import {
  sql,
  type AnyColumn,
  type SQL,
} from "drizzle-orm";

import {
  splitResolvedQueryScopeTargets,
  type ResolvedQueryScopeTarget,
} from "../../domain/query-scope.js";

export function matchesResolvedQueryScope(
  documentId: AnyColumn,
  sourceFile: AnyColumn,
  scopeTargets: readonly ResolvedQueryScopeTarget[],
): SQL {
  const columns = splitResolvedQueryScopeTargets(scopeTargets);
  return sql`EXISTS (
    SELECT 1
    FROM unnest(
      ${sql.param(columns.documentIds)}::varchar[],
      ${sql.param(columns.sourceFiles)}::text[]
    ) AS "query_scope"("document_id", "source_file")
    WHERE "query_scope"."document_id" = ${documentId}
      AND "query_scope"."source_file" = ${sourceFile}
  )`;
}
