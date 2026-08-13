import { resolve } from "node:path";

import { z } from "zod";

import { ApplicationSettingsRepository } from "../../../src/app/settings.js";
import { readStartupConfig } from "../../../src/config/index.js";
import { openDatabase } from "../../../src/database/client.js";
import { readProofCorpus } from "./proof.js";
import {
  reconcileCorpusQueue,
  type CorpusQueueReconciliationResult,
} from "./reconciler.js";

const commandSchema = z.object({
  apply: z.boolean(),
  corpusRoot: z.string().min(1),
  forceSelected: z.boolean(),
  manifestPath: z.string().min(1),
}).strict();

export type CorpusReconcileCommand = z.output<typeof commandSchema>;

export function parseCorpusReconcileCommand(
  arguments_: string[],
  workingDirectory: string = process.cwd(),
): CorpusReconcileCommand {
  let apply = false;
  let corpusRoot = resolve(workingDirectory, "documents/evaluation-corpora");
  let forceSelected = false;
  let manifestPath = resolve(workingDirectory, "corpora/proof.json");

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--apply") {
      apply = true;
      continue;
    }
    if (argument === "--force-selected") {
      forceSelected = true;
      continue;
    }
    if (argument === "--corpus-root") {
      corpusRoot = resolve(
        workingDirectory,
        readOptionValue(arguments_, index, argument),
      );
      index += 1;
      continue;
    }
    if (argument === "--manifest") {
      manifestPath = resolve(
        workingDirectory,
        readOptionValue(arguments_, index, argument),
      );
      index += 1;
      continue;
    }
    throw new Error(`Unknown corpus reconciliation option: ${argument ?? "missing"}`);
  }

  return commandSchema.parse({
    apply,
    corpusRoot,
    forceSelected,
    manifestPath,
  });
}

export async function main(
  arguments_: string[] = process.argv.slice(2),
): Promise<void> {
  const command = parseCorpusReconcileCommand(arguments_);
  const corpus = await readProofCorpus(
    command.manifestPath,
    command.corpusRoot,
  );
  const startup = readStartupConfig();
  const session = await openDatabase(startup.database);
  let result: CorpusQueueReconciliationResult;
  try {
    const repository = new ApplicationSettingsRepository(session.database);
    const settings = await repository.read(startup.database);
    result = await reconcileCorpusQueue(
      settings.config,
      corpus,
      {
        apply: command.apply,
        forceSelected: command.forceSelected,
      },
      (message) => console.error(`- ${message}`),
    );
  } finally {
    await session.close();
  }
  printReconciliation(result, command.forceSelected);
  if (result.failures.length > 0 || result.protected.length > 0) {
    process.exitCode = 1;
  }
}

function printReconciliation(
  result: CorpusQueueReconciliationResult,
  forceSelected: boolean,
): void {
  const mode = result.applied ? "Applied" : "Dry run";
  console.log(`${mode}: proof corpus contains ${result.plan.selected.length} documents.`);
  console.log(
    `${result.plan.cancellable.length} queued documents are outside the proof corpus.`,
  );
  for (const job of result.plan.cancellable) {
    console.log(`  CANCEL ${job.sourceFile}`);
  }
  for (const job of result.plan.protected) {
    console.log(`  PROTECTED ${job.sourceFile}`);
  }
  const selectedAction = forceSelected ? "FORCE QUEUE" : "ENSURE";
  for (const document of result.plan.selected) {
    console.log(
      `  ${selectedAction} ${document.domain} ${document.split} ${document.sourceFile}`,
    );
  }
  if (!result.applied) {
    console.log("No changes were made. Add --apply to reconcile the queue.");
    return;
  }
  console.log(
    `Canceled ${result.canceled.length} jobs and queued or retained ${result.ingested.length} selected documents.`,
  );
  for (const failure of result.failures) {
    console.error(`  FAILED ${failure.sourceFile}: ${failure.error}`);
  }
}

function readOptionValue(
  arguments_: string[],
  optionIndex: number,
  optionName: string,
): string {
  const value = arguments_[optionIndex + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${optionName} requires a value.`);
  }
  return value;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}`);
    process.exitCode = 1;
  });
}
