import type { FastifyInstance } from "fastify";
import { ZodError } from "zod";

import {
  decodeWorkspaceSecurityPolicyUpdate,
} from "../auth/boundary.js";
import type { AuthenticatedPrincipal } from "../auth/model.js";
import {
  SecurityPolicyVersionConflictError,
} from "../auth/security-policy-store.js";
import {
  requireAdministratorPrincipal,
  requireRequestPrincipal,
} from "./authentication-routes.js";
import { WebRequestError } from "./request-boundary.js";
import type { SecurityWebServices, WebServices } from "./services.js";

export interface SecurityRouteOptions {
  requestPrincipals: WeakMap<object, AuthenticatedPrincipal>;
  services: SecurityWebServices;
}

export function registerSecurityRoutes(
  server: FastifyInstance,
  options: SecurityRouteOptions,
): void {
  const { requestPrincipals, services } = options;

  server.get("/api/auth/password-policy", async (request) => {
    const principal = requireRequestPrincipal(requestPrincipals, request);
    return services.readPasswordPolicy(principal);
  });

  server.get("/api/security", async (request) => {
    const principal = requireAdministratorPrincipal(requestPrincipals, request);
    return services.readWorkspaceSecurityOverview(principal);
  });

  server.put("/api/security/policy", async (request) => {
    const principal = requireAdministratorPrincipal(requestPrincipals, request);
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
  if (
    typeof candidate.readPasswordPolicy !== "function"
    || typeof candidate.readWorkspaceSecurityOverview !== "function"
    || typeof candidate.updateWorkspaceSecurityPolicy !== "function"
  ) {
    return null;
  }
  return candidate as SecurityWebServices;
}
