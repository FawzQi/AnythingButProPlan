import { BrowserWindow } from 'electron'
import type {
  WebChatSendResult,
  WebChatTargetId,
  WebChatTargetInfo,
} from '@shared/types'

/**
 * Drives a real chat site (chat.deepseek.com, chatgpt.com, …) in a dedicated
 * Electron window: types the generated prompt into the site's own composer,
 * submits it, waits for the reply to finish streaming, and scrapes the
 * assistant's text back into the app.
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

const PARTITION = 'persist:larpgent-webchat'

interface WebChatTarget {
  id: WebChatTargetId
  label: string
  url: string
  inputSelectors: string[]
  sendSelectors: string[]
  responseSelectors: string[]
  stopSelectors: string[]
}

/**
 * Selector lists are ordered best-first. When every entry misses, the page
 * script falls back to structural heuristics (`contenteditable`, a button
 * labelled "Stop"), so a site that renames its CSS classes still works.
 */
export const WEB_CHAT_TARGETS: WebChatTarget[] = [
  {
    id: 'deepseek',
    label: 'DeepSeek',
    url: 'https://chat.deepseek.com/',
    inputSelectors: ['textarea#chat-input', 'textarea[placeholder]', 'div[contenteditable="true"]'],
    // DeepSeek's send button is an unlabelled div that only becomes clickable
    // once the composer has content. The page script falls back to Enter,
    // which is what the site itself listens for.
    sendSelectors: ['div[role="button"][aria-disabled="false"][class*="send"]'],
    responseSelectors: ['.ds-markdown', 'div[class*="markdown"]'],
    stopSelectors: ['div[role="button"][aria-label*="Stop" i]', 'button[aria-label*="Stop" i]'],
  },
  {
    id: 'chatgpt',
    label: 'ChatGPT',
    url: 'https://chatgpt.com/',
    inputSelectors: ['#prompt-textarea', 'div[contenteditable="true"].ProseMirror', 'div[contenteditable="true"]'],
    sendSelectors: ['button[data-testid="send-button"]', 'button[aria-label="Send prompt"]'],
    responseSelectors: ['[data-message-author-role="assistant"] .markdown', '[data-message-author-role="assistant"]'],
    stopSelectors: ['button[data-testid="stop-button"]', 'button[aria-label*="Stop" i]'],
  },
  {
    id: 'claude',
    label: 'Claude',
    url: 'https://claude.ai/new',
    inputSelectors: ['div[contenteditable="true"].ProseMirror', 'div[contenteditable="true"]'],
    sendSelectors: ['button[aria-label="Send message"]', 'button[aria-label*="Send" i]'],
    responseSelectors: ['.font-claude-message', '[data-testid="assistant-message"]'],
    stopSelectors: ['button[aria-label="Stop response"]', 'button[aria-label*="Stop" i]'],
  },
  {
    id: 'gemini',
    label: 'Gemini',
    url: 'https://gemini.google.com/app',
    inputSelectors: ['rich-textarea .ql-editor[contenteditable="true"]', 'div[contenteditable="true"].ql-editor', 'div[contenteditable="true"]'],
    sendSelectors: ['button.send-button', 'button[aria-label*="Send" i]'],
    responseSelectors: ['model-response', '.model-response-text', 'message-content'],
    stopSelectors: ['button[aria-label*="Stop" i]'],
  },
  {
    id: 'kimi',
    label: 'Kimi',
    url: 'https://kimi.com/',
    inputSelectors: ['div[contenteditable="true"]', 'textarea'],
    sendSelectors: ['div[class*="send-button"]', 'button[class*="send"]'],
    responseSelectors: ['div[class*="markdown"]', 'div[class*="segment-content"]'],
    stopSelectors: ['div[class*="stop"]'],
  },
  {
    id: 'qwen',
    label: 'Qwen Chat',
    url: 'https://chat.qwen.ai/',
    inputSelectors: ['textarea#chat-input', 'textarea[placeholder]', 'div[contenteditable="true"]'],
    sendSelectors: ['button#send-message-button', 'button[type="submit"]', 'button[aria-label*="Send" i]'],
    responseSelectors: ['div[class*="markdown"]', 'div[class*="response"]'],
    stopSelectors: ['button[aria-label*="Stop" i]', 'button[class*="stop"]'],
  },
]

export function listWebChatTargets(): WebChatTargetInfo[] {
  return WEB_CHAT_TARGETS.map((t) => ({ id: t.id, label: t.label, url: t.url }))
}

const windows = new Map<WebChatTargetId, BrowserWindow>()

/**
 * Build a Chrome user-agent string for the platform this process is running
 * on, using the Chromium version Electron was built against. The Chromium
 * version matters: sites that gate features on `Sec-CH-UA` compare it to the
 * UA, and a mismatch is itself a fingerprint.
 */
function plainChromeUserAgent(): string {
  const chrome = process.versions.chrome ?? '120.0.0.0'
  let platform = 'X11; Linux x86_64'
  if (process.platform === 'darwin') {
    platform = 'Macintosh; Intel Mac OS X 10_15_7'
  } else if (process.platform === 'win32') {
    platform = 'Windows NT 10.0; Win64; x64'
  }
  return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome} Safari/537.36`
}

function findTarget(id: WebChatTargetId): WebChatTarget | undefined {
  return WEB_CHAT_TARGETS.find((t) => t.id === id)
}

/**
 * Get the existing window for a target, or create and load one. The window
 * is created hidden and lives until the user closes it — closing it logs
 * them out of the next session, which is intentional, but the window is not
 * destroyed between sends so the login survives a normal workflow.
 */
async function ensureWindow(target: WebChatTarget): Promise<BrowserWindow> {
  const existing = windows.get(target.id)
  if (existing && !existing.isDestroyed()) return existing

  const win = new BrowserWindow({
    width: 1100,
    height: 820,
    show: false,
    title: `LARPGent — ${target.label}`,
    backgroundColor: '#16181d',
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
  })

  win.webContents.setUserAgent(plainChromeUserAgent())

  // OAuth popups ("Sign in with Google", passkey prompts) open in a sibling
  // window that shares the session partition, so the cookies land in the
  // same jar the main chat window reads from.
  win.webContents.setWindowOpenHandler(() => ({
    action: 'allow',
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
  }))

  win.on('closed', () => windows.delete(target.id))
  windows.set(target.id, win)
  await win.loadURL(target.url)
  return win
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
  const inputSels = ${JSON.stringify(target.inputSelectors)};
  const sendSels = ${JSON.stringify(target.sendSelectors)};
  const respSels = ${JSON.stringify(target.responseSelectors)};
  const stopSels = ${JSON.stringify(target.stopSelectors)};
  const prompt = ${JSON.stringify(prompt)};

  window.__larpgentWebChatAbort = false;
  const aborted = () => window.__larpgentWebChatAbort === true;

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
      const t = (nodes[i].innerText || '').trim();
      if (t) { current = t; break; }
    }
    if (!current) continue;
    sawAny = true;

    if (current === lastText && !isGenerating()) {
      stableMs += 500;
      if (stableMs >= 2000) return { ok: true, text: current };
    } else {
      stableMs = 0;
    }
    lastText = current;
  }

  if (sawAny) return { ok: true, text: lastText };
  return { ok: false, error: 'Timed out waiting for a response.' };
})()`
}

function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message
}

/**
 * Type `prompt` into the target site, submit it, and return the assistant's
 * reply. The window is made visible without stealing focus for the duration,
 * so the user can watch and intervene (captcha, login) but is not yanked out
 * of whatever they were doing.
 *
 * Failure never destroys the window: when the send fails the window is
 * brought to the front so the user can complete a login or clear a captcha,
 * and a retry reuses the same session.
 */
export async function sendToWebChat(
  targetId: WebChatTargetId,
  prompt: string,
): Promise<WebChatSendResult> {
  const target = findTarget(targetId)
  if (!target) return { ok: false, error: `Unknown web chat target: ${targetId}` }

  let win: BrowserWindow
  try {
    win = await ensureWindow(target)
  } catch (error) {
    return {
      ok: false,
      error: `Could not open ${target.label}: ${describe(error)}`,
    }
  }

  if (win.isMinimized()) win.restore()
  win.showInactive()

  try {
    await win.webContents.executeJavaScript(
      'window.__larpgentWebChatAbort = false;',
      true,
    )
  } catch {
    // The page has not finished loading; the script sets the flag itself.
  }

  let result: WebChatSendResult
  try {
    const raw = (await win.webContents.executeJavaScript(
      buildScript(target, prompt),
      true,
    )) as { ok?: boolean; text?: string; error?: string } | undefined
    if (!raw || typeof raw !== 'object') {
      result = { ok: false, error: `${target.label} returned an unexpected result.` }
    } else if (raw.ok) {
      result = { ok: true, text: typeof raw.text === 'string' ? raw.text : '' }
    } else {
      result = { ok: false, error: raw.error ?? `${target.label} reported a failure.` }
    }
  } catch (error) {
    result = { ok: false, error: `${target.label}: ${describe(error)}` }
  }

  // A failed send almost always means the user needs to sign in or solve a
  // challenge, so bring the window forward. A successful send hides it again
  // unless the user has already taken focus.
  if (!win.isDestroyed()) {
    if (!result.ok) {
      win.show()
      win.focus()
    } else if (!win.isFocused()) {
      win.hide()
    }
  }

  return result
}

/** Show the target window so the user can sign in before the first send. */
export async function openWebChat(targetId: WebChatTargetId): Promise<void> {
  const target = findTarget(targetId)
  if (!target) return
  const win = await ensureWindow(target)
  win.show()
  win.focus()
}

/**
 * Ask any in-flight send to stop on its next poll. The polling loop inside
 * the page checks the flag every 500 ms; the result is discarded as a
 * cancellation, not treated as an error.
 */
export function cancelWebChat(): void {
  for (const win of windows.values()) {
    if (win.isDestroyed()) continue
    win.webContents
      .executeJavaScript('window.__larpgentWebChatAbort = true;', true)
      .catch(() => undefined)
  }
}