import {
  readBoolean,
  readEnum,
  readJsonResponse,
  readNonEmptyString,
  readNonNegativeInteger,
  readNullableNonEmptyString,
  readPlainObject,
  readPositiveInteger,
} from "./citeloom-boundaries.js";
import { requestConfirmation } from "./citeloom-confirmation.js";
import { dispatchNotice } from "./citeloom-notices.js";

const storageKinds = Object.freeze(["filesystem", "s3"]);
const credentialSources = Object.freeze(["environment", "static"]);
const migrationStates = Object.freeze([
  "queued",
  "validating",
  "copying",
  "cutover",
  "cancel_requested",
  "completed",
  "failed",
  "cancelled",
]);
const activeMigrationStates = new Set([
  "queued",
  "validating",
  "copying",
  "cutover",
  "cancel_requested",
]);
const STORAGE_REFRESH_INTERVAL_MS = 2_000;

export function createSourceContentStorageActions() {
  return {
    sourceContentStorage: null,
    sourceContentStorageBusy: false,
    sourceContentStorageDraft: null,
    sourceContentStorageError: "",
    sourceContentStorageProbePassed: false,
    sourceContentStorageRefreshTimer: null,

    async loadSourceContentStorage() {
      try {
        const response = await fetch("/api/source-content-storage", {
          headers: { accept: "application/json" },
        });
        const storage = await readJsonResponse(
          response,
          "Object storage request",
          readSourceContentStorageResponse,
        );
        this.applySourceContentStorage(storage);
      } catch (error) {
        this.sourceContentStorageError = error instanceof Error
          ? error.message
          : "Object storage settings could not be loaded.";
        this.scheduleSourceContentStorageRefresh();
      }
    },

    applySourceContentStorage(storage) {
      this.sourceContentStorage = storage;
      this.sourceContentStorageDraft = createStorageDraft(storage.active);
      this.sourceContentStorageError = "";
      this.sourceContentStorageProbePassed = false;
      this.scheduleSourceContentStorageRefresh();
    },

    scheduleSourceContentStorageRefresh() {
      if (this.sourceContentStorageRefreshTimer !== null) {
        clearTimeout(this.sourceContentStorageRefreshTimer);
        this.sourceContentStorageRefreshTimer = null;
      }
      if (!this.sourceContentMigrationActive()) {
        return;
      }
      this.sourceContentStorageRefreshTimer = setTimeout(() => {
        this.sourceContentStorageRefreshTimer = null;
        void this.loadSourceContentStorage();
      }, STORAGE_REFRESH_INTERVAL_MS);
    },

    destroySourceContentStorage() {
      if (this.sourceContentStorageRefreshTimer !== null) {
        clearTimeout(this.sourceContentStorageRefreshTimer);
        this.sourceContentStorageRefreshTimer = null;
      }
    },

    sourceContentMigrationActive() {
      const state = this.sourceContentStorage?.migration?.state;
      return state !== undefined && activeMigrationStates.has(state);
    },

    sourceContentMigrationCancellable() {
      const state = this.sourceContentStorage?.migration?.state;
      return state !== undefined
        && activeMigrationStates.has(state)
        && state !== "cutover"
        && state !== "cancel_requested";
    },

    sourceContentStorageDraftMatchesActive() {
      const active = this.sourceContentStorage?.active;
      if (active === undefined) {
        return false;
      }
      return storageDraftMatchesActive(
        this.sourceContentStorageDraft,
        active,
      );
    },

    sourceContentStorageStatusReady() {
      return this.sourceContentStorageProbePassed
        || this.sourceContentStorageDraftMatchesActive();
    },

    sourceContentStorageStatusMessage() {
      const matchesActive = this.sourceContentStorageDraftMatchesActive();
      if (matchesActive && this.sourceContentStorageProbePassed) {
        return "Active connection test passed. This configuration is already active, so no migration is needed.";
      }
      if (matchesActive) {
        return "This configuration is already active. Change a setting to create a migration target.";
      }
      if (this.sourceContentStorageProbePassed) {
        return "Connection test passed. The target accepted a write and delete probe.";
      }
      return "Test the connection before starting a migration.";
    },

    sourceContentMigrationProgress() {
      const migration = this.sourceContentStorage?.migration;
      if (migration === null || migration === undefined) {
        return 0;
      }
      if (migration.state === "completed") {
        return 100;
      }
      if (migration.totalDocuments === 0) {
        return migration.state === "cutover" ? 95 : 0;
      }
      const copied = Math.min(
        migration.copiedDocuments,
        migration.totalDocuments,
      );
      return Math.min(95, Math.round(
        copied / migration.totalDocuments * 90,
      ));
    },

    sourceContentMigrationStateLabel() {
      const state = this.sourceContentStorage?.migration?.state;
      const labels = {
        cancel_requested: "Cancelling",
        cancelled: "Cancelled",
        completed: "Completed",
        copying: "Copying and verifying",
        cutover: "Final verification and cutover",
        failed: "Failed",
        queued: "Queued",
        validating: "Testing target storage",
      };
      return state === undefined ? "No migration" : labels[state];
    },

    changeSourceContentStorageKind(kind) {
      if (this.sourceContentStorageDraft === null) {
        return;
      }
      this.sourceContentStorageDraft.kind = readEnum(
        kind,
        storageKinds,
        "storage kind",
      );
      this.sourceContentStorageProbePassed = false;
    },

    writeSourceContentStorageDraft(key, value) {
      if (this.sourceContentStorageDraft === null) {
        return;
      }
      this.sourceContentStorageDraft[key] = value;
      this.sourceContentStorageProbePassed = false;
    },

    resetSourceContentStorageDraft() {
      if (this.sourceContentStorage === null) {
        return;
      }
      this.sourceContentStorageDraft = createStorageDraft(
        this.sourceContentStorage.active,
      );
      this.sourceContentStorageError = "";
      this.sourceContentStorageProbePassed = false;
    },

    async testSourceContentStorage() {
      if (
        this.sourceContentStorageBusy
        || this.sourceContentMigrationActive()
      ) {
        return;
      }
      let target;
      try {
        target = buildStorageTarget(this.sourceContentStorageDraft);
      } catch (error) {
        this.sourceContentStorageError = readErrorMessage(error);
        return;
      }
      this.sourceContentStorageBusy = true;
      this.sourceContentStorageError = "";
      this.sourceContentStorageProbePassed = false;
      try {
        const response = await fetch("/api/source-content-storage/probes", {
          body: JSON.stringify({ target }),
          headers: {
            accept: "application/json",
            "content-type": "application/json",
          },
          method: "POST",
        });
        await readJsonResponse(response, "Object storage connection test");
        this.sourceContentStorageProbePassed = true;
        dispatchNotice("success", "The storage connection is ready.");
      } catch (error) {
        this.sourceContentStorageError = readErrorMessage(error);
      } finally {
        this.sourceContentStorageBusy = false;
      }
    },

    async startSourceContentMigration() {
      if (
        this.sourceContentStorage === null
        || this.sourceContentStorageBusy
        || !this.sourceContentStorageProbePassed
        || this.sourceContentMigrationActive()
        || this.sourceContentStorageDraftMatchesActive()
      ) {
        return;
      }
      let target;
      try {
        target = buildStorageTarget(this.sourceContentStorageDraft);
      } catch (error) {
        this.sourceContentStorageError = readErrorMessage(error);
        return;
      }
      const confirmed = await requestConfirmation({
        cancelLabel: "Keep current storage",
        confirmLabel: "Start migration",
        description: `CiteLoom will copy and verify ${this.sourceContentStorage.documentCount} documents before switching storage. The current backend will be retained for rollback and will not stay synchronized after cutover.`,
        title: "Migrate source-content storage?",
        tone: "default",
      });
      if (!confirmed) {
        return;
      }
      this.sourceContentStorageBusy = true;
      this.sourceContentStorageError = "";
      try {
        const response = await fetch(
          "/api/source-content-storage/migrations",
          {
            body: JSON.stringify({
              expectedSettingsVersion:
                this.sourceContentStorage.settingsVersion,
              target,
            }),
            headers: {
              accept: "application/json",
              "content-type": "application/json",
            },
            method: "POST",
          },
        );
        const migration = await readJsonResponse(
          response,
          "Source-content migration request",
          readSourceContentMigration,
        );
        this.sourceContentStorage = {
          ...this.sourceContentStorage,
          migration,
        };
        this.sourceContentStorageProbePassed = false;
        this.scheduleSourceContentStorageRefresh();
        await this.loadSourceContentStorage();
        dispatchNotice("success", "The storage migration was queued.");
      } catch (error) {
        this.sourceContentStorageError = readErrorMessage(error);
      } finally {
        this.sourceContentStorageBusy = false;
      }
    },

    async cancelSourceContentMigration() {
      const migration = this.sourceContentStorage?.migration;
      if (
        migration === null
        || migration === undefined
        || this.sourceContentStorageBusy
        || !this.sourceContentMigrationCancellable()
      ) {
        return;
      }
      const confirmed = await requestConfirmation({
        cancelLabel: "Continue migration",
        confirmLabel: "Cancel migration",
        description: "CiteLoom will keep the current backend active. Objects already copied to the target will remain there for a future retry or explicit cleanup.",
        title: "Cancel storage migration?",
        tone: "danger",
      });
      if (!confirmed) {
        return;
      }
      this.sourceContentStorageBusy = true;
      try {
        const response = await fetch(
          `/api/source-content-storage/migrations/${encodeURIComponent(migration.id)}/cancellation`,
          {
            headers: { accept: "application/json" },
            method: "POST",
          },
        );
        await readJsonResponse(
          response,
          "Storage migration cancellation",
          readSourceContentMigration,
        );
        await this.loadSourceContentStorage();
      } catch (error) {
        this.sourceContentStorageError = readErrorMessage(error);
      } finally {
        this.sourceContentStorageBusy = false;
      }
    },
  };
}

export function readSourceContentStorageResponse(value) {
  const response = readPlainObject(value, "object storage");
  return {
    active: readSourceContentConfig(response.active, "active storage"),
    documentCount: readNonNegativeInteger(
      response.documentCount,
      "source document count",
    ),
    migration: response.migration === null
      ? null
      : readSourceContentMigration(response.migration),
    settingsVersion: readPositiveInteger(
      response.settingsVersion,
      "storage settings version",
    ),
  };
}

function readSourceContentMigration(value) {
  const migration = readPlainObject(value, "source-content migration");
  return {
    attemptCount: readNonNegativeInteger(
      migration.attemptCount,
      "migration attempt count",
    ),
    completedAt: readNullableNonEmptyString(
      migration.completedAt,
      "migration completion time",
    ),
    copiedDocuments: readNonNegativeInteger(
      migration.copiedDocuments,
      "copied document count",
    ),
    createdAt: readNonEmptyString(migration.createdAt, "migration creation time"),
    errorMessage: readNullableNonEmptyString(
      migration.errorMessage,
      "migration error",
    ),
    id: readNonEmptyString(migration.id, "migration ID"),
    source: readSourceContentConfig(migration.source, "migration source"),
    startedAt: readNullableNonEmptyString(
      migration.startedAt,
      "migration start time",
    ),
    state: readEnum(
      migration.state,
      migrationStates,
      "migration state",
    ),
    target: readSourceContentConfig(migration.target, "migration target"),
    totalDocuments: readNonNegativeInteger(
      migration.totalDocuments,
      "migration document count",
    ),
    updatedAt: readNonEmptyString(migration.updatedAt, "migration update time"),
    verifiedDocuments: readNonNegativeInteger(
      migration.verifiedDocuments,
      "verified document count",
    ),
  };
}

function readSourceContentConfig(value, label) {
  const config = readPlainObject(value, label);
  const kind = readEnum(config.kind, storageKinds, `${label} kind`);
  if (kind === "filesystem") {
    return {
      directory: readNonEmptyString(config.directory, `${label} directory`),
      kind,
    };
  }
  return {
    bucket: readNonEmptyString(config.bucket, `${label} bucket`),
    credentialSource: readEnum(
      config.credentialSource,
      credentialSources,
      `${label} credential source`,
    ),
    credentialsConfigured: readBoolean(
      config.credentialsConfigured,
      `${label} credential status`,
    ),
    endpointUrl: readNonEmptyString(config.endpointUrl, `${label} endpoint`),
    forcePathStyle: readBoolean(
      config.forcePathStyle,
      `${label} path-style setting`,
    ),
    kind,
    prefix: readNonEmptyString(config.prefix, `${label} prefix`),
    region: readNonEmptyString(config.region, `${label} region`),
  };
}

function createStorageDraft(active) {
  const draft = {
    accessKeyId: "",
    bucket: "citeloom",
    credentialSource: "environment",
    directory: "/app/documents/blobs",
    endpointUrl: "http://seaweedfs:8333",
    forcePathStyle: true,
    kind: active.kind,
    prefix: "sources",
    region: "us-east-1",
    secretAccessKey: "",
  };
  if (active.kind === "filesystem") {
    draft.directory = active.directory;
    return draft;
  }
  draft.bucket = active.bucket;
  draft.credentialSource = active.credentialSource;
  draft.endpointUrl = active.endpointUrl;
  draft.forcePathStyle = active.forcePathStyle;
  draft.prefix = active.prefix;
  draft.region = active.region;
  return draft;
}

function storageDraftMatchesActive(draft, active) {
  if (draft === null || draft.kind !== active.kind) {
    return false;
  }
  if (active.kind === "filesystem") {
    return draft.directory.trim() === active.directory.trim();
  }
  if (draft.credentialSource !== active.credentialSource) {
    return false;
  }
  if (
    draft.credentialSource === "static"
    && (draft.accessKeyId.trim() !== "" || draft.secretAccessKey !== "")
  ) {
    return false;
  }
  let endpointUrl;
  try {
    endpointUrl = readHttpEndpoint(draft.endpointUrl);
  } catch {
    return false;
  }
  const activeEndpointUrl = readHttpEndpoint(active.endpointUrl);
  const prefix = draft.prefix.trim().replace(/^\/+|\/+$/gu, "");
  return draft.bucket.trim() === active.bucket
    && endpointUrl === activeEndpointUrl
    && draft.forcePathStyle === active.forcePathStyle
    && prefix === active.prefix
    && draft.region.trim() === active.region;
}

function buildStorageTarget(draft) {
  if (draft === null) {
    throw new Error("Object storage settings are not loaded.");
  }
  if (draft.kind === "filesystem") {
    const directory = draft.directory.trim();
    if (!directory.startsWith("/")) {
      throw new Error("The filesystem directory must be an absolute path.");
    }
    return { directory, kind: "filesystem" };
  }
  const endpointUrl = readHttpEndpoint(draft.endpointUrl);
  const prefix = draft.prefix.trim().replace(/^\/+|\/+$/gu, "");
  if (prefix === "") {
    throw new Error("The object key prefix is required.");
  }
  let credentials;
  if (draft.credentialSource === "environment") {
    credentials = { kind: "environment" };
  } else {
    const accessKeyId = draft.accessKeyId.trim();
    const secretAccessKey = draft.secretAccessKey;
    if (accessKeyId === "" || secretAccessKey === "") {
      throw new Error(
        "Enter both the access key ID and secret access key.",
      );
    }
    credentials = {
      accessKeyId,
      kind: "static",
      secretAccessKey,
    };
  }
  return {
    bucket: requireDraftValue(draft.bucket, "Bucket"),
    credentials,
    endpointUrl,
    forcePathStyle: draft.forcePathStyle === true,
    kind: "s3",
    prefix,
    region: requireDraftValue(draft.region, "Region"),
  };
}

function readHttpEndpoint(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Enter a valid object storage endpoint URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("The object storage endpoint must use HTTP or HTTPS.");
  }
  return url.toString().replace(/\/$/u, "");
}

function requireDraftValue(value, label) {
  const normalized = value.trim();
  if (normalized === "") {
    throw new Error(`${label} is required.`);
  }
  return normalized;
}

function readErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
