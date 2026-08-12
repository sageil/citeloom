import { afterEach, describe, expect, it, vi } from "vitest";

import {
  activateSystemHealthDashboard,
  deactivateSystemHealthDashboard,
  readSystemHealthDashboard,
} from "../web/assets/scripts/dashboard-extensions.js";
import { buildPdfViewerUrl } from "../web/assets/scripts/file-links.js";
import { focusTextArea } from "../web/assets/scripts/focus.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("CiteLoom UI utilities", () => {
  it("adds the first cited page to a PDF viewer URL", () => {
    expect(buildPdfViewerUrl("/documents/file.pdf", [4, 8])).toBe(
      "/documents/file.pdf#page=4",
    );
    expect(buildPdfViewerUrl("/documents/file.pdf", [])).toBe(
      "/documents/file.pdf",
    );
  });

  it("focuses an enabled text area and places the cursor at the end", () => {
    class TestTextArea {
      disabled = false;
      focus = vi.fn();
      setSelectionRange = vi.fn();
      value = "Question";
    }
    vi.stubGlobal("HTMLTextAreaElement", TestTextArea);
    const textArea = new TestTextArea();

    focusTextArea(textArea);

    expect(textArea.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(textArea.setSelectionRange).toHaveBeenCalledWith(8, 8);
  });

  it("does not focus disabled or unrelated elements", () => {
    class TestTextArea {
      disabled = true;
      focus = vi.fn();
      setSelectionRange = vi.fn();
      value = "Question";
    }
    vi.stubGlobal("HTMLTextAreaElement", TestTextArea);
    const textArea = new TestTextArea();

    focusTextArea(textArea);
    focusTextArea({});

    expect(textArea.focus).not.toHaveBeenCalled();
    expect(textArea.setSelectionRange).not.toHaveBeenCalled();
  });

  it("activates and deactivates only the current health dashboard reader", () => {
    const firstReader = vi.fn(() => ({ state: "ready" }));
    const secondReader = vi.fn(() => ({ state: "degraded" }));

    expect(readSystemHealthDashboard({}, {}, {})).toBeNull();
    activateSystemHealthDashboard(firstReader);
    expect(readSystemHealthDashboard("dashboard", "system", "queue")).toEqual({
      state: "ready",
    });
    expect(firstReader).toHaveBeenCalledWith("dashboard", "system", "queue");
    deactivateSystemHealthDashboard(secondReader);
    expect(readSystemHealthDashboard({}, {}, {})).toEqual({ state: "ready" });
    deactivateSystemHealthDashboard(firstReader);
    expect(readSystemHealthDashboard({}, {}, {})).toBeNull();
  });
});
