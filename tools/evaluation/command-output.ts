import type { RetrievalMode } from "../../src/config/index.js";
import type { EvaluationResult } from "./index.js";
import type { EvaluationTuningSelection } from "./tuning.js";

export function printEvaluationResult(result: EvaluationResult): void {
  console.log(
    `${result.datasetName} (${result.split}, ${result.access}) NDCG@${result.atK}`,
  );
  console.log(`Cases: ${result.coverage.caseCount}`);
  if (result.benchmarkTelemetry.length > 0) {
    console.log(
      `Telemetry traces: ${result.benchmarkTelemetry.length} linked benchmark runs`,
    );
  }
  console.log(
    `Design: detect two-sided paired NDCG delta ${result.statisticalDesign.minimumDetectableNdcgDelta.toFixed(4)} with 80% power at alpha 0.05 using a normal approximation, assuming delta SD ${result.statisticalDesign.assumedPairedNdcgDeltaStandardDeviation.toFixed(4)} (${result.statisticalDesign.requiredCaseCount} cases required)`,
  );
  printCoverage("Domains", result.coverage.domains);
  printCoverage("Source kinds", result.coverage.sourceKinds);
  printCoverage("Languages", result.coverage.languages);
  printCoverage("Question types", result.coverage.questionTypes);
  for (const method of result.methods) {
    console.log(`\n${readRetrievalModeDisplayName(method.mode)}`);
    for (const domain of method.domains) {
      console.log(
        `  ${domain.domain}: NDCG ${domain.meanNdcg.toFixed(4)}, recall ${domain.meanRecall.toFixed(4)} (${domain.caseCount} cases)`,
      );
    }
    console.log(
      `  Case-weighted mean: ${method.meanNdcg.toFixed(4)} (95% CI ${method.meanNdcgInterval.lower.toFixed(4)} to ${method.meanNdcgInterval.upper.toFixed(4)})`,
    );
    console.log(`  Domain macro mean:  ${method.macroMeanNdcg.toFixed(4)}`);
    console.log(
      `  Case-weighted recall: ${method.meanRecall.toFixed(4)} (95% CI ${method.meanRecallInterval.lower.toFixed(4)} to ${method.meanRecallInterval.upper.toFixed(4)})`,
    );
    console.log(`  Domain macro recall:  ${method.macroMeanRecall.toFixed(4)}`);
    for (const evaluationCase of method.cases) {
      console.log(
        `    ${evaluationCase.id}: NDCG ${evaluationCase.ndcg.toFixed(4)}, recall ${evaluationCase.recall.toFixed(4)} (${evaluationCase.relevantRetrieved} relevant labels in ${evaluationCase.retrieved} results)`,
      );
    }
    for (const sourceKind of method.sourceKinds) {
      console.log(
        `    ${sourceKind.value} slice: NDCG ${sourceKind.meanNdcg.toFixed(4)}, recall ${sourceKind.meanRecall.toFixed(4)} (${sourceKind.caseCount} cases)`,
      );
    }
  }
  if (result.comparisons.length > 0) {
    console.log("\nPaired method deltas");
  }
  for (const comparison of result.comparisons) {
    console.log(
      `  ${readRetrievalModeDisplayName(comparison.contenderMode)} minus ${readRetrievalModeDisplayName(comparison.baselineMode)}: NDCG ${comparison.meanNdcgDelta.toFixed(4)} (95% CI ${comparison.meanNdcgDeltaInterval.lower.toFixed(4)} to ${comparison.meanNdcgDeltaInterval.upper.toFixed(4)}), recall ${comparison.meanRecallDelta.toFixed(4)} (95% CI ${comparison.meanRecallDeltaInterval.lower.toFixed(4)} to ${comparison.meanRecallDeltaInterval.upper.toFixed(4)})`,
    );
    for (const evaluationCase of comparison.cases) {
      console.log(
        `    ${evaluationCase.id}: NDCG ${evaluationCase.ndcgDelta.toFixed(4)}, recall ${evaluationCase.recallDelta.toFixed(4)}`,
      );
    }
  }
  if (result.skippedModes.length > 0) {
    const skipped = result.skippedModes.map(readRetrievalModeDisplayName);
    console.log(`\nSkipped: ${skipped.join(", ")} (reranker is disabled)`);
  }
}

export function printEvaluationTuningSelection(
  selection: EvaluationTuningSelection,
): void {
  const selected = selection.selected;
  console.log("Development retrieval tuning");
  console.log(
    `Candidates: ${selection.candidateAssessments.length}, eligible: ${selection.candidateAssessments.filter((candidate) => candidate.eligible).length}`,
  );
  console.log(
    `Objective: domain macro mean NDCG ${selected.metrics.domainMacroMeanNdcg.toFixed(4)}, improvement ${selected.objectiveImprovement.toFixed(4)}`,
  );
  console.log(
    `Estimated p95 retrieval latency: ${selected.metrics.estimatedP95LatencyMs.toFixed(1)} ms (${selected.estimatedP95LatencyRegressionMs.toFixed(1)} ms versus reference)`,
  );
  const configuration = selected.configuration;
  console.log(
    `Selected: dense ${configuration.fusion.denseWeight}, lexical ${configuration.fusion.lexicalWeight}, original ${configuration.fusion.originalQueryWeight}, expansion ${configuration.fusion.expansionQueryWeight}, decay ${configuration.fusion.expansionDecay}, expansions ${configuration.queryExpansions}, RRF k ${configuration.rrfK}, reranker candidates ${configuration.rerankerCandidateDepth}`,
  );
  console.log("Ablations:");
  for (const ablation of selection.ablations) {
    console.log(
      `  ${readRetrievalModeDisplayName(ablation.mode)}: domain macro NDCG ${ablation.metrics.domainMacroMeanNdcg.toFixed(4)}, recall ${ablation.metrics.domainMacroMeanRecall.toFixed(4)}`,
    );
  }
}

function printCoverage(
  label: string,
  counts: Array<{ count: number; value: string }>,
): void {
  const values: string[] = [];
  for (const entry of counts) {
    values.push(`${entry.value} ${entry.count}`);
  }
  console.log(`${label}: ${values.join(", ")}`);
}

export function printProgress(message: string): void {
  console.error(`- ${message}`);
}

export function printHelp(): void {
  console.log(`CiteLoom evaluation tools

  pnpm evaluate --freeze-configuration --output <freeze.json>
  pnpm evaluate <dataset.json> --preparation-output <preparation.json> [--tuning-selection <selection.json> --frozen-configuration <freeze.json>] [--output <result.json>]
  pnpm evaluate --from-preparation <preparation.json> [--output <result.json>]
  pnpm evaluate --tune --specification <search.json> --from-preparation <preparation.json> [--from-preparation <preparation.json>...] --output <selection.json> --freeze-output <freeze.json>
  pnpm evaluate --prepare-answer-threshold <dataset.json> --negative-domain <domain> --output <preparation.json>
  pnpm evaluate --select-answer-threshold --maximum-false-acceptance-rate <0..1> --from-preparation <preparation.json> [--from-preparation <preparation.json>...] --output <selection.json>
  pnpm evaluate --claims --dataset <audited-answers.json> --output <report.json>
  pnpm evaluate:generate --domain <name> --language <bcp47> --question-type <type> --split <development|holdout> --minimum-detectable-ndcg-delta <0..1> --assumed-paired-ndcg-stddev <0..1> --output <dataset.json> [options]`);
}

function readRetrievalModeDisplayName(mode: RetrievalMode): string {
  if (mode === "bm25") {
    return "BM25";
  }
  if (mode === "dense") {
    return "Dense";
  }
  if (mode === "hybrid") {
    return "Hybrid RRF";
  }
  return "Hybrid RRF plus reranker";
}
