import { createServer, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";

export interface OAuthCallbackListener {
  callback: Promise<URLSearchParams>;
  close(): Promise<void>;
}

export async function listenForOAuthCallback(
  callbackUrlValue: string,
  expectedState: string,
  timeoutMs: number,
): Promise<OAuthCallbackListener> {
  const callbackUrl = new URL(callbackUrlValue);
  let resolveCallback: (parameters: URLSearchParams) => void;
  let rejectCallback: (error: Error) => void;
  const callback = new Promise<URLSearchParams>((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });
  let settled = false;
  const server = createServer((request, response) => {
    if (request.method !== "GET" || request.url === undefined) {
      sendText(response, 405, "Method not allowed.");
      return;
    }
    const requestUrl = new URL(request.url, callbackUrl.origin);
    if (requestUrl.pathname !== callbackUrl.pathname) {
      sendText(response, 404, "Not found.");
      return;
    }
    if (
      requestUrl.searchParams.get("error") !== null
      || requestUrl.searchParams.get("code") === null
      || !oauthStatesMatch(requestUrl.searchParams.get("state"), expectedState)
    ) {
      sendText(response, 400, "OAuth authorization failed.");
      fail(new Error("The OAuth callback was rejected."));
      return;
    }
    sendHtml(
      response,
      200,
      "<h1>CiteLoom MCP authorization complete</h1><p>You can close this window and return to the terminal.</p>",
    );
    succeed(requestUrl.searchParams);
  });
  const timeout = setTimeout(() => {
    fail(new Error("Timed out waiting for the OAuth callback."));
  }, timeoutMs);
  timeout.unref();

  function succeed(parameters: URLSearchParams): void {
    if (settled) {
      return;
    }
    settled = true;
    clearTimeout(timeout);
    resolveCallback(parameters);
  }

  function fail(error: Error): void {
    if (settled) {
      return;
    }
    settled = true;
    clearTimeout(timeout);
    rejectCallback(error);
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(Number(callbackUrl.port), callbackUrl.hostname, () => {
      server.off("error", reject);
      resolve();
    });
  });

  return {
    callback,
    close: async () => {
      clearTimeout(timeout);
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) {
            resolve();
            return;
          }
          reject(error);
        });
      });
    },
  };
}

function oauthStatesMatch(received: string | null, expected: string): boolean {
  if (received === null) {
    return false;
  }
  const receivedBytes = Buffer.from(received);
  const expectedBytes = Buffer.from(expected);
  return receivedBytes.length === expectedBytes.length
    && timingSafeEqual(receivedBytes, expectedBytes);
}

function sendText(response: ServerResponse, statusCode: number, text: string): void {
  response.writeHead(statusCode, { "content-type": "text/plain; charset=utf-8" });
  response.end(text);
}

function sendHtml(response: ServerResponse, statusCode: number, body: string): void {
  response.writeHead(statusCode, {
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
    "content-type": "text/html; charset=utf-8",
  });
  response.end(`<!doctype html><html><body>${body}</body></html>`);
}
