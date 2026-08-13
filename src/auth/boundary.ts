import { z } from "zod";

import {
  readPasswordInput,
  type PasswordInput,
} from "./password.js";
import {
  workspaceMembershipAccessSchema,
  workspaceRoleSchema,
  type WorkspaceMembershipAccess,
  type WorkspaceRole,
} from "./model.js";

const usernameSchema = z.string()
  .trim()
  .min(3)
  .max(100)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
    "Username may contain letters, numbers, dots, underscores, and hyphens.",
  );
const displayNameSchema = z.string().trim().min(1).max(200);
const workspaceNameSchema = z.string().trim().min(1).max(200);
export interface NormalizedUserIdentity {
  displayName: string;
  username: string;
  usernameNormalized: string;
}

export interface BootstrapAdministratorInput extends NormalizedUserIdentity {
  workspaceName: string;
}

export interface LoginInput {
  password: string;
  remember: boolean;
  usernameNormalized: string;
}

export interface ChangePasswordInput {
  currentPassword: string;
  newPassword: PasswordInput;
}

export interface AddWorkspaceMemberInput {
  role: WorkspaceRole;
  userId: string;
}

export type CreateOrganizationUserInput = NormalizedUserIdentity;

export interface CreateWorkspaceInput {
  configuration: WorkspaceConfigurationSource;
  name: string;
}

export interface RenameWorkspaceInput {
  name: string;
}

export type WorkspaceConfigurationSource =
  | { kind: "organization-defaults" }
  | { kind: "workspace-copy"; workspaceId: string };

export interface UpdateWorkspaceSecurityPolicyInput {
  expectedVersion: number;
  invalidateOutstandingResetLinks: boolean;
  minimumPasswordLength: number;
  requireLetterAndNumber: boolean;
  requireSpecialCharacter: boolean;
  resetLinkLifetimeSeconds: number;
}

export function normalizeUserIdentity(input: {
  displayName: unknown;
  username: unknown;
}): NormalizedUserIdentity {
  const username = usernameSchema.parse(input.username).normalize("NFKC");
  return {
    displayName: displayNameSchema.parse(input.displayName),
    username,
    usernameNormalized: username.toLocaleLowerCase("en-US"),
  };
}

export function decodeBootstrapAdministratorInput(
  input: unknown,
): BootstrapAdministratorInput {
  const candidate = z.object({
    displayName: z.unknown(),
    username: z.unknown(),
    workspaceName: z.unknown(),
  }).strict().parse(input);
  return {
    ...normalizeUserIdentity(candidate),
    workspaceName: workspaceNameSchema.parse(candidate.workspaceName),
  };
}

export function decodeLoginInput(input: unknown): LoginInput {
  const candidate = z.object({
    password: z.unknown(),
    remember: z.boolean().default(false),
    username: z.unknown(),
  }).strict().parse(input);
  const username = usernameSchema.parse(candidate.username).normalize("NFKC");
  return {
    password: z.string().max(1_024).parse(candidate.password),
    remember: candidate.remember,
    usernameNormalized: username.toLocaleLowerCase("en-US"),
  };
}

export function decodePasswordSetupInput(input: unknown): {
  password: PasswordInput;
  setupToken: string;
} {
  const candidate = z.object({
    password: z.unknown(),
    setupToken: z.string().min(32).max(200),
  }).strict().parse(input);
  return {
    password: readPasswordInput(candidate.password),
    setupToken: candidate.setupToken,
  };
}

export function decodeChangePasswordInput(input: unknown): ChangePasswordInput {
  const candidate = z.object({
    currentPassword: z.string().max(1_024),
    newPassword: z.unknown(),
  }).strict().parse(input);
  return {
    currentPassword: candidate.currentPassword,
    newPassword: readPasswordInput(candidate.newPassword),
  };
}

export function decodeWorkspaceSecurityPolicyUpdate(
  input: unknown,
): UpdateWorkspaceSecurityPolicyInput {
  return z.object({
    expectedVersion: z.number().int().positive(),
    invalidateOutstandingResetLinks: z.boolean(),
    minimumPasswordLength: z.number().int().min(9).max(64),
    requireLetterAndNumber: z.boolean(),
    requireSpecialCharacter: z.boolean(),
    resetLinkLifetimeSeconds: z.number().int().min(900).max(604_800),
  }).strict().parse(input);
}

export function decodeAddWorkspaceMemberInput(
  input: unknown,
): AddWorkspaceMemberInput {
  return z.object({
    role: workspaceRoleSchema.default("member"),
    userId: z.uuid(),
  }).strict().parse(input);
}

export function decodeCreateOrganizationUserInput(
  input: unknown,
): CreateOrganizationUserInput {
  const candidate = z.object({
    displayName: z.unknown(),
    username: z.unknown(),
  }).strict().parse(input);
  return normalizeUserIdentity(candidate);
}

export function decodeOrganizationUserId(input: unknown): string {
  return z.object({ userId: z.uuid() }).strict().parse(input).userId;
}

export function decodeCreateWorkspaceInput(input: unknown): CreateWorkspaceInput {
  const candidate = z.object({
    configuration: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("organization-defaults") }).strict(),
      z.object({
        kind: z.literal("workspace-copy"),
        workspaceId: z.uuid(),
      }).strict(),
    ]).default({ kind: "organization-defaults" }),
    name: z.unknown(),
  }).strict().parse(input);
  return {
    configuration: candidate.configuration,
    name: workspaceNameSchema.parse(candidate.name),
  };
}

export function decodeRenameWorkspaceInput(input: unknown): RenameWorkspaceInput {
  const candidate = z.object({ name: z.unknown() }).strict().parse(input);
  return { name: workspaceNameSchema.parse(candidate.name) };
}

export function decodeWorkspaceId(input: unknown): string {
  return z.object({ workspaceId: z.uuid() }).strict().parse(input).workspaceId;
}

export function decodeWorkspaceName(input: unknown): string {
  return z.object({ workspaceName: workspaceNameSchema })
    .strict()
    .parse(input)
    .workspaceName;
}

export function decodeWorkspaceMemberRoleInput(input: unknown): WorkspaceRole {
  return z.object({ role: workspaceRoleSchema }).strict().parse(input).role;
}

export function decodeWorkspaceMemberAccessInput(
  input: unknown,
): WorkspaceMembershipAccess {
  return z.object({ access: workspaceMembershipAccessSchema })
    .strict()
    .parse(input)
    .access;
}

export function decodeWorkspaceMemberTarget(input: unknown): {
  userId: string;
  workspaceId: string;
} {
  return z.object({
    userId: z.uuid(),
    workspaceId: z.uuid(),
  }).strict().parse(input);
}
