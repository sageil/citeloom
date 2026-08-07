import { createHash } from "node:crypto";

export interface CanonicalEvidenceIdentityInput {
  documentId: string;
  elementSetId: string;
  evidenceContent: string;
  parentId: string;
}

export interface CanonicalEvidenceIdentityParts {
  documentId: string;
  elementSetId: string;
  evidenceSha256: string;
  parentId: string;
}

export function createEvidenceSha256(evidenceContent: string): string {
  return createHash("sha256").update(evidenceContent).digest("hex");
}

export function createCanonicalEvidenceIdentity(
  evidence: CanonicalEvidenceIdentityInput,
): string {
  return createCanonicalEvidenceIdentityFromHash({
    documentId: evidence.documentId,
    elementSetId: evidence.elementSetId,
    evidenceSha256: createEvidenceSha256(evidence.evidenceContent),
    parentId: evidence.parentId,
  });
}

export function createCanonicalEvidenceIdentityFromHash(
  evidence: CanonicalEvidenceIdentityParts,
): string {
  return [
    evidence.documentId,
    evidence.elementSetId,
    evidence.parentId,
    evidence.evidenceSha256,
  ].join("\u0000");
}
