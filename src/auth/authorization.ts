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

export function requireWorkspaceAdministrator(
  principal: AuthenticatedPrincipal,
): void {
  if (principal.role !== "admin") {
    throw new WorkspaceAuthorizationError();
  }
}

export function requireWorkspaceOrGlobalAdministrator(
  principal: AuthenticatedPrincipal,
): void {
  if (
    principal.role !== "admin"
    && principal.globalRole !== "global_admin"
  ) {
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
