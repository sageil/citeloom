import { describe, expect, it, vi } from "vitest";

import type {
  RequestIngestionControlResult,
  ResumeIngestionResult,
} from "../src/documents/catalog/index.js";
import type {
  RetryFailedIngestionResult,
} from "../src/ingestion/service.js";
import {
  buildWebServer,
  type RuntimeWebServices,
} from "../src/web-server.js";
import {
  buildConfig,
  buildPendingJob,
  buildServices,
  type TestWebServiceOverrides,
} from "./web-server-fixture.js";

describe("ingestion API boundary", () => {
  it("resumes a paused ingestion with the authenticated actor", async () => {
    const sourceFile = "/documents/uploads/request/document.pdf";
    const resumeIngestion = vi.fn<RuntimeWebServices["resumeIngestion"]>(
      async () => ({
        job: buildPendingJob(sourceFile),
        kind: "resumed",
      }),
    );
    const server = await buildIngestionTestServer({ resumeIngestion });

    try {
      const response = await server.inject({
        method: "POST",
        payload: { sourceFile },
        url: "/api/ingestion-jobs/resume",
      });

      expect(response.statusCode).toBe(202);
      expect(response.json()).toEqual({
        action: "resume",
        sourceFile,
        state: "pending",
      });
      expect(resumeIngestion).toHaveBeenCalledWith(
        expect.objectContaining({ username: "disabled-authentication" }),
        sourceFile,
        {
          isAdministrator: true,
          userId: "00000000-0000-4000-8000-000000000000",
        },
      );
    } finally {
      await server.close();
    }
  });

  it("maps resume failures to stable HTTP responses", async () => {
    const sourceFile = "/documents/uploads/request/document.pdf";
    const cases: readonly {
      expectedMessage: string;
      expectedStatus: number;
      result: ResumeIngestionResult;
    }[] = [
      {
        expectedMessage: "The ingestion job was not found.",
        expectedStatus: 404,
        result: { kind: "not-found" },
      },
      {
        expectedMessage: "The ingestion job is not paused.",
        expectedStatus: 409,
        result: { kind: "not-paused" },
      },
      {
        expectedMessage:
          "Only the uploader or an administrator can resume this ingestion.",
        expectedStatus: 403,
        result: { kind: "forbidden" },
      },
    ];

    for (const testCase of cases) {
      const resumeIngestion = vi.fn<RuntimeWebServices["resumeIngestion"]>(
        async () => testCase.result,
      );
      const server = await buildIngestionTestServer({ resumeIngestion });
      try {
        const response = await server.inject({
          method: "POST",
          payload: { sourceFile },
          url: "/api/ingestion-jobs/resume",
        });

        expect(response.statusCode).toBe(testCase.expectedStatus);
        expect(response.json()).toMatchObject({
          error: { message: testCase.expectedMessage },
        });
      } finally {
        await server.close();
      }
    }
  });

  it("returns accepted and completed cancellation states", async () => {
    const sourceFile = "/documents/uploads/request/document.pdf";
    const cancelRequestedJob = {
      ...buildPendingJob(sourceFile),
      controlState: "cancel_requested" as const,
    };
    const cases: readonly {
      expectedBody: {
        action: "cancel";
        sourceFile: string;
        state: "cancel_requested" | "canceled";
      };
      expectedStatus: number;
      result: RequestIngestionControlResult;
    }[] = [
      {
        expectedBody: {
          action: "cancel",
          sourceFile,
          state: "cancel_requested",
        },
        expectedStatus: 202,
        result: { job: cancelRequestedJob, kind: "accepted" },
      },
      {
        expectedBody: {
          action: "cancel",
          sourceFile,
          state: "canceled",
        },
        expectedStatus: 200,
        result: { kind: "canceled", sourceFile },
      },
    ];

    for (const testCase of cases) {
      const requestIngestionControl = vi.fn<
        RuntimeWebServices["requestIngestionControl"]
      >(async () => testCase.result);
      const server = await buildIngestionTestServer({
        requestIngestionControl,
      });
      try {
        const response = await server.inject({
          method: "POST",
          payload: { sourceFile },
          url: "/api/ingestion-jobs/cancel",
        });

        expect(response.statusCode).toBe(testCase.expectedStatus);
        expect(response.json()).toEqual(testCase.expectedBody);
        expect(requestIngestionControl).toHaveBeenCalledWith(
          expect.objectContaining({ username: "disabled-authentication" }),
          sourceFile,
          "cancel",
          {
            isAdministrator: true,
            userId: "00000000-0000-4000-8000-000000000000",
          },
        );
      } finally {
        await server.close();
      }
    }
  });

  it("maps pause and cancel failures to stable HTTP responses", async () => {
    const sourceFile = "/documents/uploads/request/document.pdf";
    const cases: readonly {
      action: "pause" | "cancel";
      expectedMessage: string;
      expectedStatus: number;
      result: RequestIngestionControlResult;
    }[] = [
      {
        action: "pause",
        expectedMessage: "The ingestion job was not found.",
        expectedStatus: 404,
        result: { kind: "not-found" },
      },
      {
        action: "pause",
        expectedMessage:
          "Only the uploader or an administrator can pause this ingestion.",
        expectedStatus: 403,
        result: { kind: "forbidden" },
      },
      {
        action: "pause",
        expectedMessage: "This ingestion cannot be paused from active.",
        expectedStatus: 409,
        result: { controlState: "active", kind: "invalid", state: "running" },
      },
      {
        action: "cancel",
        expectedMessage: "The ingestion job was not found.",
        expectedStatus: 404,
        result: { kind: "not-found" },
      },
      {
        action: "cancel",
        expectedMessage:
          "Only the uploader or an administrator can cancel this ingestion.",
        expectedStatus: 403,
        result: { kind: "forbidden" },
      },
      {
        action: "cancel",
        expectedMessage: "This ingestion cannot be canceled from paused.",
        expectedStatus: 409,
        result: { controlState: "paused", kind: "invalid", state: "pending" },
      },
      {
        action: "cancel",
        expectedMessage: "The request could not be completed.",
        expectedStatus: 500,
        result: { error: "Source cleanup failed.", kind: "cleanup-failed" },
      },
    ];

    for (const testCase of cases) {
      const requestIngestionControl = vi.fn<
        RuntimeWebServices["requestIngestionControl"]
      >(async () => testCase.result);
      const server = await buildIngestionTestServer({
        requestIngestionControl,
      });
      try {
        const response = await server.inject({
          method: "POST",
          payload: { sourceFile },
          url: `/api/ingestion-jobs/${testCase.action}`,
        });

        expect(response.statusCode).toBe(testCase.expectedStatus);
        expect(response.json()).toMatchObject({
          error: { message: testCase.expectedMessage },
        });
      } finally {
        await server.close();
      }
    }
  });

  it("maps a rejected retry restart to conflict", async () => {
    const sourceFile = "/documents/uploads/request/document.pdf";
    const result: RetryFailedIngestionResult = {
      error: "The stored upload is no longer available.",
      kind: "restart-rejected",
    };
    const retryFailedJob = vi.fn<RuntimeWebServices["retryFailedJob"]>(
      async () => result,
    );
    const server = await buildIngestionTestServer({ retryFailedJob });

    try {
      const response = await server.inject({
        method: "POST",
        payload: { sourceFile },
        url: "/api/ingestion-jobs/retry",
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        error: { message: result.error },
      });
    } finally {
      await server.close();
    }
  });
});

async function buildIngestionTestServer(
  overrides: TestWebServiceOverrides,
) {
  return buildWebServer(buildConfig(), {
    authentication: "disabled",
    logger: false,
    services: buildServices(overrides),
    staticDirectory: null,
  });
}
