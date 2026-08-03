import { describe, expect, it, vi } from "vitest";

import type { DoclingJsonRequester } from "../src/docling/index.js";
import {
  DoclingServiceVerifier,
  type DoclingServiceVerificationStore,
} from "../src/docling/service-verifier.js";
import type {
  DoclingServiceConfiguration,
  DoclingServiceVerification,
  DoclingServiceVerificationTarget,
} from "../src/docling/service-store.js";
import { readEqualWeightTestConfig } from "./config-fixture.js";

describe("Docling service verifier", () => {
  it("checks readiness and identity for every demand but caches capabilities", async () => {
    const config = readEqualWeightTestConfig({ settingsVersion: 3 });
    const store = new MemoryVerificationStore(config.doclingServices[0]);
    const requester = buildRequester();
    const verifier = new DoclingServiceVerifier(config, store, requester);

    await verifier.initialize();
    await expect(verifier.verifyDemand({
      assignedServiceIds: [],
      hasUnassignedJobs: false,
    })).resolves.toEqual({
      availableServiceIds: [],
      failures: [],
      probeFailed: false,
    });
    expect(requester).not.toHaveBeenCalled();

    await expect(verifier.verifyDemand({
      assignedServiceIds: [],
      hasUnassignedJobs: true,
    })).resolves.toMatchObject({ availableServiceIds: ["default"] });
    await expect(verifier.verifyDemand({
      assignedServiceIds: [],
      hasUnassignedJobs: true,
    })).resolves.toMatchObject({ availableServiceIds: ["default"] });

    expect(readRequestedPaths(requester)).toEqual([
      "/ready",
      "/version",
      "/openapi.json",
      "/ready",
      "/version",
    ]);
  });

  it("revalidates capabilities when the observed identity changes", async () => {
    const config = readEqualWeightTestConfig({ settingsVersion: 4 });
    const store = new MemoryVerificationStore(config.doclingServices[0]);
    let coreVersion = "2.87.1";
    const requester = buildRequester(() => coreVersion);
    const verifier = new DoclingServiceVerifier(config, store, requester);
    await verifier.initialize();
    await verifier.verifyDemand({
      assignedServiceIds: [],
      hasUnassignedJobs: true,
    });

    coreVersion = "2.88.0";
    await verifier.verifyDemand({
      assignedServiceIds: [],
      hasUnassignedJobs: true,
    });

    expect(readRequestedPaths(requester)).toEqual([
      "/ready",
      "/version",
      "/openapi.json",
      "/ready",
      "/version",
      "/openapi.json",
    ]);
    expect(store.target.cachedIdentity?.coreVersion).toBe("2.88.0");
  });

  it("invalidates compatibility for settings and topology changes", async () => {
    const initialConfig = readEqualWeightTestConfig({ settingsVersion: 5 });
    const service = initialConfig.doclingServices[0];
    if (service === undefined) {
      throw new Error("Missing default Docling test service.");
    }
    const store = new MemoryVerificationStore(service);
    const requester = buildRequester();
    const initialVerifier = new DoclingServiceVerifier(
      initialConfig,
      store,
      requester,
    );
    await initialVerifier.initialize();
    await initialVerifier.verifyDemand({
      assignedServiceIds: [],
      hasUnassignedJobs: true,
    });

    const settingsConfig = readEqualWeightTestConfig({ settingsVersion: 6 });
    const settingsVerifier = new DoclingServiceVerifier(
      settingsConfig,
      store,
      requester,
    );
    await settingsVerifier.initialize();
    await settingsVerifier.verifyDemand({
      assignedServiceIds: [],
      hasUnassignedJobs: true,
    });

    const topologyConfig = readEqualWeightTestConfig({
      runtime: { doclingBaseUrl: "http://127.0.0.1:5999" },
      settingsVersion: 6,
    });
    const topologyVerifier = new DoclingServiceVerifier(
      topologyConfig,
      store,
      requester,
    );
    await topologyVerifier.initialize();
    await topologyVerifier.verifyDemand({
      assignedServiceIds: [],
      hasUnassignedJobs: true,
    });

    expect(readRequestedPaths(requester).filter((path) => {
      return path === "/openapi.json";
    })).toHaveLength(3);
  });

  it("uses readiness alone when a required service is unavailable", async () => {
    const config = readEqualWeightTestConfig();
    const store = new MemoryVerificationStore(config.doclingServices[0]);
    const requester = vi.fn<DoclingJsonRequester>(async (request) => {
      if (new URL(request.url).pathname === "/ready") {
        throw new Error("connection refused");
      }
      throw new Error("Unexpected compatibility request.");
    });
    const verifier = new DoclingServiceVerifier(config, store, requester);
    await verifier.initialize();

    const result = await verifier.verifyDemand({
      assignedServiceIds: ["default"],
      hasUnassignedJobs: false,
    });

    expect(result.availableServiceIds).toEqual([]);
    expect(result.failures).toMatchObject([{
      serviceId: "default",
    }]);
    expect(result.probeFailed).toBe(true);
    expect(readRequestedPaths(requester)).toEqual(["/ready"]);

    const skippedResult = await verifier.verifyDemand({
      assignedServiceIds: ["default"],
      hasUnassignedJobs: false,
    }, false);

    expect(skippedResult.probeFailed).toBe(false);
    expect(skippedResult.failures).toMatchObject([{
      serviceId: "default",
    }]);
    expect(readRequestedPaths(requester)).toEqual(["/ready"]);
  });

  it("rejects a verification that finishes after settings invalidation", async () => {
    const initialConfig = readEqualWeightTestConfig({ settingsVersion: 7 });
    const store = new MemoryVerificationStore(initialConfig.doclingServices[0]);
    let releaseCapabilities: () => void = () => undefined;
    const capabilitiesReleased = new Promise<void>((resolve) => {
      releaseCapabilities = resolve;
    });
    const requester = buildRequester();
    requester.mockImplementation(async (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/ready") {
        return { status: "ok" };
      }
      if (path === "/version") {
        return buildVersionResponse("2.87.1");
      }
      if (path === "/openapi.json") {
        await capabilitiesReleased;
        return buildOpenApi();
      }
      throw new Error(`Unexpected Docling request: ${request.url}`);
    });
    const initialVerifier = new DoclingServiceVerifier(
      initialConfig,
      store,
      requester,
    );
    await initialVerifier.initialize();
    const verification = initialVerifier.verifyDemand({
      assignedServiceIds: [],
      hasUnassignedJobs: true,
    });
    await vi.waitFor(() => {
      expect(readRequestedPaths(requester)).toContain("/openapi.json");
    });

    const updatedConfig = readEqualWeightTestConfig({ settingsVersion: 8 });
    const updatedVerifier = new DoclingServiceVerifier(
      updatedConfig,
      store,
      requester,
    );
    await updatedVerifier.initialize();
    releaseCapabilities();

    await expect(verification).rejects.toThrow("verification became stale");
  });
});

class MemoryVerificationStore implements DoclingServiceVerificationStore {
  public target: DoclingServiceVerificationTarget;

  public constructor(
    service: DoclingServiceVerificationTarget["config"] | undefined,
  ) {
    if (service === undefined) {
      throw new Error("Missing Docling service fixture.");
    }
    this.target = {
      cachedCapabilitiesFingerprint: null,
      cachedIdentity: null,
      config: service,
      errorCategory: "CompatibilityUnverified",
      state: "unavailable",
      verificationConfigFingerprint: null,
    };
  }

  public async readVerificationTargets(
    serviceIds: readonly string[],
  ): Promise<DoclingServiceVerificationTarget[]> {
    if (!serviceIds.includes(this.target.config.id)) {
      return [];
    }
    return [structuredClone(this.target)];
  }

  public async reconcileTopology(
    configurations: readonly DoclingServiceConfiguration[],
    _settingsVersion: number,
  ): Promise<void> {
    const configuration = configurations.find((candidate) => {
      return candidate.config.id === this.target.config.id;
    });
    if (configuration === undefined) {
      return;
    }
    const cacheMatches = this.target.verificationConfigFingerprint
      === configuration.verificationConfigFingerprint;
    this.target.config = structuredClone(configuration.config);
    if (cacheMatches) {
      return;
    }
    this.target.cachedCapabilitiesFingerprint = null;
    this.target.cachedIdentity = null;
    this.target.verificationConfigFingerprint =
      configuration.verificationConfigFingerprint;
    this.target.errorCategory = "CompatibilityUnverified";
    this.target.state = "unavailable";
  }

  public async recordVerification(
    verification: DoclingServiceVerification,
  ): Promise<void> {
    if (
      this.target.verificationConfigFingerprint
      !== verification.verificationConfigFingerprint
    ) {
      throw new Error(
        `Docling service ${verification.config.id} verification became stale.`,
      );
    }
    if (verification.identity === null) {
      this.target.errorCategory = verification.errorCategory;
      this.target.state = "unavailable";
      return;
    }
    this.target.cachedCapabilitiesFingerprint =
      verification.capabilitiesFingerprint;
    this.target.cachedIdentity = structuredClone(verification.identity);
    this.target.verificationConfigFingerprint =
      verification.verificationConfigFingerprint;
    this.target.errorCategory = null;
    this.target.state = "active";
  }
}

function buildRequester(
  readCoreVersion: () => string = () => "2.87.1",
): ReturnType<typeof vi.fn<DoclingJsonRequester>> {
  return vi.fn<DoclingJsonRequester>(async (request) => {
    const path = new URL(request.url).pathname;
    if (path === "/ready") {
      return { status: "ok" };
    }
    if (path === "/version") {
      return buildVersionResponse(readCoreVersion());
    }
    if (path === "/openapi.json") {
      return buildOpenApi();
    }
    throw new Error(`Unexpected Docling request: ${request.url}`);
  });
}

function readRequestedPaths(
  requester: ReturnType<typeof vi.fn<DoclingJsonRequester>>,
): string[] {
  const paths: string[] = [];
  for (const call of requester.mock.calls) {
    const request = call[0];
    paths.push(new URL(request.url).pathname);
  }
  return paths;
}

function buildVersionResponse(coreVersion: string) {
  return {
    docling: "2.113.0",
    "docling-core": coreVersion,
    "docling-ibm-models": "3.13.3",
    "docling-jobkit": "2.1.0",
    "docling-parse": "7.8.1",
    "docling-serve": "1.27.0",
  };
}

function buildOpenApi() {
  return {
    components: {
      schemas: {
        ContentRequest: {
          properties: {
            byte_length: {},
            document_id: {},
            filename: {},
            options: { $ref: "#/components/schemas/ConvertOptions" },
            task_id: {},
          },
        },
        ConvertOptions: {
          properties: {
            abort_on_error: {},
            do_ocr: {},
            do_table_structure: {},
            document_timeout: {},
            force_ocr: {},
            from_formats: {},
            image_export_mode: {},
            images_scale: {},
            include_images: {},
            include_page_images: {},
            ocr_preset: {},
            pdf_backend: {
              enum: [
                "docling_parse",
                "pypdfium2",
                "threaded_docling_parse",
              ],
            },
            pipeline: { enum: ["standard", "vlm"] },
            table_cell_matching: {},
            table_mode: {},
            to_formats: {},
            vlm_pipeline_custom_config: {},
          },
        },
      },
    },
    info: { title: "Docling Serve", version: "1.27.0" },
    openapi: "3.1.0",
    paths: {
      "/v1/convert/content/async": {
        post: {
          requestBody: {
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ContentRequest" },
              },
            },
          },
        },
      },
      "/v1/result/{task_id}": { get: {} },
      "/v1/status/poll/{task_id}": { get: {} },
      "/v1/tasks/{task_id}/pause": { post: {} },
      "/v1/tasks/{task_id}/terminate": { post: {} },
    },
  };
}
