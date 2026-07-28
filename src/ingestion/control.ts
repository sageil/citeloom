import type { AppConfig } from "../config/index.js";
import type { CiteLoomDatabase } from "../database/client.js";
import {
  DocumentCatalog,
  type IngestionControlDoclingTask,
} from "../documents/catalog/index.js";
import {
  pauseDoclingTask,
  terminateDoclingTask,
  type DoclingTaskPauseResult,
  type DoclingTaskTerminationRequest,
} from "../docling/index.js";

export interface IngestionControlReconciliationResult {
  failed: number;
  terminated: number;
}

export interface IngestionControlExecutionDependencies {
  pauseTask(
    request: DoclingTaskTerminationRequest,
  ): Promise<DoclingTaskPauseResult>;
  terminateTask(
    request: DoclingTaskTerminationRequest,
  ): Promise<void>;
}

const defaultDependencies: IngestionControlExecutionDependencies = {
  pauseTask: pauseDoclingTask,
  terminateTask: terminateDoclingTask,
};

export async function reconcileIngestionControlExecutions(
  database: CiteLoomDatabase,
  config: AppConfig,
  sourceFile?: string,
  dependencyOverrides: Partial<IngestionControlExecutionDependencies> = {},
): Promise<IngestionControlReconciliationResult> {
  const dependencies = {
    ...defaultDependencies,
    ...dependencyOverrides,
  };
  const catalog = new DocumentCatalog(database);
  const tasks = await catalog.readRequestedControlDoclingTasks(sourceFile);
  let failed = 0;
  let terminated = 0;
  for (const task of tasks) {
    try {
      const outcome = await executeIngestionControlTask(
        config,
        task,
        dependencies,
      );
      const acknowledged = await catalog.acknowledgeDoclingTaskControl(
        task.sourceFile,
        task.serviceInstanceId,
        task.taskId,
        outcome,
      );
      if (!acknowledged) {
        continue;
      }
      terminated += 1;
    } catch (error: unknown) {
      failed += 1;
      const message = readControlError(error);
      await catalog.recordIngestionControlError(task.sourceFile, message);
    }
  }
  return { failed, terminated };
}

async function executeIngestionControlTask(
  config: AppConfig,
  task: IngestionControlDoclingTask,
  dependencies: IngestionControlExecutionDependencies,
): Promise<"paused" | "terminated"> {
  const service = config.doclingServices.find((candidate) => {
    return candidate.id === task.serviceInstanceId;
  });
  if (service === undefined) {
    throw new Error(
      `Docling service ${task.serviceInstanceId} is unavailable for task ${task.taskId}.`,
    );
  }
  const request = {
    apiKey: config.docling.apiKey,
    baseUrl: service.baseUrl,
    requestTimeoutMs: config.docling.requestTimeoutMs,
    taskId: task.taskId,
  };
  if (task.controlState === "pause_requested") {
    const result = await dependencies.pauseTask(request);
    return result.kind;
  }
  await dependencies.terminateTask(request);
  return "terminated";
}

function readControlError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 2_000);
}
