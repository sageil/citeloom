import type { FastifyInstance, FastifyReply } from "fastify";
import { ZodError } from "zod";

import {
  decodeChangePasswordInput,
  decodeAddWorkspaceMemberInput,
  decodeCreateWorkspaceInput,
  decodeLoginInput,
  decodePasswordSetupInput,
  decodeRenameWorkspaceInput,
  decodeWorkspaceMemberTarget,
  decodeWorkspaceMemberRoleInput,
  decodeWorkspaceId,
  decodeWorkspaceMemberAccessInput,
} from "../auth/boundary.js";
import { canAdministerWorkspace } from "../auth/authorization.js";
import type {
  AuthenticatedPrincipal,
  AuthorizationPrincipal,
} from "../auth/model.js";
import {
  OAuthAccessTokenRejectedError,
  OAuthInsufficientScopeError,
} from "../oauth/access-token.js";
import {
  OAuthIdentityUnavailableError,
  type OAuthIdentityContext,
} from "../oauth/principal-store.js";
import {
  OAUTH_BROWSER_CALLBACK_PATH,
  OAUTH_MCP_RESOURCE_PATH,
} from "../oauth/application-configuration.js";
import { PasswordValidationError } from "../auth/password.js";
import {
  AuthenticationRejectedError,
  FinalWorkspaceAdministratorError,
  GlobalAuthorizationError,
  SetupTokenRejectedError,
  ProtectedGlobalAdministratorError,
  WorkspaceAuthorizationError,
  WorkspaceArchiveConflictError,
  WorkspaceConfigurationSourceUnavailableError,
  WorkspaceMemberNotFoundError,
  WorkspaceMemberAlreadyExistsError,
  WorkspaceMemberAccessConflictError,
  WorkspaceNameUnavailableError,
  WorkspaceUserUnavailableError,
  WorkspaceUnavailableError,
} from "../auth/store.js";
import {
  LoginRateLimiter,
  LoginRateLimitExceededError,
} from "../auth/rate-limit.js";
import type { WebConfig } from "./config.js";
import { WebRequestError } from "./request-boundary.js";
import type { WebServices } from "./services.js";
import {
  CITELOOM_WORKSPACE_HEADER,
  type ApplicationOAuthRequestAuthenticator,
} from "./application-authentication.js";
import { isOAuthProtectedResourceMetadataPath } from "./oauth-authentication.js";
import {
  decodeCreateSharedSourceLibraryInput,
  decodeRenameSharedSourceLibraryInput,
  decodeSourceLibraryGrantInput,
  decodeSourceLibraryGrantTarget,
  decodeSourceLibraryTarget,
} from "../workspaces/source-library-boundary.js";
import {
  SourceLibraryArchiveConflictError,
  SourceLibraryUnavailableError,
} from "../workspaces/source-library-store.js";
import {
  SourceLibraryDeletionConflictError,
} from "../workspaces/source-library-deletion.js";

const PUBLIC_LOGIN_WEB_PATHS = new Set([
  "/favicon.ico",
  "/fragments/login.html",
  "/login",
  OAUTH_BROWSER_CALLBACK_PATH,
]);
const ADMINISTRATOR_WEB_PATHS = new Set([
  "/errors",
  "/fragments/errors.html",
  "/fragments/security.html",
  "/security",
]);
const SETTINGS_ADMINISTRATOR_WEB_PATHS = new Set([
  "/fragments/settings.html",
  "/settings",
]);
const GLOBAL_ADMINISTRATOR_WEB_PATHS = new Set([
  "/fragments/system-health.html",
  "/system-health",
]);
const LOGIN_REDIRECT_HEADER = "HX-Redirect";
const LOGIN_REDIRECT_PATH = "/login";
const OAUTH_LOCAL_AUTHENTICATION_PATHS = new Set([
  "/api/auth/login",
  "/api/auth/logout",
  "/api/auth/password",
  "/api/auth/session",
  "/api/auth/session/workspace",
  "/api/auth/setup",
]);
const disabledAuthenticationPrincipal: AuthenticatedPrincipal = {
  dataScope: "all",
  displayName: "Disabled authentication",
  globalRole: "global_admin",
  role: "admin",
  sessionTokenDigest: "0".repeat(64),
  userId: "00000000-0000-4000-8000-000000000000",
  username: "disabled-authentication",
  workspaceId: "00000000-0000-4000-8000-000000000000",
  workspaceName: "Disabled authentication",
};

export interface AuthenticationRouteOptions {
  authentication: "disabled" | "required";
  oauthAuthenticator: ApplicationOAuthRequestAuthenticator;
  requestPrincipals: WeakMap<object, AuthorizationPrincipal>;
  services: WebServices;
  webConfig: WebConfig;
}

export function registerAuthenticationRoutes(
  server: FastifyInstance,
  options: AuthenticationRouteOptions,
): void {
  const {
    authentication,
    oauthAuthenticator,
    requestPrincipals,
    services,
    webConfig,
  } = options;
  const loginRateLimiter = new LoginRateLimiter();
  const requestIdentityContexts = new WeakMap<object, OAuthIdentityContext>();

  server.addHook("onRequest", async (request, reply) => {
    if (authentication === "disabled") {
      requestPrincipals.set(request, disabledAuthenticationPrincipal);
      return;
    }
    const pathname = readRequestPathname(request.url);
    if (pathname === OAUTH_MCP_RESOURCE_PATH) {
      return;
    }
    if (pathname === "/api/auth/bootstrap") {
      requireSameOriginForMutation(
        request.method,
        request.headers.origin,
        webConfig,
      );
      return;
    }
    if (!pathname.startsWith("/api/") && isPublicLoginWebPath(pathname)) {
      return;
    }
    const authenticationSettings = await services.readAuthenticationSettings(
      webConfig.publicOrigin,
    );
    if (authenticationSettings.mode === "oauth") {
      if (!pathname.startsWith("/api/")) {
        clearStaleSessionCookie(request.cookies, reply, webConfig);
        return;
      }
      if (OAUTH_LOCAL_AUTHENTICATION_PATHS.has(pathname)) {
        clearStaleSessionCookie(request.cookies, reply, webConfig);
        return reply.header("Cache-Control", "no-store").status(404).send();
      }
      requireSameOriginForMutation(
        request.method,
        request.headers.origin,
        webConfig,
      );
      clearStaleSessionCookie(request.cookies, reply, webConfig);
      try {
        if (pathname === "/api/auth/context") {
          const context = await oauthAuthenticator.readIdentityContext(
            authenticationSettings,
            request.headers.authorization,
          );
          requestIdentityContexts.set(request, context);
          return;
        }
        const workspaceId = readOAuthWorkspaceId(
          request.headers[CITELOOM_WORKSPACE_HEADER],
        );
        const principal = await oauthAuthenticator.authenticate(
          authenticationSettings,
          request.headers.authorization,
          workspaceId,
        );
        requestPrincipals.set(request, principal);
        return;
      } catch (error: unknown) {
        return sendOAuthAuthenticationError(reply, error);
      }
    }
    if (!pathname.startsWith("/api/")) {
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
        && !canAdministerWorkspace(principal, principal.workspaceId)
      ) {
        throw new WebRequestError(
          403,
          "Workspace or global administrator access is required.",
        );
      }
      if (
        GLOBAL_ADMINISTRATOR_WEB_PATHS.has(pathname)
        && principal.globalRole !== "global_admin"
      ) {
        throw new WebRequestError(
          403,
          "Global administrator access is required.",
        );
      }
      if (
        SETTINGS_ADMINISTRATOR_WEB_PATHS.has(pathname)
        && !canAdministerWorkspace(principal, principal.workspaceId)
      ) {
        throw new WebRequestError(
          403,
          "Workspace or global administrator access is required.",
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

  server.get("/api/auth/bootstrap", async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
    return services.readAuthenticationBootstrap(webConfig.publicOrigin);
  });

  server.get("/api/auth/context", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const oauthContext = requestIdentityContexts.get(request);
    if (oauthContext !== undefined) {
      return oauthContext;
    }
    const principal = requireRequestPrincipal(requestPrincipals, request);
    return {
      displayName: principal.displayName,
      globalRole: principal.globalRole,
      userId: principal.userId,
      username: principal.username,
      workspaces: await services.listWorkspaces(principal),
    };
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
    try {
      const setup = decodePasswordSetupInput(request.body);
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
      if (error instanceof PasswordValidationError) {
        throw new WebRequestError(400, error.message);
      }
      if (error instanceof ZodError) {
        throw new WebRequestError(400, "The password setup request is invalid.");
      }
      throw error;
    }
  });

  server.get("/api/auth/session", async (request) => {
    const principal = requireRequestPrincipal(requestPrincipals, request);
    return buildSessionResponse(principal, null);
  });

  server.get("/api/workspaces", async (request) => {
    const principal = requireRequestPrincipal(requestPrincipals, request);
    return services.listWorkspaces(principal);
  });

  server.get("/api/source-libraries", async (request) => {
    const principal = requireRequestPrincipal(requestPrincipals, request);
    return services.listSourceLibraries(principal);
  });

  server.get("/api/source-libraries/administration", async (request) => {
    const principal = requireGlobalAdministratorPrincipal(
      requestPrincipals,
      request,
    );
    return services.readSourceLibraryAdministration(principal);
  });

  server.post("/api/source-libraries", async (request, reply) => {
    const principal = requireGlobalAdministratorPrincipal(
      requestPrincipals,
      request,
    );
    const input = decodeCreateSharedSourceLibraryInput(request.body);
    try {
      const library = await services.createSharedSourceLibrary(principal, input);
      return reply.status(201).send(library);
    } catch (error: unknown) {
      throw mapSourceLibraryError(error);
    }
  });

  server.patch("/api/source-libraries/:libraryId", async (request, reply) => {
    const principal = requireGlobalAdministratorPrincipal(
      requestPrincipals,
      request,
    );
    const target = decodeSourceLibraryTarget(request.params);
    const input = decodeRenameSharedSourceLibraryInput(request.body);
    try {
      await services.renameSharedSourceLibrary(
        principal,
        target.libraryId,
        input,
      );
      return reply.status(204).send();
    } catch (error: unknown) {
      throw mapSourceLibraryError(error);
    }
  });

  server.post(
    "/api/source-libraries/:libraryId/archive",
    async (request, reply) => {
      const principal = requireGlobalAdministratorPrincipal(
        requestPrincipals,
        request,
      );
      const target = decodeSourceLibraryTarget(request.params);
      try {
        await services.archiveSharedSourceLibrary(principal, target.libraryId);
        return reply.status(204).send();
      } catch (error: unknown) {
        throw mapSourceLibraryError(error);
      }
    },
  );

  server.delete("/api/source-libraries/:libraryId", async (request, reply) => {
    const principal = requireGlobalAdministratorPrincipal(
      requestPrincipals,
      request,
    );
    const target = decodeSourceLibraryTarget(request.params);
    try {
      await services.deleteSharedSourceLibrary(principal, target.libraryId);
      return reply.status(202).send();
    } catch (error: unknown) {
      throw mapSourceLibraryError(error);
    }
  });

  server.post(
    "/api/source-libraries/:libraryId/restore",
    async (request, reply) => {
      const principal = requireGlobalAdministratorPrincipal(
        requestPrincipals,
        request,
      );
      const target = decodeSourceLibraryTarget(request.params);
      try {
        await services.restoreSharedSourceLibrary(principal, target.libraryId);
        return reply.status(204).send();
      } catch (error: unknown) {
        throw mapSourceLibraryError(error);
      }
    },
  );

  server.put(
    "/api/source-libraries/:libraryId/grants/:workspaceId",
    async (request, reply) => {
      const principal = requireGlobalAdministratorPrincipal(
        requestPrincipals,
        request,
      );
      const target = decodeSourceLibraryGrantTarget(request.params);
      const grant = decodeSourceLibraryGrantInput(request.body);
      try {
        await services.setSourceLibraryGrant(
          principal,
          target.libraryId,
          target.workspaceId,
          grant.access,
        );
        return reply.status(204).send();
      } catch (error: unknown) {
        throw mapSourceLibraryError(error);
      }
    },
  );

  server.delete(
    "/api/source-libraries/:libraryId/grants/:workspaceId",
    async (request, reply) => {
      const principal = requireGlobalAdministratorPrincipal(
        requestPrincipals,
        request,
      );
      const target = decodeSourceLibraryGrantTarget(request.params);
      try {
        await services.revokeSourceLibraryGrant(
          principal,
          target.libraryId,
          target.workspaceId,
        );
        return reply.status(204).send();
      } catch (error: unknown) {
        throw mapSourceLibraryError(error);
      }
    },
  );

  server.post("/api/workspaces", async (request, reply) => {
    const principal = requireGlobalAdministratorPrincipal(
      requestPrincipals,
      request,
    );
    if (principal.dataScope === "all") {
      throw new WebRequestError(
        409,
        "Workspace creation is unavailable when authentication is disabled.",
      );
    }
    const input = decodeCreateWorkspaceInput(request.body);
    try {
      const workspace = await services.createWorkspace(principal, input);
      return reply.status(201).send(workspace);
    } catch (error: unknown) {
      if (error instanceof GlobalAuthorizationError) {
        throw new WebRequestError(403, error.message);
      }
      if (error instanceof WorkspaceNameUnavailableError) {
        throw new WebRequestError(409, error.message);
      }
      if (error instanceof WorkspaceConfigurationSourceUnavailableError) {
        throw new WebRequestError(404, error.message);
      }
      throw error;
    }
  });

  server.delete("/api/workspaces/:workspaceId", async (request, reply) => {
    const principal = requireGlobalAdministratorPrincipal(
      requestPrincipals,
      request,
    );
    const workspaceId = decodeWorkspaceId(request.params);
    try {
      await services.archiveWorkspace(principal, workspaceId);
      return reply.status(204).send();
    } catch (error: unknown) {
      if (error instanceof WorkspaceArchiveConflictError) {
        throw new WebRequestError(409, error.message);
      }
      if (error instanceof WorkspaceUnavailableError) {
        throw new WebRequestError(404, error.message);
      }
      throw error;
    }
  });

  server.patch("/api/workspaces/:workspaceId", async (request) => {
    const principal = requireGlobalAdministratorPrincipal(
      requestPrincipals,
      request,
    );
    const workspaceId = decodeWorkspaceId(request.params);
    const input = decodeRenameWorkspaceInput(request.body);
    try {
      return await services.renameWorkspace(principal, workspaceId, input);
    } catch (error: unknown) {
      if (error instanceof WorkspaceNameUnavailableError) {
        throw new WebRequestError(409, error.message);
      }
      if (error instanceof WorkspaceUnavailableError) {
        throw new WebRequestError(404, error.message);
      }
      throw error;
    }
  });

  server.put("/api/auth/session/workspace", async (request) => {
    const principal = requireLocalSessionPrincipal(requestPrincipals, request);
    const workspaceId = decodeWorkspaceId(request.body);
    try {
      const switched = await services.switchWorkspace(principal, workspaceId);
      requestPrincipals.set(request, switched);
      return buildSessionResponse(switched, null);
    } catch (error: unknown) {
      if (error instanceof WorkspaceUnavailableError) {
        throw new WebRequestError(404, error.message);
      }
      throw error;
    }
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
    const principal = requireLocalSessionPrincipal(requestPrincipals, request);
    try {
      const passwords = decodeChangePasswordInput(request.body);
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
      if (error instanceof PasswordValidationError) {
        throw new WebRequestError(400, error.message);
      }
      if (error instanceof ZodError) {
        throw new WebRequestError(400, "The password change request is invalid.");
      }
      throw error;
    }
  });

  server.post("/api/workspaces/:workspaceId/members", async (request, reply) => {
    const principal = requireRequestPrincipal(requestPrincipals, request);
    const workspaceId = decodeWorkspaceId(request.params);
    const member = decodeAddWorkspaceMemberInput(request.body);
    try {
      await services.addWorkspaceMember(
        principal,
        workspaceId,
        member.userId,
        member.role,
      );
      return reply.status(204).send();
    } catch (error: unknown) {
      throw mapWorkspaceMembershipError(error);
    }
  });

  server.get("/api/workspaces/:workspaceId/member-candidates", async (request) => {
    const principal = requireRequestPrincipal(requestPrincipals, request);
    const workspaceId = decodeWorkspaceId(request.params);
    try {
      return await services.listWorkspaceMemberCandidates(principal, workspaceId);
    } catch (error: unknown) {
      throw mapWorkspaceMembershipError(error);
    }
  });

  server.get("/api/workspaces/:workspaceId/members", async (request) => {
    const principal = requireRequestPrincipal(requestPrincipals, request);
    const workspaceId = decodeWorkspaceId(request.params);
    try {
      return await services.listWorkspaceMembers(principal, workspaceId);
    } catch (error: unknown) {
      throw mapWorkspaceMembershipError(error);
    }
  });

  server.put("/api/workspaces/:workspaceId/members/:userId/role", async (request, reply) => {
    const principal = requireRequestPrincipal(requestPrincipals, request);
    const target = decodeWorkspaceMemberTarget(request.params);
    const role = decodeWorkspaceMemberRoleInput(request.body);
    try {
      await services.changeWorkspaceMemberRole(
        principal,
        target.workspaceId,
        target.userId,
        role,
      );
      return reply.status(204).send();
    } catch (error: unknown) {
      throw mapWorkspaceMembershipError(error);
    }
  });

  server.put(
    "/api/workspaces/:workspaceId/members/:userId/access",
    async (request, reply) => {
      const principal = requireRequestPrincipal(requestPrincipals, request);
      try {
        const target = decodeWorkspaceMemberTarget(request.params);
        const access = decodeWorkspaceMemberAccessInput(request.body);
        await services.changeWorkspaceMemberAccess(
          principal,
          target.workspaceId,
          target.userId,
          access,
        );
        return reply.status(204).send();
      } catch (error: unknown) {
        throw mapWorkspaceMembershipError(error);
      }
    },
  );

  server.delete(
    "/api/workspaces/:workspaceId/members/:userId",
    async (request, reply) => {
      const principal = requireRequestPrincipal(requestPrincipals, request);
      const target = decodeWorkspaceMemberTarget(request.params);
      try {
        await services.removeWorkspaceMember(
          principal,
          target.workspaceId,
          target.userId,
        );
        return reply.status(204).send();
      } catch (error: unknown) {
        throw mapWorkspaceMembershipError(error);
      }
    },
  );
}

export function requireRequestPrincipal<T extends object>(
  principals: WeakMap<object, AuthorizationPrincipal>,
  request: T,
): AuthorizationPrincipal {
  const principal = principals.get(request);
  if (principal === undefined) {
    throw new WebRequestError(401, "Authentication is required.");
  }
  return principal;
}

export function requireWorkspaceAdministratorPrincipal<T extends object>(
  principals: WeakMap<object, AuthorizationPrincipal>,
  request: T,
  workspaceId: string,
): AuthorizationPrincipal {
  const principal = requireRequestPrincipal(principals, request);
  if (!canAdministerWorkspace(principal, workspaceId)) {
    throw new WebRequestError(
      403,
      "Workspace or global administrator access is required.",
    );
  }
  return principal;
}

export function requireGlobalAdministratorPrincipal<T extends object>(
  principals: WeakMap<object, AuthorizationPrincipal>,
  request: T,
): AuthorizationPrincipal {
  const principal = requireRequestPrincipal(principals, request);
  if (principal.globalRole !== "global_admin") {
    throw new WebRequestError(
      403,
      "Global administrator access is required.",
    );
  }
  return principal;
}

function isPublicAuthenticationPath(pathname: string): boolean {
  return pathname === "/api/auth/login"
    || pathname === "/api/auth/setup";
}

function isPublicLoginWebPath(pathname: string): boolean {
  return pathname.startsWith("/assets/")
    || PUBLIC_LOGIN_WEB_PATHS.has(pathname)
    || isOAuthProtectedResourceMetadataPath(pathname);
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

function clearStaleSessionCookie(
  cookies: Record<string, string | undefined>,
  reply: FastifyReply,
  webConfig: WebConfig,
): void {
  if (cookies[readSessionCookieName(webConfig)] !== undefined) {
    clearSessionCookie(reply, webConfig);
  }
}

function readOAuthWorkspaceId(
  value: string | string[] | undefined,
): string {
  if (typeof value !== "string") {
    throw new WebRequestError(
      400,
      `The ${CITELOOM_WORKSPACE_HEADER} header must identify one workspace.`,
    );
  }
  try {
    return decodeWorkspaceId({ workspaceId: value });
  } catch (error: unknown) {
    if (error instanceof ZodError) {
      throw new WebRequestError(
        400,
        `The ${CITELOOM_WORKSPACE_HEADER} header must be a valid workspace ID.`,
      );
    }
    throw error;
  }
}

function sendOAuthAuthenticationError(
  reply: FastifyReply,
  error: unknown,
): unknown {
  if (error instanceof OAuthAccessTokenRejectedError) {
    return reply
      .header("WWW-Authenticate", 'Bearer error="invalid_token"')
      .status(401)
      .send({ error: { message: error.message } });
  }
  if (error instanceof OAuthInsufficientScopeError) {
    const scope = error.requiredScopes.join(" ");
    return reply
      .header(
        "WWW-Authenticate",
        `Bearer error="insufficient_scope", scope="${scope}"`,
      )
      .status(403)
      .send({ error: { message: error.message } });
  }
  if (error instanceof OAuthIdentityUnavailableError) {
    return reply.status(403).send({ error: { message: error.message } });
  }
  throw error;
}

function buildSessionResponse(
  principal: AuthorizationPrincipal,
  expiresAt: string | null,
): {
  expiresAt: string | null;
  user: {
    dataScope: "all" | "workspace";
    displayName: string;
    globalRole: "global_admin" | "standard";
    id: string;
    username: string;
  };
  workspace: { id: string; name: string; role: "admin" | "member" };
} {
  return {
    expiresAt,
    user: {
      dataScope: principal.dataScope,
      displayName: principal.displayName,
      globalRole: principal.globalRole,
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

function requireLocalSessionPrincipal<T extends object>(
  principals: WeakMap<object, AuthorizationPrincipal>,
  request: T,
): AuthenticatedPrincipal {
  const principal = requireRequestPrincipal(principals, request);
  if (!isAuthenticatedPrincipal(principal)) {
    throw new WebRequestError(
      404,
      "Session-based authentication is unavailable while OAuth is enabled.",
    );
  }
  return principal;
}

function isAuthenticatedPrincipal(
  principal: AuthorizationPrincipal,
): principal is AuthenticatedPrincipal {
  return "sessionTokenDigest" in principal
    && typeof principal.sessionTokenDigest === "string";
}

function mapWorkspaceMembershipError(error: unknown): unknown {
  if (error instanceof ZodError) {
    return new WebRequestError(400, "The workspace membership request is invalid.");
  }
  if (error instanceof WorkspaceAuthorizationError) {
    return new WebRequestError(403, error.message);
  }
  if (error instanceof WorkspaceMemberNotFoundError) {
    return new WebRequestError(404, error.message);
  }
  if (error instanceof WorkspaceUnavailableError) {
    return new WebRequestError(404, error.message);
  }
  if (error instanceof WorkspaceMemberAlreadyExistsError) {
    return new WebRequestError(409, error.message);
  }
  if (error instanceof WorkspaceUserUnavailableError) {
    return new WebRequestError(404, error.message);
  }
  if (error instanceof FinalWorkspaceAdministratorError) {
    return new WebRequestError(409, error.message);
  }
  if (error instanceof WorkspaceMemberAccessConflictError) {
    return new WebRequestError(409, error.message);
  }
  if (error instanceof ProtectedGlobalAdministratorError) {
    return new WebRequestError(409, error.message);
  }
  return error;
}

function mapSourceLibraryError(error: unknown): unknown {
  if (error instanceof SourceLibraryArchiveConflictError) {
    return new WebRequestError(409, error.message);
  }
  if (error instanceof SourceLibraryDeletionConflictError) {
    return new WebRequestError(409, error.message);
  }
  if (error instanceof SourceLibraryUnavailableError) {
    return new WebRequestError(404, error.message);
  }
  if (error instanceof GlobalAuthorizationError) {
    return new WebRequestError(403, error.message);
  }
  return error;
}
