import { resolve } from "node:path";

import { z } from "zod";

import {
  downloadCorpus,
  type CorpusDomain,
} from "./downloader.js";

const corpusCommandSchema = z.object({
  domain: z.enum(["legal", "veterinary"]).nullable(),
  manifestPath: z.string().min(1),
  outputDirectory: z.string().min(1),
  overwrite: z.boolean(),
}).strict();

type CorpusCommand = z.output<typeof corpusCommandSchema>;

export function parseCorpusCommand(
  arguments_: string[],
  workingDirectory: string = process.cwd(),
): CorpusCommand {
  if (arguments_[0] !== "download") {
    throw new Error(readCorpusUsage());
  }
  let domain: CorpusDomain | null = null;
  let manifestPath = resolve(workingDirectory, "corpora/manifest.json");
  let outputDirectory = resolve(
    workingDirectory,
    "documents/evaluation-corpora",
  );
  let overwrite = false;

  for (let index = 1; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--force") {
      overwrite = true;
      continue;
    }
    if (argument === "--domain") {
      domain = readDomain(arguments_, index);
      index += 1;
      continue;
    }
    if (argument === "--manifest") {
      manifestPath = resolve(
        workingDirectory,
        readOptionValue(arguments_, index, "--manifest"),
      );
      index += 1;
      continue;
    }
    if (argument === "--output") {
      outputDirectory = resolve(
        workingDirectory,
        readOptionValue(arguments_, index, "--output"),
      );
      index += 1;
      continue;
    }
    throw new Error(`Unknown corpus option: ${argument ?? "missing"}`);
  }

  return corpusCommandSchema.parse({
    domain,
    manifestPath,
    outputDirectory,
    overwrite,
  });
}

export async function main(arguments_: string[] = process.argv.slice(2)): Promise<void> {
  const command = parseCorpusCommand(arguments_);
  const result = await downloadCorpus(
    command.manifestPath,
    {
      domain: command.domain,
      outputDirectory: command.outputDirectory,
      overwrite: command.overwrite,
    },
    (message) => console.error(`- ${message}`),
  );
  console.log(
    `Corpus ready: ${result.downloaded} downloaded, ${result.skipped} kept, ${result.documents.length} total.`,
  );
  console.log(`Inventory: ${result.inventoryPath}`);
}

function readDomain(arguments_: string[], optionIndex: number): CorpusDomain {
  const value = readOptionValue(arguments_, optionIndex, "--domain");
  if (value !== "legal" && value !== "veterinary") {
    throw new Error("--domain must be legal or veterinary.");
  }
  return value;
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

function readCorpusUsage(): string {
  return "Usage: pnpm corpus:download download [--domain <legal|veterinary>] [--manifest <path>] [--output <directory>] [--force]";
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}`);
    process.exitCode = 1;
  });
}
