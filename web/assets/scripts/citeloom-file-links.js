export function buildPdfViewerUrl(fileUrl, pageNumbers) {
  const pageNumber = pageNumbers[0];
  if (pageNumber === undefined) {
    return fileUrl;
  }
  return `${fileUrl}#page=${pageNumber}`;
}
