import type { FastifyInstance } from "fastify";
import { ZodError } from "zod";

import {
  decodeCreateOrganizationUserInput,
  decodeOrganizationUserId,
  decodeWorkspaceSecurityPolicyUpdate,
} from "../auth/boundary.js";
import type { AuthenticatedPrincipal } from "../auth/model.js";
import {
  SecurityPolicyVersionConflictError,
} from "../auth/security-policy-store.js";
import {
  OrganizationUsernameUnavailableError,
  OrganizationUserUnavailableError,
  OrganizationUserWorkspaceRequiredError,
} from "../auth/user-account-store.js";
import {
  requireGlobalAdministratorPrincipal,
  requireRequestPrincipal,
  requireWorkspaceAdministratorPrincipal,
} from "./authentication-routes.js";
import { WebRequestError } from "./request-boundary.js";
import type { SecurityWebServices, WebServices } from "./services.js";

export interface SecurityRouteOptions {
  requestPrincipals: WeakMap<object, AuthenticatedPrincipal>;
  services: SecurityWebServices;
}

const securityServiceMethods = [
  "createOrganizationUser",
  "createOrganizationUserPasswordLink",
  "listOrganizationUsers",
  "readPasswordPolicy",
  "readWorkspaceSecurityOverview",
  "updateWorkspaceSecurityPolicy",
] as const;

export function registerSecurityRoutes(
  server: FastifyInstance,
  options: SecurityRouteOptions,
): void {
  const { requestPrincipals, services } = options;

  server.get("/api/auth/password-policy", async (request) => {
    const principal = requireRequestPrincipal(requestPrincipals, request);
    return services.readPasswordPolicy(principal);
  });

  server.get("/api/security/users", async (request) => {
    const principal = requireGlobalAdministratorPrincipal(
      requestPrincipals,
      request,
    );
    return services.listOrganizationUsers(principal);
  });

  server.post("/api/security/users", async (request, reply) => {
    const principal = requireGlobalAdministratorPrincipal(
      requestPrincipals,
      request,
    );
    try {
      const input = decodeCreateOrganizationUserInput(request.body);
      const user = await services.createOrganizationUser(principal, input);
      return reply.status(201).send(user);
    } catch (error: unknown) {
      if (error instanceof ZodError) {
        throw new WebRequestError(400, "The user account values are invalid.");
      }
      if (error instanceof OrganizationUsernameUnavailableError) {
        throw new WebRequestError(409, error.message);
      }
      throw error;
    }
  });

  server.post(
    "/api/security/users/:userId/password-link",
    async (request, reply) => {
      const principal = requireGlobalAdministratorPrincipal(
        requestPrincipals,
        request,
      );
      try {
        const userId = decodeOrganizationUserId(request.params);
        const link = await services.createOrganizationUserPasswordLink(
          principal,
          userId,
        );
        return reply.status(201).send(link);
      } catch (error: unknown) {
        if (error instanceof ZodError) {
          throw new WebRequestError(400, "The user identifier is invalid.");
        }
        if (error instanceof OrganizationUserUnavailableError) {
          throw new WebRequestError(404, error.message);
        }
        if (error instanceof OrganizationUserWorkspaceRequiredError) {
          throw new WebRequestError(409, error.message);
        }
        throw error;
      }
    },
  );

  server.get("/api/security", async (request) => {
    const principal = requireRequestPrincipal(requestPrincipals, request);
    requireWorkspaceAdministratorPrincipal(
      requestPrincipals,
      request,
      principal.workspaceId,
    );
    return services.readWorkspaceSecurityOverview(principal);
  });

  server.put("/api/security/policy", async (request) => {
    const principal = requireRequestPrincipal(requestPrincipals, request);
    requireWorkspaceAdministratorPrincipal(
      requestPrincipals,
      request,
      principal.workspaceId,
    );
    try {
      const input = decodeWorkspaceSecurityPolicyUpdate(request.body);
      return await services.updateWorkspaceSecurityPolicy(principal, input);
    } catch (error: unknown) {
      if (error instanceof ZodError) {
        throw new WebRequestError(400, "The security policy values are invalid.");
      }
      if (error instanceof SecurityPolicyVersionConflictError) {
        throw new WebRequestError(409, error.message);
      }
      throw error;
    }
  });
}

export function readSecurityWebServices(
  services: WebServices,
): SecurityWebServices | null {
  const candidate = services as WebServices & Partial<SecurityWebServices>;
  for (const method of securityServiceMethods) {
    if (typeof candidate[method] !== "function") {
      return null;
    }
  }
  return candidate as SecurityWebServices;
}
