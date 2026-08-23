import { readFile } from "node:fs/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CONFIRMATION_REQUEST_EVENT,
  dispatchConfirmationResponse,
} from "../web/assets/scripts/confirmation.js";
import { registerPage } from "../web/assets/scripts/settings.js";
import {
  readSourceContentStorageResponse,
} from "../web/assets/scripts/source-content-storage.js";
import {
  findHtmlElementByAttribute,
  htmlElementHasClass,
  readHtmlAttribute,
  readHtmlDocumentText,
  readHtmlElements,
} from "./html-test-helpers.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

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
      page.featureDefinitionsByCapability.chat = { label: "Chat" };
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

  it("declares one reset control for each settings scope", async () => {
    const fragment = await readFile(
      new URL("../web/fragments/settings.html", import.meta.url),
      "utf8",
    );
    const elements = readHtmlElements(fragment);
    const resetHandlers = elements
      .map((element) => readHtmlAttribute(element, "@click"))
      .filter((handler) => handler?.startsWith("reset") === true);

    expect(resetHandlers.filter((handler) => handler === "resetAll()"))
      .toHaveLength(1);
    expect(resetHandlers).toEqual(expect.arrayContaining([
      "resetSelectedFeature()",
      "resetSelectedProvider()",
      "resetRuntimeContext()",
    ]));
  });
});

describe("CiteLoom settings scope selection", () => {
  it("declares the selector for the applied settings target", async () => {
    const fragment = await readFile(
      new URL("../web/fragments/settings.html", import.meta.url),
      "utf8",
    );
    const elements = readHtmlElements(fragment);
    const selector = findHtmlElementByAttribute(
      elements,
      "@change",
      "changeSettingsTargetFromControl($event.target)",
    );
    const optionTemplate = findHtmlElementByAttribute(
      elements,
      ":key",
      "scope.id",
    );
    const option = findHtmlElementByAttribute(elements, ":value", "scope.id");

    expect(selector.tagName).toBe("select");
    expect(readHtmlAttribute(selector, ":value")).toBe("settings?.scope.id ?? ''");
    expect(readHtmlAttribute(selector, "x-model")).toBeNull();
    expect(optionTemplate.tagName).toBe("template");
    expect(option.tagName).toBe("option");
    expect(readHtmlAttribute(option, ":value")).toBe("scope.id");
  });

  it("declares one workspace editor for details and membership", async () => {
    const fragment = await readFile(
      new URL("../web/fragments/settings.html", import.meta.url),
      "utf8",
    );
    const elements = readHtmlElements(fragment);
    const visibleText = readHtmlDocumentText(elements);
    const editor = elements.filter((element) => {
      return htmlElementHasClass(element, "workspace-user-management");
    });

    expect(findHtmlElementByAttribute(
      elements,
      "@click",
      "selectArea('Workspaces')",
    ).tagName).toBe("button");
    expect(findHtmlElementByAttribute(
      elements,
      "@click",
      "selectArea('Workspace')",
    ).tagName).toBe("button");
    expect(findHtmlElementByAttribute(
      elements,
      "@submit.prevent",
      "saveWorkspaceName()",
    ).tagName).toBe("form");
    expect(findHtmlElementByAttribute(
      elements,
      "x-if",
      "selectedArea === 'Workspace'",
    ).tagName).toBe("template");
    expect(visibleText).toContain("Create workspace");
    expect(editor).toHaveLength(1);
  });

  it("loads only organization resources for the organization target", async () => {
    const page = createSettingsPage();
    page.settings = buildSettingsScopeFixture("organization");
    page.loadOpenAICodexAuth = vi.fn(async () => undefined);
    page.loadSourceContentStorage = vi.fn(async () => undefined);
    page.loadSourceLibraryAdministration = vi.fn(async () => undefined);
    page.loadUsers = vi.fn(async () => undefined);

    await page.loadScopeResources();

    expect(page.loadOpenAICodexAuth).toHaveBeenCalledOnce();
    expect(page.loadSourceContentStorage).toHaveBeenCalledOnce();
    expect(page.loadSourceLibraryAdministration).toHaveBeenCalledOnce();
    expect(page.loadUsers).not.toHaveBeenCalled();
    expect(page.areaExists("Workspaces")).toBe(true);
    expect(page.areaExists("Workspace")).toBe(false);
  });

  it("loads only membership resources for a workspace target", async () => {
    const page = createSettingsPage();
    page.settings = buildSettingsScopeFixture(TEST_WORKSPACE_ID);
    page.loadOpenAICodexAuth = vi.fn(async () => undefined);
    page.loadSourceContentStorage = vi.fn(async () => undefined);
    page.loadSourceLibraryAdministration = vi.fn(async () => undefined);
    page.loadUsers = vi.fn(async () => undefined);

    await page.loadScopeResources();

    expect(page.loadUsers).toHaveBeenCalledOnce();
    expect(page.loadOpenAICodexAuth).not.toHaveBeenCalled();
    expect(page.loadSourceContentStorage).not.toHaveBeenCalled();
    expect(page.loadSourceLibraryAdministration).not.toHaveBeenCalled();
    expect(page.areaExists("Workspace")).toBe(true);
    expect(page.areaExists("Workspaces")).toBe(false);
  });

  it("keeps the control on the applied target while a target change is pending", async () => {
    const page = createSettingsPage();
    page.loading = false;
    page.locationStateRestored = true;
    page.settings = buildSettingsScopeFixture(TEST_WORKSPACE_ID);
    page.loadScopeResources = vi.fn(async () => undefined);
    let finishLoading;
    page.loadSettings = vi.fn(async (targetId) => {
      expect(targetId).toBe("organization");
      return await new Promise((resolve) => {
        finishLoading = () => {
          page.locationStateRestored = true;
          page.applySettings(buildSettingsScopeFixture("organization"));
          resolve(true);
        };
      });
    });
    const control = { value: "organization" };

    const targetChange = page.changeSettingsTargetFromControl(control);
    await Promise.resolve();

    expect(control.value).toBe(TEST_WORKSPACE_ID);
    expect(page.settings.scope.id).toBe(TEST_WORKSPACE_ID);

    finishLoading();
    await targetChange;

    expect(control.value).toBe("organization");
    expect(page.settings.scope.id).toBe("organization");
  });

  it("restores the applied target when the user keeps unsaved changes", async () => {
    await withConfirmation(false, async () => {
      const page = createSettingsPage();
      page.loading = false;
      page.pending = { topK: "set" };
      page.settings = buildSettingsScopeFixture(TEST_WORKSPACE_ID);
      page.loadSettings = vi.fn();
      const control = { value: "organization" };

      await page.changeSettingsTargetFromControl(control);

      expect(control.value).toBe(TEST_WORKSPACE_ID);
      expect(page.settings.scope.id).toBe(TEST_WORKSPACE_ID);
      expect(page.loadSettings).not.toHaveBeenCalled();
    });
  });

  it("restores the applied target when the target request fails", async () => {
    const page = createSettingsPage();
    page.loading = false;
    page.settings = buildSettingsScopeFixture(TEST_WORKSPACE_ID);
    page.loadSettings = vi.fn(async () => false);
    const control = { value: "organization" };

    const changed = await page.changeSettingsTargetFromControl(control);

    expect(changed).toBe(false);
    expect(control.value).toBe(TEST_WORKSPACE_ID);
    expect(page.settings.scope.id).toBe(TEST_WORKSPACE_ID);
  });

  it("keeps the selected scope when the settings page is recreated", () => {
    const pageFactory = createSettingsPageFactory();
    const page = pageFactory();
    page.locationStateRestored = true;

    page.applySettings(buildSettingsScopeFixture("organization"));

    const recreatedPage = pageFactory();
    expect(recreatedPage.settingsRequestUrl()).toBe("/api/settings");
  });

  it("restores a selected workspace by its stable ID", () => {
    const pageFactory = createSettingsPageFactory();
    const page = pageFactory();
    page.locationStateRestored = true;

    page.applySettings(buildSettingsScopeFixture(TEST_WORKSPACE_ID));

    const recreatedPage = pageFactory();
    expect(recreatedPage.settingsRequestUrl()).toBe(
      `/api/workspaces/${TEST_WORKSPACE_ID}/settings`,
    );
  });
});

describe("CiteLoom embedding-space settings", () => {
  it("keeps application-wide identity fields visible and operational fields advanced", () => {
    const page = createSettingsPage();
    page.featureFieldsByCapability.embedding = [
      { key: "embeddingDimensions" },
      { key: "embeddingInputFormatId" },
      { key: "retrievalWindowPolicy" },
      { key: "retrievalChunkTargetTokens" },
      { key: "embeddingTimeoutSeconds" },
      { key: "embeddingSpaceId" },
    ];

    expect(page.featurePrimaryFields("embedding").map((field) => field.key))
      .toEqual([
        "embeddingDimensions",
        "embeddingInputFormatId",
        "retrievalWindowPolicy",
      ]);
    expect(page.featureAdvancedFields("embedding").map((field) => field.key))
      .toEqual([
        "retrievalChunkTargetTokens",
        "embeddingTimeoutSeconds",
        "embeddingSpaceId",
      ]);
  });

  it("reports pending embedding-space impact and active-space coverage", () => {
    const page = createSettingsPage();
    page.settings = {
      embeddingSpace: {
        activeDocumentCount: 2,
        dimensions: 2048,
        id: "application-search-space",
        totalDocumentCount: 7,
      },
    };
    page.providerDrafts = {};
    page.pending.embeddingDimensions = "set";

    expect(page.embeddingSpaceChangePending()).toBe(true);
    expect(page.embeddingSpaceImpactMessage()).toContain(
      "Up to 7 indexed documents may require reindexing",
    );
    expect(page.embeddingSpaceCoverageLabel()).toBe("2 of 7");
    expect(page.embeddingSpaceNeedsReindex()).toBe(true);
    expect(page.embeddingSpaceReindexMessage()).toBe(
      "5 indexed documents need reindexing for the active embedding space.",
    );
  });

  it("declares dimensions, impact, status, and reindex navigation", async () => {
    const fragment = await readFile(
      new URL("../web/fragments/settings.html", import.meta.url),
      "utf8",
    );
    const elements = readHtmlElements(fragment);
    const visibleText = readHtmlDocumentText(elements);

    expect(findHtmlElementByAttribute(
      elements,
      "x-for",
      "field in featurePrimaryFields(selectedFeatureCapability)",
    ).tagName).toBe("template");
    expect(visibleText).toContain("Vector dimensions");
    expect(findHtmlElementByAttribute(
      elements,
      "x-text",
      "embeddingSpaceImpactMessage()",
    ).tagName).toBe("span");
    expect(findHtmlElementByAttribute(
      elements,
      "x-text",
      "embeddingSpaceCoverageLabel()",
    ).tagName).toBe("strong");
    expect(findHtmlElementByAttribute(
      elements,
      "data-view",
      "documents",
    ).tagName).toBe("a");
  });
});

describe("CiteLoom provider reasoning settings", () => {
  it("declares a provider reasoning control that governs thinking mode", async () => {
    const fragment = await readFile(
      new URL("../web/fragments/settings.html", import.meta.url),
      "utf8",
    );
    const elements = readHtmlElements(fragment);
    const reasoningToggle = findHtmlElementByAttribute(
      elements,
      "@change",
      "writeProviderSendReasoningOptions($event.target.checked)",
    );
    const providerMode = findHtmlElementByAttribute(
      elements,
      ":disabled",
      "!providerSendReasoningOptions()",
    );
    const featureMode = findHtmlElementByAttribute(
      elements,
      ":disabled",
      "!featureSendReasoningOptions(selectedFeatureCapability)",
    );

    expect(reasoningToggle.tagName).toBe("input");
    expect(readHtmlAttribute(reasoningToggle, "type")).toBe("checkbox");
    expect(providerMode.tagName).toBe("select");
    expect(featureMode.tagName).toBe("select");
  });
});

describe("CiteLoom source-content storage settings", () => {
  it("decodes redacted object-storage state without requiring credentials", () => {
    const response = readSourceContentStorageResponse({
      active: {
        bucket: "citeloom",
        credentialSource: "static",
        credentialsConfigured: true,
        endpointUrl: "http://seaweedfs:8333",
        forcePathStyle: true,
        kind: "s3",
        prefix: "sources",
        region: "us-east-1",
      },
      documentCount: 34,
      migration: null,
      settingsVersion: 7,
    });

    expect(response.active).toEqual({
      bucket: "citeloom",
      credentialSource: "static",
      credentialsConfigured: true,
      endpointUrl: "http://seaweedfs:8333",
      forcePathStyle: true,
      kind: "s3",
      prefix: "sources",
      region: "us-east-1",
    });
  });

  it("tests a write-only target before queuing a confirmed migration", async () => {
    await withConfirmation(true, async ({ confirmations }) => {
      const page = createSettingsPage();
      page.applySourceContentStorage(buildStorageOverview());
      page.changeSourceContentStorageKind("s3");
      page.writeSourceContentStorageDraft("credentialSource", "static");
      page.writeSourceContentStorageDraft("accessKeyId", "seaweed-access");
      page.writeSourceContentStorageDraft("secretAccessKey", "seaweed-secret");
      const target = buildStorageTargetFixture();
      const migrationResponse = buildMigrationResponse();
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(jsonResponse({ ok: true }))
        .mockResolvedValueOnce(jsonResponse(migrationResponse))
        .mockResolvedValueOnce(jsonResponse({
          ...buildStorageOverview(),
          active: migrationResponse.target,
          migration: {
            ...migrationResponse,
            completedAt: "2026-08-10T16:02:00.000Z",
            state: "completed",
            verifiedDocuments: 34,
          },
          settingsVersion: 8,
        }));
      vi.stubGlobal("fetch", fetchMock);

      await page.testSourceContentStorage();
      expect(page.sourceContentStorageProbePassed).toBe(true);
      await page.startSourceContentMigration();

      expect(confirmations).toEqual([
        expect.objectContaining({
          confirmLabel: "Start migration",
          description: expect.stringContaining("34 documents"),
          title: "Migrate source-content storage?",
        }),
      ]);
      expect(fetchMock).toHaveBeenNthCalledWith(
        1,
        "/api/source-content-storage/probes",
        expect.objectContaining({
          body: JSON.stringify({ target }),
          method: "POST",
        }),
      );
      expect(fetchMock).toHaveBeenNthCalledWith(
        2,
        "/api/source-content-storage/migrations",
        expect.objectContaining({
          body: JSON.stringify({
            expectedSettingsVersion: 7,
            target,
          }),
          method: "POST",
        }),
      );
      expect(page.sourceContentStorage.active).toEqual(
        migrationResponse.target,
      );
      expect(page.sourceContentStorage.migration.state).toBe("completed");
      page.destroySourceContentStorage();
    });
  });

  it("declares the connection boundary and migration controls", async () => {
    const fragment = await readFile(
      new URL("../web/fragments/settings.html", import.meta.url),
      "utf8",
    );
    const elements = readHtmlElements(fragment);
    const visibleText = readHtmlDocumentText(elements);
    const pathStyle = findHtmlElementByAttribute(
      elements,
      "@change",
      "writeSourceContentStorageDraft('forcePathStyle', $event.target.checked)",
    );
    const workspaceAccess = findHtmlElementByAttribute(
      elements,
      ":aria-label",
      "`${workspace.name} access to ${library.name}`",
    );
    const pathStyleStatus = findHtmlElementByAttribute(
      elements,
      "x-text",
      "sourceContentStorageDraft.forcePathStyle ? 'On. Required by bundled SeaweedFS and many self-hosted S3 services.' : 'Off. Recommended for AWS S3.'",
    );
    const runtimeArea = findHtmlElementByAttribute(
      elements,
      "x-if",
      "!browsingAreas && selectedArea !== 'Application Features' && selectedArea !== 'Providers' && selectedArea !== 'Object storage' && selectedArea !== 'Source libraries' && selectedArea !== 'Workspace' && selectedArea !== 'Workspaces' && selectedArea !== 'Startup and deployment'",
    );

    expect(visibleText).toContain("This page configures CiteLoom's connection.");
    expect(visibleText).toContain(
      "SeaweedFS server credentials, ports, and data directories remain deployment-controlled.",
    );
    expect(visibleText).toContain("Credentials are write-only");
    expect(findHtmlElementByAttribute(
      elements,
      "@click",
      "testSourceContentStorage()",
    ).tagName).toBe("button");
    expect(findHtmlElementByAttribute(
      elements,
      "@click",
      "startSourceContentMigration()",
    ).tagName).toBe("button");
    expect(findHtmlElementByAttribute(
      elements,
      "@click",
      "cancelSourceContentMigration()",
    ).tagName).toBe("button");
    expect(pathStyle.tagName).toBe("input");
    expect(readHtmlAttribute(pathStyle, "type")).toBe("checkbox");
    expect(pathStyleStatus.tagName).toBe("small");
    expect(workspaceAccess.tagName).toBe("select");
    expect(runtimeArea.tagName).toBe("template");
  });
});

function buildStorageOverview() {
  return {
    active: {
      directory: "/app/documents/blobs",
      kind: "filesystem",
    },
    documentCount: 34,
    migration: null,
    settingsVersion: 7,
  };
}

function buildStorageTargetFixture() {
  return {
    bucket: "citeloom",
    credentials: {
      accessKeyId: "seaweed-access",
      kind: "static",
      secretAccessKey: "seaweed-secret",
    },
    endpointUrl: "http://seaweedfs:8333",
    forcePathStyle: true,
    kind: "s3",
    prefix: "sources",
    region: "us-east-1",
  };
}

function buildMigrationResponse() {
  return {
    attemptCount: 0,
    completedAt: null,
    copiedDocuments: 0,
    createdAt: "2026-08-10T16:00:00.000Z",
    errorMessage: null,
    id: "00000000-0000-4000-8000-000000000401",
    source: {
      directory: "/app/documents/blobs",
      kind: "filesystem",
    },
    startedAt: null,
    state: "queued",
    target: {
      bucket: "citeloom",
      credentialSource: "static",
      credentialsConfigured: true,
      endpointUrl: "http://seaweedfs:8333",
      forcePathStyle: true,
      kind: "s3",
      prefix: "sources",
      region: "us-east-1",
    },
    totalDocuments: 34,
    updatedAt: "2026-08-10T16:00:00.000Z",
    verifiedDocuments: 0,
  };
}

function jsonResponse(value) {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    status: 200,
  });
}

const TEST_WORKSPACE_ID = "00000000-0000-4000-8000-000000000601";

function buildSettingsScopeFixture(targetId) {
  const organizationSelected = targetId === "organization";
  return {
    features: [],
    fields: [],
    providers: {
      catalog: [],
      connections: [],
    },
    scope: {
      available: [
        {
          id: "organization",
          kind: "organization",
          label: "Organization",
        },
        {
          id: TEST_WORKSPACE_ID,
          kind: "workspace",
          label: "DefaultSpace",
        },
      ],
      editableProviderConnections: organizationSelected,
      id: targetId,
      kind: organizationSelected ? "organization" : "workspace",
      label: organizationSelected ? "Organization" : "DefaultSpace",
    },
  };
}

function createSettingsPage({ reactiveResetState = false } = {}) {
  const rawValues = new WeakMap();
  const pageFactory = createSettingsPageFactory(rawValues);
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

function createSettingsPageFactory(rawValues = new WeakMap()) {
  let pageFactory = null;
  registerPage({
    data(name, factory) {
      expect(name).toBe("citeloomSettingsPage");
      pageFactory = factory;
    },
    raw(value) {
      return rawValues.get(value) ?? value;
    },
  });
  if (pageFactory === null) {
    throw new Error("The settings page factory was not registered.");
  }
  return pageFactory;
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
