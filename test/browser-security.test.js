import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("browser security policy", () => {
  it("uses local browser dependencies and disables htmx evaluation", async () => {
    const index = await readFile(
      new URL("../web/index.html", import.meta.url),
      "utf8",
    );

    expect(index).not.toContain("cdn.jsdelivr.net");
    expect(index).toContain("./assets/vendor/alpine.min.js");
    expect(index).toContain("./assets/vendor/htmx.min.js");
    expect(index).toContain('"allowEval":false');
    expect(index).toContain('"allowScriptTags":false');
  });
});
