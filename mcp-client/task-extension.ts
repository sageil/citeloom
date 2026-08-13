import { setTimeout as delay } from "node:timers/promises";

import type {
  McpDetailedTask,
} from "../src/mcp/tasks/model.js";
import type { McpTaskExtensionClient } from "./task-client.js";

export async function waitForAnswerTask(
  client: McpTaskExtensionClient,
  taskId: string,
  options: {
    onStatus(task: McpDetailedTask): void;
    pollIntervalMs: number;
    signal: AbortSignal;
    timeoutMs: number;
  },
): Promise<McpDetailedTask & { status: "completed" }> {
  const deadline = Date.now() + options.timeoutMs;
  while (true) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new Error(`MCP task ${taskId} did not complete before the timeout.`);
    }
    const requestSignal = AbortSignal.any([
      options.signal,
      AbortSignal.timeout(remainingMs),
    ]);
    const task = await client.readTask(taskId, requestSignal);
    options.onStatus(task);
    if (task.status === "completed") {
      return task;
    }
    if (task.status === "failed") {
      throw new Error(
        `MCP task ${taskId} failed: ${task.error.message}`,
      );
    }
    if (task.status === "cancelled") {
      throw new Error(`MCP task ${taskId} was cancelled.`);
    }
    await delay(
      Math.min(options.pollIntervalMs, Math.max(1, deadline - Date.now())),
      undefined,
      { signal: options.signal },
    );
  }
}
