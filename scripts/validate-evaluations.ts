import { readFile } from "node:fs/promises";

import {
  readBenchmarkEvaluationDataset,
  readEvaluationDataset,
} from "../tools/evaluation/dataset.js";
import { decodeEvaluationTuningSpecification } from "../tools/evaluation/tuning.js";

interface CheckedDataset {
  access: "development" | "regression";
  path: string;
}

const checkedDatasets: readonly CheckedDataset[] = [
  { access: "development", path: "evaluations/legal.development.json" },
  { access: "regression", path: "evaluations/legal.holdout.json" },
  { access: "development", path: "evaluations/veterinary.development.json" },
  { access: "regression", path: "evaluations/veterinary.holdout.json" },
];

const tuningSpecificationPaths = [
  "evaluation-tuning.example.json",
  "evaluations/tuning/search.json",
] as const;

for (const checkedDataset of checkedDatasets) {
  const dataset = await readEvaluationDataset(checkedDataset.path);
  const benchmark = readBenchmarkEvaluationDataset(dataset, checkedDataset.path);
  if (benchmark.version !== 3 || benchmark.corpus === undefined) {
    throw new Error(
      `${checkedDataset.path} must use version 3 corpus and element provenance.`,
    );
  }
  if (benchmark.access !== checkedDataset.access) {
    throw new Error(
      `${checkedDataset.path} must use ${checkedDataset.access} access.`,
    );
  }
  if (benchmark.cases.length < benchmark.statisticalDesign.requiredCaseCount) {
    throw new Error(`${checkedDataset.path} does not meet its required case count.`);
  }
  for (const evaluationCase of benchmark.cases) {
    for (const judgment of evaluationCase.judgments) {
      if (judgment.review.auditStatus !== "accepted") {
        throw new Error(
          `${checkedDataset.path} contains an unaccepted judgment in ${evaluationCase.id}.`,
        );
      }
    }
  }
}

for (const path of tuningSpecificationPaths) {
  const content = await readFile(path, "utf8");
  decodeEvaluationTuningSpecification(JSON.parse(content) as unknown, path);
}

process.stdout.write("Evaluation datasets and tuning specifications are valid.\n");
