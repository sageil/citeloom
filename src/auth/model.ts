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

export interface WorkspacePasswordPolicy {
  minimumPasswordLength: number;
  requireLetterAndNumber: boolean;
  requireSpecialCharacter: boolean;
}

export interface WorkspaceSecurityPolicy extends WorkspacePasswordPolicy {
  resetLinkLifetimeSeconds: number;
  updatedAt: string;
  version: number;
}

export type WorkspaceSecurityAdministrator = WorkspaceMember;

export interface WorkspaceSecurityPolicyChange extends WorkspacePasswordPolicy {
  changedAt: string;
  changedByDisplayName: string | null;
  changedByUsername: string | null;
  id: string;
  resetLinkLifetimeSeconds: number;
  revokedResetLinkCount: number;
}

export interface WorkspaceSecurityOverview {
  activeResetLinkCount: number;
  administrators: WorkspaceSecurityAdministrator[];
  policy: WorkspaceSecurityPolicy;
  recentChanges: WorkspaceSecurityPolicyChange[];
}
