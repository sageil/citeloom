import { hostname } from "node:os";
import { randomUUID } from "node:crypto";

import { and, asc, eq, gt, isNotNull, ne } from "drizzle-orm";
import { z } from "zod";

import {
  PostgresApplicationStateRevisionSource,
  type ApplicationStateRevisionChannel,
  type ApplicationStateRevisionSource,
} from "../app/application-state-revisions.js";
import type { ApplicationRuntime } from "../app/runtime.js";
import { ApplicationSettingsRepository } from "../app/settings.js";
import {
  readApplicationErrorRetentionConfig,
  readDoclingServiceTopologyFromConfig,
  type AppConfig,
  type ProviderConcurrencyConfig,
} from "../config/index.js";
import { openDatabase, type CiteLoomDatabase } from "../database/client.js";
import {
  inferenceLimits,
  inferenceSlots,
  ingestionJobs,
  workerHeartbeats,
} from "../database/schema.js";
import type { IngestionJob } from "../documents/catalog/index.js";
import {
  IngestionProcessor,
  type ProcessJobResult,
} from "./processor.js";
import { ApplicationErrorReporter } from "../observability/application-errors.js";
import {
  enforceApplicationErrorRetention,
  startApplicationErrorRetentionController,
} from "../observability/application-error-retention.js";

export interface WorkerOptions {
  once: boolean;
  signal?: AbortSignal;
}

export interface QueueStatus {
  attemptCount: number;
  errorMessage: string | null;
  maxAttempts: number;
  nextAttemptAt: string;
  phase: "discovered" | "normalized" | "indexed";
  sourceFile: string;
  state: "failed" | "pending" | "running";
}

export interface WorkerStatus {
  heartbeatAt: string;
  hostname: string;
  id: string;
  processId: number;
  startedAt: string;
  state: "idle" | "starting" | "stopped" | "working";
}

export interface InferenceStatus {
  activeSlots: number;
  capacity: number;
  name: string;
  providerId: string;
}

export interface SystemStatus {
  inference: InferenceStatus[];
  queue: QueueStatus[];
  workers: WorkerStatus[];
}

const queueRowSchema = z.object({
  attemptCount: z.number().int().nonnegative(),
  errorMessage: z.string().nullable(),
  maxAttempts: z.number().int().positive(),
  nextAttemptAt: z.date(),
  phase: z.enum(["discovered", "normalized", "indexed"]),
  sourceFile: z.string().min(1),
  state: z.enum(["pending", "running", "failed"]),
});
const workerRowSchema = z.object({
  heartbeatAt: z.date(),
  hostname: z.string().min(1),
  id: z.uuid(),
  processId: z.number().int().positive(),
  startedAt: z.date(),
  state: z.enum(["starting", "idle", "working", "stopped"]),
});
const inferenceLimitRowSchema = z.object({
  capacity: z.number().int().min(1).max(16),
  resourceGroup: z.string().min(1).max(100),
});
const inferenceSlotRowSchema = z.object({
  leaseExpiresAt: z.date(),
  resourceGroup: z.string().min(1).max(100),
});
const WORKER_HEARTBEAT_INTERVAL_MS = 5_000;
const ACTIVE_WORKER_WINDOW_MS = 20_000;

export async function runIngestionWorker(
  config: AppConfig,
  options: WorkerOptions,
): Promise<void> {
  const retentionConfig = readApplicationErrorRetentionConfig(process.env);
  const databaseSession = await openDatabase(config.database);
  let revisions: ApplicationStateRevisionSource | null = null;
  try {
    const errors = new ApplicationErrorReporter(databaseSession.database);
    revisions = await PostgresApplicationStateRevisionSource.open(
      config.database,
      (message) => {
        const error = new Error(message);
        void errors.report(error, {
          category: "database-operation",
          code: "revision_listener_failed",
          instance: hostname(),
          operation: "listen-application-state-revisions",
          origin: "background-task",
          retryable: true,
          service: "worker",
          severity: "warning",
        });
      },
    );
    const registry = new WorkerRegistry(databaseSession.database, errors);
    const processor = new ReloadingIngestionProcessor(
      config,
      databaseSession.database,
      revisions,
      errors,
      reportWorkerEvent,
    );
    await processor.initialize();
    await registry.start();
    const errorRetention = startApplicationErrorRetentionController({
      cleanup: async () => enforceApplicationErrorRetention(
        databaseSession.database,
        retentionConfig,
      ),
      reportError: async (error) => {
        await errors.report(error, {
          category: "error-retention",
          code: "application_error_retention_failed",
          instance: hostname(),
          operation: "enforce-application-error-retention",
          origin: "background-task",
          retryable: true,
          service: "worker",
          severity: "warning",
        });
      },
      reportProgress: reportWorkerEvent,
    });
    try {
      await runWorkerDispatcher(
        processor,
        registry,
        options.once,
        options.signal,
        {
          reportError: async (error) => {
            await errors.report(error, {
              category: "worker-iteration",
              code: "worker_iteration_failed",
              instance: hostname(),
              operation: "dispatch-ingestion-work",
              origin: "worker",
              retryable: true,
              service: "worker",
              severity: "error",
            });
          },
        },
      );
    } finally {
      await errorRetention.close();
      await registry.stop();
    }
  } finally {
    await revisions?.close();
    await databaseSession.close();
  }
}

export async function readSystemStatus(config: AppConfig): Promise<SystemStatus> {
  const databaseSession = await openDatabase(config.database);
  try {
    return await readSystemStatusFromDatabase(
      databaseSession.database,
      config.scheduling.providers,
    );
  } finally {
    await databaseSession.close();
  }
}

export async function readSystemStatusWithRuntime(
  runtime: ApplicationRuntime,
): Promise<SystemStatus> {
  return readSystemStatusFromDatabase(
    runtime.database,
    runtime.config.scheduling.providers,
  );
}

async function readSystemStatusFromDatabase(
  database: CiteLoomDatabase,
  providers: readonly ProviderConcurrencyConfig[],
): Promise<SystemStatus> {
  const currentTime = new Date();
  const activeWorkerThreshold = new Date(
    currentTime.getTime() - ACTIVE_WORKER_WINDOW_MS,
  );
  const [queueRows, workerRows, limitRows, slotRows] = await Promise.all([
    database
      .select({
        attemptCount: ingestionJobs.attemptCount,
        errorMessage: ingestionJobs.errorMessage,
        maxAttempts: ingestionJobs.maxAttempts,
        nextAttemptAt: ingestionJobs.nextAttemptAt,
        phase: ingestionJobs.phase,
        sourceFile: ingestionJobs.sourceFile,
        state: ingestionJobs.state,
      })
      .from(ingestionJobs)
      .where(eq(ingestionJobs.controlState, "active"))
      .orderBy(asc(ingestionJobs.nextAttemptAt), asc(ingestionJobs.sourceFile)),
    database
      .select()
      .from(workerHeartbeats)
      .where(
        and(
          gt(workerHeartbeats.heartbeatAt, activeWorkerThreshold),
          ne(workerHeartbeats.state, "stopped"),
        )
      )
      .orderBy(asc(workerHeartbeats.startedAt)),
    database.select().from(inferenceLimits),
    database
      .select({
        leaseExpiresAt: inferenceSlots.leaseExpiresAt,
        resourceGroup: inferenceSlots.resourceGroup,
      })
      .from(inferenceSlots)
      .where(
        and(
          isNotNull(inferenceSlots.ownerId),
          gt(inferenceSlots.leaseExpiresAt, currentTime),
        ),
      ),
  ]);

  const queue = queueRows.map(decodeQueueStatus);
  const workers = workerRows.map(decodeWorkerStatus);
  const activeByResource = new Map<string, number>();
  for (const row of slotRows) {
    const result = inferenceSlotRowSchema.safeParse(row);
    if (!result.success) {
      throw new Error(`Invalid inference slot row: ${result.error.message}`);
    }
    const active = activeByResource.get(result.data.resourceGroup) ?? 0;
    activeByResource.set(result.data.resourceGroup, active + 1);
  }
  const inference: InferenceStatus[] = [];
  const providerNames = new Map<string, string>();
  for (const provider of providers) {
    providerNames.set(provider.providerId, provider.name);
  }
  for (const row of limitRows) {
    const result = inferenceLimitRowSchema.safeParse(row);
    if (!result.success) {
      throw new Error(`Invalid inference limit row: ${result.error.message}`);
    }
    const name = providerNames.get(result.data.resourceGroup);
    if (name === undefined) {
      continue;
    }
    inference.push({
      activeSlots: activeByResource.get(result.data.resourceGroup) ?? 0,
      capacity: result.data.capacity,
      name,
      providerId: result.data.resourceGroup,
    });
  }
  inference.sort((left, right) => {
    return left.name.localeCompare(right.name);
  });
  return { inference, queue, workers };
}

class WorkerRegistry {
  private activeJobs = 0;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private readonly id = randomUUID();
  private registered = false;
  private readonly startedAt = new Date();

  public constructor(
    private readonly database: CiteLoomDatabase,
    private readonly errors: ApplicationErrorReporter | null = null,
  ) {}

  public async start(): Promise<void> {
    await this.database.insert(workerHeartbeats).values({
      heartbeatAt: new Date(),
      hostname: hostname(),
      id: this.id,
      processId: process.pid,
      startedAt: this.startedAt,
      state: "starting",
    });
    this.registered = true;
    await this.writeHeartbeat("idle");
    this.heartbeat = setInterval(() => {
      const state = this.activeJobs > 0 ? "working" : "idle";
      void this.writeHeartbeat(state).catch(async (error: unknown) => {
        reportWorkerEvent(`Worker heartbeat failed: ${readErrorMessage(error)}`);
        await this.errors?.report(error, {
          category: "database-operation",
          code: "worker_heartbeat_failed",
          instance: hostname(),
          operation: "write-worker-heartbeat",
          origin: "worker",
          retryable: true,
          service: "worker",
          severity: "error",
        });
      });
    }, WORKER_HEARTBEAT_INTERVAL_MS);
    this.heartbeat.unref();
  }

  public async jobStarted(): Promise<void> {
    this.activeJobs += 1;
    await this.writeHeartbeat("working");
  }

  public async jobFinished(): Promise<void> {
    this.activeJobs = Math.max(0, this.activeJobs - 1);
    const state = this.activeJobs > 0 ? "working" : "idle";
    await this.writeHeartbeat(state);
  }

  public async stop(): Promise<void> {
    if (this.heartbeat !== null) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
    if (!this.registered) {
      return;
    }
    await this.writeHeartbeat("stopped");
    this.registered = false;
  }

  private async writeHeartbeat(
    state: "idle" | "starting" | "stopped" | "working",
  ): Promise<void> {
    await this.database
      .update(workerHeartbeats)
      .set({ heartbeatAt: new Date(), state })
      .where(eq(workerHeartbeats.id, this.id));
  }
}

export interface WorkerClaimedWork {
  doclingProbeFailed: boolean;
  doclingServicesWaiting: boolean;
  job: IngestionJob;
  processor: WorkerClaimedWorkProcessor;
  requiresDocling: boolean;
}

export type WorkerClaimResult =
  | { kind: "claimed"; work: WorkerClaimedWork }
  | {
    doclingProbeFailed: boolean;
    doclingServicesWaiting: true;
    kind: "docling-unavailable";
  }
  | { kind: "idle" };

export interface WorkerWakeup {
  channels: ApplicationStateRevisionChannel[];
}

export interface WorkerClaimedWorkProcessor {
  processClaimedJob(
    job: IngestionJob,
    abortSignal?: AbortSignal,
  ): Promise<ProcessJobResult>;
}

export interface WorkerDispatcherSource {
  readonly concurrency: number;
  readonly fallbackPollIntervalMs: number;
  claimNextJob(allowDoclingVerification: boolean): Promise<WorkerClaimResult>;
  refreshIfChanged(): Promise<boolean>;
  waitForWakeup(
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<WorkerWakeup>;
}

export interface WorkerActivityRegistry {
  jobFinished(): Promise<void>;
  jobStarted(): Promise<void>;
}

export interface WorkerDispatcherDependencies {
  now?: () => number;
  random?: () => number;
  reportError?: (error: unknown) => Promise<void>;
}

class ReloadingIngestionProcessor {
  private config: AppConfig;
  private processor: IngestionProcessor;
  private readonly repository: ApplicationSettingsRepository;
  private readonly pendingRevisionChannels =
    new Set<ApplicationStateRevisionChannel>();
  private version = -1;

  public constructor(
    private readonly baseConfig: AppConfig,
    private readonly database: CiteLoomDatabase,
    private readonly revisions: ApplicationStateRevisionSource,
    private readonly errors: ApplicationErrorReporter,
    private readonly reportProgress: (message: string) => void,
  ) {
    this.config = baseConfig;
    this.processor = new IngestionProcessor(baseConfig, database, reportProgress);
    this.repository = new ApplicationSettingsRepository(database);
    this.revisions.subscribe((revision) => {
      this.pendingRevisionChannels.add(revision.channel);
    });
  }

  public get concurrency(): number {
    return this.config.worker.concurrency;
  }

  public get fallbackPollIntervalMs(): number {
    return this.config.worker.fallbackPollIntervalMs;
  }

  public async initialize(): Promise<void> {
    const settings = await this.repository.read(
      this.baseConfig.database,
      readDoclingServiceTopologyFromConfig(this.baseConfig),
    );
    await this.install(settings.config, settings.version);
  }

  public async claimNextJob(
    allowDoclingVerification: boolean,
  ): Promise<WorkerClaimResult> {
    const claim = await this.processor.claimNextJob(
      allowDoclingVerification,
    );
    if (claim.kind !== "claimed") {
      return claim;
    }
    return {
      kind: "claimed",
      work: {
        doclingProbeFailed: claim.doclingProbeFailed,
        doclingServicesWaiting: claim.doclingServicesWaiting,
        job: claim.job,
        processor: this.processor,
        requiresDocling: claim.requiresDocling,
      },
    };
  }

  public async refreshIfChanged(): Promise<boolean> {
    try {
      const settings = await this.repository.read(
        this.baseConfig.database,
        readDoclingServiceTopologyFromConfig(this.baseConfig),
      );
      if (settings.version === this.version) {
        return false;
      }
      await this.install(settings.config, settings.version);
      this.reportProgress(`Worker adopted settings revision ${settings.version}.`);
      return true;
    } catch (error: unknown) {
      await this.errors.report(error, {
        category: "settings-reload",
        code: "worker_settings_reload_failed",
        instance: hostname(),
        operation: "reload-worker-settings",
        origin: "settings-reload",
        retryable: true,
        service: "worker",
        severity: "error",
      });
      throw error;
    }
  }

  public async waitForWakeup(
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<WorkerWakeup> {
    const pending = this.consumePendingRevisionChannels();
    if (pending.length > 0) {
      return { channels: pending };
    }
    await this.revisions.waitForSignal(timeoutMs, signal);
    if (signal?.aborted === true) {
      return { channels: [] };
    }
    return { channels: this.consumePendingRevisionChannels() };
  }

  private async install(config: AppConfig, version: number): Promise<void> {
    const processor = new IngestionProcessor(
      config,
      this.database,
      this.reportProgress,
    );
    await processor.initialize();
    try {
      const deleted = await processor.cleanExpiredDoclingMetrics();
      if (deleted > 0) {
        this.reportProgress(
          `Deleted ${deleted} expired Docling conversion metric run(s).`,
        );
      }
    } catch (error: unknown) {
      this.reportProgress(
        `Docling metrics retention warning: ${readErrorMessage(error)}`,
      );
      await this.errors.report(error, {
        category: "metrics-retention",
        code: "docling_metrics_retention_failed",
        instance: hostname(),
        operation: "clean-expired-docling-metrics",
        origin: "background-task",
        retryable: true,
        service: "worker",
        severity: "warning",
      });
    }
    this.config = config;
    this.processor = processor;
    this.version = version;
  }

  private consumePendingRevisionChannels(): ApplicationStateRevisionChannel[] {
    const channels = [...this.pendingRevisionChannels];
    this.pendingRevisionChannels.clear();
    channels.sort((left, right) => left.localeCompare(right));
    return channels;
  }
}

export async function runWorkerDispatcher(
  processor: WorkerDispatcherSource,
  registry: WorkerActivityRegistry,
  once: boolean,
  signal: AbortSignal | undefined,
  dependencies: WorkerDispatcherDependencies = {},
): Promise<void> {
  const backoff = new DoclingReadinessBackoff(
    dependencies.now ?? Date.now,
    dependencies.random ?? Math.random,
  );
  const active = new Set<Promise<void>>();
  while (!isAborted(signal)) {
    if (await processor.refreshIfChanged()) {
      backoff.reset();
    }
    let doclingWaiting = false;
    while (
      active.size < processor.concurrency &&
      !isAborted(signal)
    ) {
      const claim = await processor.claimNextJob(backoff.canVerify());
      if (claim.kind === "idle") {
        backoff.reset();
        break;
      }
      if (claim.kind === "docling-unavailable") {
        if (claim.doclingProbeFailed) {
          backoff.recordFailure();
        }
        doclingWaiting = true;
        break;
      }
      if (claim.work.doclingProbeFailed) {
        backoff.recordFailure();
      }
      if (claim.work.doclingServicesWaiting) {
        doclingWaiting = true;
      }
      const task = processClaimedWork(
        claim.work,
        registry,
        signal,
      ).catch(async (error: unknown) => {
        reportWorkerEvent(`Worker iteration failed: ${readErrorMessage(error)}`);
        await dependencies.reportError?.(error);
      });
      active.add(task);
      void task.finally(() => active.delete(task));
      if (isAborted(signal)) {
        break;
      }
    }
    const waitTimeoutMs = doclingWaiting
      ? Math.min(
        processor.fallbackPollIntervalMs,
        backoff.readRemainingDelayMs(),
      )
      : processor.fallbackPollIntervalMs;
    if (active.size > 0) {
      const waitResult = await waitForActiveWorkOrWakeup(
        active,
        processor,
        waitTimeoutMs,
        signal,
      );
      if (waitResult.kind === "wakeup") {
        interruptBackoffForRevision(backoff, waitResult.wakeup);
      }
      continue;
    }
    if (isAborted(signal)) {
      break;
    }
    if (await processor.refreshIfChanged()) {
      backoff.reset();
      continue;
    }
    if (once) {
      return;
    }
    const wakeup = await processor.waitForWakeup(waitTimeoutMs, signal);
    interruptBackoffForRevision(backoff, wakeup);
  }
  await Promise.all(active);
}

type ActiveWorkWaitResult =
  | { kind: "activity" }
  | { kind: "wakeup"; wakeup: WorkerWakeup };

async function waitForActiveWorkOrWakeup(
  active: ReadonlySet<Promise<void>>,
  processor: WorkerDispatcherSource,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<ActiveWorkWaitResult> {
  if (isAborted(signal)) {
    return { kind: "activity" };
  }
  const wakeupController = new AbortController();
  const abortWakeup = (): void => {
    wakeupController.abort(signal?.reason);
  };
  signal?.addEventListener("abort", abortWakeup, { once: true });
  try {
    return await Promise.race([
      Promise.race(active).then((): ActiveWorkWaitResult => {
        return { kind: "activity" };
      }),
      processor
        .waitForWakeup(timeoutMs, wakeupController.signal)
        .then((wakeup): ActiveWorkWaitResult => {
          return { kind: "wakeup", wakeup };
        }),
    ]);
  } finally {
    wakeupController.abort();
    signal?.removeEventListener("abort", abortWakeup);
  }
}

const DOCLING_READINESS_BACKOFF_BASE_MS = 1_000;
const DOCLING_READINESS_BACKOFF_MAX_MS = 30_000;

class DoclingReadinessBackoff {
  private failureCount = 0;
  private retryAtMs = 0;

  public constructor(
    private readonly now: () => number,
    private readonly random: () => number,
  ) {}

  public canVerify(): boolean {
    return this.now() >= this.retryAtMs;
  }

  public interrupt(): void {
    this.retryAtMs = 0;
  }

  public readRemainingDelayMs(): number {
    return Math.max(1, this.retryAtMs - this.now());
  }

  public recordFailure(): void {
    const exponent = Math.min(this.failureCount, 30);
    const exponentialDelay = DOCLING_READINESS_BACKOFF_BASE_MS
      * (2 ** exponent);
    const maximumDelay = Math.min(
      exponentialDelay,
      DOCLING_READINESS_BACKOFF_MAX_MS,
    );
    const minimumDelay = Math.ceil(maximumDelay / 2);
    const randomRange = maximumDelay - minimumDelay;
    const jitter = Math.floor(this.random() * (randomRange + 1));
    this.retryAtMs = this.now() + minimumDelay + jitter;
    this.failureCount += 1;
  }

  public reset(): void {
    this.failureCount = 0;
    this.retryAtMs = 0;
  }
}

function interruptBackoffForRevision(
  backoff: DoclingReadinessBackoff,
  wakeup: WorkerWakeup,
): void {
  if (
    wakeup.channels.includes("jobs")
    || wakeup.channels.includes("settings")
  ) {
    backoff.interrupt();
  }
}

async function processClaimedWork(
  work: WorkerClaimedWork,
  registry: WorkerActivityRegistry,
  signal: AbortSignal | undefined,
): Promise<void> {
  await registry.jobStarted();
  reportWorkerEvent(`Processing ${work.job.sourceFile} in phase ${work.job.phase}`);
  try {
    const result = await work.processor.processClaimedJob(work.job, signal);
    if (result.kind === "indexed") {
      reportWorkerEvent(`Indexed ${result.promotion.indexed.sourceFile}`);
    }
  } finally {
    await registry.jobFinished();
  }
}

function decodeQueueStatus(row: unknown): QueueStatus {
  const result = queueRowSchema.safeParse(row);
  if (!result.success) {
    throw new Error(`Invalid ingestion queue row: ${result.error.message}`);
  }
  return {
    attemptCount: result.data.attemptCount,
    errorMessage: result.data.errorMessage,
    maxAttempts: result.data.maxAttempts,
    nextAttemptAt: result.data.nextAttemptAt.toISOString(),
    phase: result.data.phase,
    sourceFile: result.data.sourceFile,
    state: result.data.state,
  };
}

function decodeWorkerStatus(row: unknown): WorkerStatus {
  const result = workerRowSchema.safeParse(row);
  if (!result.success) {
    throw new Error(`Invalid worker heartbeat row: ${result.error.message}`);
  }
  return {
    heartbeatAt: result.data.heartbeatAt.toISOString(),
    hostname: result.data.hostname,
    id: result.data.id,
    processId: result.data.processId,
    startedAt: result.data.startedAt.toISOString(),
    state: result.data.state,
  };
}

function reportWorkerEvent(message: string): void {
  console.log(JSON.stringify({
    level: "info",
    message,
    timestamp: new Date().toISOString(),
  }));
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}
