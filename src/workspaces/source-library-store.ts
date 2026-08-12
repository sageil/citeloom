import { randomUUID } from "node:crypto";

import { and, asc, eq, inArray, or } from "drizzle-orm";

import { requireGlobalAdministrator } from "../auth/authorization.js";
import type { AuthenticatedPrincipal } from "../auth/model.js";
import type { CiteLoomDatabase } from "../database/client.js";
import {
  ingestionJobs,
  sourceLibraries,
  workspaceLibraryGrants,
  workspaces,
} from "../database/schema.js";
import type {
  CreateSharedSourceLibraryInput,
  RenameSharedSourceLibraryInput,
  SourceLibraryAdministration,
  SourceLibraryAccess,
  SourceLibrarySummary,
} from "./source-library-model.js";

export class SourceLibraryUnavailableError extends Error {
  public constructor() {
    super("The requested source library or workspace is unavailable.");
    this.name = "SourceLibraryUnavailableError";
  }
}

export class SourceLibraryArchiveConflictError extends Error {
  public constructor() {
    super("The shared library cannot be archived while documents are processing.");
    this.name = "SourceLibraryArchiveConflictError";
  }
}

export class SourceLibraryStore {
  public constructor(
    private readonly database: CiteLoomDatabase,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async listAccessible(
    principal: AuthenticatedPrincipal,
  ): Promise<SourceLibrarySummary[]> {
    if (principal.dataScope === "all") {
      const rows = await this.database
        .select({
          id: sourceLibraries.id,
          kind: sourceLibraries.kind,
          name: sourceLibraries.name,
        })
        .from(sourceLibraries)
        .where(eq(sourceLibraries.state, "active"))
        .orderBy(asc(sourceLibraries.kind), asc(sourceLibraries.name));
      const libraries: SourceLibrarySummary[] = [];
      for (const row of rows) {
        libraries.push({ ...row, access: "manage" });
      }
      return libraries;
    }
    const workspaceId = principal.workspaceId;
    const sharedLibraryCondition = principal.globalRole === "global_admin"
      ? eq(sourceLibraries.kind, "shared")
      : and(
          eq(sourceLibraries.kind, "shared"),
          eq(workspaceLibraryGrants.workspaceId, workspaceId),
        );
    const rows = await this.database
      .select({
        grantedAccess: workspaceLibraryGrants.access,
        id: sourceLibraries.id,
        kind: sourceLibraries.kind,
        name: sourceLibraries.name,
        ownerWorkspaceId: sourceLibraries.ownerWorkspaceId,
      })
      .from(sourceLibraries)
      .leftJoin(
        workspaceLibraryGrants,
        and(
          eq(workspaceLibraryGrants.libraryId, sourceLibraries.id),
          eq(workspaceLibraryGrants.workspaceId, workspaceId),
        ),
      )
      .where(and(
        eq(sourceLibraries.state, "active"),
        or(
          eq(sourceLibraries.ownerWorkspaceId, workspaceId),
          sharedLibraryCondition,
        ),
      ))
      .orderBy(asc(sourceLibraries.kind), asc(sourceLibraries.name));
    const libraries: SourceLibrarySummary[] = [];
    for (const row of rows) {
      const access = row.ownerWorkspaceId === workspaceId
        || (
          principal.globalRole === "global_admin"
          && row.kind === "shared"
        )
        ? "manage"
        : row.grantedAccess;
      if (access === null) {
        continue;
      }
      libraries.push({
        access,
        id: row.id,
        kind: row.kind,
        name: row.name,
      });
    }
    return libraries;
  }

  public async readAdministration(
    principal: AuthenticatedPrincipal,
  ): Promise<SourceLibraryAdministration> {
    requireGlobalAdministrator(principal);
    return this.database.transaction(
      async (transaction) => readSourceLibraryAdministration(transaction),
      {
        accessMode: "read only",
        isolationLevel: "repeatable read",
      },
    );
  }

  public async createShared(
    principal: AuthenticatedPrincipal,
    input: CreateSharedSourceLibraryInput,
  ): Promise<SourceLibrarySummary> {
    requireGlobalAdministrator(principal);
    const id = randomUUID();
    const now = this.now();
    await this.database.transaction(async (transaction) => {
      const activeWorkspaces = await transaction
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(and(
          eq(workspaces.id, principal.workspaceId),
          eq(workspaces.state, "active"),
        ))
        .limit(1);
      if (activeWorkspaces[0] === undefined) {
        throw new SourceLibraryUnavailableError();
      }
      await transaction.insert(sourceLibraries).values({
        createdAt: now,
        id,
        kind: "shared",
        name: input.name,
        ownerWorkspaceId: null,
        state: "active",
        updatedAt: now,
      });
      await transaction.insert(workspaceLibraryGrants).values({
        access: "manage",
        createdAt: now,
        libraryId: id,
        workspaceId: principal.workspaceId,
      });
    });
    return { access: "manage", id, kind: "shared", name: input.name };
  }

  public async renameShared(
    principal: AuthenticatedPrincipal,
    libraryId: string,
    input: RenameSharedSourceLibraryInput,
  ): Promise<void> {
    requireGlobalAdministrator(principal);
    const updated = await this.database
      .update(sourceLibraries)
      .set({ name: input.name, updatedAt: this.now() })
      .where(and(
        eq(sourceLibraries.id, libraryId),
        eq(sourceLibraries.kind, "shared"),
        inArray(sourceLibraries.state, ["active", "archived"]),
      ))
      .returning({ id: sourceLibraries.id });
    if (updated[0] === undefined) {
      throw new SourceLibraryUnavailableError();
    }
  }

  public async archiveShared(
    principal: AuthenticatedPrincipal,
    libraryId: string,
  ): Promise<void> {
    requireGlobalAdministrator(principal);
    await this.database.transaction(async (transaction) => {
      const libraries = await transaction
        .select({ state: sourceLibraries.state })
        .from(sourceLibraries)
        .where(and(
          eq(sourceLibraries.id, libraryId),
          eq(sourceLibraries.kind, "shared"),
        ))
        .for("update")
        .limit(1);
      const library = libraries[0];
      if (library === undefined) {
        throw new SourceLibraryUnavailableError();
      }
      if (library.state === "archived") {
        return;
      }
      if (library.state === "deleting") {
        throw new SourceLibraryUnavailableError();
      }
      const activeJobs = await transaction
        .select({ sourceFile: ingestionJobs.sourceFile })
        .from(ingestionJobs)
        .where(and(
          eq(ingestionJobs.sourceLibraryId, libraryId),
          inArray(ingestionJobs.state, ["pending", "running"]),
        ))
        .limit(1);
      if (activeJobs[0] !== undefined) {
        throw new SourceLibraryArchiveConflictError();
      }
      await transaction
        .update(sourceLibraries)
        .set({ state: "archived", updatedAt: this.now() })
        .where(eq(sourceLibraries.id, libraryId));
    });
  }

  public async restoreShared(
    principal: AuthenticatedPrincipal,
    libraryId: string,
  ): Promise<void> {
    requireGlobalAdministrator(principal);
    const updated = await this.database
      .update(sourceLibraries)
      .set({ state: "active", updatedAt: this.now() })
      .where(and(
        eq(sourceLibraries.id, libraryId),
        eq(sourceLibraries.kind, "shared"),
        eq(sourceLibraries.state, "archived"),
      ))
      .returning({ id: sourceLibraries.id });
    if (updated[0] === undefined) {
      const active = await this.database
        .select({ id: sourceLibraries.id })
        .from(sourceLibraries)
        .where(and(
          eq(sourceLibraries.id, libraryId),
          eq(sourceLibraries.kind, "shared"),
          eq(sourceLibraries.state, "active"),
        ))
        .limit(1);
      if (active[0] === undefined) {
        throw new SourceLibraryUnavailableError();
      }
    }
  }

  public async setGrant(
    principal: AuthenticatedPrincipal,
    libraryId: string,
    workspaceId: string,
    access: SourceLibraryAccess,
  ): Promise<void> {
    requireGlobalAdministrator(principal);
    await this.database.transaction(async (transaction) => {
      const rows = await transaction
        .select({ libraryId: sourceLibraries.id, workspaceId: workspaces.id })
        .from(sourceLibraries)
        .innerJoin(workspaces, eq(workspaces.id, workspaceId))
        .where(and(
          eq(sourceLibraries.id, libraryId),
          eq(sourceLibraries.kind, "shared"),
          eq(sourceLibraries.state, "active"),
          eq(workspaces.state, "active"),
        ))
        .for("update")
        .limit(1);
      if (rows[0] === undefined) {
        throw new SourceLibraryUnavailableError();
      }
      await transaction.insert(workspaceLibraryGrants).values({
        access,
        createdAt: this.now(),
        libraryId,
        workspaceId,
      }).onConflictDoUpdate({
        set: { access },
        target: [
          workspaceLibraryGrants.workspaceId,
          workspaceLibraryGrants.libraryId,
        ],
      });
    });
  }

  public async revokeGrant(
    principal: AuthenticatedPrincipal,
    libraryId: string,
    workspaceId: string,
  ): Promise<void> {
    requireGlobalAdministrator(principal);
    await this.database.transaction(async (transaction) => {
      const libraries = await transaction
        .select({ id: sourceLibraries.id })
        .from(sourceLibraries)
        .where(and(
          eq(sourceLibraries.id, libraryId),
          eq(sourceLibraries.kind, "shared"),
          eq(sourceLibraries.state, "active"),
        ))
        .for("update")
        .limit(1);
      if (libraries[0] === undefined) {
        throw new SourceLibraryUnavailableError();
      }
      const deleted = await transaction
        .delete(workspaceLibraryGrants)
        .where(and(
          eq(workspaceLibraryGrants.libraryId, libraryId),
          eq(workspaceLibraryGrants.workspaceId, workspaceId),
        ))
        .returning({ libraryId: workspaceLibraryGrants.libraryId });
      if (deleted[0] === undefined) {
        throw new SourceLibraryUnavailableError();
      }
    });
  }
}

type SourceLibraryAdministrationDatabase = Pick<CiteLoomDatabase, "select">;

async function readSourceLibraryAdministration(
  database: SourceLibraryAdministrationDatabase,
): Promise<SourceLibraryAdministration> {
  const libraryRows = await database
    .select({
      id: sourceLibraries.id,
      name: sourceLibraries.name,
      state: sourceLibraries.state,
    })
    .from(sourceLibraries)
    .where(eq(sourceLibraries.kind, "shared"))
    .orderBy(
      asc(sourceLibraries.state),
      asc(sourceLibraries.name),
      asc(sourceLibraries.id),
    );
  const workspaceRows = await database
    .select({ id: workspaces.id, name: workspaces.name })
    .from(workspaces)
    .where(eq(workspaces.state, "active"))
    .orderBy(asc(workspaces.name), asc(workspaces.id));
  const grantRows = await database
    .select({
      access: workspaceLibraryGrants.access,
      libraryId: workspaceLibraryGrants.libraryId,
      workspaceId: workspaceLibraryGrants.workspaceId,
    })
    .from(workspaceLibraryGrants)
    .innerJoin(
      sourceLibraries,
      eq(sourceLibraries.id, workspaceLibraryGrants.libraryId),
    )
    .innerJoin(
      workspaces,
      eq(workspaces.id, workspaceLibraryGrants.workspaceId),
    )
    .where(and(
      eq(sourceLibraries.kind, "shared"),
      eq(workspaces.state, "active"),
    ))
    .orderBy(
      asc(workspaceLibraryGrants.libraryId),
      asc(workspaces.name),
      asc(workspaces.id),
    );
  const grantsByLibrary = new Map<
    string,
    SourceLibraryAdministration["libraries"][number]["grants"]
  >();
  for (const row of grantRows) {
    const grants = grantsByLibrary.get(row.libraryId) ?? [];
    grants.push({ access: row.access, workspaceId: row.workspaceId });
    grantsByLibrary.set(row.libraryId, grants);
  }
  const libraries: SourceLibraryAdministration["libraries"] = [];
  for (const row of libraryRows) {
    libraries.push({
      grants: grantsByLibrary.get(row.id) ?? [],
      id: row.id,
      name: row.name,
      state: row.state,
    });
  }
  return {
    libraries,
    workspaces: workspaceRows,
  };
}
