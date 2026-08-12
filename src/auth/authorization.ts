import type { AuthenticatedPrincipal } from "./model.js";

export class WorkspaceAuthorizationError extends Error {
  public constructor(message: string = "Workspace administrator access is required.") {
    super(message);
    this.name = "WorkspaceAuthorizationError";
  }
}

export class GlobalAuthorizationError extends Error {
  public constructor(message: string = "Global administrator access is required.") {
    super(message);
    this.name = "GlobalAuthorizationError";
  }
}

export function canAdministerWorkspace(
  principal: AuthenticatedPrincipal,
  workspaceId: string,
): boolean {
  if (principal.dataScope === "all") {
    return principal.workspaceId === workspaceId;
  }
  if (principal.globalRole === "global_admin") {
    return true;
  }
  return principal.workspaceId === workspaceId && principal.role === "admin";
}

export function requireWorkspaceAdministrator(
  principal: AuthenticatedPrincipal,
  workspaceId: string,
): void {
  if (!canAdministerWorkspace(principal, workspaceId)) {
    throw new WorkspaceAuthorizationError(
      "Workspace or global administrator access is required.",
    );
  }
}

export function requireGlobalAdministrator(
  principal: AuthenticatedPrincipal,
): void {
  if (principal.globalRole !== "global_admin") {
    throw new GlobalAuthorizationError();
  }
}
