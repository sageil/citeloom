import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createEvidenceWindowControls,
  createEvidenceWindowState,
  findEvidenceCitationTrigger,
  positionEvidenceWindow,
  prepareEvidenceWindow,
  revealEvidenceCitationTrigger,
  waitForEvidenceWindowLayout,
} from "../web/assets/scripts/citeloom-evidence-window.js";

class FakeHtmlElement {
  constructor(bounds) {
    this.bounds = bounds;
    this.dataset = {};
    this.isConnected = true;
    this.scrollCalls = [];
    this.scrollTop = 0;
  }

  getBoundingClientRect() {
    return this.bounds;
  }

  scrollTo(options) {
    this.scrollCalls.push(options);
    this.scrollTop = options.top;
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("shared evidence window", () => {
  it("builds the HHEM scale from the selected claim for either route", () => {
    const controls = createEvidenceWindowControls({
      close() {},
      readCitation(page) {
        return page.selectedCitation;
      },
      readClaims(page) {
        return page.claims;
      },
      readError() {
        return "";
      },
      readFileLabel() {
        return "Open source";
      },
      readFileUrl() {
        return "/source";
      },
      readImageUrl() {
        return "";
      },
      readLoading() {
        return false;
      },
      readSelectedCitation(page) {
        return page.selectedCitation;
      },
      readSummary() {
        return "Source";
      },
      readText() {
        return "Evidence";
      },
    });
    const page = {
      ...controls,
      claimVerifierSupportThreshold: 0.7,
      claims: [{
        claimIndex: 3,
        evidenceUnits: [{
          citationNumber: 2,
          supportProbability: 0.9,
        }],
      }],
      selectedCitation: { citationNumber: 2 },
    };
    page.selectedEvidenceClaimIndex = 3;

    expect(page.selectedEvidenceScoreScale()).toMatchObject({
      ariaLabel: "HHEM claim score 0.900. Global support threshold 0.700.",
      markers: [{ label: "0.900", status: "supported" }],
      thresholdLabel: "0.700",
    });
  });

  it("selects a rendered citation trigger instead of a hidden match", () => {
    vi.stubGlobal("HTMLElement", FakeHtmlElement);
    const hidden = new FakeHtmlElement({
      bottom: 0,
      height: 0,
      left: 0,
      top: 0,
      width: 0,
    });
    hidden.dataset.evidenceCitationId = "citation-1";
    const visible = new FakeHtmlElement({
      bottom: 722,
      height: 22,
      left: 500,
      top: 700,
      width: 24,
    });
    visible.dataset.evidenceCitationId = "citation-1";
    const root = {
      querySelectorAll() {
        return [hidden, visible];
      },
    };

    const result = findEvidenceCitationTrigger(
      root,
      "citation-1",
      null,
      900,
    );
    expect(result === visible).toBe(true);
  });

  it("does not retain a zero height measured before scrolling settles", () => {
    vi.stubGlobal("HTMLElement", FakeHtmlElement);
    const state = createEvidenceWindowState();
    const trigger = new FakeHtmlElement({
      bottom: -178,
      height: 22,
      left: 500,
      top: -200,
      width: 24,
    });
    const panel = new FakeHtmlElement({
      bottom: 520,
      height: 520,
      left: 0,
      top: 0,
      width: 760,
    });
    prepareEvidenceWindow(state, trigger);

    positionEvidenceWindow(state, panel, { height: 900, width: 1440 });
    trigger.bounds = {
      bottom: 722,
      height: 22,
      left: 500,
      top: 700,
      width: 24,
    };
    positionEvidenceWindow(state, panel, { height: 900, width: 1440 });

    expect(state.position.maxHeight).toBe(520);
    expect(state.position.top).toBe(170);
  });

  it("does not retain a zero size measured before the panel is rendered", () => {
    vi.stubGlobal("HTMLElement", FakeHtmlElement);
    const state = createEvidenceWindowState();
    const trigger = new FakeHtmlElement({
      bottom: 722,
      height: 22,
      left: 500,
      top: 700,
      width: 24,
    });
    const panel = new FakeHtmlElement({
      bottom: 0,
      height: 0,
      left: 0,
      top: 0,
      width: 0,
    });
    prepareEvidenceWindow(state, trigger);

    positionEvidenceWindow(state, panel, { height: 900, width: 1440 });
    panel.bounds = {
      bottom: 520,
      height: 520,
      left: 0,
      top: 0,
      width: 760,
    };
    positionEvidenceWindow(state, panel, { height: 900, width: 1440 });

    expect(state.position.maxHeight).toBe(520);
    expect(state.position.width).toBe(760);
  });

  it("waits for the first rendered panel layout", async () => {
    vi.stubGlobal("HTMLElement", FakeHtmlElement);
    const panel = new FakeHtmlElement({
      bottom: 0,
      height: 0,
      left: 0,
      top: 0,
      width: 0,
    });
    let frameCount = 0;
    vi.stubGlobal("requestAnimationFrame", (callback) => {
      frameCount += 1;
      panel.bounds = {
        bottom: 520,
        height: 520,
        left: 0,
        top: 0,
        width: 760,
      };
      callback(frameCount);
      return frameCount;
    });

    await expect(waitForEvidenceWindowLayout(panel)).resolves.toBe(true);
    expect(frameCount).toBe(1);
  });

  it("reveals a citation instantly inside a smooth scroll container", () => {
    vi.stubGlobal("HTMLElement", FakeHtmlElement);
    const trigger = new FakeHtmlElement({
      bottom: 100,
      height: 22,
      left: 500,
      top: 78,
      width: 24,
    });
    const container = new FakeHtmlElement({
      bottom: 800,
      height: 760,
      left: 0,
      top: 40,
      width: 1200,
    });
    container.scrollTop = 1000;

    revealEvidenceCitationTrigger(trigger, container);

    expect(container.scrollCalls).toEqual([{
      behavior: "instant",
      top: 316,
    }]);
  });
});
