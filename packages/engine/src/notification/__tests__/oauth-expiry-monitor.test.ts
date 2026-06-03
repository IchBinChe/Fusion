import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OAuthAlertStateStore } from "../oauth-alert-state.js";
import { OAuthExpiryMonitor, type AuthStorageLike } from "../oauth-expiry-monitor.js";

const tempDirs: string[] = [];

function createStatePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "oauth-expiry-monitor-"));
  tempDirs.push(dir);
  return join(dir, "oauth-alert-state.json");
}

function createAuthStorage(initialCredential?: { type?: string; expires?: number }): AuthStorageLike & {
  credential: { type?: string; expires?: number } | undefined;
} {
  return {
    credential: initialCredential,
    reload: vi.fn(),
    getOAuthProviders: () => [{ id: "openai-codex", name: "OpenAI Codex" }],
    get(providerId: string) {
      if (providerId !== "openai-codex") {
        return undefined;
      }
      return this.credential;
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("OAuthExpiryMonitor", () => {
  it("fires once when an OAuth credential is expired", async () => {
    vi.useFakeTimers();
    const now = Date.now();
    const authStorage = createAuthStorage({ type: "oauth", expires: now - 1_000 });
    const dispatch = vi.fn(async () => undefined);

    const monitor = new OAuthExpiryMonitor({
      authStorage,
      notificationService: { dispatch } as any,
      intervalMs: 100,
      clock: () => now,
      alertState: new OAuthAlertStateStore({ statePath: createStatePath(), clock: () => now }),
    });

    await monitor.start();
    await vi.runOnlyPendingTimersAsync();

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(
      "oauth-token-expired",
      expect.objectContaining({
        event: "oauth-token-expired",
        metadata: expect.objectContaining({
          providerId: "openai-codex",
          providerName: "OpenAI Codex",
        }),
      }),
    );
    monitor.stop();
  });

  it("does not fire for non-expired/non-oauth credentials", async () => {
    vi.useFakeTimers();
    const dispatch = vi.fn(async () => undefined);
    const now = Date.now();

    const cases: Array<{ type?: string; expires?: number } | undefined> = [
      { type: "api_key" },
      { type: "oauth" },
      { type: "oauth", expires: now + 60_000 },
      undefined,
    ];

    for (const credential of cases) {
      const authStorage = createAuthStorage(credential);
      const monitor = new OAuthExpiryMonitor({
        authStorage,
        notificationService: { dispatch } as any,
        intervalMs: 100,
        clock: () => now,
        alertState: new OAuthAlertStateStore({ statePath: createStatePath(), clock: () => now }),
      });

      await monitor.start();
      await vi.runOnlyPendingTimersAsync();
      monitor.stop();
    }

    expect(dispatch).not.toHaveBeenCalled();
  });

  it("deduplicates dispatches for same provider and expiry", async () => {
    vi.useFakeTimers();
    const now = Date.now();
    const authStorage = createAuthStorage({ type: "oauth", expires: now - 1 });
    const dispatch = vi.fn(async () => undefined);

    const monitor = new OAuthExpiryMonitor({
      authStorage,
      notificationService: { dispatch } as any,
      intervalMs: 100,
      clock: () => now,
      alertState: new OAuthAlertStateStore({ statePath: createStatePath(), clock: () => now }),
    });

    await monitor.start();
    await vi.advanceTimersByTimeAsync(200);

    expect(dispatch).toHaveBeenCalledTimes(1);
    monitor.stop();
  });

  it("re-fires after credential is replaced with a new expiry that later expires", async () => {
    vi.useFakeTimers();
    let now = Date.now();
    const statePath = createStatePath();
    const authStorage = createAuthStorage({ type: "oauth", expires: now - 1 });
    const dispatch = vi.fn(async () => undefined);

    const monitor = new OAuthExpiryMonitor({
      authStorage,
      notificationService: { dispatch } as any,
      intervalMs: 100,
      clock: () => now,
      alertState: new OAuthAlertStateStore({ statePath, clock: () => now }),
    });

    await monitor.start();
    expect(dispatch).toHaveBeenCalledTimes(1);

    authStorage.credential = { type: "oauth", expires: now + 1_000 };
    await vi.advanceTimersByTimeAsync(100);

    now += 2_000;
    await vi.advanceTimersByTimeAsync(100);

    expect(dispatch).toHaveBeenCalledTimes(1);

    now += 12 * 60 * 60 * 1000;
    await vi.advanceTimersByTimeAsync(100);

    expect(dispatch).toHaveBeenCalledTimes(2);
    monitor.stop();
  });

  it("throttles changed expiries until min notify interval elapses across restarts", async () => {
    vi.useFakeTimers();
    let now = Date.now();
    const statePath = createStatePath();
    const authStorage = createAuthStorage({ type: "oauth", expires: now - 1 });
    const dispatch = vi.fn(async () => undefined);

    const firstMonitor = new OAuthExpiryMonitor({
      authStorage,
      notificationService: { dispatch } as any,
      minNotifyIntervalMs: 1_000,
      clock: () => now,
      alertState: new OAuthAlertStateStore({ statePath, clock: () => now }),
    });

    await firstMonitor.start();
    firstMonitor.stop();
    expect(dispatch).toHaveBeenCalledTimes(1);

    now += 500;
    authStorage.credential = { type: "oauth", expires: now - 2 };
    const restartedMonitor = new OAuthExpiryMonitor({
      authStorage,
      notificationService: { dispatch } as any,
      minNotifyIntervalMs: 1_000,
      clock: () => now,
      alertState: new OAuthAlertStateStore({ statePath, clock: () => now }),
    });

    await restartedMonitor.start();
    restartedMonitor.stop();
    expect(dispatch).toHaveBeenCalledTimes(1);

    now += 500;
    authStorage.credential = { type: "oauth", expires: now - 3 };
    await restartedMonitor.start();
    restartedMonitor.stop();
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it("does not persist lastAlertAt when dispatch fails", async () => {
    let now = Date.now();
    const statePath = createStatePath();
    const authStorage = createAuthStorage({ type: "oauth", expires: now - 1 });
    const dispatch = vi.fn(async () => {
      throw new Error("boom");
    });

    const firstMonitor = new OAuthExpiryMonitor({
      authStorage,
      notificationService: { dispatch } as any,
      minNotifyIntervalMs: 1_000,
      clock: () => now,
      alertState: new OAuthAlertStateStore({ statePath, clock: () => now }),
    });
    await firstMonitor.start();
    firstMonitor.stop();
    expect(dispatch).toHaveBeenCalledTimes(1);

    const secondDispatch = vi.fn(async () => undefined);
    now += 100;
    const restartedMonitor = new OAuthExpiryMonitor({
      authStorage,
      notificationService: { dispatch: secondDispatch } as any,
      minNotifyIntervalMs: 1_000,
      clock: () => now,
      alertState: new OAuthAlertStateStore({ statePath, clock: () => now }),
    });
    await restartedMonitor.start();
    restartedMonitor.stop();

    expect(secondDispatch).toHaveBeenCalledTimes(1);
  });

  it("clears persisted state when providers disappear", async () => {
    let now = Date.now();
    const statePath = createStatePath();
    const authStorage = createAuthStorage({ type: "oauth", expires: now - 1 });
    const dispatch = vi.fn(async () => undefined);

    const firstMonitor = new OAuthExpiryMonitor({
      authStorage,
      notificationService: { dispatch } as any,
      minNotifyIntervalMs: 1_000,
      clock: () => now,
      alertState: new OAuthAlertStateStore({ statePath, clock: () => now }),
    });
    await firstMonitor.start();
    firstMonitor.stop();
    expect(dispatch).toHaveBeenCalledTimes(1);

    const noProviderStorage: AuthStorageLike = {
      reload: vi.fn(),
      getOAuthProviders: () => [],
      get: () => undefined,
    };
    const clearingMonitor = new OAuthExpiryMonitor({
      authStorage: noProviderStorage,
      notificationService: { dispatch } as any,
      minNotifyIntervalMs: 1_000,
      clock: () => now,
      alertState: new OAuthAlertStateStore({ statePath, clock: () => now }),
    });
    await clearingMonitor.start();
    clearingMonitor.stop();

    now += 100;
    const restartedMonitor = new OAuthExpiryMonitor({
      authStorage,
      notificationService: { dispatch } as any,
      minNotifyIntervalMs: 1_000,
      clock: () => now,
      alertState: new OAuthAlertStateStore({ statePath, clock: () => now }),
    });
    await restartedMonitor.start();
    restartedMonitor.stop();

    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it("stop cancels the interval", async () => {
    vi.useFakeTimers();
    const now = Date.now();
    const authStorage = createAuthStorage({ type: "oauth", expires: now - 1 });
    const dispatch = vi.fn(async () => undefined);

    const monitor = new OAuthExpiryMonitor({
      authStorage,
      notificationService: { dispatch } as any,
      intervalMs: 100,
      clock: () => now,
      alertState: new OAuthAlertStateStore({ statePath: createStatePath(), clock: () => now }),
    });

    await monitor.start();
    monitor.stop();
    await vi.advanceTimersByTimeAsync(500);

    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});
