export function buildPdfViewerUrl(fileUrl, pageNumbers) {
  const pageNumber = pageNumbers[0];
  if (pageNumber === undefined) {
    return fileUrl;
  }
  return `${fileUrl}#page=${pageNumber}`;
}

const nonTextSourceExtensions = new Set([
  ".docx",
  ".jpeg",
  ".jpg",
  ".pdf",
  ".png",
  ".pptx",
  ".webp",
  ".xlsx",
]);

export function buildHighlightedSourceViewerUrl(
  fileUrl,
  sourceFile,
  pageNumbers,
) {
  if (sourceFile.toLowerCase().endsWith(".pdf")) {
    return buildPdfViewerUrl(fileUrl, pageNumbers);
  }
  if (!isTextSourceFile(sourceFile)) {
    return fileUrl;
  }
  return `${fileUrl}#citeloom-evidence`;
}

export function isTextSourceFile(sourceFile) {
  const normalized = sourceFile.toLowerCase();
  const filename = normalized.split(/[\\/]/u).at(-1) ?? normalized;
  const extensionStart = filename.lastIndexOf(".");
  const extension = extensionStart < 0 ? "" : filename.slice(extensionStart);
  return !nonTextSourceExtensions.has(extension);
}
