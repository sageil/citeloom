import type { TaskScheduler } from "../../src/shared/concurrency.js";
import type { SourceElement } from "../../src/domain/source-elements.js";
import { generateEvaluationQuestion } from "./inference.js";
import type { EvaluationModelRegistry } from "./models.js";

const MAX_UNIQUE_QUESTION_ATTEMPTS = 4;

interface EvaluationQuestionCase {
  id: string;
  question: string;
}

export interface EvaluationQuestionDeduplicationOptions {
  domain: string;
}

export async function regenerateDuplicateQuestions<
  Case extends EvaluationQuestionCase,
>(
  cases: Case[],
  elements: SourceElement[],
  options: EvaluationQuestionDeduplicationOptions,
  models: EvaluationModelRegistry,
  scheduler: TaskScheduler,
  reportProgress: (message: string) => void,
): Promise<Case[]> {
  if (cases.length !== elements.length) {
    throw new Error("Evaluation cases do not match their selected source elements.");
  }
  const seenQuestions = new Set<string>();
  const uniqueCases: Case[] = [];
  for (let caseIndex = 0; caseIndex < cases.length; caseIndex += 1) {
    const evaluationCase = cases[caseIndex];
    const element = elements[caseIndex];
    if (evaluationCase === undefined || element === undefined) {
      throw new Error(`Missing evaluation input at index ${caseIndex}.`);
    }
    const uniqueCase = await regenerateDuplicateQuestion(
      evaluationCase,
      element,
      options,
      models,
      scheduler,
      uniqueCases,
      seenQuestions,
      reportProgress,
    );
    uniqueCases.push(uniqueCase);
    seenQuestions.add(normalizeEvaluationQuestion(uniqueCase.question));
  }
  return uniqueCases;
}

async function regenerateDuplicateQuestion<
  Case extends EvaluationQuestionCase,
>(
  evaluationCase: Case,
  element: SourceElement,
  options: EvaluationQuestionDeduplicationOptions,
  models: EvaluationModelRegistry,
  scheduler: TaskScheduler,
  uniqueCases: Case[],
  seenQuestions: Set<string>,
  reportProgress: (message: string) => void,
): Promise<Case> {
  let question = evaluationCase.question;
  let normalized = normalizeEvaluationQuestion(question);
  for (
    let attempt = 1;
    seenQuestions.has(normalized) && attempt <= MAX_UNIQUE_QUESTION_ATTEMPTS;
    attempt += 1
  ) {
    reportProgress(
      `Regenerating duplicate question for ${evaluationCase.id}, attempt ${attempt}/${MAX_UNIQUE_QUESTION_ATTEMPTS}`,
    );
    question = await generateEvaluationQuestion(models, scheduler, {
      domain: options.domain,
      element,
      excludedQuestions: readEvaluationQuestions(uniqueCases),
    });
    normalized = normalizeEvaluationQuestion(question);
  }
  if (seenQuestions.has(normalized)) {
    throw new Error(
      `The local model could not generate a unique evaluation question for ${evaluationCase.id} after ${MAX_UNIQUE_QUESTION_ATTEMPTS} attempts.`,
    );
  }
  if (question === evaluationCase.question) {
    return evaluationCase;
  }
  return { ...evaluationCase, question };
}

function readEvaluationQuestions(cases: EvaluationQuestionCase[]): string[] {
  const questions: string[] = [];
  for (const evaluationCase of cases) {
    questions.push(evaluationCase.question);
  }
  return questions;
}

function normalizeEvaluationQuestion(question: string): string {
  return question.trim().toLowerCase();
}
