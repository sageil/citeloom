import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createStructuredOutput } from "../src/inference/structured-output.js";

describe("structured output provider compatibility", () => {
  it("rejects tuple schemas before sending them to a provider", () => {
    expect(() => createStructuredOutput({
      description: "An invalid tuple response.",
      name: "invalid_tuple",
      schema: z.object({
        values: z.tuple([]),
      }).strict(),
      validation: "provider-only",
    })).toThrow(
      "Structured output invalid_tuple uses unsupported prefixItems at $.properties.values.prefixItems.",
    );
  });
});
