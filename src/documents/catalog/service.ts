import { basename } from "node:path";

import { and, eq } from "drizzle-orm";

import type { ApplicationRuntime } from "../../app/runtime.js";
import {
  type CatalogEntry,
  DocumentCatalog,
} from "./index.js";
import {
  browseDocumentCatalog,
  type BrowseDocumentCatalogRequest,
  type BrowseDocumentCatalogResult,
} from "./browser.js";
import type { AppConfig } from "../../config/index.js";
import { openDatabase } from "../../database/client.js";
import type { DocumentMediaType } from "../format.js";
import { SourceContentStore } from "../storage/source-content-store.js";
import { indexedDocuments, ingestionJobs } from "../../database/schema.js";
import { buildAccessibleSourceLibraryCondition } from "../../workspaces/source-library-access.js";

export interface ReadDocumentFileRequest {
  documentId: string;
  sourceFile: string;
}

export interface IndexedDocumentFile {
  content: Buffer;
  documentId: string;
  filename: string;
  mediaType: DocumentMediaType;
  sourceFile: string;
}

export interface UpdateIndexedDocumentTagsRequest {
  documentId: string;
  sourceFile: string;
  tags: string[];
}

export interface UpdateIndexedDocumentTagsResult {
  sourceFile: string;
  tags: string[];
}

export async function listCatalogEntries(config: AppConfig): Promise<CatalogEntry[]> {
  const databaseSession = await openDatabase(config.database);
  const catalog = new DocumentCatalog(databaseSession.database);
  try {
    return await catalog.listEntries();
  } finally {
    await databaseSession.close();
  }
}

export async function browseCatalogEntries(
  config: AppConfig,
  request: BrowseDocumentCatalogRequest,
): Promise<BrowseDocumentCatalogResult> {
  const databaseSession = await openDatabase(config.database);
  try {
    return await browseDocumentCatalog(
      databaseSession.query,
      config.embeddingSpace.id,
      request,
    );
  } finally {
    await databaseSession.close();
  }
}

export async function browseCatalogEntriesWithRuntime(
  runtime: ApplicationRuntime,
  request: BrowseDocumentCatalogRequest,
  workspaceId: string | null = null,
): Promise<BrowseDocumentCatalogResult> {
  return browseDocumentCatalog(
    runtime.query,
    runtime.config.embeddingSpace.id,
    request,
    workspaceId,
  );
}

export async function updateIndexedDocumentTagsWithRuntime(
  runtime: ApplicationRuntime,
  request: UpdateIndexedDocumentTagsRequest,
  workspaceId: string | null = null,
): Promise<UpdateIndexedDocumentTagsResult | null> {
  return runtime.database.transaction(async (transaction) => {
    const matchingDocuments = await transaction
      .select({ sourceFile: indexedDocuments.sourceFile })
      .from(indexedDocuments)
      .where(
        and(
          eq(indexedDocuments.documentId, request.documentId),
          eq(indexedDocuments.sourceFile, request.sourceFile),
          workspaceId === null
            ? undefined
            : buildAccessibleSourceLibraryCondition(
                indexedDocuments.sourceLibraryId,
                workspaceId,
                "manage",
              ),
        ),
      )
      .limit(1)
      .for("update");
    if (matchingDocuments.length === 0) {
      return null;
    }
    await transaction
      .update(indexedDocuments)
      .set({ tags: request.tags })
      .where(and(
        eq(indexedDocuments.sourceFile, request.sourceFile),
        workspaceId === null
          ? undefined
          : buildAccessibleSourceLibraryCondition(
              indexedDocuments.sourceLibraryId,
              workspaceId,
              "manage",
            ),
      ));
    await transaction
      .update(ingestionJobs)
      .set({ tags: request.tags })
      .where(and(
        eq(ingestionJobs.sourceFile, request.sourceFile),
        workspaceId === null
          ? undefined
          : buildAccessibleSourceLibraryCondition(
              ingestionJobs.sourceLibraryId,
              workspaceId,
              "manage",
            ),
      ));
    return {
      sourceFile: request.sourceFile,
      tags: request.tags,
    };
  });
}

export async function readIndexedDocumentFile(
  config: AppConfig,
  request: ReadDocumentFileRequest,
): Promise<IndexedDocumentFile | null> {
  const databaseSession = await openDatabase(config.database);
  const catalog = new DocumentCatalog(databaseSession.database);
  const documentStore = new SourceContentStore(
    databaseSession.database,
    config.sourceContent,
  );
  try {
    const indexedDocument = await catalog.findIndexedDocument(
      request.documentId,
      request.sourceFile,
    );
    if (indexedDocument === null) {
      return null;
    }
    const storedDocument = await documentStore.readDocument(indexedDocument.documentId);
    return {
      content: storedDocument.content,
      documentId: indexedDocument.documentId,
      filename: basename(indexedDocument.sourceFile),
      mediaType: indexedDocument.format.mediaType,
      sourceFile: indexedDocument.sourceFile,
    };
  } finally {
    await databaseSession.close();
  }
}

export async function readIndexedDocumentFileWithRuntime(
  runtime: ApplicationRuntime,
  request: ReadDocumentFileRequest,
  workspaceId: string | null = null,
): Promise<IndexedDocumentFile | null> {
  const catalog = new DocumentCatalog(runtime.database, { workspaceId });
  const documentStore = new SourceContentStore(
    runtime.database,
    runtime.config.sourceContent,
  );
  const indexedDocument = await catalog.findIndexedDocument(
    request.documentId,
    request.sourceFile,
  );
  if (indexedDocument === null) {
    return null;
  }
  const storedDocument = await documentStore.readDocument(indexedDocument.documentId);
  return {
    content: storedDocument.content,
    documentId: indexedDocument.documentId,
    filename: basename(indexedDocument.sourceFile),
    mediaType: indexedDocument.format.mediaType,
    sourceFile: indexedDocument.sourceFile,
  };
}
