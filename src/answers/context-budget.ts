import type { TextPart } from "ai";

import type { RetrievedElement } from "../retrieval/document-retrieval.js";
import type { LanguageModelCapabilities } from "../inference/model-capabilities.js";

export interface AnswerBudgetConfiguration {
  maximumOutputTokens: number;
  minimumOutputTokens: number;
  providerSafetyMarginTokens: number;
}

export type BudgetedAnswerContent = readonly TextPart[];

export interface AnswerSourceContentOptions {
  expanded: BudgetedAnswerContent | null;
  primary: BudgetedAnswerContent;
}

export interface AnswerContextDecision {
  evidenceSha256: string;
  elementId: string;
  reason: "capacity" | "included";
  retrievalRank: number;
  retrievalWindowId: string;
  tokenUpperBound: number;
}

export interface AnswerRequestBudget {
  availableInputTokens: number;
  contextCapacityTokens: number;
  decisions: AnswerContextDecision[];
  expandedRetrievalWindowIds: string[];
  inputTokenUpperBound: number;
  outputBudgetTokens: number;
  providerSafetyMarginTokens: number;
  selected: RetrievedElement[];
}

export class AnswerCapacityError extends Error {
  public constructor(
    message: string,
    public readonly failureReason:
      | "minimum-structured-output"
      | "no-complete-evidence-window",
    public readonly contextCapacityTokens: number,
    public readonly providerSafetyMarginTokens: number,
  ) {
    super(message);
    this.name = "AnswerCapacityError";
  }
}

export function planAnswerRequest(
  capabilities: LanguageModelCapabilities,
  configuration: AnswerBudgetConfiguration,
  fixedContent: BudgetedAnswerContent,
  sourceContents: readonly AnswerSourceContentOptions[],
  retrieved: readonly RetrievedElement[],
): AnswerRequestBudget {
  validateConfiguration(configuration);
  if (sourceContents.length !== retrieved.length) {
    throw new Error("Answer source content must correspond to retrieved evidence.");
  }
  const fixedInputTokens = countContentTokens(capabilities, fixedContent);
  const capacityAfterSafety = capabilities.contextCapacityTokens
    - configuration.providerSafetyMarginTokens;
  const capacityAfterFixedInput = capacityAfterSafety - fixedInputTokens;
  if (capacityAfterFixedInput < configuration.minimumOutputTokens) {
    throw new AnswerCapacityError(
      "The answer model context cannot fit the prompt and minimum structured response.",
      "minimum-structured-output",
      capabilities.contextCapacityTokens,
      configuration.providerSafetyMarginTokens,
    );
  }
  const availableInputTokens = capacityAfterSafety
    - configuration.minimumOutputTokens;
  let inputTokenUpperBound = fixedInputTokens;
  const decisions: AnswerContextDecision[] = [];
  const selected: RetrievedElement[] = [];
  const selectedSourceIndexes: number[] = [];
  for (let index = 0; index < retrieved.length; index += 1) {
    const item = retrieved[index];
    const sourceContent = sourceContents[index];
    if (item === undefined || sourceContent === undefined) {
      throw new Error(`Missing answer source at retrieval rank ${index + 1}.`);
    }
    const tokenUpperBound = countContentTokens(
      capabilities,
      sourceContent.primary,
    );
    const fits = inputTokenUpperBound + tokenUpperBound <= availableInputTokens;
    decisions.push({
      evidenceSha256: item.provenance.evidenceSha256,
      elementId: item.element.id,
      reason: fits ? "included" : "capacity",
      retrievalRank: index + 1,
      retrievalWindowId: item.provenance.retrievalWindowId,
      tokenUpperBound,
    });
    if (!fits) {
      continue;
    }
    selected.push(item);
    selectedSourceIndexes.push(index);
    inputTokenUpperBound += tokenUpperBound;
  }
  if (retrieved.length > 0 && selected.length === 0) {
    throw new AnswerCapacityError(
      "The answer model context cannot fit any complete retrieved evidence window.",
      "no-complete-evidence-window",
      capabilities.contextCapacityTokens,
      configuration.providerSafetyMarginTokens,
    );
  }
  const expandedRetrievalWindowIds: string[] = [];
  for (const sourceIndex of selectedSourceIndexes) {
    const item = retrieved[sourceIndex];
    const sourceContent = sourceContents[sourceIndex];
    if (
      item === undefined
      || sourceContent === undefined
      || sourceContent.expanded === null
    ) {
      continue;
    }
    const primaryTokens = countContentTokens(
      capabilities,
      sourceContent.primary,
    );
    const expandedTokens = countContentTokens(
      capabilities,
      sourceContent.expanded,
    );
    const additionalTokens = expandedTokens - primaryTokens;
    if (
      additionalTokens <= 0
      || inputTokenUpperBound + additionalTokens > availableInputTokens
    ) {
      continue;
    }
    expandedRetrievalWindowIds.push(item.provenance.retrievalWindowId);
    inputTokenUpperBound += additionalTokens;
  }
  const remainingCapacity = capacityAfterSafety - inputTokenUpperBound;
  const outputBudgetTokens = Math.min(
    configuration.maximumOutputTokens,
    remainingCapacity,
  );
  return {
    availableInputTokens,
    contextCapacityTokens: capabilities.contextCapacityTokens,
    decisions,
    expandedRetrievalWindowIds,
    inputTokenUpperBound,
    outputBudgetTokens,
    providerSafetyMarginTokens: configuration.providerSafetyMarginTokens,
    selected,
  };
}

function countContentTokens(
  capabilities: LanguageModelCapabilities,
  content: BudgetedAnswerContent,
): number {
  let tokens = 0;
  for (const part of content) {
    tokens += countPartTokens(capabilities, part);
  }
  return tokens;
}

function countPartTokens(
  capabilities: LanguageModelCapabilities,
  part: TextPart,
): number {
  return capabilities.tokenCounter.countTextTokens(part.text);
}

function validateConfiguration(configuration: AnswerBudgetConfiguration): void {
  const values = [
    configuration.maximumOutputTokens,
    configuration.minimumOutputTokens,
  ];
  if (values.some((value) => !Number.isInteger(value) || value < 1)) {
    throw new Error("Answer budget configuration values must be positive integers.");
  }
  if (
    !Number.isInteger(configuration.providerSafetyMarginTokens)
    || configuration.providerSafetyMarginTokens < 0
  ) {
    throw new Error("Provider safety margin must be a nonnegative integer.");
  }
  if (configuration.maximumOutputTokens < configuration.minimumOutputTokens) {
    throw new Error("Maximum answer output must be at least the minimum output reserve.");
  }
}
