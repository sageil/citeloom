import type { FastifyInstance } from "fastify";

import type { AuthenticatedPrincipal } from "../auth/model.js";
import type { AppConfig } from "../config/index.js";
import {
  type EffectiveApplicationSettings,
  SettingsValidationError,
  SettingsVersionConflictError,
} from "../app/settings.js";
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
import { requireAdministratorPrincipal } from "./authentication-routes.js";
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
      requireAdministratorPrincipal(requestPrincipals, request);
      const settings = await services.readSettings();
      return buildApplicationSettingsResponse(settings, config, webConfig);
    },
  );

  server.post("/api/embedding-input-formats", async (request, reply) => {
    requireAdministratorPrincipal(requestPrincipals, request);
    const definition = decodeEmbeddingInputFormatDefinition(request.body);
    const format = await services.createEmbeddingInputFormat(definition);
    return reply.status(201).send({ id: format.id });
  });

  server.post(
    "/api/embedding-input-formats/:id/copies",
    async (request, reply) => {
      requireAdministratorPrincipal(requestPrincipals, request);
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
      requireAdministratorPrincipal(requestPrincipals, request);
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
    requireAdministratorPrincipal(requestPrincipals, request);
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
      requireAdministratorPrincipal(requestPrincipals, request);
      const settingsRequest = decodeApplicationSettingsUpdate(request.body);
      let settings: EffectiveApplicationSettings;
      try {
        settings = await services.updateSettings(settingsRequest);
      } catch (error: unknown) {
        if (error instanceof SettingsVersionConflictError) {
          throw new WebRequestError(409, error.message);
        }
        if (error instanceof SettingsValidationError) {
          throw new WebRequestError(400, error.message);
        }
        throw error;
      }
      return buildApplicationSettingsResponse(settings, config, webConfig);
    },
  );

  server.get("/api/providers/openai-codex/auth", async (request, reply) => {
    requireAdministratorPrincipal(requestPrincipals, request);
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
      requireAdministratorPrincipal(requestPrincipals, request);
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
      requireAdministratorPrincipal(requestPrincipals, request);
      reply.header("Cache-Control", "private, no-store");
      const flow = await openAICodexDeviceAuth.cancel();
      return { flow };
    },
  );

  server.delete(
    "/api/providers/openai-codex/auth",
    async (request, reply) => {
      requireAdministratorPrincipal(requestPrincipals, request);
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
      requireAdministratorPrincipal(requestPrincipals, request);
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
