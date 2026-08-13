import { setImmediate } from "node:timers/promises";

import { describe, expect, it } from "vitest";

import { listenForOAuthCallback } from "./callback-server.js";

describe("OAuth callback listener", () => {
  it("closes cleanly before authorization starts", async () => {
    const listener = await listenForOAuthCallback(
      "http://127.0.0.1:0/oauth/callback",
      "expected-state",
      1_000,
    );
    let callbackSettled = false;
    void listener.callback.then(
      () => {
        callbackSettled = true;
      },
      () => {
        callbackSettled = true;
      },
    );

    await listener.close();
    await setImmediate();

    expect(callbackSettled).toBe(false);
  });
});
