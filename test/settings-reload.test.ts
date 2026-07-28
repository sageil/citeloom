import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  ApplicationStateRevisionSignal,
  ApplicationStateRevisionSource,
  ApplicationStateRevisionSubscriber,
} from "../src/app/application-state-revisions.js";
import type { EffectiveApplicationSettings } from "../src/app/settings.js";
import {
  createSettingsReloadController,
} from "../src/api/services.js";
import {
  createTestRuntimeSettings,
  readEqualWeightTestConfig,
} from "./config-fixture.js";
import { createDeferred } from "./deferred-fixture.js";
import { createTestProviderSettings } from "./provider-settings-fixture.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("web settings reload controller", () => {
  it("reloads every simulated web instance after one committed revision", async () => {
    const revisions = new MemoryApplicationStateRevisionSource();
    const settings = buildEffectiveSettings(2);
    const first = buildRuntimeState(1);
    const second = buildRuntimeState(1);
    const firstController = createSettingsReloadController({
      readCurrentVersion: () => first.version,
      readSettings: async () => settings,
      reload: async (config) => {
        first.version = config.settingsVersion;
        return true;
      },
      revisions,
    });
    const secondController = createSettingsReloadController({
      readCurrentVersion: () => second.version,
      readSettings: async () => settings,
      reload: async (config) => {
        second.version = config.settingsVersion;
        return true;
      },
      revisions,
    });

    revisions.publish({ channel: "settings", revision: "2" });

    await vi.waitFor(() => {
      expect(first.version).toBe(2);
      expect(second.version).toBe(2);
    });
    await firstController.close();
    await secondController.close();
  });

  it("detects a missed revision through the bounded fallback poll", async () => {
    vi.useFakeTimers();
    const revisions = new MemoryApplicationStateRevisionSource();
    const settings = buildEffectiveSettings(2);
    const state = buildRuntimeState(1);
    const controller = createSettingsReloadController({
      fallbackIntervalMs: 25,
      readCurrentVersion: () => state.version,
      readSettings: async () => settings,
      reload: async (config) => {
        state.version = config.settingsVersion;
        return true;
      },
      revisions,
    });

    await vi.advanceTimersByTimeAsync(25);

    expect(state.version).toBe(2);
    await controller.close();
  });

  it("coalesces concurrent revision signals and rechecks after an in-flight read", async () => {
    const revisions = new MemoryApplicationStateRevisionSource();
    const settings = buildEffectiveSettings(2);
    const state = buildRuntimeState(1);
    const firstRead = createDeferred();
    let readCount = 0;
    const controller = createSettingsReloadController({
      readCurrentVersion: () => state.version,
      readSettings: async () => {
        readCount += 1;
        if (readCount === 1) {
          await firstRead.promise;
        }
        return settings;
      },
      reload: async (config) => {
        state.version = config.settingsVersion;
        return true;
      },
      revisions,
    });

    revisions.publish({ channel: "settings", revision: "2" });
    revisions.publish({ channel: "settings", revision: "3" });
    expect(readCount).toBe(1);
    firstRead.resolve();

    await vi.waitFor(() => expect(readCount).toBe(2));
    expect(state.version).toBe(2);
    await controller.close();
  });
});

class MemoryApplicationStateRevisionSource implements ApplicationStateRevisionSource {
  private readonly subscribers = new Set<ApplicationStateRevisionSubscriber>();

  public async close(): Promise<void> {
    this.subscribers.clear();
  }

  public publish(signal: ApplicationStateRevisionSignal): void {
    for (const subscriber of this.subscribers) {
      subscriber(signal);
    }
  }

  public subscribe(subscriber: ApplicationStateRevisionSubscriber): () => void {
    this.subscribers.add(subscriber);
    return (): void => {
      this.subscribers.delete(subscriber);
    };
  }

  public async waitForSignal(): Promise<void> {}
}

function buildRuntimeState(version: number): { version: number } {
  return { version };
}

function buildEffectiveSettings(version: number): EffectiveApplicationSettings {
  const runtimeSettings = createTestRuntimeSettings();
  const providerSettings = createTestProviderSettings();
  const config = readEqualWeightTestConfig({
    providerSettings,
    runtime: runtimeSettings,
    settingsVersion: version,
  });
  return {
    config,
    defaults: runtimeSettings,
    overrides: {},
    providerSettings,
    runtimeSettings,
    updatedAt: null,
    version,
  };
}
