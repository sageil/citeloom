import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  readHtmlAttribute,
  readHtmlElements,
} from "./html-test-helpers.js";

describe("browser security policy", () => {
  it("declares local browser dependencies and restrictive htmx settings", async () => {
    const index = await readFile(
      new URL("../web/index.html", import.meta.url),
      "utf8",
    );
    const elements = readHtmlElements(index);
    const scriptSources = [];
    let htmxConfig = null;
    for (const element of elements) {
      if (element.tagName === "script") {
        const source = readHtmlAttribute(element, "src");
        if (source !== null) {
          scriptSources.push(source);
        }
      }
      if (
        element.tagName === "meta"
        && readHtmlAttribute(element, "name") === "htmx-config"
      ) {
        htmxConfig = JSON.parse(readHtmlAttribute(element, "content"));
      }
    }

    expect(scriptSources).toContain("./assets/vendor/alpine.min.js");
    expect(scriptSources).toContain("./assets/vendor/htmx.min.js");
    expect(scriptSources.some((source) => source.startsWith("http"))).toBe(false);
    expect(htmxConfig).toMatchObject({
      allowEval: false,
      allowScriptTags: false,
    });
  });
});
