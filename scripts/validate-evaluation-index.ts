import { readStartupConfig } from "../src/config/index.js";
import { ApplicationSettingsRepository } from "../src/app/settings.js";
import { openDatabase } from "../src/database/client.js";
import {
  readBenchmarkEvaluationDataset,
  readEvaluationDataset,
} from "../tools/evaluation/dataset.js";
import {
  assertLiveEvaluationCorpus,
  inspectLiveEvaluationCorpus,
  type LiveEvaluationCorpusReport,
} from "../tools/evaluation/live-corpus.js";

const defaultDatasetPaths = [
  "evaluations/legal.development.json",
  "evaluations/legal.holdout.json",
  "evaluations/veterinary.development.json",
  "evaluations/veterinary.holdout.json",
] as const;

const requestedPaths = process.argv.slice(2);
const datasetPaths = requestedPaths.length === 0
  ? [...defaultDatasetPaths]
  : requestedPaths;
const startup = readStartupConfig();
const session = await openDatabase(startup.database);
try {
  const repository = new ApplicationSettingsRepository(session.database);
  const settings = await repository.read(startup.database);
  const config = settings.config;
  const failures: string[] = [];
  for (const datasetPath of datasetPaths) {
    const dataset = readBenchmarkEvaluationDataset(
      await readEvaluationDataset(datasetPath),
      datasetPath,
    );
    let report: LiveEvaluationCorpusReport;
    try {
      report = await inspectLiveEvaluationCorpus(
        session.database,
        config.embeddingSpace.id,
        dataset,
        datasetPath,
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${datasetPath} inspection failed: ${message}`);
      continue;
    }
    if (report.issues.length > 0) {
      failures.push(...report.issues);
      continue;
    }
    process.stdout.write(
      `${datasetPath}: ${dataset.cases.length} cases, ${report.documentCount} documents, and ${report.elementCount} current elements validated.\n`,
    );
  }
  assertLiveEvaluationCorpus({
    documentCount: 0,
    elementCount: 0,
    issues: failures,
    scopeTargets: [],
  });
} finally {
  await session.close();
}
