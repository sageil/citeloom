import {
  readArray,
  readEnum,
  readJsonResponse,
  readNonEmptyString,
  readPlainObject,
} from "./citeloom-boundaries.js";
import { requestConfirmation } from "./citeloom-confirmation.js";
import { dispatchNotice } from "./citeloom-notices.js";

const SOURCE_LIBRARY_DELETION_REFRESH_INTERVAL_MS = 2_000;

const sourceLibraryAccessValues = Object.freeze(["none", "use", "manage"]);

export function readSourceLibrarySummaries(value) {
  const libraries = [];
  const libraryIds = new Set();
  for (const candidate of readArray(value, "source libraries")) {
    const library = readPlainObject(candidate, "source library");
    const id = readNonEmptyString(library.id, "source library ID");
    if (libraryIds.has(id)) {
      throw new Error("A source library appears more than once.");
    }
    libraryIds.add(id);
    libraries.push({
      access: readEnum(
        library.access,
        ["manage", "use"],
        "source library access",
      ),
      id,
      kind: readEnum(
        library.kind,
        ["private", "shared"],
        "source library kind",
      ),
      name: readNonEmptyString(library.name, "source library name"),
    });
  }
  return libraries;
}

export function buildSourceLibraryViewUrl(view, libraryId) {
  const parameters = new URLSearchParams({
    "source-library": libraryId,
    view,
  });
  return `./index.html?${parameters.toString()}`;
}

export function createSourceLibraryAdministrationActions() {
  return {
    sourceLibraryAdministration: null,
    sourceLibraryAdministrationBusy: false,
    sourceLibraryAdministrationError: "",
    sourceLibraryDeletionRefreshTimer: null,
    sourceLibraryGrantDrafts: {},
    sourceLibraryNameDraft: "",
    sourceLibraryRenameDraft: "",
    sourceLibraryRenamingId: null,

    async loadSourceLibraryAdministration() {
      this.sourceLibraryAdministrationBusy = true;
      try {
        const response = await fetch("/api/source-libraries/administration", {
          headers: { accept: "application/json" },
        });
        const administration = await readJsonResponse(
          response,
          "Source library administration request",
          readSourceLibraryAdministration,
        );
        this.applySourceLibraryAdministration(administration);
      } catch (error) {
        this.sourceLibraryAdministrationError = readErrorMessage(error);
      } finally {
        this.sourceLibraryAdministrationBusy = false;
      }
    },

    applySourceLibraryAdministration(administration) {
      const drafts = {};
      for (const library of administration.libraries) {
        for (const workspace of administration.workspaces) {
          const key = this.sourceLibraryGrantDraftKey(
            library.id,
            workspace.id,
          );
          drafts[key] = this.sourceLibraryWorkspaceAccess(
            library,
            workspace.id,
          );
        }
      }
      this.sourceLibraryAdministration = administration;
      this.sourceLibraryGrantDrafts = drafts;
      if (this.sourceLibraryRenamingId !== null) {
        const renamedLibrary = administration.libraries.find((library) => {
          return library.id === this.sourceLibraryRenamingId;
        });
        if (renamedLibrary === undefined) {
          this.sourceLibraryRenamingId = null;
          this.sourceLibraryRenameDraft = "";
        }
      }
      this.sourceLibraryAdministrationError = "";
      this.scheduleSourceLibraryDeletionRefresh();
    },

    destroySourceLibraryAdministration() {
      this.sourceLibraryAdministration = null;
      this.sourceLibraryAdministrationBusy = false;
      this.sourceLibraryAdministrationError = "";
      this.clearSourceLibraryDeletionRefresh();
      this.sourceLibraryGrantDrafts = {};
      this.sourceLibraryNameDraft = "";
      this.sourceLibraryRenameDraft = "";
      this.sourceLibraryRenamingId = null;
    },

    sourceLibraryGrantDraftKey(libraryId, workspaceId) {
      return `${libraryId}:${workspaceId}`;
    },

    sourceLibraryWorkspaceAccess(library, workspaceId) {
      for (const grant of library.grants) {
        if (grant.workspaceId === workspaceId) {
          return grant.access;
        }
      }
      return "none";
    },

    sourceLibraryGrantedWorkspaceCount(library) {
      return library.grants.length;
    },

    sourceLibraryGrantCount() {
      let count = 0;
      for (const library of this.sourceLibraryAdministration?.libraries ?? []) {
        if (library.state !== "active") {
          continue;
        }
        count += library.grants.length;
      }
      return count;
    },

    sourceLibraryActiveCount() {
      let count = 0;
      for (const library of this.sourceLibraryAdministration?.libraries ?? []) {
        if (library.state === "active") {
          count += 1;
        }
      }
      return count;
    },

    clearSourceLibraryDeletionRefresh() {
      if (this.sourceLibraryDeletionRefreshTimer === null) {
        return;
      }
      globalThis.clearTimeout(this.sourceLibraryDeletionRefreshTimer);
      this.sourceLibraryDeletionRefreshTimer = null;
    },

    scheduleSourceLibraryDeletionRefresh() {
      this.clearSourceLibraryDeletionRefresh();
      const deleting = this.sourceLibraryAdministration?.libraries.some(
        (library) => library.state === "deleting",
      ) ?? false;
      if (!deleting) {
        return;
      }
      this.sourceLibraryDeletionRefreshTimer = globalThis.setTimeout(async () => {
        this.sourceLibraryDeletionRefreshTimer = null;
        await this.loadSourceLibraryAdministration();
      }, SOURCE_LIBRARY_DELETION_REFRESH_INTERVAL_MS);
    },

    sourceLibraryCountLabel(count, singular) {
      let label = singular;
      if (count !== 1) {
        label = singular.endsWith("y")
          ? `${singular.slice(0, -1)}ies`
          : `${singular}s`;
      }
      return `${count} ${label}`;
    },

    async createSharedSourceLibrary() {
      if (this.sourceLibraryAdministrationBusy) {
        return;
      }
      const name = this.sourceLibraryNameDraft.trim();
      if (name === "") {
        this.sourceLibraryAdministrationError = "Enter a shared library name.";
        return;
      }
      this.sourceLibraryAdministrationBusy = true;
      this.sourceLibraryAdministrationError = "";
      try {
        const response = await fetch("/api/source-libraries", {
          body: JSON.stringify({ name }),
          headers: {
            accept: "application/json",
            "content-type": "application/json",
          },
          method: "POST",
        });
        const library = await readJsonResponse(
          response,
          "Shared source library creation",
          readCreatedSharedSourceLibrary,
        );
        this.sourceLibraryNameDraft = "";
        await this.loadSourceLibraryAdministration();
        dispatchNotice("success", `${library.name} was created.`);
      } catch (error) {
        this.sourceLibraryAdministrationError = readErrorMessage(error);
      } finally {
        this.sourceLibraryAdministrationBusy = false;
      }
    },

    startRenamingSourceLibrary(library) {
      this.sourceLibraryRenamingId = library.id;
      this.sourceLibraryRenameDraft = library.name;
      this.$nextTick?.(() => this.$refs.sourceLibraryRenameInput?.focus());
    },

    cancelRenamingSourceLibrary() {
      this.sourceLibraryRenamingId = null;
      this.sourceLibraryRenameDraft = "";
    },

    async renameSharedSourceLibrary(library) {
      if (this.sourceLibraryAdministrationBusy) {
        return;
      }
      const name = this.sourceLibraryRenameDraft.trim();
      if (name === "") {
        this.sourceLibraryAdministrationError = "Enter a shared library name.";
        return;
      }
      if (name === library.name) {
        this.cancelRenamingSourceLibrary();
        return;
      }
      this.sourceLibraryAdministrationBusy = true;
      this.sourceLibraryAdministrationError = "";
      try {
        await requireSuccessfulEmptyResponse(
          await fetch(buildSourceLibraryUrl(library.id), {
            body: JSON.stringify({ name }),
            headers: {
              accept: "application/json",
              "content-type": "application/json",
            },
            method: "PATCH",
          }),
          "Shared source library rename",
        );
        this.cancelRenamingSourceLibrary();
        await this.loadSourceLibraryAdministration();
        dispatchNotice("success", `${name} was renamed.`);
      } catch (error) {
        this.sourceLibraryAdministrationError = readErrorMessage(error);
      } finally {
        this.sourceLibraryAdministrationBusy = false;
      }
    },

    manageSourceLibraryDocuments(library) {
      window.location.assign(
        buildSourceLibraryViewUrl("documents", library.id),
      );
    },

    async archiveSharedSourceLibrary(library) {
      if (this.sourceLibraryAdministrationBusy) {
        return;
      }
      const confirmed = await requestConfirmation({
        cancelLabel: "Keep library",
        confirmLabel: "Archive library",
        description: `${library.name} will be hidden from every workspace. Its documents and workspace access assignments will be retained and restored with it.`,
        title: `Archive ${library.name}?`,
        tone: "danger",
      });
      if (!confirmed) {
        return;
      }
      this.sourceLibraryAdministrationBusy = true;
      this.sourceLibraryAdministrationError = "";
      try {
        await requireSuccessfulEmptyResponse(
          await fetch(`${buildSourceLibraryUrl(library.id)}/archive`, {
            headers: { accept: "application/json" },
            method: "POST",
          }),
          "Shared source library archive",
        );
        await this.loadSourceLibraryAdministration();
        dispatchNotice("success", `${library.name} was archived.`);
      } catch (error) {
        this.sourceLibraryAdministrationError = readErrorMessage(error);
      } finally {
        this.sourceLibraryAdministrationBusy = false;
      }
    },

    async deleteSharedSourceLibrary(library) {
      if (
        this.sourceLibraryAdministrationBusy
        || library.state === "deleting"
      ) {
        return;
      }
      let availabilityMessage = `${library.name} is already unavailable.`;
      if (library.state === "active") {
        availabilityMessage = `${library.name} will become unavailable immediately.`;
      }
      const confirmed = await requestConfirmation({
        cancelLabel: "Keep library",
        confirmLabel: "Delete permanently",
        description: `${availabilityMessage} All documents in it and its workspace access assignments will be permanently deleted. This cannot be undone.`,
        title: `Delete ${library.name} permanently?`,
        tone: "danger",
      });
      if (!confirmed) {
        return;
      }
      this.sourceLibraryAdministrationBusy = true;
      this.sourceLibraryAdministrationError = "";
      try {
        await requireSuccessfulEmptyResponse(
          await fetch(buildSourceLibraryUrl(library.id), {
            headers: { accept: "application/json" },
            method: "DELETE",
          }),
          "Permanent shared source library deletion",
        );
        await this.loadSourceLibraryAdministration();
      } catch (error) {
        this.sourceLibraryAdministrationError = readErrorMessage(error);
      } finally {
        this.sourceLibraryAdministrationBusy = false;
      }
    },

    async restoreSharedSourceLibrary(library) {
      if (this.sourceLibraryAdministrationBusy) {
        return;
      }
      this.sourceLibraryAdministrationBusy = true;
      this.sourceLibraryAdministrationError = "";
      try {
        await requireSuccessfulEmptyResponse(
          await fetch(`${buildSourceLibraryUrl(library.id)}/restore`, {
            headers: { accept: "application/json" },
            method: "POST",
          }),
          "Shared source library restore",
        );
        await this.loadSourceLibraryAdministration();
        dispatchNotice("success", `${library.name} was restored.`);
      } catch (error) {
        this.sourceLibraryAdministrationError = readErrorMessage(error);
      } finally {
        this.sourceLibraryAdministrationBusy = false;
      }
    },

    async changeSourceLibraryGrant(library, workspace) {
      if (this.sourceLibraryAdministrationBusy) {
        return;
      }
      const key = this.sourceLibraryGrantDraftKey(library.id, workspace.id);
      const previousAccess = this.sourceLibraryWorkspaceAccess(
        library,
        workspace.id,
      );
      const nextAccess = readEnum(
        this.sourceLibraryGrantDrafts[key],
        sourceLibraryAccessValues,
        "source library access",
      );
      if (nextAccess === previousAccess) {
        return;
      }
      if (nextAccess === "none") {
        const confirmed = await requestConfirmation({
          cancelLabel: "Keep access",
          confirmLabel: "Remove access",
          description: `${workspace.name} members will no longer find or use sources from ${library.name}. The shared content will not be deleted.`,
          title: `Remove ${workspace.name} access?`,
          tone: "danger",
        });
        if (!confirmed) {
          this.sourceLibraryGrantDrafts[key] = previousAccess;
          return;
        }
      }
      this.sourceLibraryAdministrationBusy = true;
      this.sourceLibraryAdministrationError = "";
      try {
        const url = buildSourceLibraryGrantUrl(library.id, workspace.id);
        if (nextAccess === "none") {
          await requireSuccessfulEmptyResponse(
            await fetch(url, {
              headers: { accept: "application/json" },
              method: "DELETE",
            }),
            "Source library access removal",
          );
        } else {
          await requireSuccessfulEmptyResponse(
            await fetch(url, {
              body: JSON.stringify({ access: nextAccess }),
              headers: {
                accept: "application/json",
                "content-type": "application/json",
              },
              method: "PUT",
            }),
            "Source library access update",
          );
        }
        await this.loadSourceLibraryAdministration();
        dispatchNotice("success", `${workspace.name} access was updated.`);
      } catch (error) {
        this.sourceLibraryGrantDrafts[key] = previousAccess;
        this.sourceLibraryAdministrationError = readErrorMessage(error);
      } finally {
        this.sourceLibraryAdministrationBusy = false;
      }
    },
  };
}

export function readSourceLibraryAdministration(value) {
  const response = readPlainObject(value, "source library administration");
  const workspaces = readAdministrationWorkspaces(response.workspaces);
  const workspaceIds = new Set(workspaces.map((workspace) => workspace.id));
  const libraries = [];
  const libraryIds = new Set();
  for (const candidate of readArray(
    response.libraries,
    "shared source libraries",
  )) {
    const library = readPlainObject(candidate, "shared source library");
    const id = readNonEmptyString(library.id, "shared source library ID");
    if (libraryIds.has(id)) {
      throw new Error("A shared source library appears more than once.");
    }
    libraryIds.add(id);
    libraries.push({
      grants: readAdministrationGrants(library.grants, workspaceIds),
      id,
      name: readNonEmptyString(library.name, "shared source library name"),
      state: readEnum(
        library.state,
        ["active", "archived", "deleting"],
        "shared source library state",
      ),
    });
  }
  return { libraries, workspaces };
}

function readAdministrationWorkspaces(value) {
  const workspaces = [];
  const workspaceIds = new Set();
  for (const candidate of readArray(value, "source library workspaces")) {
    const workspace = readPlainObject(candidate, "source library workspace");
    const id = readNonEmptyString(workspace.id, "source library workspace ID");
    if (workspaceIds.has(id)) {
      throw new Error("A source library workspace appears more than once.");
    }
    workspaceIds.add(id);
    workspaces.push({
      id,
      name: readNonEmptyString(workspace.name, "source library workspace name"),
    });
  }
  return workspaces;
}

function readAdministrationGrants(value, workspaceIds) {
  const grants = [];
  const grantedWorkspaceIds = new Set();
  for (const candidate of readArray(value, "source library grants")) {
    const grant = readPlainObject(candidate, "source library grant");
    const workspaceId = readNonEmptyString(
      grant.workspaceId,
      "source library grant workspace ID",
    );
    if (!workspaceIds.has(workspaceId) || grantedWorkspaceIds.has(workspaceId)) {
      throw new Error("A source library grant references an invalid workspace.");
    }
    grantedWorkspaceIds.add(workspaceId);
    grants.push({
      access: readEnum(
        grant.access,
        ["use", "manage"],
        "source library grant access",
      ),
      workspaceId,
    });
  }
  return grants;
}

function readCreatedSharedSourceLibrary(value) {
  const library = readPlainObject(value, "created shared source library");
  return {
    access: readEnum(
      library.access,
      ["manage"],
      "created shared source library access",
    ),
    id: readNonEmptyString(library.id, "created shared source library ID"),
    kind: readEnum(
      library.kind,
      ["shared"],
      "created source library kind",
    ),
    name: readNonEmptyString(library.name, "created shared source library name"),
  };
}

function buildSourceLibraryGrantUrl(libraryId, workspaceId) {
  return `/api/source-libraries/${encodeURIComponent(libraryId)}/grants/${encodeURIComponent(workspaceId)}`;
}

function buildSourceLibraryUrl(libraryId) {
  return `/api/source-libraries/${encodeURIComponent(libraryId)}`;
}

async function requireSuccessfulEmptyResponse(response, label) {
  if (response.ok) {
    return;
  }
  await readJsonResponse(response, label);
}

function readErrorMessage(error) {
  return error instanceof Error
    ? error.message
    : "Source library administration failed.";
}
