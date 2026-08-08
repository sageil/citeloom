import { z } from "zod";

export const verificationJobStateSchema = z.enum([
  "pending",
  "running",
  "completed",
  "failed",
]);

export const evidenceVerificationStateSchema = z.union([
  z.literal("not-applicable"),
  verificationJobStateSchema,
]);

export type EvidenceVerificationState = z.output<
  typeof evidenceVerificationStateSchema
>;
