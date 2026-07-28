import { describe, expect, it } from "vitest";

import {
  applicationStateRevisionsDiffer,
  decodeApplicationStateRevisionNotification,
} from "../src/app/application-state-revisions.js";
import { formatApplicationStateRevisionEvent } from "../src/web-server.js";

describe("application state revision boundary", () => {
  it("decodes a typed PostgreSQL notification", () => {
    expect(decodeApplicationStateRevisionNotification(
      JSON.stringify({ channel: "catalog", revision: "42" }),
    )).toEqual({ channel: "catalog", revision: "42" });
  });

  it("rejects missing, malformed, and unknown notifications", () => {
    expect(() => decodeApplicationStateRevisionNotification(undefined)).toThrow(
      "payload is missing",
    );
    expect(() => decodeApplicationStateRevisionNotification("{" )).toThrow(
      "not valid JSON",
    );
    expect(() => decodeApplicationStateRevisionNotification(JSON.stringify({
      channel: "unknown",
      revision: "1",
    }))).toThrow("payload is invalid");
    expect(() => decodeApplicationStateRevisionNotification(JSON.stringify({
      channel: "jobs",
      revision: 1,
    }))).toThrow("payload is invalid");
  });

  it("compares complete snapshots and formats deterministic SSE events", () => {
    const revisions = { catalog: "2", jobs: "5", settings: "1" };
    expect(applicationStateRevisionsDiffer(revisions, revisions)).toBe(false);
    expect(applicationStateRevisionsDiffer(revisions, {
      catalog: "2",
      jobs: "6",
      settings: "1",
    })).toBe(true);
    expect(formatApplicationStateRevisionEvent(revisions)).toBe(
      "id: 2.5.1\nevent: revision\ndata: {\"catalog\":\"2\",\"jobs\":\"5\",\"settings\":\"1\"}\n\n",
    );
  });
});
