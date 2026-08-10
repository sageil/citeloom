import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";

import { z } from "zod";

import {
  queryScopeSchema,
  type QueryScope,
} from "../domain/query-scope.js";
import { tagSchema } from "../domain/validation.js";

const commandSchema = z.discriminatedUnion("name", [
  z.object({ name: z.literal("doctor") }),
  z.object({ name: z.literal("documents") }),
  z.object({ name: z.literal("document-toc-backfill") }),
  z.object({
    action: z.enum(["apply", "dry-run", "resume"]),
    name: z.literal("embedding-space-gc"),
    retentionDays: z.number().int().nonnegative().max(36_500).nullable(),
    runId: z.uuid().nullable(),
  }),
  z.object({
    name: z.literal("embedding-space-pin"),
    reason: z.string().trim().min(1).max(500),
    spaceId: z.string().trim().min(1).max(500),
  }),
  z.object({
    name: z.literal("embedding-space-unpin"),
    spaceId: z.string().trim().min(1).max(500),
  }),
  z.object({ name: z.literal("help") }),
  z.object({
    name: z.literal("retry-job"),
    sourceFile: z.string().min(1).max(8_192),
  }),
  z.object({ name: z.literal("status") }),
  z.object({ name: z.literal("source-content-migrate") }),
  z.object({
    directory: z.string().min(1),
    name: z.literal("source-content-export"),
  }),
  z.object({
    directory: z.string().min(1),
    name: z.literal("source-content-import"),
  }),
  z.object({ name: z.literal("worker"), once: z.boolean() }),
  z.object({
    enqueue: z.boolean(),
    force: z.boolean(),
    inputPaths: z.array(z.string().min(1)).min(1),
    name: z.literal("ingest"),
    recursive: z.boolean(),
    tags: z.array(tagSchema),
  }),
  z.object({
    name: z.literal("ask"),
    question: z.string().trim().min(1).max(8_000),
    scope: queryScopeSchema,
  }),
]);

export type CliCommand = z.output<typeof commandSchema>;

export class CliUsageError extends Error {
  public override readonly name = "CliUsageError";
}

export function parseCliCommand(
  arguments_: string[],
  workingDirectory: string = process.cwd(),
): CliCommand {
  const [commandName, ...commandArguments] = arguments_;
  let candidate: unknown;

  if (commandName === undefined || commandName === "help" || commandName === "--help") {
    candidate = { name: "help" };
  } else if (commandName === "doctor") {
    candidate = { name: "doctor" };
  } else if (commandName === "status") {
    candidate = { name: "status" };
  } else if (commandName === "source-content") {
    candidate = parseSourceContentArguments(commandArguments, workingDirectory);
  } else if (commandName === "worker") {
    candidate = parseWorkerArguments(commandArguments);
  } else if (commandName === "documents") {
    candidate = parseDocumentsArguments(commandArguments);
  } else if (commandName === "document-toc") {
    candidate = parseDocumentTocArguments(commandArguments);
  } else if (commandName === "embedding-spaces") {
    candidate = parseEmbeddingSpaceArguments(commandArguments);
  } else if (commandName === "jobs") {
    candidate = parseJobsArguments(commandArguments);
  } else if (commandName === "ingest") {
    candidate = parseIngestArguments(commandArguments);
  } else if (commandName === "ask") {
    candidate = parseAskArguments(commandArguments, workingDirectory);
  } else {
    throw new CliUsageError(`Unknown command: ${commandName}`);
  }

  const result = commandSchema.safeParse(candidate);
  if (!result.success) {
    throw new CliUsageError(readCommandUsageError(commandName));
  }
  return result.data;
}

function parseSourceContentArguments(
  arguments_: string[],
  workingDirectory: string,
): unknown {
  if (arguments_.length === 2
    && arguments_[0] === "migrate"
    && arguments_[1] === "--apply") {
    return { name: "source-content-migrate" };
  }
  if (
    arguments_.length === 3
    && arguments_[0] === "export"
    && arguments_[1] === "--directory"
    && arguments_[2] !== undefined
  ) {
    return {
      directory: resolve(workingDirectory, arguments_[2]),
      name: "source-content-export",
    };
  }
  if (
    arguments_.length === 4
    && arguments_[0] === "import"
    && arguments_[1] === "--directory"
    && arguments_[2] !== undefined
    && arguments_[3] === "--apply"
  ) {
    return {
      directory: resolve(workingDirectory, arguments_[2]),
      name: "source-content-import",
    };
  }
  throw new CliUsageError(
    "Usage: citeloom source-content migrate --apply | citeloom source-content export --directory <path> | citeloom source-content import --directory <path> --apply",
  );
}

function parseDocumentTocArguments(arguments_: string[]): unknown {
  if (arguments_.length === 1 && arguments_[0] === "backfill") {
    return { name: "document-toc-backfill" };
  }
  throw new CliUsageError("Usage: citeloom document-toc backfill");
}

function parseDocumentsArguments(arguments_: string[]): unknown {
  if (
    arguments_.length === 0
    || (arguments_.length === 1 && arguments_[0] === "list")
  ) {
    return { name: "documents" };
  }
  throw new CliUsageError("Usage: citeloom documents list");
}

function parseEmbeddingSpaceArguments(arguments_: string[]): unknown {
  const operation = arguments_[0];
  if (operation === "pin") {
    if (
      arguments_.length !== 5
      || arguments_[1] !== "--space"
      || arguments_[2] === undefined
      || arguments_[3] !== "--reason"
      || arguments_[4] === undefined
    ) {
      throw new CliUsageError(readEmbeddingSpaceUsage());
    }
    return {
      name: "embedding-space-pin",
      reason: arguments_[4],
      spaceId: arguments_[2],
    };
  }
  if (operation === "unpin") {
    if (
      arguments_.length !== 3
      || arguments_[1] !== "--space"
      || arguments_[2] === undefined
    ) {
      throw new CliUsageError(readEmbeddingSpaceUsage());
    }
    return { name: "embedding-space-unpin", spaceId: arguments_[2] };
  }
  if (operation !== "gc") {
    throw new CliUsageError(readEmbeddingSpaceUsage());
  }

  let action: "apply" | "dry-run" | null = null;
  let retentionDays: number | null = null;
  let runId: string | null = null;
  for (let index = 1; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--apply") {
      if (action !== null) {
        throw new CliUsageError(readEmbeddingSpaceUsage());
      }
      action = "apply";
      continue;
    }
    if (argument === "--dry-run") {
      if (action !== null) {
        throw new CliUsageError(readEmbeddingSpaceUsage());
      }
      action = "dry-run";
      continue;
    }
    if (argument === "--retention-days") {
      retentionDays = readIntegerOption(arguments_, index, argument);
      index += 1;
      continue;
    }
    if (argument === "--resume") {
      runId = requireOptionValue(arguments_, index, argument);
      index += 1;
      continue;
    }
    throw new CliUsageError(readEmbeddingSpaceUsage());
  }
  if (action !== "apply") {
    if (action === "dry-run" && retentionDays !== null && runId === null) {
      return { action, name: "embedding-space-gc", retentionDays, runId };
    }
    throw new CliUsageError(readEmbeddingSpaceUsage());
  }
  if (runId !== null) {
    if (retentionDays !== null) {
      throw new CliUsageError(readEmbeddingSpaceUsage());
    }
    return {
      action: "resume",
      name: "embedding-space-gc",
      retentionDays: null,
      runId,
    };
  }
  if (retentionDays === null) {
    throw new CliUsageError(readEmbeddingSpaceUsage());
  }
  return { action, name: "embedding-space-gc", retentionDays, runId: null };
}

function readEmbeddingSpaceUsage(): string {
  return "Usage: citeloom embedding-spaces pin --space <id> --reason <reason> | citeloom embedding-spaces unpin --space <id> | citeloom embedding-spaces gc --retention-days <days> <--dry-run|--apply> | citeloom embedding-spaces gc --resume <run-id> --apply";
}

function parseIngestArguments(arguments_: string[]): unknown {
  const inputPaths: string[] = [];
  const tags: string[] = [];
  let enqueue = false;
  let force = false;
  let pathsOnly = false;
  let recursive = false;

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === undefined) {
      throw new CliUsageError("Usage: citeloom ingest [options] <path> [...paths]");
    }
    if (pathsOnly) {
      inputPaths.push(argument);
      continue;
    }
    if (argument === "--") {
      pathsOnly = true;
      continue;
    }
    if (argument === "--force") {
      force = true;
      continue;
    }
    if (argument === "--enqueue") {
      enqueue = true;
      continue;
    }
    if (argument === "--recursive") {
      recursive = true;
      continue;
    }
    if (argument === "--tag") {
      tags.push(requireOptionValue(arguments_, index, argument));
      index += 1;
      continue;
    }
    if (argument.startsWith("--")) {
      throw new CliUsageError(`Unknown ingest option: ${argument}`);
    }
    inputPaths.push(argument);
  }

  return { enqueue, force, inputPaths, name: "ingest", recursive, tags };
}

function parseWorkerArguments(arguments_: string[]): unknown {
  if (arguments_.length === 0) {
    return { name: "worker", once: false };
  }
  if (arguments_.length === 1 && arguments_[0] === "--once") {
    return { name: "worker", once: true };
  }
  throw new CliUsageError("Usage: citeloom worker [--once]");
}

function parseJobsArguments(arguments_: string[]): unknown {
  if (
    arguments_.length !== 3
    || arguments_[0] !== "retry"
    || arguments_[1] !== "--file"
    || arguments_[2] === undefined
  ) {
    throw new CliUsageError("Usage: citeloom jobs retry --file <stored-source-file>");
  }
  return { name: "retry-job", sourceFile: arguments_[2] };
}

function parseAskArguments(arguments_: string[], workingDirectory: string): unknown {
  const documentIds: string[] = [];
  const questionParts: string[] = [];
  const sourceFiles: string[] = [];
  const tags: string[] = [];
  let explicitAll = false;
  let questionOnly = false;

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === undefined) {
      throw new CliUsageError("Usage: citeloom ask [scope] -- <question>");
    }
    if (questionOnly) {
      questionParts.push(argument);
      continue;
    }
    if (argument === "--") {
      questionOnly = true;
      continue;
    }
    if (argument === "--all") {
      explicitAll = true;
      continue;
    }
    if (argument === "--document") {
      documentIds.push(requireOptionValue(arguments_, index, argument));
      index += 1;
      continue;
    }
    if (argument === "--file") {
      const sourceFile = requireOptionValue(arguments_, index, argument);
      sourceFiles.push(normalizeSourceFile(workingDirectory, sourceFile));
      index += 1;
      continue;
    }
    if (argument === "--tag") {
      tags.push(requireOptionValue(arguments_, index, argument));
      index += 1;
      continue;
    }
    if (argument.startsWith("--")) {
      throw new CliUsageError(`Unknown ask option: ${argument}`);
    }
    questionParts.push(argument);
  }

  const scope = buildQueryScope(explicitAll, documentIds, sourceFiles, tags);
  return { name: "ask", question: questionParts.join(" "), scope };
}

function requireOptionValue(
  arguments_: string[],
  optionIndex: number,
  optionName: string,
): string {
  const value = arguments_[optionIndex + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new CliUsageError(`${optionName} requires a value.`);
  }
  return value;
}

function readIntegerOption(
  arguments_: string[],
  optionIndex: number,
  optionName: string,
): number {
  const value = requireOptionValue(arguments_, optionIndex, optionName);
  if (!/^\d+$/.test(value)) {
    throw new CliUsageError(`${optionName} requires a positive integer.`);
  }
  return Number(value);
}

function normalizeSourceFile(workingDirectory: string, sourceFile: string): string {
  const absolutePath = resolve(workingDirectory, sourceFile);
  return existsSync(absolutePath) ? realpathSync(absolutePath) : absolutePath;
}

function buildQueryScope(
  explicitAll: boolean,
  documentIds: string[],
  sourceFiles: string[],
  tags: string[],
): QueryScope {
  let selectedScopes = 0;
  selectedScopes += explicitAll ? 1 : 0;
  selectedScopes += documentIds.length > 0 ? 1 : 0;
  selectedScopes += sourceFiles.length > 0 ? 1 : 0;
  selectedScopes += tags.length > 0 ? 1 : 0;
  if (selectedScopes > 1) {
    throw new CliUsageError("Choose only one query scope: --all, --document, --file, or --tag.");
  }
  if (documentIds.length > 0) {
    return { documentIds, kind: "documentIds" };
  }
  if (sourceFiles.length > 0) {
    return { kind: "sourceFiles", sourceFiles };
  }
  if (tags.length > 0) {
    return { kind: "tags", tags };
  }
  return { kind: "all" };
}

function readCommandUsageError(commandName: string | undefined): string {
  if (commandName === "ingest") {
    return "Usage: citeloom ingest [options] <path> [...paths]";
  }
  if (commandName === "worker") {
    return "Usage: citeloom worker [--once]";
  }
  if (commandName === "jobs") {
    return "Usage: citeloom jobs retry --file <stored-source-file>";
  }
  if (commandName === "ask") {
    return "Usage: citeloom ask [scope] -- <question>";
  }
  return "Invalid command.";
}
