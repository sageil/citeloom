import {
  and,
  asc,
  cosineDistance,
  eq,
  inArray,
  sql,
} from "drizzle-orm";
import { z } from "zod";

import type { EmbeddingSpaceConfig } from "../../config/index.js";
import type { CiteLoomDatabase } from "../../database/client.js";
import {
  activeRetrievalEvidence,
  activeRetrievalRoutes,
  indexedDocuments,
} from "../../database/schema.js";
import {
  createResolvedQueryScopeTargetKey,
  type ResolvedQueryScopeTarget,
} from "../../domain/query-scope.js";
import {
  readActiveRetrievalVectorTable,
  readRetrievalVectorTable,
  type ActiveRetrievalVectorTable,
  type RetrievalVectorTable,
} from "../../embedding/storage-tables.js";
import { matchesResolvedQueryScope } from "./query-scope-filter.js";
import type {
  RetrievalSearchStrategy,
} from "./candidate-budget-search.js";
import type { RetrievalTransaction } from "./index-store.js";

export interface ActiveRetrievalWindowRow {
  documentId: string;
  evidenceContent: string;
  generationId: string;
  id: string;
  nextRetrievalId: string | null;
  previousRetrievalId: string | null;
  sourceFile: string;
}

export interface ActiveEvidenceSourceAliasRow {
  documentId: string;
  documentVersionId: string;
  elementSetId: string;
  evidenceContent: string;
  evidenceRetrievalId: string;
  parentId: string;
  sourceFile: string;
}

interface DenseCandidateKey {
  distance: number;
  documentId: string;
  generationId: string;
  representationId: string;
  sourceFile: string;
}

const denseCandidateKeySchema = z.object({
  distance: z.number().nonnegative(),
  documentId: z.string().min(1),
  generationId: z.uuid(),
  representationId: z.string().min(1),
  sourceFile: z.string().min(1),
});

interface ActiveRouteRow {
  documentId: string;
  elementSetId: string;
  evidenceId: string | null;
  evidenceMode: "direct" | "parent-exact";
  generationId: string;
  kind: "image" | "table" | "text";
  parentId: string;
  representationContent: string;
  representationId: string;
  representationType:
    | "exact-window"
    | "image-description"
    | "table-description";
  sourceFile: string;
}

interface ActiveEvidenceRow {
  documentId: string;
  evidenceContent: string;
  evidenceId: string;
  generationId: string;
  parentId: string;
  sourceFile: string;
}

export function readActiveRetrievalWindows(
  database: CiteLoomDatabase,
  space: EmbeddingSpaceConfig,
  scopeTargets: ResolvedQueryScopeTarget[],
  retrievalIds: string[],
): Promise<ActiveRetrievalWindowRow[]> {
  if (scopeTargets.length === 0 || retrievalIds.length === 0) {
    return Promise.resolve([]);
  }
  return database
    .select({
      documentId: activeRetrievalEvidence.documentId,
      evidenceContent: activeRetrievalEvidence.evidenceContent,
      generationId: activeRetrievalEvidence.generationId,
      id: activeRetrievalEvidence.evidenceId,
      nextRetrievalId: activeRetrievalEvidence.nextRetrievalId,
      previousRetrievalId: activeRetrievalEvidence.previousRetrievalId,
      sourceFile: activeRetrievalEvidence.sourceFile,
    })
    .from(activeRetrievalEvidence)
    .where(and(
      eq(activeRetrievalEvidence.embeddingSpaceId, space.id),
      matchesResolvedQueryScope(
        activeRetrievalEvidence.documentId,
        activeRetrievalEvidence.generationId,
        activeRetrievalEvidence.sourceFile,
        scopeTargets,
      ),
      inArray(activeRetrievalEvidence.evidenceId, retrievalIds),
    ));
}

export function readActiveEvidenceSourceAliases(
  database: CiteLoomDatabase,
  embeddingSpaceId: string,
  scopeTargets: ResolvedQueryScopeTarget[],
  parentIds: string[],
): Promise<ActiveEvidenceSourceAliasRow[]> {
  if (scopeTargets.length === 0 || parentIds.length === 0) {
    return Promise.resolve([]);
  }
  return database
    .select({
      documentId: activeRetrievalEvidence.documentId,
      documentVersionId: indexedDocuments.versionId,
      elementSetId: indexedDocuments.elementSetId,
      evidenceContent: activeRetrievalEvidence.evidenceContent,
      evidenceRetrievalId: activeRetrievalEvidence.evidenceId,
      parentId: activeRetrievalEvidence.parentId,
      sourceFile: activeRetrievalEvidence.sourceFile,
    })
    .from(activeRetrievalEvidence)
    .innerJoin(
      indexedDocuments,
      and(
        eq(indexedDocuments.documentId, activeRetrievalEvidence.documentId),
        eq(indexedDocuments.sourceFile, activeRetrievalEvidence.sourceFile),
      ),
    )
    .where(and(
      eq(activeRetrievalEvidence.embeddingSpaceId, embeddingSpaceId),
      matchesResolvedQueryScope(
        activeRetrievalEvidence.documentId,
        activeRetrievalEvidence.generationId,
        activeRetrievalEvidence.sourceFile,
        scopeTargets,
      ),
      inArray(activeRetrievalEvidence.parentId, parentIds),
    ));
}

export async function queryDenseCandidates(
  database: CiteLoomDatabase,
  space: EmbeddingSpaceConfig,
  embedding: number[],
  candidateK: number,
  scopeTargets: ResolvedQueryScopeTarget[],
  strategy: RetrievalSearchStrategy,
): Promise<unknown[]> {
  let keys: DenseCandidateKey[];
  if (strategy === "indexed") {
    const activeTable = readActiveRetrievalVectorTable(space.dimensions);
    keys = await queryIndexedDenseCandidateKeys(
      database,
      activeTable,
      space.id,
      embedding,
      candidateK,
    );
  } else {
    const canonicalTable = readRetrievalVectorTable(space.dimensions);
    keys = await queryExactDenseCandidateKeys(
      database,
      canonicalTable,
      space.id,
      embedding,
      candidateK,
      scopeTargets,
    );
  }
  return hydrateDenseCandidateKeys(database, space.id, keys);
}

export function queryDenseEvidenceCandidates(
  database: CiteLoomDatabase,
  space: EmbeddingSpaceConfig,
  embedding: number[],
  scopeTargets: ResolvedQueryScopeTarget[],
  parentIds: string[],
): Promise<unknown[]> {
  if (parentIds.length === 0) {
    return Promise.resolve([]);
  }
  const table = readActiveRetrievalVectorTable(space.dimensions);
  return runExactVectorScan(database, async (transaction) => {
    const distance = cosineDistance(table.embedding, embedding);
    return transaction
      .select({
        distance,
        documentId: activeRetrievalEvidence.documentId,
        evidenceContent: activeRetrievalEvidence.evidenceContent,
        evidenceRetrievalId: activeRetrievalEvidence.evidenceId,
        generationId: activeRetrievalEvidence.generationId,
        parentId: activeRetrievalEvidence.parentId,
        sourceFile: activeRetrievalEvidence.sourceFile,
      })
      .from(table)
      .innerJoin(
        activeRetrievalRoutes,
        and(
          eq(activeRetrievalRoutes.embeddingSpaceId, table.embeddingSpaceId),
          eq(activeRetrievalRoutes.generationId, table.generationId),
          eq(activeRetrievalRoutes.representationId, table.representationId),
        ),
      )
      .innerJoin(
        activeRetrievalEvidence,
        and(
          eq(
            activeRetrievalEvidence.embeddingSpaceId,
            activeRetrievalRoutes.embeddingSpaceId,
          ),
          eq(
            activeRetrievalEvidence.generationId,
            activeRetrievalRoutes.generationId,
          ),
          eq(
            activeRetrievalEvidence.evidenceId,
            activeRetrievalRoutes.evidenceId,
          ),
        ),
      )
      .where(and(
        eq(table.embeddingSpaceId, space.id),
        matchesResolvedQueryScope(
          table.documentId,
          table.generationId,
          table.sourceFile,
          scopeTargets,
        ),
        inArray(activeRetrievalRoutes.parentId, parentIds),
        eq(activeRetrievalRoutes.representationType, "exact-window"),
      ))
      .orderBy(distance, asc(table.representationId));
  });
}

async function queryIndexedDenseCandidateKeys(
  database: CiteLoomDatabase,
  table: ActiveRetrievalVectorTable,
  embeddingSpaceId: string,
  embedding: number[],
  topK: number,
): Promise<DenseCandidateKey[]> {
  const distance = cosineDistance(table.embedding, embedding);
  const rows = await database
    .select({
      distance,
      documentId: table.documentId,
      generationId: table.generationId,
      representationId: table.representationId,
      sourceFile: table.sourceFile,
    })
    .from(table)
    .where(eq(table.embeddingSpaceId, embeddingSpaceId))
    .orderBy(distance, asc(table.representationId))
    .limit(topK);
  return decodeDenseCandidateKeys(rows);
}

async function queryExactDenseCandidateKeys(
  database: CiteLoomDatabase,
  table: RetrievalVectorTable,
  embeddingSpaceId: string,
  embedding: number[],
  topK: number,
  scopeTargets: ResolvedQueryScopeTarget[],
): Promise<DenseCandidateKey[]> {
  return runExactVectorScan(database, async (transaction) => {
    const distance = cosineDistance(table.embedding, embedding);
    const rows = await transaction
      .select({
        distance,
        documentId: table.documentId,
        generationId: table.generationId,
        representationId: table.id,
        sourceFile: table.sourceFile,
      })
      .from(table)
      .where(and(
        eq(table.embeddingSpaceId, embeddingSpaceId),
        matchesResolvedQueryScope(
          table.documentId,
          table.generationId,
          table.sourceFile,
          scopeTargets,
        ),
      ))
      .orderBy(distance, asc(table.id))
      .limit(topK);
    return decodeDenseCandidateKeys(rows);
  });
}

async function runExactVectorScan<Result>(
  database: CiteLoomDatabase,
  operation: (transaction: RetrievalTransaction) => Promise<Result>,
): Promise<Result> {
  return database.transaction(async (transaction) => {
    const settingResult = await transaction.execute(sql<{ value: string }>`
      SELECT current_setting('enable_indexscan') AS "value"
    `);
    const previousSetting = settingResult.rows[0]?.value;
    if (previousSetting !== "on" && previousSetting !== "off") {
      throw new Error("PostgreSQL returned an invalid enable_indexscan setting.");
    }
    await transaction.execute(
      sql`SELECT set_config('enable_indexscan', 'off', true)`,
    );
    const result = await operation(transaction);
    await transaction.execute(
      sql`SELECT set_config('enable_indexscan', ${previousSetting}, true)`,
    );
    return result;
  });
}

function decodeDenseCandidateKeys(rows: readonly unknown[]): DenseCandidateKey[] {
  const keys: DenseCandidateKey[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const result = denseCandidateKeySchema.safeParse(rows[index]);
    if (!result.success) {
      throw new Error(
        `Invalid dense projection key ${index + 1}: ${result.error.message}`,
      );
    }
    keys.push(result.data);
  }
  return keys;
}

async function hydrateDenseCandidateKeys(
  database: CiteLoomDatabase,
  embeddingSpaceId: string,
  keys: readonly DenseCandidateKey[],
): Promise<unknown[]> {
  if (keys.length === 0) {
    return [];
  }
  const representationIds = keys.map((key) => key.representationId);
  const routes: ActiveRouteRow[] = await database
    .select({
      documentId: activeRetrievalRoutes.documentId,
      elementSetId: indexedDocuments.elementSetId,
      evidenceId: activeRetrievalRoutes.evidenceId,
      evidenceMode: activeRetrievalRoutes.evidenceMode,
      generationId: activeRetrievalRoutes.generationId,
      kind: activeRetrievalRoutes.kind,
      parentId: activeRetrievalRoutes.parentId,
      representationContent: activeRetrievalRoutes.representationContent,
      representationId: activeRetrievalRoutes.representationId,
      representationType: activeRetrievalRoutes.representationType,
      sourceFile: activeRetrievalRoutes.sourceFile,
    })
    .from(activeRetrievalRoutes)
    .innerJoin(
      indexedDocuments,
      and(
        eq(indexedDocuments.documentId, activeRetrievalRoutes.documentId),
        eq(indexedDocuments.sourceFile, activeRetrievalRoutes.sourceFile),
      ),
    )
    .where(and(
      eq(activeRetrievalRoutes.embeddingSpaceId, embeddingSpaceId),
      inArray(activeRetrievalRoutes.representationId, representationIds),
    ));
  const routesByKey = new Map<string, ActiveRouteRow>();
  const evidenceIds: string[] = [];
  for (const route of routes) {
    routesByKey.set(createActiveProjectionKey(
      route.documentId,
      route.generationId,
      route.representationId,
      route.sourceFile,
    ), route);
    if (route.evidenceId !== null) {
      evidenceIds.push(route.evidenceId);
    }
  }
  let evidenceRows: ActiveEvidenceRow[] = [];
  if (evidenceIds.length > 0) {
    evidenceRows = await database
      .select({
        documentId: activeRetrievalEvidence.documentId,
        evidenceContent: activeRetrievalEvidence.evidenceContent,
        evidenceId: activeRetrievalEvidence.evidenceId,
        generationId: activeRetrievalEvidence.generationId,
        parentId: activeRetrievalEvidence.parentId,
        sourceFile: activeRetrievalEvidence.sourceFile,
      })
      .from(activeRetrievalEvidence)
      .where(and(
        eq(activeRetrievalEvidence.embeddingSpaceId, embeddingSpaceId),
        inArray(activeRetrievalEvidence.evidenceId, evidenceIds),
      ));
  }
  const evidenceByKey = new Map<string, ActiveEvidenceRow>();
  for (const evidence of evidenceRows) {
    evidenceByKey.set(createActiveProjectionKey(
      evidence.documentId,
      evidence.generationId,
      evidence.evidenceId,
      evidence.sourceFile,
    ), evidence);
  }

  const rows: unknown[] = [];
  for (const key of keys) {
    const projectionKey = createActiveProjectionKey(
      key.documentId,
      key.generationId,
      key.representationId,
      key.sourceFile,
    );
    const route = routesByKey.get(projectionKey);
    if (route === undefined) {
      throw new Error(
        `Active route is missing for representation ${key.representationId}.`,
      );
    }
    let evidenceContent = route.representationContent;
    let evidenceRetrievalId = key.representationId;
    if (route.evidenceMode === "direct") {
      const evidenceId = route.evidenceId;
      if (evidenceId === null) {
        throw new Error(
          `Direct route ${key.representationId} has no evidence identifier.`,
        );
      }
      const evidenceKey = createActiveProjectionKey(
        key.documentId,
        key.generationId,
        evidenceId,
        key.sourceFile,
      );
      const evidence = evidenceByKey.get(evidenceKey);
      if (evidence === undefined) {
        throw new Error(
          `Active evidence ${evidenceId} is missing for ${key.representationId}.`,
        );
      }
      evidenceContent = evidence.evidenceContent;
      evidenceRetrievalId = evidence.evidenceId;
    }
    rows.push({
      distance: key.distance,
      documentId: key.documentId,
      elementSetId: route.elementSetId,
      evidenceContent,
      evidenceRetrievalId,
      generationId: key.generationId,
      kind: route.kind,
      parentId: route.parentId,
      representationContent: route.representationContent,
      representationId: key.representationId,
      representationType: route.representationType,
      sourceFile: key.sourceFile,
    });
  }
  return rows;
}

export function createActiveProjectionKey(
  documentId: string,
  generationId: string,
  retrievalId: string,
  sourceFile: string,
): string {
  const scopeKey = createResolvedQueryScopeTargetKey({
    documentId,
    generationId,
    sourceFile,
  });
  return `${scopeKey}\0${retrievalId}`;
}
