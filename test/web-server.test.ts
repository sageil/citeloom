import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";
import { createUIMessageStream, type InferUIMessageChunk } from "ai";

import type { CiteLoomUIMessage } from "../src/answers/stream.js";
import {
  type EffectiveApplicationSettings,
  SettingsVersionConflictError,
} from "../src/app/settings.js";
import type { PendingIngestionJob } from "../src/documents/catalog/index.js";
import type { StagedIngestionDocument } from "../src/ingestion/service.js";
import type {
  BrowserDocument,
  BrowseDocumentCatalogRequest,
  BrowseDocumentCatalogResult,
} from "../src/documents/catalog/browser.js";
import {
  type AppConfig,
  type RuntimeSettings,
} from "../src/config/index.js";
import { createTestProviderSettings } from "./provider-settings-fixture.js";
import { readProviderConnectionConfiguration } from "../src/providers/profiles.js";
import {
  SourceDiscoveryScopeError,
  SourceDiscoveryUnavailableError,
} from "../src/retrieval/discovery/pipeline.js";
import type {
  SourceDiscoveryResponse,
} from "../src/retrieval/discovery/schema.js";
import { TextToSpeechUnavailableError } from "../src/providers/text-to-speech.js";
import {
  SpeechToTextProviderError,
  SpeechToTextTimeoutError,
} from "../src/providers/speech-to-text.js";
import {
  buildWebServer as buildProductionWebServer,
  openApplicationStateRevisionEventStream,
  type BuildWebServerOptions,
  type QuestionRequest,
  type RuntimeWebServices,
  type WebServices,
} from "../src/web-server.js";
import {
  createTestRuntimeSettings,
  readEqualWeightTestConfig,
  TEST_PLAIN_EMBEDDING_INPUT_FORMAT,
} from "./config-fixture.js";
import { createDeferred } from "./deferred-fixture.js";
import type { AuthenticatedPrincipal } from "../src/auth/model.js";
import {
  AuthenticationRejectedError,
  WorkspaceAuthorizationError,
} from "../src/auth/store.js";

const temporaryDirectories: string[] = [];

async function buildWebServer(
  config: AppConfig,
  options: BuildWebServerOptions,
) {
  return buildProductionWebServer(config, {
    ...options,
    authentication: "disabled",
  });
}

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

describe("web server boundary", () => {
  it("fails closed for unauthenticated API requests", async () => {
    const server = await buildProductionWebServer(buildConfig(), {
      logger: false,
      services: buildServices(),
      staticDirectory: null,
    });
    try {
      const response = await server.inject({ method: "GET", url: "/api/dashboard" });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({
        error: { message: "Authentication is required." },
      });
    } finally {
      await server.close();
    }
  });

  it("returns a generic internal error with its recorded error ID", async () => {
    const browseDocuments = vi.fn<RuntimeWebServices["browseDocuments"]>(
      async () => {
        const error = new Error("private database query detail");
        Object.assign(error, { statusCode: 501 });
        throw error;
      },
    );
    const reportApplicationError = vi.fn<WebServices["reportApplicationError"]>(
      async () => ({ id: "00000000-0000-4000-8000-000000000098" }),
    );
    const server = await buildWebServer(buildConfig(), {
      logger: false,
      services: buildServices({
        browseDocuments,
        reportApplicationError,
      }),
      staticDirectory: null,
    });

    try {
      const response = await server.inject({
        method: "GET",
        url: "/api/dashboard",
      });

      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({
        error: {
          code: "internal_error",
          id: "00000000-0000-4000-8000-000000000098",
          message: "The request could not be completed.",
        },
      });
      expect(response.body).not.toContain("private database query detail");
      expect(reportApplicationError).toHaveBeenCalledTimes(1);
    } finally {
      await server.close();
    }
  });

  it("does not record a wrapped expected request cancellation", async () => {
    const browseDocuments = vi.fn<RuntimeWebServices["browseDocuments"]>(
      async () => {
        const cancellation = new DOMException("client left", "AbortError");
        throw new AggregateError([
          new Error("request wrapper", { cause: cancellation }),
        ]);
      },
    );
    const reportApplicationError = vi.fn<WebServices["reportApplicationError"]>(
      async () => ({ id: "00000000-0000-4000-8000-000000000097" }),
    );
    const server = await buildWebServer(buildConfig(), {
      logger: false,
      services: buildServices({
        browseDocuments,
        reportApplicationError,
      }),
      staticDirectory: null,
    });

    try {
      const response = await server.inject({
        method: "GET",
        url: "/api/dashboard",
      });

      expect(response.statusCode).toBe(499);
      expect(response.json()).toEqual({
        error: {
          code: "request_cancelled",
          message: "The request was cancelled.",
        },
      });
      expect(reportApplicationError).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("only exposes the login shell to unauthenticated browser requests", async () => {
    const staticDirectory = await mkdtemp(join(tmpdir(), "citeloom-login-boundary-"));
    temporaryDirectories.push(staticDirectory);
    await writeFile(join(staticDirectory, "index.html"), "<main>CiteLoom</main>");
    const scriptsDirectory = join(staticDirectory, "assets", "scripts");
    await mkdir(scriptsDirectory, { recursive: true });
    await writeFile(
      join(scriptsDirectory, "citeloom-dashboard-extensions.js"),
      "export const loaded = true;",
    );
    await writeFile(
      join(scriptsDirectory, "citeloom-bootstrap.js"),
      "window.citeloomBootstrapLoaded = true;",
    );
    await writeFile(
      join(scriptsDirectory, "citeloom-notices.js"),
      "export const noticeEvent = 'citeloom:notice';",
    );
    const server = await buildProductionWebServer(buildConfig(), {
      logger: false,
      services: buildServices(),
      staticDirectory,
    });

    try {
      const loginResponse = await server.inject({ method: "GET", url: "/login" });
      expect(loginResponse.statusCode).toBe(200);
      expect(loginResponse.body).toBe("<main>CiteLoom</main>");

      const dependencyResponse = await server.inject({
        method: "GET",
        url: "/assets/scripts/citeloom-dashboard-extensions.js",
      });
      expect(dependencyResponse.statusCode).toBe(200);
      expect(dependencyResponse.body).toBe("export const loaded = true;");

      const bootstrapResponse = await server.inject({
        method: "GET",
        url: "/assets/scripts/citeloom-bootstrap.js",
      });
      expect(bootstrapResponse.statusCode).toBe(200);
      expect(bootstrapResponse.body).toBe("window.citeloomBootstrapLoaded = true;");

      const noticesResponse = await server.inject({
        method: "GET",
        url: "/assets/scripts/citeloom-notices.js",
      });
      expect(noticesResponse.statusCode).toBe(200);
      expect(noticesResponse.body).toBe(
        "export const noticeEvent = 'citeloom:notice';",
      );

      for (const url of ["/", "/documents", "/settings", "/unknown"]) {
        const response = await server.inject({ method: "GET", url });
        expect(response.statusCode).toBe(302);
        expect(response.headers.location).toBe("/login");
      }
    } finally {
      await server.close();
    }
  });

  it("creates a secure host-only session cookie after login", async () => {
    const principal = buildAuthenticatedPrincipal("admin");
    const authenticate = vi.fn<WebServices["authenticate"]>(async () => ({
      expiresAt: "2026-08-01T12:00:00.000Z",
      principal,
      token: "private-session-token",
    }));
    const server = await buildProductionWebServer(buildConfig(), {
      logger: false,
      services: buildServices({ authenticate }),
      staticDirectory: null,
    });
    try {
      const response = await server.inject({
        headers: { origin: "https://localhost:3443" },
        method: "POST",
        payload: {
          password: "correct horse battery staple",
          remember: true,
          username: "Admin",
        },
        url: "/api/auth/login",
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers["set-cookie"]).toContain(
        "__Host-citeloom_session=private-session-token",
      );
      expect(response.headers["set-cookie"]).toContain("HttpOnly");
      expect(response.headers["set-cookie"]).toContain("Secure");
      expect(response.headers["set-cookie"]).toContain("SameSite=Strict");
      expect(response.headers["cache-control"]).toBe("no-store");
    } finally {
      await server.close();
    }
  });

  it("rejects login requests from another origin", async () => {
    const authenticate = vi.fn<WebServices["authenticate"]>();
    const server = await buildProductionWebServer(buildConfig(), {
      logger: false,
      services: buildServices({ authenticate }),
      staticDirectory: null,
    });
    try {
      const response = await server.inject({
        headers: { origin: "https://attacker.example" },
        method: "POST",
        payload: { password: "attempted password", username: "admin" },
        url: "/api/auth/login",
      });
      expect(response.statusCode).toBe(403);
      expect(authenticate).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("returns one generic response for rejected credentials", async () => {
    const authenticate = vi.fn<WebServices["authenticate"]>(async () => {
      throw new AuthenticationRejectedError();
    });
    const server = await buildProductionWebServer(buildConfig(), {
      logger: false,
      services: buildServices({ authenticate }),
      staticDirectory: null,
    });
    try {
      const response = await server.inject({
        headers: { origin: "https://localhost:3443" },
        method: "POST",
        payload: { password: "attempted password", username: "admin" },
        url: "/api/auth/login",
      });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({
        error: { message: "Invalid username or password." },
      });
    } finally {
      await server.close();
    }
  });

  it("maps non-admin member creation to forbidden", async () => {
    const principal = buildAuthenticatedPrincipal("member");
    const createWorkspaceMember = vi.fn<WebServices["createWorkspaceMember"]>(
      async () => {
        throw new WorkspaceAuthorizationError();
      },
    );
    const server = await buildProductionWebServer(buildConfig(), {
      logger: false,
      services: buildServices({
        createWorkspaceMember,
        readSession: async () => principal,
      }),
      staticDirectory: null,
    });
    try {
      const response = await server.inject({
        cookies: { "__Host-citeloom_session": "private-session-token" },
        headers: { origin: "https://localhost:3443" },
        method: "POST",
        payload: { displayName: "Another User", username: "another" },
        url: "/api/workspace/members",
      });
      expect(response.statusCode).toBe(403);
    } finally {
      await server.close();
    }
  });

  it("changes the authenticated user's password", async () => {
    const principal = buildAuthenticatedPrincipal("member");
    const changePassword = vi.fn<WebServices["changePassword"]>();
    const server = await buildProductionWebServer(buildConfig(), {
      logger: false,
      services: buildServices({
        changePassword,
        readSession: async () => principal,
      }),
      staticDirectory: null,
    });
    try {
      const response = await server.inject({
        cookies: { "__Host-citeloom_session": "private-session-token" },
        headers: { origin: "https://localhost:3443" },
        method: "PUT",
        payload: {
          currentPassword: "correct horse battery staple",
          newPassword: "a newer secure passphrase",
        },
        url: "/api/auth/password",
      });
      expect(response.statusCode).toBe(204);
      expect(changePassword).toHaveBeenCalledWith(
        principal,
        "correct horse battery staple",
        "a newer secure passphrase",
      );
    } finally {
      await server.close();
    }
  });

  it("serves canonical application routes that survive browser refresh", async () => {
    const staticDirectory = await mkdtemp(join(tmpdir(), "citeloom-web-routes-"));
    temporaryDirectories.push(staticDirectory);
    await writeFile(join(staticDirectory, "index.html"), "<main>CiteLoom</main>");
    const server = await buildWebServer(buildConfig(), {
      logger: false,
      services: buildServices(),
      staticDirectory,
    });

    try {
      const baseResponse = await server.inject({ method: "GET", url: "/" });
      expect(baseResponse.statusCode).toBe(200);
      expect(baseResponse.body).toBe("<main>CiteLoom</main>");
      expect(baseResponse.headers.location).toBeUndefined();

      const fallbackResponse = await server.inject({
        method: "GET",
        url: "/?section=documents&theme=dark",
      });
      expect(fallbackResponse.statusCode).toBe(200);
      expect(fallbackResponse.body).toBe("<main>CiteLoom</main>");
      expect(fallbackResponse.headers.location).toBeUndefined();

      for (const route of [
        "/account",
        "/overview",
        "/documents",
        "/errors",
        "/ask",
        "/help",
        "/settings",
        "/system-health",
        "/users",
        "/login",
      ]) {
        const response = await server.inject({ method: "GET", url: route });
        expect(response.statusCode).toBe(200);
        expect(response.body).toBe("<main>CiteLoom</main>");
      }

      const unknownResponse = await server.inject({ method: "GET", url: "/unknown" });
      expect(unknownResponse.statusCode).toBe(404);
    } finally {
      await server.close();
    }
  });

  it("serves error reports only to workspace administrators", async () => {
    const staticDirectory = await mkdtemp(join(tmpdir(), "citeloom-error-reports-"));
    temporaryDirectories.push(staticDirectory);
    await mkdir(join(staticDirectory, "fragments"), { recursive: true });
    await writeFile(join(staticDirectory, "index.html"), "<main>CiteLoom</main>");
    await writeFile(
      join(staticDirectory, "fragments", "errors.html"),
      "<section>Error reports</section>",
    );
    const readApplicationErrors = vi.fn<WebServices["readApplicationErrors"]>(
      async () => buildApplicationErrorPage(),
    );
    const purgeApplicationErrors = vi.fn<WebServices["purgeApplicationErrors"]>(
      async () => ({ deleted: 3 }),
    );
    const memberServer = await buildProductionWebServer(buildConfig(), {
      logger: false,
      services: buildServices({
        purgeApplicationErrors,
        readApplicationErrors,
        readSession: async () => buildAuthenticatedPrincipal("member"),
      }),
      staticDirectory,
    });

    try {
      for (const url of ["/errors", "/fragments/errors.html", "/api/errors"]) {
        const response = await memberServer.inject({
          cookies: { "__Host-citeloom_session": "private-session-token" },
          method: "GET",
          url,
        });
        expect(response.statusCode).toBe(403);
      }
      const purgeResponse = await memberServer.inject({
        headers: { origin: "https://localhost:3443" },
        cookies: { "__Host-citeloom_session": "private-session-token" },
        method: "DELETE",
        url: "/api/errors",
      });
      expect(purgeResponse.statusCode).toBe(403);
      expect(readApplicationErrors).not.toHaveBeenCalled();
      expect(purgeApplicationErrors).not.toHaveBeenCalled();
    } finally {
      await memberServer.close();
    }

    const principal = buildAuthenticatedPrincipal("admin");
    const administratorServer = await buildProductionWebServer(buildConfig(), {
      logger: false,
      services: buildServices({
        purgeApplicationErrors,
        readApplicationErrors,
        readSession: async () => principal,
      }),
      staticDirectory,
    });

    try {
      const routeResponse = await administratorServer.inject({
        cookies: { "__Host-citeloom_session": "private-session-token" },
        method: "GET",
        url: "/errors",
      });
      const fragmentResponse = await administratorServer.inject({
        cookies: { "__Host-citeloom_session": "private-session-token" },
        method: "GET",
        url: "/fragments/errors.html",
      });
      const apiResponse = await administratorServer.inject({
        cookies: { "__Host-citeloom_session": "private-session-token" },
        method: "GET",
        url: "/api/errors?area=ingestion&page=2&pageSize=25",
      });
      const invalidResponse = await administratorServer.inject({
        cookies: { "__Host-citeloom_session": "private-session-token" },
        method: "GET",
        url: "/api/errors?area=private",
      });
      const purgeResponse = await administratorServer.inject({
        headers: { origin: "https://localhost:3443" },
        cookies: { "__Host-citeloom_session": "private-session-token" },
        method: "DELETE",
        url: "/api/errors",
      });

      expect(routeResponse.statusCode).toBe(200);
      expect(fragmentResponse.statusCode).toBe(200);
      expect(fragmentResponse.body).toBe("<section>Error reports</section>");
      expect(apiResponse.statusCode).toBe(200);
      expect(apiResponse.json()).toEqual(buildApplicationErrorPage());
      expect(invalidResponse.statusCode).toBe(400);
      expect(purgeResponse.statusCode).toBe(200);
      expect(purgeResponse.json()).toEqual({ deleted: 3 });
      expect(readApplicationErrors).toHaveBeenCalledTimes(1);
      expect(readApplicationErrors).toHaveBeenCalledWith(principal, {
        area: "ingestion",
        page: 2,
        pageSize: 25,
      });
      expect(purgeApplicationErrors).toHaveBeenCalledOnce();
      expect(purgeApplicationErrors).toHaveBeenCalledWith(principal);
    } finally {
      await administratorServer.close();
    }
  });

  it("returns typed source discovery results", async () => {
    const searchSources = vi.fn<RuntimeWebServices["searchSources"]>(async () => {
      return buildSourceDiscoveryResponse();
    });
    const server = await buildWebServer(buildConfig(), {
      logger: false,
      services: buildServices({ searchSources }),
      staticDirectory: null,
    });

    try {
      const response = await server.inject({
        method: "POST",
        payload: buildSourceDiscoveryRequest(),
        url: "/api/search",
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(buildSourceDiscoveryResponse());
      expect(searchSources).toHaveBeenCalledWith(
        buildSourceDiscoveryRequest(),
        expect.any(AbortSignal),
      );
    } finally {
      await server.close();
    }
  });

  it("rejects invalid source discovery input at the HTTP boundary", async () => {
    const searchSources = vi.fn<RuntimeWebServices["searchSources"]>(async () => {
      return buildSourceDiscoveryResponse();
    });
    const server = await buildWebServer(buildConfig(), {
      logger: false,
      services: buildServices({ searchSources }),
      staticDirectory: null,
    });

    try {
      const response = await server.inject({
        method: "POST",
        payload: { ...buildSourceDiscoveryRequest(), query: " " },
        url: "/api/search",
      });

      expect(response.statusCode).toBe(400);
      expect(searchSources).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("returns service unavailable when every requested retrieval path fails", async () => {
    const searchSources = vi.fn<RuntimeWebServices["searchSources"]>(async () => {
      throw new SourceDiscoveryUnavailableError("Retrieval services failed.");
    });
    const server = await buildWebServer(buildConfig(), {
      logger: false,
      services: buildServices({ searchSources }),
      staticDirectory: null,
    });

    try {
      const response = await server.inject({
        method: "POST",
        payload: buildSourceDiscoveryRequest(),
        url: "/api/search",
      });

      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({
        error: {
          id: "00000000-0000-4000-8000-000000000099",
          message: "A required service is unavailable.",
        },
      });
    } finally {
      await server.close();
    }
  });

  it("returns conflict when the selected discovery scope no longer resolves", async () => {
    const searchSources = vi.fn<RuntimeWebServices["searchSources"]>(async () => {
      throw new SourceDiscoveryScopeError("The selected document is no longer ready.");
    });
    const server = await buildWebServer(buildConfig(), {
      logger: false,
      services: buildServices({ searchSources }),
      staticDirectory: null,
    });

    try {
      const response = await server.inject({
        method: "POST",
        payload: buildSourceDiscoveryRequest(),
        url: "/api/search",
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        error: { message: "The selected document is no longer ready." },
      });
    } finally {
      await server.close();
    }
  });

  it("returns a typed dashboard assembled from catalog and system services", async () => {
    const effectiveConfig = buildConfig();
    effectiveConfig.textToSpeech = {
      adapter: "omlx-speech",
      apiToken: null,
      baseUrl: "http://localhost:9000/v1",
      providerId: "local-ai",
      model: "Kokoro-82M-bf16",
      preload: true,
      runtimeName: "oMLX",
      speed: 1,
      timeoutMs: 30_000,
      voice: "af_heart",
    };
    effectiveConfig.speechToText = buildSpeechToTextConfig();
    const services = buildServices({ config: effectiveConfig });
    const server = await buildWebServer(buildConfig(), {
      logger: false,
      services,
      staticDirectory: null,
    });

    try {
      const response = await server.inject({ method: "GET", url: "/api/dashboard" });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        documentSummary: {
          queryable: 1,
          total: 1,
        },
        embeddingSpace: {
          dimensions: 768,
          id: "embedding-model:plain:768:window-87caf59d17b4baa5:representations-v2",
          model: "embedding-model",
          retrievalWindowPolicyFingerprint:
            "87caf59d17b4baa5dfa11a48876e2113061ed943b23827a515384c2f5b35120f",
          retrievalWindowPolicyId:
            "citeloom/retrieval-window:structured-token-v3",
        },
        features: {
          speechToText: true,
          textToSpeech: true,
          textToSpeechPreload: true,
        },
        inferenceRuntime: {
          answerModel: "vision-model",
          claimVerifier: {
            model: "vectara/hallucination_evaluation_model@8e4a2e6e96c708cc76c2344f7e4757df2515292c",
            name: "test verifier runtime",
          },
          name: "LM Studio",
          queryExpansionModel: "summary-model",
          reranker: null,
          summaryModel: "summary-model",
        },
        supportedExtensions: [
          ".pdf",
          ".html",
          ".htm",
          ".docx",
          ".xlsx",
          ".pptx",
          ".png",
          ".jpg",
          ".jpeg",
          ".webp",
        ],
        system: { queue: [], workers: [] },
        telemetry: {
          corrections: [],
          enabled: false,
          requests: [],
          stages: [],
          windowHours: 24,
        },
      });
    } finally {
      await server.close();
    }
  });

  it("streams canonical revision snapshots and publishes committed changes", async () => {
    let revisions = { catalog: "0", jobs: "0", settings: "0" };
    const subscription: {
      current: ((signal: {
        channel: "catalog" | "jobs" | "settings";
        revision: string;
      }) => void) | null;
    } = { current: null };
    const services = buildServices({
      readRevisions: async () => revisions,
      subscribeRevisions: (receive) => {
        subscription.current = receive;
        return () => {
          subscription.current = null;
        };
      },
    });
    const response = new TestRevisionResponse();
    const close = openApplicationStateRevisionEventStream(
      response as unknown as ServerResponse,
      services,
    );
    try {
      await vi.waitFor(() => {
        expect(response.text).toContain("data: {\"catalog\":\"0\"");
      });

      revisions = { catalog: "0", jobs: "1", settings: "0" };
      subscription.current?.({ channel: "jobs", revision: "1" });
      await vi.waitFor(() => {
        expect(response.text).toContain(
          "data: {\"catalog\":\"0\",\"jobs\":\"1\"",
        );
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers["Content-Type"]).toContain("text/event-stream");
      expect(response.text).toContain("id: 0.0.0");
      expect(response.text).toContain("id: 0.1.0");
    } finally {
      close();
    }
  });

  it("runs deep diagnostics only on POST and coalesces concurrent requests", async () => {
    let diagnosticCalls = 0;
    const diagnosticGate = { resolve: (): void => {
      throw new Error("Diagnostics did not start.");
    } };
    const services = buildServices({
      readHealth: async () => {
        diagnosticCalls += 1;
        await new Promise<void>((resolve) => {
          diagnosticGate.resolve = resolve;
        });
        return [{ detail: "ready", name: "PostgreSQL", ok: true }];
      },
    });
    const server = await buildWebServer(buildConfig(), {
      logger: false,
      services,
      staticDirectory: null,
    });

    try {
      expect((await server.inject({ method: "GET", url: "/api/health" })).statusCode).toBe(404);
      const first = server.inject({ method: "POST", url: "/api/diagnostics" });
      const second = server.inject({ method: "POST", url: "/api/diagnostics" });
      await vi.waitFor(() => expect(diagnosticCalls).toBe(1));
      diagnosticGate.resolve();
      const responses = await Promise.all([first, second]);
      expect(responses.every((response) => response.statusCode === 200)).toBe(true);
      expect(diagnosticCalls).toBe(1);
    } finally {
      await server.close();
    }
  });

  it("returns effective settings with provenance and redacted credentials", async () => {
    const config = buildConfig();
    config.database.url = "postgresql://database-user:database-password@localhost:5432/citeloom?sslpassword=query-secret#fragment-secret";
    const settings = buildEffectiveSettings();
    settings.providerSettings.connections.custom.answer.apiToken =
      "database-secret";
    settings.providerSettings.connections.custom.answer.model =
      "database-vision";
    settings.providerSettings.connections.openai.apiToken = "openai-secret";
    settings.providerSettings.connections.openai.textToSpeech.apiToken =
      "openai-speech-secret";
    settings.runtimeSettings.retrievalChunkTargetTokens = 4_096;
    settings.updatedAt = "2026-07-14T20:00:00.000Z";
    settings.version = 3;
    const server = await buildWebServer(config, {
      logger: false,
      services: buildServices({ readSettings: async () => settings }),
      staticDirectory: null,
    });

    try {
      const response = await server.inject({ method: "GET", url: "/api/settings" });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toMatchObject({ updatedAt: settings.updatedAt, version: 3 });
      expect(body.warnings).toEqual([
        "Document section size 4096 exceeds the embedding model's maximum input of "
        + "2048 tokens. CiteLoom will use 2048 tokens instead.",
        "No indexed documents use the selected search setup. "
        + "Index a document before asking questions.",
      ]);
      expect(body.fields).toEqual(expect.arrayContaining([
        expect.objectContaining({
          key: "retrievalChunkTargetTokens",
          min: 1,
          step: 1,
          unit: "tokens",
          value: 4_096,
        }),
        expect.objectContaining({
          defaultValue: 5,
          key: "retryBaseSeconds",
          max: 3_600,
          min: 0.1,
          step: 0.1,
          unit: "seconds",
          value: 5,
        }),
        expect.objectContaining({
          defaultValue: 5,
          key: "backgroundProgressIntervalSeconds",
          max: 3_600,
          min: 0.1,
          step: 0.1,
          unit: "seconds",
          value: 5,
        }),
        expect.objectContaining({
          defaultValue: 1,
          key: "workerFallbackPollSeconds",
          max: 300,
          min: 1,
          step: 1,
          unit: "seconds",
          value: 1,
        }),
      ]));
      expect(body.fields).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ key: "backgroundProgressIntervalMs" }),
        expect.objectContaining({ key: "inferenceApiToken" }),
        expect.objectContaining({ key: "retryBaseMs" }),
        expect.objectContaining({ key: "ttsApiToken" }),
        expect.objectContaining({ key: "ttsBaseUrl" }),
        expect.objectContaining({ key: "visionModel" }),
        expect.objectContaining({ key: "workerFallbackPollMs" }),
      ]));
      expect(body.providers.connections).toEqual(expect.arrayContaining([
        expect.objectContaining({
          apiTokenConfigured: true,
          capabilityApiTokensConfigured: expect.objectContaining({
            textToSpeech: true,
          }),
          providerId: "openai",
        }),
        expect.objectContaining({
          capabilityApiTokensConfigured: expect.objectContaining({
            answer: true,
          }),
          configuration: expect.objectContaining({
            answer: expect.objectContaining({ model: "database-vision" }),
          }),
          providerId: "custom",
        }),
      ]));
      const openAi = body.providers.connections.find((connection: {
        providerId: string;
      }) => connection.providerId === "openai");
      expect(openAi.configuration.baseUrl).toBe("https://api.openai.com/v1");
      expect(body.providers.catalog).toEqual(expect.arrayContaining([
        expect.objectContaining({
          authentication: "openai-device",
          id: "openai-codex",
        }),
      ]));
      expect(body.providers.routing.queryExpansion).toBe("lmstudio");
      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain("database-secret");
      expect(serialized).not.toContain("database-password");
      expect(serialized).not.toContain("query-secret");
      expect(serialized).not.toContain("fragment-secret");
      expect(serialized).not.toContain("openai-secret");
      expect(serialized).not.toContain("openai-speech-secret");
    } finally {
      await server.close();
    }
  });

  it("decodes typed setting changes before updating persisted configuration", async () => {
    const updateSettings = vi.fn<WebServices["updateSettings"]>(async () => {
      return buildEffectiveSettings();
    });
    const server = await buildWebServer(buildConfig(), {
      logger: false,
      services: buildServices({ updateSettings }),
      staticDirectory: null,
    });

    try {
      const response = await server.inject({
        method: "PUT",
        payload: {
          changes: [
            { action: "set", key: "doclingTimeoutSeconds", value: 240 },
            { action: "set", key: "retryBaseSeconds", value: 2.5 },
            {
              action: "set",
              key: "backgroundProgressIntervalSeconds",
              value: 1.001,
            },
            { action: "reset", key: "workerFallbackPollSeconds" },
            { action: "reset", key: "queryExpansions" },
          ],
          expectedVersion: 2,
        },
        url: "/api/settings",
      });

      expect(response.statusCode).toBe(200);
      expect(updateSettings).toHaveBeenCalledWith({
        changes: [
          { key: "doclingTimeoutSeconds", value: 240 },
          { key: "retryBaseMs", value: 2_500 },
          { key: "backgroundProgressIntervalMs", value: 1_001 },
          { key: "workerFallbackPollMs", reset: true },
          { key: "queryExpansions", reset: true },
        ],
        expectedVersion: 2,
        providerChanges: [],
      });
    } finally {
      await server.close();
    }
  });

  it("exposes administrator-only OpenAI Codex connection and model state", async () => {
    const disconnect = vi.fn(async () => undefined);
    const readModels = vi.fn(async () => [{
      defaultReasoningLevel: "medium",
      id: "gpt-5.6-terra",
      name: "GPT-5.6 Terra",
      reasoning: true,
      supportedReasoningLevels: ["low", "medium", "high"],
    }]);
    const server = await buildWebServer(buildConfig(), {
      logger: false,
      services: buildServices({
        openAICodex: {
          disconnect,
          readConnectionState: async () => ({
            expiresAt: "2026-07-27T13:00:00.000Z",
            state: "connected",
            updatedAt: "2026-07-27T12:00:00.000Z",
          }),
          readModels,
          replaceCredentials: async () => undefined,
        },
      }),
      staticDirectory: null,
    });

    try {
      const auth = await server.inject({
        method: "GET",
        url: "/api/providers/openai-codex/auth",
      });
      const models = await server.inject({
        method: "GET",
        url: "/api/providers/openai-codex/models",
      });
      const disconnected = await server.inject({
        method: "DELETE",
        url: "/api/providers/openai-codex/auth",
      });

      expect(auth.statusCode).toBe(200);
      expect(auth.json()).toEqual({
        connection: {
          expiresAt: "2026-07-27T13:00:00.000Z",
          state: "connected",
          updatedAt: "2026-07-27T12:00:00.000Z",
        },
        flow: null,
      });
      expect(models.statusCode).toBe(200);
      expect(models.json()).toEqual({
        models: [expect.objectContaining({ id: "gpt-5.6-terra" })],
      });
      expect(disconnected.statusCode).toBe(204);
      expect(readModels).toHaveBeenCalledOnce();
      expect(disconnect).toHaveBeenCalledOnce();
    } finally {
      await server.close();
    }
  });

  it("rejects internal millisecond keys and imprecise browser seconds", async () => {
    const updateSettings = vi.fn<WebServices["updateSettings"]>(async () => {
      return buildEffectiveSettings();
    });
    const server = await buildWebServer(buildConfig(), {
      logger: false,
      services: buildServices({ updateSettings }),
      staticDirectory: null,
    });

    try {
      const internalKey = await server.inject({
        method: "PUT",
        payload: {
          changes: [{ action: "set", key: "retryBaseMs", value: 5_000 }],
          expectedVersion: 0,
        },
        url: "/api/settings",
      });
      const impreciseSeconds = await server.inject({
        method: "PUT",
        payload: {
          changes: [{
            action: "set",
            key: "retryBaseSeconds",
            value: 0.1001,
          }],
          expectedVersion: 0,
        },
        url: "/api/settings",
      });
      const belowMinimum = await server.inject({
        method: "PUT",
        payload: {
          changes: [{
            action: "set",
            key: "retryBaseSeconds",
            value: 0.05,
          }],
          expectedVersion: 0,
        },
        url: "/api/settings",
      });

      expect(internalKey.statusCode).toBe(400);
      expect(internalKey.json()).toMatchObject({
        error: { message: "Unknown runtime setting: retryBaseMs." },
      });
      expect(impreciseSeconds.statusCode).toBe(400);
      expect(impreciseSeconds.json()).toMatchObject({
        error: {
          message: expect.stringContaining(
            "seconds must resolve to a whole number of milliseconds",
          ),
        },
      });
      expect(belowMinimum.statusCode).toBe(400);
      expect(updateSettings).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("rejects invalid setting values and stale settings revisions", async () => {
    const updateSettings = vi.fn<WebServices["updateSettings"]>(async () => {
      throw new SettingsVersionConflictError();
    });
    const server = await buildWebServer(buildConfig(), {
      logger: false,
      services: buildServices({ updateSettings }),
      staticDirectory: null,
    });

    try {
      const invalid = await server.inject({
        method: "PUT",
        payload: {
          changes: [{ action: "set", key: "doclingTimeoutSeconds", value: "slow" }],
          expectedVersion: 0,
        },
        url: "/api/settings",
      });
      const stale = await server.inject({
        method: "PUT",
        payload: {
          changes: [{ action: "set", key: "doclingTimeoutSeconds", value: 240 }],
          expectedVersion: 0,
        },
        url: "/api/settings",
      });

      expect(invalid.statusCode).toBe(400);
      expect(stale.statusCode).toBe(409);
      expect(updateSettings).toHaveBeenCalledTimes(1);
    } finally {
      await server.close();
    }
  });

  it("decodes provider configuration, credential, and route changes", async () => {
    const updateSettings = vi.fn<WebServices["updateSettings"]>(async () => {
      return buildEffectiveSettings();
    });
    const providers = createTestProviderSettings();
    const configuration = readProviderConnectionConfiguration(
      providers.connections.groq,
    );
    configuration.speechToText.model = "configured-stt";
    const server = await buildWebServer(buildConfig(), {
      logger: false,
      services: buildServices({ updateSettings }),
      staticDirectory: null,
    });

    try {
      const response = await server.inject({
        method: "PUT",
        payload: {
          changes: [],
          expectedVersion: 0,
          providerChanges: [
            { action: "configure", configuration, providerId: "groq" },
            {
              action: "credential",
              providerId: "groq",
              target: "shared",
              value: "groq-secret",
            },
            {
              action: "route",
              capability: "speechToText",
              providerId: "groq",
            },
          ],
        },
        url: "/api/settings",
      });

      expect(response.statusCode).toBe(200);
      expect(updateSettings).toHaveBeenCalledWith({
        changes: [],
        expectedVersion: 0,
        providerChanges: [
          { action: "configure", configuration, providerId: "groq" },
          {
            action: "credential",
            providerId: "groq",
            target: "shared",
            value: "groq-secret",
          },
          {
            action: "route",
            capability: "speechToText",
            providerId: "groq",
          },
        ],
      });
    } finally {
      await server.close();
    }
  });

  it("decodes feature-scoped and provider-scoped reset changes", async () => {
    const updateSettings = vi.fn<WebServices["updateSettings"]>(async () => {
      return buildEffectiveSettings();
    });
    const server = await buildWebServer(buildConfig(), {
      logger: false,
      services: buildServices({ updateSettings }),
      staticDirectory: null,
    });

    try {
      const response = await server.inject({
        method: "PUT",
        payload: {
          changes: [],
          expectedVersion: 0,
          providerChanges: [
            { action: "reset-feature", capability: "chat" },
            { action: "reset-provider", providerId: "ollama" },
          ],
        },
        url: "/api/settings",
      });

      expect(response.statusCode).toBe(200);
      expect(updateSettings).toHaveBeenCalledWith({
        changes: [],
        expectedVersion: 0,
        providerChanges: [
          { action: "reset-feature", capability: "chat" },
          { action: "reset-provider", providerId: "ollama" },
        ],
      });
    } finally {
      await server.close();
    }
  });

  it("rejects incompatible provider routing at the HTTP boundary", async () => {
    const updateSettings = vi.fn<WebServices["updateSettings"]>(async () => {
      return buildEffectiveSettings();
    });
    const server = await buildWebServer(buildConfig(), {
      logger: false,
      services: buildServices({ updateSettings }),
      staticDirectory: null,
    });

    try {
      const response = await server.inject({
        method: "PUT",
        payload: {
          changes: [],
          expectedVersion: 0,
          providerChanges: [{
            action: "route",
            capability: "textToSpeech",
            providerId: "cohere",
          }],
        },
        url: "/api/settings",
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        error: { message: "Provider cohere does not support text-to-speech." },
      });
      expect(updateSettings).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("does not contact providers while settings load or save", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const updateSettings = vi.fn<WebServices["updateSettings"]>(async () => {
      return buildEffectiveSettings();
    });
    const server = await buildWebServer(buildConfig(), {
      logger: false,
      services: buildServices({ updateSettings }),
      staticDirectory: null,
    });

    try {
      const readResponse = await server.inject({
        method: "GET",
        url: "/api/settings",
      });
      const saveResponse = await server.inject({
        method: "PUT",
        payload: {
          changes: [{ action: "set", key: "ttsSpeed", value: 1.1 }],
          expectedVersion: 0,
        },
        url: "/api/settings",
      });

      expect(readResponse.statusCode).toBe(200);
      expect(saveResponse.statusCode).toBe(200);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("decodes document catalog filters before browsing a bounded page", async () => {
    let receivedRequest: BrowseDocumentCatalogRequest | null = null;
    const removedDocument = buildBrowserDocument({
      displayStatus: "reindex-required",
      embeddingSpaceIds: ["previous-model:plain:768"],
      pageCount: 27,
      queryStatus: "reindex-required",
      sourceFile: "/documents/removed.pdf",
    });
    const services = buildServices({
      browseDocuments: async (request) => {
        receivedRequest = request;
        return buildCatalogResult([removedDocument]);
      },
    });
    const server = await buildWebServer(buildConfig(), {
      logger: false,
      services,
      staticDirectory: null,
    });

    try {
      const response = await server.inject({
        method: "GET",
        url: "/api/documents?collection=tag%3Alegal&page=2&pageSize=50&search=privacy&sort=name-asc&status=reindex-required&tag=statute",
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        documents: [{
          displayStatus: "reindex-required",
          embeddingProgress: {
            completedElements: 5,
            state: "complete",
            totalElements: 5,
          },
          mediaDescriptionProgress: {
            completedImages: 0,
            completedTables: 1,
          },
          pageCount: 27,
          queryStatus: "reindex-required",
          sourceFile: "/documents/removed.pdf",
          status: "ready",
        }],
      });
      expect(receivedRequest).toEqual({
        collection: { kind: "tag", tag: "legal" },
        page: 2,
        pageSize: 50,
        search: "privacy",
        sort: "name-asc",
        status: "reindex-required",
        tag: "statute",
      });
    } finally {
      await server.close();
    }
  });

  it("rejects invalid document catalog filters before calling the catalog", async () => {
    const browseDocuments = vi.fn<RuntimeWebServices["browseDocuments"]>(async () => {
      return buildCatalogResult();
    });
    const server = await buildWebServer(buildConfig(), {
      logger: false,
      services: buildServices({ browseDocuments }),
      staticDirectory: null,
    });

    try {
      const response = await server.inject({
        method: "GET",
        url: "/api/documents?pageSize=500&status=unknown",
      });

      expect(response.statusCode).toBe(400);
      expect(browseDocuments).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("serves the catalog-validated stored source document inline", async () => {
    const documentId = "a".repeat(64);
    const sourceFile = "/app/documents/uploads/group/handbook.pdf";
    const content = Buffer.from("%PDF-test-document");
    const readDocumentFile = vi.fn<RuntimeWebServices["readDocumentFile"]>(async () => ({
      content,
      documentId,
      filename: "handbook.pdf",
      mediaType: "application/pdf",
      sourceFile,
    }));
    const server = await buildWebServer(buildConfig(), {
      logger: false,
      services: buildServices({ readDocumentFile }),
      staticDirectory: null,
    });

    try {
      const parameters = new URLSearchParams({ sourceFile });
      const response = await server.inject({
        method: "GET",
        url: `/api/documents/${documentId}/file?${parameters.toString()}`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("private, no-store");
      expect(response.headers["content-disposition"]).toContain("inline;");
      expect(response.headers["content-type"]).toContain("application/pdf");
      expect(response.rawPayload).toEqual(content);
      expect(readDocumentFile).toHaveBeenCalledWith(
        { documentId, sourceFile },
      );
    } finally {
      await server.close();
    }
  });

  it("sandboxes stored HTML documents opened from answer links", async () => {
    const documentId = "a".repeat(64);
    const sourceFile = "/documents/reference.html";
    const server = await buildWebServer(buildConfig(), {
      logger: false,
      services: buildServices({
        readDocumentFile: async () => ({
          content: Buffer.from("<h1>Reference</h1>"),
          documentId,
          filename: "reference.html",
          mediaType: "text/html",
          sourceFile,
        }),
      }),
      staticDirectory: null,
    });

    try {
      const parameters = new URLSearchParams({ sourceFile });
      const response = await server.inject({
        method: "GET",
        url: `/api/documents/${documentId}/file?${parameters.toString()}`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers["content-security-policy"]).toContain("sandbox");
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
    } finally {
      await server.close();
    }
  });

  it("does not serve a document when the catalog ID and source path do not match", async () => {
    const readDocumentFile = vi.fn<RuntimeWebServices["readDocumentFile"]>(async () => null);
    const server = await buildWebServer(buildConfig(), {
      logger: false,
      services: buildServices({ readDocumentFile }),
      staticDirectory: null,
    });

    try {
      const sourceFile = "/documents/other.pdf";
      const parameters = new URLSearchParams({ sourceFile });
      const response = await server.inject({
        method: "GET",
        url: `/api/documents/${"a".repeat(64)}/file?${parameters.toString()}`,
      });

      expect(response.statusCode).toBe(404);
      expect(readDocumentFile).toHaveBeenCalledWith(
        {
          documentId: "a".repeat(64),
          sourceFile,
        },
      );
    } finally {
      await server.close();
    }
  });

  it("rejects invalid document links before reading stored content", async () => {
    const readDocumentFile = vi.fn<RuntimeWebServices["readDocumentFile"]>(async () => null);
    const server = await buildWebServer(buildConfig(), {
      logger: false,
      services: buildServices({ readDocumentFile }),
      staticDirectory: null,
    });

    try {
      const missingSourceResponse = await server.inject({
        method: "GET",
        url: `/api/documents/${"a".repeat(64)}/file?sourceFile=`,
      });
      const invalidIdResponse = await server.inject({
        method: "GET",
        url: "/api/documents/not-a-document-id/file?sourceFile=%2Fdocuments%2Fhandbook.pdf",
      });

      expect(missingSourceResponse.statusCode).toBe(400);
      expect(invalidIdResponse.statusCode).toBe(400);
      expect(readDocumentFile).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("decodes a scoped question before streaming the RAG pipeline", async () => {
    let receivedQuestion: QuestionRequest | null = null;
    const services = buildServices({
      streamAnswer: (request) => {
        receivedQuestion = request;
        return createAnswerStream("The milestone is Friday.");
      },
    });
    const server = await buildWebServer(buildConfig(), {
      logger: false,
      services,
      staticDirectory: null,
    });

    try {
      const response = await server.inject({
        method: "POST",
        payload: {
          question: "When is the milestone?",
          scope: { kind: "sourceFiles", sourceFiles: ["/documents/handbook.docx"] },
          threadId: "00000000-0000-4000-8000-000000000001",
        },
        url: "/api/questions",
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toContain("text/event-stream");
      expect(response.body).toContain("data-answer");
      expect(response.body).toContain("The milestone is Friday.");
      expect(receivedQuestion).toEqual({
        question: "When is the milestone?",
        scope: { kind: "sourceFiles", sourceFiles: ["/documents/handbook.docx"] },
        threadId: "00000000-0000-4000-8000-000000000001",
      });
    } finally {
      await server.close();
    }
  });

  it("rejects an empty question before starting a stream", async () => {
    const streamAnswer = vi.fn<RuntimeWebServices["streamAnswer"]>(() => {
      return createAnswerStream("Unexpected answer");
    });
    const server = await buildWebServer(buildConfig(), {
      logger: false,
      services: buildServices({ streamAnswer }),
      staticDirectory: null,
    });

    try {
      const response = await server.inject({
        method: "POST",
        payload: { question: "   ", scope: { kind: "all" } },
        url: "/api/questions",
      });

      expect(response.statusCode).toBe(400);
      expect(streamAnswer).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("streams validated speech audio with private response headers", async () => {
    const audioBytes = Buffer.from("RIFF speech audio");
    const answerDocument = {
      citations: [] as [],
      content: "The supplied source material does not answer this question.",
      schemaVersion: 1 as const,
      statements: [] as [],
    };
    const generateSpeech = vi.fn<RuntimeWebServices["generateSpeech"]>(async () => ({
      audio: Readable.from([audioBytes]),
      completion: Promise.resolve(),
      contentType: "audio/wav",
    }));
    const server = await buildWebServer(buildConfig(), {
      logger: false,
      services: buildServices({ generateSpeech }),
      staticDirectory: null,
    });

    try {
      const response = await server.inject({
        method: "POST",
        payload: { answerDocument },
        url: "/api/speech",
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("private, no-store");
      expect(response.headers["content-type"]).toContain("audio/wav");
      expect(response.rawPayload).toEqual(audioBytes);
      expect(generateSpeech).toHaveBeenCalledWith(
        { answerDocument },
        expect.any(AbortSignal),
      );
    } finally {
      await server.close();
    }
  });

  it("rejects an invalid speech answer document before generating audio", async () => {
    const generateSpeech = vi.fn<RuntimeWebServices["generateSpeech"]>();
    const server = await buildWebServer(buildConfig(), {
      logger: false,
      services: buildServices({ generateSpeech }),
      staticDirectory: null,
    });

    try {
      const response = await server.inject({
        method: "POST",
        payload: {
          answerDocument: {
            citations: [],
            content: "The supplied source material does not answer this question.",
            schemaVersion: 2,
            statements: [],
          },
        },
        url: "/api/speech",
      });

      expect(response.statusCode).toBe(400);
      expect(generateSpeech).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("returns service unavailable when text-to-speech is disabled", async () => {
    const generateSpeech = vi.fn<RuntimeWebServices["generateSpeech"]>(async () => {
      throw new TextToSpeechUnavailableError();
    });
    const server = await buildWebServer(buildConfig(), {
      logger: false,
      services: buildServices({ generateSpeech }),
      staticDirectory: null,
    });

    try {
      const response = await server.inject({
        method: "POST",
        payload: {
          answerDocument: {
            citations: [],
            content: "The supplied source material does not answer this question.",
            schemaVersion: 1,
            statements: [],
          },
        },
        url: "/api/speech",
      });

      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({
        error: {
          id: "00000000-0000-4000-8000-000000000099",
          message: "A required service is unavailable.",
        },
      });
    } finally {
      await server.close();
    }
  });

  it("returns a typed transcription with private response headers", async () => {
    const effectiveConfig = buildConfig();
    effectiveConfig.speechToText = buildSpeechToTextConfig();
    const transcribeAudio = vi.fn<RuntimeWebServices["transcribeAudio"]>(
      async () => ({ text: "CiteLoom should search the evidence for Section 42." }),
    );
    const uploadDirectory = await createTemporaryDirectory();
    const server = await buildWebServer(buildConfig(), {
      logger: false,
      services: buildServices({ config: effectiveConfig, transcribeAudio }),
      staticDirectory: null,
      uploadDirectory,
    });
    const form = new FormData();
    form.append(
      "file",
      new File(["recorded audio"], "browser-supplied-name.webm", {
        type: "audio/webm;codecs=opus",
      }),
    );
    const request = await buildMultipartRequest(form);

    try {
      const response = await server.inject({
        headers: request.headers,
        method: "POST",
        payload: request.payload,
        url: "/api/transcriptions",
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        text: "CiteLoom should search the evidence for Section 42.",
      });
      expect(response.headers["cache-control"]).toBe("private, no-store");
      expect(response.headers["cross-origin-resource-policy"]).toBe("same-origin");
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
      expect(transcribeAudio).toHaveBeenCalledOnce();
      const [audio, signal] = transcribeAudio.mock.calls[0] ?? [];
      expect(audio).toMatchObject({
        content: Buffer.from("recorded audio"),
        mediaType: "audio/webm",
      });
      expect(audio?.filename).toMatch(
        /^recording-[0-9a-f-]{36}\.webm$/,
      );
      expect(audio?.filename).not.toContain("browser-supplied-name");
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(await readDirectoryEntries(uploadDirectory)).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it("keeps an accepted transcription on one runtime snapshot during a settings reload", async () => {
    const firstConfig = buildConfig();
    firstConfig.speechToText = {
      ...buildSpeechToTextConfig(),
      model: "first-transcription-model",
    };
    const secondConfig = buildConfig();
    secondConfig.speechToText = {
      ...buildSpeechToTextConfig(),
      model: "second-transcription-model",
    };
    const firstGate = createDeferred<void>();
    const firstTranscribe = vi.fn<RuntimeWebServices["transcribeAudio"]>(async () => {
      await firstGate.promise;
      return { text: "First runtime transcript" };
    });
    const secondTranscribe = vi.fn<RuntimeWebServices["transcribeAudio"]>(
      async () => ({ text: "Second runtime transcript" }),
    );
    const services = buildServices({
      config: firstConfig,
      transcribeAudio: firstTranscribe,
    });
    const replacementServices = buildServices({
      config: secondConfig,
      transcribeAudio: secondTranscribe,
    });
    const server = await buildWebServer(buildConfig(), {
      logger: false,
      services,
      staticDirectory: null,
    });
    const firstRequest = await buildMultipartRequest(buildTranscriptionForm([
      buildAudioFile("first audio", "audio/webm"),
    ]));

    try {
      const acceptedResponse = server.inject({
        headers: firstRequest.headers,
        method: "POST",
        payload: firstRequest.payload,
        url: "/api/transcriptions",
      });
      await vi.waitFor(() => expect(firstTranscribe).toHaveBeenCalledOnce());
      services.run = replacementServices.run;
      firstGate.resolve(undefined);

      await expect(acceptedResponse.then((response) => response.json())).resolves.toEqual({
        text: "First runtime transcript",
      });
      expect(secondTranscribe).not.toHaveBeenCalled();

      const secondRequest = await buildMultipartRequest(buildTranscriptionForm([
        buildAudioFile("second audio", "audio/webm"),
      ]));
      const replacementResponse = await server.inject({
        headers: secondRequest.headers,
        method: "POST",
        payload: secondRequest.payload,
        url: "/api/transcriptions",
      });
      expect(replacementResponse.json()).toEqual({
        text: "Second runtime transcript",
      });
    } finally {
      firstGate.resolve(undefined);
      await server.close();
    }
  });

  it("rejects disabled transcription before parsing the multipart body", async () => {
    const transcribeAudio = vi.fn<RuntimeWebServices["transcribeAudio"]>();
    const server = await buildWebServer(buildConfig(), {
      logger: false,
      services: buildServices({ transcribeAudio }),
      staticDirectory: null,
    });

    try {
      const response = await server.inject({
        headers: { "content-type": "multipart/form-data; boundary=broken" },
        method: "POST",
        payload: "this is not a multipart body",
        url: "/api/transcriptions",
      });

      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({
        error: {
          id: "00000000-0000-4000-8000-000000000099",
          message: "A required service is unavailable.",
        },
      });
      expect(response.headers["cache-control"]).toBe("private, no-store");
      expect(transcribeAudio).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it.each([
    ["non-multipart", "text/plain", Buffer.from("audio"), 415],
    ["malformed multipart", "multipart/form-data; boundary=broken", Buffer.from("audio"), 400],
  ])("rejects a %s transcription upload", async (_name, contentType, payload, status) => {
    const effectiveConfig = buildConfig();
    effectiveConfig.speechToText = buildSpeechToTextConfig();
    const transcribeAudio = vi.fn<RuntimeWebServices["transcribeAudio"]>();
    const server = await buildWebServer(buildConfig(), {
      logger: false,
      services: buildServices({ config: effectiveConfig, transcribeAudio }),
      staticDirectory: null,
    });

    try {
      const response = await server.inject({
        headers: { "content-type": contentType },
        method: "POST",
        payload,
        url: "/api/transcriptions",
      });

      expect(response.statusCode).toBe(status);
      expect(transcribeAudio).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it.each([
    ["missing file", new FormData(), 400],
    ["empty file", buildTranscriptionForm([buildAudioFile("", "audio/webm")]), 400],
    ["undersized MP4", buildTranscriptionForm([
      buildAudioFile("x".repeat(1_499), "audio/mp4"),
    ]), 400],
    ["unsupported file", buildTranscriptionForm([buildAudioFile("audio", "audio/mpeg")]), 415],
    ["unexpected field", buildTranscriptionForm(
      [buildAudioFile("audio", "audio/webm")],
      ["language", "English"],
    ), 400],
    ["multiple files", buildTranscriptionForm([
      buildAudioFile("first", "audio/webm"),
      buildAudioFile("second", "audio/webm"),
    ]), 400],
  ])("rejects a transcription request with %s", async (_name, form, status) => {
    const effectiveConfig = buildConfig();
    effectiveConfig.speechToText = buildSpeechToTextConfig();
    const transcribeAudio = vi.fn<RuntimeWebServices["transcribeAudio"]>();
    const server = await buildWebServer(buildConfig(), {
      logger: false,
      services: buildServices({ config: effectiveConfig, transcribeAudio }),
      staticDirectory: null,
    });
    const request = await buildMultipartRequest(form);

    try {
      const response = await server.inject({
        headers: request.headers,
        method: "POST",
        payload: request.payload,
        url: "/api/transcriptions",
      });

      expect(response.statusCode).toBe(status);
      expect(transcribeAudio).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("rejects audio above the runtime snapshot byte limit", async () => {
    const effectiveConfig = buildConfig();
    effectiveConfig.speechToText = {
      ...buildSpeechToTextConfig(),
      maxAudioBytes: 4,
    };
    const transcribeAudio = vi.fn<RuntimeWebServices["transcribeAudio"]>();
    const server = await buildWebServer(buildConfig(), {
      logger: false,
      services: buildServices({ config: effectiveConfig, transcribeAudio }),
      staticDirectory: null,
    });
    const request = await buildMultipartRequest(buildTranscriptionForm([
      buildAudioFile("12345", "audio/webm"),
    ]));

    try {
      const response = await server.inject({
        headers: request.headers,
        method: "POST",
        payload: request.payload,
        url: "/api/transcriptions",
      });

      expect(response.statusCode).toBe(413);
      expect(transcribeAudio).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it.each([
    [new SpeechToTextProviderError(), 502],
    [new SpeechToTextTimeoutError(), 504],
  ])("maps transcription provider failures without exposing provider content", async (error, status) => {
    const effectiveConfig = buildConfig();
    effectiveConfig.speechToText = buildSpeechToTextConfig();
    const transcribeAudio = vi.fn<RuntimeWebServices["transcribeAudio"]>(async () => {
      throw error;
    });
    const server = await buildWebServer(buildConfig(), {
      logger: false,
      services: buildServices({ config: effectiveConfig, transcribeAudio }),
      staticDirectory: null,
    });
    const request = await buildMultipartRequest(buildTranscriptionForm([
      buildAudioFile("audio", "audio/webm"),
    ]));

    try {
      const response = await server.inject({
        headers: request.headers,
        method: "POST",
        payload: request.payload,
        url: "/api/transcriptions",
      });

      expect(response.statusCode).toBe(status);
      expect(response.body).not.toContain("transcription-token");
      expect(response.headers["cache-control"]).toBe("private, no-store");
    } finally {
      await server.close();
    }
  });

  it("propagates a browser disconnect to the active transcription", async () => {
    const effectiveConfig = buildConfig();
    effectiveConfig.speechToText = buildSpeechToTextConfig();
    const transcribeAudio = vi.fn<RuntimeWebServices["transcribeAudio"]>(
      async (_audio, signal) => {
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
    );
    const server = await buildWebServer(buildConfig(), {
      logger: false,
      services: buildServices({ config: effectiveConfig, transcribeAudio }),
      staticDirectory: null,
    });
    let disconnect = (): void => {
      throw new Error("Expected the transcription request to start.");
    };
    server.addHook("onRequest", async (request) => {
      disconnect = () => request.raw.emit("close");
    });
    const request = await buildMultipartRequest(buildTranscriptionForm([
      buildAudioFile("audio", "audio/webm"),
    ]));

    try {
      const response = server.inject({
        headers: request.headers,
        method: "POST",
        payload: request.payload,
        url: "/api/transcriptions",
      });
      await vi.waitFor(() => expect(transcribeAudio).toHaveBeenCalledOnce());
      const providerSignal = transcribeAudio.mock.calls[0]?.[1];

      disconnect();

      await vi.waitFor(() => expect(providerSignal?.aborted).toBe(true));
      await response.catch(() => undefined);
    } finally {
      await server.close();
    }
  });

  it("streams supported uploads and normalizes ingestion options", async () => {
    const uploadDirectory = await createTemporaryDirectory();
    let receivedDocuments: StagedIngestionDocument[] = [];
    const receivedContents: string[] = [];
    let receivedOptions: Parameters<RuntimeWebServices["ingest"]>[1] | null = null;
    const services = buildServices({
      ingest: async (documents, options) => {
        receivedDocuments = [...documents];
        for (const document of documents) {
          receivedContents.push(await readFile(document.sourceFile, "utf8"));
        }
        receivedOptions = options;
        return { documents: [], failures: [] };
      },
    });
    const server = await buildWebServer(buildConfig(), {
      logger: false,
      services,
      staticDirectory: null,
      uploadDirectory,
    });

    try {
      const form = new FormData();
      form.append("force", "true");
      form.append("tags", "Finance,quarterly,finance");
      form.append("documents", new Blob(["<html>Revenue</html>"], { type: "text/html" }), "report.HTML");
      form.append("documents", new Blob(["docx bytes"]), "handbook.docx");
      const request = await buildMultipartRequest(form);
      const response = await server.inject({
        headers: request.headers,
        method: "POST",
        payload: request.payload,
        url: "/api/ingestions",
      });

      expect(response.statusCode).toBe(200);
      expect(receivedOptions).toEqual({
        enqueue: true,
        force: true,
        recursive: false,
        tags: ["finance", "quarterly"],
      });
      expect(receivedDocuments.map((document) => ({
        byteLength: document.byteLength,
        documentId: document.documentId,
        extension: document.extension,
        mediaType: document.mediaType,
        sourceFilename: document.sourceFile.split("/").at(-1),
      }))).toEqual([
        {
          byteLength: 20,
          documentId: createHash("sha256").update("<html>Revenue</html>").digest("hex"),
          extension: ".html",
          mediaType: "text/html",
          sourceFilename: "report.html",
        },
        {
          byteLength: 10,
          documentId: createHash("sha256").update("docx bytes").digest("hex"),
          extension: ".docx",
          mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          sourceFilename: "handbook.docx",
        },
      ]);
      expect(receivedContents).toEqual(["<html>Revenue</html>", "docx bytes"]);
      await expect(readDirectoryEntries(uploadDirectory)).resolves.toEqual([]);
    } finally {
      await server.close();
    }
  });

  it("rejects oversized uploads and removes the incomplete upload group", async () => {
    const uploadDirectory = await createTemporaryDirectory();
    const ingest = vi.fn<RuntimeWebServices["ingest"]>(async () => ({ documents: [], failures: [] }));
    const config = buildConfig();
    config.maxDocumentBytes = 16;
    const services = buildServices({
      ingest,
      config,
    });
    const server = await buildWebServer(config, {
      logger: false,
      services,
      staticDirectory: null,
      uploadDirectory,
    });

    try {
      const form = new FormData();
      form.append("documents", new Blob(["x".repeat(32)]), "oversized.html");
      const request = await buildMultipartRequest(form);
      const response = await server.inject({
        headers: request.headers,
        method: "POST",
        payload: request.payload,
        url: "/api/ingestions",
      });

      expect(response.statusCode).toBe(413);
      expect(ingest).not.toHaveBeenCalled();
      await expect(readDirectoryEntries(uploadDirectory)).resolves.toEqual([]);
    } finally {
      await server.close();
    }
  });

  it("queues a failed job retry from its stored durable phase", async () => {
    const sourceFile = "/app/documents/uploads/group/handbook.pdf";
    const retryFailedJob = vi.fn<RuntimeWebServices["retryFailedJob"]>(
      async (requestedSourceFile) => {
        return {
          job: buildPendingJob(requestedSourceFile),
          kind: "retried",
        };
      },
    );
    const server = await buildWebServer(buildConfig(), {
      logger: false,
      services: buildServices({ retryFailedJob }),
      staticDirectory: null,
    });

    try {
      const response = await server.inject({
        method: "POST",
        payload: { sourceFile },
        url: "/api/ingestion-jobs/retry",
      });

      expect(response.statusCode).toBe(202);
      expect(response.json()).toEqual({
        phase: "normalized",
        sourceFile,
        state: "pending",
        updatedAt: "2026-07-14T04:00:00.000Z",
      });
      expect(retryFailedJob).toHaveBeenCalledWith(sourceFile);
    } finally {
      await server.close();
    }
  });

  it("queues a force reindex for the selected stored document", async () => {
    const documentId = "a".repeat(64);
    const sourceFile = "/app/documents/uploads/group/handbook.pdf";
    const reindexDocument = vi.fn<RuntimeWebServices["reindexDocument"]>(
      async (request) => ({
        documentId: request.documentId,
        kind: "queued",
        sourceFile: request.sourceFile,
      }),
    );
    const server = await buildWebServer(buildConfig(), {
      logger: false,
      services: buildServices({ reindexDocument }),
      staticDirectory: null,
    });

    try {
      const response = await server.inject({
        method: "POST",
        payload: { sourceFile },
        url: `/api/documents/${documentId}/reindex`,
      });

      expect(response.statusCode).toBe(202);
      expect(response.json()).toEqual({
        documentId,
        sourceFile,
        status: "queued",
      });
      expect(reindexDocument).toHaveBeenCalledWith(
        { documentId, sourceFile },
        {
          isAdministrator: true,
          userId: "00000000-0000-4000-8000-000000000000",
        },
      );
    } finally {
      await server.close();
    }
  });

  it("passes the authenticated member to document reindexing", async () => {
    const principal = buildAuthenticatedPrincipal("member");
    const reindexDocument = vi.fn<RuntimeWebServices["reindexDocument"]>(
      async (request) => ({
        documentId: request.documentId,
        kind: "queued",
        sourceFile: request.sourceFile,
      }),
    );
    const server = await buildProductionWebServer(buildConfig(), {
      logger: false,
      services: buildServices({
        readSession: async () => principal,
        reindexDocument,
      }),
      staticDirectory: null,
    });

    try {
      const response = await server.inject({
        cookies: { "__Host-citeloom_session": "private-session-token" },
        headers: { origin: "https://localhost:3443" },
        method: "POST",
        payload: {
          sourceFile: "/app/documents/uploads/group/handbook.pdf",
        },
        url: `/api/documents/${"a".repeat(64)}/reindex`,
      });

      expect(response.statusCode).toBe(202);
      expect(reindexDocument).toHaveBeenCalledWith(
        {
          documentId: "a".repeat(64),
          sourceFile: "/app/documents/uploads/group/handbook.pdf",
        },
        {
          isAdministrator: false,
          userId: principal.userId,
        },
      );
    } finally {
      await server.close();
    }
  });

  it("rejects an invalid document reindex request at the HTTP boundary", async () => {
    const reindexDocument = vi.fn<RuntimeWebServices["reindexDocument"]>(
      async () => ({ kind: "not-found" }),
    );
    const server = await buildWebServer(buildConfig(), {
      logger: false,
      services: buildServices({ reindexDocument }),
      staticDirectory: null,
    });

    try {
      const response = await server.inject({
        method: "POST",
        payload: { sourceFile: "" },
        url: "/api/documents/not-a-document-id/reindex",
      });

      expect(response.statusCode).toBe(400);
      expect(reindexDocument).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("returns not found when the selected document is no longer indexed", async () => {
    const server = await buildWebServer(buildConfig(), {
      logger: false,
      services: buildServices(),
      staticDirectory: null,
    });

    try {
      const response = await server.inject({
        method: "POST",
        payload: { sourceFile: "/documents/missing.pdf" },
        url: `/api/documents/${"a".repeat(64)}/reindex`,
      });

      expect(response.statusCode).toBe(404);
    } finally {
      await server.close();
    }
  });

  it("returns a conflict when the selected document cannot be queued", async () => {
    const reindexDocument = vi.fn<RuntimeWebServices["reindexDocument"]>(
      async () => ({
        error: "Another ingestion worker is processing this document.",
        kind: "rejected",
      }),
    );
    const server = await buildWebServer(buildConfig(), {
      logger: false,
      services: buildServices({ reindexDocument }),
      staticDirectory: null,
    });

    try {
      const response = await server.inject({
        method: "POST",
        payload: { sourceFile: "/documents/active.pdf" },
        url: `/api/documents/${"a".repeat(64)}/reindex`,
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        error: { message: "Another ingestion worker is processing this document." },
      });
    } finally {
      await server.close();
    }
  });

  it("rejects an invalid retry request at the HTTP boundary", async () => {
    const retryFailedJob = vi.fn<RuntimeWebServices["retryFailedJob"]>(async () => {
      return { kind: "not-found" };
    });
    const server = await buildWebServer(buildConfig(), {
      logger: false,
      services: buildServices({ retryFailedJob }),
      staticDirectory: null,
    });

    try {
      const response = await server.inject({
        method: "POST",
        payload: { sourceFile: "   " },
        url: "/api/ingestion-jobs/retry",
      });

      expect(response.statusCode).toBe(400);
      expect(retryFailedJob).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("passes the authenticated administrator to ingestion control", async () => {
    const sourceFile = "/documents/uploads/request/document.pdf";
    const requestIngestionControl = vi.fn<
      RuntimeWebServices["requestIngestionControl"]
    >(async () => ({ job: buildPendingJob(sourceFile), kind: "accepted" }));
    const server = await buildWebServer(buildConfig(), {
      logger: false,
      services: buildServices({ requestIngestionControl }),
      staticDirectory: null,
    });

    try {
      const response = await server.inject({
        method: "POST",
        payload: { sourceFile },
        url: "/api/ingestion-jobs/pause",
      });

      expect(response.statusCode).toBe(202);
      expect(requestIngestionControl).toHaveBeenCalledWith(
        sourceFile,
        "pause",
        {
          isAdministrator: true,
          userId: "00000000-0000-4000-8000-000000000000",
        },
      );
    } finally {
      await server.close();
    }
  });

  it("returns a conflict when a requested job is not failed", async () => {
    const retryFailedJob = vi.fn<RuntimeWebServices["retryFailedJob"]>(async () => {
      return { kind: "not-failed", state: "running" };
    });
    const server = await buildWebServer(buildConfig(), {
      logger: false,
      services: buildServices({ retryFailedJob }),
      staticDirectory: null,
    });

    try {
      const response = await server.inject({
        method: "POST",
        payload: { sourceFile: "/documents/active.pdf" },
        url: "/api/ingestion-jobs/retry",
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        error: { message: "Ingestion job is running, not failed: /documents/active.pdf." },
      });
    } finally {
      await server.close();
    }
  });

  it("returns not found when no matching ingestion job exists", async () => {
    const server = await buildWebServer(buildConfig(), {
      logger: false,
      services: buildServices(),
      staticDirectory: null,
    });

    try {
      const response = await server.inject({
        method: "POST",
        payload: { sourceFile: "/documents/missing.pdf" },
        url: "/api/ingestion-jobs/retry",
      });

      expect(response.statusCode).toBe(404);
    } finally {
      await server.close();
    }
  });
});

describe("research API boundary", () => {
  it("creates, lists, reopens, and exports explicit research threads", async () => {
    const thread = {
      createdAt: "2026-07-15T12:00:00.000Z",
      id: "00000000-0000-4000-8000-000000000201",
      title: "Quarterly evidence",
      turns: [],
      updatedAt: "2026-07-15T12:00:00.000Z",
    };
    const createResearchThread = vi.fn<RuntimeWebServices["createResearchThread"]>(
      async () => thread,
    );
    const deleteResearchThread = vi.fn<RuntimeWebServices["deleteResearchThread"]>(
      async () => undefined,
    );
    const server = await buildWebServer(buildConfig(), {
      logger: false,
      services: buildServices({
        createResearchThread,
        deleteResearchThread,
        exportResearchThread: async () => ({
          content: "# Quarterly evidence\n",
          filename: "thread.md",
          mediaType: "text/markdown; charset=utf-8",
        }),
        listResearchThreads: async () => [{
          createdAt: thread.createdAt,
          id: thread.id,
          title: thread.title,
          turnCount: 0,
          updatedAt: thread.updatedAt,
        }],
        readResearchThread: async () => thread,
      }),
      staticDirectory: null,
    });
    try {
      const created = await server.inject({
        method: "POST",
        payload: { title: "  Quarterly evidence  " },
        url: "/api/research/threads",
      });
      const listed = await server.inject({
        method: "GET",
        url: "/api/research/threads",
      });
      const reopened = await server.inject({
        method: "GET",
        url: `/api/research/threads/${thread.id}`,
      });
      const exported = await server.inject({
        method: "GET",
        url: `/api/research/threads/${thread.id}/export?format=markdown`,
      });
      const deleted = await server.inject({
        method: "DELETE",
        url: `/api/research/threads/${thread.id}`,
      });

      expect(created.statusCode).toBe(201);
      expect(createResearchThread).toHaveBeenCalledWith("Quarterly evidence");
      expect(listed.json()).toEqual([expect.objectContaining({ id: thread.id })]);
      expect(reopened.json()).toMatchObject({ id: thread.id });
      expect(exported.headers["content-type"]).toContain("text/markdown");
      expect(exported.headers["content-disposition"]).toContain("thread.md");
      expect(deleted.statusCode).toBe(204);
      expect(deleteResearchThread).toHaveBeenCalledWith(thread.id);
    } finally {
      await server.close();
    }
  });

  it("returns bounded document version metadata", async () => {
    const sourceFile = "/documents/test.pdf";
    const version = {
      createdAt: "2026-07-24T05:03:27.369Z",
      documentId: "a".repeat(64),
      elementCount: 37,
      elementSetId: "b".repeat(64),
      format: {
        extension: ".pdf" as const,
        mediaType: "application/pdf" as const,
      },
      generationId: "00000000-0000-4000-8000-000000000002",
      id: "00000000-0000-4000-8000-000000000001",
      pageCount: 12,
      sourceFile,
      version: 1,
    };
    const listDocumentVersions = vi.fn<
      RuntimeWebServices["listDocumentVersions"]
    >(async () => [version]);
    const server = await buildWebServer(buildConfig(), {
      logger: false,
      services: buildServices({ listDocumentVersions }),
      staticDirectory: null,
    });
    try {
      const response = await server.inject({
        method: "GET",
        url: `/api/document-versions?sourceFile=${encodeURIComponent(sourceFile)}`,
      });

      expect(response.statusCode).toBe(200);
      expect(listDocumentVersions).toHaveBeenCalledWith(sourceFile);
      expect(response.json()).toEqual([version]);
      expect(response.json()[0]).not.toHaveProperty("elementIds");
    } finally {
      await server.close();
    }
  });

  it("returns immutable citation evidence and validates dimension-specific feedback", async () => {
    const citationId = "00000000-0000-4000-8000-000000000202";
    const turnId = "00000000-0000-4000-8000-000000000203";
    const addResearchFeedback = vi.fn<RuntimeWebServices["addResearchFeedback"]>(
      async () => ({ negativeCount: 1, positiveCount: 0, rating: -1 }),
    );
    const server = await buildWebServer(buildConfig(), {
      logger: false,
      services: buildServices({
        addResearchFeedback,
        readCitationEvidence: async () => ({
          citationNumber: 1,
          createdAt: "2026-07-15T12:00:00.000Z",
          documentId: "a".repeat(64),
          documentVersionId: "00000000-0000-4000-8000-000000000205",
          elementId: "b".repeat(64),
          evidence: { excerpt: "Exact evidence.", kind: "text" },
          id: citationId,
          pageNumbers: [1],
          regions: [],
          sectionPath: [],
          sourceFile: "/documents/evidence.txt",
          stale: false,
          turnId,
        }),
      }),
      staticDirectory: null,
    });
    try {
      const evidence = await server.inject({
        method: "GET",
        url: `/api/citations/${citationId}`,
      });
      const invalidFeedback = await server.inject({
        method: "POST",
        payload: {
          citationId: null,
          comment: null,
          dimension: "citation-correctness",
          rating: 1,
          turnId,
        },
        url: "/api/research/feedback",
      });
      const validFeedback = await server.inject({
        method: "POST",
        payload: {
          citationId,
          comment: null,
          dimension: "citation-correctness",
          rating: -1,
          turnId,
        },
        url: "/api/research/feedback",
      });

      expect(evidence.statusCode).toBe(200);
      expect(evidence.json()).toMatchObject({
        documentVersionId: "00000000-0000-4000-8000-000000000205",
        evidence: { excerpt: "Exact evidence.", kind: "text" },
      });
      expect(invalidFeedback.statusCode).toBe(400);
      expect(validFeedback.statusCode).toBe(200);
      expect(addResearchFeedback).toHaveBeenCalledWith({
        citationId,
        comment: null,
        dimension: "citation-correctness",
        rating: -1,
        turnId,
      }, "00000000-0000-4000-8000-000000000000");
    } finally {
      await server.close();
    }
  });

});

type TestWebServiceOverrides = Partial<RuntimeWebServices>
  & Partial<Pick<
    WebServices,
    | "authenticate"
    | "changePassword"
    | "changeWorkspaceMemberRole"
    | "completePasswordSetup"
    | "copyEmbeddingInputFormat"
    | "createEmbeddingInputFormat"
    | "createPasswordReset"
    | "createWorkspaceMember"
    | "listWorkspaceMembers"
    | "openAICodex"
    | "purgeApplicationErrors"
    | "readApplicationErrors"
    | "readSession"
    | "readSettings"
    | "reportApplicationError"
    | "removeWorkspaceMember"
    | "retireEmbeddingInputFormat"
    | "revokeSession"
    | "reviseEmbeddingInputFormat"
    | "subscribeRevisions"
    | "updateSettings"
  >>;

function buildServices(
  overrides: TestWebServiceOverrides = {},
): WebServices {
  const runtimeServices: RuntimeWebServices = {
    addResearchFeedback: async () => ({ negativeCount: 0, positiveCount: 1, rating: 1 }),
    browseDocuments: async () => buildCatalogResult(),
    compareDocumentVersions: async () => null,
    config: buildConfig(),
    createResearchThread: async (title) => ({
      createdAt: "2026-07-15T12:00:00.000Z",
      id: "00000000-0000-4000-8000-000000000001",
      title,
      turns: [],
      updatedAt: "2026-07-15T12:00:00.000Z",
    }),
    deleteResearchThread: async () => undefined,
    exportResearchThread: async () => null,
    generateSpeech: async () => ({
      audio: Readable.from([Buffer.from("audio")]),
      completion: Promise.resolve(),
      contentType: "audio/wav",
    }),
    ingest: async () => ({ documents: [], failures: [] }),
    listDocumentVersions: async () => [],
    listResearchThreads: async () => [],
    readCitationEvidence: async () => null,
    readCitationHighlightedPdf: async () => null,
    readCitationImage: async () => null,
    readDocumentFile: async () => null,
    readHealth: async () => [{ detail: "ready", name: "PostgreSQL", ok: true }],
    readResearchThread: async () => null,
    readResearchFeedback: async () => ({ negativeCount: 0, positiveCount: 0, rating: 0 }),
    readRevisions: async () => ({ catalog: "0", jobs: "0", settings: "0" }),
    readStatus: async () => ({ inference: [], queue: [], workers: [] }),
    readTelemetry: async () => buildTelemetryDashboard(),
    readVersionedDocumentFile: async () => null,
    reindexDocument: async () => ({ kind: "not-found" }),
    retryFailedJob: async () => ({ kind: "not-found" }),
    requestIngestionControl: async () => ({ kind: "not-found" }),
    resumeIngestion: async () => ({ kind: "not-found" }),
    searchSources: async () => buildSourceDiscoveryResponse(),
    streamAnswer: () => createAnswerStream("Answer"),
    transcribeAudio: async () => ({ text: "Transcript" }),
  };
  const effectiveRuntimeServices: RuntimeWebServices = {
    ...runtimeServices,
    ...overrides,
  };
  return {
    authenticate: overrides.authenticate ?? (async () => {
      throw new Error("Authentication is not configured in boundary tests.");
    }),
    changePassword: overrides.changePassword ?? (async () => {
      throw new Error("Authentication is not configured in boundary tests.");
    }),
    changeWorkspaceMemberRole: overrides.changeWorkspaceMemberRole ?? (async () => {
      throw new Error("Authentication is not configured in boundary tests.");
    }),
    completePasswordSetup: overrides.completePasswordSetup ?? (async () => {
      throw new Error("Authentication is not configured in boundary tests.");
    }),
    copyEmbeddingInputFormat: overrides.copyEmbeddingInputFormat
      ?? (async () => buildEmbeddingInputFormatRecord()),
    createEmbeddingInputFormat: overrides.createEmbeddingInputFormat
      ?? (async () => buildEmbeddingInputFormatRecord()),
    createPasswordReset: overrides.createPasswordReset ?? (async () => {
      throw new Error("Authentication is not configured in boundary tests.");
    }),
    createWorkspaceMember: overrides.createWorkspaceMember ?? (async () => {
      throw new Error("Authentication is not configured in boundary tests.");
    }),
    listWorkspaceMembers: overrides.listWorkspaceMembers ?? (async () => []),
    openAICodex: overrides.openAICodex ?? {
      disconnect: async () => undefined,
      readConnectionState: async () => ({
        expiresAt: null,
        state: "disconnected",
        updatedAt: null,
      }),
      readModels: async () => [],
      replaceCredentials: async () => undefined,
    },
    purgeApplicationErrors: overrides.purgeApplicationErrors
      ?? (async () => ({ deleted: 0 })),
    readApplicationErrors: overrides.readApplicationErrors
      ?? (async () => buildApplicationErrorPage()),
    readRevisions: effectiveRuntimeServices.readRevisions,
    readSettings: overrides.readSettings ?? (async () => buildEffectiveSettings()),
    reportApplicationError: overrides.reportApplicationError
      ?? (async () => ({ id: "00000000-0000-4000-8000-000000000099" })),
    removeWorkspaceMember: overrides.removeWorkspaceMember ?? (async () => {
      throw new Error("Authentication is not configured in boundary tests.");
    }),
    retireEmbeddingInputFormat: overrides.retireEmbeddingInputFormat
      ?? (async () => buildEmbeddingInputFormatRecord()),
    readSession: overrides.readSession ?? (async () => null),
    revokeSession: overrides.revokeSession ?? (async () => undefined),
    run: async (operation) => operation(effectiveRuntimeServices),
    runManaged: async (operation) => {
      const task = await operation(effectiveRuntimeServices);
      return task.value;
    },
    stream: (operation) => operation(effectiveRuntimeServices),
    subscribeRevisions: overrides.subscribeRevisions ?? (() => () => undefined),
    reviseEmbeddingInputFormat: overrides.reviseEmbeddingInputFormat
      ?? (async () => buildEmbeddingInputFormatRecord()),
    updateSettings: overrides.updateSettings ?? (async () => buildEffectiveSettings()),
  };
}

function buildSourceDiscoveryRequest() {
  return {
    includeRelated: true,
    keywordPage: 1,
    query: "loan",
    scope: { kind: "all" as const },
  };
}

function buildAuthenticatedPrincipal(
  role: "admin" | "member",
): AuthenticatedPrincipal {
  return {
    displayName: "Test User",
    role,
    sessionTokenDigest: "a".repeat(64),
    userId: "00000000-0000-4000-8000-000000000301",
    username: "test-user",
    workspaceId: "00000000-0000-4000-8000-000000000302",
    workspaceName: "Test Workspace",
  };
}

function buildApplicationErrorPage() {
  return {
    counts: {
      all: 0,
      application: 0,
      general: 0,
      ingestion: 0,
    },
    errors: [],
    generatedAt: "2026-07-27T12:00:00.000Z",
    page: 1,
    pageCount: 0,
    pageSize: 50 as const,
    total: 0,
  };
}

class TestRevisionResponse extends EventEmitter {
  public readonly headers: Record<string, string> = {};
  public statusCode = 0;
  public text = "";

  public end(): void {
    this.emit("close");
  }

  public write(value: string): boolean {
    this.text += value;
    return true;
  }

  public writeHead(statusCode: number, headers: Record<string, string>): void {
    this.statusCode = statusCode;
    Object.assign(this.headers, headers);
  }
}

function buildTelemetryDashboard() {
  return {
    corrections: [],
    enabled: false,
    generatedAt: "2026-07-15T12:00:00.000Z",
    requests: [],
    scheduling: [],
    stages: [],
    windowHours: 24,
  };
}

function buildSourceDiscoveryResponse(): SourceDiscoveryResponse {
  return {
    keyword: {
      documents: [],
      page: 1,
      pageSize: 10,
      status: "complete",
      totalDocuments: 0,
      warning: null,
    },
    query: "loan",
    related: {
      documents: [],
      limit: 10,
      status: "complete",
      warning: null,
    },
  };
}

function buildEffectiveSettings(): EffectiveApplicationSettings {
  const config = buildConfig();
  const runtimeSettings = buildRuntimeSettings();
  return {
    config,
    defaults: runtimeSettings,
    embeddingInputFormats: [{
      ...buildEmbeddingInputFormatRecord(),
      embeddingSpaceCount: 0,
    }],
    indexedDocumentCount: 0,
    overrides: {},
    providerSettings: createTestProviderSettings(),
    runtimeSettings,
    selectedEmbeddingSpaceDocumentCount: 0,
    updatedAt: null,
    version: 0,
  };
}

function buildRuntimeSettings(): RuntimeSettings {
  return createTestRuntimeSettings({
    claimVerifierRuntimeName: "test verifier runtime",
    embeddingInputFormatId: TEST_PLAIN_EMBEDDING_INPUT_FORMAT.id,
    maxDocumentMegabytes: 1,
    workerFallbackPollMs: 1_000,
  });
}

function buildEmbeddingInputFormatRecord() {
  return {
    ...TEST_PLAIN_EMBEDDING_INPUT_FORMAT,
    createdAt: new Date("2026-07-15T12:00:00.000Z"),
    retiredAt: null,
  };
}

function buildBrowserDocument(
  overrides: Partial<BrowserDocument> = {},
): BrowserDocument {
  return {
    activeDocumentId: "a".repeat(64),
    activeVersionId: "00000000-0000-4000-8000-000000000001",
    attemptCount: null,
    byteLength: 4_096,
    controlError: null,
    controlState: "active",
    displayStatus: "ready",
    documentId: "a".repeat(64),
    embeddingSpaceIds: [
      "embedding-model:plain:768:window-2e666b3b90c9157e",
    ],
    embeddingProgress: {
      completedElements: 5,
      state: "complete",
      totalElements: 5,
    },
    errorMessage: null,
    images: 0,
    maxAttempts: null,
    mediaDescriptionProgress: {
      completedImages: 0,
      completedTables: 1,
    },
    nextAttemptAt: null,
    pageCount: null,
    phase: null,
    queryStatus: "ready",
    sourceFile: "/documents/handbook.docx",
    status: "ready",
    tables: 1,
    tags: ["handbook"],
    textChunks: 4,
    totalElements: 5,
    updatedAt: "2026-07-13T16:00:00.000Z",
    uploadedByUserId: null,
    ...overrides,
  };
}

function buildCatalogResult(
  documents: BrowserDocument[] = [buildBrowserDocument()],
): BrowseDocumentCatalogResult {
  return {
    attention: { documents: [], total: 0 },
    documents,
    facets: {
      failed: 0,
      pending: 0,
      processing: 0,
      queryable: 1,
      queryableTags: [{ count: 1, tag: "handbook" }],
      ready: 1,
      reindexRequired: 0,
      running: 0,
      tags: [{ count: 1, tag: "handbook" }],
      total: documents.length,
      untagged: 0,
      uploads: 0,
    },
    page: 1,
    pageSize: 25,
    total: documents.length,
  };
}

function buildPendingJob(sourceFile: string): PendingIngestionJob {
  return {
    attemptCount: 0,
    documentId: "b".repeat(64),
    doclingAttemptConfig: null,
    doclingRunId: null,
    elementSetId: "c".repeat(64),
    embeddingSpaceId: "embedding-model:plain:768:window-2e666b3b90c9157e",
    controlError: null,
    controlState: "active",
    errorMessage: null,
    format: {
      extension: ".pdf",
      mediaType: "application/pdf",
    },
    generationId: "00000000-0000-4000-8000-000000000001",
    images: 0,
    leaseExpiresAt: null,
    maxAttempts: 3,
    nextAttemptAt: "2026-07-14T04:00:00.000Z",
    ownerId: null,
    pageCount: null,
    phase: "normalized",
    sourceFile,
    state: "pending",
    tables: 1,
    tags: ["legal"],
    textChunks: 4,
    totalElements: 5,
    updatedAt: "2026-07-14T04:00:00.000Z",
    uploadedByUserId: null,
  };
}

function buildConfig(): AppConfig {
  return readEqualWeightTestConfig({
    embeddingInputFormat: TEST_PLAIN_EMBEDDING_INPUT_FORMAT,
    providerOptions: {
      inferenceBaseUrl: "http://127.0.0.1:1234/v1",
    },
    runtime: buildRuntimeSettings(),
  });
}

function buildSpeechToTextConfig(): NonNullable<AppConfig["speechToText"]> {
  return {
    adapter: "omlx-transcription",
    apiToken: "transcription-token",
    baseUrl: "http://localhost:9000/v1",
    providerId: "local-ai",
    language: "English",
    maxAudioBytes: 10 * 1_024 * 1_024,
    model: "Qwen3-ASR-1.7B-8bit",
    prompt: "CiteLoom is the product name. Preserve the exact spelling CiteLoom.",
    runtimeName: "oMLX",
    timeoutMs: 60_000,
  };
}

function buildAudioFile(content: string, type: string): File {
  return new File([content], "browser-name.webm", { type });
}

function buildTranscriptionForm(
  files: File[],
  field?: [string, string],
): FormData {
  const form = new FormData();
  if (field !== undefined) {
    form.append(field[0], field[1]);
  }
  for (const file of files) {
    form.append("file", file, file.name);
  }
  return form;
}

function createAnswerStream(
  answer: string,
): ReadableStream<InferUIMessageChunk<CiteLoomUIMessage>> {
  return createUIMessageStream<CiteLoomUIMessage>({
    execute: ({ writer }) => {
      writer.write({ type: "start" });
      writer.write({
        data: {
          answerDocument: {
            citations: [{
              citationNumber: 1,
              documentId: "a".repeat(64),
              documentVersionId: "00000000-0000-4000-8000-000000000002",
              elementId: "b".repeat(64),
              evidence: { excerpt: "Supporting evidence.", kind: "text" },
              id: "00000000-0000-4000-8000-000000000003",
              kind: "text",
              pageNumbers: [1],
              regions: [],
              sectionPath: [],
              sourceFile: "/tmp/report.pdf",
            }],
            schemaVersion: 1,
            statements: [{
              citationIds: ["00000000-0000-4000-8000-000000000003"],
              content: answer,
              presentation: "paragraph",
              section: "answer",
            }],
          },
          claims: [],
          matchedDocuments: [],
          runDetails: null,
          turn: {
            runId: "00000000-0000-4000-8000-000000000004",
            sequence: 1,
            threadId: "00000000-0000-4000-8000-000000000001",
            turnId: "00000000-0000-4000-8000-000000000005",
          },
        },
        id: "answer",
        type: "data-answer",
      });
      writer.write({ finishReason: "stop", type: "finish" });
    },
  });
}

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "citeloom-web-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function buildMultipartRequest(form: FormData): Promise<{
  headers: Record<string, string>;
  payload: Buffer;
}> {
  const request = new Request("http://citeloom.test/api/ingestions", {
    body: form,
    method: "POST",
  });
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key] = value;
  });
  const payload = Buffer.from(await request.arrayBuffer());
  return { headers, payload };
}

async function readDirectoryEntries(directory: string): Promise<string[]> {
  return readdir(directory);
}
