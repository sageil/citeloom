import { and, asc, eq, or, sql, type SQL, type SQLWrapper } from "drizzle-orm";

import type { CiteLoomDatabase } from "../database/client.js";
import type { AuthorizationPrincipal } from "../auth/model.js";
import {
  indexedDocuments,
  documentVersions,
  ingestionJobs,
  sourceLibraries,
  workspaceLibraryGrants,
  workspaces,
} from "../database/schema.js";

export class WorkspaceSourceLibraryUnavailableError extends Error {
  public constructor() {
    super("The workspace source library is unavailable.");
    this.name = "WorkspaceSourceLibraryUnavailableError";
  }
}

export type CatalogSourceAuthorization =
  | { kind: "global" }
  | { kind: "unavailable" }
  | { kind: "workspace"; workspaceId: string };

export async function authorizeSourceLibraryForPrincipal(
  database: CiteLoomDatabase,
  principal: AuthorizationPrincipal,
  libraryId: string,
  requiredAccess: "manage" | "use" = "use",
): Promise<CatalogSourceAuthorization> {
  if (principal.dataScope === "all") {
    const available = await isActiveSourceLibrary(database, libraryId);
    return available ? { kind: "global" } : { kind: "unavailable" };
  }
  if (
    principal.globalRole === "global_admin"
    && await isActiveSharedSourceLibrary(database, libraryId)
  ) {
    return { kind: "global" };
  }
  const available = await canAccessSourceLibrary(
    database,
    principal.workspaceId,
    libraryId,
    requiredAccess,
  );
  if (!available) {
    return { kind: "unavailable" };
  }
  return { kind: "workspace", workspaceId: principal.workspaceId };
}

export async function authorizeCatalogSourceForPrincipal(
  database: CiteLoomDatabase,
  principal: AuthorizationPrincipal,
  sourceFile: string,
  requiredAccess: "manage" | "use" = "use",
): Promise<CatalogSourceAuthorization> {
  const reference = await readCatalogSourceLibraryReference(database, sourceFile);
  if (reference.kind === "unassigned" && principal.dataScope === "all") {
    return { kind: "global" };
  }
  if (reference.kind !== "assigned") {
    return { kind: "unavailable" };
  }
  return authorizeSourceLibraryForPrincipal(
    database,
    principal,
    reference.libraryId,
    requiredAccess,
  );
}

export async function authorizeDocumentVersionForPrincipal(
  database: CiteLoomDatabase,
  principal: AuthorizationPrincipal,
  versionId: string,
  requiredAccess: "manage" | "use" = "use",
): Promise<CatalogSourceAuthorization> {
  const rows = await database
    .select({ sourceFile: documentVersions.sourceFile })
    .from(documentVersions)
    .where(eq(documentVersions.id, versionId))
    .limit(1);
  const version = rows[0];
  if (version === undefined) {
    return { kind: "unavailable" };
  }
  return authorizeCatalogSourceForPrincipal(
    database,
    principal,
    version.sourceFile,
    requiredAccess,
  );
}

export async function canAccessCatalogSource(
  database: CiteLoomDatabase,
  workspaceId: string,
  sourceFile: string,
  requiredAccess: "manage" | "use" = "use",
): Promise<boolean> {
  const reference = await readCatalogSourceLibraryReference(database, sourceFile);
  if (reference.kind !== "assigned") {
    return false;
  }
  return canAccessSourceLibrary(
    database,
    workspaceId,
    reference.libraryId,
    requiredAccess,
  );
}

type CatalogSourceLibraryReference =
  | { kind: "assigned"; libraryId: string }
  | { kind: "unassigned" }
  | { kind: "unavailable" };

async function readCatalogSourceLibraryReference(
  database: CiteLoomDatabase,
  sourceFile: string,
): Promise<CatalogSourceLibraryReference> {
  const jobRows = await database
    .select({ sourceLibraryId: ingestionJobs.sourceLibraryId })
    .from(ingestionJobs)
    .where(eq(ingestionJobs.sourceFile, sourceFile))
    .limit(1);
  const indexedRows = await database
    .select({ sourceLibraryId: indexedDocuments.sourceLibraryId })
    .from(indexedDocuments)
    .where(eq(indexedDocuments.sourceFile, sourceFile))
    .limit(1);
  const job = jobRows[0];
  const indexed = indexedRows[0];
  if (job === undefined && indexed === undefined) {
    return { kind: "unavailable" };
  }
  const jobLibraryId = job?.sourceLibraryId ?? null;
  const indexedLibraryId = indexed?.sourceLibraryId ?? null;
  if (
    jobLibraryId !== null
    && indexedLibraryId !== null
    && jobLibraryId !== indexedLibraryId
  ) {
    return { kind: "unavailable" };
  }
  const libraryId = jobLibraryId ?? indexedLibraryId;
  if (libraryId === null) {
    return { kind: "unassigned" };
  }
  return { kind: "assigned", libraryId };
}

async function isActiveSourceLibrary(
  database: CiteLoomDatabase,
  libraryId: string,
): Promise<boolean> {
  const rows = await database
    .select({ id: sourceLibraries.id })
    .from(sourceLibraries)
    .where(and(
      eq(sourceLibraries.id, libraryId),
      eq(sourceLibraries.state, "active"),
    ))
    .limit(1);
  return rows[0] !== undefined;
}

async function isActiveSharedSourceLibrary(
  database: CiteLoomDatabase,
  libraryId: string,
): Promise<boolean> {
  const rows = await database
    .select({ id: sourceLibraries.id })
    .from(sourceLibraries)
    .where(and(
      eq(sourceLibraries.id, libraryId),
      eq(sourceLibraries.kind, "shared"),
      eq(sourceLibraries.state, "active"),
    ))
    .limit(1);
  return rows[0] !== undefined;
}

export async function readPrivateSourceLibraryId(
  database: CiteLoomDatabase,
  workspaceId: string,
): Promise<string> {
  const rows = await database
    .select({ id: sourceLibraries.id })
    .from(sourceLibraries)
    .where(and(
      eq(sourceLibraries.kind, "private"),
      eq(sourceLibraries.ownerWorkspaceId, workspaceId),
      eq(sourceLibraries.state, "active"),
    ))
    .limit(1);
  const row = rows[0];
  if (row === undefined) {
    throw new WorkspaceSourceLibraryUnavailableError();
  }
  return row.id;
}

export async function readDefaultSourceLibraryId(
  database: CiteLoomDatabase,
): Promise<string | null> {
  const rows = await database
    .select({ id: sourceLibraries.id })
    .from(sourceLibraries)
    .innerJoin(
      workspaces,
      eq(workspaces.id, sourceLibraries.ownerWorkspaceId),
    )
    .where(and(
      eq(sourceLibraries.kind, "private"),
      eq(sourceLibraries.state, "active"),
      eq(workspaces.state, "active"),
    ))
    .orderBy(asc(workspaces.createdAt), asc(workspaces.id))
    .limit(1);
  return rows[0]?.id ?? null;
}

export function buildAccessibleSourceLibraryCondition(
  libraryId: SQLWrapper,
  workspaceId: string,
  requiredAccess: "manage" | "use" = "use",
): SQL {
  return buildAccessibleSourceLibraryConditionForWorkspaces(
    libraryId,
    [workspaceId],
    requiredAccess,
  );
}

export function buildAccessibleSourceLibraryConditionForWorkspaces(
  libraryId: SQLWrapper,
  workspaceIds: readonly string[],
  requiredAccess: "manage" | "use" = "use",
): SQL {
  if (workspaceIds.length === 0) {
    throw new Error("At least one workspace ID is needed for document access.");
  }
  const workspaceIdList = sql.join(
    workspaceIds.map((workspaceId) => sql`${workspaceId}`),
    sql`, `,
  );
  return sql`EXISTS (
    SELECT 1
    FROM ${sourceLibraries} AS accessible_library
    WHERE accessible_library.id = ${libraryId}
      AND accessible_library.state = 'active'
      AND (
        accessible_library.owner_workspace_id IN (${workspaceIdList})
        OR (
          accessible_library.kind = 'shared'
          AND EXISTS (
            SELECT 1
            FROM ${workspaceLibraryGrants} AS accessible_grant
            WHERE accessible_grant.library_id = accessible_library.id
              AND accessible_grant.workspace_id IN (${workspaceIdList})
              AND (${requiredAccess} = 'use' OR accessible_grant.access = 'manage')
          )
        )
      )
  )`;
}

export async function canAccessSourceLibrary(
  database: CiteLoomDatabase,
  workspaceId: string,
  libraryId: string,
  requiredAccess: "manage" | "use" = "use",
): Promise<boolean> {
  const rows = await database
    .select({ id: sourceLibraries.id })
    .from(sourceLibraries)
    .leftJoin(
      workspaceLibraryGrants,
      and(
        eq(workspaceLibraryGrants.libraryId, sourceLibraries.id),
        eq(workspaceLibraryGrants.workspaceId, workspaceId),
      ),
    )
    .where(and(
      eq(sourceLibraries.id, libraryId),
      eq(sourceLibraries.state, "active"),
      or(
        eq(sourceLibraries.ownerWorkspaceId, workspaceId),
        and(
          eq(sourceLibraries.kind, "shared"),
          eq(workspaceLibraryGrants.workspaceId, workspaceId),
          requiredAccess === "use"
            ? undefined
            : eq(workspaceLibraryGrants.access, "manage"),
        ),
      ),
    ))
    .limit(1);
  return rows[0] !== undefined;
}
