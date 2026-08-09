export interface DocumentNotificationSubscription {
  documentId: string;
  filename: string;
  sourceFile: string;
}

export interface DocumentNotificationChange
  extends DocumentNotificationSubscription {
  enabled: boolean;
}

export interface DocumentNotificationCatalogStatus {
  documentId: string;
  errorMessage: string | null;
  queryStatus: "failed" | "pending" | "ready" | "reindex-required" | "running";
  sourceFile: string;
  status: "failed" | "pending" | "ready" | "running";
}

export interface DocumentNotificationStorage {
  getItem(key: string): string | null;
  removeItem(key: string): void;
  setItem(key: string, value: string): void;
}

export type BrowserNotificationPermission =
  | "default"
  | "denied"
  | "granted"
  | "unsupported";

export const DOCUMENT_NOTIFICATION_CHANGE_EVENT: string;
export const DOCUMENT_NOTIFICATION_REQUEST_EVENT: string;
export const DOCUMENT_NOTIFICATION_STATE_EVENT: string;

export function buildDocumentNotificationCatalogUrl(
  subscription: DocumentNotificationSubscription,
): string;
export function buildDocumentNotificationStorageKey(
  userId: string,
  workspaceId: string,
): string;
export function changeDocumentNotificationSubscription(
  subscriptions: DocumentNotificationSubscription[],
  change: DocumentNotificationChange,
): DocumentNotificationSubscription[];
export function documentNotificationEnabled(
  subscriptions: DocumentNotificationSubscription[],
  sourceFile: string,
): boolean;
export function readBrowserNotificationPermission(): BrowserNotificationPermission;
export function readDocumentNotificationCatalogStatus(
  value: unknown,
  sourceFile: string,
): DocumentNotificationCatalogStatus | null;
export function readDocumentNotificationChange(
  value: unknown,
): DocumentNotificationChange;
export function readDocumentNotificationOutcome(
  document: DocumentNotificationCatalogStatus | null,
): "failed" | "processing" | "ready" | "removed";
export function readDocumentNotificationRequest(
  value: unknown,
): { sourceFile: string };
export function readDocumentNotificationState(
  value: unknown,
): { enabled: boolean; sourceFile: string };
export function readDocumentNotificationSubscriptions(
  value: unknown,
): DocumentNotificationSubscription[];
export function readStoredDocumentNotificationSubscriptions(
  storage: DocumentNotificationStorage,
  storageKey: string,
): DocumentNotificationSubscription[];
export function requestBrowserNotificationPermission(): Promise<BrowserNotificationPermission>;
export function showBrowserNotification(
  title: string,
  options?: NotificationOptions,
): Notification | null;
export function writeStoredDocumentNotificationSubscriptions(
  storage: DocumentNotificationStorage,
  storageKey: string,
  subscriptions: DocumentNotificationSubscription[],
): boolean;
