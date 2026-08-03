import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import {
  CONFIRMATION_REQUEST_EVENT,
  dispatchConfirmationResponse,
} from "../web/assets/scripts/citeloom-confirmation.js";
import { registerPage } from "../web/assets/scripts/citeloom-settings.js";

describe("CiteLoom settings resets", () => {
  it("cancels the global reset without submitting changes", async () => {
    await withConfirmation(false, async ({ confirmations }) => {
      const page = createSettingsPage();
      page.settings = {
        fields: [{ key: "retrievalCandidates" }, { key: "topK" }],
      };
      page.submitSettingsUpdate = vi.fn(async () => true);

      await page.resetAll();

      expect(confirmations).toEqual([
        expect.objectContaining({
          confirmLabel: "Reset all settings",
          title: "Reset all settings?",
        }),
      ]);
      expect(page.submitSettingsUpdate).not.toHaveBeenCalled();
    });
  });

  it("confirms and submits the global reset for every setting", async () => {
    await withConfirmation(true, async ({ confirmations }) => {
      const page = createSettingsPage();
      page.settings = {
        fields: [{ key: "retrievalCandidates" }, { key: "topK" }],
      };
      page.submitSettingsUpdate = vi.fn(async () => true);

      await page.resetAll();

      expect(confirmations).toEqual([
        expect.objectContaining({ title: "Reset all settings?" }),
      ]);
      expect(page.submitSettingsUpdate).toHaveBeenCalledWith([
        { action: "reset", key: "retrievalCandidates" },
        { action: "reset", key: "topK" },
      ], [{ action: "reset" }]);
    });
  });

  it("confirms and stages only one field reset", async () => {
    await withConfirmation(true, async ({ confirmations }) => {
      const page = createSettingsPage();
      const field = {
        defaultValue: 50,
        input: "number",
        key: "retrievalCandidates",
        label: "Matching sections reviewed",
        sensitive: false,
      };
      page.drafts = { retrievalCandidates: "75", topK: "10" };
      page.pending = { topK: "set" };

      await page.resetField(field);

      expect(confirmations).toEqual([
        expect.objectContaining({
          title: "Reset Matching sections reviewed?",
        }),
      ]);
      expect(page.drafts).toEqual({
        retrievalCandidates: "50",
        topK: "10",
      });
      expect(page.pending).toEqual({
        retrievalCandidates: "reset",
        topK: "set",
      });
    });
  });

  it("resets only the selected runtime panel and preserves other drafts", async () => {
    await withConfirmation(true, async ({ confirmations }) => {
      const page = createSettingsPage({ reactiveResetState: true });
      const searchFields = [
        {
          group: "Search and answers",
          key: "retrievalCandidates",
          panel: { id: "search-size", label: "Search size" },
        },
        {
          group: "Search and answers",
          key: "topK",
          panel: { id: "search-size", label: "Search size" },
        },
      ];
      const unrelatedField = {
        group: "Usage diagnostics",
        key: "aiMetricsEnabled",
      };
      page.settings = { fields: [...searchFields, unrelatedField] };
      page.groups = [
        { fields: searchFields, name: "Search and answers" },
        { fields: [unrelatedField], name: "Usage diagnostics" },
      ];
      page.selectedArea = "Search and answers";
      page.drafts.aiMetricsEnabled = "false";
      page.pending.aiMetricsEnabled = "set";
      page.submitSettingsUpdate = vi.fn(async () => {
        page.drafts = {};
        page.pending = {};
        return true;
      });

      await page.resetRuntimeContext();

      expect(confirmations).toEqual([
        expect.objectContaining({
          confirmLabel: "Reset Search size",
          title: "Reset Search size?",
        }),
      ]);
      expect(page.submitSettingsUpdate).toHaveBeenCalledWith([
        { action: "reset", key: "retrievalCandidates" },
        { action: "reset", key: "topK" },
      ], []);
      expect(page.pending).toEqual({ aiMetricsEnabled: "set" });
      expect(page.drafts).toEqual({ aiMetricsEnabled: "false" });
    });
  });

  it("submits only the selected feature or provider reset", async () => {
    await withConfirmation(true, async ({ confirmations }) => {
      const page = createSettingsPage({ reactiveResetState: true });
      const chatField = { key: "chatTemperature" };
      page.settings = { fields: [chatField] };
      page.featureFieldsByCapability.chat = [chatField];
      page.selectedFeatureCapability = "chat";
      page.submitSettingsUpdate = vi.fn(async () => true);

      await page.resetSelectedFeature();

      expect(page.submitSettingsUpdate).toHaveBeenLastCalledWith(
        [{ action: "reset", key: "chatTemperature" }],
        [{ action: "reset-feature", capability: "chat" }],
      );

      page.selectedProviderId = "ollama";
      page.providerProfilesById.ollama = { displayName: "Ollama" };
      await page.resetSelectedProvider();

      expect(page.submitSettingsUpdate).toHaveBeenLastCalledWith(
        [],
        [{ action: "reset-provider", providerId: "ollama" }],
      );
      expect(confirmations).toEqual([
        expect.objectContaining({ title: "Reset Chat?" }),
        expect.objectContaining({ title: "Reset Ollama?" }),
      ]);
    });
  });

  it("binds each editor reset to its scoped handler", async () => {
    const fragment = await readFile(
      new URL("../web/fragments/settings.html", import.meta.url),
      "utf8",
    );

    expect(fragment.match(/@click="resetAll\(\)"/g)).toHaveLength(1);
    expect(fragment).toContain('@click="resetSelectedFeature()"');
    expect(fragment).toContain('@click="resetSelectedProvider()"');
    expect(fragment).toContain('@click="resetRuntimeContext()"');
  });
});

function createSettingsPage({ reactiveResetState = false } = {}) {
  let pageFactory = null;
  const rawValues = new WeakMap();
  registerPage({
    data(name, factory) {
      expect(name).toBe("citeloomSettingsPage");
      pageFactory = factory;
    },
    raw(value) {
      return rawValues.get(value) ?? value;
    },
  });
  const page = pageFactory();
  if (!reactiveResetState) {
    return page;
  }
  page.credentialDrafts = createReactiveProxy(
    page.credentialDrafts,
    rawValues,
  );
  page.drafts = createReactiveProxy(page.drafts, rawValues);
  page.pending = createReactiveProxy(page.pending, rawValues);
  return page;
}

function createReactiveProxy(value, rawValues) {
  const proxy = new Proxy(value, {});
  rawValues.set(proxy, value);
  return proxy;
}

async function withConfirmation(confirmed, operation) {
  const originalWindow = globalThis.window;
  const browserWindow = new EventTarget();
  const confirmations = [];
  globalThis.window = browserWindow;
  browserWindow.addEventListener(CONFIRMATION_REQUEST_EVENT, (event) => {
    confirmations.push(event.detail);
    dispatchConfirmationResponse(event.detail.requestId, confirmed);
  });
  try {
    await operation({ confirmations });
  } finally {
    if (originalWindow === undefined) {
      delete globalThis.window;
    } else {
      globalThis.window = originalWindow;
    }
  }
}
