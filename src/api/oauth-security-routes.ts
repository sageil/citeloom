import type { FastifyInstance } from "fastify";
import { ZodError } from "zod";

import type { AuthenticatedPrincipal } from "../auth/model.js";
import { OAuthConfigurationVerificationError } from "../oauth/access-token.js";
import {
  decodeOAuthConfigurationDisableInput,
  decodeOAuthConfigurationUpdateInput,
  decodeOAuthConfigurationVerificationInput,
  decodeOAuthUserIdentityLinkInput,
  decodeOAuthUserLinkTarget,
  decodeOAuthWorkspaceLinkInput,
  decodeOAuthWorkspaceLinkTarget,
} from "../oauth/boundary.js";
import { OAuthConfigurationValidationError } from "../oauth/config.js";
import {
  OAuthConfigurationVersionConflictError,
  OAuthResourceDisabledError,
  OAuthResourceUnconfiguredError,
} from "../oauth/configuration-store.js";
import {
  OAuthLinkConflictError,
  OAuthLinkTargetUnavailableError,
} from "../oauth/link-store.js";
import {
  requireGlobalAdministratorPrincipal,
} from "./authentication-routes.js";
import { WebRequestError } from "./request-boundary.js";
import type {
  OAuthSecurityWebServices,
  WebServices,
} from "./services.js";

export interface OAuthSecurityRouteOptions {
  publicOrigin: string;
  requestPrincipals: WeakMap<object, AuthenticatedPrincipal>;
  services: OAuthSecurityWebServices;
}

const oauthSecurityServiceMethods = [
  "disableOAuthConfiguration",
  "linkOAuthUserIdentity",
  "linkOAuthWorkspace",
  "readOAuthConfiguration",
  "readOAuthSecurityOverview",
  "resolveOAuthPrincipal",
  "unlinkOAuthUserIdentity",
  "unlinkOAuthWorkspace",
  "updateOAuthConfiguration",
  "verifyOAuthConfiguration",
] as const;

export function registerOAuthSecurityRoutes(
  server: FastifyInstance,
  options: OAuthSecurityRouteOptions,
): void {
  const { publicOrigin, requestPrincipals, services } = options;

  server.get("/api/security/oauth", async (request) => {
    const principal = requireGlobalAdministratorPrincipal(
      requestPrincipals,
      request,
    );
    return services.readOAuthSecurityOverview(principal, publicOrigin);
  });

  server.post(
    "/api/security/oauth/configuration/verify",
    async (request, reply) => {
      const principal = requireGlobalAdministratorPrincipal(
        requestPrincipals,
        request,
      );
      try {
        const input = decodeOAuthConfigurationVerificationInput(
          request.body,
          publicOrigin,
        );
        await services.verifyOAuthConfiguration(principal, input);
        return reply.status(204).send();
      } catch (error: unknown) {
        throw mapOAuthAdministrationError(error);
      }
    },
  );

  server.put("/api/security/oauth/configuration", async (request) => {
    const principal = requireGlobalAdministratorPrincipal(
      requestPrincipals,
      request,
    );
    try {
      const input = decodeOAuthConfigurationUpdateInput(
        request.body,
        publicOrigin,
      );
      return await services.updateOAuthConfiguration(
        principal,
        input,
        publicOrigin,
      );
    } catch (error: unknown) {
      throw mapOAuthAdministrationError(error);
    }
  });

  server.post("/api/security/oauth/configuration/disable", async (request) => {
    const principal = requireGlobalAdministratorPrincipal(
      requestPrincipals,
      request,
    );
    try {
      const expectedVersion = decodeOAuthConfigurationDisableInput(
        request.body,
      );
      return await services.disableOAuthConfiguration(
        principal,
        expectedVersion,
        publicOrigin,
      );
    } catch (error: unknown) {
      throw mapOAuthAdministrationError(error);
    }
  });

  server.put("/api/security/oauth/users/:userId", async (request, reply) => {
    const principal = requireGlobalAdministratorPrincipal(
      requestPrincipals,
      request,
    );
    try {
      const userId = decodeOAuthUserLinkTarget(request.params);
      const input = decodeOAuthUserIdentityLinkInput(request.body);
      await services.linkOAuthUserIdentity(
        principal,
        publicOrigin,
        userId,
        input.subject,
      );
      return reply.status(204).send();
    } catch (error: unknown) {
      throw mapOAuthAdministrationError(error);
    }
  });

  server.delete("/api/security/oauth/users/:userId", async (request, reply) => {
    const principal = requireGlobalAdministratorPrincipal(
      requestPrincipals,
      request,
    );
    try {
      const userId = decodeOAuthUserLinkTarget(request.params);
      await services.unlinkOAuthUserIdentity(principal, publicOrigin, userId);
      return reply.status(204).send();
    } catch (error: unknown) {
      throw mapOAuthAdministrationError(error);
    }
  });

  server.put(
    "/api/security/oauth/workspaces/:workspaceId",
    async (request, reply) => {
      const principal = requireGlobalAdministratorPrincipal(
        requestPrincipals,
        request,
      );
      try {
        const workspaceId = decodeOAuthWorkspaceLinkTarget(request.params);
        const input = decodeOAuthWorkspaceLinkInput(request.body);
        await services.linkOAuthWorkspace(
          principal,
          publicOrigin,
          workspaceId,
          input.externalWorkspaceId,
        );
        return reply.status(204).send();
      } catch (error: unknown) {
        throw mapOAuthAdministrationError(error);
      }
    },
  );

  server.delete(
    "/api/security/oauth/workspaces/:workspaceId",
    async (request, reply) => {
      const principal = requireGlobalAdministratorPrincipal(
        requestPrincipals,
        request,
      );
      try {
        const workspaceId = decodeOAuthWorkspaceLinkTarget(request.params);
        await services.unlinkOAuthWorkspace(
          principal,
          publicOrigin,
          workspaceId,
        );
        return reply.status(204).send();
      } catch (error: unknown) {
        throw mapOAuthAdministrationError(error);
      }
    },
  );
}

export function readOAuthSecurityWebServices(
  services: WebServices,
): OAuthSecurityWebServices | null {
  const candidate = services as WebServices & Partial<OAuthSecurityWebServices>;
  for (const method of oauthSecurityServiceMethods) {
    if (typeof candidate[method] !== "function") {
      return null;
    }
  }
  return candidate as WebServices & OAuthSecurityWebServices;
}

function mapOAuthAdministrationError(error: unknown): unknown {
  if (error instanceof ZodError) {
    return new WebRequestError(400, "The OAuth request values are invalid.");
  }
  if (error instanceof OAuthConfigurationValidationError) {
    return new WebRequestError(400, "The OAuth configuration values are invalid.");
  }
  if (error instanceof OAuthConfigurationVerificationError) {
    return new WebRequestError(422, error.message);
  }
  if (error instanceof OAuthLinkTargetUnavailableError) {
    return new WebRequestError(404, error.message);
  }
  if (
    error instanceof OAuthConfigurationVersionConflictError
    || error instanceof OAuthLinkConflictError
    || error instanceof OAuthResourceDisabledError
    || error instanceof OAuthResourceUnconfiguredError
  ) {
    return new WebRequestError(409, error.message);
  }
  return error;
}
