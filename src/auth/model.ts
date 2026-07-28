import { z } from "zod";

export const workspaceRoleSchema = z.enum(["admin", "member"]);

export type WorkspaceRole = z.output<typeof workspaceRoleSchema>;

export interface AuthenticatedPrincipal {
  displayName: string;
  role: WorkspaceRole;
  sessionTokenDigest: string;
  userId: string;
  username: string;
  workspaceId: string;
  workspaceName: string;
}

export interface AuthenticationSession {
  expiresAt: string;
  principal: AuthenticatedPrincipal;
  token: string;
}

export interface PendingUserSetup {
  expiresAt: string;
  setupToken: string;
  userId: string;
}

export type WorkspaceMemberAddition =
  | { kind: "existing"; userId: string }
  | ({ kind: "setup" } & PendingUserSetup);

export interface WorkspaceMember {
  displayName: string;
  role: WorkspaceRole;
  state: "active" | "pending" | "suspended";
  userId: string;
  username: string;
}
