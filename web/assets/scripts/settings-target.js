import { requestConfirmation } from "./confirmation.js";

const settingsTargetStorageKey = "citeloom.settings-target";
const workspaceIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function readSettingsTargetPreference() {
  const storage = readSessionStorage();
  if (storage === null) {
    return null;
  }
  let value;
  try {
    value = storage.getItem(settingsTargetStorageKey);
  } catch {
    return null;
  }
  if (value === "organization" || workspaceIdPattern.test(value)) {
    return value;
  }
  return null;
}

export function writeSettingsTargetPreference(targetId) {
  if (targetId !== "organization" && !workspaceIdPattern.test(targetId)) {
    return false;
  }
  const storage = readSessionStorage();
  if (storage === null) {
    return false;
  }
  try {
    storage.setItem(settingsTargetStorageKey, targetId);
    return true;
  } catch {
    return false;
  }
}

export function clearSettingsTargetPreference() {
  const storage = readSessionStorage();
  if (storage === null) {
    return false;
  }
  try {
    storage.removeItem(settingsTargetStorageKey);
    return true;
  } catch {
    return false;
  }
}

export function createSettingsTargetActions(readSettingsResponse) {
  const initialTarget = readSettingsTargetPreference();

  return {
    abortController: null,
    preferredSettingsTargetId: initialTarget,

    async loadScopeResources() {
      const requests = [];
      if (this.organizationSettingsVisible) {
        requests.push(
          this.loadOpenAICodexAuth(),
          this.loadSourceContentStorage(),
          this.loadSourceLibraryAdministration(),
        );
      } else {
        this.destroySourceContentStorage();
        this.destroySourceLibraryAdministration();
        if (this.openAICodexPollTimer !== null) {
          clearTimeout(this.openAICodexPollTimer);
          this.openAICodexPollTimer = null;
        }
        this.openAICodexAuth = null;
        this.sourceContentStorage = null;
      }
      if (this.workspaceManagementVisible) {
        requests.push(this.loadUsers());
      } else {
        this.destroyUserManagement();
      }
      await Promise.all(requests);
    },

    async loadSettings(targetId = null, allowUnavailableTargetFallback = true) {
      const requestedTargetId = this.resolveSettingsTargetId(targetId);
      this.abortController?.abort();
      const controller = new AbortController();
      this.abortController = controller;
      this.loading = true;
      this.errorMessage = "";
      try {
        const response = await fetch(this.settingsRequestUrl(requestedTargetId), {
          headers: { accept: "application/json" },
          signal: controller.signal,
        });
        if (
          allowUnavailableTargetFallback
          && this.settings === null
          && this.preferredSettingsTargetId !== null
          && (response.status === 403 || response.status === 404)
        ) {
          this.forgetSettingsTarget();
          return await this.loadSettings(null, false);
        }
        const settings = await readSettingsResponse(response, "Settings request");
        this.applySettings(settings);
        return true;
      } catch (error) {
        if (!controller.signal.aborted) {
          this.errorMessage = error instanceof Error
            ? error.message
            : "The settings request failed.";
        }
        return false;
      } finally {
        if (!controller.signal.aborted) {
          this.loading = false;
        }
      }
    },

    resolveSettingsTargetId(targetId = null) {
      return targetId
        ?? this.settings?.scope.id
        ?? this.preferredSettingsTargetId;
    },

    settingsRequestUrl(targetId = null) {
      const requestedTargetId = this.resolveSettingsTargetId(targetId);
      if (
        requestedTargetId === null
        || requestedTargetId === "organization"
      ) {
        return "/api/settings";
      }
      return `/api/workspaces/${encodeURIComponent(requestedTargetId)}/settings`;
    },

    rememberSettingsTarget(targetId) {
      this.preferredSettingsTargetId = targetId;
      writeSettingsTargetPreference(targetId);
    },

    forgetSettingsTarget() {
      clearSettingsTargetPreference();
      this.preferredSettingsTargetId = null;
    },

    async changeSettingsTargetFromControl(control) {
      const requestedTargetId = control.value;
      control.value = this.settings?.scope.id ?? "";
      const changed = await this.changeSettingsTarget(requestedTargetId);
      control.value = this.settings?.scope.id ?? "";
      return changed;
    },

    async changeSettingsTarget(targetId, destinationArea = null) {
      const activeTargetId = this.settings?.scope.id;
      if (activeTargetId === undefined) {
        return false;
      }
      let targetAvailable = false;
      for (const target of this.settings.scope.available) {
        if (target.id === targetId) {
          targetAvailable = true;
          break;
        }
      }
      if (!targetAvailable) {
        return false;
      }
      if (targetId === activeTargetId) {
        if (destinationArea !== null) {
          this.selectArea(destinationArea);
        }
        return true;
      }
      if (this.loading) {
        return false;
      }
      if (this.changeCount > 0) {
        const confirmed = await requestConfirmation({
          cancelLabel: "Keep editing",
          confirmLabel: "Discard changes",
          description: "Unsaved settings changes will be discarded when you switch target.",
          title: "Switch settings target?",
          tone: "danger",
        });
        if (!confirmed) {
          return false;
        }
      }
      this.selectedArea = null;
      this.locationStateRestored = false;
      const loaded = await this.loadSettings(targetId);
      if (!loaded) {
        return false;
      }
      await this.loadScopeResources();
      if (destinationArea !== null) {
        this.selectArea(destinationArea);
      }
      return true;
    },

    destroySettingsTargetActions() {
      this.abortController?.abort();
    },
  };
}

function readSessionStorage() {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}
