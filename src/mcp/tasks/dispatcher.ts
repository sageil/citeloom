import { randomUUID } from "node:crypto";

import type { WebServices } from "../../api/services.js";
import {
  MCP_ANSWER_SCOPE,
  MCP_API_KEY_TASK_ISSUER,
} from "../contract.js";
import { executeMcpAnswerTask } from "./answer.js";
import type {
  McpTaskOwner,
  McpTaskServices,
} from "./model.js";

const DEFAULT_LEASE_DURATION_MS = 30_000;
const DEFAULT_RECONCILIATION_INTERVAL_MS = 10_000;

export interface McpTaskDispatcherOptions {
  leaseDurationMs?: number;
  onError(error: unknown): void;
  publicOrigin: string;
  reconciliationIntervalMs?: number;
  services: WebServices;
  tasks: McpTaskServices;
}

interface ActiveMcpTask {
  abortController: AbortController;
  cancelRequested: boolean;
  completion: Promise<void>;
}

export class McpTaskDispatcher {
  private readonly activeTasks = new Map<string, ActiveMcpTask>();
  private closed = false;
  private reconciliation: Promise<void> | null = null;
  private reconciliationTimer: NodeJS.Timeout | null = null;

  public constructor(private readonly options: McpTaskDispatcherOptions) {}

  public async start(): Promise<void> {
    if (this.closed || this.reconciliationTimer !== null) {
      return;
    }
    await this.reconcile();
    this.reconciliationTimer = setInterval(() => {
      void this.reconcile();
    }, this.reconciliationIntervalMs);
    this.reconciliationTimer.unref();
  }

  public enqueue(taskId: string): void {
    if (this.closed || this.activeTasks.has(taskId)) {
      return;
    }
    const abortController = new AbortController();
    const active: ActiveMcpTask = {
      abortController,
      cancelRequested: false,
      completion: Promise.resolve(),
    };
    active.completion = this.run(taskId, active)
      .catch(this.options.onError)
      .finally(() => {
        this.activeTasks.delete(taskId);
      });
    this.activeTasks.set(taskId, active);
  }

  public async requestCancellation(
    owner: McpTaskOwner,
    taskId: string,
  ): Promise<boolean> {
    const found = await this.options.tasks.requestCancellation(owner, taskId);
    if (!found) {
      return false;
    }
    const active = this.activeTasks.get(taskId);
    if (active !== undefined) {
      active.cancelRequested = true;
      active.abortController.abort(new Error("The MCP task was cancelled."));
    }
    return true;
  }

  public async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (this.reconciliationTimer !== null) {
      clearInterval(this.reconciliationTimer);
      this.reconciliationTimer = null;
    }
    const completions: Promise<void>[] = [];
    for (const active of this.activeTasks.values()) {
      active.abortController.abort(new Error("The MCP task worker stopped."));
      completions.push(active.completion);
    }
    await Promise.all(completions);
    if (this.reconciliation !== null) {
      await this.reconciliation;
    }
  }

  private get leaseDurationMs(): number {
    return this.options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
  }

  private get reconciliationIntervalMs(): number {
    return this.options.reconciliationIntervalMs
      ?? DEFAULT_RECONCILIATION_INTERVAL_MS;
  }

  private async reconcile(): Promise<void> {
    if (this.closed || this.reconciliation !== null) {
      return;
    }
    const operation = async (): Promise<void> => {
      await this.options.tasks.deleteExpiredTerminalBatch(new Date());
      await this.options.tasks.failExpiredLeases(new Date());
      const taskIds = await this.options.tasks.listUnclaimedTaskIds();
      for (const taskId of taskIds) {
        this.enqueue(taskId);
      }
    };
    this.reconciliation = operation()
      .catch(this.options.onError)
      .finally(() => {
        this.reconciliation = null;
      });
    await this.reconciliation;
  }

  private async run(taskId: string, active: ActiveMcpTask): Promise<void> {
    const leaseOwner = randomUUID();
    const task = await this.options.tasks.claim(
      taskId,
      leaseOwner,
      this.buildLeaseExpiry(),
    );
    if (task === null) {
      return;
    }
    const heartbeat = setInterval(() => {
      void this.renewLease(taskId, leaseOwner, active);
    }, this.reconciliationIntervalMs);
    heartbeat.unref();
    try {
      const principal = task.issuer === MCP_API_KEY_TASK_ISSUER
        ? await this.resolveApiKeyPrincipal(task.clientId, task.workspaceId)
        : await this.resolveOAuthPrincipal(task.issuer, task.subject, task.workspaceId);
      const result = await executeMcpAnswerTask(
        this.options.services,
        principal,
        task.request,
        active.abortController.signal,
      );
      active.abortController.signal.throwIfAborted();
      await this.options.tasks.complete(taskId, leaseOwner, result);
    } catch (error: unknown) {
      if (active.cancelRequested) {
        await this.options.tasks.cancelClaimed(taskId, leaseOwner);
      } else {
        await this.options.tasks.fail(
          taskId,
          leaseOwner,
          { code: -32603, message: "Task execution failed." },
          "Task execution failed.",
        );
      }
      if (!active.abortController.signal.aborted) {
        this.options.onError(error);
      }
    } finally {
      clearInterval(heartbeat);
    }
  }

  private async resolveApiKeyPrincipal(
    apiKeyId: string,
    workspaceId: string,
  ): Promise<import("../../auth/model.js").AuthorizationPrincipal> {
    const access = await this.options.services.resolveMcpApiKeyPrincipal(
      apiKeyId,
      workspaceId,
      [MCP_ANSWER_SCOPE],
    );
    return access.principal;
  }

  private async resolveOAuthPrincipal(
    issuer: string,
    subject: string,
    workspaceId: string,
  ): Promise<import("../../auth/model.js").AuthorizationPrincipal> {
    const authentication = await this.options.services
      .readAuthenticationSettings(this.options.publicOrigin);
    if (
      authentication.mode !== "oauth"
      || authentication.activeOAuthConfiguration?.issuer !== issuer
      || !authentication.activeOAuthConfiguration.mcpScopes.includes(
        MCP_ANSWER_SCOPE,
      )
    ) {
      throw new Error("OAuth authentication is no longer active.");
    }
    return this.options.services.resolveOAuthPrincipal(
      { issuer, scopes: [MCP_ANSWER_SCOPE], subject },
      workspaceId,
    );
  }

  private async renewLease(
    taskId: string,
    leaseOwner: string,
    active: ActiveMcpTask,
  ): Promise<void> {
    try {
      const state = await this.options.tasks.renewLease(
        taskId,
        leaseOwner,
        this.buildLeaseExpiry(),
      );
      if (state === "active") {
        return;
      }
      if (state === "cancel") {
        active.cancelRequested = true;
      }
      active.abortController.abort(new Error("The MCP task lease ended."));
    } catch (error: unknown) {
      this.options.onError(error);
      active.abortController.abort(error);
    }
  }

  private buildLeaseExpiry(): Date {
    return new Date(Date.now() + this.leaseDurationMs);
  }
}
