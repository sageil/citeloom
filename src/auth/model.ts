import { z } from "zod";

export const workspaceRoleSchema = z.enum(["admin", "member"]);
export const globalRoleSchema = z.enum(["global_admin", "standard"]);
export const userAccountStateSchema = z.enum([
  "active",
  "pending",
  "suspended",
]);
export const workspaceMembershipAccessSchema = z.enum([
  "enabled",
  "disabled",
]);

export type WorkspaceRole = z.output<typeof workspaceRoleSchema>;
export type GlobalRole = z.output<typeof globalRoleSchema>;
export type UserAccountState = z.output<typeof userAccountStateSchema>;
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

export interface OrganizationUserAccount {
  displayName: string;
  globalRole: GlobalRole;
  state: UserAccountState;
  userId: string;
  username: string;
  workspaceCount: number;
}

export interface UserPasswordLink {
  expiresAt: string;
  purpose: "reset" | "setup";
  setupToken: string;
  userId: string;
}

export interface WorkspaceMember {
  access: WorkspaceMembershipAccess;
  displayName: string;
  globalRole: GlobalRole;
  role: WorkspaceRole;
  state: UserAccountState;
  userId: string;
  username: string;
}

export interface WorkspaceMemberCandidate {
  displayName: string;
  globalRole: GlobalRole;
  state: UserAccountState;
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
