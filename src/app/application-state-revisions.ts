import { asc } from "drizzle-orm";
import { Client, type Notification } from "pg";
import { z } from "zod";

import type { DatabaseConfig } from "../config/index.js";
import type { CiteLoomDatabase } from "../database/client.js";
import { applicationRevisions } from "../database/schema.js";

export const APPLICATION_STATE_REVISION_CHANNELS = [
  "catalog",
  "jobs",
  "settings",
] as const;

const stateRevisionChannelSchema = z.enum(APPLICATION_STATE_REVISION_CHANNELS);
const stateRevisionStringSchema = z.string().regex(/^(0|[1-9][0-9]*)$/);
const stateRevisionNotificationSchema = z.object({
  channel: stateRevisionChannelSchema,
  revision: stateRevisionStringSchema,
});
const stateRevisionRowSchema = z.object({
  channel: stateRevisionChannelSchema,
  revision: z.bigint().nonnegative(),
});

export type ApplicationStateRevisionChannel = z.output<
  typeof stateRevisionChannelSchema
>;

export interface ApplicationStateRevisionSignal {
  channel: ApplicationStateRevisionChannel;
  revision: string;
}

export interface ApplicationStateRevisionSnapshot {
  catalog: string;
  jobs: string;
  settings: string;
}

export type ApplicationStateRevisionSubscriber = (
  signal: ApplicationStateRevisionSignal,
) => void;

export interface ApplicationStateRevisionSource {
  close(): Promise<void>;
  subscribe(subscriber: ApplicationStateRevisionSubscriber): () => void;
  waitForSignal(timeoutMs: number, abortSignal?: AbortSignal): Promise<void>;
}

const NOTIFICATION_CHANNEL = "citeloom_revisions";
const RECONNECT_DELAY_MS = 1_000;

export async function readApplicationStateRevisions(
  database: CiteLoomDatabase,
): Promise<ApplicationStateRevisionSnapshot> {
  const rows = await database
    .select({
      channel: applicationRevisions.channel,
      revision: applicationRevisions.revision,
    })
    .from(applicationRevisions)
    .orderBy(asc(applicationRevisions.channel));
  const revisions = new Map<ApplicationStateRevisionChannel, string>();
  for (const row of rows) {
    const decoded = decodeApplicationStateRevisionRow(row);
    if (revisions.has(decoded.channel)) {
      throw new Error(
        `Duplicate application state revision row: ${decoded.channel}.`,
      );
    }
    revisions.set(decoded.channel, decoded.revision.toString());
  }
  return {
    catalog: readRequiredStateRevision(revisions, "catalog"),
    jobs: readRequiredStateRevision(revisions, "jobs"),
    settings: readRequiredStateRevision(revisions, "settings"),
  };
}

export function decodeApplicationStateRevisionNotification(
  payload: string | undefined,
): ApplicationStateRevisionSignal {
  if (payload === undefined) {
    throw new Error(
      "Application state revision notification payload is missing.",
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    throw new Error(
      "Application state revision notification payload is not valid JSON.",
    );
  }
  const result = stateRevisionNotificationSchema.safeParse(value);
  if (!result.success) {
    throw new Error(
      `Application state revision notification payload is invalid: ${result.error.message}`,
    );
  }
  return result.data;
}

export function applicationStateRevisionsDiffer(
  previous: ApplicationStateRevisionSnapshot,
  next: ApplicationStateRevisionSnapshot,
): boolean {
  return previous.catalog !== next.catalog
    || previous.jobs !== next.jobs
    || previous.settings !== next.settings;
}

export class PostgresApplicationStateRevisionSource implements ApplicationStateRevisionSource {
  private client: Client | null = null;
  private closed = false;
  private connectPromise: Promise<void> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly subscribers = new Set<ApplicationStateRevisionSubscriber>();

  private constructor(
    private readonly config: DatabaseConfig,
    private readonly reportError: (message: string) => void,
  ) {}

  public static async open(
    config: DatabaseConfig,
    reportError: (message: string) => void = console.error,
  ): Promise<PostgresApplicationStateRevisionSource> {
    const source = new PostgresApplicationStateRevisionSource(
      config,
      reportError,
    );
    await source.connect();
    return source;
  }

  public async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const client = this.client;
    this.client = null;
    if (client !== null) {
      await client.end();
    }
    await this.connectPromise;
    this.subscribers.clear();
  }

  public subscribe(subscriber: ApplicationStateRevisionSubscriber): () => void {
    if (this.closed) {
      throw new Error("Application state revision source is closed.");
    }
    this.subscribers.add(subscriber);
    return (): void => {
      this.subscribers.delete(subscriber);
    };
  }

  public waitForSignal(
    timeoutMs: number,
    abortSignal?: AbortSignal,
  ): Promise<void> {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
      throw new Error("Revision signal timeout must be a positive integer.");
    }
    if (abortSignal?.aborted === true) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      let completed = false;
      const complete = (): void => {
        if (completed) {
          return;
        }
        completed = true;
        clearTimeout(timeout);
        unsubscribe();
        abortSignal?.removeEventListener("abort", complete);
        resolve();
      };
      const unsubscribe = this.subscribe(complete);
      const timeout = setTimeout(complete, timeoutMs);
      timeout.unref();
      abortSignal?.addEventListener("abort", complete, { once: true });
    });
  }

  private connect(): Promise<void> {
    if (this.connectPromise !== null) {
      return this.connectPromise;
    }
    const current = this.connectClient();
    this.connectPromise = current;
    const clearConnectPromise = (): void => {
      if (this.connectPromise === current) {
        this.connectPromise = null;
      }
    };
    void current.then(clearConnectPromise, clearConnectPromise);
    return current;
  }

  private async connectClient(): Promise<void> {
    if (this.closed || this.client !== null) {
      return;
    }
    const client = new Client({
      application_name: "citeloom-revision-listener",
      connectionString: this.config.url,
    });
    client.on("error", (error: Error) => {
      this.handleDisconnect(client, error);
    });
    client.on("end", () => {
      this.handleDisconnect(client);
    });
    client.on("notification", (notification: Notification) => {
      this.handleNotification(notification);
    });
    try {
      await client.connect();
      await client.query(`LISTEN ${NOTIFICATION_CHANNEL}`);
      if (this.closed) {
        await client.end();
        return;
      }
      this.client = client;
    } catch (error: unknown) {
      await client.end().catch(() => undefined);
      throw error;
    }
  }

  private handleDisconnect(client: Client, error?: Error): void {
    if (this.client !== client) {
      return;
    }
    this.client = null;
    if (error !== undefined) {
      this.reportError(
        `Application state revision listener disconnected: ${error.message}`,
      );
    }
    this.scheduleReconnect();
  }

  private handleNotification(notification: Notification): void {
    if (notification.channel !== NOTIFICATION_CHANNEL) {
      return;
    }
    let signal: ApplicationStateRevisionSignal;
    try {
      signal = decodeApplicationStateRevisionNotification(
        notification.payload,
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.reportError(message);
      return;
    }
    for (const subscriber of this.subscribers) {
      subscriber(signal);
    }
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer !== null) {
      return;
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect().catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.reportError(
          `Application state revision listener reconnect failed: ${message}`,
        );
        this.scheduleReconnect();
      });
    }, RECONNECT_DELAY_MS);
    this.reconnectTimer.unref();
  }
}

function decodeApplicationStateRevisionRow(row: unknown): {
  channel: ApplicationStateRevisionChannel;
  revision: bigint;
} {
  const result = stateRevisionRowSchema.safeParse(row);
  if (!result.success) {
    throw new Error(
      `Application state revision row is invalid: ${result.error.message}`,
    );
  }
  return result.data;
}

function readRequiredStateRevision(
  revisions: ReadonlyMap<ApplicationStateRevisionChannel, string>,
  channel: ApplicationStateRevisionChannel,
): string {
  const revision = revisions.get(channel);
  if (revision === undefined) {
    throw new Error(`Application state revision row is missing: ${channel}.`);
  }
  return revision;
}
