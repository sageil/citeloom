import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { registerPage } from "../web/assets/scripts/citeloom-documents.js";

describe("CiteLoom document ingestion controls", () => {
  it("uses the shared embedding progress presenter in the document inspector", () => {
    let pageFactory = null;
    registerPage({
      data(name, factory) {
        expect(name).toBe("citeloomDocumentsPage");
        pageFactory = factory;
      },
    });
    const page = pageFactory();

    expect(page.embeddingProgressDetail({
      embeddingProgress: {
        completedElements: 2,
        state: "in-progress",
        totalElements: 5,
      },
    })).toBe("2 of 5 elements embedded");
  });

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
