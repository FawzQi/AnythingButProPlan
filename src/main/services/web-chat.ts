import { BrowserWindow, clipboard } from "electron";
import type {
  WebChatSendResult,
  WebChatTargetId,
  WebChatTargetInfo,
} from "@shared/types";

/**
 * Drives a real chat site (chat.deepseek.com, chatgpt.com, …) in a dedicated
 * Electron window: types the generated prompt into the site's own composer,
 * submits it, waits for the reply to finish streaming, then asks the site to
 * copy its reply to the clipboard and reads it back from the main process.
 *
 * The clipboard is the *preferred* source because it carries the site's own
 * markdown — fenced code blocks, tables, headings — whereas scraping the
 * rendered DOM with `innerText` collapses tables into a run of cells and
 * drops fence markers. When the reply is a full-file code block followed by
 * an explanation and a debug section, the fences are what let the parser
 * tell the code apart from the prose; without them the whole reply lands in
 * the file. So the clipboard path is not an optimisation, it is the
 * correctness path: every fallback to DOM scraping is a degraded answer.
 *
 * Why a real window instead of an HTTP client: the entire point of this
 * feature is to reuse the account the user already has. There is no API key
 * to paste, no per-token bill, and no separate model catalogue to keep
 * current — the site is the model. The trade-off is that the integration is
 * only as stable as each site's DOM, which changes without notice. Every
 * selector below is therefore a list tried in order, and every one of them
 * degrades to a generic heuristic rather than throwing.
 *
 * Bot detection: the window is a normal Chromium window on a persistent
 * session partition, so the user signs in once and stays signed in. Two
 * fingerprints are deliberately removed:
 *
 *   - The `Electron/…` token in the user agent, which several sites key on.
 *     Replaced with a plain Chrome UA matching the bundled Chromium version.
 *
 *   - The `AutomationControlled` blink feature, which otherwise makes
 *     `navigator.webdriver` true. Set in `index.ts` before app ready, since
 *     Chromium reads its switches during start-up.
 *
 * No further evasion is attempted: the goal is to look like the browser the
 * user is actually running, not to defeat a determined anti-bot system. If a
 * site adds a captcha or a proof-of-work challenge, the window is visible and
 * the user can solve it by hand.
 */

const PARTITION = "persist:AnythingButProPlan-webchat";

/** Time allowed for an upload to land before the prompt is sent. */
const UPLOAD_GRACE_MS = 10_000;

/**
 * How long to let the page's copy handler reach the OS clipboard before the
 * main process reads it back. `navigator.clipboard.writeText` is async, so a
 * synchronous read right after the click would race the write; this is the
 * head-room for the common sites that await the platform clipboard promise
 * before resolving the click handler. Sized generously because a coding-mode
 * reply can be large and the browser has to serialize the whole markdown
 * blob before handing it to the OS.
 */
const CLIPBOARD_SETTLE_MS = 1500;

/**
 * How long to wait after `win.focus()` before clicking a copy control.
 * Chromium refuses `navigator.clipboard.writeText` while the document is
 * unfocused and a synthetic click does not count as user activation, so a
 * copy issued into a document the OS has not yet handed focus back to is a
 * silent no-op: the write never happens, the sentinel stays on the
 * clipboard, and we fall through to the scraped text.
 */
const FOCUS_SETTLE_MS = 400;

interface WebChatTarget {
  id: WebChatTargetId;
  label: string;
  url: string;
  inputSelectors: string[];
  sendSelectors: string[];
  responseSelectors: string[];
  stopSelectors: string[];
  /**
   * "Copy message" affordances, best-first. When one is found, the page
   * script clicks it after the reply stabilises and the main process reads
   * the clipboard instead of scraping the DOM — the site copies the full
   * markdown source of the turn, which is exactly what the parser wants.
   * A generic `aria-label` fallback is used when the site-specific entries
   * miss, and the response selectors remain the fallback when no copy
   * control can be found at all.
   */
  copySelectors?: string[];
  /**
   * File inputs to try when attaching a document, best-first. Every one of
   * these sites renders a hidden `<input type="file">` for the attach button;
   * the generic first entry covers all of them, and the site-specific ones
   * exist because a page can have several file inputs (avatar upload, import
   * from Drive) and picking the wrong one attaches the document to something
   * that is not the composer.
   */
  fileSelectors?: string[];
}

/**
 * Selector lists are ordered best-first. When every entry misses, the page
 * script falls back to structural heuristics (`contenteditable`, a button
 * labelled "Stop"), so a site that renames its CSS classes still works.
 */
export const WEB_CHAT_TARGETS: WebChatTarget[] = [
  {
    id: "deepseek",
    label: "DeepSeek",
    url: "https://chat.deepseek.com/",
    inputSelectors: [
      "textarea#chat-input",
      "textarea[placeholder]",
      'div[contenteditable="true"]',
    ],
    // DeepSeek's send button is an unlabelled div that only becomes clickable
    // once the composer has content. The page script falls back to Enter,
    // which is what the site itself listens for.
    sendSelectors: ['div[role="button"][aria-disabled="false"][class*="send"]'],
    responseSelectors: [".ds-markdown", 'div[class*="markdown"]'],
    stopSelectors: [
      'div[role="button"][aria-label*="Stop" i]',
      'button[aria-label*="Stop" i]',
    ],
    copySelectors: [
      'div[role="button"][aria-label*="Copy" i]',
      'button[aria-label*="Copy" i]',
      'div[role="button"][title*="Copy" i]',
      'button[title*="Copy" i]',
      '[data-testid*="copy" i]',
    ],
    fileSelectors: ['input[type="file"]'],
  },
  {
    id: "chatgpt",
    label: "ChatGPT",
    url: "https://chatgpt.com/",
    inputSelectors: [
      "#prompt-textarea",
      'div[contenteditable="true"].ProseMirror',
      'div[contenteditable="true"]',
    ],
    sendSelectors: [
      'button[data-testid="send-button"]',
      'button[aria-label="Send prompt"]',
    ],
    responseSelectors: [
      '[data-message-author-role="assistant"] .markdown',
      '[data-message-author-role="assistant"]',
    ],
    stopSelectors: [
      'button[data-testid="stop-button"]',
      'button[aria-label*="Stop" i]',
    ],
    copySelectors: [
      'button[data-testid="copy-turn-action-button"]',
      'button[aria-label="Copy"]',
      'button[aria-label*="Copy" i]',
    ],
    fileSelectors: ['input[type="file"]'],
  },
  {
    id: "claude",
    label: "Claude",
    url: "https://claude.ai/new",
    inputSelectors: [
      'div[contenteditable="true"].ProseMirror',
      'div[contenteditable="true"]',
    ],
    sendSelectors: [
      'button[aria-label="Send message"]',
      'button[aria-label*="Send" i]',
    ],
    responseSelectors: [
      ".font-claude-message",
      '[data-testid="assistant-message"]',
    ],
    stopSelectors: [
      'button[aria-label="Stop response"]',
      'button[aria-label*="Stop" i]',
    ],
    copySelectors: [
      'button[data-testid="action-bar-copy"]',
      'button[aria-label*="Copy" i]',
    ],
    fileSelectors: ['input[type="file"]'],
  },
  {
    id: "gemini",
    label: "Gemini",
    url: "https://gemini.google.com/app",
    inputSelectors: [
      'rich-textarea .ql-editor[contenteditable="true"]',
      'div[contenteditable="true"].ql-editor',
      'div[contenteditable="true"]',
    ],
    sendSelectors: ["button.send-button", 'button[aria-label*="Send" i]'],
    responseSelectors: [
      "model-response",
      ".model-response-text",
      "message-content",
    ],
    stopSelectors: ['button[aria-label*="Stop" i]'],
    copySelectors: ["copy-button button", 'button[aria-label*="Copy" i]'],
    fileSelectors: ['input[type="file"]'],
  },
  {
    id: "kimi",
    label: "Kimi",
    url: "https://kimi.com/",
    inputSelectors: ['div[contenteditable="true"]', "textarea"],
    sendSelectors: ['div[class*="send-button"]', 'button[class*="send"]'],
    responseSelectors: [
      'div[class*="markdown"]',
      'div[class*="segment-content"]',
    ],
    stopSelectors: ['div[class*="stop"]'],
    copySelectors: [
      'div[class*="copy-button"]',
      'div[role="button"][aria-label*="Copy" i]',
      'button[aria-label*="Copy" i]',
    ],
    fileSelectors: ['input[type="file"]'],
  },
  {
    id: "qwen",
    label: "Qwen Chat",
    url: "https://chat.qwen.ai/",
    inputSelectors: [
      "textarea#chat-input",
      "textarea[placeholder]",
      'div[contenteditable="true"]',
    ],
    sendSelectors: [
      "button#send-message-button",
      'button[type="submit"]',
      'button[aria-label*="Send" i]',
    ],
    responseSelectors: ['div[class*="markdown"]', 'div[class*="response"]'],
    stopSelectors: ['button[aria-label*="Stop" i]', 'button[class*="stop"]'],
    copySelectors: [
      'button[aria-label*="Copy" i]',
      'div[role="button"][aria-label*="Copy" i]',
    ],
    fileSelectors: ['input[type="file"]'],
  },
];

export function listWebChatTargets(): WebChatTargetInfo[] {
  return WEB_CHAT_TARGETS.map((t) => ({
    id: t.id,
    label: t.label,
    url: t.url,
  }));
}

const windows = new Map<WebChatTargetId, BrowserWindow>();

/**
 * Build a Chrome user-agent string for the platform this process is running
 * on, using the Chromium version Electron was built against. The Chromium
 * version matters: sites that gate features on `Sec-CH-UA` compare it to the
 * UA, and a mismatch is itself a fingerprint.
 */
function plainChromeUserAgent(): string {
  const chrome = process.versions.chrome ?? "120.0.0.0";
  let platform = "X11; Linux x86_64";
  if (process.platform === "darwin") {
    platform = "Macintosh; Intel Mac OS X 10_15_7";
  } else if (process.platform === "win32") {
    platform = "Windows NT 10.0; Win64; x64";
  }
  return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome} Safari/537.36`;
}

function findTarget(id: WebChatTargetId): WebChatTarget | undefined {
  return WEB_CHAT_TARGETS.find((t) => t.id === id);
}

/**
 * Get the existing window for a target, or create and load one. The window
 * is created hidden and lives until the user closes it — closing it logs
 * them out of the next session, which is intentional, but the window is not
 * destroyed between sends so the login survives a normal workflow.
 */
async function ensureWindow(target: WebChatTarget): Promise<BrowserWindow> {
  const existing = windows.get(target.id);
  if (existing && !existing.isDestroyed()) return existing;

  const win = new BrowserWindow({
    width: 1100,
    height: 820,
    show: false,
    title: `AnythingButProPlan — ${target.label}`,
    backgroundColor: "#16181d",
    autoHideMenuBar: true,
    webPreferences: {
      partition: PARTITION,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      // Deliberately no preload. This window is a plain browser tab; nothing
      // in the app's renderer bridge should be reachable from a third-party
      // page.
    },
  });

  win.webContents.setUserAgent(plainChromeUserAgent());

  // Some sites gate `navigator.clipboard.writeText` behind the Clipboard
  // permission even when the document is focused, and Electron's default
  // permission handler resolves a request as "denied" unless a handler is
  // registered. That silently breaks the copy path and drops us onto the
  // DOM scrape, which is exactly the failure mode this whole file exists to
  // avoid. Register a permissive handler on the shared session so a focused
  // page can always write to the clipboard.
  win.webContents.session.setPermissionRequestHandler(
    (_wc, _permission, callback) => {
      callback(true);
    },
  );

  // OAuth popups ("Sign in with Google", passkey prompts) open in a sibling
  // window that shares the session partition, so the cookies land in the
  // same jar the main chat window reads from.
  win.webContents.setWindowOpenHandler(() => ({
    action: "allow",
    overrideBrowserWindowOptions: {
      width: 600,
      height: 750,
      autoHideMenuBar: true,
      webPreferences: {
        partition: PARTITION,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    },
  }));

  win.on("closed", () => windows.delete(target.id));
  windows.set(target.id, win);
  await win.loadURL(target.url);
  return win;
}

/**
 * The page-side driver. Runs inside the chat site, so it must be plain
 * JavaScript with no imports and no TS types — it is stringified and handed
 * to `executeJavaScript`.
 *
 * The flow:
 *   1. Poll for the composer. Sites render it late and a cold load can take
 *      several seconds.
 *   2. Insert the prompt. `<textarea>` goes through the native value setter
 *      so React's synthetic `onChange` fires; a `contenteditable` (ProseMirror,
 *      Lexical, Quill) goes through `execCommand('insertText')`, which is the
 *      only insertion path those editors treat as real typing.
 *   3. Submit — click the send button if one is enabled, otherwise fire a
 *      synthetic Enter, which is what every one of these sites listens for.
 *   4. Poll the last assistant message until the text stops changing for
 *      two seconds AND no visible "stop generating" control is present. The
 *      stop-button check is the fast path; the text-stability check is the
 *      fallback for sites that do not expose one.
 *
 * The script deliberately does *not* click the copy button. The copy click
 * has to happen in a focused document (see `deliverPrompt`), and the window
 * is deliberately unfocused for the whole typing/submitting/waiting phase.
 */
function buildScript(target: WebChatTarget, prompt: string): string {
  return `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const queryFirst = (sels) => {
    for (const s of sels) {
      try { const el = document.querySelector(s); if (el) return el; } catch {}
    }
    return null;
  };
  const queryAll = (sels) => {
    const out = [];
    for (const s of sels) {
      try { document.querySelectorAll(s).forEach((el) => out.push(el)); } catch {}
    }
    return out;
  };

  // Assistant messages carry an action bar (Copy, Download, Retry, …) inside
  // the same element as the reply itself. Reading innerText on the container
  // picks those labels up as literal lines *and* flattens every pre/code
  // block into a run of raw text with no fence markers, so the parser cannot
  // tell code from prose and a reply shaped "full file, then explanation,
  // then debug" lands in the file as one blob. The scrape is the *fallback*
  // when the clipboard path misses, but it has to produce the same shape the
  // copy button would: fences around every code block, blank lines between
  // blocks, headings and lists preserved. So instead of reading innerText we
  // walk the DOM and re-emit markdown — pre/code with a language-x class
  // becomes a fenced block tagged x, block elements get newlines around
  // them, br becomes a newline, and inline code keeps its backticks so it is
  // not mistaken for prose. Button-shaped descendants are removed before the
  // walk, and a small set of known action-bar labels is dropped line-by-line
  // as a backstop for sites that render the bar as plain divs.
  const UI_LABEL = /^(Copy|Copy code|Copy message|Copy turn|Download|Retry|Regenerate|Edit|Share|Save|Read aloud|Good response|Bad response|Rate this response|Thumbs up|Thumbs down)$/i;
  const BLOCK_TAGS = new Set(['p','div','section','article','header','footer','main','aside','nav','h1','h2','h3','h4','h5','h6','li','ul','ol','blockquote','table','thead','tbody','tr','hr','figure','figcaption','dl','dt','dd']);
  const FENCE = '\`\`\`';
  const BACKTICK = '\`';
  const cleanAssistantText = (node) => {
    try {
      const clone = node.cloneNode(true);
      clone
        .querySelectorAll('button, [role="button"], [aria-label*="Copy" i], [aria-label*="Download" i]')
        .forEach((el) => el.remove());
      const out = [];
      const walk = (n) => {
        if (!n) return;
        if (n.nodeType === 3) {
          const v = n.nodeValue || '';
          if (v.length > 0) out.push(v);
          return;
        }
        if (n.nodeType !== 1) return;
        const tag = n.tagName ? n.tagName.toLowerCase() : '';
        if (tag === 'script' || tag === 'style' || tag === 'noscript') return;
        if (tag === 'br') { out.push('\\n'); return; }
        if (tag === 'pre') {
          const codeEl = n.querySelector('code');
          const codeText = ((codeEl || n).textContent || '').replace(/\\n+$/, '');
          let lang = '';
          if (codeEl) {
            const cls = typeof codeEl.className === 'string' ? codeEl.className : '';
            const m = cls.match(/language-([a-z0-9+#._-]+)/i);
            if (m) lang = m[1];
          }
          if (!lang) {
            const dataLang = n.getAttribute && n.getAttribute('data-language');
            if (dataLang) lang = dataLang;
          }
          out.push('\\n\\n' + FENCE + lang + '\\n' + codeText + '\\n' + FENCE + '\\n');
          return;
        }
        if (tag === 'code') {
          out.push(BACKTICK + (n.textContent || '') + BACKTICK);
          return;
        }
        const isBlock = BLOCK_TAGS.has(tag);
        if (isBlock) out.push('\\n');
        const kids = n.childNodes || [];
        for (let i = 0; i < kids.length; i++) walk(kids[i]);
        if (isBlock) out.push('\\n');
      };
      walk(clone);
      const raw = out
        .join('')
        .replace(/[ \\t]+$/gm, '')
        .replace(/\\n{3,}/g, '\\n\\n')
        .trim();
      const lines = raw.split('\\n');
      const kept = [];
      for (const line of lines) {
        if (UI_LABEL.test(line.trim())) continue;
        kept.push(line);
      }
      return kept.join('\\n').trim();
    } catch {
      return (node.innerText || '').trim();
    }
  };

  const inputSels = ${JSON.stringify(target.inputSelectors)};
  const sendSels = ${JSON.stringify(target.sendSelectors)};
  const respSels = ${JSON.stringify(target.responseSelectors)};
  const stopSels = ${JSON.stringify(target.stopSelectors)};
  const prompt = ${JSON.stringify(prompt)};

  window.__AnythingButProPlanWebChatAbort = false;
  const aborted = () => window.__AnythingButProPlanWebChatAbort === true;

  let input = null;
  for (let i = 0; i < 80; i++) {
    if (aborted()) return { ok: false, error: 'Cancelled.' };
    input = queryFirst(inputSels);
    if (input) break;
    await sleep(250);
  }
  if (!input) {
    return { ok: false, error: 'Could not find the chat input. Are you signed in?' };
  }

  input.focus();
  const tag = input.tagName.toLowerCase();
  if (tag === 'textarea' || tag === 'input') {
    const proto = tag === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(input, prompt);
    else input.value = prompt;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  } else {
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(input);
    sel.removeAllRanges();
    sel.addRange(range);
    document.execCommand('insertText', false, prompt);
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: prompt }));
  }
  await sleep(400);
  if (aborted()) return { ok: false, error: 'Cancelled.' };

  const sendBtn = queryFirst(sendSels);
  const canClick = sendBtn && !sendBtn.disabled && sendBtn.getAttribute('aria-disabled') !== 'true';
  if (canClick) {
    sendBtn.click();
  } else {
    const fire = (type) => input.dispatchEvent(new KeyboardEvent(type, {
      key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true,
    }));
    fire('keydown'); fire('keypress'); fire('keyup');
  }

  const isGenerating = () => {
    for (const s of stopSels) {
      try {
        const el = document.querySelector(s);
        if (el && el.offsetParent !== null) return true;
      } catch {}
    }
    const btns = document.querySelectorAll('button');
    for (const b of btns) {
      if (b.offsetParent === null) continue;
      const label = ((b.getAttribute('aria-label') || '') + ' ' + (b.textContent || '')).toLowerCase();
      if (/\\bstop\\b/.test(label)) return true;
    }
    return false;
  };

  const started = Date.now();
  const MAX_MS = 8 * 60 * 1000;
  let lastText = '';
  let stableMs = 0;
  let sawAny = false;

  await sleep(900);
  while (Date.now() - started < MAX_MS) {
    if (aborted()) return { ok: false, error: 'Cancelled.' };
    await sleep(500);

    const nodes = queryAll(respSels);
    let current = '';
    for (let i = nodes.length - 1; i >= 0; i--) {
      const t = cleanAssistantText(nodes[i]);
      if (t) { current = t; break; }
    }
    if (!current) continue;
    sawAny = true;

    if (current === lastText && !isGenerating()) {
      stableMs += 500;
      if (stableMs >= 2000) {
        // The reply has settled. Report it as stable: true so the main
        // process knows to attempt the copy-to-clipboard upgrade before
        // falling back to this text.
        return { ok: true, stable: true, text: current };
      }
    } else {
      stableMs = 0;
    }
    lastText = current;
  }

  if (sawAny) return { ok: true, stable: false, text: lastText };
  return { ok: false, error: 'Timed out waiting for a response.' };
})()`;
}

/**
 * Collect every visible copy control on the page and stash the list on
 * `window`, keyed by index. Returns the count.
 *
 * There is more than one "Copy" on a coding-mode reply: each fenced code
 * block carries its own copy button (which copies only that block), and the
 * message's action bar carries a copy button (which copies the whole turn
 * as markdown). The label alone cannot tell them apart — a site may label
 * both "Copy" — so we gather every candidate and let the main process try
 * them newest-to-oldest, accepting the result that looks like the whole
 * turn. Candidates inside `<pre>`, `<code>`, or any element whose class
 * mentions "code" are dropped first: those are always per-block controls,
 * and pruning them keeps the click loop short.
 */
function buildCollectCopyCandidatesScript(target: WebChatTarget): string {
  return `(() => {
    const queryAll = (sels) => {
      const out = [];
      for (const s of sels) {
        try { document.querySelectorAll(s).forEach((el) => out.push(el)); } catch {}
      }
      return out;
    };
    const copySels = ${JSON.stringify(
      target.copySelectors ?? [
        'button[aria-label*="Copy" i]',
        'div[role="button"][aria-label*="Copy" i]',
      ],
    )};
    const insideCode = (el) => {
      let node = el.parentElement;
      let depth = 0;
      while (node && depth < 6) {
        const tag = node.tagName ? node.tagName.toLowerCase() : '';
        if (tag === 'pre' || tag === 'code') return true;
        const cls = typeof node.className === 'string' ? node.className : '';
        if (cls && /\\bcode\\b/i.test(cls)) return true;
        node = node.parentElement;
        depth++;
      }
      return false;
    };
    const els = queryAll(copySels);
    const seen = new Set();
    const visible = [];
    for (const el of els) {
      if (!el || seen.has(el)) continue;
      seen.add(el);
      if (el.offsetParent === null) continue;
      visible.push(el);
    }
    const pool = visible.filter((el) => !insideCode(el));
    const final = pool.length > 0 ? pool : visible;
    window.__AnythingButProPlanCopyCandidates = final;
    return final.length;
  })()`;
}

async function collectCopyCandidates(
  win: BrowserWindow,
  target: WebChatTarget,
): Promise<number> {
  try {
    const count = (await win.webContents.executeJavaScript(
      buildCollectCopyCandidatesScript(target),
      true,
    )) as number | undefined;
    return typeof count === "number" ? count : 0;
  } catch {
    return 0;
  }
}

async function clickCopyCandidate(
  win: BrowserWindow,
  index: number,
): Promise<boolean> {
  try {
    const clicked = (await win.webContents.executeJavaScript(
      `(() => {
        const el = (window.__AnythingButProPlanCopyCandidates || [])[${index}];
        if (!el) return false;
        try { el.click(); return true; } catch { return false; }
      })()`,
      true,
    )) as boolean | undefined;
    return clicked === true;
  } catch {
    return false;
  }
}

/**
 * Ask the site to copy its reply, click the message-level "Copy" control,
 * and read the result back from the OS clipboard.
 *
 * The newest assistant turn is at the bottom of the transcript, so its
 * action-bar copy button is the bottom-most candidate. We try candidates
 * from the bottom up and take the longest result: a per-block copy returns
 * one fenced block (short), the message-level copy returns the whole turn
 * (which, for a coding-mode reply, contains every fence plus the
 * explanation and debug sections). The longest result is therefore the
 * whole turn in every realistic case.
 *
 * The early-accept shortcut is deliberately strict. Its only purpose is to
 * save a couple of `CLIPBOARD_SETTLE_MS` waits on the common path, and a
 * loose test — "contains a fence and is not tiny" — would fire on a single
 * large code block that a per-block copy returned, ending the loop on a
 * fragment. Requiring at least two fence markers *and* a non-trivial body
 * means the only result that can stop the loop early is one that already
 * looks like a whole turn (a fence, then prose, then another fence), which
 * is exactly what the message-level copy produces.
 *
 * A sentinel is planted before each click so a silent no-op can be told
 * apart from a real write: if the clipboard still holds the sentinel, the
 * site's `navigator.clipboard.writeText` never landed — usually because the
 * document was not yet focused, which the caller has already waited on.
 */
async function readReplyViaCopy(
  win: BrowserWindow,
  target: WebChatTarget,
): Promise<string | null> {
  const count = await collectCopyCandidates(win, target);
  if (count === 0) return null;

  const sentinel = `__AnythingButProPlan_${Date.now()}__`;
  // Cap the number of clicks. The message-level control is nearly always in
  // the bottom few candidates, and every click costs a `CLIPBOARD_SETTLE_MS`
  // wait — clicking dozens would make a slow send even slower.
  const maxTries = Math.min(count, 5);
  let best = "";

  for (let i = count - 1; i >= count - maxTries; i--) {
    clipboard.writeText(sentinel);
    const clicked = await clickCopyCandidate(win, i);
    if (!clicked) continue;
    await new Promise((resolve) => setTimeout(resolve, CLIPBOARD_SETTLE_MS));
    const text = clipboard.readText();
    if (typeof text !== "string" || text.length === 0) continue;
    if (text === sentinel) continue;
    if (text.length > best.length) best = text;
    // Early accept only on a result that already looks like the whole
    // turn: at least two fence markers plus a body that is more than a
    // single block. A per-block copy of one large file cannot satisfy
    // both, so it can never win the loop early.
    const fenceCount = (text.match(/```/g) || []).length;
    if (fenceCount >= 2 && text.length > 500) return text;
  }

  return best.length > 0 ? best : null;
}

function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message;
}

/**
 * Type `prompt` into the target site, submit it, and return the assistant's
 * reply.
 *
 * The reply is sourced from the clipboard when possible. Between the settle
 * check and the copy click the window is briefly focused — a copy issued
 * while the document is unfocused is a no-op — and a sentinel is planted on
 * the clipboard first, so a write that silently fails can be told apart
 * from a write that succeeded. Without the sentinel, a failed write would
 * leave whatever the user last copied on the clipboard and we would return
 * that, which is worse than useless: it looks like an answer.
 *
 * Failure never destroys the window: when the send fails the window is
 * brought to the front so the user can complete a login or clear a captcha,
 * and a retry reuses the same session.
 */
async function deliverPrompt(
  win: BrowserWindow,
  target: WebChatTarget,
  prompt: string,
): Promise<WebChatSendResult> {
  try {
    await win.webContents.executeJavaScript(
      "window.__AnythingButProPlanWebChatAbort = false;",
      true,
    );
  } catch {
    // The page has not finished loading; the script sets the flag itself.
  }

  try {
    const raw = (await win.webContents.executeJavaScript(
      buildScript(target, prompt),
      true,
    )) as
      | { ok?: boolean; text?: string; error?: string; stable?: boolean }
      | undefined;
    if (!raw || typeof raw !== "object") {
      return {
        ok: false,
        error: `${target.label} returned an unexpected result.`,
      };
    }
    if (!raw.ok) {
      return {
        ok: false,
        error: raw.error ?? `${target.label} reported a failure.`,
      };
    }

    const scraped = typeof raw.text === "string" ? raw.text : "";

    if (raw.stable === true) {
      const wasFocused = win.isFocused();
      try {
        if (!wasFocused) {
          win.show();
          win.focus();
          // Poll until the OS actually hands the window focus, then give the
          // renderer a beat to observe the focus event. Chromium refuses
          // `navigator.clipboard.writeText` while the document is unfocused
          // and a synthetic click does not count as user activation, so a
          // copy issued into a document the OS has not yet focused is a
          // silent no-op — the sentinel stays on the clipboard and we fall
          // through to the scraped text.
          const focusDeadline = Date.now() + 2000;
          while (!win.isFocused() && Date.now() < focusDeadline) {
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          await new Promise((resolve) => setTimeout(resolve, FOCUS_SETTLE_MS));
        }
        const fromClipboard = await readReplyViaCopy(win, target);
        if (fromClipboard) return { ok: true, text: fromClipboard };
      } catch {
        // Fall through to the scraped text.
      }
    }

    return { ok: true, text: scraped };
  } catch (error) {
    return { ok: false, error: `${target.label}: ${describe(error)}` };
  }
}

/**
 * Put a real file into the site's file input.
 *
 * `input.files` cannot be assigned from page JavaScript — a `File` built in
 * the page carries bytes we would have to push through `executeJavaScript`
 * as base64, which is megabytes of string for a paper and fails outright on
 * a large PDF. The debugger protocol's `DOM.setFileInputFiles` sets the path
 * on the element the way a user's file picker does, so the site's own upload
 * code runs unchanged.
 *
 * Returns false when the page has no file input — the caller then sends the
 * extracted text instead of the document, which is worse but works.
 */
async function attachFile(
  win: BrowserWindow,
  target: WebChatTarget,
  absolutePath: string,
): Promise<boolean> {
  const debugger_ = win.webContents.debugger;
  try {
    if (!debugger_.isAttached()) debugger_.attach("1.3");
    await debugger_.sendCommand("DOM.enable");
    const document_ = (await debugger_.sendCommand("DOM.getDocument", {
      depth: -1,
      pierce: true,
    })) as { root?: { nodeId?: number } };
    const rootId = document_.root?.nodeId;
    if (rootId === undefined) return false;

    for (const selector of target.fileSelectors ?? ['input[type="file"]']) {
      const found = (await debugger_.sendCommand("DOM.querySelector", {
        nodeId: rootId,
        selector,
      })) as { nodeId?: number };
      if (found.nodeId === undefined || found.nodeId === 0) continue;
      await debugger_.sendCommand("DOM.setFileInputFiles", {
        files: [absolutePath],
        nodeId: found.nodeId,
      });
      return true;
    }
    return false;
  } catch (error) {
    // A page that already has a debugger attached (the user opened devtools)
    // refuses a second one; that is not worth failing the conversion over.
    console.warn(
      `Could not attach a file to ${target.label}:`,
      describe(error),
    );
    return false;
  }
}

/**
 * Best-effort wait for an in-flight upload to complete.
 *
 * No two of these sites agree on what "uploading" looks like in the DOM, so
 * this polls a handful of generic indicators (progress bars, `aria-busy`
 * containers, class names containing "upload"). It returns `true` when an
 * indicator appeared and then cleared; `false` when none was ever seen, in
 * which case the caller falls back to the fixed grace period — the common
 * case, since most sites swap the composer for a "file attached" chip
 * instead of rendering a progress bar.
 */
async function waitForUploadSettle(
  win: BrowserWindow,
  _target: WebChatTarget,
): Promise<boolean> {
  const script = `(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const indicators = [
      '[role="progressbar"]',
      '[aria-busy="true"]',
      'div[class*="uploading"]',
      'div[class*="upload-progress"]',
      'div[class*="file-upload"][class*="loading"]',
    ];
    const busy = () => {
      for (const s of indicators) {
        try {
          const el = document.querySelector(s);
          if (el && el.offsetParent !== null) return true;
        } catch {}
      }
      return false;
    };
    const start = Date.now();
    let seen = false;
    while (Date.now() - start < 1500) {
      if (busy()) { seen = true; break; }
      await sleep(100);
    }
    if (!seen) return false;
    while (busy() && Date.now() - start < 60000) await sleep(200);
    return true;
  })()`;
  try {
    const settled = (await win.webContents.executeJavaScript(script, true)) as
      | boolean
      | undefined;
    return settled === true;
  } catch {
    return false;
  }
}

export async function sendToWebChat(
  targetId: WebChatTargetId,
  prompt: string,
): Promise<WebChatSendResult> {
  const target = findTarget(targetId);
  if (!target)
    return { ok: false, error: `Unknown web chat target: ${targetId}` };

  let win: BrowserWindow;
  try {
    win = await ensureWindow(target);
  } catch (error) {
    return {
      ok: false,
      error: `Could not open ${target.label}: ${describe(error)}`,
    };
  }

  if (win.isMinimized()) win.restore();
  win.showInactive();

  const result = await deliverPrompt(win, target, prompt);

  // A failed send almost always means the user needs to sign in or solve a
  // challenge, so bring the window forward. A successful send hides it again
  // unless the user has already taken focus.
  if (!win.isDestroyed()) {
    if (!result.ok) {
      win.show();
      win.focus();
    } else if (!win.isFocused()) {
      win.hide();
    }
  }

  return result;
}

export interface WebChatDocumentResult extends WebChatSendResult {
  /** True when the document itself was attached, false when only text went. */
  attached: boolean;
}

/**
 * Attach a document to the chat and send `prompt` with it.
 *
 * This is the path a research conversion takes when the user has no API key:
 * the site's model reads the actual PDF — figures, charts and layout included
 * — and answers with markdown, which is the whole reason to prefer this over
 * extracting text locally first.
 *
 * The flow mirrors what a user does by hand: drop the file in, give the
 * upload a moment to land, paste the base prompt, wait for the model to
 * finish, then ask the site to copy its reply to the clipboard. The final
 * clipboard read happens inside `deliverPrompt`, so a site whose copy
 * control cannot be found still degrades to a DOM scrape rather than
 * failing.
 *
 * Uploads are asynchronous and the sites gate their send button while one is
 * in flight. Two mechanisms cover the wait: a generic progress-indicator
 * poll (`waitForUploadSettle`) for sites that render one, and a fixed
 * ten-second grace period for everyone else — there is no shared DOM event
 * for "upload finished" across six sites, and the send path already
 * tolerates a click that does nothing because it retries and falls back to
 * Enter.
 */
export async function sendDocumentToWebChat(
  targetId: WebChatTargetId,
  prompt: string,
  documentPath: string,
): Promise<WebChatDocumentResult> {
  const target = findTarget(targetId);
  if (!target) {
    return {
      ok: false,
      attached: false,
      error: `Unknown web chat target: ${targetId}`,
    };
  }

  let win: BrowserWindow;
  try {
    win = await ensureWindow(target);
  } catch (error) {
    return {
      ok: false,
      attached: false,
      error: `Could not open ${target.label}: ${describe(error)}`,
    };
  }

  if (win.isMinimized()) win.restore();
  win.showInactive();

  const attached = await attachFile(win, target, documentPath);
  if (attached) {
    const sawIndicator = await waitForUploadSettle(win, target);
    if (!sawIndicator) {
      await new Promise((resolve) => setTimeout(resolve, UPLOAD_GRACE_MS));
    }
  }

  const result = await deliverPrompt(win, target, prompt);
  if (!win.isDestroyed() && !result.ok) {
    win.show();
    win.focus();
  }
  return { ...result, attached };
}

/** Show the target window so the user can sign in before the first send. */
export async function openWebChat(targetId: WebChatTargetId): Promise<void> {
  const target = findTarget(targetId);
  if (!target) return;
  const win = await ensureWindow(target);
  win.show();
  win.focus();
}

/**
 * Ask any in-flight send to stop on its next poll. The polling loop inside
 * the page checks the flag every 500 ms; the result is discarded as a
 * cancellation, not treated as an error.
 */
export function cancelWebChat(): void {
  for (const win of windows.values()) {
    if (win.isDestroyed()) continue;
    win.webContents
      .executeJavaScript(
        "window.__AnythingButProPlanWebChatAbort = true;",
        true,
      )
      .catch(() => undefined);
  }
}

/**
 * Close every open web chat window. Called from `index.ts` when the main
 * window closes and when the app is about to quit, so the hidden chat
 * windows do not keep the process alive after the main window is gone.
 *
 * Electron keeps the app running for as long as any window exists, and the
 * web chat windows are created `show: false` and are never closed by the
 * app — so without this, closing the main window would leave the process
 * (and the signed-in chat sessions) running with no visible way to reach
 * them. The `windows` map is cleared afterwards so a subsequent
 * `ensureWindow` starts from a clean slate rather than handing back a
 * destroyed reference.
 */
export function closeAllWebChatWindows(): void {
  for (const win of windows.values()) {
    if (!win.isDestroyed()) win.destroy();
  }
  windows.clear();
}