import type { AuthenticatedPrincipal } from "./model.js";

export class WorkspaceAuthorizationError extends Error {
  public constructor(message: string = "Workspace administrator access is required.") {
    super(message);
    this.name = "WorkspaceAuthorizationError";
  }
}

export function requireWorkspaceAdministrator(
  principal: AuthenticatedPrincipal,
): void {
  if (principal.role !== "admin") {
    throw new WorkspaceAuthorizationError();
  }
}
