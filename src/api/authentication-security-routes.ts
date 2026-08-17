import type { FastifyInstance } from "fastify";
import { ZodError } from "zod";

import type { AuthorizationPrincipal } from "../auth/model.js";
import {
  OAuthAccessTokenRejectedError,
  OAuthConfigurationVerificationError,
  OAuthInsufficientScopeError,
} from "../oauth/access-token.js";
import {
  decodeHostRecoveryConfigurationInput,
  decodeOAuthApplicationActivationInput,
  decodeOAuthApplicationConfigurationStageInput,
  OAuthApplicationConfigurationError,
} from "../oauth/application-configuration.js";
import {
  AuthenticationSettingsVersionConflictError,
  HostRecoveryConfigurationRejectedError,
  OAuthActivationRejectedError,
  OAuthApplicationUnconfiguredError,
} from "../oauth/application-store.js";
import {
  OAuthIdentityLinkConflictError,
  OAuthIdentityLinkRemovalRejectedError,
  OAuthIdentityLinkTargetUnavailableError,
} from "../oauth/identity-link-store.js";
import {
  decodeOAuthUserIdentityLinkInput,
  decodeOAuthUserLinkTarget,
} from "../oauth/boundary.js";
import { requireGlobalAdministratorPrincipal } from "./authentication-routes.js";
import { WebRequestError } from "./request-boundary.js";
import type { AuthenticationSecurityWebServices } from "./services.js";
import { OAUTH_ACTIVATION_PROOF_HEADER } from "./application-authentication.js";

export interface AuthenticationSecurityRouteOptions {
  publicOrigin: string;
  requestPrincipals: WeakMap<object, AuthorizationPrincipal>;
  services: AuthenticationSecurityWebServices;
}

export function registerAuthenticationSecurityRoutes(
  server: FastifyInstance,
  options: AuthenticationSecurityRouteOptions,
): void {
  const { publicOrigin, requestPrincipals, services } = options;

  server.get("/api/security/authentication", async (request) => {
    const principal = requireGlobalAdministratorPrincipal(
      requestPrincipals,
      request,
    );
    return services.readAuthenticationSecurityOverview(principal, publicOrigin);
  });

  server.put(
    "/api/security/authentication/host-recovery",
    async (request) => {
      const principal = requireGlobalAdministratorPrincipal(
        requestPrincipals,
        request,
      );
      try {
        const input = decodeHostRecoveryConfigurationInput(request.body);
        return await services.configureHostAuthenticationRecovery(
          principal,
          input.enabled,
          input.expectedVersion,
          publicOrigin,
        );
      } catch (error: unknown) {
        throw mapAuthenticationAdministrationError(error);
      }
    },
  );

  server.put(
    "/api/security/authentication/oauth/staged",
    async (request) => {
      const principal = requireGlobalAdministratorPrincipal(
        requestPrincipals,
        request,
      );
      try {
        const input = decodeOAuthApplicationConfigurationStageInput(
          request.body,
        );
        return await services.stageOAuthApplicationConfiguration(
          principal,
          input.configuration,
          input.expectedVersion,
          publicOrigin,
        );
      } catch (error: unknown) {
        throw mapAuthenticationAdministrationError(error);
      }
    },
  );

  server.post(
    "/api/security/authentication/oauth/activate",
    async (request, reply) => {
      const principal = requireGlobalAdministratorPrincipal(
        requestPrincipals,
        request,
      );
      try {
        const expectedVersion = decodeOAuthApplicationActivationInput(
          request.body,
        );
        return await services.activateOAuthApplication(
          principal,
          request.headers[OAUTH_ACTIVATION_PROOF_HEADER],
          expectedVersion,
          publicOrigin,
        );
      } catch (error: unknown) {
        if (error instanceof OAuthAccessTokenRejectedError) {
          return reply
            .header("WWW-Authenticate", 'Bearer error="invalid_token"')
            .status(401)
            .send({ error: { message: error.message } });
        }
        if (error instanceof OAuthInsufficientScopeError) {
          return reply.status(403).send({
            error: { message: error.message },
          });
        }
        throw mapAuthenticationAdministrationError(error);
      }
    },
  );

  server.post(
    "/api/security/authentication/oauth/disable",
    async (request) => {
      const principal = requireGlobalAdministratorPrincipal(
        requestPrincipals,
        request,
      );
      try {
        const expectedVersion = decodeOAuthApplicationActivationInput(
          request.body,
        );
        return await services.disableOAuthApplication(
          principal,
          expectedVersion,
          publicOrigin,
        );
      } catch (error: unknown) {
        throw mapAuthenticationAdministrationError(error);
      }
    },
  );

  server.put(
    "/api/security/authentication/oauth/users/:userId",
    async (request, reply) => {
      const principal = requireGlobalAdministratorPrincipal(
        requestPrincipals,
        request,
      );
      try {
        const userId = decodeOAuthUserLinkTarget(request.params);
        const input = decodeOAuthUserIdentityLinkInput(request.body);
        await services.linkOAuthApplicationUserIdentity(
          principal,
          userId,
          input.subject,
          publicOrigin,
        );
        return reply.status(204).send();
      } catch (error: unknown) {
        throw mapAuthenticationAdministrationError(error);
      }
    },
  );

  server.delete(
    "/api/security/authentication/oauth/users/:userId",
    async (request, reply) => {
      const principal = requireGlobalAdministratorPrincipal(
        requestPrincipals,
        request,
      );
      try {
        const userId = decodeOAuthUserLinkTarget(request.params);
        await services.unlinkOAuthApplicationUserIdentity(
          principal,
          userId,
          publicOrigin,
        );
        return reply.status(204).send();
      } catch (error: unknown) {
        throw mapAuthenticationAdministrationError(error);
      }
    },
  );
}

function mapAuthenticationAdministrationError(error: unknown): unknown {
  if (error instanceof ZodError) {
    return new WebRequestError(400, "The OAuth request values are invalid.");
  }
  if (error instanceof OAuthApplicationConfigurationError) {
    return new WebRequestError(400, error.message);
  }
  if (error instanceof OAuthConfigurationVerificationError) {
    return new WebRequestError(422, error.message);
  }
  if (error instanceof OAuthIdentityLinkTargetUnavailableError) {
    return new WebRequestError(404, error.message);
  }
  if (
    error instanceof AuthenticationSettingsVersionConflictError
    || error instanceof HostRecoveryConfigurationRejectedError
    || error instanceof OAuthActivationRejectedError
    || error instanceof OAuthApplicationUnconfiguredError
    || error instanceof OAuthIdentityLinkConflictError
    || error instanceof OAuthIdentityLinkRemovalRejectedError
  ) {
    return new WebRequestError(409, error.message);
  }
  return error;
}
