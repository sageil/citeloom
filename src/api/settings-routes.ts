import type { FastifyInstance } from "fastify";

import { decodeWorkspaceId } from "../auth/boundary.js";
import type { AuthorizationPrincipal } from "../auth/model.js";
import {
  WorkspaceAuthorizationError,
  WorkspaceUnavailableError,
} from "../auth/store.js";
import type { AppConfig } from "../config/index.js";
import { SettingsValidationError, SettingsVersionConflictError } from "../app/settings.js";
import {
  requireGlobalAdministratorPrincipal,
  requireRequestPrincipal,
  requireWorkspaceAdministratorPrincipal,
} from "./authentication-routes.js";
import type { WebConfig } from "./config.js";
import {
  decodeApplicationSettingsUpdate,
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
  requestPrincipals: WeakMap<object, AuthorizationPrincipal>;
  services: WebServices;
  webConfig: WebConfig;
}

export function registerSettingsRoutes(
  server: FastifyInstance,
  options: SettingsRouteOptions,
): void {
  const { config, requestPrincipals, services, webConfig } = options;

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
  principal: AuthorizationPrincipal,
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
  principal: AuthorizationPrincipal,
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
