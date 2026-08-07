import type { Agent } from "undici";
import { fetch } from "undici";

export async function authenticateApplicationProbe(
  dispatcher: Agent,
  origin: string,
  username: string,
  password: string,
): Promise<string> {
  const response = await fetch(`${origin}/api/auth/login`, {
    body: JSON.stringify({ password, remember: false, username }),
    dispatcher,
    headers: {
      "Content-Type": "application/json",
      Origin: origin,
    },
    method: "POST",
  });
  await requireSuccessfulApplicationResponse(response, "Authentication");
  const cookie = response.headers.getSetCookie()[0];
  if (cookie === undefined) {
    throw new Error("Authentication response did not set a session cookie.");
  }
  const separatorIndex = cookie.indexOf(";");
  return separatorIndex < 0 ? cookie : cookie.slice(0, separatorIndex);
}

export function buildApplicationProbeHeaders(
  origin: string,
  sessionCookie: string,
): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Cookie: sessionCookie,
    Origin: origin,
  };
}

export async function requireSuccessfulApplicationResponse(
  response: Response,
  operation: string,
): Promise<void> {
  if (response.ok) {
    return;
  }
  const body = await response.text();
  throw new Error(`${operation} failed with HTTP ${response.status}: ${body}`);
}
