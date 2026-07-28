import { randomUUID } from "node:crypto";

import {
  exchangeOpenAICodexDeviceAuthorization,
  OpenAICodexOAuthError,
  pollOpenAICodexDeviceAuthorization,
  requestOpenAICodexDeviceAuthorization,
  type OpenAICodexDeviceAuthorization,
  type OpenAICodexOAuthCredentials,
  type OpenAICodexOAuthRequestOptions,
} from "./openai-codex-oauth.js";

const REQUEST_TIMEOUT_MS = 30_000;

export type OpenAICodexDeviceFlowState =
  | "cancelled"
  | "connected"
  | "exchanging"
  | "expired"
  | "failed"
  | "pending";

export interface OpenAICodexDeviceFlowStatus {
  error: string | null;
  expiresAt: string;
  flowId: string;
  state: OpenAICodexDeviceFlowState;
  userCode: string;
  verificationUrl: string;
}

export type StartedOpenAICodexDeviceFlow = OpenAICodexDeviceFlowStatus;

export interface OpenAICodexDeviceAuthControllerOptions {
  fetch?: typeof fetch;
  now?: () => Date;
  persistCredentials(
    credentials: OpenAICodexOAuthCredentials,
  ): Promise<void>;
}

interface ActiveOpenAICodexDeviceFlow {
  abortController: AbortController;
  authorization: OpenAICodexDeviceAuthorization;
  error: string | null;
  flowId: string;
  running: Promise<void>;
  state: OpenAICodexDeviceFlowState;
}

export class OpenAICodexDeviceAuthController {
  private closed = false;
  private current: ActiveOpenAICodexDeviceFlow | null = null;
  private mutation: Promise<void> = Promise.resolve();

  public constructor(
    private readonly options: OpenAICodexDeviceAuthControllerOptions,
  ) {}

  public async cancel(): Promise<OpenAICodexDeviceFlowStatus | null> {
    return this.serialize(async () => this.cancelCurrent());
  }

  public async close(): Promise<void> {
    this.closed = true;
    await this.cancel();
  }

  public readStatus(): OpenAICodexDeviceFlowStatus | null {
    return this.current === null ? null : readFlowStatus(this.current);
  }

  public async start(): Promise<StartedOpenAICodexDeviceFlow> {
    return this.serialize(async () => this.startCurrent());
  }

  private async cancelCurrent(): Promise<OpenAICodexDeviceFlowStatus | null> {
    const flow = this.current;
    if (flow === null) {
      return null;
    }
    if (isTerminalState(flow.state)) {
      return readFlowStatus(flow);
    }
    flow.state = "cancelled";
    flow.abortController.abort(
      new Error("OpenAI Codex device sign-in was cancelled."),
    );
    await flow.running;
    return readFlowStatus(flow);
  }

  private async startCurrent(): Promise<StartedOpenAICodexDeviceFlow> {
    if (this.closed) {
      throw new Error("OpenAI Codex device sign-in is unavailable.");
    }
    await this.cancelCurrent();
    const abortController = new AbortController();
    const startSignal = AbortSignal.any([
      abortController.signal,
      AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    ]);
    const authorization = await requestOpenAICodexDeviceAuthorization(
      buildOAuthRequestOptions(this.options, startSignal),
    );
    const flow: ActiveOpenAICodexDeviceFlow = {
      abortController,
      authorization,
      error: null,
      flowId: randomUUID(),
      running: Promise.resolve(),
      state: "pending",
    };
    this.current = flow;
    flow.running = this.run(flow);
    return readFlowStatus(flow);
  }

  private async serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutation.then(operation, operation);
    this.mutation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async run(flow: ActiveOpenAICodexDeviceFlow): Promise<void> {
    try {
      while (readNow(this.options).getTime() < flow.authorization.expiresAt.getTime()) {
        await waitForPollInterval(
          flow.authorization.intervalSeconds,
          flow.abortController.signal,
        );
        const pollSignal = AbortSignal.any([
          flow.abortController.signal,
          AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        ]);
        const poll = await pollOpenAICodexDeviceAuthorization(
          flow.authorization,
          buildOAuthRequestOptions(this.options, pollSignal),
        );
        if (poll.state === "pending") {
          continue;
        }
        flow.state = "exchanging";
        const exchangeSignal = AbortSignal.any([
          flow.abortController.signal,
          AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        ]);
        const credentials = await exchangeOpenAICodexDeviceAuthorization(
          poll.authorization,
          buildOAuthRequestOptions(this.options, exchangeSignal),
        );
        flow.abortController.signal.throwIfAborted();
        await this.options.persistCredentials(credentials);
        flow.state = "connected";
        return;
      }
      flow.state = "expired";
      flow.error = "OpenAI Codex device sign-in expired. Start again.";
    } catch (error: unknown) {
      if (flow.abortController.signal.aborted) {
        if (flow.state !== "cancelled") {
          flow.state = "cancelled";
        }
        return;
      }
      flow.state = "failed";
      flow.error = readDeviceFlowError(error);
    }
  }
}

function readFlowStatus(
  flow: ActiveOpenAICodexDeviceFlow,
): OpenAICodexDeviceFlowStatus {
  return {
    error: flow.error,
    expiresAt: flow.authorization.expiresAt.toISOString(),
    flowId: flow.flowId,
    state: flow.state,
    userCode: flow.authorization.userCode,
    verificationUrl: flow.authorization.verificationUrl,
  };
}

function isTerminalState(state: OpenAICodexDeviceFlowState): boolean {
  return state === "cancelled"
    || state === "connected"
    || state === "expired"
    || state === "failed";
}

function readDeviceFlowError(error: unknown): string {
  if (error instanceof OpenAICodexOAuthError) {
    return error.message;
  }
  return "OpenAI Codex sign-in failed because the authorization service could not be reached.";
}

function readNow(options: OpenAICodexDeviceAuthControllerOptions): Date {
  return options.now?.() ?? new Date();
}

function buildOAuthRequestOptions(
  options: OpenAICodexDeviceAuthControllerOptions,
  signal: AbortSignal,
): OpenAICodexOAuthRequestOptions {
  const requestOptions: OpenAICodexOAuthRequestOptions = { signal };
  if (options.fetch !== undefined) {
    requestOptions.fetch = options.fetch;
  }
  if (options.now !== undefined) {
    requestOptions.now = options.now;
  }
  return requestOptions;
}

async function waitForPollInterval(
  intervalSeconds: number,
  signal: AbortSignal,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const finish = (): void => {
      signal.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(finish, intervalSeconds * 1_000);
    const abort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
  });
}
