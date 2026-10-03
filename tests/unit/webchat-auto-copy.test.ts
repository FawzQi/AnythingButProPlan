import { describe, expect, it, vi, beforeEach } from "vitest";
import type { WebChatResponsePushedPayload } from "../../src/shared/types";
import type { BrowserWindow } from "electron";

let fakeClipboardText = "";
const mockClipboard = {
  readText: vi.fn(async () => fakeClipboardText),
  writeText: vi.fn((text: string) => {
    fakeClipboardText = text;
  }),
};

vi.mock("electron", () => ({
  app: { on: vi.fn() },
  clipboard: mockClipboard,
  BrowserWindow: vi.fn(),
}));

const {
  setWebChatResponsePushListener,
  scrapeWebChatResponse,
  autoCopyLatestResponse,
  getWebChatStatuses,
  _setWindowForTest,
  _setStatusForTest,
  _setGenerationObservedForTest,
  _pollOpenWindowsStatusForTest,
} = await import("../../src/main/services/web-chat");

describe("Web chat response scraping", () => {
  beforeEach(() => {
    fakeClipboardText = "";
    vi.clearAllMocks();
    _setWindowForTest("deepseek", null);
    _setWindowForTest("claude", null);
    _setStatusForTest("deepseek", "idle");
    _setStatusForTest("claude", "idle");
  });

  it("scrapeWebChatResponse returns error when no window exists", async () => {
    const result = await scrapeWebChatResponse("deepseek");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("No open web chat window");
  });

  it("extracts response via copy candidate, updates clipboard and returns text", async () => {
    const mockResponseText = "```typescript\nconst x = 42;\n```\nHere is your code.";

    const fakeWin = {
      isDestroyed: () => false,
      webContents: {
        isDestroyed: () => false,
        executeJavaScript: vi.fn(async (script: string) => {
          if (script.includes("el.click()")) {
            fakeClipboardText = mockResponseText;
            return { clicked: true, capturedText: mockResponseText };
          }
          if (script.includes("CopyCandidates")) return 1;
          return null;
        }),
      },
    } as unknown as BrowserWindow;

    _setWindowForTest("deepseek", fakeWin);

    const result = await scrapeWebChatResponse("deepseek");
    expect(result.ok).toBe(true);
    expect(result.text).toBe(mockResponseText);
    expect(mockClipboard.writeText).toHaveBeenCalledWith(mockResponseText);
  });

  it("falls back to DOM scraping when copy candidate click fails", async () => {
    const fallbackMarkdown = "```javascript\nconsole.log('scraped');\n```";

    const fakeWin = {
      isDestroyed: () => false,
      webContents: {
        isDestroyed: () => false,
        executeJavaScript: vi.fn(async (script: string) => {
          if (script.includes("CopyCandidates")) return 0;
          if (script.includes("cleanAssistantText")) {
            return fallbackMarkdown;
          }
          return null;
        }),
      },
    } as unknown as BrowserWindow;

    _setWindowForTest("claude", fakeWin);

    const result = await scrapeWebChatResponse("claude");
    expect(result.ok).toBe(true);
    expect(result.text).toBe(fallbackMarkdown);
  });

  it("does NOT auto-scrape when browsing history (generationObserved is false)", async () => {
    const pushed: WebChatResponsePushedPayload[] = [];
    setWebChatResponsePushListener((payload) => {
      pushed.push(payload);
    });

    const fakeWin = {
      isDestroyed: () => false,
      webContents: {
        isDestroyed: () => false,
        isLoading: () => false,
        executeJavaScript: vi.fn(async () => "idle"),
      },
    } as unknown as BrowserWindow;

    _setWindowForTest("deepseek", fakeWin);

    // Initial state: idle and generationObserved is false
    _setStatusForTest("deepseek", "idle");
    _setGenerationObservedForTest("deepseek", false);

    // Poll status: remains idle
    await _pollOpenWindowsStatusForTest();
    await _pollOpenWindowsStatusForTest();

    expect(pushed).toHaveLength(0);
    expect(fakeClipboardText).toBe("");
  });

  it("safely auto-scrapes and pushes response when generation finishes (working -> idle)", async () => {
    const pushed: WebChatResponsePushedPayload[] = [];
    setWebChatResponsePushListener((payload) => {
      pushed.push(payload);
    });

    const fullResponse =
      "===Files===\nFile: a.ts\n```typescript\nconst a = 1;\n```\n======\n===Explanation===\nDone.\n======";

    let inspectionResult = "working";
    const fakeWin = {
      isDestroyed: () => false,
      isFocused: () => true,
      webContents: {
        isDestroyed: () => false,
        isLoading: () => false,
        executeJavaScript: vi.fn(async (script: string) => {
          if (
            script.includes("STATUS_INSPECTION_SCRIPT") ||
            script.includes("__AnythingButProPlanWebChatStatus") ||
            script.includes("ds-thinking")
          ) {
            return inspectionResult;
          }
          if (script.includes("respSels") || script.includes("cleanAssistantText")) {
            return fullResponse;
          }
          if (script.includes("CopyCandidates")) {
            return 0;
          }
          return inspectionResult;
        }),
      },
    } as unknown as BrowserWindow;

    _setWindowForTest("deepseek", fakeWin);

    // Poll 1: Chat is actively working
    await _pollOpenWindowsStatusForTest();
    expect(getWebChatStatuses().deepseek).toBe("working");
    expect(pushed).toHaveLength(0);

    // AI finishes generating: inspection reports idle
    inspectionResult = "idle";

    // Poll 2: First idle tick (debouncing, remains working)
    await _pollOpenWindowsStatusForTest();
    expect(getWebChatStatuses().deepseek).toBe("working");
    expect(pushed).toHaveLength(0);

    // Poll 3: Second consecutive idle tick (idle confirmed, triggers auto-scrape)
    await _pollOpenWindowsStatusForTest();
    expect(getWebChatStatuses().deepseek).toBe("idle");

    // Allow auto-scrape settle delay (500ms) to complete
    await new Promise((resolve) => setTimeout(resolve, 600));

    expect(pushed).toHaveLength(1);
    expect(pushed[0]).toEqual({
      target: "deepseek",
      text: fullResponse,
    });
    expect(fakeClipboardText).toBe(fullResponse);
  });

  it("ensures script includes negative guards for regenerate, retry, and user/composer elements", async () => {
    let scriptPassed = "";
    let clickScriptPassed = "";
    const fakeWin = {
      isDestroyed: () => false,
      isFocused: () => true,
      webContents: {
        isDestroyed: () => false,
        executeJavaScript: vi.fn(async (script: string) => {
          if (script.includes("el.click()")) {
            clickScriptPassed = script;
            return { clicked: true, capturedText: "sample" };
          }
          if (script.includes("isCodeBlockControl") || script.includes("outerPool")) {
            scriptPassed = script;
            return 1;
          }
          return null;
        }),
      },
    } as unknown as BrowserWindow;

    _setWindowForTest("deepseek", fakeWin);
    await scrapeWebChatResponse("deepseek");

    expect(scriptPassed).toContain("regenerat");
    expect(scriptPassed).toContain("重新生成");
    expect(scriptPassed).toContain("retry");
    expect(scriptPassed).toContain("user-message");
    expect(scriptPassed).toContain("composer");
    expect(scriptPassed).toContain("chat-input");

    expect(clickScriptPassed).toContain("user-message");
    expect(clickScriptPassed).toContain("composer");
    expect(clickScriptPassed).toContain("chat-input");
  });

  it("ensures candidate collection script excludes code block controls", async () => {
    let scriptPassed = "";
    const fakeWin = {
      isDestroyed: () => false,
      webContents: {
        isDestroyed: () => false,
        executeJavaScript: vi.fn(async (script: string) => {
          if (script.includes("CopyCandidates")) {
            scriptPassed = script;
            return 0;
          }
          return null;
        }),
      },
    } as unknown as BrowserWindow;

    _setWindowForTest("deepseek", fakeWin);
    await scrapeWebChatResponse("deepseek");

    expect(scriptPassed).toContain("isCodeBlockControl");
    expect(scriptPassed).toContain("code-block");
  });

  it("rejects partial code block copy candidate in favor of full scraped response", async () => {
    const fullScrapedResponse =
      "===Files===\nFile: src/index.ts\n```typescript\nconst x = 42;\n```\n======\n===Explanation===\nThis is the complete explanation of what changed.\n======";
    const partialCodeBlockOnly = "```typescript\nconst x = 42;\n```";

    const fakeWin = {
      isDestroyed: () => false,
      isFocused: () => true,
      webContents: {
        isDestroyed: () => false,
        executeJavaScript: vi.fn(async (script: string) => {
          // If scraping DOM:
          if (script.includes("respSels") || script.includes("cleanAssistantText")) {
            return fullScrapedResponse;
          }
          // If collecting copy candidates:
          if (script.includes("CopyCandidates")) {
            return 1;
          }
          // If clicking copy candidate: it only returned the code block!
          if (script.includes("el.click()")) {
            fakeClipboardText = partialCodeBlockOnly;
            return { clicked: true, capturedText: partialCodeBlockOnly };
          }
          return null;
        }),
      },
    } as unknown as BrowserWindow;

    _setWindowForTest("deepseek", fakeWin);
    const result = await scrapeWebChatResponse("deepseek");

    expect(result.ok).toBe(true);
    // Must return the full scraped response with Explanation, NOT just the code block fragment!
    expect(result.text).toBe(fullScrapedResponse);
    expect(result.text).toContain("===Explanation===");
  });

  describe("Status Poller & Glitch Suppression (Hysteresis)", () => {
    it("immediately transitions from idle to working when inspected as working", async () => {
      _setStatusForTest("deepseek", "idle");

      const fakeWin = {
        isDestroyed: () => false,
        webContents: {
          isDestroyed: () => false,
          isLoading: () => false,
          executeJavaScript: vi.fn(async () => "working"),
        },
      } as unknown as BrowserWindow;

      _setWindowForTest("deepseek", fakeWin);
      await _pollOpenWindowsStatusForTest();

      expect(getWebChatStatuses().deepseek).toBe("working");
    });

    it("suppresses momentary idle drops (debounces 1 tick) to prevent back-to-back glitching", async () => {
      _setStatusForTest("deepseek", "working");

      let currentInspection = "idle";
      const fakeWin = {
        isDestroyed: () => false,
        webContents: {
          isDestroyed: () => false,
          isLoading: () => false,
          executeJavaScript: vi.fn(async () => currentInspection),
        },
      } as unknown as BrowserWindow;

      _setWindowForTest("deepseek", fakeWin);

      // Tick 1: inspected as idle (e.g. cursor momentarily blinked off)
      await _pollOpenWindowsStatusForTest();
      // Must stay "working" because threshold is 2 consecutive ticks!
      expect(getWebChatStatuses().deepseek).toBe("working");

      // Next tick: inspected back as working (next token arrived)
      currentInspection = "working";
      await _pollOpenWindowsStatusForTest();
      expect(getWebChatStatuses().deepseek).toBe("working");
    });

    it("cleanly transitions to idle after 2 consecutive idle polls", async () => {
      _setStatusForTest("deepseek", "working");

      const fakeWin = {
        isDestroyed: () => false,
        webContents: {
          isDestroyed: () => false,
          isLoading: () => false,
          executeJavaScript: vi.fn(async () => "idle"),
        },
      } as unknown as BrowserWindow;

      _setWindowForTest("deepseek", fakeWin);

      // Tick 1: idle -> still debounced working
      await _pollOpenWindowsStatusForTest();
      expect(getWebChatStatuses().deepseek).toBe("working");

      // Tick 2: idle -> confirmed 2 consecutive idle samples, switches to idle
      await _pollOpenWindowsStatusForTest();
      expect(getWebChatStatuses().deepseek).toBe("idle");
    });

    it("immediately transitions to paused when Continue/Resume is detected", async () => {
      _setStatusForTest("deepseek", "working");

      const fakeWin = {
        isDestroyed: () => false,
        webContents: {
          isDestroyed: () => false,
          isLoading: () => false,
          executeJavaScript: vi.fn(async () => "paused"),
        },
      } as unknown as BrowserWindow;

      _setWindowForTest("deepseek", fakeWin);
      await _pollOpenWindowsStatusForTest();

      expect(getWebChatStatuses().deepseek).toBe("paused");
    });

    it("ensures STATUS_INSPECTION_SCRIPT checks thinking, cursor, stop rect, and text stream", async () => {
      let scriptExecuted = "";
      const fakeWin = {
        isDestroyed: () => false,
        webContents: {
          isDestroyed: () => false,
          isLoading: () => false,
          executeJavaScript: vi.fn(async (s: string) => {
            scriptExecuted = s;
            return "idle";
          }),
        },
      } as unknown as BrowserWindow;

      _setWindowForTest("deepseek", fakeWin);
      await _pollOpenWindowsStatusForTest();

      expect(scriptExecuted).toContain(".ds-thinking");
      expect(scriptExecuted).toContain("thinking");
      expect(scriptExecuted).toContain("reasoning");
      expect(scriptExecuted).toContain(".ds-cursor");
      expect(scriptExecuted).toContain("svg rect");
      expect(scriptExecuted).toContain("__AnythingButProPlanLastObservedText");
    });
  });
});



