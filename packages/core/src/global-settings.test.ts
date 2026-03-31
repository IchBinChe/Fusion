import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { GlobalSettingsStore } from "./global-settings.js";
import { DEFAULT_GLOBAL_SETTINGS } from "./types.js";
import { readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "kb-global-settings-test-"));
}

describe("GlobalSettingsStore", () => {
  let dir: string;
  let store: GlobalSettingsStore;

  beforeEach(() => {
    dir = makeTmpDir();
    store = new GlobalSettingsStore(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  describe("init()", () => {
    it("creates the directory and settings.json if missing", async () => {
      const nested = join(dir, "nested", "deep");
      const nestedStore = new GlobalSettingsStore(nested);

      const created = await nestedStore.init();

      expect(created).toBe(true);
      expect(existsSync(join(nested, "settings.json"))).toBe(true);
    });

    it("creates settings.json with defaults on first init", async () => {
      await store.init();

      const raw = await readFile(join(dir, "settings.json"), "utf-8");
      const parsed = JSON.parse(raw);
      expect(parsed.themeMode).toBe("dark");
      expect(parsed.colorTheme).toBe("default");
      expect(parsed.ntfyEnabled).toBe(false);
    });

    it("returns false if settings.json already exists", async () => {
      await store.init(); // creates file
      const created = await store.init(); // second call
      expect(created).toBe(false);
    });

    it("preserves existing settings on re-init", async () => {
      await store.init();
      await store.updateSettings({ themeMode: "light" });

      const created = await store.init();
      expect(created).toBe(false);

      const settings = await store.getSettings();
      expect(settings.themeMode).toBe("light");
    });
  });

  describe("getSettings()", () => {
    it("returns defaults when file does not exist", async () => {
      const settings = await store.getSettings();

      expect(settings).toEqual(DEFAULT_GLOBAL_SETTINGS);
    });

    it("returns persisted values merged with defaults", async () => {
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, "settings.json"),
        JSON.stringify({ themeMode: "light", colorTheme: "ocean" }),
      );

      const settings = await store.getSettings();

      expect(settings.themeMode).toBe("light");
      expect(settings.colorTheme).toBe("ocean");
      // Defaults are filled in for missing fields
      expect(settings.ntfyEnabled).toBe(false);
      expect(settings.defaultProvider).toBeUndefined();
    });

    it("returns defaults on invalid JSON", async () => {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "settings.json"), "not-json{{{");

      const settings = await store.getSettings();

      expect(settings).toEqual(DEFAULT_GLOBAL_SETTINGS);
    });

    it("returns defaults when directory does not exist", async () => {
      const nonExistent = new GlobalSettingsStore(join(dir, "nope", "nada"));
      const settings = await nonExistent.getSettings();

      expect(settings).toEqual(DEFAULT_GLOBAL_SETTINGS);
    });
  });

  describe("updateSettings()", () => {
    it("persists a partial update and returns merged settings", async () => {
      await store.init();

      const updated = await store.updateSettings({ themeMode: "system" });

      expect(updated.themeMode).toBe("system");
      expect(updated.colorTheme).toBe("default"); // unchanged default

      // Verify persistence
      const raw = await readFile(join(dir, "settings.json"), "utf-8");
      const parsed = JSON.parse(raw);
      expect(parsed.themeMode).toBe("system");
    });

    it("merges multiple updates without losing fields", async () => {
      await store.init();

      await store.updateSettings({ defaultProvider: "anthropic", defaultModelId: "claude-sonnet-4-5" });
      await store.updateSettings({ ntfyEnabled: true, ntfyTopic: "my-topic" });

      const settings = await store.getSettings();
      expect(settings.defaultProvider).toBe("anthropic");
      expect(settings.defaultModelId).toBe("claude-sonnet-4-5");
      expect(settings.ntfyEnabled).toBe(true);
      expect(settings.ntfyTopic).toBe("my-topic");
      expect(settings.themeMode).toBe("dark"); // preserved default
    });

    it("creates directory if missing", async () => {
      const nested = join(dir, "auto", "create");
      const nestedStore = new GlobalSettingsStore(nested);

      await nestedStore.updateSettings({ themeMode: "light" });

      expect(existsSync(join(nested, "settings.json"))).toBe(true);
      const settings = await nestedStore.getSettings();
      expect(settings.themeMode).toBe("light");
    });

    it("can clear a field by setting it to undefined", async () => {
      await store.init();
      await store.updateSettings({ defaultProvider: "anthropic" });
      await store.updateSettings({ defaultProvider: undefined });

      const settings = await store.getSettings();
      expect(settings.defaultProvider).toBeUndefined();
    });

    it("handles concurrent updates safely via locking", async () => {
      await store.init();

      // Fire 10 concurrent updates
      const promises = Array.from({ length: 10 }, (_, i) =>
        store.updateSettings({ ntfyTopic: `topic-${i}` }),
      );
      await Promise.all(promises);

      // The final value should be one of the submitted values (last writer wins)
      const settings = await store.getSettings();
      expect(settings.ntfyTopic).toMatch(/^topic-\d$/);
    });
  });

  describe("getSettingsPath()", () => {
    it("returns the path to settings.json", () => {
      const path = store.getSettingsPath();
      expect(path).toBe(join(dir, "settings.json"));
    });
  });

  describe("atomic writes", () => {
    it("does not leave tmp files after a successful write", async () => {
      await store.init();
      await store.updateSettings({ themeMode: "light" });

      const tmpPath = join(dir, "settings.json.tmp");
      expect(existsSync(tmpPath)).toBe(false);
    });
  });
});
