import type {
  EmbeddingSpaceConfig,
  RankFusionConfig,
  RetrievalMode,
} from "../../config/index.js";
import type { CiteLoomDatabase } from "../../database/client.js";
import type { DocumentTocEntry } from "../../domain/document-toc.js";
import {
  createTelemetryStageResult,
  noopRunTelemetry,
  type RunTelemetry,
} from "../../observability/run.js";
import type {
  DenseCandidate,
  FusedCandidate,
  WeightedRanking,
} from "../ranking/rank-fusion.js";
import { createCandidateSourceAliases } from "../ranking/rank-fusion.js";
import {
  queryActiveTocRetrievalRows,
  readActiveDocumentTocs,
  type ActiveDocumentToc,
} from "./store.js";

const MAXIMUM_EXPANDED_SECTIONS = 6;
const MAXIMUM_WINDOWS_PER_SECTION = 2;

interface TocSectionSelection {
  documentId: string;
  elementSetId: string;
  entry: DocumentTocEntry;
  sourceFile: string;
}

interface TocLookup {
  entryByRetrievalId: Map<string, DocumentTocEntry>;
  toc: ActiveDocumentToc;
}

export async function createDocumentTocRanking(
  database: CiteLoomDatabase,
  space: EmbeddingSpaceConfig,
  retrievalMode: RetrievalMode,
  queryEmbedding: number[],
  rankedCandidates: FusedCandidate[],
  candidateK: number,
  fusion: RankFusionConfig,
  abortSignal: AbortSignal,
  runTelemetry: RunTelemetry = noopRunTelemetry,
): Promise<WeightedRanking | null> {
  const expansionInput = rankedCandidates.slice(0, candidateK);
  if (expansionInput.length === 0) {
    return null;
  }
  const stage = runTelemetry.startStage({
    model: null,
    name: "toc-expansion",
    retrievalMode,
  });
  try {
    const selections = await selectMatchedSections(
      database,
      space.id,
      expansionInput,
    );
    const candidates = await loadSectionCandidates(
      database,
      space,
      queryEmbedding,
      selections,
    );
    abortSignal.throwIfAborted();
    await stage.finish(createTelemetryStageResult("success", {
      inputCount: selections.length,
      outputCount: candidates.length,
    }));
    if (candidates.length === 0) {
      return null;
    }
    return {
      candidates,
      channel: "toc",
      queryIndex: 0,
      weight: fusion.denseWeight * fusion.originalQueryWeight,
    };
  } catch {
    abortSignal.throwIfAborted();
    await stage.finish(createTelemetryStageResult("fallback", {
      inputCount: expansionInput.length,
      outputCount: 0,
    }));
    return null;
  }
}

async function selectMatchedSections(
  database: CiteLoomDatabase,
  embeddingSpaceId: string,
  rankedCandidates: readonly FusedCandidate[],
): Promise<TocSectionSelection[]> {
  const targets = rankedCandidates.map((candidate) => ({
    documentId: candidate.documentId,
    sourceFile: candidate.sourceFile,
  }));
  const activeTocs = await readActiveDocumentTocs(
    database,
    embeddingSpaceId,
    targets,
  );
  const lookupByDocument = buildTocLookups(activeTocs);
  const selectedSectionKeys = new Set<string>();
  const selections: TocSectionSelection[] = [];
  for (const candidate of rankedCandidates) {
    const documentKey = createDocumentKey(
      candidate.documentId,
      candidate.sourceFile,
    );
    const lookup = lookupByDocument.get(documentKey);
    const entry = lookup?.entryByRetrievalId.get(candidate.retrievalId);
    if (lookup === undefined || entry === undefined) {
      continue;
    }
    const sectionKey = `${lookup.toc.generationId}\u0000${entry.id}`;
    if (selectedSectionKeys.has(sectionKey)) {
      continue;
    }
    selectedSectionKeys.add(sectionKey);
    selections.push({
      documentId: lookup.toc.documentId,
      elementSetId: lookup.toc.elementSetId,
      entry,
      sourceFile: lookup.toc.sourceFile,
    });
    if (selections.length === MAXIMUM_EXPANDED_SECTIONS) {
      break;
    }
  }
  return selections;
}

function buildTocLookups(
  activeTocs: readonly ActiveDocumentToc[],
): Map<string, TocLookup> {
  const lookups = new Map<string, TocLookup>();
  for (const toc of activeTocs) {
    if (toc.artifact.mode !== "generated") {
      continue;
    }
    const entryByRetrievalId = new Map<string, DocumentTocEntry>();
    for (const entry of toc.artifact.entries) {
      for (const retrievalId of entry.retrievalWindowIds) {
        entryByRetrievalId.set(retrievalId, entry);
      }
    }
    lookups.set(createDocumentKey(toc.documentId, toc.sourceFile), {
      entryByRetrievalId,
      toc,
    });
  }
  return lookups;
}

async function loadSectionCandidates(
  database: CiteLoomDatabase,
  space: EmbeddingSpaceConfig,
  queryEmbedding: number[],
  selections: readonly TocSectionSelection[],
): Promise<DenseCandidate[]> {
  const sectionRows = await Promise.all(selections.map((selection) => {
    return queryActiveTocRetrievalRows(
      database,
      space,
      queryEmbedding,
      selection.documentId,
      selection.sourceFile,
      [...selection.entry.retrievalWindowIds],
      MAXIMUM_WINDOWS_PER_SECTION,
    );
  }));
  const seenCandidates = new Set<string>();
  const candidates: DenseCandidate[] = [];
  for (let index = 0; index < sectionRows.length; index += 1) {
    const rows = sectionRows[index];
    const selection = selections[index];
    if (rows === undefined || selection === undefined) {
      throw new Error(`Incomplete TOC section retrieval at index ${index}.`);
    }
    for (const row of rows) {
      const key = `${row.documentId}\u0000${row.sourceFile}\u0000${row.id}`;
      if (seenCandidates.has(key)) {
        continue;
      }
      seenCandidates.add(key);
      candidates.push({
        distance: row.distance,
        documentId: row.documentId,
        elementSetId: selection.elementSetId,
        evidenceContent: row.evidenceContent,
        evidenceRetrievalId: row.id,
        parentId: row.parentId,
        representation: {
          content: row.evidenceContent,
          id: row.id,
          type: "exact-window",
        },
        sourceAliases: createCandidateSourceAliases({
          evidenceRetrievalId: row.id,
          sourceFile: row.sourceFile,
        }),
        sourceFile: row.sourceFile,
      });
    }
  }
  return candidates;
}

function createDocumentKey(documentId: string, sourceFile: string): string {
  return `${documentId}\u0000${sourceFile}`;
}
