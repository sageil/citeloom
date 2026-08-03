import {
  and,
  count,
  desc,
  eq,
  inArray,
  isNull,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { z } from "zod";

import type { CiteLoomDatabase } from "../database/client.js";
import {
  applicationErrorEvents,
  doclingErrorDetails,
} from "../database/schema.js";
import type {
  ApplicationErrorElementKind,
  ApplicationErrorOrigin,
  ApplicationErrorSeverity,
} from "./application-errors.js";

export const APPLICATION_ERROR_AREAS = [
  "ingestion",
  "application",
  "general",
] as const;

export type ApplicationErrorArea = (typeof APPLICATION_ERROR_AREAS)[number];
export type ApplicationErrorAreaFilter = "all" | ApplicationErrorArea;
export type ApplicationErrorPageSize = 25 | 50 | 100;

export interface ApplicationErrorPageRequest {
  area: ApplicationErrorAreaFilter;
  page: number;
  pageSize: ApplicationErrorPageSize;
}

export interface ApplicationErrorAreaCounts {
  all: number;
  application: number;
  general: number;
  ingestion: number;
}

export interface ApplicationErrorDoclingDetail {
  category: string;
  componentType: string;
  doclingLabel: string | null;
  elementKind: ApplicationErrorElementKind | null;
  message: string;
  moduleName: string;
  pageNumber: number | null;
  pageRangeEnd: number | null;
  pageRangeStart: number | null;
  sequence: number;
  sourceRef: string | null;
}

export interface ApplicationErrorRecord {
  area: ApplicationErrorArea;
  attemptNumber: number | null;
  category: string;
  code: string;
  documentId: string | null;
  doclingErrors: ApplicationErrorDoclingDetail[];
  id: string;
  instance: string | null;
  jobId: string | null;
  message: string;
  occurredAt: string;
  operation: string;
  origin: ApplicationErrorOrigin;
  release: string | null;
  requestId: string | null;
  requestSequence: number | null;
  retryable: boolean | null;
  runId: string | null;
  service: string;
  severity: ApplicationErrorSeverity;
  sourceFile: string | null;
  stackFingerprint: string | null;
  taskId: string | null;
  workspaceId: string | null;
}

export interface ApplicationErrorPage {
  counts: ApplicationErrorAreaCounts;
  errors: ApplicationErrorRecord[];
  generatedAt: string;
  page: number;
  pageCount: number;
  pageSize: ApplicationErrorPageSize;
  total: number;
}

export interface ApplicationErrorPurgeResult {
  deleted: number;
}

const applicationErrorPurgeResultSchema = z.object({
  deleted: z.coerce.number().int().nonnegative(),
});

const ingestionOrigins: ApplicationErrorOrigin[] = [
  "ingestion",
  "docling-transport",
  "docling-task",
  "docling-conversion",
  "docling-normalization",
  "docling-element",
];
const applicationOrigins: ApplicationErrorOrigin[] = [
  "http-request",
  "streaming-answer",
  "inference-provider",
];
const generalOrigins: ApplicationErrorOrigin[] = [
  "worker",
  "scheduler",
  "background-task",
  "settings-reload",
  "database-operation",
  "startup",
  "cli",
];

export async function readApplicationErrorPage(
  database: CiteLoomDatabase,
  workspaceId: string,
  request: ApplicationErrorPageRequest,
): Promise<ApplicationErrorPage> {
  const workspaceCondition = buildApplicationErrorVisibilityCondition(
    workspaceId,
  );
  const areaCondition = buildApplicationErrorAreaCondition(request.area);
  const pageCondition = areaCondition === undefined
    ? workspaceCondition
    : and(workspaceCondition, areaCondition);

  const [originCounts, totalRows, eventRows] = await Promise.all([
    database
      .select({
        origin: applicationErrorEvents.origin,
        value: count(),
      })
      .from(applicationErrorEvents)
      .where(workspaceCondition)
      .groupBy(applicationErrorEvents.origin),
    database
      .select({ value: count() })
      .from(applicationErrorEvents)
      .where(pageCondition),
    database
      .select()
      .from(applicationErrorEvents)
      .where(pageCondition)
      .orderBy(
        desc(applicationErrorEvents.occurredAt),
        desc(applicationErrorEvents.id),
      )
      .limit(request.pageSize)
      .offset((request.page - 1) * request.pageSize),
  ]);

  const counts = buildApplicationErrorAreaCounts(originCounts);
  const total = totalRows[0]?.value ?? 0;
  const eventIds = eventRows.map((event) => event.id);
  const detailRows = eventIds.length === 0
    ? []
    : await database
      .select()
      .from(doclingErrorDetails)
      .where(inArray(doclingErrorDetails.applicationErrorId, eventIds))
      .orderBy(
        doclingErrorDetails.applicationErrorId,
        doclingErrorDetails.sequence,
      );
  const detailsByEvent = groupDoclingErrorDetails(detailRows);
  const errors: ApplicationErrorRecord[] = [];
  for (const event of eventRows) {
    errors.push({
      area: readApplicationErrorArea(event.origin),
      attemptNumber: event.attemptNumber,
      category: event.category,
      code: event.code,
      documentId: event.documentId,
      doclingErrors: detailsByEvent.get(event.id) ?? [],
      id: event.id,
      instance: event.instance,
      jobId: event.jobId,
      message: event.message,
      occurredAt: event.occurredAt.toISOString(),
      operation: event.operation,
      origin: event.origin,
      release: event.release,
      requestId: event.requestId,
      requestSequence: event.requestSequence,
      retryable: event.retryable,
      runId: event.runId,
      service: event.service,
      severity: event.severity,
      sourceFile: event.sourceFile,
      stackFingerprint: event.stackFingerprint,
      taskId: event.taskId,
      workspaceId: event.workspaceId,
    });
  }

  return {
    counts,
    errors,
    generatedAt: new Date().toISOString(),
    page: request.page,
    pageCount: total === 0 ? 0 : Math.ceil(total / request.pageSize),
    pageSize: request.pageSize,
    total,
  };
}

export async function purgeApplicationErrors(
  database: CiteLoomDatabase,
  workspaceId: string,
): Promise<ApplicationErrorPurgeResult> {
  return database.transaction(async (transaction) => {
    const visibilityCondition = buildApplicationErrorVisibilityCondition(
      workspaceId,
    );
    const result = await transaction.execute(sql`
      with deleted as (
        delete from ${applicationErrorEvents}
        where ${visibilityCondition}
        returning 1
      )
      select count(*)::integer as deleted from deleted
    `);
    return applicationErrorPurgeResultSchema.parse(result.rows[0]);
  });
}

export function readApplicationErrorArea(
  origin: ApplicationErrorOrigin,
): ApplicationErrorArea {
  if (ingestionOrigins.includes(origin)) {
    return "ingestion";
  }
  if (applicationOrigins.includes(origin)) {
    return "application";
  }
  return "general";
}

function buildApplicationErrorAreaCondition(
  area: ApplicationErrorAreaFilter,
): SQL | undefined {
  if (area === "ingestion") {
    return inArray(applicationErrorEvents.origin, ingestionOrigins);
  }
  if (area === "application") {
    return inArray(applicationErrorEvents.origin, applicationOrigins);
  }
  if (area === "general") {
    return inArray(applicationErrorEvents.origin, generalOrigins);
  }
  return undefined;
}

function buildApplicationErrorVisibilityCondition(workspaceId: string): SQL {
  const condition = or(
    isNull(applicationErrorEvents.workspaceId),
    eq(applicationErrorEvents.workspaceId, workspaceId),
  );
  if (condition === undefined) {
    throw new Error("Application error visibility requires a workspace.");
  }
  return condition;
}

function buildApplicationErrorAreaCounts(
  rows: Array<{ origin: ApplicationErrorOrigin; value: number }>,
): ApplicationErrorAreaCounts {
  const counts: ApplicationErrorAreaCounts = {
    all: 0,
    application: 0,
    general: 0,
    ingestion: 0,
  };
  for (const row of rows) {
    const area = readApplicationErrorArea(row.origin);
    counts[area] += row.value;
    counts.all += row.value;
  }
  return counts;
}

function groupDoclingErrorDetails(
  rows: Array<typeof doclingErrorDetails.$inferSelect>,
): Map<string, ApplicationErrorDoclingDetail[]> {
  const grouped = new Map<string, ApplicationErrorDoclingDetail[]>();
  for (const row of rows) {
    const details = grouped.get(row.applicationErrorId) ?? [];
    details.push({
      category: row.category,
      componentType: row.componentType,
      doclingLabel: row.doclingLabel,
      elementKind: row.elementKind,
      message: row.message,
      moduleName: row.moduleName,
      pageNumber: row.pageNumber,
      pageRangeEnd: row.pageRangeEnd,
      pageRangeStart: row.pageRangeStart,
      sequence: row.sequence,
      sourceRef: row.sourceRef,
    });
    grouped.set(row.applicationErrorId, details);
  }
  return grouped;
}
