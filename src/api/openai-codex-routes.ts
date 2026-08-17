import type { FastifyInstance } from "fastify";

import type { AuthorizationPrincipal } from "../auth/model.js";
import {
  OpenAICodexAuthenticationRequiredError,
  OpenAICodexProviderInUseError,
  type OpenAICodexConnectionState,
} from "../providers/openai-codex-credentials.js";
import {
  OpenAICodexDeviceAuthController,
} from "../providers/openai-codex-device-auth.js";
import type { OpenAICodexModel } from "../providers/openai-codex-models.js";
import {
  OpenAICodexOAuthError,
  type OpenAICodexOAuthCredentials,
} from "../providers/openai-codex-oauth.js";
import { requireGlobalAdministratorPrincipal } from "./authentication-routes.js";
import { WebRequestError } from "./request-boundary.js";

export interface OpenAICodexRouteServices {
  disconnect(): Promise<void>;
  readConnectionState(): Promise<OpenAICodexConnectionState>;
  readModels(signal: AbortSignal): Promise<OpenAICodexModel[]>;
  replaceCredentials(credentials: OpenAICodexOAuthCredentials): Promise<void>;
}

export interface OpenAICodexRouteOptions {
  requestPrincipals: WeakMap<object, AuthorizationPrincipal>;
  services: OpenAICodexRouteServices;
}

export function registerOpenAICodexRoutes(
  server: FastifyInstance,
  options: OpenAICodexRouteOptions,
): void {
  const { requestPrincipals, services } = options;
  const deviceAuth = new OpenAICodexDeviceAuthController({
    persistCredentials: async (credentials) => {
      await services.replaceCredentials(credentials);
    },
  });
  server.addHook("onClose", async () => deviceAuth.close());

  server.get("/api/providers/openai-codex/auth", async (request, reply) => {
    requireGlobalAdministratorPrincipal(requestPrincipals, request);
    reply.header("Cache-Control", "private, no-store");
    const connection = await services.readConnectionState();
    return {
      connection,
      flow: deviceAuth.readStatus(),
    };
  });

  server.post(
    "/api/providers/openai-codex/device-authorization",
    async (request, reply) => {
      requireGlobalAdministratorPrincipal(requestPrincipals, request);
      reply.header("Cache-Control", "private, no-store");
      try {
        const flow = await deviceAuth.start();
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
      const flow = await deviceAuth.cancel();
      return { flow };
    },
  );

  server.delete(
    "/api/providers/openai-codex/auth",
    async (request, reply) => {
      requireGlobalAdministratorPrincipal(requestPrincipals, request);
      reply.header("Cache-Control", "private, no-store");
      await deviceAuth.cancel();
      try {
        await services.disconnect();
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
        const models = await services.readModels(AbortSignal.timeout(30_000));
        return { models };
      } catch (error: unknown) {
        throw mapOpenAICodexError(error);
      }
    },
  );
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
