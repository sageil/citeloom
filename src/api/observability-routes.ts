import type { ServerResponse } from "node:http";

import type { FastifyInstance } from "fastify";

import type {
  ApplicationStateRevisionSnapshot,
  ApplicationStateRevisionSubscriber,
} from "../app/application-state-revisions.js";
import type { AuthorizationPrincipal } from "../auth/model.js";
import type {
  ApplicationErrorPage,
  ApplicationErrorPageRequest,
  ApplicationErrorPurgeResult,
} from "../observability/application-error-store.js";
import type { DoctorCheck, DoctorLiveChecks } from "../observability/doctor.js";
import {
  requireGlobalAdministratorPrincipal,
  requireRequestPrincipal,
  requireWorkspaceAdministratorPrincipal,
} from "./authentication-routes.js";
import {
  buildDashboardResponse,
  buildDiagnosticResponseChecks,
  type DashboardResponse,
  type DashboardRuntimeServices,
  type HealthResponse,
} from "./dashboard-response.js";
import {
  decodeApplicationErrorQuery,
  decodeDiagnosticRequest,
} from "./request-boundary.js";

export interface ObservabilityRouteServices extends RevisionStreamServices {
  purgeApplicationErrors: (
    principal: AuthorizationPrincipal,
  ) => Promise<ApplicationErrorPurgeResult>;
  readApplicationErrors: (
    principal: AuthorizationPrincipal,
    request: ApplicationErrorPageRequest,
  ) => Promise<ApplicationErrorPage>;
  run: <T>(
    operation: (runtime: DashboardRuntimeServices) => Promise<T>,
  ) => Promise<T>;
}

export interface ObservabilityRouteOptions {
  maximumUploadRequestBytes: number;
  requestPrincipals: WeakMap<object, AuthorizationPrincipal>;
  runDiagnostics: (liveChecks: DoctorLiveChecks) => Promise<DoctorCheck[]>;
  services: ObservabilityRouteServices;
}

export interface RevisionStreamServices {
  readRevisions: () => Promise<ApplicationStateRevisionSnapshot>;
  subscribeRevisions: (
    subscriber: ApplicationStateRevisionSubscriber,
  ) => () => void;
}

export function registerObservabilityRoutes(
  server: FastifyInstance,
  options: ObservabilityRouteOptions,
): void {
  const {
    maximumUploadRequestBytes,
    requestPrincipals,
    runDiagnostics,
    services,
  } = options;

  server.get("/api/dashboard", async (request): Promise<DashboardResponse> => {
    const principal = requireRequestPrincipal(requestPrincipals, request);
    return services.run(async (runtime) => {
      return buildDashboardResponse(
        runtime,
        principal,
        maximumUploadRequestBytes,
      );
    });
  });

  server.get("/api/errors", async (request) => {
    const principal = requireRequestPrincipal(requestPrincipals, request);
    requireWorkspaceAdministratorPrincipal(
      requestPrincipals,
      request,
      principal.workspaceId,
    );
    const errorRequest = decodeApplicationErrorQuery(request.query);
    return services.readApplicationErrors(principal, errorRequest);
  });

  server.delete("/api/errors", async (request) => {
    const principal = requireRequestPrincipal(requestPrincipals, request);
    requireWorkspaceAdministratorPrincipal(
      requestPrincipals,
      request,
      principal.workspaceId,
    );
    return services.purgeApplicationErrors(principal);
  });

  server.get("/api/events", (_request, reply) => {
    reply.hijack();
    openApplicationStateRevisionEventStream(reply.raw, services);
    return reply;
  });

  server.post("/api/diagnostics", async (request): Promise<HealthResponse> => {
    requireGlobalAdministratorPrincipal(requestPrincipals, request);
    const diagnostics = decodeDiagnosticRequest(request.body);
    const checks = await runDiagnostics(diagnostics.liveChecks);
    return {
      checks: buildDiagnosticResponseChecks(checks),
      generatedAt: new Date().toISOString(),
    };
  });
}

export function formatApplicationStateRevisionEvent(
  revisions: ApplicationStateRevisionSnapshot,
): string {
  const id = `${revisions.catalog}.${revisions.jobs}.${revisions.settings}`;
  return `id: ${id}\nevent: revision\ndata: ${JSON.stringify(revisions)}\n\n`;
}

export function openApplicationStateRevisionEventStream(
  response: ServerResponse,
  services: RevisionStreamServices,
): () => void {
  response.writeHead(200, {
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "Content-Type": "text/event-stream; charset=utf-8",
    "X-Accel-Buffering": "no",
  });
  response.write("retry: 1000\n\n");
  let closed = false;
  let reading = false;
  let refreshQueued = false;
  const publish = (): void => {
    refreshQueued = true;
    if (reading || closed) {
      return;
    }
    reading = true;
    void publishQueuedRevisions();
  };
  const publishQueuedRevisions = async (): Promise<void> => {
    try {
      while (refreshQueued && !closed) {
        refreshQueued = false;
        const revisions = await services.readRevisions();
        if (!closed) {
          response.write(formatApplicationStateRevisionEvent(revisions));
        }
      }
    } catch {
      close();
    } finally {
      reading = false;
      if (refreshQueued && !closed) {
        publish();
      }
    }
  };
  const unsubscribe = services.subscribeRevisions(publish);
  const heartbeat = setInterval(() => {
    if (!closed) {
      response.write(": keep-alive\n\n");
    }
  }, 15_000);
  heartbeat.unref();
  const close = (): void => {
    if (closed) {
      return;
    }
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
    response.end();
  };
  response.once("close", close);
  publish();
  return close;
}
