import type {
  PublishedAnswerCitation,
  PublishedAnswerDocument,
} from "../../../src/answers/published-schema.js";

export type ClaimStatus =
  | "partially-supported"
  | "supported"
  | "unsupported"
  | "unverified";

export interface CitationClaimStatus {
  citationNumbers: number[];
  status: ClaimStatus;
}

export interface CitationTablePresentationCell {
  columnSpan: number;
  key: string;
  rowHeader: boolean;
  rowSpan: number;
  startColumn: number;
  text: string;
}

export interface CitationTablePresentationRow {
  cells: CitationTablePresentationCell[];
  key: string;
}

type TableCitationEvidence = Extract<
  PublishedAnswerCitation["evidence"],
  { kind: "table" }
>;

export type PresentedAnswerCitation = Omit<
  PublishedAnswerCitation,
  "evidence"
> & {
  evidence:
    | Exclude<PublishedAnswerCitation["evidence"], { kind: "table" }>
    | (Omit<TableCitationEvidence, "table"> & {
      table: TableCitationEvidence["table"] & {
        bodyRows: CitationTablePresentationRow[];
        headerRows: CitationTablePresentationRow[];
        renderMode: "grid" | "text";
      };
    });
  key: string;
  preview: false;
};

export function aggregateCitationStatus(
  claims: CitationClaimStatus[],
  citationNumber: number,
): ClaimStatus;

export function formatClaimStatusLabel(status: ClaimStatus): string;

export function readAnswerPresentation(
  value: unknown,
  label: string,
): {
  answerDocument: PublishedAnswerDocument;
  sources: PresentedAnswerCitation[];
};
