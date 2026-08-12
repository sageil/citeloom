import { describe, expect, it } from "vitest";

import {
  buildDocumentNotificationCatalogUrl,
  buildDocumentNotificationStorageKey,
  changeDocumentNotificationSubscription,
  documentNotificationEnabled,
  readDocumentNotificationCatalogStatus,
  readDocumentNotificationChange,
  readDocumentNotificationOutcome,
  readStoredDocumentNotificationSubscriptions,
  writeStoredDocumentNotificationSubscriptions,
} from "../web/assets/scripts/document-notifications.js";
import {
  registerPage as registerDocumentsPage,
} from "../web/assets/scripts/documents.js";

class MemoryStorage {
  private readonly values = new Map<string, string>();

  public getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  public removeItem(key: string): void {
    this.values.delete(key);
  }

  public setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

const subscription = {
  documentId: "document-1",
  filename: "evidence.pdf",
  sourceFile: "/documents/evidence.pdf",
};

describe("document ready notifications", () => {
  it("scopes stored subscriptions to the user and workspace", () => {
    const firstKey = buildDocumentNotificationStorageKey("user-1", "workspace-1");
    const secondKey = buildDocumentNotificationStorageKey("user-2", "workspace-1");

    expect(firstKey).not.toBe(secondKey);
    expect(firstKey).toContain("user-1:workspace-1");
  });

  it("persists and reloads subscriptions for the browser session", () => {
    const storage = new MemoryStorage();
    const key = buildDocumentNotificationStorageKey("user-1", "workspace-1");

    expect(writeStoredDocumentNotificationSubscriptions(
      storage,
      key,
      [subscription],
    )).toBe(true);
    expect(readStoredDocumentNotificationSubscriptions(storage, key)).toEqual([
      subscription,
    ]);

    expect(writeStoredDocumentNotificationSubscriptions(storage, key, [])).toBe(true);
    expect(readStoredDocumentNotificationSubscriptions(storage, key)).toEqual([]);
  });

  it("fails closed when stored subscription data is invalid", () => {
    const storage = new MemoryStorage();
    const key = buildDocumentNotificationStorageKey("user-1", "workspace-1");
    storage.setItem(key, JSON.stringify([{ documentId: "document-1" }]));

    expect(readStoredDocumentNotificationSubscriptions(storage, key)).toEqual([]);
  });

  it("arms, updates, and clears one subscription per source file", () => {
    const armed = changeDocumentNotificationSubscription([], {
      ...subscription,
      enabled: true,
    });
    expect(documentNotificationEnabled(armed, subscription.sourceFile)).toBe(true);

    const updated = changeDocumentNotificationSubscription(armed, {
      ...subscription,
      documentId: "document-2",
      enabled: true,
    });
    expect(updated).toEqual([{ ...subscription, documentId: "document-2" }]);

    const cleared = changeDocumentNotificationSubscription(updated, {
      ...subscription,
      enabled: false,
    });
    expect(cleared).toEqual([]);
  });

  it("validates notification changes at the event boundary", () => {
    expect(readDocumentNotificationChange({
      ...subscription,
      enabled: true,
    })).toEqual({
      ...subscription,
      enabled: true,
    });
    expect(() => readDocumentNotificationChange({
      documentId: subscription.documentId,
      enabled: true,
      sourceFile: subscription.sourceFile,
    })).toThrow("document notification filename");
  });

  it("builds an exact catalog lookup for the watched source file", () => {
    const url = new URL(
      buildDocumentNotificationCatalogUrl(subscription),
      "https://citeloom.test",
    );

    expect(url.pathname).toBe("/api/documents");
    expect(url.searchParams.get("search")).toBe("/documents/evidence.pdf");
    expect(url.searchParams.get("status")).toBe("all");
  });

  it("resolves ready, failed, processing, and removed outcomes", () => {
    const readyCatalog = buildCatalog({
      queryStatus: "ready",
      status: "ready",
    });
    const failedCatalog = buildCatalog({
      queryStatus: "failed",
      status: "failed",
    });
    const processingCatalog = buildCatalog({
      queryStatus: "running",
      status: "running",
    });
    const failedStatus = readDocumentNotificationCatalogStatus(
      failedCatalog,
      subscription.sourceFile,
    );

    expect(readDocumentNotificationOutcome(
      readDocumentNotificationCatalogStatus(
        readyCatalog,
        subscription.sourceFile,
      ),
    )).toBe("ready");
    expect(failedStatus?.errorMessage).toBe("Embedding failed");
    expect(readDocumentNotificationOutcome(failedStatus)).toBe("failed");
    expect(readDocumentNotificationOutcome(
      readDocumentNotificationCatalogStatus(
        processingCatalog,
        subscription.sourceFile,
      ),
    )).toBe("processing");
    expect(readDocumentNotificationOutcome(
      readDocumentNotificationCatalogStatus(
        buildCatalog(null),
        subscription.sourceFile,
      ),
    )).toBe("removed");
  });

  it("tolerates inspector teardown while notification state changes", () => {
    const page = buildDocumentsPageNotificationState();
    page.notificationSourceFiles = [subscription.sourceFile];

    expect(page.documentNotificationAvailable(null)).toBe(false);
    expect(page.documentNotificationEnabled(null)).toBe(false);
    expect(page.documentNotificationLabel(null)).toBe("Notify me when ready");
    expect(() => page.toggleDocumentNotification(null)).not.toThrow();
    expect(() => page.setDocumentNotification(null, false)).not.toThrow();
  });
});

interface DocumentsPageNotificationState {
  notificationSourceFiles: string[];
  documentNotificationAvailable(document: null): boolean;
  documentNotificationEnabled(document: null): boolean;
  documentNotificationLabel(document: null): string;
  setDocumentNotification(document: null, enabled: boolean): void;
  toggleDocumentNotification(document: null): void;
}

function buildDocumentsPageNotificationState(): DocumentsPageNotificationState {
  const registrations = new Map<string, () => unknown>();
  registerDocumentsPage({
    data(name, factory) {
      registrations.set(name, factory);
    },
  });
  const factory = registrations.get("citeloomDocumentsPage");
  if (factory === undefined) {
    throw new Error("The documents page did not register its Alpine component.");
  }
  return factory() as DocumentsPageNotificationState;
}

function buildCatalog(
  state: {
    queryStatus: "failed" | "ready" | "running";
    status: "failed" | "ready" | "running";
  } | null,
): unknown {
  const documents = [];
  if (state !== null) {
    documents.push({
      documentId: subscription.documentId,
      errorMessage: state.status === "failed" ? "Embedding failed" : null,
      queryStatus: state.queryStatus,
      sourceFile: subscription.sourceFile,
      status: state.status,
    });
  }
  return {
    attention: { documents: [], total: 0 },
    documents,
  };
}
