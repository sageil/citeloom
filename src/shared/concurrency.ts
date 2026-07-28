import type { WorkloadClass } from "../config/index.js";

export interface TaskScheduler {
  readonly capacity: number;
  run: <T>(
    task: (abortSignal: AbortSignal) => Promise<T>,
    abortSignal?: AbortSignal,
    timingObserver?: TaskTimingObserver,
  ) => Promise<T>;
}

export interface TaskTimingObserver {
  completed: () => void;
  started: (scheduling?: TaskSchedulingMetadata) => void;
}

export interface TaskSchedulingMetadata {
  resourceGroup: string;
  workload: WorkloadClass;
}

export interface ManagedTask<Value> {
  completion: Promise<void>;
  value: Value;
}

interface TaskWaiter {
  abortSignal: AbortSignal | null;
  onAbort: (() => void) | null;
  reject: (reason: unknown) => void;
  resolve: () => void;
}

const passiveAbortSignal = new AbortController().signal;

export class TaskLimiter implements TaskScheduler {
  private activeTasks = 0;
  private readonly waiters: TaskWaiter[] = [];

  public constructor(public readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error("Task limiter capacity must be a positive integer.");
    }
  }

  public async run<T>(
    task: (abortSignal: AbortSignal) => Promise<T>,
    abortSignal?: AbortSignal,
    timingObserver?: TaskTimingObserver,
  ): Promise<T> {
    await this.acquire(abortSignal);
    try {
      abortSignal?.throwIfAborted();
      timingObserver?.started();
      try {
        return await task(abortSignal ?? passiveAbortSignal);
      } finally {
        timingObserver?.completed();
      }
    } finally {
      this.release();
    }
  }

  private async acquire(abortSignal?: AbortSignal): Promise<void> {
    abortSignal?.throwIfAborted();
    if (this.activeTasks < this.capacity) {
      this.activeTasks += 1;
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const waiter: TaskWaiter = {
        abortSignal: abortSignal ?? null,
        onAbort: null,
        reject,
        resolve,
      };
      this.waiters.push(waiter);
      if (abortSignal !== undefined) {
        const onAbort = (): void => {
          abortSignal.removeEventListener("abort", onAbort);
          const index = this.waiters.indexOf(waiter);
          if (index !== -1) {
            this.waiters.splice(index, 1);
          }
          reject(abortSignal.reason);
        };
        waiter.onAbort = onAbort;
        abortSignal.addEventListener("abort", onAbort, { once: true });
        if (abortSignal.aborted) {
          onAbort();
        }
      }
    });
  }

  private release(): void {
    const nextWaiter = this.waiters.shift();
    if (nextWaiter !== undefined) {
      if (nextWaiter.abortSignal !== null && nextWaiter.onAbort !== null) {
        nextWaiter.abortSignal.removeEventListener("abort", nextWaiter.onAbort);
      }
      nextWaiter.resolve();
      return;
    }
    this.activeTasks -= 1;
  }
}

export async function startManagedTask<Value>(
  scheduler: TaskScheduler,
  start: (abortSignal: AbortSignal) => Promise<ManagedTask<Value>>,
  abortSignal?: AbortSignal,
  timingObserver?: TaskTimingObserver,
): Promise<ManagedTask<Value>> {
  let rejectStart = (_reason: unknown): void => undefined;
  let resolveStart = (_task: ManagedTask<Value>): void => undefined;
  const started = new Promise<ManagedTask<Value>>((resolve, reject) => {
    rejectStart = reject;
    resolveStart = resolve;
  });
  const completion = scheduler.run(
    async (taskSignal) => {
      const task = await start(taskSignal);
      resolveStart(task);
      await task.completion;
    },
    abortSignal,
    timingObserver,
  );
  void completion.catch(rejectStart);
  const task = await started;
  return {
    completion,
    value: task.value,
  };
}

export async function mapWithConcurrency<Input, Output>(
  inputs: readonly Input[],
  concurrency: number,
  operation: (input: Input, index: number) => Promise<Output>,
): Promise<Output[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error("Map concurrency must be a positive integer.");
  }
  if (inputs.length === 0) {
    return [];
  }

  const results = new Array<Output>(inputs.length);
  const workerCount = Math.min(concurrency, inputs.length);
  let nextIndex = 0;

  const runWorker = async (): Promise<void> => {
    while (nextIndex < inputs.length) {
      const index = nextIndex;
      nextIndex += 1;
      const input = inputs[index];
      if (input === undefined) {
        throw new Error(`Missing concurrent input at index ${index}.`);
      }
      results[index] = await operation(input, index);
    }
  };

  const workers: Promise<void>[] = [];
  for (let index = 0; index < workerCount; index += 1) {
    workers.push(runWorker());
  }
  await Promise.all(workers);
  return results;
}
