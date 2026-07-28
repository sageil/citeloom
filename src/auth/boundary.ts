import { z } from "zod";

import { readPassword } from "./password.js";
import { workspaceRoleSchema, type WorkspaceRole } from "./model.js";

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
const workspaceSlugSchema = z.string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

export interface NormalizedUserIdentity {
  displayName: string;
  username: string;
  usernameNormalized: string;
}

export interface BootstrapAdministratorInput extends NormalizedUserIdentity {
  workspaceName: string;
  workspaceSlug: string;
}

export interface LoginInput {
  password: string;
  remember: boolean;
  usernameNormalized: string;
}

export interface ChangePasswordInput {
  currentPassword: string;
  newPassword: string;
}

export interface CreateWorkspaceMemberInput {
  identity: NormalizedUserIdentity;
  role: WorkspaceRole;
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
    workspaceSlug: z.unknown(),
  }).strict().parse(input);
  return {
    ...normalizeUserIdentity(candidate),
    workspaceName: workspaceNameSchema.parse(candidate.workspaceName),
    workspaceSlug: workspaceSlugSchema.parse(candidate.workspaceSlug),
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
  password: string;
  setupToken: string;
} {
  const candidate = z.object({
    password: z.unknown(),
    setupToken: z.string().min(32).max(200),
  }).strict().parse(input);
  return {
    password: readPassword(candidate.password),
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
    newPassword: readPassword(candidate.newPassword),
  };
}

export function decodeCreateWorkspaceMemberInput(
  input: unknown,
): CreateWorkspaceMemberInput {
  const candidate = z.object({
    displayName: z.unknown(),
    role: workspaceRoleSchema.default("member"),
    username: z.unknown(),
  }).strict().parse(input);
  return {
    identity: normalizeUserIdentity(candidate),
    role: candidate.role,
  };
}

export function decodeWorkspaceMemberRoleInput(input: unknown): WorkspaceRole {
  return z.object({ role: workspaceRoleSchema }).strict().parse(input).role;
}

export function decodeWorkspaceMemberId(input: unknown): string {
  return z.object({ userId: z.uuid() }).strict().parse(input).userId;
}
