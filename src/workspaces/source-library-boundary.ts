import { z } from "zod";

import type {
  CreateSharedSourceLibraryInput,
  RenameSharedSourceLibraryInput,
  SourceLibraryAccess,
} from "./source-library-model.js";

const sourceLibraryNameSchema = z.string().trim().min(1).max(200);
const sourceLibraryAccessSchema = z.enum(["use", "manage"]);

export function decodeCreateSharedSourceLibraryInput(
  input: unknown,
): CreateSharedSourceLibraryInput {
  return z.object({ name: sourceLibraryNameSchema }).strict().parse(input);
}

export function decodeRenameSharedSourceLibraryInput(
  input: unknown,
): RenameSharedSourceLibraryInput {
  return z.object({ name: sourceLibraryNameSchema }).strict().parse(input);
}

export function decodeSourceLibraryTarget(input: unknown): {
  libraryId: string;
} {
  return z.object({ libraryId: z.uuid() }).strict().parse(input);
}

export function decodeSourceLibraryGrantInput(input: unknown): {
  access: SourceLibraryAccess;
} {
  return z.object({ access: sourceLibraryAccessSchema }).strict().parse(input);
}

export function decodeSourceLibraryGrantTarget(input: unknown): {
  libraryId: string;
  workspaceId: string;
} {
  return z.object({
    libraryId: z.uuid(),
    workspaceId: z.uuid(),
  }).strict().parse(input);
}
