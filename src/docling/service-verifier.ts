import type {
  AppConfig,
  DoclingConfig,
  DoclingServiceInstanceConfig,
} from "../config/index.js";
import {
  checkDoclingServiceAvailability,
  readDoclingErrorCategory,
  readDoclingServiceCapabilities,
  readDoclingServiceIdentity,
  type DoclingJsonRequester,
} from "./client/index.js";
import type { DoclingServiceIdentity } from "./protocol/run-metadata.js";
import type {
  DoclingServiceConfiguration,
  DoclingServiceVerification,
  DoclingServiceVerificationTarget,
} from "./service-store.js";
import {
  fingerprintDoclingVerificationConfiguration,
} from "./verification-configuration.js";

export interface DoclingVerificationDemand {
  assignedServiceIds: readonly string[];
  hasUnassignedJobs: boolean;
}

export interface DoclingVerificationFailure {
  errorCategory: string;
  serviceId: string;
}

export interface DoclingVerificationResult {
  availableServiceIds: string[];
  failures: DoclingVerificationFailure[];
  probeFailed: boolean;
}

type DoclingVerificationTargetResult =
  | { kind: "available"; probeFailed: false; serviceId: string }
  | {
    errorCategory: string;
    kind: "unavailable";
    probeFailed: boolean;
    serviceId: string;
  };

export interface DoclingServiceVerificationStore {
  readVerificationTargets(
    serviceIds: readonly string[],
  ): Promise<DoclingServiceVerificationTarget[]>;
  reconcileTopology(
    configurations: readonly DoclingServiceConfiguration[],
    settingsVersion: number,
  ): Promise<void>;
  recordVerification(verification: DoclingServiceVerification): Promise<void>;
}

export class DoclingServiceVerifier {
  public constructor(
    private readonly config: AppConfig,
    private readonly services: DoclingServiceVerificationStore,
    private readonly requester?: DoclingJsonRequester,
  ) {}

  public async initialize(): Promise<void> {
    const configurations: DoclingServiceConfiguration[] = [];
    for (const service of this.config.doclingServices) {
      configurations.push({
        config: service,
        verificationConfigFingerprint:
          fingerprintDoclingVerificationConfiguration(
            this.config.settingsVersion,
            service,
            "configured",
          ),
      });
    }
    await this.services.reconcileTopology(
      configurations,
      this.config.settingsVersion,
    );
  }

  public async verifyDemand(
    demand: DoclingVerificationDemand,
    verifyUnavailableServices: boolean = true,
  ): Promise<DoclingVerificationResult> {
    const requiredServiceIds = new Set<string>(demand.assignedServiceIds);
    if (demand.hasUnassignedJobs) {
      for (const service of this.config.doclingServices) {
        requiredServiceIds.add(service.id);
      }
    }
    const targets = await this.services.readVerificationTargets(
      [...requiredServiceIds],
    );
    const pending: Array<Promise<DoclingVerificationTargetResult>> = [];
    for (const target of targets) {
      if (!verifyUnavailableServices && target.errorCategory !== null) {
        pending.push(Promise.resolve({
          errorCategory: target.errorCategory,
          kind: "unavailable",
          probeFailed: false,
          serviceId: target.config.id,
        }));
        continue;
      }
      pending.push(this.verifyTarget(target));
    }
    const results = await Promise.all(pending);
    const availableServiceIds: string[] = [];
    const failures: DoclingVerificationFailure[] = [];
    let probeFailed = false;
    for (const result of results) {
      if (result.probeFailed) {
        probeFailed = true;
      }
      if (result.kind === "available") {
        availableServiceIds.push(result.serviceId);
        continue;
      }
      failures.push({
        errorCategory: result.errorCategory,
        serviceId: result.serviceId,
      });
    }
    availableServiceIds.sort((left, right) => left.localeCompare(right));
    failures.sort((left, right) => left.serviceId.localeCompare(right.serviceId));
    return { availableServiceIds, failures, probeFailed };
  }

  private async verifyTarget(
    target: DoclingServiceVerificationTarget,
  ): Promise<DoclingVerificationTargetResult> {
    const doclingConfig = buildServiceDoclingConfig(this.config, target.config);
    const verificationConfigFingerprint =
      fingerprintDoclingVerificationConfiguration(
        this.config.settingsVersion,
        target.config,
        target.state === "draining" ? "draining" : "configured",
      );
    let capabilitiesFingerprint: string;
    let identity: DoclingServiceIdentity;
    try {
      await checkDoclingServiceAvailability(doclingConfig, this.requester);
      identity = await readDoclingServiceIdentity(
        doclingConfig,
        this.requester,
      );
      const cacheMatches = target.cachedCapabilitiesFingerprint !== null
        && target.cachedIdentity !== null
        && sameServiceIdentity(target.cachedIdentity, identity)
        && target.verificationConfigFingerprint
          === verificationConfigFingerprint;
      if (cacheMatches) {
        const cachedFingerprint = target.cachedCapabilitiesFingerprint;
        if (cachedFingerprint === null) {
          throw new Error(
            `Docling service ${target.config.id} capability cache is incomplete.`,
          );
        }
        capabilitiesFingerprint = cachedFingerprint;
      } else {
        const capabilities = await readDoclingServiceCapabilities(
          doclingConfig,
          this.requester,
        );
        capabilitiesFingerprint = capabilities.fingerprint;
      }
    } catch (error: unknown) {
      const errorCategory = readDoclingErrorCategory(error);
      const verification: DoclingServiceVerification = {
        config: target.config,
        errorCategory,
        identity: null,
        verificationConfigFingerprint,
      };
      await this.services.recordVerification(verification);
      return {
        errorCategory,
        kind: "unavailable",
        probeFailed: true,
        serviceId: target.config.id,
      };
    }
    const verification: DoclingServiceVerification = {
      capabilitiesFingerprint,
      config: target.config,
      errorCategory: null,
      identity,
      verificationConfigFingerprint,
    };
    await this.services.recordVerification(verification);
    return {
      kind: "available",
      probeFailed: false,
      serviceId: target.config.id,
    };
  }
}

function buildServiceDoclingConfig(
  config: AppConfig,
  service: DoclingServiceInstanceConfig,
): DoclingConfig {
  return {
    ...config.docling,
    baseUrl: service.baseUrl,
  };
}

function sameServiceIdentity(
  left: DoclingServiceIdentity,
  right: DoclingServiceIdentity,
): boolean {
  return left.coreVersion === right.coreVersion
    && left.jobkitVersion === right.jobkitVersion
    && left.modelsVersion === right.modelsVersion
    && left.parseVersion === right.parseVersion
    && left.serveVersion === right.serveVersion
    && left.version === right.version;
}
