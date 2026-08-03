import type { FastifyInstance, FastifyReply } from "fastify";

import {
  decodeChangePasswordInput,
  decodeCreateWorkspaceMemberInput,
  decodeLoginInput,
  decodePasswordSetupInput,
  decodeWorkspaceMemberId,
  decodeWorkspaceMemberRoleInput,
} from "../auth/boundary.js";
import type { AuthenticatedPrincipal } from "../auth/model.js";
import {
  AuthenticationRejectedError,
  FinalWorkspaceAdministratorError,
  SetupTokenRejectedError,
  UsernameUnavailableError,
  WorkspaceAuthorizationError,
  WorkspaceMemberNotFoundError,
} from "../auth/store.js";
import {
  LoginRateLimiter,
  LoginRateLimitExceededError,
} from "../auth/rate-limit.js";
import type { WebConfig } from "./config.js";
import { WebRequestError } from "./request-boundary.js";
import type { WebServices } from "./services.js";

const PUBLIC_LOGIN_WEB_PATHS = new Set([
  "/assets/fonts/citeloom-space-grotesk-latin-ext.woff2",
  "/assets/fonts/citeloom-space-grotesk-latin.woff2",
  "/assets/fonts/citeloom-space-grotesk-vietnamese.woff2",
  "/assets/images/citeloom-icons.svg",
  "/assets/images/citeloom-mark.png",
  "/assets/images/citeloom-particle-flow.svg",
  "/assets/scripts/citeloom-app.js",
  "/assets/scripts/citeloom-bootstrap.js",
  "/assets/scripts/citeloom-boundaries.js",
  "/assets/scripts/citeloom-dashboard-extensions.js",
  "/assets/scripts/citeloom-document-notifications.js",
  "/assets/scripts/citeloom-login.js",
  "/assets/scripts/citeloom-notices.js",
  "/assets/styles/citeloom-base.css",
  "/assets/styles/citeloom-login.css",
  "/assets/styles/citeloom-navigation.css",
  "/assets/styles/citeloom-shell.css",
  "/fragments/login.html",
  "/login",
]);
const ADMINISTRATOR_WEB_PATHS = new Set([
  "/errors",
  "/fragments/errors.html",
]);
const LOGIN_REDIRECT_HEADER = "HX-Redirect";
const LOGIN_REDIRECT_PATH = "/login";
const disabledAuthenticationPrincipal: AuthenticatedPrincipal = {
  displayName: "Disabled authentication",
  role: "admin",
  sessionTokenDigest: "0".repeat(64),
  userId: "00000000-0000-4000-8000-000000000000",
  username: "disabled-authentication",
  workspaceId: "00000000-0000-4000-8000-000000000000",
  workspaceName: "Disabled authentication",
};

export interface AuthenticationRouteOptions {
  authentication: "disabled" | "required";
  requestPrincipals: WeakMap<object, AuthenticatedPrincipal>;
  services: WebServices;
  webConfig: WebConfig;
}

export function registerAuthenticationRoutes(
  server: FastifyInstance,
  options: AuthenticationRouteOptions,
): void {
  const {
    authentication,
    requestPrincipals,
    services,
    webConfig,
  } = options;
  const loginRateLimiter = new LoginRateLimiter();

  server.addHook("onRequest", async (request, reply) => {
    if (authentication === "disabled") {
      requestPrincipals.set(request, disabledAuthenticationPrincipal);
      return;
    }
    const pathname = readRequestPathname(request.url);
    if (!pathname.startsWith("/api/")) {
      if (PUBLIC_LOGIN_WEB_PATHS.has(pathname)) {
        return;
      }
      const principal = await readRequestSession(
        request.cookies,
        reply,
        services,
        webConfig,
      );
      if (principal === null) {
        if (request.headers["hx-request"] === "true") {
          return reply
            .header(LOGIN_REDIRECT_HEADER, LOGIN_REDIRECT_PATH)
            .status(401)
            .send();
        }
        return reply.redirect(LOGIN_REDIRECT_PATH);
      }
      if (
        ADMINISTRATOR_WEB_PATHS.has(pathname)
        && principal.role !== "admin"
      ) {
        throw new WebRequestError(
          403,
          "Workspace administrator access is required.",
        );
      }
      requestPrincipals.set(request, principal);
      return;
    }
    if (isPublicAuthenticationPath(pathname)) {
      requireSameOriginForMutation(
        request.method,
        request.headers.origin,
        webConfig,
      );
      return;
    }
    const principal = await readRequestSession(
      request.cookies,
      reply,
      services,
      webConfig,
    );
    if (principal === null) {
      return reply
        .header(LOGIN_REDIRECT_HEADER, LOGIN_REDIRECT_PATH)
        .status(401)
        .send({
          error: { message: "Authentication is required." },
        });
    }
    requireSameOriginForMutation(
      request.method,
      request.headers.origin,
      webConfig,
    );
    requestPrincipals.set(request, principal);
  });

  server.post("/api/auth/login", async (request, reply) => {
    const login = decodeLoginInput(request.body);
    try {
      loginRateLimiter.check(request.ip, login.usernameNormalized);
      const session = await services.authenticate(login);
      loginRateLimiter.recordSuccess(login.usernameNormalized);
      setSessionCookie(reply, session.token, session.expiresAt, webConfig);
      return buildSessionResponse(session.principal, session.expiresAt);
    } catch (error: unknown) {
      if (error instanceof AuthenticationRejectedError) {
        loginRateLimiter.recordFailure(request.ip, login.usernameNormalized);
        throw new WebRequestError(401, error.message);
      }
      if (error instanceof LoginRateLimitExceededError) {
        throw new WebRequestError(429, error.message);
      }
      throw error;
    }
  });

  server.post("/api/auth/setup", async (request, reply) => {
    const setup = decodePasswordSetupInput(request.body);
    try {
      const session = await services.completePasswordSetup(
        setup.setupToken,
        setup.password,
      );
      setSessionCookie(reply, session.token, session.expiresAt, webConfig);
      return buildSessionResponse(session.principal, session.expiresAt);
    } catch (error: unknown) {
      if (error instanceof SetupTokenRejectedError) {
        throw new WebRequestError(400, error.message);
      }
      throw error;
    }
  });

  server.get("/api/auth/session", async (request) => {
    const principal = requireRequestPrincipal(requestPrincipals, request);
    return buildSessionResponse(principal, null);
  });

  server.post("/api/auth/logout", async (request, reply) => {
    const sessionToken = request.cookies[readSessionCookieName(webConfig)];
    if (sessionToken !== undefined) {
      await services.revokeSession(sessionToken);
    }
    clearSessionCookie(reply, webConfig);
    return reply.status(204).send();
  });

  server.put("/api/auth/password", async (request, reply) => {
    const principal = requireRequestPrincipal(requestPrincipals, request);
    const passwords = decodeChangePasswordInput(request.body);
    try {
      await services.changePassword(
        principal,
        passwords.currentPassword,
        passwords.newPassword,
      );
      return reply.status(204).send();
    } catch (error: unknown) {
      if (error instanceof AuthenticationRejectedError) {
        throw new WebRequestError(401, "The current password is incorrect.");
      }
      throw error;
    }
  });

  server.post("/api/workspace/members", async (request, reply) => {
    const principal = requireRequestPrincipal(requestPrincipals, request);
    const member = decodeCreateWorkspaceMemberInput(request.body);
    try {
      const setup = await services.createWorkspaceMember(
        principal,
        member.identity,
        member.role,
      );
      return reply.status(201).send(setup);
    } catch (error: unknown) {
      if (error instanceof WorkspaceAuthorizationError) {
        throw new WebRequestError(403, error.message);
      }
      if (error instanceof UsernameUnavailableError) {
        throw new WebRequestError(409, error.message);
      }
      throw error;
    }
  });

  server.get("/api/workspace/members", async (request) => {
    const principal = requireRequestPrincipal(requestPrincipals, request);
    try {
      return await services.listWorkspaceMembers(principal);
    } catch (error: unknown) {
      throw mapWorkspaceMembershipError(error);
    }
  });

  server.put("/api/workspace/members/:userId/role", async (request, reply) => {
    const principal = requireRequestPrincipal(requestPrincipals, request);
    const userId = decodeWorkspaceMemberId(request.params);
    const role = decodeWorkspaceMemberRoleInput(request.body);
    try {
      await services.changeWorkspaceMemberRole(principal, userId, role);
      return reply.status(204).send();
    } catch (error: unknown) {
      throw mapWorkspaceMembershipError(error);
    }
  });

  server.post(
    "/api/workspace/members/:userId/password-reset",
    async (request, reply) => {
      const principal = requireRequestPrincipal(requestPrincipals, request);
      const userId = decodeWorkspaceMemberId(request.params);
      try {
        const reset = await services.createPasswordReset(principal, userId);
        return reply.status(201).send(reset);
      } catch (error: unknown) {
        throw mapWorkspaceMembershipError(error);
      }
    },
  );

  server.delete(
    "/api/workspace/members/:userId",
    async (request, reply) => {
      const principal = requireRequestPrincipal(requestPrincipals, request);
      const userId = decodeWorkspaceMemberId(request.params);
      try {
        await services.removeWorkspaceMember(principal, userId);
        return reply.status(204).send();
      } catch (error: unknown) {
        throw mapWorkspaceMembershipError(error);
      }
    },
  );
}

export function requireRequestPrincipal<T extends object>(
  principals: WeakMap<object, AuthenticatedPrincipal>,
  request: T,
): AuthenticatedPrincipal {
  const principal = principals.get(request);
  if (principal === undefined) {
    throw new WebRequestError(401, "Authentication is required.");
  }
  return principal;
}

export function requireAdministratorPrincipal<T extends object>(
  principals: WeakMap<object, AuthenticatedPrincipal>,
  request: T,
): AuthenticatedPrincipal {
  const principal = requireRequestPrincipal(principals, request);
  if (principal.role !== "admin") {
    throw new WebRequestError(
      403,
      "Workspace administrator access is required.",
    );
  }
  return principal;
}

function isPublicAuthenticationPath(pathname: string): boolean {
  return pathname === "/api/auth/login" || pathname === "/api/auth/setup";
}

function readRequestPathname(url: string): string {
  return url.split("?", 1)[0] ?? url;
}

async function readRequestSession(
  cookies: Record<string, string | undefined>,
  reply: FastifyReply,
  services: Pick<WebServices, "readSession">,
  webConfig: WebConfig,
): Promise<AuthenticatedPrincipal | null> {
  const sessionToken = cookies[readSessionCookieName(webConfig)];
  if (sessionToken === undefined) {
    return null;
  }
  const principal = await services.readSession(sessionToken);
  if (principal === null) {
    clearSessionCookie(reply, webConfig);
  }
  return principal;
}

function requireSameOriginForMutation(
  method: string,
  origin: string | undefined,
  webConfig: WebConfig,
): void {
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
    return;
  }
  if (origin !== webConfig.publicOrigin) {
    throw new WebRequestError(403, "The request origin is not allowed.");
  }
}

function readSessionCookieName(webConfig: WebConfig): string {
  return webConfig.secureSessionCookie
    ? "__Host-citeloom_session"
    : "citeloom_session";
}

function setSessionCookie(
  reply: FastifyReply,
  sessionToken: string,
  expiresAt: string,
  webConfig: WebConfig,
): void {
  reply.setCookie(readSessionCookieName(webConfig), sessionToken, {
    expires: new Date(expiresAt),
    httpOnly: true,
    path: "/",
    sameSite: "strict",
    secure: webConfig.secureSessionCookie,
  });
  reply.header("Cache-Control", "no-store");
}

function clearSessionCookie(reply: FastifyReply, webConfig: WebConfig): void {
  reply.clearCookie(readSessionCookieName(webConfig), {
    httpOnly: true,
    path: "/",
    sameSite: "strict",
    secure: webConfig.secureSessionCookie,
  });
  reply.header("Cache-Control", "no-store");
}

function buildSessionResponse(
  principal: AuthenticatedPrincipal,
  expiresAt: string | null,
): {
  expiresAt: string | null;
  user: { displayName: string; id: string; username: string };
  workspace: { id: string; name: string; role: "admin" | "member" };
} {
  return {
    expiresAt,
    user: {
      displayName: principal.displayName,
      id: principal.userId,
      username: principal.username,
    },
    workspace: {
      id: principal.workspaceId,
      name: principal.workspaceName,
      role: principal.role,
    },
  };
}

function mapWorkspaceMembershipError(error: unknown): unknown {
  if (error instanceof WorkspaceAuthorizationError) {
    return new WebRequestError(403, error.message);
  }
  if (error instanceof WorkspaceMemberNotFoundError) {
    return new WebRequestError(404, error.message);
  }
  if (error instanceof FinalWorkspaceAdministratorError) {
    return new WebRequestError(409, error.message);
  }
  return error;
}
