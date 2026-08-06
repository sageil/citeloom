import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";

import { buildApplicationRuntime } from "../../app/runtime.js";
import type { AppConfig } from "../../config/index.js";
import type { CiteLoomDatabase } from "../../database/client.js";
import {
  documentVersions,
  indexedDocumentSpaces,
  retrievalTocArtifacts,
} from "../../database/schema.js";
import {
  documentTocArtifactSchema,
  type DocumentTocArtifact,
} from "../../domain/document-toc.js";
import { contentIdSchema } from "../../domain/validation.js";
import { SourceDocumentStore } from "../../documents/storage/source-document-store.js";
import { generateDocumentTocArtifact } from "./generation.js";
import {
  publishBackfilledDocumentTocArtifact,
  type DocumentTocGenerationIdentity,
} from "./store.js";

const backfillCandidateSchema = z.object({
  artifact: documentTocArtifactSchema.nullable(),
  documentId: contentIdSchema,
  elementSetId: contentIdSchema,
  generationId: z.uuid(),
  sourceFile: z.string().min(1),
});

interface DocumentTocBackfillCandidate extends DocumentTocGenerationIdentity {
  artifact: DocumentTocArtifact | null;
}

export interface DocumentTocBackfillReport {
  alreadyPublished: number;
  published: number;
  scanned: number;
  stale: number;
}

export async function backfillDocumentTocs(
  config: AppConfig,
  reportProgress: (message: string) => void,
  abortSignal: AbortSignal,
): Promise<DocumentTocBackfillReport> {
  if (!config.docling.tocEnabled) {
    throw new Error(
      "Document TOC routing is disabled in the Docling configuration.",
    );
  }
  const runtime = await buildApplicationRuntime(config);
  try {
    const candidates = await readBackfillCandidates(
      runtime.database,
      config.embeddingSpace.id,
    );
    const documentStore = new SourceDocumentStore(runtime.database);
    const scheduler = runtime.scheduler("indexing", "maintenance");
    const report: DocumentTocBackfillReport = {
      alreadyPublished: 0,
      published: 0,
      scanned: candidates.length,
      stale: 0,
    };
    for (const candidate of candidates) {
      abortSignal.throwIfAborted();
      if (candidate.artifact?.mode === "generated") {
        report.alreadyPublished += 1;
        continue;
      }
      reportProgress(`Building document TOC for ${candidate.sourceFile}`);
      const elements = await documentStore.readAllElements(
        candidate.elementSetId,
        candidate.sourceFile,
      );
      const artifact = await generateDocumentTocArtifact(
        {
          documentId: candidate.documentId,
          elements,
          sourceFile: candidate.sourceFile,
          space: config.embeddingSpace,
        },
        runtime.models,
        scheduler,
        abortSignal,
        reportProgress,
      );
      abortSignal.throwIfAborted();
      const result = await publishBackfilledDocumentTocArtifact(
        runtime.database,
        config.embeddingSpace.id,
        candidate,
        artifact,
      );
      if (result === "published") {
        report.published += 1;
      } else if (result === "already-published") {
        report.alreadyPublished += 1;
      } else {
        report.stale += 1;
      }
    }
    return report;
  } finally {
    await runtime.close();
  }
}

async function readBackfillCandidates(
  database: CiteLoomDatabase,
  embeddingSpaceId: string,
): Promise<DocumentTocBackfillCandidate[]> {
  const rows = await readBackfillCandidatesQuery(database, embeddingSpaceId);
  const candidates: DocumentTocBackfillCandidate[] = [];
  for (const row of rows) {
    const result = backfillCandidateSchema.safeParse(row);
    if (!result.success) {
      throw new Error(
        `Invalid document TOC backfill candidate: ${result.error.message}`,
      );
    }
    candidates.push(result.data);
  }
  return candidates;
}

function readBackfillCandidatesQuery(
  database: CiteLoomDatabase,
  embeddingSpaceId: string,
) {
  return database
    .select({
      artifact: retrievalTocArtifacts.artifact,
      documentId: indexedDocumentSpaces.documentId,
      elementSetId: documentVersions.elementSetId,
      generationId: indexedDocumentSpaces.generationId,
      sourceFile: indexedDocumentSpaces.sourceFile,
    })
    .from(indexedDocumentSpaces)
    .innerJoin(
      documentVersions,
      and(
        eq(documentVersions.documentId, indexedDocumentSpaces.documentId),
        eq(documentVersions.generationId, indexedDocumentSpaces.generationId),
        eq(documentVersions.sourceFile, indexedDocumentSpaces.sourceFile),
      ),
    )
    .leftJoin(
      retrievalTocArtifacts,
      eq(retrievalTocArtifacts.generationId, indexedDocumentSpaces.generationId),
    )
    .where(eq(indexedDocumentSpaces.embeddingSpaceId, embeddingSpaceId))
    .orderBy(
      asc(indexedDocumentSpaces.sourceFile),
      asc(indexedDocumentSpaces.generationId),
    );
}
