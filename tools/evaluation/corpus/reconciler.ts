import { isAbsolute, relative, sep } from "node:path";

import type { AppConfig } from "../../../src/config/index.js";
import { openDatabase } from "../../../src/database/client.js";
import type { IngestionJob } from "../../../src/documents/catalog/index.js";
import type {
  ProofCorpus,
  ProofCorpusDocument,
  ProofCorpusDomain,
} from "./proof.js";
import {
  ingestDocuments,
  type IngestFailure,
  type IngestResult,
} from "../../../src/ingestion/service.js";
import { IngestionProcessor } from "../../../src/ingestion/processor.js";

export interface CorpusQueueReconciliationOptions {
  apply: boolean;
  forceSelected: boolean;
}

export interface CorpusQueueReconciliationPlan {
  cancellable: IngestionJob[];
  protected: IngestionJob[];
  retained: IngestionJob[];
  selected: ProofCorpusDocument[];
}

export interface CorpusQueueReconciliationResult {
  applied: boolean;
  canceled: IngestionJob[];
  failures: IngestFailure[];
  ingested: IngestResult[];
  plan: CorpusQueueReconciliationPlan;
  protected: IngestionJob[];
}

export async function reconcileCorpusQueue(
  config: AppConfig,
  corpus: ProofCorpus,
  options: CorpusQueueReconciliationOptions,
  reportProgress: (message: string) => void,
): Promise<CorpusQueueReconciliationResult> {
  const databaseSession = await openDatabase(config.database);
  let plan: CorpusQueueReconciliationPlan;
  let canceled: IngestionJob[] = [];
  try {
    const processor = new IngestionProcessor(
      config,
      databaseSession.database,
      reportProgress,
    );
    const jobs = await processor.catalog.listJobs();
    plan = buildCorpusQueueReconciliationPlan(jobs, corpus, new Date());
    if (!options.apply) {
      return {
        applied: false,
        canceled,
        failures: [],
        ingested: [],
        plan,
        protected: plan.protected,
      };
    }
    requireNoProtectedJobs(plan);
    requireSelectedJobsAvailable(plan, new Date());
    const sourceFiles = plan.cancellable.map((job) => job.sourceFile);
    canceled = await processor.catalog.cancelAvailableJobs(sourceFiles);
    for (const canceledJob of canceled) {
      await processor.cleanAbandonedJob(canceledJob);
      reportProgress(
        `Canceled queued corpus document ${canceledJob.sourceFile}`,
      );
    }
  } finally {
    await databaseSession.close();
  }

  const ingested: IngestResult[] = [];
  const failures: IngestFailure[] = [];
  const documentsByDomain = groupDocumentsByDomain(corpus.documents);
  for (const [domain, documents] of documentsByDomain) {
    const sourceFiles = documents.map((document) => document.sourceFile);
    const result = await ingestDocuments(
      config,
      sourceFiles,
      {
        enqueue: true,
        force: options.forceSelected,
        recursive: false,
        tags: [domain],
      },
      reportProgress,
    );
    ingested.push(...result.documents);
    failures.push(...result.failures);
  }
  return {
    applied: true,
    canceled,
    failures,
    ingested,
    plan,
    protected: [],
  };
}

export function buildCorpusQueueReconciliationPlan(
  jobs: IngestionJob[],
  corpus: ProofCorpus,
  currentTime: Date,
): CorpusQueueReconciliationPlan {
  const selectedSourceFiles = new Set<string>();
  for (const document of corpus.documents) {
    selectedSourceFiles.add(document.sourceFile);
  }

  const cancellable: IngestionJob[] = [];
  const protectedJobs: IngestionJob[] = [];
  const retained: IngestionJob[] = [];
  for (const job of jobs) {
    if (!isSourceWithinCorpus(job.sourceFile, corpus.corpusRoot)) {
      retained.push(job);
      continue;
    }
    if (selectedSourceFiles.has(job.sourceFile)) {
      retained.push(job);
      continue;
    }
    if (hasActiveLease(job, currentTime)) {
      protectedJobs.push(job);
      continue;
    }
    cancellable.push(job);
  }
  return {
    cancellable,
    protected: protectedJobs,
    retained,
    selected: corpus.documents,
  };
}

export function isSourceWithinCorpus(
  sourceFile: string,
  corpusRoot: string,
): boolean {
  const relativePath = relative(corpusRoot, sourceFile);
  if (relativePath === "" || relativePath === "..") {
    return false;
  }
  if (relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    return false;
  }
  return true;
}

function hasActiveLease(job: IngestionJob, currentTime: Date): boolean {
  if (job.state !== "running") {
    return false;
  }
  return new Date(job.leaseExpiresAt).getTime() > currentTime.getTime();
}

function requireSelectedJobsAvailable(
  plan: CorpusQueueReconciliationPlan,
  currentTime: Date,
): void {
  const selectedSourceFiles = new Set<string>();
  for (const document of plan.selected) {
    selectedSourceFiles.add(document.sourceFile);
  }
  const activeSelected: string[] = [];
  for (const job of plan.retained) {
    if (
      selectedSourceFiles.has(job.sourceFile) &&
      hasActiveLease(job, currentTime)
    ) {
      activeSelected.push(job.sourceFile);
    }
  }
  if (activeSelected.length > 0) {
    throw new Error(
      `Selected corpus jobs are currently running: ${activeSelected.join(", ")}`,
    );
  }
}

function requireNoProtectedJobs(
  plan: CorpusQueueReconciliationPlan,
): void {
  if (plan.protected.length === 0) {
    return;
  }
  const files = plan.protected.map((job) => job.sourceFile).join(", ");
  throw new Error(`Corpus jobs have active leases and cannot be canceled: ${files}`);
}

function groupDocumentsByDomain(
  documents: ProofCorpusDocument[],
): Map<ProofCorpusDomain, ProofCorpusDocument[]> {
  const groups = new Map<ProofCorpusDomain, ProofCorpusDocument[]>();
  for (const document of documents) {
    const existing = groups.get(document.domain);
    if (existing === undefined) {
      groups.set(document.domain, [document]);
      continue;
    }
    existing.push(document);
  }
  return groups;
}
