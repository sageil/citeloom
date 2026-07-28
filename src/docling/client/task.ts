import { randomUUID } from "node:crypto";

export interface DoclingTaskReference {
  deadlineAt: string;
  id: string;
  submittedAt: string;
}

export interface PreparedDoclingTask {
  kind: "new" | "resumed";
  task: DoclingTaskReference;
}

export type DoclingTaskControl =
  | { kind: "ephemeral" }
  | {
      clear: (taskId: string) => Promise<void>;
      current: DoclingTaskReference | null;
      kind: "durable";
      record: (task: DoclingTaskReference) => Promise<void>;
    };

export interface DoclingTaskControlFactory {
  open(requestKey: string): Promise<DoclingTaskControl>;
}

export const ephemeralDoclingTaskControl: DoclingTaskControl = {
  kind: "ephemeral",
};

export const ephemeralDoclingTaskControlFactory: DoclingTaskControlFactory = {
  open: async () => ephemeralDoclingTaskControl,
};

export async function prepareDoclingTask(
  control: DoclingTaskControl,
  taskTimeoutMs: number,
  currentTime: Date = new Date(),
): Promise<PreparedDoclingTask> {
  if (!Number.isFinite(taskTimeoutMs) || taskTimeoutMs <= 0) {
    throw new Error("Docling task timeout must be positive.");
  }
  if (control.kind === "durable" && control.current !== null) {
    return { kind: "resumed", task: control.current };
  }

  const submittedAtMs = currentTime.getTime();
  const task: DoclingTaskReference = {
    deadlineAt: new Date(submittedAtMs + taskTimeoutMs).toISOString(),
    id: randomUUID(),
    submittedAt: currentTime.toISOString(),
  };
  if (control.kind === "durable") {
    await control.record(task);
  }
  return { kind: "new", task };
}
