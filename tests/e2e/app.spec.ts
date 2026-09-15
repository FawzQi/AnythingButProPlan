import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
} from "@playwright/test";

/**
 * Electron E2E needs a display. On a headless machine run these under xvfb-run:
 *   xvfb-run -a npm run test:e2e
 */
let app: ElectronApplication;
let projectRoot: string;

test.beforeAll(async () => {
  projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "LARPGent-e2e-"));
  await fs.mkdir(path.join(projectRoot, "src"), { recursive: true });
  await fs.writeFile(
    path.join(projectRoot, "src", "app.ts"),
    "export const app = () => 1\n",
    "utf8",
  );
  await fs.writeFile(path.join(projectRoot, "README.md"), "# e2e\n", "utf8");

  app = await electron.launch({ args: ["."] });
});

test.afterAll(async () => {
  await app?.close();
  await fs.rm(projectRoot, { recursive: true, force: true });
});

test("opens a window with the three panels", async () => {
  const page = await app.firstWindow();
  await expect(page.getByRole("heading", { name: "LARPGent" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Project" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Prompt" })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "AI Response" }),
  ).toBeVisible();
});

test("parses a pasted response into a diff-able file table", async () => {
  const page = await app.firstWindow();
  const response = [
    "File: src/app.ts",
    "",
    "```typescript",
    "export const app = () => 2",
    "```",
  ].join("\n");

  await page.getByPlaceholder(/Paste the AI response/).fill(response);

  await expect(page.getByText("src/app.ts")).toBeVisible();
  await expect(page.getByText("strategy: markdown")).toBeVisible();
  await expect(page.getByText("File: header")).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Apply 1 file/ }),
  ).toBeEnabled();
});

test("opens a folder, previews the diff, and writes on confirmation", async () => {
  await app.evaluate(async ({ dialog }, root) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [root],
    });
  }, projectRoot);

  const page = await app.firstWindow();
  await page.getByRole("button", { name: "Open folder" }).click();
  await expect(page.getByText("src", { exact: true })).toBeVisible();

  await page
    .getByPlaceholder(/Paste the AI response/)
    .fill(
      [
        "File: src/app.ts",
        "",
        "```typescript",
        "export const app = () => 2",
        "```",
        "",
        "File: src/brand-new.ts",
        "",
        "```typescript",
        "export const brandNew = () => true",
        "```",
      ].join("\n"),
    );

  // src/app.ts is on disk, src/brand-new.ts is not.
  await expect(page.getByText("overwrite")).toBeVisible();
  await expect(page.getByText("create")).toBeVisible();

  await page.getByRole("button", { name: "View" }).first().click();
  await expect(page.getByText("On disk")).toBeVisible();
  await expect(page.getByText("Proposed")).toBeVisible();
  await page.getByRole("button", { name: "Close" }).click();

  // The confirmation gate is the whole point of the apply flow.
  await page.evaluate(() => {
    // The callback runs in the browser, but this project typechecks without
    // the DOM lib, so reach the renderer's global scope through a cast.
    const scope = globalThis as unknown as {
      confirm: (message?: string) => boolean;
    };
    scope.confirm = () => true;
  });
  await page.getByRole("button", { name: /Apply 2 file/ }).click();

  await expect(page.getByText(/1 overwritten, 1 created/)).toBeVisible();
  // No blank line before the closing fence, so the block has no trailing
  // newline — content is written exactly as the model produced it.
  await expect
    .poll(() => fs.readFile(path.join(projectRoot, "src", "app.ts"), "utf8"))
    .toBe("export const app = () => 2");
  await expect
    .poll(() =>
      fs.readFile(path.join(projectRoot, "src", "brand-new.ts"), "utf8"),
    )
    .toBe("export const brandNew = () => true");
  // The previous version is preserved.
  await expect
    .poll(() =>
      fs.readFile(path.join(projectRoot, "src", "app.ts.bak"), "utf8"),
    )
    .toBe("export const app = () => 1\n");
});
