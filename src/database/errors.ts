import { z } from "zod";

const POSTGRES_UNIQUE_VIOLATION_CODE = "23505";
const postgresConstraintErrorSchema = z.object({
  code: z.string(),
  constraint: z.string().min(1),
}).passthrough();

export function readUniqueConstraintName(error: unknown): string | null {
  if (!(error instanceof Error)) {
    return null;
  }
  const decoded = postgresConstraintErrorSchema.safeParse(error.cause);
  if (!decoded.success || decoded.data.code !== POSTGRES_UNIQUE_VIOLATION_CODE) {
    return null;
  }
  return decoded.data.constraint;
}

export function isUniqueConstraintError(error: unknown): boolean {
  return readUniqueConstraintName(error) !== null;
}
