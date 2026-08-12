import type {
  ManagedTask,
  TaskScheduler,
} from "../shared/concurrency.js";
import type {
  AppConfig,
  ScheduledProviderCapability,
  SchedulingConfig,
  WorkloadClass,
} from "../config/index.js";
import {
  openDatabase,
  type CiteLoomDatabase,
  type DatabaseSession,
  type SqlQueryExecutor,
} from "../database/client.js";
import {
  createInferenceModelRegistry,
  type InferenceModelRegistry,
} from "../inference/registry.js";
import { InferenceCoordinator } from "../inference/coordinator.js";
import { ensureEmbeddingSpace } from "../retrieval/indexing/index.js";

export interface RuntimeInferenceCoordinator {
  configure(config: SchedulingConfig): Promise<void>;
  createScheduler(
    providerId: string,
    workload: WorkloadClass,
    localCapacity: number,
  ): TaskScheduler;
}

export interface ApplicationRuntime {
  readonly config: AppConfig;
  readonly database: CiteLoomDatabase;
  readonly inferenceCoordinator: RuntimeInferenceCoordinator;
  readonly models: InferenceModelRegistry;
  readonly query: SqlQueryExecutor;
  close(): Promise<void>;
  scheduler(
    capability: ScheduledProviderCapability,
    workload: WorkloadClass,
  ): TaskScheduler;
}

export interface ApplicationRuntimeDependencies {
  createCoordinator(database: CiteLoomDatabase): RuntimeInferenceCoordinator;
  createModels(
    config: AppConfig,
    database: CiteLoomDatabase,
  ): InferenceModelRegistry;
  ensureEmbeddingSpace(
    database: CiteLoomDatabase,
    config: AppConfig["embeddingSpace"],
  ): Promise<void>;
  openDatabase(config: AppConfig["database"]): Promise<DatabaseSession>;
}

export type ApplicationRuntimeBuilder = (
  config: AppConfig,
) => Promise<ApplicationRuntime>;

export function createRuntimeTaskScheduler(
  config: Pick<AppConfig, "scheduling">,
  coordinator: RuntimeInferenceCoordinator,
  capability: ScheduledProviderCapability,
  workload: WorkloadClass,
): TaskScheduler {
  const target = config.scheduling.targets[capability];
  if (target === undefined) {
    throw new Error(`${capability} has no configured provider.`);
  }
  const provider = config.scheduling.providers.find((candidate) => {
    return candidate.providerId === target.providerId;
  });
  if (provider === undefined) {
    throw new Error(
      `${capability} refers to missing provider ${target.providerId}.`,
    );
  }
  return coordinator.createScheduler(
    provider.providerId,
    workload,
    provider.maximumParallelRequests,
  );
}

const defaultDependencies: ApplicationRuntimeDependencies = {
  createCoordinator: (database) => new InferenceCoordinator(database),
  createModels: createInferenceModelRegistry,
  ensureEmbeddingSpace,
  openDatabase,
};

export async function buildApplicationRuntime(
  config: AppConfig,
  dependencies: ApplicationRuntimeDependencies = defaultDependencies,
): Promise<ApplicationRuntime> {
  const runtimeConfig = freezeApplicationConfig(config);
  const session = await dependencies.openDatabase(runtimeConfig.database);
  try {
    await dependencies.ensureEmbeddingSpace(
      session.database,
      runtimeConfig.embeddingSpace,
    );
    const inferenceCoordinator = dependencies.createCoordinator(session.database);
    await inferenceCoordinator.configure(runtimeConfig.scheduling);
    const models = dependencies.createModels(runtimeConfig, session.database);
    const schedulers = new Map<string, TaskScheduler>();
    const scheduler = (
      capability: ScheduledProviderCapability,
      workload: WorkloadClass,
    ): TaskScheduler => {
      const key = `${capability}:${workload}`;
      const existing = schedulers.get(key);
      if (existing !== undefined) {
        return existing;
      }
      const created = createRuntimeTaskScheduler(
        runtimeConfig,
        inferenceCoordinator,
        capability,
        workload,
      );
      schedulers.set(key, created);
      return created;
    };
    let closePromise: Promise<void> | null = null;
    const runtime: ApplicationRuntime = {
      close: async (): Promise<void> => {
        closePromise ??= session.close();
        await closePromise;
      },
      config: runtimeConfig,
      database: session.database,
      inferenceCoordinator,
      models,
      query: session.query,
      scheduler,
    };
    return Object.freeze(runtime);
  } catch (error: unknown) {
    try {
      await session.close();
    } catch (closeError: unknown) {
      throw new AggregateError(
        [error, closeError],
        "Application runtime startup failed and its database pool could not close cleanly.",
      );
    }
    throw error;
  }
}

export function createApplicationRuntimeView(
  runtime: ApplicationRuntime,
  config: AppConfig,
): ApplicationRuntime {
  const runtimeConfig = freezeApplicationConfig(config);
  const models = createInferenceModelRegistry(runtimeConfig, runtime.database);
  const schedulers = new Map<string, TaskScheduler>();
  const scheduler = (
    capability: ScheduledProviderCapability,
    workload: WorkloadClass,
  ): TaskScheduler => {
    const key = `${capability}:${workload}`;
    const existing = schedulers.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const created = createRuntimeTaskScheduler(
      runtimeConfig,
      runtime.inferenceCoordinator,
      capability,
      workload,
    );
    schedulers.set(key, created);
    return created;
  };
  return Object.freeze({
    close: async () => undefined,
    config: runtimeConfig,
    database: runtime.database,
    inferenceCoordinator: runtime.inferenceCoordinator,
    models,
    query: runtime.query,
    scheduler,
  });
}

export class ApplicationRuntimeManager {
  private readonly closeErrors: unknown[] = [];
  private closing = false;
  private current: RuntimeSlot;
  private latestRequestedSettingsVersion: number;
  private readonly pendingReloads = new Set<Promise<boolean>>();
  private readonly retiringSlots = new Map<RuntimeSlot, Promise<void>>();
  private shutdownPromise: Promise<void> | null = null;

  private constructor(
    runtime: ApplicationRuntime,
    private readonly buildRuntime: ApplicationRuntimeBuilder,
  ) {
    this.current = new RuntimeSlot(runtime);
    this.latestRequestedSettingsVersion = runtime.config.settingsVersion;
  }

  public static async start(
    config: AppConfig,
    buildRuntime: ApplicationRuntimeBuilder = buildApplicationRuntime,
  ): Promise<ApplicationRuntimeManager> {
    const runtime = await buildRuntime(config);
    if (runtime.config.settingsVersion !== config.settingsVersion) {
      await runtime.close();
      throw new Error("The application runtime builder returned the wrong settings version.");
    }
    return new ApplicationRuntimeManager(runtime, buildRuntime);
  }

  public get settingsVersion(): number {
    return this.current.settingsVersion;
  }

  public async reload(config: AppConfig): Promise<boolean> {
    if (this.closing) {
      throw new Error("The application runtime is shutting down.");
    }
    this.latestRequestedSettingsVersion = Math.max(
      this.latestRequestedSettingsVersion,
      config.settingsVersion,
    );
    const reload = this.buildAndInstall(config);
    this.pendingReloads.add(reload);
    try {
      return await reload;
    } finally {
      this.pendingReloads.delete(reload);
    }
  }

  public shutdown(): Promise<void> {
    this.shutdownPromise ??= this.performShutdown();
    return this.shutdownPromise;
  }

  public streamWithRuntime<T>(
    operation: (runtime: ApplicationRuntime) => ReadableStream<T>,
  ): ReadableStream<T> {
    const lease = this.acquire();
    const bridge = new RuntimeStreamBridge(lease, operation);
    return new ReadableStream<T>({
      cancel: (reason) => bridge.cancel(reason),
      pull: (controller) => bridge.pull(controller),
      start: (controller) => bridge.start(controller),
    });
  }

  public streamWithRuntimeAsync<T>(
    operation: (
      runtime: ApplicationRuntime,
    ) => Promise<ReadableStream<T>>,
  ): ReadableStream<T> {
    const lease = this.acquire();
    const bridge = new RuntimeStreamBridge(lease, operation);
    return new ReadableStream<T>({
      cancel: (reason) => bridge.cancel(reason),
      pull: (controller) => bridge.pull(controller),
      start: (controller) => bridge.start(controller),
    });
  }

  public async withRuntime<T>(
    operation: (runtime: ApplicationRuntime) => Promise<T>,
  ): Promise<T> {
    const lease = this.acquire();
    try {
      return await operation(lease.runtime);
    } finally {
      lease.release();
    }
  }

  public async withManagedRuntime<T>(
    operation: (
      runtime: ApplicationRuntime,
    ) => Promise<ManagedTask<T>>,
  ): Promise<T> {
    const lease = this.acquire();
    try {
      const task = await operation(lease.runtime);
      void task.completion.then(
        () => lease.release(),
        () => lease.release(),
      ).catch((error: unknown) => {
        this.closeErrors.push(error);
      });
      return task.value;
    } catch (error: unknown) {
      lease.release();
      throw error;
    }
  }

  private acquire(): RuntimeLease {
    if (this.closing) {
      throw new Error("The application runtime is shutting down.");
    }
    return this.current.acquire();
  }

  private async buildAndInstall(config: AppConfig): Promise<boolean> {
    const candidate = await this.buildRuntime(config);
    if (candidate.config.settingsVersion !== config.settingsVersion) {
      await candidate.close();
      throw new Error("The application runtime builder returned the wrong settings version.");
    }
    if (this.closing) {
      await candidate.close();
      throw new Error("The application runtime is shutting down.");
    }
    if (
      candidate.config.settingsVersion < this.latestRequestedSettingsVersion
      || candidate.config.settingsVersion <= this.current.settingsVersion
    ) {
      await candidate.close();
      return false;
    }

    const previous = this.current;
    const next = new RuntimeSlot(candidate);
    this.current = next;
    void this.retireSlot(previous);
    return true;
  }

  private async performShutdown(): Promise<void> {
    this.closing = true;
    const pendingReloads = [...this.pendingReloads];
    await Promise.allSettled(pendingReloads);
    void this.retireSlot(this.current);
    const pendingClosures = [...this.retiringSlots.values()];
    await Promise.all(pendingClosures);
    if (this.closeErrors.length > 0) {
      throw new AggregateError(
        this.closeErrors,
        "One or more application runtime resources failed to close.",
      );
    }
  }

  private retireSlot(slot: RuntimeSlot): Promise<void> {
    const existingClosure = this.retiringSlots.get(slot);
    if (existingClosure !== undefined) {
      return existingClosure;
    }
    const closure = slot.waitUntilClosed().then(
      () => {
        this.retiringSlots.delete(slot);
      },
      (error: unknown) => {
        this.retiringSlots.delete(slot);
        this.closeErrors.push(error);
      },
    );
    this.retiringSlots.set(slot, closure);
    slot.retire();
    return closure;
  }
}

interface RuntimeLease {
  readonly runtime: ApplicationRuntime;
  release(): void;
}

class RuntimeStreamBridge<T> {
  private reader: ReadableStreamDefaultReader<T> | null = null;
  private released = false;

  public constructor(
    private readonly lease: RuntimeLease,
    private readonly operation: (
      runtime: ApplicationRuntime,
    ) => ReadableStream<T> | Promise<ReadableStream<T>>,
  ) {}

  public async cancel(reason: unknown): Promise<void> {
    try {
      await this.reader?.cancel(reason);
    } finally {
      this.release();
    }
  }

  public async start(
    controller: ReadableStreamDefaultController<T>,
  ): Promise<void> {
    try {
      const stream = await this.operation(this.lease.runtime);
      this.reader = stream.getReader();
    } catch (error: unknown) {
      controller.error(error);
      this.release();
    }
  }

  public async pull(
    controller: ReadableStreamDefaultController<T>,
  ): Promise<void> {
    if (this.reader === null) {
      return;
    }
    try {
      const result = await this.reader.read();
      if (result.done) {
        controller.close();
        this.release();
        return;
      }
      controller.enqueue(result.value);
    } catch (error: unknown) {
      controller.error(error);
      this.release();
    }
  }

  private release(): void {
    if (this.released) {
      return;
    }
    this.released = true;
    this.lease.release();
  }
}

class RuntimeSlot {
  private activeLeases = 0;
  private closePromise: Promise<void> | null = null;
  private readonly closed: Promise<void>;
  private rejectClosed: (reason: unknown) => void = () => undefined;
  private resolveClosed: () => void = () => undefined;
  private retired = false;

  public constructor(public readonly runtime: ApplicationRuntime) {
    this.closed = new Promise<void>((resolve, reject) => {
      this.resolveClosed = resolve;
      this.rejectClosed = reject;
    });
    void this.closed.catch(() => undefined);
  }

  public get settingsVersion(): number {
    return this.runtime.config.settingsVersion;
  }

  public acquire(): RuntimeLease {
    if (this.retired) {
      throw new Error("The application runtime snapshot has retired.");
    }
    this.activeLeases += 1;
    let released = false;
    return {
      release: (): void => {
        if (released) {
          return;
        }
        released = true;
        this.release();
      },
      runtime: this.runtime,
    };
  }

  public retire(): void {
    if (this.retired) {
      return;
    }
    this.retired = true;
    this.closeIfDrained();
  }

  public waitUntilClosed(): Promise<void> {
    return this.closed;
  }

  private closeIfDrained(): void {
    if (!this.retired || this.activeLeases > 0 || this.closePromise !== null) {
      return;
    }
    try {
      this.closePromise = this.runtime.close();
    } catch (error: unknown) {
      this.rejectClosed(error);
      return;
    }
    void this.closePromise.then(this.resolveClosed, this.rejectClosed);
  }

  private release(): void {
    if (this.activeLeases <= 0) {
      throw new Error("Application runtime lease accounting underflowed.");
    }
    this.activeLeases -= 1;
    this.closeIfDrained();
  }
}

function freezeApplicationConfig(config: AppConfig): AppConfig {
  const copy = structuredClone(config);
  Object.freeze(copy.database);
  Object.freeze(copy.docling);
  Object.freeze(copy.embeddingSpace.inputFormat);
  Object.freeze(copy.embeddingSpace);
  Object.freeze(copy.inference.embedding.inputFormat);
  Object.freeze(copy.inference);
  Object.freeze(copy.inferenceMetrics);
  Object.freeze(copy.retry);
  if (copy.retrieval.reranker !== null) {
    Object.freeze(copy.retrieval.reranker);
  }
  Object.freeze(copy.retrieval);
  for (const provider of copy.scheduling.providers) {
    Object.freeze(provider);
  }
  Object.freeze(copy.scheduling.providers);
  for (const target of Object.values(copy.scheduling.targets)) {
    Object.freeze(target);
  }
  Object.freeze(copy.scheduling.targets);
  Object.freeze(copy.scheduling);
  Object.freeze(copy.sourceDiscovery);
  Object.freeze(copy.sourceContent);
  if (copy.speechToText !== null) {
    Object.freeze(copy.speechToText);
  }
  if (copy.textToSpeech !== null) {
    Object.freeze(copy.textToSpeech);
  }
  Object.freeze(copy.worker);
  Object.freeze(copy);
  return copy;
}
