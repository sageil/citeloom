import { createHash } from "node:crypto";

import { and, asc, count, eq, gte, inArray } from "drizzle-orm";
import { z } from "zod";

import type { CiteLoomDatabase } from "../../database/client.js";
import {
  documentElementSetMembers,
  documentElementSets,
  sourceElements,
} from "../../database/schema.js";
import type {
  RetrievalSourceElement,
  SourceElement,
} from "../../domain/source-elements.js";
import {
  contentIdSchema,
  imageMediaTypeSchema,
  sourceRegionSchema,
} from "../../domain/validation.js";
import { queueSourceContentDeletion } from "./source-content-store.js";

const tableCellSchema = z.object({
  columnHeader: z.boolean(),
  columnSpan: z.number().int().positive(),
  endColumn: z.number().int().positive(),
  endRow: z.number().int().positive(),
  rowHeader: z.boolean(),
  rowSection: z.boolean(),
  rowSpan: z.number().int().positive(),
  startColumn: z.number().int().nonnegative(),
  startRow: z.number().int().nonnegative(),
  text: z.string(),
});
const sourceElementMetadataShape = {
  documentId: contentIdSchema,
  id: contentIdSchema,
  pageNumber: z.number().int().positive().nullable(),
  pageNumbers: z.array(z.number().int().positive()),
  regions: z.array(sourceRegionSchema),
  sectionPath: z.array(z.string().min(1)),
  sourceFile: z.string().min(1),
  sourceRefs: z.array(z.string().min(1)).min(1),
};
const sourceElementContentShape = {
  ...sourceElementMetadataShape,
  content: z.string().min(1),
};
const textElementSchema = z.object({
  ...sourceElementContentShape,
  detectedTypes: z.array(z.string().trim().min(1)).min(1),
  kind: z.literal("text"),
});
const tableElementSchema = z.object({
  ...sourceElementContentShape,
  caption: z.string().trim().min(1).nullable(),
  detectedType: z.string().trim().min(1),
  kind: z.literal("table"),
  table: z.object({
    cells: z.array(tableCellSchema),
    columnCount: z.number().int().positive(),
    rowCount: z.number().int().positive(),
    rowEnd: z.number().int().positive(),
    rowStart: z.number().int().nonnegative(),
  }),
});
const imageElementMetadataShape = {
  ...sourceElementMetadataShape,
  caption: z.string().trim().min(1).nullable(),
  detectedType: z.string().trim().min(1),
  kind: z.literal("image"),
  mimeType: imageMediaTypeSchema,
};
const imageElementSchema = z.object({
  ...imageElementMetadataShape,
  content: z.string().min(1),
});
const retrievalImageElementSchema = z.object(imageElementMetadataShape);
const sourceElementSchema = z.discriminatedUnion("kind", [
  textElementSchema,
  tableElementSchema,
  imageElementSchema,
]).superRefine(validateSourceElementMetadata);
const retrievalSourceElementSchema = z.discriminatedUnion("kind", [
  textElementSchema,
  tableElementSchema,
  retrievalImageElementSchema,
]).superRefine(validateSourceElementMetadata);

function validateSourceElementMetadata(
  element: SourceElement | RetrievalSourceElement,
  context: z.RefinementCtx,
): void {
  const uniquePages = new Set(element.pageNumbers);
  if (uniquePages.size !== element.pageNumbers.length) {
    context.addIssue({
      code: "custom",
      message: "page numbers must be unique",
      path: ["pageNumbers"],
    });
  }
  for (let index = 1; index < element.pageNumbers.length; index += 1) {
    const previous = element.pageNumbers[index - 1];
    const current = element.pageNumbers[index];
    if (previous !== undefined && current !== undefined && current <= previous) {
      context.addIssue({
        code: "custom",
        message: "page numbers must be strictly ascending",
        path: ["pageNumbers", index],
      });
    }
  }
  if (element.pageNumber !== (element.pageNumbers[0] ?? null)) {
    context.addIssue({
      code: "custom",
      message: "primary page must match the first page number",
      path: ["pageNumber"],
    });
  }
  for (let index = 0; index < element.regions.length; index += 1) {
    const region = element.regions[index];
    if (region === undefined) {
      continue;
    }
    if (!uniquePages.has(region.pageNumber)) {
      context.addIssue({
        code: "custom",
        message: "region page is absent from page numbers",
        path: ["regions", index, "pageNumber"],
      });
    }
    if (
      region.boundingBox.right <= region.boundingBox.left ||
      region.boundingBox.bottom <= region.boundingBox.top
    ) {
      context.addIssue({
        code: "custom",
        message: "region bounding box is empty or inverted",
        path: ["regions", index, "boundingBox"],
      });
    }
    if (region.characterSpan.end < region.characterSpan.start) {
      context.addIssue({
        code: "custom",
        message: "region character span is inverted",
        path: ["regions", index, "characterSpan"],
      });
    }
  }
  if (new Set(element.sourceRefs).size !== element.sourceRefs.length) {
    context.addIssue({
      code: "custom",
      message: "source references must be unique",
      path: ["sourceRefs"],
    });
  }
  if (element.kind === "table") {
    if (
      element.table.rowStart !== 0
      || element.table.rowEnd !== element.table.rowCount
    ) {
      context.addIssue({
        code: "custom",
        message: "canonical table must contain its complete row range",
        path: ["table"],
      });
    }
  }
}
const storedSourceElementRowSchema = z.object({
  element: retrievalSourceElementSchema,
  id: contentIdSchema,
  imageContent: z.instanceof(Buffer).nullable(),
});
const retrievalSourceElementRowSchema = z.object({
  element: retrievalSourceElementSchema,
  id: contentIdSchema,
});
const documentElementSetRowSchema = z.object({
  complete: z.literal(true),
  documentId: contentIdSchema,
  elementCount: z.number().int().positive(),
  id: contentIdSchema,
});
const orderedSourceElementRowSchema = storedSourceElementRowSchema.extend({
  position: z.number().int().nonnegative(),
});

const INSERT_BATCH_SIZE = 500;
const INSERT_BATCH_MAX_BYTES = 8 * 1_024 * 1_024;

export interface DocumentElementSet {
  documentId: string;
  elementCount: number;
  id: string;
}

export interface SourceElementBatch {
  elements: SourceElement[];
  nextPosition: number;
}

export class SourceDocumentStore {
  public constructor(private readonly database: CiteLoomDatabase) {}

  public async writeMany(elements: SourceElement[]): Promise<void> {
    let batch: Array<typeof sourceElements.$inferInsert> = [];
    let batchBytes = 0;
    for (const element of elements) {
      const normalized = readSourceElement(element);
      const row = createStoredSourceElementRow(normalized);
      const rowBytes = measureStoredSourceElementRow(row);
      if (
        batch.length > 0 &&
        (batch.length >= INSERT_BATCH_SIZE ||
          batchBytes + rowBytes > INSERT_BATCH_MAX_BYTES)
      ) {
        await this.database
          .insert(sourceElements)
          .values(batch)
          .onConflictDoNothing({ target: sourceElements.id });
        batch = [];
        batchBytes = 0;
      }
      batch.push(row);
      batchBytes += rowBytes;
    }
    if (batch.length > 0) {
      await this.database
        .insert(sourceElements)
        .values(batch)
        .onConflictDoNothing({ target: sourceElements.id });
    }
  }

  public async writeElementSet(
    documentId: string,
    elements: readonly SourceElement[],
  ): Promise<DocumentElementSet> {
    const normalizedDocumentId = readDocumentId(documentId);
    if (elements.length === 0) {
      throw new Error("A document element set must contain at least one element.");
    }
    const normalizedElements: SourceElement[] = [];
    const elementIds = new Set<string>();
    for (const element of elements) {
      const normalized = readSourceElement(element);
      if (normalized.documentId !== normalizedDocumentId) {
        throw new Error(
          `Source element ${normalized.id} belongs to another document.`,
        );
      }
      if (elementIds.has(normalized.id)) {
        throw new Error(`Duplicate source element ${normalized.id}.`);
      }
      elementIds.add(normalized.id);
      normalizedElements.push(normalized);
    }
    const setId = createElementSetId(
      normalizedDocumentId,
      normalizedElements,
    );
    await this.database
      .insert(documentElementSets)
      .values({
        complete: false,
        documentId: normalizedDocumentId,
        elementCount: normalizedElements.length,
        id: setId,
      })
      .onConflictDoNothing({ target: documentElementSets.id });

    let rows: Array<typeof documentElementSetMembers.$inferInsert> = [];
    for (let position = 0; position < normalizedElements.length; position += 1) {
      const element = normalizedElements[position];
      if (element === undefined) {
        throw new Error(`Missing source element at position ${position}.`);
      }
      rows.push({
        elementId: element.id,
        position,
        setId,
      });
      if (rows.length === INSERT_BATCH_SIZE) {
        await this.writeElementSetMembers(rows);
        rows = [];
      }
    }
    if (rows.length > 0) {
      await this.writeElementSetMembers(rows);
    }

    const countRows = await this.database
      .select({ count: count() })
      .from(documentElementSetMembers)
      .where(eq(documentElementSetMembers.setId, setId));
    if (countRows[0]?.count !== normalizedElements.length) {
      throw new Error(`Document element set ${setId} is incomplete.`);
    }
    await this.database
      .update(documentElementSets)
      .set({ complete: true })
      .where(eq(documentElementSets.id, setId));
    return this.readElementSet(setId);
  }

  public async readElementSet(setId: string): Promise<DocumentElementSet> {
    const normalizedSetId = readElementId(setId);
    const rows = await this.database
      .select({
        complete: documentElementSets.complete,
        documentId: documentElementSets.documentId,
        elementCount: documentElementSets.elementCount,
        id: documentElementSets.id,
      })
      .from(documentElementSets)
      .where(eq(documentElementSets.id, normalizedSetId))
      .limit(1);
    const result = documentElementSetRowSchema.safeParse(rows[0]);
    if (!result.success) {
      throw new Error(`Document element set is missing or incomplete: ${setId}.`);
    }
    return {
      documentId: result.data.documentId,
      elementCount: result.data.elementCount,
      id: result.data.id,
    };
  }

  public async readElementBatch(
    setId: string,
    startPosition: number,
    limit: number,
    sourceFile?: string,
  ): Promise<SourceElementBatch> {
    const normalizedSetId = readElementId(setId);
    const normalizedStart = readBatchPosition(startPosition);
    const normalizedLimit = readBatchLimit(limit);
    const rows = await this.database
      .select({
        element: sourceElements.element,
        id: sourceElements.id,
        imageContent: sourceElements.imageContent,
        position: documentElementSetMembers.position,
      })
      .from(documentElementSetMembers)
      .innerJoin(
        sourceElements,
        eq(sourceElements.id, documentElementSetMembers.elementId),
      )
      .where(and(
        eq(documentElementSetMembers.setId, normalizedSetId),
        gte(documentElementSetMembers.position, normalizedStart),
      ))
      .orderBy(asc(documentElementSetMembers.position))
      .limit(normalizedLimit);
    const elements: SourceElement[] = [];
    for (let offset = 0; offset < rows.length; offset += 1) {
      const result = orderedSourceElementRowSchema.safeParse(rows[offset]);
      if (!result.success) {
        throw new Error(
          `Invalid ordered source element row: ${result.error.message}`,
        );
      }
      const expectedPosition = normalizedStart + offset;
      if (result.data.position !== expectedPosition) {
        throw new Error(
          `Document element set ${normalizedSetId} has a gap at position ${expectedPosition}.`,
        );
      }
      const storedElement = restoreSourceElement(result.data);
      const element = sourceFile === undefined
        ? storedElement
        : replaceSourceFile(storedElement, sourceFile);
      elements.push(element);
    }
    return {
      elements,
      nextPosition: normalizedStart + elements.length,
    };
  }

  public async readAllElements(
    setId: string,
    sourceFile?: string,
  ): Promise<SourceElement[]> {
    const elementSet = await this.readElementSet(setId);
    const elements: SourceElement[] = [];
    let position = 0;
    while (position < elementSet.elementCount) {
      const batch = await this.readElementBatch(
        elementSet.id,
        position,
        INSERT_BATCH_SIZE,
        sourceFile,
      );
      if (batch.elements.length === 0) {
        throw new Error(
          `Document element set ${elementSet.id} ended at position ${position}.`,
        );
      }
      elements.push(...batch.elements);
      position = batch.nextPosition;
    }
    return elements;
  }

  public async containsElement(setId: string, elementId: string): Promise<boolean> {
    const normalizedSetId = readElementId(setId);
    const normalizedElementId = readElementId(elementId);
    const rows = await this.database
      .select({ position: documentElementSetMembers.position })
      .from(documentElementSetMembers)
      .where(and(
        eq(documentElementSetMembers.setId, normalizedSetId),
        eq(documentElementSetMembers.elementId, normalizedElementId),
      ))
      .limit(1);
    return rows.length === 1;
  }

  public async readMany(
    ids: string[],
    sourceFile?: string,
  ): Promise<SourceElement[]> {
    if (ids.length === 0) {
      return [];
    }
    const normalizedIds = ids.map(readElementId);
    const elementsById = new Map<string, SourceElement>();
    for (
      let start = 0;
      start < normalizedIds.length;
      start += INSERT_BATCH_SIZE
    ) {
      const batchIds = normalizedIds.slice(start, start + INSERT_BATCH_SIZE);
      const rows = await this.database
        .select({
          element: sourceElements.element,
          id: sourceElements.id,
          imageContent: sourceElements.imageContent,
        })
        .from(sourceElements)
        .where(inArray(sourceElements.id, batchIds));
      for (const row of rows) {
        const result = storedSourceElementRowSchema.safeParse(row);
        if (!result.success) {
          throw new Error(`Invalid source element row: ${result.error.message}`);
        }
        elementsById.set(result.data.id, restoreSourceElement(result.data));
      }
    }

    const elements: SourceElement[] = [];
    for (const id of normalizedIds) {
      const element = elementsById.get(id);
      if (element === undefined) {
        throw new Error(`Stored source element is missing: ${id}`);
      }
      elements.push(
        sourceFile === undefined ? element : replaceSourceFile(element, sourceFile),
      );
    }
    return elements;
  }

  public async readManyForRetrieval(
    ids: string[],
    sourceFile?: string,
  ): Promise<RetrievalSourceElement[]> {
    return this.readManyForRetrievalFrom(this.database, ids, sourceFile);
  }

  public async readManyForRetrievalFrom(
    database: CiteLoomDatabase,
    ids: string[],
    sourceFile?: string,
  ): Promise<RetrievalSourceElement[]> {
    if (ids.length === 0) {
      return [];
    }
    const normalizedIds = ids.map(readElementId);
    const elementsById = new Map<string, RetrievalSourceElement>();
    for (
      let start = 0;
      start < normalizedIds.length;
      start += INSERT_BATCH_SIZE
    ) {
      const batchIds = normalizedIds.slice(start, start + INSERT_BATCH_SIZE);
      const rows = await database
        .select({ element: sourceElements.element, id: sourceElements.id })
        .from(sourceElements)
        .where(inArray(sourceElements.id, batchIds));
      for (const row of rows) {
        const result = retrievalSourceElementRowSchema.safeParse(row);
        if (!result.success) {
          throw new Error(
            `Invalid retrieval source element row: ${result.error.message}`,
          );
        }
        elementsById.set(result.data.id, result.data.element);
      }
    }

    const elements: RetrievalSourceElement[] = [];
    for (const id of normalizedIds) {
      const element = elementsById.get(id);
      if (element === undefined) {
        throw new Error(`Stored source element is missing: ${id}`);
      }
      elements.push(
        sourceFile === undefined ? element : replaceSourceFile(element, sourceFile),
      );
    }
    return elements;
  }

  public async deleteMany(ids: string[]): Promise<void> {
    if (ids.length === 0) {
      return;
    }
    await this.database
      .delete(sourceElements)
      .where(inArray(sourceElements.id, ids.map(readElementId)));
  }

  private async writeElementSetMembers(
    rows: Array<typeof documentElementSetMembers.$inferInsert>,
  ): Promise<void> {
    await this.database
      .insert(documentElementSetMembers)
      .values(rows)
      .onConflictDoNothing({
        target: [
          documentElementSetMembers.setId,
          documentElementSetMembers.position,
        ],
      });
  }
}

export type SourceDocumentTransaction = Parameters<
  Parameters<CiteLoomDatabase["transaction"]>[0]
>[0];

export async function deleteStoredDocumentEvidence(
  transaction: SourceDocumentTransaction,
  documentId: string,
): Promise<void> {
  while (true) {
    const setRows = await transaction
      .select({ id: documentElementSets.id })
      .from(documentElementSets)
      .where(eq(documentElementSets.documentId, documentId))
      .limit(1);
    const setId = setRows[0]?.id;
    if (setId === undefined) {
      break;
    }
    while (true) {
      const memberRows = await transaction
        .select({ position: documentElementSetMembers.position })
        .from(documentElementSetMembers)
        .where(eq(documentElementSetMembers.setId, setId))
        .limit(INSERT_BATCH_SIZE);
      const positions = memberRows.map((row) => row.position);
      if (positions.length === 0) {
        break;
      }
      await transaction
        .delete(documentElementSetMembers)
        .where(and(
          eq(documentElementSetMembers.setId, setId),
          inArray(documentElementSetMembers.position, positions),
        ));
    }
    await transaction
      .delete(documentElementSets)
      .where(eq(documentElementSets.id, setId));
  }

  while (true) {
    const elementRows = await transaction
      .select({ id: sourceElements.id })
      .from(sourceElements)
      .where(eq(sourceElements.documentId, documentId))
      .limit(INSERT_BATCH_SIZE);
    const ids = elementRows.map((row) => row.id);
    if (ids.length === 0) {
      break;
    }
    await transaction
      .delete(sourceElements)
      .where(inArray(sourceElements.id, ids));
  }
  await queueSourceContentDeletion(transaction, documentId);
}

function createElementSetId(
  documentId: string,
  elements: readonly SourceElement[],
): string {
  const hash = createHash("sha256");
  updateLengthPrefixedHash(hash, documentId);
  for (const element of elements) {
    updateLengthPrefixedHash(hash, element.id);
  }
  return hash.digest("hex");
}

function updateLengthPrefixedHash(
  hash: ReturnType<typeof createHash>,
  value: string,
): void {
  const bytes = Buffer.byteLength(value, "utf8");
  hash.update(String(bytes));
  hash.update(":");
  hash.update(value);
}

function readBatchPosition(value: number): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`Invalid element batch position: ${value}.`);
  }
  return value;
}

function readBatchLimit(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > INSERT_BATCH_SIZE) {
    throw new Error(
      `Element batch limit must be between 1 and ${INSERT_BATCH_SIZE}.`,
    );
  }
  return value;
}

function createStoredSourceElementRow(
  element: SourceElement,
): typeof sourceElements.$inferInsert {
  if (element.kind === "image") {
    const { content, ...metadata } = element;
    return {
      documentId: element.documentId,
      element: metadata,
      id: element.id,
      imageContent: Buffer.from(content, "base64"),
    };
  }
  return {
    documentId: element.documentId,
    element,
    id: element.id,
    imageContent: null,
  };
}

function measureStoredSourceElementRow(
  row: typeof sourceElements.$inferInsert,
): number {
  const metadataBytes = Buffer.byteLength(JSON.stringify({
    documentId: row.documentId,
    element: row.element,
    id: row.id,
  }), "utf8");
  return metadataBytes + (row.imageContent?.byteLength ?? 0);
}

function restoreSourceElement(
  row: z.output<typeof storedSourceElementRowSchema>,
): SourceElement {
  if (row.id !== row.element.id) {
    throw new Error(`Stored source element id differs from row id: ${row.id}.`);
  }
  if (row.element.kind === "image") {
    if (row.imageContent === null || row.imageContent.byteLength === 0) {
      throw new Error(`Stored image content is missing: ${row.id}.`);
    }
    return {
      ...row.element,
      content: row.imageContent.toString("base64"),
    };
  }
  if (row.imageContent !== null) {
    throw new Error(`Non-image source element has image content: ${row.id}.`);
  }
  return row.element;
}

function readSourceElement(value: unknown): SourceElement {
  const result = sourceElementSchema.safeParse(value);
  if (!result.success) {
    throw new Error(`Invalid source element: ${result.error.message}`);
  }
  return result.data;
}

function readDocumentId(value: string): string {
  const result = contentIdSchema.safeParse(value);
  if (!result.success) {
    throw new Error(`Invalid document id: ${value}`);
  }
  return result.data;
}

function readElementId(value: string): string {
  const result = contentIdSchema.safeParse(value);
  if (!result.success) {
    throw new Error(`Invalid source element id: ${value}`);
  }
  return result.data;
}

function replaceSourceFile<Element extends { sourceFile: string }>(
  element: Element,
  sourceFile: string,
): Element {
  return { ...element, sourceFile };
}
