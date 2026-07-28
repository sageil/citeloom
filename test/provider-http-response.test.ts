import { describe, expect, it } from "vitest";

import {
  readBoundedJsonResponse,
  readBoundedResponseText,
} from "../src/providers/http-response.js";

describe("bounded provider responses", () => {
  it("reads responses within the configured byte limit", async () => {
    const response = new Response(JSON.stringify({ status: "ok" }));

    await expect(readBoundedJsonResponse(response, 1_024)).resolves.toEqual({
      status: "ok",
    });
  });

  it("cancels responses that exceed the configured byte limit", async () => {
    const response = new Response("x".repeat(100));

    await expect(readBoundedResponseText(response, 10)).rejects.toThrow(
      "Provider response exceeded 10 bytes",
    );
  });
});
