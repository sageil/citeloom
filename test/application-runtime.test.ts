import { describe, expect, it, vi } from "vitest";

import {
  ApplicationRuntimeManager,
  buildApplicationRuntime,
  type ApplicationRuntime,
  type ApplicationRuntimeDependencies,
} from "../src/app/runtime.js";
import type { TaskScheduler } from "../src/shared/concurrency.js";
import type { AppConfig } from "../src/config/index.js";
import type {
  CiteLoomDatabase,
  DatabaseSession,
  SqlQueryExecutor,
} from "../src/database/client.js";
import type { InferenceModelRegistry } from "../src/inference/registry.js";
import { readEqualWeightTestConfig } from "./config-fixture.js";
import { createDeferred } from "./deferred-fixture.js";

describe("application runtime", () => {
  it("closes the startup pool once when runtime initialization fails", async () => {
    const close = vi.fn<() => Promise<void>>(async () => undefined);
    const session = buildDatabaseSession(close);
    const startupError = new Error("inference capacity configuration failed");
    const dependencies: ApplicationRuntimeDependencies = {
      createCoordinator: () => ({
        configure: async () => {
          throw startupError;
        },
        createScheduler: () => buildScheduler(),
      }),
      createModels: () => buildModels(),
      ensureEmbeddingSpace: async () => undefined,
      openDatabase: async () => session,
    };

    await expect(
      buildApplicationRuntime(buildConfig(0), dependencies),
    ).rejects.toBe(startupError);
    expect(close).toHaveBeenCalledOnce();
  });

  it("freezes normalized speech-to-text configuration in each runtime snapshot", async () => {
    const close = vi.fn<() => Promise<void>>(async () => undefined);
    const config = buildConfig(0);
    config.speechToText = {
      adapter: "omlx-transcription",
      apiToken: null,
      baseUrl: "http://127.0.0.1:9000/v1",
      providerId: "local-ai",
      language: "English",
      maxAudioBytes: 10 * 1_024 * 1_024,
      model: "Qwen3-ASR-1.7B-8bit",
      prompt: "Preserve CiteLoom.",
      runtimeName: "oMLX",
      timeoutMs: 60_000,
    };
    const dependencies: ApplicationRuntimeDependencies = {
      createCoordinator: () => ({
        configure: async () => undefined,
        createScheduler: () => buildScheduler(),
      }),
      createModels: () => buildModels(),
      ensureEmbeddingSpace: async () => undefined,
      openDatabase: async () => buildDatabaseSession(close),
    };

    const runtime = await buildApplicationRuntime(config, dependencies);

    expect(Object.isFrozen(runtime.config.speechToText)).toBe(true);
    config.speechToText!.model = "mutated-after-build";
    expect(runtime.config.speechToText?.model).toBe("Qwen3-ASR-1.7B-8bit");
    await runtime.close();
    expect(close).toHaveBeenCalledOnce();
  });

  it("builds schedulers from capability provider assignments", async () => {
    const close = vi.fn<() => Promise<void>>(async () => undefined);
    const createScheduler = vi.fn(
      (
        _providerId: string,
        _workload: string,
        _capacity: number,
      ) => buildScheduler(),
    );
    const dependencies: ApplicationRuntimeDependencies = {
      createCoordinator: () => ({
        configure: async () => undefined,
        createScheduler,
      }),
      createModels: () => buildModels(),
      ensureEmbeddingSpace: async () => undefined,
      openDatabase: async () => buildDatabaseSession(close),
    };
    const runtime = await buildApplicationRuntime(
      buildConfig(0),
      dependencies,
    );

    const answer = runtime.scheduler("answer", "interactive-answer");
    const repeatedAnswer = runtime.scheduler("answer", "interactive-answer");
    runtime.scheduler("summarization", "ingestion");
    runtime.scheduler("embedding", "ingestion");

    expect(repeatedAnswer).toBe(answer);
    expect(createScheduler).toHaveBeenCalledTimes(3);
    expect(createScheduler).toHaveBeenCalledWith(
      "lmstudio",
      "interactive-answer",
      1,
    );
    expect(createScheduler).toHaveBeenCalledWith(
      "lmstudio",
      "ingestion",
      1,
    );
    expect(createScheduler).toHaveBeenCalledWith(
      "lmstudio",
      "ingestion",
      1,
    );
    await runtime.close();
  });

  it("keeps the current snapshot available when a settings reload fails", async () => {
    const initial = buildTestRuntime(0);
    const reloadError = new Error("new runtime could not initialize");
    const manager = await ApplicationRuntimeManager.start(
      buildConfig(0),
      async (config) => {
        if (config.settingsVersion === 0) {
          return initial.runtime;
        }
        throw reloadError;
      },
    );

    await expect(manager.reload(buildConfig(1))).rejects.toBe(reloadError);
    await expect(manager.withRuntime(async (runtime) => {
      return runtime.config.settingsVersion;
    })).resolves.toBe(0);
    expect(initial.close).not.toHaveBeenCalled();

    await manager.shutdown();
    expect(initial.close).toHaveBeenCalledOnce();
  });

  it("shares one bounded pool and model registry across concurrent requests", async () => {
    const initial = buildTestRuntime(0);
    const requestGate = createDeferred<void>();
    const manager = await ApplicationRuntimeManager.start(
      buildConfig(0),
      async () => initial.runtime,
    );
    const observedDatabases: CiteLoomDatabase[] = [];
    const observedModels: InferenceModelRegistry[] = [];
    const executeRequest = manager.withRuntime(async (runtime) => {
      observedDatabases.push(runtime.database);
      observedModels.push(runtime.models);
      await requestGate.promise;
    });
    const executeConcurrentRequest = manager.withRuntime(async (runtime) => {
      observedDatabases.push(runtime.database);
      observedModels.push(runtime.models);
      await requestGate.promise;
    });

    await vi.waitFor(() => expect(observedDatabases).toHaveLength(2));
    expect(observedDatabases[0]).toBe(observedDatabases[1]);
    expect(observedModels[0]).toBe(observedModels[1]);
    expect(initial.close).not.toHaveBeenCalled();

    requestGate.resolve();
    await Promise.all([executeRequest, executeConcurrentRequest]);
    await manager.shutdown();
  });

  it("routes new work to a replacement while an in-flight request drains", async () => {
    const runtimes = new Map<number, TestRuntime>();
    const manager = await ApplicationRuntimeManager.start(
      buildConfig(0),
      async (config) => {
        const runtime = buildTestRuntime(config.settingsVersion);
        runtimes.set(config.settingsVersion, runtime);
        return runtime.runtime;
      },
    );
    const requestGate = createDeferred<void>();
    const inFlight = manager.withRuntime(async (runtime) => {
      const version = runtime.config.settingsVersion;
      await requestGate.promise;
      return version;
    });

    await manager.reload(buildConfig(1));

    await expect(manager.withRuntime(async (runtime) => {
      return runtime.config.settingsVersion;
    })).resolves.toBe(1);
    expect(runtimes.get(0)?.close).not.toHaveBeenCalled();

    requestGate.resolve();
    await expect(inFlight).resolves.toBe(0);
    await vi.waitFor(() => {
      expect(runtimes.get(0)?.close).toHaveBeenCalledOnce();
    });
    expect(readRetiringSlotCount(manager)).toBe(0);

    await manager.shutdown();
    expect(runtimes.get(1)?.close).toHaveBeenCalledOnce();
  });

  it("preserves a retired runtime close failure without retaining its slot", async () => {
    const closeError = new Error("retired runtime could not close");
    const initial = buildTestRuntime(0);
    initial.close.mockRejectedValue(closeError);
    const replacement = buildTestRuntime(1);
    const manager = await ApplicationRuntimeManager.start(
      buildConfig(0),
      async (config) => {
        if (config.settingsVersion === 0) {
          return initial.runtime;
        }
        return replacement.runtime;
      },
    );

    await manager.reload(buildConfig(1));
    await vi.waitFor(() => {
      expect(initial.close).toHaveBeenCalledOnce();
      expect(readRetiringSlotCount(manager)).toBe(0);
    });

    let shutdownError: unknown;
    try {
      await manager.shutdown();
    } catch (error: unknown) {
      shutdownError = error;
    }
    expect(shutdownError).toBeInstanceOf(AggregateError);
    if (!(shutdownError instanceof AggregateError)) {
      throw new Error("Expected runtime shutdown to report an aggregate close error.");
    }
    expect(shutdownError.errors).toEqual([closeError]);
    expect(replacement.close).toHaveBeenCalledOnce();
  });

  it("waits for a draining retired runtime during shutdown", async () => {
    const runtimes = new Map<number, TestRuntime>();
    const manager = await ApplicationRuntimeManager.start(
      buildConfig(0),
      async (config) => {
        const runtime = buildTestRuntime(config.settingsVersion);
        runtimes.set(config.settingsVersion, runtime);
        return runtime.runtime;
      },
    );
    const requestGate = createDeferred<void>();
    const inFlight = manager.withRuntime(async () => requestGate.promise);

    await manager.reload(buildConfig(1));
    const shutdownCompleted = vi.fn();
    const shutdown = manager.shutdown();
    void shutdown.then(shutdownCompleted, shutdownCompleted);

    await vi.waitFor(() => {
      expect(runtimes.get(1)?.close).toHaveBeenCalledOnce();
    });
    expect(runtimes.get(0)?.close).not.toHaveBeenCalled();
    expect(shutdownCompleted).not.toHaveBeenCalled();

    requestGate.resolve();
    await inFlight;
    await shutdown;
    expect(runtimes.get(0)?.close).toHaveBeenCalledOnce();
    expect(shutdownCompleted).toHaveBeenCalledOnce();
    expect(readRetiringSlotCount(manager)).toBe(0);
  });

  it("discards a stale runtime when concurrent reloads finish out of order", async () => {
    const runtimes = new Map<number, TestRuntime>();
    const firstReloadGate = createDeferred<void>();
    const manager = await ApplicationRuntimeManager.start(
      buildConfig(0),
      async (config) => {
        const runtime = buildTestRuntime(config.settingsVersion);
        runtimes.set(config.settingsVersion, runtime);
        if (config.settingsVersion === 1) {
          await firstReloadGate.promise;
        }
        return runtime.runtime;
      },
    );

    const firstReload = manager.reload(buildConfig(1));
    await vi.waitFor(() => expect(runtimes.has(1)).toBe(true));
    await expect(manager.reload(buildConfig(2))).resolves.toBe(true);
    firstReloadGate.resolve();
    await expect(firstReload).resolves.toBe(false);

    await expect(manager.withRuntime(async (runtime) => {
      return runtime.config.settingsVersion;
    })).resolves.toBe(2);
    expect(runtimes.get(1)?.close).toHaveBeenCalledOnce();

    await manager.shutdown();
    expect(runtimes.get(0)?.close).toHaveBeenCalledOnce();
    expect(runtimes.get(2)?.close).toHaveBeenCalledOnce();
  });

  it("does not install an older snapshot after a newer concurrent reload fails", async () => {
    const runtimes = new Map<number, TestRuntime>();
    const firstReloadGate = createDeferred<void>();
    const newerReloadError = new Error("newer runtime failed");
    const manager = await ApplicationRuntimeManager.start(
      buildConfig(0),
      async (config) => {
        if (config.settingsVersion === 2) {
          throw newerReloadError;
        }
        const runtime = buildTestRuntime(config.settingsVersion);
        runtimes.set(config.settingsVersion, runtime);
        if (config.settingsVersion === 1) {
          await firstReloadGate.promise;
        }
        return runtime.runtime;
      },
    );

    const firstReload = manager.reload(buildConfig(1));
    await vi.waitFor(() => expect(runtimes.has(1)).toBe(true));
    await expect(manager.reload(buildConfig(2))).rejects.toBe(newerReloadError);
    firstReloadGate.resolve();
    await expect(firstReload).resolves.toBe(false);

    await expect(manager.withRuntime(async (runtime) => {
      return runtime.config.settingsVersion;
    })).resolves.toBe(0);
    expect(runtimes.get(1)?.close).toHaveBeenCalledOnce();

    await manager.shutdown();
  });

  it("releases a runtime lease when a request stream is cancelled", async () => {
    const runtimes = new Map<number, TestRuntime>();
    const cancel = vi.fn<(reason: unknown) => void>();
    const manager = await ApplicationRuntimeManager.start(
      buildConfig(0),
      async (config) => {
        const runtime = buildTestRuntime(config.settingsVersion);
        runtimes.set(config.settingsVersion, runtime);
        return runtime.runtime;
      },
    );
    const stream = manager.streamWithRuntime(() => {
      return new ReadableStream<string>({ cancel });
    });
    const reader = stream.getReader();

    await manager.reload(buildConfig(1));
    expect(runtimes.get(0)?.close).not.toHaveBeenCalled();

    await reader.cancel("request disconnected");
    expect(cancel).toHaveBeenCalledWith("request disconnected");
    await vi.waitFor(() => {
      expect(runtimes.get(0)?.close).toHaveBeenCalledOnce();
    });

    await manager.shutdown();
  });

  it("retains a runtime lease until managed work completes", async () => {
    const runtimes = new Map<number, TestRuntime>();
    const completion = createDeferred<void>();
    const manager = await ApplicationRuntimeManager.start(
      buildConfig(0),
      async (config) => {
        const runtime = buildTestRuntime(config.settingsVersion);
        runtimes.set(config.settingsVersion, runtime);
        return runtime.runtime;
      },
    );

    const settingsVersion = await manager.withManagedRuntime(async (runtime) => ({
      completion: completion.promise,
      value: runtime.config.settingsVersion,
    }));
    expect(settingsVersion).toBe(0);

    await manager.reload(buildConfig(1));
    expect(runtimes.get(0)?.close).not.toHaveBeenCalled();

    completion.resolve();
    await vi.waitFor(() => {
      expect(runtimes.get(0)?.close).toHaveBeenCalledOnce();
    });

    await manager.shutdown();
  });

  it("drains active work on shutdown and closes every runtime once", async () => {
    const initial = buildTestRuntime(0);
    const requestGate = createDeferred<void>();
    const manager = await ApplicationRuntimeManager.start(
      buildConfig(0),
      async () => initial.runtime,
    );
    const inFlight = manager.withRuntime(async () => requestGate.promise);

    const shutdown = manager.shutdown();
    await expect(manager.withRuntime(async () => undefined)).rejects.toThrow(
      "shutting down",
    );
    expect(initial.close).not.toHaveBeenCalled();

    requestGate.resolve();
    await inFlight;
    await shutdown;
    await manager.shutdown();
    expect(initial.close).toHaveBeenCalledOnce();
  });
});

interface RuntimeManagerRetirementState {
  readonly retiringSlots: ReadonlyMap<unknown, Promise<void>>;
}

interface TestRuntime {
  close: ReturnType<typeof vi.fn<() => Promise<void>>>;
  runtime: ApplicationRuntime;
}

function readRetiringSlotCount(manager: ApplicationRuntimeManager): number {
  const state = manager as unknown as RuntimeManagerRetirementState;
  return state.retiringSlots.size;
}

function buildConfig(settingsVersion: number): AppConfig {
  return readEqualWeightTestConfig({
    settingsVersion,
  });
}

function buildDatabaseSession(
  close: () => Promise<void>,
): DatabaseSession {
  return {
    close,
    database: {} as CiteLoomDatabase,
    query: buildQueryExecutor(),
  };
}

function buildModels(): InferenceModelRegistry {
  return {} as InferenceModelRegistry;
}

function buildQueryExecutor(): SqlQueryExecutor {
  return {
    execute: async () => [],
  };
}

function buildScheduler(): TaskScheduler {
  const passiveAbortSignal = new AbortController().signal;
  return {
    capacity: 1,
    run: async (task) => task(passiveAbortSignal),
  };
}

function buildTestRuntime(settingsVersion: number): TestRuntime {
  const close = vi.fn<() => Promise<void>>(async () => undefined);
  const scheduler = buildScheduler();
  const runtime: ApplicationRuntime = {
    close,
    config: buildConfig(settingsVersion),
    database: {} as CiteLoomDatabase,
    inferenceCoordinator: {
      configure: async () => undefined,
      createScheduler: () => scheduler,
    },
    models: buildModels(),
    query: buildQueryExecutor(),
    scheduler: () => scheduler,
  };
  return { close, runtime };
}
