import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CONFIRMATION_REQUEST_EVENT,
  dispatchConfirmationResponse,
} from "../web/assets/scripts/confirmation.js";
import {
  createSourceLibraryAdministrationActions,
  readSourceLibraryAdministration,
} from "../web/assets/scripts/source-libraries.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("CiteLoom source library administration", () => {
  it("loads libraries, grants, and grant drafts through the response boundary", async () => {
    const administration = buildAdministration();
    const fetchMock = vi.fn(async () => jsonResponse(administration));
    vi.stubGlobal("fetch", fetchMock);
    const page = createSourceLibraryPage();

    await page.loadSourceLibraryAdministration();

    expect(page.sourceLibraryAdministration).toEqual(administration);
    expect(page.sourceLibraryGrantDrafts).toEqual({
      "00000000-0000-4000-8000-000000000501:00000000-0000-4000-8000-000000000601": "manage",
      "00000000-0000-4000-8000-000000000501:00000000-0000-4000-8000-000000000602": "none",
    });
    expect(page.sourceLibraryGrantCount()).toBe(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/source-libraries/administration",
      { headers: { accept: "application/json" } },
    );
  });

  it("creates a shared library and refreshes organization administration", async () => {
    await withBrowser(async () => {
      const administration = buildAdministration();
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(jsonResponse({
          access: "manage",
          id: administration.libraries[0].id,
          kind: "shared",
          name: administration.libraries[0].name,
        }, 201))
        .mockResolvedValueOnce(jsonResponse(administration));
      vi.stubGlobal("fetch", fetchMock);
      const page = createSourceLibraryPage();
      page.sourceLibraryNameDraft = "  Common Sources  ";

      await page.createSharedSourceLibrary();

      expect(fetchMock).toHaveBeenNthCalledWith(
        1,
        "/api/source-libraries",
        expect.objectContaining({
          body: JSON.stringify({ name: "Common Sources" }),
          method: "POST",
        }),
      );
      expect(page.sourceLibraryNameDraft).toBe("");
      expect(page.sourceLibraryAdministration).toEqual(administration);
    });
  });

  it("grants use access and refreshes the effective assignment", async () => {
    await withBrowser(async () => {
      const administration = buildAdministration();
      const updated = structuredClone(administration);
      updated.libraries[0].grants.push({
        access: "use",
        workspaceId: updated.workspaces[1].id,
      });
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(new Response(null, { status: 204 }))
        .mockResolvedValueOnce(jsonResponse(updated));
      vi.stubGlobal("fetch", fetchMock);
      const page = createSourceLibraryPage();
      page.applySourceLibraryAdministration(administration);
      const library = administration.libraries[0];
      const workspace = administration.workspaces[1];
      const key = page.sourceLibraryGrantDraftKey(library.id, workspace.id);
      page.sourceLibraryGrantDrafts[key] = "use";

      await page.changeSourceLibraryGrant(library, workspace);

      expect(fetchMock).toHaveBeenNthCalledWith(
        1,
        `/api/source-libraries/${library.id}/grants/${workspace.id}`,
        expect.objectContaining({
          body: JSON.stringify({ access: "use" }),
          method: "PUT",
        }),
      );
      expect(page.sourceLibraryGrantDrafts[key]).toBe("use");
    });
  });

  it("renames a shared library and refreshes its administration state", async () => {
    await withBrowser(async () => {
      const administration = buildAdministration();
      const renamedAdministration = structuredClone(administration);
      renamedAdministration.libraries[0].name = "Organization Handbook";
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(new Response(null, { status: 204 }))
        .mockResolvedValueOnce(jsonResponse(renamedAdministration));
      vi.stubGlobal("fetch", fetchMock);
      const page = createSourceLibraryPage();
      page.applySourceLibraryAdministration(administration);
      const library = administration.libraries[0];
      page.startRenamingSourceLibrary(library);
      page.sourceLibraryRenameDraft = "  Organization Handbook  ";

      await page.renameSharedSourceLibrary(library);

      expect(fetchMock).toHaveBeenNthCalledWith(
        1,
        `/api/source-libraries/${library.id}`,
        expect.objectContaining({
          body: JSON.stringify({ name: "Organization Handbook" }),
          method: "PATCH",
        }),
      );
      expect(page.sourceLibraryAdministration).toEqual(renamedAdministration);
      expect(page.sourceLibraryRenamingId).toBeNull();
    });
  });

  it("opens Documents with the selected shared library", () => {
    const assign = vi.fn();
    vi.stubGlobal("window", { location: { assign } });
    const page = createSourceLibraryPage();
    const library = buildAdministration().libraries[0];

    page.manageSourceLibraryDocuments(library);

    const destination = new URL(assign.mock.calls[0][0], "https://localhost");
    expect(destination.searchParams.get("view")).toBe("documents");
    expect(destination.searchParams.get("source-library")).toBe(library.id);
  });

  it("archives and restores a shared library while retaining its grants", async () => {
    await withBrowser(async ({ confirmations }) => {
      const administration = buildAdministration();
      const archivedAdministration = structuredClone(administration);
      archivedAdministration.libraries[0].state = "archived";
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(new Response(null, { status: 204 }))
        .mockResolvedValueOnce(jsonResponse(archivedAdministration))
        .mockResolvedValueOnce(new Response(null, { status: 204 }))
        .mockResolvedValueOnce(jsonResponse(administration));
      vi.stubGlobal("fetch", fetchMock);
      const page = createSourceLibraryPage();
      page.applySourceLibraryAdministration(administration);
      const library = administration.libraries[0];

      await page.archiveSharedSourceLibrary(library);
      await page.restoreSharedSourceLibrary(archivedAdministration.libraries[0]);

      expect(confirmations).toEqual([
        expect.objectContaining({
          confirmLabel: "Archive library",
          title: "Archive Common Sources?",
        }),
      ]);
      expect(fetchMock).toHaveBeenNthCalledWith(
        1,
        `/api/source-libraries/${library.id}/archive`,
        expect.objectContaining({ method: "POST" }),
      );
      expect(fetchMock).toHaveBeenNthCalledWith(
        3,
        `/api/source-libraries/${library.id}/restore`,
        expect.objectContaining({ method: "POST" }),
      );
      expect(page.sourceLibraryAdministration).toEqual(administration);
    });
  });

  it("starts permanent deletion directly for an active shared library", async () => {
    await withBrowser(async ({ confirmations }) => {
      const administration = buildAdministration();
      const deletingAdministration = structuredClone(administration);
      deletingAdministration.libraries[0].state = "deleting";
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(new Response(null, { status: 202 }))
        .mockResolvedValueOnce(jsonResponse(deletingAdministration));
      vi.stubGlobal("fetch", fetchMock);
      const page = createSourceLibraryPage();
      page.applySourceLibraryAdministration(administration);
      const library = administration.libraries[0];

      await page.deleteSharedSourceLibrary(library);

      expect(confirmations).toEqual([
        expect.objectContaining({
          confirmLabel: "Delete permanently",
          description: expect.stringContaining(
            "Common Sources will become unavailable immediately.",
          ),
          title: "Delete Common Sources permanently?",
        }),
      ]);
      expect(fetchMock).toHaveBeenNthCalledWith(
        1,
        `/api/source-libraries/${library.id}`,
        expect.objectContaining({ method: "DELETE" }),
      );
      expect(page.sourceLibraryAdministration).toEqual(deletingAdministration);
      page.destroySourceLibraryAdministration();
    });
  });

  it("keeps an existing grant when access removal is cancelled", async () => {
    await withBrowser(async ({ confirmations }) => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const page = createSourceLibraryPage();
      const administration = buildAdministration();
      page.applySourceLibraryAdministration(administration);
      const library = administration.libraries[0];
      const workspace = administration.workspaces[0];
      const key = page.sourceLibraryGrantDraftKey(library.id, workspace.id);
      page.sourceLibraryGrantDrafts[key] = "none";

      await page.changeSourceLibraryGrant(library, workspace);

      expect(page.sourceLibraryGrantDrafts[key]).toBe("manage");
      expect(fetchMock).not.toHaveBeenCalled();
      expect(confirmations).toEqual([
        expect.objectContaining({
          confirmLabel: "Remove access",
          title: "Remove Research access?",
        }),
      ]);
    }, false);
  });

  it("rejects grants for workspaces outside the administration response", () => {
    const administration = buildAdministration();
    administration.libraries[0].grants[0].workspaceId =
      "00000000-0000-4000-8000-000000000699";

    expect(() => readSourceLibraryAdministration(administration)).toThrow(
      "A source library grant references an invalid workspace.",
    );
  });
});

function createSourceLibraryPage() {
  return createSourceLibraryAdministrationActions();
}

function buildAdministration() {
  return {
    libraries: [{
      grants: [{
        access: "manage",
        workspaceId: "00000000-0000-4000-8000-000000000601",
      }],
      id: "00000000-0000-4000-8000-000000000501",
      name: "Common Sources",
      state: "active",
    }],
    workspaces: [
      {
        id: "00000000-0000-4000-8000-000000000601",
        name: "Research",
      },
      {
        id: "00000000-0000-4000-8000-000000000602",
        name: "Legal",
      },
    ],
  };
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    status,
  });
}

async function withBrowser(operation, confirmed = true) {
  const originalWindow = globalThis.window;
  const browserWindow = new EventTarget();
  const confirmations = [];
  globalThis.window = browserWindow;
  browserWindow.addEventListener(CONFIRMATION_REQUEST_EVENT, (event) => {
    confirmations.push(event.detail);
    dispatchConfirmationResponse(event.detail.requestId, confirmed);
  });
  try {
    await operation({ confirmations });
  } finally {
    if (originalWindow === undefined) {
      delete globalThis.window;
    } else {
      globalThis.window = originalWindow;
    }
  }
}
