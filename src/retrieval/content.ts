import type { RetrievalSourceElement } from "../domain/source-elements.js";

export function buildRerankDocument(
  element: RetrievalSourceElement,
  focusedText: string,
): string {
  const parts = [element.sourceFile];
  if (element.sectionPath.length > 0) {
    parts.push(`Section: ${element.sectionPath.join(" > ")}`);
  }
  if (element.pageNumbers.length > 0) {
    parts.push(`Pages: ${element.pageNumbers.join(", ")}`);
  }
  parts.push(focusedText);
  return parts.join("\n");
}
