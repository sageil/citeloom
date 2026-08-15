import { describe, expect, it } from "vitest";

import { readPemCertificates } from "./tls-trust.js";

describe("MCP client TLS trust boundary", () => {
  it("rejects a CA file without PEM certificates", () => {
    expect(() => readPemCertificates("not a certificate", "ca.crt")).toThrow(
      "The CA file ca.crt contains no PEM certificates.",
    );
  });

  it("rejects a malformed PEM certificate", () => {
    expect(() => readPemCertificates(
      "-----BEGIN CERTIFICATE-----\ninvalid\n-----END CERTIFICATE-----",
      "ca.crt",
    )).toThrow("The CA file ca.crt contains an invalid certificate.");
  });
});
