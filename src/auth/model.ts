import { z } from "zod";

export const workspaceRoleSchema = z.enum(["admin", "member"]);
export const globalRoleSchema = z.enum(["global_admin", "standard"]);
export const workspaceMembershipAccessSchema = z.enum([
  "enabled",
  "disabled",
]);

export type WorkspaceRole = z.output<typeof workspaceRoleSchema>;
export type GlobalRole = z.output<typeof globalRoleSchema>;
export type WorkspaceMembershipAccess = z.output<
  typeof workspaceMembershipAccessSchema
>;

export interface AuthenticatedPrincipal {
  dataScope: "all" | "workspace";
  displayName: string;
  globalRole: GlobalRole;
  role: WorkspaceRole;
  sessionTokenDigest: string;
  userId: string;
  username: string;
  workspaceId: string;
  workspaceName: string;
}

export interface WorkspaceSummary {
  id: string;
  name: string;
  role: WorkspaceRole;
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
  access: WorkspaceMembershipAccess;
  displayName: string;
  globalRole: GlobalRole;
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

export interface WorkspaceSecurityAdministrator {
  displayName: string;
  role: "admin";
  state: "active" | "pending" | "suspended";
  userId: string;
  username: string;
}

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
