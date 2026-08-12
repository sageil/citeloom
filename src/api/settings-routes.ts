import type { FastifyInstance } from "fastify";

import { decodeWorkspaceId } from "../auth/boundary.js";
import type { AuthenticatedPrincipal } from "../auth/model.js";
import {
  WorkspaceAuthorizationError,
  WorkspaceUnavailableError,
} from "../auth/store.js";
import type { AppConfig } from "../config/index.js";
import { SettingsValidationError, SettingsVersionConflictError } from "../app/settings.js";
import {
  EmbeddingInputFormatInUseError,
  EmbeddingInputFormatNotFoundError,
} from "../embedding/input-format-store.js";
import {
  OpenAICodexAuthenticationRequiredError,
  OpenAICodexProviderInUseError,
} from "../providers/openai-codex-credentials.js";
import {
  OpenAICodexDeviceAuthController,
} from "../providers/openai-codex-device-auth.js";
import { OpenAICodexOAuthError } from "../providers/openai-codex-oauth.js";
import {
  requireGlobalAdministratorPrincipal,
  requireRequestPrincipal,
  requireWorkspaceAdministratorPrincipal,
} from "./authentication-routes.js";
import type { WebConfig } from "./config.js";
import {
  decodeApplicationSettingsUpdate,
  decodeCopyEmbeddingInputFormatRequest,
  decodeEmbeddingInputFormatDefinition,
  decodeResourceId,
  WebRequestError,
} from "./request-boundary.js";
import type { WebServices } from "./services.js";
import {
  buildApplicationSettingsResponse,
  buildOrganizationSettingsScope,
  buildWorkspaceSettingsScope,
  type ApplicationSettingsResponse,
} from "./settings-response.js";

export interface SettingsRouteOptions {
  config: AppConfig;
  requestPrincipals: WeakMap<object, AuthenticatedPrincipal>;
  services: WebServices;
  webConfig: WebConfig;
}

export function registerSettingsRoutes(
  server: FastifyInstance,
  options: SettingsRouteOptions,
): void {
  const { config, requestPrincipals, services, webConfig } = options;
  const openAICodexDeviceAuth = new OpenAICodexDeviceAuthController({
    persistCredentials: async (credentials) => {
      await services.openAICodex.replaceCredentials(credentials);
    },
  });
  server.addHook("onClose", async () => openAICodexDeviceAuth.close());

  server.get(
    "/api/settings",
    async (request): Promise<ApplicationSettingsResponse> => {
      const principal = requireRequestPrincipal(requestPrincipals, request);
      const workspaces = await services.listWorkspaces(principal);
      if (principal.globalRole !== "global_admin") {
        requireWorkspaceAdministratorPrincipal(
          requestPrincipals,
          request,
          principal.workspaceId,
        );
        const workspace = requireSettingsWorkspace(
          workspaces,
          principal.workspaceId,
        );
        const settings = await readSettingsWorkspace(
          services,
          principal,
          workspace.id,
        );
        return buildApplicationSettingsResponse(
          settings,
          config,
          webConfig,
          buildWorkspaceSettingsScope(workspace, [workspace], false),
        );
      }
      const settings = await services.readSettings();
      return buildApplicationSettingsResponse(
        settings,
        config,
        webConfig,
        buildOrganizationSettingsScope(workspaces),
      );
    },
  );

  server.get(
    "/api/workspaces/:workspaceId/settings",
    async (request): Promise<ApplicationSettingsResponse> => {
      const principal = requireRequestPrincipal(requestPrincipals, request);
      const workspaceId = decodeWorkspaceId(request.params);
      requireWorkspaceAdministratorPrincipal(
        requestPrincipals,
        request,
        workspaceId,
      );
      const workspaces = await services.listWorkspaces(principal);
      const workspace = requireSettingsWorkspace(workspaces, workspaceId);
      const settings = await readSettingsWorkspace(
        services,
        principal,
        workspaceId,
      );
      return buildApplicationSettingsResponse(
        settings,
        config,
        webConfig,
        buildSettingsWorkspaceScope(principal, workspace, workspaces),
      );
    },
  );

  server.post("/api/embedding-input-formats", async (request, reply) => {
    requireGlobalAdministratorPrincipal(requestPrincipals, request);
    const definition = decodeEmbeddingInputFormatDefinition(request.body);
    const format = await services.createEmbeddingInputFormat(definition);
    return reply.status(201).send({ id: format.id });
  });

  server.post(
    "/api/embedding-input-formats/:id/copies",
    async (request, reply) => {
      requireGlobalAdministratorPrincipal(requestPrincipals, request);
      const id = decodeResourceId(request.params);
      const copy = decodeCopyEmbeddingInputFormatRequest(request.body);
      try {
        const format = await services.copyEmbeddingInputFormat(id, copy.name);
        return reply.status(201).send({ id: format.id });
      } catch (error: unknown) {
        throw mapEmbeddingInputFormatError(error);
      }
    },
  );

  server.post(
    "/api/embedding-input-formats/:id/revisions",
    async (request, reply) => {
      requireGlobalAdministratorPrincipal(requestPrincipals, request);
      const id = decodeResourceId(request.params);
      const definition = decodeEmbeddingInputFormatDefinition(request.body);
      try {
        const format = await services.reviseEmbeddingInputFormat(
          id,
          definition,
        );
        return reply.status(201).send({ id: format.id });
      } catch (error: unknown) {
        throw mapEmbeddingInputFormatError(error);
      }
    },
  );

  server.delete("/api/embedding-input-formats/:id", async (request) => {
    requireGlobalAdministratorPrincipal(requestPrincipals, request);
    const id = decodeResourceId(request.params);
    try {
      const format = await services.retireEmbeddingInputFormat(id);
      return { id: format.id };
    } catch (error: unknown) {
      throw mapEmbeddingInputFormatError(error);
    }
  });

  server.put(
    "/api/settings",
    async (request): Promise<ApplicationSettingsResponse> => {
      const principal = requireRequestPrincipal(requestPrincipals, request);
      requireGlobalAdministratorPrincipal(requestPrincipals, request);
      const settingsRequest = decodeApplicationSettingsUpdate(request.body);
      try {
        const settings = await services.updateSettings(settingsRequest);
        const workspaces = await services.listWorkspaces(principal);
        return buildApplicationSettingsResponse(
          settings,
          config,
          webConfig,
          buildOrganizationSettingsScope(workspaces),
        );
      } catch (error: unknown) {
        throw mapSettingsUpdateError(error);
      }
    },
  );

  server.put(
    "/api/workspaces/:workspaceId/settings",
    async (request): Promise<ApplicationSettingsResponse> => {
      const principal = requireRequestPrincipal(requestPrincipals, request);
      const workspaceId = decodeWorkspaceId(request.params);
      requireWorkspaceAdministratorPrincipal(
        requestPrincipals,
        request,
        workspaceId,
      );
      const settingsRequest = decodeApplicationSettingsUpdate(request.body);
      try {
        const settings = await services.updateWorkspaceSettings(
          principal,
          workspaceId,
          settingsRequest,
        );
        const workspaces = await services.listWorkspaces(principal);
        const workspace = requireSettingsWorkspace(workspaces, workspaceId);
        return buildApplicationSettingsResponse(
          settings,
          config,
          webConfig,
          buildSettingsWorkspaceScope(principal, workspace, workspaces),
        );
      } catch (error: unknown) {
        throw mapSettingsUpdateError(error);
      }
    },
  );

  server.get("/api/providers/openai-codex/auth", async (request, reply) => {
    requireGlobalAdministratorPrincipal(requestPrincipals, request);
    reply.header("Cache-Control", "private, no-store");
    const connection = await services.openAICodex.readConnectionState();
    return {
      connection,
      flow: openAICodexDeviceAuth.readStatus(),
    };
  });

  server.post(
    "/api/providers/openai-codex/device-authorization",
    async (request, reply) => {
      requireGlobalAdministratorPrincipal(requestPrincipals, request);
      reply.header("Cache-Control", "private, no-store");
      try {
        const flow = await openAICodexDeviceAuth.start();
        return reply.status(201).send(flow);
      } catch (error: unknown) {
        throw mapOpenAICodexError(error);
      }
    },
  );

  server.delete(
    "/api/providers/openai-codex/device-authorization",
    async (request, reply) => {
      requireGlobalAdministratorPrincipal(requestPrincipals, request);
      reply.header("Cache-Control", "private, no-store");
      const flow = await openAICodexDeviceAuth.cancel();
      return { flow };
    },
  );

  server.delete(
    "/api/providers/openai-codex/auth",
    async (request, reply) => {
      requireGlobalAdministratorPrincipal(requestPrincipals, request);
      reply.header("Cache-Control", "private, no-store");
      await openAICodexDeviceAuth.cancel();
      try {
        await services.openAICodex.disconnect();
      } catch (error: unknown) {
        throw mapOpenAICodexError(error);
      }
      return reply.status(204).send();
    },
  );

  server.get(
    "/api/providers/openai-codex/models",
    async (request, reply) => {
      requireGlobalAdministratorPrincipal(requestPrincipals, request);
      reply.header("Cache-Control", "private, no-store");
      try {
        const models = await services.openAICodex.readModels(
          AbortSignal.timeout(30_000),
        );
        return { models };
      } catch (error: unknown) {
        throw mapOpenAICodexError(error);
      }
    },
  );
}

function requireSettingsWorkspace(
  workspaces: Awaited<ReturnType<WebServices["listWorkspaces"]>>,
  workspaceId: string,
) {
  for (const workspace of workspaces) {
    if (workspace.id === workspaceId && workspace.role === "admin") {
      return workspace;
    }
  }
  throw new WebRequestError(404, "The workspace is unavailable.");
}

function buildSettingsWorkspaceScope(
  principal: AuthenticatedPrincipal,
  workspace: Awaited<ReturnType<WebServices["listWorkspaces"]>>[number],
  workspaces: Awaited<ReturnType<WebServices["listWorkspaces"]>>,
) {
  if (principal.globalRole === "global_admin") {
    return buildWorkspaceSettingsScope(workspace, workspaces, true);
  }
  return buildWorkspaceSettingsScope(workspace, [workspace], false);
}

async function readSettingsWorkspace(
  services: WebServices,
  principal: AuthenticatedPrincipal,
  workspaceId: string,
) {
  try {
    return await services.readWorkspaceSettings(principal, workspaceId);
  } catch (error: unknown) {
    throw mapWorkspaceSettingsError(error);
  }
}

function mapSettingsUpdateError(error: unknown): unknown {
  if (error instanceof SettingsVersionConflictError) {
    return new WebRequestError(409, error.message);
  }
  if (error instanceof SettingsValidationError) {
    return new WebRequestError(400, error.message);
  }
  return mapWorkspaceSettingsError(error);
}

function mapWorkspaceSettingsError(error: unknown): unknown {
  if (error instanceof WorkspaceAuthorizationError) {
    return new WebRequestError(403, error.message);
  }
  if (error instanceof WorkspaceUnavailableError) {
    return new WebRequestError(404, error.message);
  }
  return error;
}

function mapEmbeddingInputFormatError(error: unknown): unknown {
  if (error instanceof EmbeddingInputFormatNotFoundError) {
    return new WebRequestError(404, error.message);
  }
  if (error instanceof EmbeddingInputFormatInUseError) {
    return new WebRequestError(409, error.message);
  }
  return error;
}

function mapOpenAICodexError(error: unknown): unknown {
  if (
    error instanceof OpenAICodexAuthenticationRequiredError
    || error instanceof OpenAICodexProviderInUseError
  ) {
    return new WebRequestError(409, error.message);
  }
  if (error instanceof OpenAICodexOAuthError) {
    return new WebRequestError(502, error.message);
  }
  return error;
}
