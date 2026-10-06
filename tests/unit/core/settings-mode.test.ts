import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `src/main/services/settings.ts` reaches for `electron` at import time, so
 * the mode is stubbed here and the settings file is written into a temp
 * directory. The point of the test is the migration path, not the storage:
 * a settings file written before research mode existed has no `mode` field,
 * and a hand-edited one can hold anything at all.
 */
const dir = path.join(os.tmpdir(), `abpp-settings-${process.pid}`);

vi.mock("electron", () => ({
  app: { getPath: () => dir },
  // No keyring in the test environment — the settings module falls back to
  // base64, which is fine: no test here touches an API key.
  safeStorage: { isEncryptionAvailable: () => false },
}));

const { getSettings, saveSettings } = await import(
  "../../../src/main/services/core/settings"
);

function settingsFile(): string {
  return path.join(dir, "ai-settings.json");
}

beforeEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("mode persistence", () => {
  it("defaults to coding when there is no settings file", async () => {
    expect((await getSettings()).mode).toBe("coding");
  });

  it("round-trips research mode through a save and a reload", async () => {
    await saveSettings({ mode: "research" });
    expect((await getSettings()).mode).toBe("research");
    expect(JSON.parse(await fs.readFile(settingsFile(), "utf8")).mode).toBe(
      "research",
    );
  });

  it("migrates a pre-research settings file to coding mode", async () => {
    // Exactly the shape written before this feature: no `mode` key at all.
    await fs.writeFile(
      settingsFile(),
      JSON.stringify({
        provider: "deepseek",
        encryptedKeys: {},
        modelByProvider: {},
        suggestMethod: "gitnexus-llm",
      }),
      "utf8",
    );
    const settings = await getSettings();
    expect(settings.mode).toBe("coding");
    // The untouched fields survive the migration.
    expect(settings.suggestMethod).toBe("gitnexus-llm");
  });

  it("falls back to coding on a hand-edited mode value", async () => {
    await fs.writeFile(
      settingsFile(),
      JSON.stringify({ mode: "researchish" }),
      "utf8",
    );
    expect((await getSettings()).mode).toBe("coding");
  });

  it("leaves the mode alone when another field is saved", async () => {
    await saveSettings({ mode: "research" });
    await saveSettings({ suggestMethod: "gitnexus-jev" });
    expect((await getSettings()).mode).toBe("research");
  });

  it("defaults HyDE settings correctly and round-trips them", async () => {
    const initial = await getSettings();
    expect(initial.enableHydeQuery).toBe(false);
    expect(initial.hydeProvider).toBe("deepseek");
    expect(initial.hydeModel).toBe("deepseek-flash");

    await saveSettings({
      enableHydeQuery: true,
      hydeProvider: "groq",
      hydeModel: "llama-3.3-70b-versatile",
    });

    const updated = await getSettings();
    expect(updated.enableHydeQuery).toBe(true);
    expect(updated.hydeProvider).toBe("groq");
    expect(updated.hydeModel).toBe("llama-3.3-70b-versatile");
  });
});
