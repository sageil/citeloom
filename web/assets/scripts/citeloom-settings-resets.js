import { requestConfirmation } from "./citeloom-confirmation.js";

export function createSettingsResetActions(alpine) {
  return {
    async resetAll() {
      if (this.settings === null || this.saving) {
        return;
      }
      const confirmed = await requestConfirmation({
        cancelLabel: "Keep settings",
        confirmLabel: "Reset all settings",
        description: "This immediately restores every application and provider setting to its default value. This cannot be undone.",
        title: "Reset all settings?",
        tone: "danger",
      });
      if (!confirmed) {
        return;
      }
      const changes = buildRuntimeResetChanges(this.settings.fields);
      await this.submitSettingsUpdate(changes, [{ action: "reset" }]);
    },

    async resetField(field) {
      const confirmed = await requestConfirmation({
        cancelLabel: "Keep setting",
        confirmLabel: "Reset setting",
        description: `This stages only ${field.label} to use its default value. Save changes to apply it.`,
        title: `Reset ${field.label}?`,
        tone: "danger",
      });
      if (!confirmed) {
        return;
      }
      this.saved = false;
      this.drafts[field.key] = createResetDraftValue(field);
      this.pending[field.key] = "reset";
    },

    async resetRuntimeContext() {
      if (this.settings === null || this.saving) {
        return;
      }
      const context = this.runtimeResetContext();
      if (context === null) {
        return;
      }
      const confirmed = await requestConfirmation({
        cancelLabel: "Keep settings",
        confirmLabel: `Reset ${context.label}`,
        description: `This immediately restores only the settings in ${context.label} to their default values. Other application settings will not change.`,
        title: `Reset ${context.label}?`,
        tone: "danger",
      });
      if (!confirmed) {
        return;
      }
      const snapshot = captureResetSnapshot(this, alpine);
      const changes = buildRuntimeResetChanges(context.fields);
      const updated = await this.submitSettingsUpdate(changes, []);
      if (updated) {
        restoreDraftsAfterScopedReset(
          this,
          alpine,
          snapshot,
          context.fields,
          null,
          null,
        );
      }
    },

    runtimeResetContext() {
      const panel = this.activeRuntimePanel();
      if (panel !== null) {
        return { fields: panel.fields, label: panel.label };
      }
      if (this.selectedArea !== null) {
        for (const group of this.groups) {
          if (group.name === this.selectedArea) {
            return { fields: group.fields, label: group.name };
          }
        }
      }
      return null;
    },

    async resetSelectedFeature() {
      if (this.settings === null || this.saving) {
        return;
      }
      const capability = this.selectedFeatureCapability;
      const label = this.capabilityLabel(capability);
      const confirmed = await requestConfirmation({
        cancelLabel: "Keep settings",
        confirmLabel: `Reset ${label}`,
        description: `This immediately restores only the ${label} feature to its default settings. Other application features will not change.`,
        title: `Reset ${label}?`,
        tone: "danger",
      });
      if (!confirmed) {
        return;
      }
      const fields = this.featureFieldsFor(capability);
      const snapshot = captureResetSnapshot(this, alpine);
      const changes = buildRuntimeResetChanges(fields);
      const providerChanges = [{ action: "reset-feature", capability }];
      const updated = await this.submitSettingsUpdate(changes, providerChanges);
      if (updated) {
        restoreDraftsAfterScopedReset(
          this,
          alpine,
          snapshot,
          fields,
          capability,
          null,
        );
      }
    },

    async resetSelectedProvider() {
      if (
        this.settings === null
        || this.saving
        || this.selectedProviderId === null
      ) {
        return;
      }
      const providerId = this.selectedProviderId;
      const label = this.selectedProviderProfile?.displayName ?? providerId;
      const confirmed = await requestConfirmation({
        cancelLabel: "Keep settings",
        confirmLabel: `Reset ${label}`,
        description: `This immediately restores only the ${label} provider connection to its default settings. Other providers and application features will not change.`,
        title: `Reset ${label}?`,
        tone: "danger",
      });
      if (!confirmed) {
        return;
      }
      const snapshot = captureResetSnapshot(this, alpine);
      const providerChanges = [{ action: "reset-provider", providerId }];
      const updated = await this.submitSettingsUpdate([], providerChanges);
      if (updated) {
        restoreDraftsAfterScopedReset(
          this,
          alpine,
          snapshot,
          [],
          null,
          providerId,
        );
      }
    },
  };
}

function buildRuntimeResetChanges(fields) {
  const changes = [];
  for (const field of fields) {
    changes.push({ action: "reset", key: field.key });
  }
  return changes;
}

function createResetDraftValue(field) {
  if (field.input === "boolean") {
    return field.defaultValue === true;
  }
  if (field.sensitive || field.defaultValue === null) {
    return "";
  }
  return String(field.defaultValue);
}

function captureResetSnapshot(page, alpine) {
  return {
    credentialClears: [...page.credentialClears],
    credentialDrafts: cloneReactiveRecord(page.credentialDrafts, alpine),
    drafts: cloneReactiveRecord(page.drafts, alpine),
    pending: cloneReactiveRecord(page.pending, alpine),
    providerDrafts: page.providerDrafts === null
      ? null
      : cloneProviderDrafts(page.providerDrafts, alpine),
  };
}

function cloneReactiveRecord(record, alpine) {
  return { ...alpine.raw(record) };
}

function restoreDraftsAfterScopedReset(
  page,
  alpine,
  snapshot,
  resetFields,
  resetCapability,
  resetProviderId,
) {
  const resetKeys = new Set();
  for (const field of resetFields) {
    resetKeys.add(field.key);
  }
  for (const key of Object.keys(snapshot.pending)) {
    if (resetKeys.has(key)) {
      continue;
    }
    page.pending[key] = snapshot.pending[key];
    page.drafts[key] = snapshot.drafts[key];
  }
  restoreProviderDraftsAfterScopedReset(
    page,
    alpine,
    snapshot.providerDrafts,
    resetCapability,
    resetProviderId,
  );
  page.credentialDrafts = structuredClone(snapshot.credentialDrafts);
  page.credentialClears = [...snapshot.credentialClears];
  if (resetProviderId !== null) {
    delete page.credentialDrafts[resetProviderId];
    page.credentialClears = page.credentialClears.filter((providerId) => {
      return providerId !== resetProviderId;
    });
  }
  page.saved = page.changeCount === 0;
}

function restoreProviderDraftsAfterScopedReset(
  page,
  alpine,
  previousDrafts,
  resetCapability,
  resetProviderId,
) {
  if (previousDrafts === null || page.providerDrafts === null) {
    return;
  }
  const resetResult = cloneProviderDrafts(page.providerDrafts, alpine);
  const restoredDrafts = structuredClone(previousDrafts);
  if (resetCapability !== null) {
    restoredDrafts.routing[resetCapability] =
      resetResult.routing[resetCapability];
    restoredDrafts.featureOverrides[resetCapability] = structuredClone(
      resetResult.featureOverrides[resetCapability],
    );
  }
  if (resetProviderId !== null) {
    restoreResetProviderConnection(
      restoredDrafts,
      resetResult,
      resetProviderId,
    );
  }
  page.replaceProviderDrafts(restoredDrafts);
}

function restoreResetProviderConnection(
  restoredDrafts,
  resetResult,
  resetProviderId,
) {
  const resetConnection = resetResult.connections.find((candidate) => {
    return candidate.providerId === resetProviderId;
  });
  if (resetConnection === undefined) {
    return;
  }
  for (let index = 0; index < restoredDrafts.connections.length; index += 1) {
    const connection = restoredDrafts.connections[index];
    if (connection.providerId !== resetProviderId) {
      continue;
    }
    restoredDrafts.connections[index] = structuredClone(resetConnection);
    return;
  }
}

function cloneProviderDrafts(providerDrafts, alpine) {
  return structuredClone(alpine.raw(providerDrafts));
}
