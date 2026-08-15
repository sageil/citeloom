import type {
  McpAnswerTaskRequest,
  McpAnswerTaskResult,
  McpTaskError,
  McpTaskOwner,
  McpTaskRecord,
  McpTaskServices,
} from "./model.js";
import type { McpTaskStore } from "./store.js";

export type RunMcpTaskStore = <Result>(
  operation: (store: McpTaskStore) => Promise<Result>,
) => Promise<Result>;

export class ManagedMcpTaskServices implements McpTaskServices {
  public constructor(private readonly run: RunMcpTaskStore) {}

  public cancelClaimed(taskId: string, leaseOwner: string): Promise<boolean> {
    return this.run((store) => store.cancelClaimed(taskId, leaseOwner));
  }

  public claim(
    taskId: string,
    leaseOwner: string,
    leaseExpiresAt: Date,
  ): Promise<McpTaskRecord | null> {
    return this.run((store) => {
      return store.claim(taskId, leaseOwner, leaseExpiresAt);
    });
  }

  public complete(
    taskId: string,
    leaseOwner: string,
    result: McpAnswerTaskResult,
  ): Promise<boolean> {
    return this.run((store) => store.complete(taskId, leaseOwner, result));
  }

  public deleteExpiredTerminalBatch(now: Date): Promise<number> {
    return this.run((store) => store.deleteExpiredTerminalBatch(now));
  }

  public create(
    owner: McpTaskOwner,
    request: McpAnswerTaskRequest,
  ): Promise<McpTaskRecord> {
    return this.run((store) => store.create(owner, request));
  }

  public fail(
    taskId: string,
    leaseOwner: string,
    error: McpTaskError,
    statusMessage: string,
  ): Promise<boolean> {
    return this.run((store) => {
      return store.fail(taskId, leaseOwner, error, statusMessage);
    });
  }

  public failExpiredLeases(now: Date): Promise<number> {
    return this.run((store) => store.failExpiredLeases(now));
  }

  public listUnclaimedTaskIds(): Promise<string[]> {
    return this.run((store) => store.listUnclaimedTaskIds());
  }

  public readForOwner(
    owner: McpTaskOwner,
    taskId: string,
  ): Promise<McpTaskRecord | null> {
    return this.run((store) => store.readForOwner(owner, taskId));
  }

  public renewLease(
    taskId: string,
    leaseOwner: string,
    leaseExpiresAt: Date,
  ): Promise<"active" | "cancel" | "lost"> {
    return this.run((store) => {
      return store.renewLease(taskId, leaseOwner, leaseExpiresAt);
    });
  }

  public requestCancellation(
    owner: McpTaskOwner,
    taskId: string,
  ): Promise<boolean> {
    return this.run((store) => store.requestCancellation(owner, taskId));
  }
}
