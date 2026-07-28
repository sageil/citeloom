import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("CiteLoom bootstrap routing", () => {
  it("requests the login fragment on the login route", async () => {
    const workspace = stubBrowserLocation("/login", "");
    await import("../web/assets/scripts/citeloom-bootstrap.js?test=login");
    expect(workspace.attributes.get("hx-get")).toBe("./fragments/login.html");
  });

  it("requests the overview fragment on the root route", async () => {
    const workspace = stubBrowserLocation("/", "");
    await import("../web/assets/scripts/citeloom-bootstrap.js?test=overview");
    expect(workspace.attributes.get("hx-get")).toBe("./fragments/overview.html");
  });

  it("honors a supported query-string route", async () => {
    const workspace = stubBrowserLocation("/", "?view=documents");
    await import("../web/assets/scripts/citeloom-bootstrap.js?test=documents");
    expect(workspace.attributes.get("hx-get")).toBe("./fragments/documents.html");
  });

  it("requests the error report fragment on the administrator route", async () => {
    const workspace = stubBrowserLocation("/errors", "");
    await import("../web/assets/scripts/citeloom-bootstrap.js?test=errors");
    expect(workspace.attributes.get("hx-get")).toBe("./fragments/errors.html");
  });
});

function stubBrowserLocation(pathname, search) {
  class TestHTMLElement {
    attributes = new Map();

    setAttribute(name, value) {
      this.attributes.set(name, value);
    }
  }

  const workspace = new TestHTMLElement();
  vi.stubGlobal("HTMLElement", TestHTMLElement);
  vi.stubGlobal("document", {
    addEventListener: vi.fn(),
    getElementById: vi.fn((id) => id === "workspace" ? workspace : null),
  });
  vi.stubGlobal("window", {
    addEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
    location: {
      hash: "",
      pathname,
      search,
    },
  });
  return workspace;
}
