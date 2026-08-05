import { createHash } from "node:crypto";

import {
  NoObjectGeneratedError,
  streamText,
  type TextPart,
  type UserContent,
} from "ai";
import { z } from "zod";

import {
  createAnswerModelResponseSchema,
  createEvidenceReferences,
  decodeAnswerModelResponse,
  AnswerDraftDecodeError,
  type AnswerDraft,
  type AnswerDraftValidationIssue,
  type EvidenceReference,
} from "./draft.js";
import {
  createAnswerContentCitationCatalog,
  decodePartialAnswerContentSnapshot,
  type AnswerContentSnapshot,
} from "./content-snapshot.js";
import { createAskSystemPrompt } from "./system-prompt.js";
import type { TaskScheduler } from "../shared/concurrency.js";
import type {
  MatchedDocument,
  RetrievedElement,
} from "../retrieval/document-retrieval.js";
import { buildMatchedDocuments } from "../retrieval/document-retrieval.js";
import type { InferenceModelRegistry } from "../inference/registry.js";
import { createProcessingQuestion } from "../domain/question.js";
import {
  createInferenceRequestSignal,
  throwInferenceRequestFailure,
} from "../inference/request.js";
import {
  createInferenceTelemetryOptions,
} from "../inference/shared.js";
import { createStructuredOutput } from "../inference/structured-output.js";
import {
  AnswerCapacityError,
  planAnswerRequest,
  type AnswerSourceContentOptions,
  type AnswerRequestBudget,
} from "./context-budget.js";
import {
  compileAnswerDraft,
  createUncitedAnswerDocument,
  isPublishedAnsweredDocument,
  readPublishedAnswerClaims,
  renderPublishedAnswerMarkdown,
  type PublishedAnswerCitation,
  type PublishedAnswerDocument,
} from "./published.js";
import type {
  AnswerClaim,
  ClaimVerificationResult,
} from "../research/types.js";
import {
  createTelemetryStageResult,
  noopRunTelemetry,
  readTelemetryFailureOutcome,
  type AnswerGenerationEvidenceTelemetry,
  type AnswerResponseDiagnosticTelemetry,
  type AnswerResponseFailureCategory,
  type RunTelemetry,
} from "../observability/run.js";
import type { AppliedGenerationSettings } from "../inference/generation-settings.js";
import type { LanguageModelCapabilities } from "../inference/model-capabilities.js";

export type AnswerSource = PublishedAnswerCitation;

export interface AnswerResult {
  answer: string;
  answerDocument: PublishedAnswerDocument;
  matchedDocuments: MatchedDocument[];
  runDetails: AnswerRunDetails | null;
  sources: AnswerSource[];
}

export interface AnswerRunDetails {
  durationMs: number;
  finishReason: string | null;
  inputTokens: number | null;
  modelId: string;
  outputTokens: number | null;
  runId: string | null;
}

type GeneratedAnswerFallbackReason = "model-uncited";

const ANSWER_OUTPUT_DESCRIPTION = "A private CiteLoom response containing a direct answer, cited findings, and exact request-local evidence references.";
const ANSWER_OUTPUT_NAME = "answer_draft";
const ignoreAnswerContent = (_content: AnswerContentSnapshot): void => undefined;
const ANSWER_CORRECTION_BUDGET_INSTRUCTION = [
  "CORRECTION REQUEST:",
  "Preserve supported answer content while fixing the response contract.",
  "Use the same question and retrieved evidence.",
  "Return only one object matching the required output schema and allowed evidence references.",
].join("\n");

export interface AnsweredGeneratedAnswerResult extends AnswerResult {
  claims: AnswerClaim[];
  outcome: "answered";
  runDetails: AnswerRunDetails;
}

export interface FallbackGeneratedAnswerResult extends AnswerResult {
  claims: [];
  outcome: "fallback";
  reason: GeneratedAnswerFallbackReason;
  runDetails: AnswerRunDetails;
  sources: [];
}

export interface EmptyRetrievalAnswerResult extends AnswerResult {
  claims: [];
  matchedDocuments: [];
  outcome: "fallback";
  reason: "empty-retrieval";
  runDetails: null;
  sources: [];
}

export type GeneratedAnswerResult =
  | AnsweredGeneratedAnswerResult
  | EmptyRetrievalAnswerResult
  | FallbackGeneratedAnswerResult;

export function attachAdvisoryClaimChecks(
  result: AnsweredGeneratedAnswerResult,
  checks: readonly ClaimVerificationResult[],
): AnsweredGeneratedAnswerResult {
  return {
    ...result,
    claims: [...checks],
  };
}

interface AnswerCompletion {
  finishReason: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
}

interface AdaptiveAnswerContext {
  contextCapacityTokens: number;
  inputTokenUpperBound: number;
  modelDigest: string;
  modelFormat: "gguf";
}

interface InvalidAnswerResponse {
  failureCategory: AnswerResponseFailureCategory;
  issues: AnswerDraftValidationIssue[];
  rejectedResponse: string | null;
  responseSha256: string | null;
  unknownReferenceCount: number;
}

type DecodedAnswerResponse =
  | {
    draft: AnswerDraft;
    failure: null;
    responseSha256: string;
    verificationStatementIndexes: readonly number[] | null;
  }
  | {
    draft: null;
    failure: InvalidAnswerResponse;
    responseSha256: string | null;
  };

type AnswerMetricOperation = "answer" | "answer-stream";
type AnswerContentPart = TextPart;

interface PreparedAnswerRequest {
  content: UserContent;
  evidence: AnswerGenerationEvidenceTelemetry[];
}

interface PreparedAnswerSourceContent extends AnswerSourceContentOptions {
  requestEvidence: AnswerGenerationEvidenceTelemetry;
}

interface ExpandedAnswerSource {
  mode: "adjacent-retrieval-windows" | "parent-source-element";
  retrievalWindowIds: string[];
  text: string;
}

const passiveAbortSignal = new AbortController().signal;

export class InvalidAnswerDraftError extends Error {
  public constructor() {
    super("The answer model returned an invalid response after one correction request.");
    this.name = "InvalidAnswerDraftError";
  }
}

export class AnswerOutputTokenLimitError extends Error {
  public constructor(public readonly outputTokenLimit: number) {
    super(
      `Answer generation reached the ${outputTokenLimit}-token output limit before producing a valid structured response.`,
    );
    this.name = "AnswerOutputTokenLimitError";
  }
}

export class UnexpectedAnswerFinishReasonError extends Error {
  public constructor(finishReason: string | null) {
    super(`Answer generation ended with provider finish reason ${finishReason ?? "unknown"}.`);
    this.name = "UnexpectedAnswerFinishReasonError";
  }
}

export interface AnswerConversationTurn {
  assistant: string;
  user: string;
}

export interface AnswerUserPromptFrame {
  afterSources: string | null;
  beforeSources: string;
  correctionPlacement: "after-sources" | "before-sources";
}

export interface AnswerGenerationPrompt {
  buildUserPromptFrame(
    question: string,
    conversationTurns: readonly AnswerConversationTurn[],
  ): AnswerUserPromptFrame;
  createEvidenceReferences(
    retrieved: readonly RetrievedElement[],
  ): EvidenceReference[];
  responseContract: AnswerResponseContract;
  systemPrompt: string;
}

export interface AnswerGenerationOptions {
  conversationTurns?: readonly AnswerConversationTurn[];
  prompt?: AnswerGenerationPrompt;
  receiveAnswerContent?: (content: AnswerContentSnapshot) => void;
}

export interface AnswerResponseContract {
  createSchema(
    allowedEvidenceRefs: readonly EvidenceReference[],
  ): z.ZodType<unknown>;
  decode(
    value: unknown,
    allowedEvidenceRefs: readonly EvidenceReference[],
  ): AnswerResponseDecodeResult;
  description: string;
  name: string;
}

export interface AnswerResponseDecodeResult {
  draft: AnswerDraft;
  verificationStatementIndexes: readonly number[] | null;
}

const defaultAnswerResponse: AnswerResponseContract = {
  createSchema: createAnswerModelResponseSchema,
  decode: decodeDefaultAnswerModelResponse,
  description: ANSWER_OUTPUT_DESCRIPTION,
  name: ANSWER_OUTPUT_NAME,
};

function decodeDefaultAnswerModelResponse(
  value: unknown,
  allowedEvidenceRefs: readonly EvidenceReference[],
): AnswerResponseDecodeResult {
  const draft = decodeAnswerModelResponse(
    value,
    allowedEvidenceRefs,
  );
  return {
    draft,
    verificationStatementIndexes: readKeyPointStatementIndexes(draft),
  };
}

function readKeyPointStatementIndexes(draft: AnswerDraft): number[] {
  if (draft.status === "uncited") {
    return [];
  }
  const indexes: number[] = [];
  for (let index = 0; index < draft.statements.length; index += 1) {
    if (draft.statements[index]?.section === "key-points") {
      indexes.push(index);
    }
  }
  return indexes;
}

const defaultAnswerGenerationPrompt: AnswerGenerationPrompt = {
  buildUserPromptFrame: buildAnswerUserPromptFrame,
  createEvidenceReferences: createDefaultEvidenceReferences,
  responseContract: defaultAnswerResponse,
  systemPrompt: createAnswerSystemPrompt(),
};

function createDefaultEvidenceReferences(
  retrieved: readonly RetrievedElement[],
): EvidenceReference[] {
  return createEvidenceReferences(retrieved.length);
}

export async function answerQuestion(
  models: InferenceModelRegistry,
  question: string,
  retrieved: RetrievedElement[],
  scheduler: TaskScheduler,
  generationSettings: AppliedGenerationSettings,
  runTelemetry: RunTelemetry = noopRunTelemetry,
  conversationTurns: readonly AnswerConversationTurn[] = [],
  prompt: AnswerGenerationPrompt = defaultAnswerGenerationPrompt,
): Promise<GeneratedAnswerResult> {
  return generateAnswer(
    models,
    question,
    retrieved,
    scheduler,
    passiveAbortSignal,
    generationSettings,
    "answer",
    runTelemetry,
    conversationTurns,
    prompt,
    ignoreAnswerContent,
  );
}

export async function streamAnswerQuestion(
  models: InferenceModelRegistry,
  question: string,
  retrieved: RetrievedElement[],
  scheduler: TaskScheduler,
  abortSignal: AbortSignal,
  generationSettings: AppliedGenerationSettings,
  runTelemetry: RunTelemetry = noopRunTelemetry,
  options: AnswerGenerationOptions = {},
): Promise<GeneratedAnswerResult> {
  const conversationTurns = options.conversationTurns ?? [];
  const prompt = options.prompt ?? defaultAnswerGenerationPrompt;
  const receiveAnswerContent = options.receiveAnswerContent ?? ignoreAnswerContent;
  return generateAnswer(
    models,
    question,
    retrieved,
    scheduler,
    abortSignal,
    generationSettings,
    "answer-stream",
    runTelemetry,
    conversationTurns,
    prompt,
    receiveAnswerContent,
  );
}

async function generateAnswer(
  models: InferenceModelRegistry,
  question: string,
  retrieved: RetrievedElement[],
  scheduler: TaskScheduler,
  abortSignal: AbortSignal,
  generationSettings: AppliedGenerationSettings,
  metricOperation: AnswerMetricOperation,
  runTelemetry: RunTelemetry,
  conversationTurns: readonly AnswerConversationTurn[],
  prompt: AnswerGenerationPrompt,
  receiveAnswerContent: (content: AnswerContentSnapshot) => void,
): Promise<GeneratedAnswerResult> {
  if (retrieved.length === 0) {
    return createEmptyRetrievalAnswer();
  }
  const processingQuestion = createProcessingQuestion(question);
  const startedAt = performance.now();
  const stage = runTelemetry.startStage({
    model: {
      modelId: models.answer.modelId,
      provider: models.answer.provider,
    },
    name: "answer",
    retrievalMode: null,
  });
  const finishMetric = models.metrics.start(
    metricOperation,
    models.answer.provider,
    models.answer.modelId,
  );
  let metricFinished = false;
  const finishMetricOnce = (value: AnswerCompletion): void => {
    if (metricFinished) {
      return;
    }
    metricFinished = true;
    finishMetric(value);
  };
  let completion: AnswerCompletion | null = null;
  const recordCompletion = (value: AnswerCompletion): void => {
    completion = value;
    finishMetricOnce(value);
  };
  let selectedRetrieved: RetrievedElement[] = [];
  try {
    const runGeneration = async (requestSignal: AbortSignal) => {
      const capabilities = await models.readAnswerCapabilities(requestSignal);
      const availableEvidenceRefs = prompt.createEvidenceReferences(retrieved);
      const promptFrame = prompt.buildUserPromptFrame(
        processingQuestion,
        conversationTurns,
      );
      const fixedContent = buildAnswerFixedContent(promptFrame);
      const outputSchemaText = serializeAnswerOutputSchema(
        availableEvidenceRefs,
        prompt.responseContract,
      );
      const sourceContents = buildAnswerSourceContents(
        retrieved,
        availableEvidenceRefs,
      );
      const budget = planAnswerRequest(
        capabilities,
        models.answerBudget,
        [
          { text: prompt.systemPrompt, type: "text" },
          { text: outputSchemaText, type: "text" },
          ...fixedContent,
          { text: ANSWER_CORRECTION_BUDGET_INSTRUCTION, type: "text" },
        ],
        sourceContents,
        retrieved,
      );
      runTelemetry.recordAnswerBudget({
        availableInputTokens: budget.availableInputTokens,
        contextCapacityTokens: budget.contextCapacityTokens,
        failureReason: null,
        inputTokenUpperBound: budget.inputTokenUpperBound,
        outputBudgetTokens: budget.outputBudgetTokens,
        providerSafetyMarginTokens: budget.providerSafetyMarginTokens,
        requests: [],
        responseDiagnostics: [],
        windows: budget.decisions,
      });
      const adaptiveContext = createAdaptiveAnswerContext(
        capabilities,
        budget,
      );
      selectedRetrieved = budget.selected;
      const allowedEvidenceRefs = prompt.createEvidenceReferences(
        selectedRetrieved,
      );
      const expandedRetrievalWindowIds = new Set(
        budget.expandedRetrievalWindowIds,
      );
      const answerRequest = prepareAnswerRequest(
        processingQuestion,
        selectedRetrieved,
        allowedEvidenceRefs,
        expandedRetrievalWindowIds,
        conversationTurns,
        prompt,
        null,
      );
      recordAnswerRequest(runTelemetry, "initial", answerRequest.evidence);
      let initialResponse: DecodedAnswerResponse;
      let initialCompletion: AnswerCompletion;
      try {
        const result = await requestAnswerDraft(
          models,
          answerRequest.content,
          selectedRetrieved,
          allowedEvidenceRefs,
          requestSignal,
          generationSettings,
          recordCompletion,
          budget,
          adaptiveContext,
          prompt.systemPrompt,
          prompt.responseContract,
          receiveAnswerContent,
        );
        requestSignal.throwIfAborted();
        initialCompletion = {
          finishReason: result.finishReason,
          inputTokens: result.usage.inputTokens ?? null,
          outputTokens: result.usage.outputTokens ?? null,
        };
        if (!isExpectedAnswerFinishReason(initialCompletion.finishReason)) {
          throw new UnexpectedAnswerFinishReasonError(
            initialCompletion.finishReason,
          );
        }
        initialResponse = decodeAnswerResponse(
          result.output,
          allowedEvidenceRefs,
          prompt.responseContract,
        );
      } catch (error: unknown) {
        if (!NoObjectGeneratedError.isInstance(error)) {
          throw error;
        }
        initialCompletion = readAnswerCompletion(error, completion);
        finishMetricOnce(initialCompletion);
        if (initialCompletion.finishReason === "length") {
          throw new AnswerOutputTokenLimitError(budget.outputBudgetTokens);
        }
        if (!isExpectedAnswerFinishReason(initialCompletion.finishReason)) {
          throw new UnexpectedAnswerFinishReasonError(
            initialCompletion.finishReason,
          );
        }
        initialResponse = {
          draft: null,
          failure: createInvalidJsonResponse(error),
          responseSha256: hashResponse(error.text ?? null),
        };
      }
      const runDetails = createAnswerRunDetails(
        models,
        startedAt,
        initialCompletion,
        runTelemetry.runId,
      );
      if (initialResponse.draft !== null) {
        recordAnswerResponseDiagnostic(
          runTelemetry,
          models,
          "initial",
          initialResponse,
          "not-needed",
        );
        return {
          completion: initialCompletion,
          result: finalizeAnswerDraft(
            initialResponse.draft,
            selectedRetrieved,
            allowedEvidenceRefs,
            runDetails,
            initialResponse.verificationStatementIndexes,
          ),
        };
      }
      let correctedResponse: DecodedAnswerResponse;
      try {
        correctedResponse = await correctAnswerDraft(
          models,
          processingQuestion,
          selectedRetrieved,
          allowedEvidenceRefs,
          initialResponse.failure,
          requestSignal,
          generationSettings,
          budget,
          adaptiveContext,
          runTelemetry,
          conversationTurns,
          prompt,
          receiveAnswerContent,
        );
      } catch (error: unknown) {
        recordAnswerResponseDiagnostic(
          runTelemetry,
          models,
          "initial",
          initialResponse,
          "transport-error",
        );
        throw error;
      }
      const correctionOutcome = correctedResponse.draft === null
        ? "invalid"
        : "succeeded";
      recordAnswerResponseDiagnostic(
        runTelemetry,
        models,
        "initial",
        initialResponse,
        correctionOutcome,
      );
      recordAnswerResponseDiagnostic(
        runTelemetry,
        models,
        "correction",
        correctedResponse,
        correctionOutcome,
      );
      if (correctedResponse.draft === null) {
        throw new InvalidAnswerDraftError();
      }
      return {
        completion: initialCompletion,
        result: finalizeAnswerDraft(
          correctedResponse.draft,
          selectedRetrieved,
          allowedEvidenceRefs,
          runDetails,
          correctedResponse.verificationStatementIndexes,
        ),
      };
    };
    const generated = await scheduler.run(
      runGeneration,
      abortSignal,
      stage.timingObserver,
    );
    await finishAnswerStage(
      stage,
      generated.result,
      selectedRetrieved.length,
      generated.completion,
    );
    return generated.result;
  } catch (error: unknown) {
    if (error instanceof AnswerCapacityError) {
      runTelemetry.recordAnswerBudget({
        availableInputTokens: null,
        contextCapacityTokens: error.contextCapacityTokens,
        failureReason: error.failureReason,
        inputTokenUpperBound: null,
        outputBudgetTokens: null,
        providerSafetyMarginTokens: error.providerSafetyMarginTokens,
        requests: [],
        responseDiagnostics: [],
        windows: [],
      });
    }
    if (abortSignal.aborted) {
      finishMetricOnce({
        finishReason: "aborted",
        inputTokens: null,
        outputTokens: null,
      });
      await stage.finish(createTelemetryStageResult(
        readTelemetryFailureOutcome(abortSignal),
        { inputCount: selectedRetrieved.length },
      ));
      throw error;
    }
    if (
      error instanceof AnswerOutputTokenLimitError
      || error instanceof InvalidAnswerDraftError
    ) {
      await stage.finish(createTelemetryStageResult(
        "error",
        { inputCount: selectedRetrieved.length },
      ));
      throw error;
    }
    finishMetricOnce({
      finishReason: "error",
      inputTokens: null,
      outputTokens: null,
    });
    await stage.finish(createTelemetryStageResult(
      readTelemetryFailureOutcome(abortSignal),
      { inputCount: selectedRetrieved.length },
    ));
    throw error;
  }
}

async function correctAnswerDraft(
  models: InferenceModelRegistry,
  question: string,
  retrieved: RetrievedElement[],
  allowedEvidenceRefs: readonly EvidenceReference[],
  initialFailure: InvalidAnswerResponse,
  abortSignal: AbortSignal,
  generationSettings: AppliedGenerationSettings,
  budget: AnswerRequestBudget,
  adaptiveContext: AdaptiveAnswerContext | null,
  runTelemetry: RunTelemetry,
  conversationTurns: readonly AnswerConversationTurn[],
  prompt: AnswerGenerationPrompt,
  receiveAnswerContent: (content: AnswerContentSnapshot) => void,
): Promise<DecodedAnswerResponse> {
  abortSignal.throwIfAborted();
  const correction = buildAnswerCorrectionInstruction(
    initialFailure,
    allowedEvidenceRefs,
  );
  const answerRequest = prepareAnswerRequest(
    question,
    retrieved,
    allowedEvidenceRefs,
    new Set(budget.expandedRetrievalWindowIds),
    conversationTurns,
    prompt,
    correction,
  );
  const runGeneration = (requestSignal: AbortSignal) => {
    recordAnswerRequest(runTelemetry, "correction", answerRequest.evidence);
    return requestAnswerDraft(
      models,
      answerRequest.content,
      retrieved,
      allowedEvidenceRefs,
      requestSignal,
      generationSettings,
      () => undefined,
      budget,
      adaptiveContext,
      prompt.systemPrompt,
      prompt.responseContract,
      receiveAnswerContent,
    );
  };
  let result: Awaited<ReturnType<typeof requestAnswerDraft>>;
  try {
    result = await runGeneration(abortSignal);
  } catch (error: unknown) {
    if (NoObjectGeneratedError.isInstance(error)) {
      const completion = readAnswerCompletion(error, null);
      if (completion.finishReason === "length") {
        throw new AnswerOutputTokenLimitError(budget.outputBudgetTokens);
      }
      if (isExpectedAnswerFinishReason(completion.finishReason)) {
        return {
          draft: null,
          failure: createInvalidJsonResponse(error),
          responseSha256: hashResponse(error.text ?? null),
        };
      }
      throw new UnexpectedAnswerFinishReasonError(completion.finishReason);
    }
    throw error;
  }
  if (!isExpectedAnswerFinishReason(result.finishReason)) {
    throw new UnexpectedAnswerFinishReasonError(result.finishReason);
  }
  return decodeAnswerResponse(
    result.output,
    allowedEvidenceRefs,
    prompt.responseContract,
  );
}

function decodeAnswerResponse(
  value: unknown,
  allowedEvidenceRefs: readonly EvidenceReference[],
  responseContract: AnswerResponseContract,
): DecodedAnswerResponse {
  const rejectedResponse = serializeResponse(value);
  const responseSha256 = hashResponse(rejectedResponse);
  if (responseSha256 === null) {
    throw new Error("The answer provider returned an unserializable response.");
  }
  try {
    const decoded = responseContract.decode(
      value,
      allowedEvidenceRefs,
    );
    return {
      draft: decoded.draft,
      failure: null,
      responseSha256,
      verificationStatementIndexes:
        decoded.verificationStatementIndexes,
    };
  } catch (error: unknown) {
    if (!(error instanceof AnswerDraftDecodeError)) {
      throw error;
    }
    return {
      draft: null,
      failure: {
        failureCategory: error.failureCategory,
        issues: error.issues,
        rejectedResponse,
        responseSha256,
        unknownReferenceCount: error.unknownReferenceCount,
      },
      responseSha256,
    };
  }
}

function createInvalidJsonResponse(
  error: NoObjectGeneratedError,
): InvalidAnswerResponse {
  const rejectedResponse = error.text ?? null;
  return {
    failureCategory: "invalid-json",
    issues: [{
      message: "must be valid JSON",
      path: "$",
    }],
    rejectedResponse,
    responseSha256: hashResponse(rejectedResponse),
    unknownReferenceCount: 0,
  };
}

function recordAnswerResponseDiagnostic(
  runTelemetry: RunTelemetry,
  models: InferenceModelRegistry,
  phase: AnswerResponseDiagnosticTelemetry["phase"],
  response: DecodedAnswerResponse,
  correctionOutcome: AnswerResponseDiagnosticTelemetry["correctionOutcome"],
): void {
  const failure = response.failure;
  const invalidFieldPaths: string[] = [];
  if (failure !== null) {
    for (const issue of failure.issues) {
      if (!invalidFieldPaths.includes(issue.path)) {
        invalidFieldPaths.push(issue.path);
      }
    }
  }
  runTelemetry.recordAnswerResponseDiagnostic({
    correctionOutcome,
    failureCategory: failure?.failureCategory ?? null,
    invalidFieldPaths,
    modelId: models.answer.modelId,
    phase,
    provider: models.answer.provider,
    responseSha256: response.responseSha256,
    unknownReferenceCount: failure?.unknownReferenceCount ?? 0,
  });
}

function serializeResponse(value: unknown): string | null {
  const serialized = JSON.stringify(value);
  return serialized ?? null;
}

function hashResponse(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  return createHash("sha256").update(value).digest("hex");
}

function recordAnswerRequest(
  runTelemetry: RunTelemetry,
  phase: "correction" | "initial",
  evidence: readonly AnswerGenerationEvidenceTelemetry[],
): void {
  runTelemetry.recordAnswerRequest({ evidence: [...evidence], phase });
}

async function requestAnswerDraft(
  models: InferenceModelRegistry,
  content: UserContent,
  retrieved: readonly RetrievedElement[],
  allowedEvidenceRefs: readonly EvidenceReference[],
  abortSignal: AbortSignal,
  generationSettings: AppliedGenerationSettings,
  recordCompletion: (completion: AnswerCompletion) => void,
  budget: AnswerRequestBudget,
  adaptiveContext: AdaptiveAnswerContext | null,
  systemPrompt: string,
  responseContract: AnswerResponseContract,
  receiveAnswerContent: (content: AnswerContentSnapshot) => void,
) {
  const citationCatalog = createAnswerContentCitationCatalog(
    retrieved,
    allowedEvidenceRefs,
  );
  const output = createAnswerModelOutput(
    allowedEvidenceRefs,
    responseContract,
  );
  const telemetry = createInferenceTelemetryOptions(models, "citeloom.answer");
  const timeoutMs = models.timeouts.answerMs;
  const signals = createInferenceRequestSignal(timeoutMs, abortSignal);
  try {
    const samplingSettings = buildAnswerSamplingSettings(generationSettings);
    let streamFailure: unknown = null;
    const providerOptions = adaptiveContext !== null
      ? {
        citeloomAdaptiveContext: {
          contextCapacityTokens: adaptiveContext.contextCapacityTokens,
          inputTokenUpperBound: adaptiveContext.inputTokenUpperBound,
          modelDigest: adaptiveContext.modelDigest,
          modelFormat: adaptiveContext.modelFormat,
        },
      }
      : null;
    const result = streamText({
      ...samplingSettings,
      ...(providerOptions === null ? {} : { providerOptions }),
      abortSignal: signals.requestSignal,
      maxRetries: 1,
      maxOutputTokens: budget.outputBudgetTokens,
      messages: [{ content, role: "user" }],
      model: models.answer,
      onError: ({ error }) => {
        streamFailure = error;
      },
      onFinish: (event) => {
        recordCompletion({
          finishReason: event.finishReason,
          inputTokens: event.usage.inputTokens ?? null,
          outputTokens: event.usage.outputTokens ?? null,
        });
      },
      output,
      system: systemPrompt,
      telemetry,
    });
    for await (const partialOutput of result.partialOutputStream) {
      const preview = decodePartialAnswerContentSnapshot(
        partialOutput,
        citationCatalog,
      );
      if (preview !== null) {
        receiveAnswerContent(preview);
      }
    }
    if (streamFailure !== null) {
      throw streamFailure;
    }
    return {
      finishReason: await result.finishReason,
      output: await result.output,
      usage: await result.usage,
    };
  } catch (error: unknown) {
    throwInferenceRequestFailure(
      error,
      "answer",
      timeoutMs,
      signals.timeoutSignal,
      abortSignal,
    );
  }
}

function createAdaptiveAnswerContext(
  capabilities: LanguageModelCapabilities,
  budget: AnswerRequestBudget,
): AdaptiveAnswerContext | null {
  if (capabilities.source !== "ollama-model") {
    return null;
  }
  return {
    contextCapacityTokens: capabilities.contextCapacityTokens,
    inputTokenUpperBound: budget.inputTokenUpperBound,
    modelDigest: capabilities.modelDigest,
    modelFormat: capabilities.modelFormat,
  };
}

export function createAnswerModelOutput(
  allowedEvidenceRefs: readonly EvidenceReference[],
  responseContract: AnswerResponseContract = defaultAnswerResponse,
): ReturnType<typeof createStructuredOutput<unknown>> {
  const responseSchema = responseContract.createSchema(allowedEvidenceRefs);
  return createStructuredOutput({
    description: responseContract.description,
    name: responseContract.name,
    schema: responseSchema,
    validation: "provider-only",
  });
}

function buildAnswerSamplingSettings(settings: AppliedGenerationSettings): {
  seed?: number;
  temperature: number;
} {
  if (settings.seed === null) {
    return { temperature: settings.temperature };
  }
  return { seed: settings.seed, temperature: settings.temperature };
}

function isExpectedAnswerFinishReason(finishReason: string | null): boolean {
  return finishReason === "stop" || finishReason === "length";
}

export function buildAnswerContent(
  question: string,
  retrieved: RetrievedElement[],
  expandedRetrievalWindowIds: ReadonlySet<string> = new Set(),
  conversationTurns: readonly AnswerConversationTurn[] = [],
  prompt: AnswerGenerationPrompt = defaultAnswerGenerationPrompt,
): UserContent {
  const allowedEvidenceRefs = prompt.createEvidenceReferences(retrieved);
  const request = prepareAnswerRequest(
    question,
    retrieved,
    allowedEvidenceRefs,
    expandedRetrievalWindowIds,
    conversationTurns,
    prompt,
    null,
  );
  return request.content;
}

function prepareAnswerRequest(
  question: string,
  retrieved: RetrievedElement[],
  allowedEvidenceRefs: readonly EvidenceReference[],
  expandedRetrievalWindowIds: ReadonlySet<string>,
  conversationTurns: readonly AnswerConversationTurn[],
  prompt: AnswerGenerationPrompt,
  correction: string | null,
): PreparedAnswerRequest {
  const promptFrame = prompt.buildUserPromptFrame(
    question,
    conversationTurns,
  );
  const sourceContents = buildAnswerSourceContents(
    retrieved,
    allowedEvidenceRefs,
    expandedRetrievalWindowIds,
  );
  const evidence: AnswerGenerationEvidenceTelemetry[] = [];
  const sources: AnswerContentPart[] = [];
  for (const sourceContent of sourceContents) {
    sources.push(...sourceContent.primary);
    evidence.push(sourceContent.requestEvidence);
  }
  return {
    content: assembleAnswerContent(promptFrame, sources, correction),
    evidence,
  };
}

function buildAnswerCorrectionInstruction(
  failure: InvalidAnswerResponse,
  allowedEvidenceRefs: readonly EvidenceReference[],
): string {
  const lines = [
    "CORRECTION REQUEST:",
    "The previous response did not match the required answer contract.",
    "Preserve all supported answer content while fixing only the contract errors.",
    "Use the same question and the same retrieved evidence supplied below.",
    `The exact allowed evidence references are: ${allowedEvidenceRefs.join(", ")}.`,
    "",
    "Validation errors:",
  ];
  for (const issue of failure.issues) {
    lines.push(`- ${issue.path}: ${issue.message}`);
  }
  if (failure.rejectedResponse !== null) {
    lines.push(
      "",
      "Rejected response:",
      failure.rejectedResponse,
      "End rejected response.",
    );
  }
  lines.push(
    "",
    "Return only one object matching the required output schema.",
  );
  return lines.join("\n");
}

function buildAnswerUserPromptFrame(
  question: string,
  _conversationTurns: readonly AnswerConversationTurn[],
): AnswerUserPromptFrame {
  return {
    afterSources: [
      "</retrieved_sources>",
      "",
      "<current_question>",
      question,
      "</current_question>",
    ].join("\n"),
    beforeSources: [
      "USER_PROMPT",
      "---------",
      "<retrieved_sources>",
    ].join("\n"),
    correctionPlacement: "after-sources",
  };
}

function buildAnswerFixedContent(
  frame: AnswerUserPromptFrame,
): AnswerContentPart[] {
  const content: AnswerContentPart[] = [{
    text: frame.beforeSources,
    type: "text",
  }];
  if (frame.afterSources !== null) {
    content.push({
      text: frame.afterSources,
      type: "text",
    });
  }
  return content;
}

function assembleAnswerContent(
  frame: AnswerUserPromptFrame,
  sources: readonly AnswerContentPart[],
  correction: string | null,
): UserContent {
  const content: AnswerContentPart[] = [{
    text: frame.beforeSources,
    type: "text",
  }];
  if (
    correction !== null
    && frame.correctionPlacement === "before-sources"
  ) {
    content.push({ text: correction, type: "text" });
  }
  content.push(...sources);
  if (frame.afterSources !== null) {
    content.push({ text: frame.afterSources, type: "text" });
  }
  if (
    correction !== null
    && frame.correctionPlacement === "after-sources"
  ) {
    content.push({ text: correction, type: "text" });
  }
  return content;
}

function serializeAnswerOutputSchema(
  allowedEvidenceRefs: readonly EvidenceReference[],
  responseContract: AnswerResponseContract,
): string {
  return JSON.stringify({
    description: responseContract.description,
    name: responseContract.name,
    schema: z.toJSONSchema(
      responseContract.createSchema(allowedEvidenceRefs),
    ),
  });
}

function buildAnswerSourceContents(
  retrieved: readonly RetrievedElement[],
  allowedEvidenceRefs: readonly EvidenceReference[],
  expandedRetrievalWindowIds: ReadonlySet<string> = new Set(),
): PreparedAnswerSourceContent[] {
  if (allowedEvidenceRefs.length !== retrieved.length) {
    throw new Error(
      "Answer evidence references must correspond to retrieved evidence.",
    );
  }
  const sources: PreparedAnswerSourceContent[] = [];
  for (let index = 0; index < retrieved.length; index += 1) {
    const item = retrieved[index];
    const evidenceRef = allowedEvidenceRefs[index];
    if (item === undefined || evidenceRef === undefined) {
      throw new Error(`Missing retrieved element at index ${index}.`);
    }
    const label = createSourceLabel(evidenceRef, item.element);
    if (item.element.kind === "image") {
      const primaryText = `${label}\n${item.evidenceContent}`;
      const primary = [{
        text: primaryText,
        type: "text" as const,
      }];
      sources.push({
        expanded: null,
        primary,
        requestEvidence: buildAnswerRequestEvidence(
          item,
          primaryText,
          "exact-retrieval-window",
          [item.provenance.retrievalWindowId],
        ),
      });
      continue;
    }
    const primaryText = `${label}\n${item.evidenceContent}`;
    const primary = [{
      text: primaryText,
      type: "text" as const,
    }];
    let expanded: AnswerContentPart[] | null = null;
    const expandedSource = buildExpandedAnswerSource(label, item);
    if (expandedSource !== null) {
      expanded = [{
        text: expandedSource.text,
        type: "text",
      }];
    }
    const useExpanded = expandedRetrievalWindowIds.has(
      item.provenance.retrievalWindowId,
    );
    const selectedContent = useExpanded && expanded !== null
      ? expanded
      : primary;
    const selectedExpandedSource = useExpanded ? expandedSource : null;
    let requestEvidence: AnswerGenerationEvidenceTelemetry;
    if (selectedExpandedSource === null) {
      requestEvidence = buildAnswerRequestEvidence(
        item,
        primaryText,
        "exact-retrieval-window",
        [item.provenance.retrievalWindowId],
      );
    } else {
      requestEvidence = buildAnswerRequestEvidence(
        item,
        selectedExpandedSource.text,
        selectedExpandedSource.mode,
        selectedExpandedSource.retrievalWindowIds,
      );
    }
    sources.push({
      expanded,
      primary: selectedContent,
      requestEvidence,
    });
  }
  return sources;
}

function buildExpandedAnswerSource(
  label: string,
  item: RetrievedElement,
): ExpandedAnswerSource | null {
  const parts = [label];
  const adjacentContext = item.adjacentContext;
  let hasAdjacentContext = false;
  if (adjacentContext !== undefined && adjacentContext.preceding !== null) {
    parts.push(`Preceding context:\n${adjacentContext.preceding}`);
    hasAdjacentContext = true;
  }
  parts.push(`Exact retrieved passage:\n${item.evidenceContent}`);
  if (adjacentContext !== undefined && adjacentContext.following !== null) {
    parts.push(`Following context:\n${adjacentContext.following}`);
    hasAdjacentContext = true;
  }
  if (
    !hasAdjacentContext
    &&
    item.element.kind !== "image"
    && item.element.content !== item.evidenceContent
  ) {
    parts.push(`Parent source element:\n${item.element.content}`);
  }
  if (parts.length === 2) {
    return null;
  }
  if (hasAdjacentContext && adjacentContext !== undefined) {
    return {
      mode: "adjacent-retrieval-windows",
      retrievalWindowIds: [...adjacentContext.retrievalWindowIds],
      text: parts.join("\n\n"),
    };
  }
  return {
    mode: "parent-source-element",
    retrievalWindowIds: [item.provenance.retrievalWindowId],
    text: parts.join("\n\n"),
  };
}

function buildAnswerRequestEvidence(
  item: RetrievedElement,
  content: string,
  mode: AnswerGenerationEvidenceTelemetry["context"]["mode"],
  retrievalWindowIds: readonly string[],
): AnswerGenerationEvidenceTelemetry {
  return {
    context: {
      contentSha256: createHash("sha256").update(content).digest("hex"),
      mode,
      retrievalWindowIds: [...retrievalWindowIds],
    },
    evidenceSha256: item.provenance.evidenceSha256,
    elementId: item.element.id,
    retrievalWindowId: item.provenance.retrievalWindowId,
  };
}

export function createEmptyRetrievalAnswer(): EmptyRetrievalAnswerResult {
  return createRetrievalFallback("empty-retrieval");
}

function createRetrievalFallback(
  reason: EmptyRetrievalAnswerResult["reason"],
): EmptyRetrievalAnswerResult {
  const answerDocument = createUncitedAnswerDocument();
  return {
    answer: renderPublishedAnswerMarkdown(answerDocument),
    answerDocument,
    claims: [],
    matchedDocuments: [],
    outcome: "fallback",
    reason,
    runDetails: null,
    sources: [],
  };
}

function finalizeAnswerDraft(
  draft: AnswerDraft,
  retrieved: RetrievedElement[],
  evidenceRefs: readonly EvidenceReference[],
  runDetails: AnswerRunDetails,
  verificationStatementIndexes: readonly number[] | null,
): AnsweredGeneratedAnswerResult | FallbackGeneratedAnswerResult {
  if (draft.status === "uncited") {
    return createGeneratedFallback(
      retrieved,
      runDetails,
      "model-uncited",
      draft.content,
    );
  }
  const answerDocument = compileAnswerDraft(draft, retrieved, evidenceRefs);
  if (!isPublishedAnsweredDocument(answerDocument)) {
    throw new Error("Answered draft compiled into an uncited document.");
  }
  const claims = readPublishedAnswerClaims(answerDocument);
  return {
    answer: renderPublishedAnswerMarkdown(answerDocument),
    answerDocument,
    claims: selectVerificationClaims(
      claims,
      verificationStatementIndexes,
    ),
    matchedDocuments: buildMatchedDocuments(retrieved),
    outcome: "answered",
    runDetails,
    sources: answerDocument.citations,
  };
}

function selectVerificationClaims(
  claims: readonly AnswerClaim[],
  statementIndexes: readonly number[] | null,
): AnswerClaim[] {
  if (statementIndexes === null) {
    return [...claims];
  }
  const selected: AnswerClaim[] = [];
  const seen = new Set<number>();
  for (const statementIndex of statementIndexes) {
    if (
      !Number.isInteger(statementIndex)
      || statementIndex < 0
      || statementIndex >= claims.length
    ) {
      throw new Error(
        `Answer verification statement index ${statementIndex} is unavailable.`,
      );
    }
    if (seen.has(statementIndex)) {
      throw new Error(
        `Answer verification statement index ${statementIndex} is duplicated.`,
      );
    }
    const claim = claims[statementIndex];
    if (claim === undefined) {
      throw new Error(
        `Answer verification statement index ${statementIndex} is missing.`,
      );
    }
    seen.add(statementIndex);
    selected.push(claim);
  }
  return selected;
}

function createGeneratedFallback(
  retrieved: RetrievedElement[],
  runDetails: AnswerRunDetails,
  reason: GeneratedAnswerFallbackReason,
  answer: string,
): FallbackGeneratedAnswerResult {
  const answerDocument = createUncitedAnswerDocument(answer);
  const fallback: FallbackGeneratedAnswerResult = {
    answer,
    answerDocument,
    claims: [],
    matchedDocuments: buildMatchedDocuments(retrieved),
    outcome: "fallback",
    reason,
    runDetails,
    sources: [],
  };
  console.warn(JSON.stringify({
    level: "warn",
    operation: "generated-answer-finalization",
    reason,
    retrievedCount: retrieved.length,
    runId: runDetails.runId,
  }));
  return fallback;
}

export function createAnswerSystemPrompt(): string {
  return createAskSystemPrompt();
}

async function finishAnswerStage(
  stage: ReturnType<RunTelemetry["startStage"]>,
  result: GeneratedAnswerResult,
  inputCount: number,
  completion: AnswerCompletion,
): Promise<void> {
  const outcome = result.outcome === "answered" ? "success" : "fallback";
  const outputCount = result.outcome === "answered"
    ? result.answerDocument.statements.length
    : 0;
  await stage.finish(createTelemetryStageResult(outcome, {
    inputCount,
    inputTokens: completion.inputTokens,
    outputCount,
    outputTokens: completion.outputTokens,
  }));
}

function readAnswerCompletion(
  error: NoObjectGeneratedError,
  observedCompletion: AnswerCompletion | null,
): AnswerCompletion {
  return {
    finishReason: error.finishReason ?? observedCompletion?.finishReason ?? null,
    inputTokens: error.usage?.inputTokens ?? observedCompletion?.inputTokens ?? null,
    outputTokens: error.usage?.outputTokens ?? observedCompletion?.outputTokens ?? null,
  };
}

function createAnswerRunDetails(
  models: InferenceModelRegistry,
  startedAt: number,
  completion: AnswerCompletion,
  runId: string | null,
): AnswerRunDetails {
  return {
    durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
    finishReason: completion.finishReason,
    inputTokens: completion.inputTokens,
    modelId: readAnswerModelId(models.answer.modelId),
    outputTokens: completion.outputTokens,
    runId,
  };
}

function readAnswerModelId(modelId: string): string {
  const internalRoleSuffix = ":answer";
  if (modelId.endsWith(internalRoleSuffix)) {
    return modelId.slice(0, -internalRoleSuffix.length);
  }
  return modelId;
}

function createSourceLabel(
  evidenceRef: EvidenceReference,
  element: RetrievedElement["element"],
): string {
  const pages = element.pageNumbers.length === 0
    ? "unknown"
    : element.pageNumbers.join(", ");
  let referenceLabel = `${evidenceRef} RETRIEVED EVIDENCE`;
  if (evidenceRef.startsWith("SOURCE_")) {
    referenceLabel = `Source reference: ${evidenceRef}\nRETRIEVED EVIDENCE`;
  } else if (!evidenceRef.startsWith("EVID_")) {
    referenceLabel = `Chunk ID: ${evidenceRef}\nRETRIEVED EVIDENCE`;
  }
  const parts = [
    referenceLabel,
    `Source file: ${element.sourceFile}`,
    `Source type: ${element.kind}; pages: ${pages}`,
  ];
  if (element.kind === "image" && element.sourceRefs.includes("source-image")) {
    parts.push("Evidence scope: full standalone source image");
  }
  if (element.sectionPath.length > 0) {
    parts.push(`Section: ${element.sectionPath.join(" > ")}`);
  }
  return parts.join("\n");
}
