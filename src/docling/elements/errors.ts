import type {
  DoclingErrorDetail,
  DoclingErrorElementKind,
  DoclingPictureItem,
  DoclingTableItem,
  DoclingTextItem,
} from "../protocol/index.js";

type DoclingElementItem =
  | DoclingPictureItem
  | DoclingTableItem
  | DoclingTextItem;

export class DoclingElementProcessingError extends Error {
  public readonly conversionErrors: DoclingErrorDetail[];

  public constructor(
    kind: DoclingErrorElementKind,
    item: DoclingElementItem,
    cause: unknown,
  ) {
    super(`CiteLoom could not normalize Docling ${kind} ${item.selfRef}.`, {
      cause,
    });
    this.name = "DoclingElementProcessingError";
    this.conversionErrors = [
      buildElementErrorDetail(kind, item, cause),
    ];
  }
}

export class DoclingNormalizationError extends Error {
  public readonly conversionErrors: DoclingErrorDetail[];

  public constructor(cause: unknown) {
    super("CiteLoom could not normalize the Docling document.", { cause });
    this.name = "DoclingNormalizationError";
    this.conversionErrors = [{
      category: "unknown",
      componentType: "doc_assembler",
      doclingLabel: null,
      elementKind: null,
      message: readErrorMessage(cause),
      moduleName: "CiteLoomDoclingNormalizer",
      pageNumber: null,
      pageRangeEnd: null,
      pageRangeStart: null,
      sourceRef: null,
    }];
  }
}

function buildElementErrorDetail(
  kind: DoclingErrorElementKind,
  item: DoclingElementItem,
  cause: unknown,
): DoclingErrorDetail {
  const pages = new Set<number>();
  for (const provenance of item.provenance) {
    pages.add(provenance.pageNumber);
  }
  const sortedPages = [...pages].sort((left, right) => left - right);
  let pageNumber: number | null = null;
  let pageRangeEnd: number | null = null;
  let pageRangeStart: number | null = null;
  if (sortedPages.length === 1) {
    pageNumber = sortedPages[0] ?? null;
  } else if (sortedPages.length > 1) {
    pageRangeStart = sortedPages[0] ?? null;
    pageRangeEnd = sortedPages.at(-1) ?? null;
  }
  return {
    category: "unknown",
    componentType: "doc_assembler",
    doclingLabel: item.label,
    elementKind: kind,
    message: readErrorMessage(cause),
    moduleName: "CiteLoomDoclingNormalizer",
    pageNumber,
    pageRangeEnd,
    pageRangeStart,
    sourceRef: item.selfRef,
  };
}

function readErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return "A non-Error value was thrown during Docling normalization.";
}
