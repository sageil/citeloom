import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("CiteLoom document ingestion controls", () => {
  it("shows controls to administrators and to the uploader", async () => {
    const fragment = await readFile(
      new URL("../web/fragments/documents.html", import.meta.url),
      "utf8",
    );

    expect(fragment).toContain(
      "(currentRole === 'admin' || (currentUserId !== null &amp;&amp; selectedDocument.uploadedByUserId === currentUserId))",
    );
  });

  it("uses the document management action layout for ingestion controls", async () => {
    const fragment = await readFile(
      new URL("../web/fragments/documents.html", import.meta.url),
      "utf8",
    );
    const actionLayoutMatches = fragment.match(
      /class="inspector-management-actions inspector-control-actions"/g,
    );

    expect(actionLayoutMatches).toHaveLength(2);
    expect(fragment).toMatch(
      /class="button secondary"[\s\S]*?Pause ingestion/,
    );
    expect(fragment).toMatch(
      /class="button danger"[\s\S]*?Cancel ingestion/,
    );
    expect(fragment).toContain(
      "This stops the reindex and keeps the current version available.",
    );
  });
});
