import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";

import { z } from "zod";

import type { QueryScope } from "../../src/domain/query-scope.js";
import {
  evaluationLanguageSchema,
  evaluationQuestionTypeSchema,
  evaluationSplitSchema,
  evaluationStatisticalDesignSchema,
  evaluationStableNameSchema,
} from "./dataset.js";
import { createEvaluationStatisticalDesign } from "./statistics.js";
import { queryScopeSchema } from "../../src/domain/query-scope.js";

const commandSchema = z.discriminatedUnion("name", [
  z.object({
    datasetPath: z.string().min(1),
    name: z.literal("evaluate-claims"),
    outputPath: z.string().min(1),
  }),
  z.object({
    datasetPath: z.string().min(1),
    frozenConfigurationPath: z.string().min(1).nullable(),
    name: z.literal("evaluate"),
    outputPath: z.string().min(1).nullable(),
    preparationOutputPath: z.string().min(1),
    tuningSelectionPath: z.string().min(1).nullable(),
  }),
  z.object({
    name: z.literal("freeze-evaluation-configuration"),
    outputPath: z.string().min(1),
  }),
  z.object({
    name: z.literal("score-evaluation"),
    outputPath: z.string().min(1).nullable(),
    preparationPath: z.string().min(1),
  }),
  z.object({
    freezeOutputPath: z.string().min(1),
    name: z.literal("tune-evaluation"),
    outputPath: z.string().min(1),
    preparationPaths: z.array(z.string().min(1)).min(1),
    specificationPath: z.string().min(1),
  }),
  z.object({
    datasetPath: z.string().min(1),
    name: z.literal("prepare-answer-threshold-calibration"),
    negativeDomain: evaluationStableNameSchema,
    outputPath: z.string().min(1),
  }),
  z.object({
    maximumFalseAcceptanceRate: z.number().finite().min(0).max(1),
    name: z.literal("select-answer-threshold"),
    outputPath: z.string().min(1),
    preparationPaths: z.array(z.string().min(1)).min(1),
  }),
  z.object({
    atK: z.number().int().min(1),
    caseCount: z.number().int().min(1).max(1_000),
    domain: evaluationStableNameSchema,
    enrich: z.boolean(),
    language: evaluationLanguageSchema,
    name: z.literal("generate-evaluation"),
    outputPath: z.string().min(1),
    overwrite: z.boolean(),
    scope: queryScopeSchema,
    seed: z.string().trim().min(1).max(120),
    split: evaluationSplitSchema,
    statisticalDesign: evaluationStatisticalDesignSchema,
    questionType: evaluationQuestionTypeSchema,
  }),
  z.object({ name: z.literal("help") }),
]);

export type EvaluationCommand = z.output<typeof commandSchema>;

export function parseEvaluationCommand(
  arguments_: string[],
  workingDirectory: string = process.cwd(),
): EvaluationCommand {
  if (
    arguments_.length === 0
    || arguments_[0] === "help"
    || arguments_[0] === "--help"
  ) {
    return { name: "help" };
  }

  const candidate = parseEvaluateArguments(arguments_, workingDirectory);
  const result = commandSchema.safeParse(candidate);
  if (!result.success) {
    if (arguments_[0] === "--generate") {
      throw new Error(readEvaluationGenerationUsage());
    }
    throw new Error(readEvaluationUsage());
  }
  return result.data;
}

function parseEvaluateArguments(
  arguments_: string[],
  workingDirectory: string,
): unknown {
  if (arguments_[0] === "--claims") {
    if (
      arguments_.length !== 5
      || arguments_[1] !== "--dataset"
      || arguments_[2] === undefined
      || arguments_[3] !== "--output"
      || arguments_[4] === undefined
    ) {
      throw new Error(readEvaluationUsage());
    }
    return {
      datasetPath: normalizeSourceFile(workingDirectory, arguments_[2]),
      name: "evaluate-claims",
      outputPath: normalizeSourceFile(workingDirectory, arguments_[4]),
    };
  }
  if (arguments_[0] === "--generate") {
    return parseEvaluationGenerationArguments(
      arguments_.slice(1),
      workingDirectory,
    );
  }
  if (arguments_[0] === "--tune") {
    return parseEvaluationTuningArguments(
      arguments_.slice(1),
      workingDirectory,
    );
  }
  if (arguments_[0] === "--prepare-answer-threshold") {
    return parseAnswerThresholdPreparationArguments(
      arguments_.slice(1),
      workingDirectory,
    );
  }
  if (arguments_[0] === "--select-answer-threshold") {
    return parseAnswerThresholdSelectionArguments(
      arguments_.slice(1),
      workingDirectory,
    );
  }
  if (arguments_[0] === "--freeze-configuration") {
    return parseFreezeEvaluationArguments(
      arguments_.slice(1),
      workingDirectory,
    );
  }
  if (arguments_[0] === "--from-preparation") {
    return parseSavedEvaluationArguments(
      arguments_.slice(1),
      workingDirectory,
    );
  }
  const datasetArgument = arguments_[0];
  if (datasetArgument === undefined) {
    throw new Error(readEvaluationUsage());
  }
  let outputPath: string | null = null;
  let frozenConfigurationPath: string | null = null;
  let preparationOutputPath: string | null = null;
  let tuningSelectionPath: string | null = null;
  for (let index = 1; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--output") {
      const output = requireOptionValue(arguments_, index, "--output");
      outputPath = normalizeSourceFile(workingDirectory, output);
      index += 1;
      continue;
    }
    if (argument === "--frozen-configuration") {
      const input = requireOptionValue(
        arguments_,
        index,
        "--frozen-configuration",
      );
      frozenConfigurationPath = normalizeSourceFile(workingDirectory, input);
      index += 1;
      continue;
    }
    if (argument === "--preparation-output") {
      const output = requireOptionValue(
        arguments_,
        index,
        "--preparation-output",
      );
      preparationOutputPath = normalizeSourceFile(workingDirectory, output);
      index += 1;
      continue;
    }
    if (argument === "--tuning-selection") {
      const input = requireOptionValue(
        arguments_,
        index,
        "--tuning-selection",
      );
      tuningSelectionPath = normalizeSourceFile(workingDirectory, input);
      index += 1;
      continue;
    }
    throw new Error(readEvaluationUsage());
  }
  if (preparationOutputPath === null) {
    throw new Error(readEvaluationUsage());
  }
  if (tuningSelectionPath !== null && frozenConfigurationPath === null) {
    throw new Error(
      "A tuning selection must be used with its frozen configuration.",
    );
  }
  const datasetPath = normalizeSourceFile(workingDirectory, datasetArgument);
  assertDistinctEvaluationPaths(
    datasetPath,
    preparationOutputPath,
    outputPath,
  );
  return {
    datasetPath,
    frozenConfigurationPath,
    name: "evaluate",
    outputPath,
    preparationOutputPath,
    tuningSelectionPath,
  };
}

function parseEvaluationTuningArguments(
  arguments_: string[],
  workingDirectory: string,
): unknown {
  const preparationPaths: string[] = [];
  let freezeOutputPath: string | null = null;
  let outputPath: string | null = null;
  let specificationPath: string | null = null;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--specification") {
      specificationPath = normalizeSourceFile(
        workingDirectory,
        requireOptionValue(arguments_, index, "--specification"),
      );
      index += 1;
      continue;
    }
    if (argument === "--from-preparation") {
      preparationPaths.push(normalizeSourceFile(
        workingDirectory,
        requireOptionValue(arguments_, index, "--from-preparation"),
      ));
      index += 1;
      continue;
    }
    if (argument === "--output") {
      outputPath = normalizeSourceFile(
        workingDirectory,
        requireOptionValue(arguments_, index, "--output"),
      );
      index += 1;
      continue;
    }
    if (argument === "--freeze-output") {
      freezeOutputPath = normalizeSourceFile(
        workingDirectory,
        requireOptionValue(arguments_, index, "--freeze-output"),
      );
      index += 1;
      continue;
    }
    throw new Error(readEvaluationTuningUsage());
  }
  if (
    specificationPath === null
    || outputPath === null
    || freezeOutputPath === null
    || preparationPaths.length === 0
  ) {
    throw new Error(readEvaluationTuningUsage());
  }
  const paths = [
    specificationPath,
    outputPath,
    freezeOutputPath,
    ...preparationPaths,
  ];
  if (new Set(paths).size !== paths.length) {
    throw new Error("Evaluation tuning inputs and outputs must use distinct paths.");
  }
  return {
    freezeOutputPath,
    name: "tune-evaluation",
    outputPath,
    preparationPaths,
    specificationPath,
  };
}

function parseAnswerThresholdPreparationArguments(
  arguments_: string[],
  workingDirectory: string,
): unknown {
  const datasetArgument = arguments_[0];
  if (datasetArgument === undefined) {
    throw new Error(readAnswerThresholdUsage());
  }
  let negativeDomain: string | null = null;
  let outputPath: string | null = null;
  for (let index = 1; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--negative-domain") {
      negativeDomain = requireOptionValue(arguments_, index, argument);
      index += 1;
      continue;
    }
    if (argument === "--output") {
      outputPath = normalizeSourceFile(
        workingDirectory,
        requireOptionValue(arguments_, index, argument),
      );
      index += 1;
      continue;
    }
    throw new Error(readAnswerThresholdUsage());
  }
  if (negativeDomain === null || outputPath === null) {
    throw new Error(readAnswerThresholdUsage());
  }
  const datasetPath = normalizeSourceFile(workingDirectory, datasetArgument);
  if (datasetPath === outputPath) {
    throw new Error(
      "The answer-threshold preparation must not overwrite its dataset.",
    );
  }
  return {
    datasetPath,
    name: "prepare-answer-threshold-calibration",
    negativeDomain,
    outputPath,
  };
}

function parseAnswerThresholdSelectionArguments(
  arguments_: string[],
  workingDirectory: string,
): unknown {
  const preparationPaths: string[] = [];
  let maximumFalseAcceptanceRate: number | null = null;
  let outputPath: string | null = null;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--from-preparation") {
      preparationPaths.push(normalizeSourceFile(
        workingDirectory,
        requireOptionValue(arguments_, index, argument),
      ));
      index += 1;
      continue;
    }
    if (argument === "--maximum-false-acceptance-rate") {
      maximumFalseAcceptanceRate = readClosedUnitIntervalOption(
        arguments_,
        index,
        argument,
      );
      index += 1;
      continue;
    }
    if (argument === "--output") {
      outputPath = normalizeSourceFile(
        workingDirectory,
        requireOptionValue(arguments_, index, argument),
      );
      index += 1;
      continue;
    }
    throw new Error(readAnswerThresholdUsage());
  }
  if (
    preparationPaths.length === 0
    || maximumFalseAcceptanceRate === null
    || outputPath === null
  ) {
    throw new Error(readAnswerThresholdUsage());
  }
  if (preparationPaths.includes(outputPath)) {
    throw new Error(
      "The answer-threshold selection must not overwrite a preparation.",
    );
  }
  if (new Set(preparationPaths).size !== preparationPaths.length) {
    throw new Error("Answer-threshold preparation paths must be unique.");
  }
  return {
    maximumFalseAcceptanceRate,
    name: "select-answer-threshold",
    outputPath,
    preparationPaths,
  };
}

function parseFreezeEvaluationArguments(
  arguments_: string[],
  workingDirectory: string,
): unknown {
  if (arguments_.length !== 2 || arguments_[0] !== "--output") {
    throw new Error(readEvaluationUsage());
  }
  const output = arguments_[1];
  if (output === undefined) {
    throw new Error(readEvaluationUsage());
  }
  return {
    name: "freeze-evaluation-configuration",
    outputPath: normalizeSourceFile(workingDirectory, output),
  };
}

function parseSavedEvaluationArguments(
  arguments_: string[],
  workingDirectory: string,
): unknown {
  const preparationArgument = arguments_[0];
  if (preparationArgument === undefined) {
    throw new Error(readEvaluationUsage());
  }
  let outputPath: string | null = null;
  if (arguments_.length === 3 && arguments_[1] === "--output") {
    const output = arguments_[2];
    if (output !== undefined) {
      outputPath = normalizeSourceFile(workingDirectory, output);
    }
  } else if (arguments_.length !== 1) {
    throw new Error(readEvaluationUsage());
  }
  const preparationPath = normalizeSourceFile(
    workingDirectory,
    preparationArgument,
  );
  if (outputPath === preparationPath) {
    throw new Error(
      "The offline evaluation output must not overwrite its preparation artifact.",
    );
  }
  return {
    name: "score-evaluation",
    outputPath,
    preparationPath,
  };
}

function readEvaluationUsage(): string {
  return `Usage: citeloom evaluate <dataset.json> --preparation-output <preparation.json> [--tuning-selection <selection.json> --frozen-configuration <freeze.json>] [--output <result.json>] | citeloom evaluate --from-preparation <preparation.json> [--output <result.json>] | citeloom evaluate --freeze-configuration --output <freeze.json> | citeloom evaluate --claims --dataset <audited-answers.json> --output <report.json> | ${readEvaluationTuningUsage()} | ${readAnswerThresholdUsage()}`;
}

function readEvaluationTuningUsage(): string {
  return "citeloom evaluate --tune --specification <search.json> --from-preparation <preparation.json> [--from-preparation <preparation.json>...] --output <selection.json> --freeze-output <freeze.json>";
}

function readAnswerThresholdUsage(): string {
  return "citeloom evaluate --prepare-answer-threshold <dataset.json> --negative-domain <domain> --output <preparation.json> | citeloom evaluate --select-answer-threshold --maximum-false-acceptance-rate <0..1> --from-preparation <preparation.json> [--from-preparation <preparation.json>...] --output <selection.json>";
}

function assertDistinctEvaluationPaths(
  datasetPath: string,
  preparationOutputPath: string,
  resultOutputPath: string | null,
): void {
  if (datasetPath === preparationOutputPath) {
    throw new Error(
      "The evaluation preparation output must not overwrite its dataset.",
    );
  }
  if (resultOutputPath === datasetPath) {
    throw new Error("The evaluation result must not overwrite its dataset.");
  }
  if (resultOutputPath === preparationOutputPath) {
    throw new Error(
      "The evaluation result and preparation output must use different paths.",
    );
  }
}

function parseEvaluationGenerationArguments(
  arguments_: string[],
  workingDirectory: string,
): unknown {
  const documentIds: string[] = [];
  const sourceFiles: string[] = [];
  const tags: string[] = [];
  let atK = 10;
  let assumedPairedNdcgDeltaStandardDeviation: number | null = null;
  let caseCount: number | null = null;
  let domain: string | null = null;
  let enrich = false;
  let explicitAll = false;
  let language: string | null = null;
  let minimumDetectableNdcgDelta: number | null = null;
  let outputPath: string | null = null;
  let overwrite = false;
  let seed = "citeloom-evaluation-v1";
  let split: string | null = null;
  let questionType: string | null = null;

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === undefined) {
      throw new Error(readEvaluationGenerationUsage());
    }
    if (argument === "--all") {
      explicitAll = true;
      continue;
    }
    if (argument === "--at-k") {
      atK = readIntegerOption(arguments_, index, "--at-k");
      index += 1;
      continue;
    }
    if (argument === "--assumed-paired-ndcg-stddev") {
      assumedPairedNdcgDeltaStandardDeviation = readUnitIntervalOption(
        arguments_,
        index,
        "--assumed-paired-ndcg-stddev",
      );
      index += 1;
      continue;
    }
    if (argument === "--cases") {
      caseCount = readIntegerOption(arguments_, index, "--cases");
      index += 1;
      continue;
    }
    if (argument === "--document") {
      documentIds.push(requireOptionValue(arguments_, index, "--document"));
      index += 1;
      continue;
    }
    if (argument === "--domain") {
      domain = requireOptionValue(arguments_, index, "--domain");
      index += 1;
      continue;
    }
    if (argument === "--enrich") {
      enrich = true;
      continue;
    }
    if (argument === "--file") {
      const sourceFile = requireOptionValue(arguments_, index, "--file");
      sourceFiles.push(normalizeSourceFile(workingDirectory, sourceFile));
      index += 1;
      continue;
    }
    if (argument === "--language") {
      language = requireOptionValue(arguments_, index, "--language");
      index += 1;
      continue;
    }
    if (argument === "--minimum-detectable-ndcg-delta") {
      minimumDetectableNdcgDelta = readUnitIntervalOption(
        arguments_,
        index,
        "--minimum-detectable-ndcg-delta",
      );
      index += 1;
      continue;
    }
    if (argument === "--force") {
      overwrite = true;
      continue;
    }
    if (argument === "--output") {
      const output = requireOptionValue(arguments_, index, "--output");
      outputPath = normalizeSourceFile(workingDirectory, output);
      index += 1;
      continue;
    }
    if (argument === "--seed") {
      seed = requireOptionValue(arguments_, index, "--seed");
      index += 1;
      continue;
    }
    if (argument === "--question-type") {
      questionType = requireOptionValue(arguments_, index, "--question-type");
      index += 1;
      continue;
    }
    if (argument === "--split") {
      split = requireOptionValue(arguments_, index, "--split");
      index += 1;
      continue;
    }
    if (argument === "--tag") {
      tags.push(requireOptionValue(arguments_, index, "--tag"));
      index += 1;
      continue;
    }
    throw new Error(`Unknown evaluation generation option: ${argument}`);
  }

  if (
    assumedPairedNdcgDeltaStandardDeviation === null ||
    domain === null ||
    language === null ||
    minimumDetectableNdcgDelta === null ||
    outputPath === null ||
    questionType === null ||
    split === null
  ) {
    throw new Error(readEvaluationGenerationUsage());
  }
  const statisticalDesign = createEvaluationStatisticalDesign(
    minimumDetectableNdcgDelta,
    assumedPairedNdcgDeltaStandardDeviation,
  );
  const plannedCaseCount = caseCount ?? statisticalDesign.requiredCaseCount;
  if (plannedCaseCount < statisticalDesign.requiredCaseCount) {
    throw new Error(
      `--cases must be at least ${statisticalDesign.requiredCaseCount} for the declared minimum detectable NDCG delta.`,
    );
  }
  const defaultTags = tags.length === 0 && !explicitAll &&
      documentIds.length === 0 && sourceFiles.length === 0
    ? [domain]
    : tags;
  const scope = buildQueryScope(
    explicitAll,
    documentIds,
    sourceFiles,
    defaultTags,
  );
  return {
    atK,
    caseCount: plannedCaseCount,
    domain,
    enrich,
    language,
    name: "generate-evaluation",
    outputPath,
    overwrite,
    scope,
    seed,
    split,
    statisticalDesign,
    questionType,
  };
}

function readIntegerOption(
  arguments_: string[],
  optionIndex: number,
  optionName: string,
): number {
  const value = requireOptionValue(arguments_, optionIndex, optionName);
  if (!/^\d+$/.test(value)) {
    throw new Error(`${optionName} requires a positive integer.`);
  }
  return Number(value);
}

function readUnitIntervalOption(
  arguments_: string[],
  optionIndex: number,
  optionName: string,
): number {
  const value = requireOptionValue(arguments_, optionIndex, optionName);
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue) || numberValue <= 0 || numberValue > 1) {
    throw new Error(`${optionName} must be greater than 0 and at most 1.`);
  }
  return numberValue;
}

function readClosedUnitIntervalOption(
  arguments_: string[],
  optionIndex: number,
  optionName: string,
): number {
  const value = requireOptionValue(arguments_, optionIndex, optionName);
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue) || numberValue < 0 || numberValue > 1) {
    throw new Error(`${optionName} must be between 0 and 1.`);
  }
  return numberValue;
}

function readEvaluationGenerationUsage(): string {
  return "Usage: citeloom evaluate --generate --domain <name> --language <bcp47> --question-type <type> --split <development|holdout> --minimum-detectable-ndcg-delta <0..1> --assumed-paired-ndcg-stddev <0..1> --output <dataset.json> [--cases <count>] [--at-k <count>] [--seed <value>] [--enrich] [--force] [--all | --document <id> | --file <path> | --tag <tag>]";
}

function requireOptionValue(
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
    throw new Error("Choose only one query scope: --all, --document, --file, or --tag.");
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
