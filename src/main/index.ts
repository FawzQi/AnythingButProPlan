import path from "node:path";
import { app, BrowserWindow, shell } from "electron";
import { registerIpcHandlers } from "./ipc";
import { closeAllWebChatWindows } from "./services/web-chat";

// Remove the `AutomationControlled` blink feature before Chromium starts.
// Without this switch, `navigator.webdriver` reports true in every window
// the app creates, and several chat sites refuse to serve an automated
// session. Set here rather than inside the web-chat service because
// Chromium reads its command-line switches during start-up, and
// `whenReady` is already too late.
app.commandLine.appendSwitch("disable-blink-features", "AutomationControlled");

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: "#16181d",
    title: "AnythingButProPlan",
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  window.on("ready-to-show", () => window.show());

  // The web chat windows are created hidden and are never closed by the
  // app, so Electron would keep the process alive after the main window is
  // gone — `window-all-closed` never fires while one of them is still open.
  // Tear them down here so closing the main window actually quits the app
  // on every platform.
  window.on("closed", () => closeAllWebChatWindows());

  // `shell.openExternal` will hand the URL to the OS, which dispatches on the
  // scheme. Passing an attacker-controlled URL — including `file://`,
  // `smb://`, `vbscript:`, or any registered custom handler — is a documented
  // Electron privilege-escalation risk: a compromised or XSS'd renderer could
  // launch local programs, mount network shares, or trigger protocol handlers
  // without a prompt. Restricting to http(s) matches the only legitimate use
  // (opening a documentation or search link), and any other scheme is
  // silently dropped instead of refused with an error banner the user cannot
  // act on.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });

  const rendererUrl = process.env["ELECTRON_RENDERER_URL"];
  if (rendererUrl) {
    void window.loadURL(rendererUrl);
  } else {
    void window.loadFile(path.join(__dirname, "../renderer/index.html"));
  }

  return window;
}

void app.whenReady().then(() => {
  registerIpcHandlers();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// On macOS the app stays alive after the last window closes, so an explicit
// quit is the only signal that the chat windows should go. Closing them here
// as well covers that path without changing the platform behaviour above.
app.on("before-quit", () => {
  closeAllWebChatWindows();
});
