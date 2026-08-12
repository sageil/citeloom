export interface DocumentVersionView {
  createdAt: string;
  documentId: string;
  elementCount: number;
  id: string;
  pageCount: number | null;
  sourceFile: string;
  version: number;
}

export interface IngestionControlResponseView {
  action: "pause" | "resume" | "cancel";
  sourceFile: string;
  state:
    | "pending"
    | "running"
    | "canceled"
    | "active"
    | "pause_requested"
    | "paused"
    | "cancel_requested"
    | "cleanup_failed";
}

export interface AlpineDataRegistrar {
  data(name: string, factory: () => unknown): void;
}

export function registerPage(alpine: AlpineDataRegistrar): void;

export function readDocumentVersions(value: unknown): DocumentVersionView[];

export function readIngestionControlResponse(
  value: unknown,
): IngestionControlResponseView;
