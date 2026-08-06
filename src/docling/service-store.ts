import {
  and,
  asc,
  eq,
  inArray,
  isNotNull,
  isNull,
  or,
  sql,
} from "drizzle-orm";
import { z } from "zod";

import { buildOwnedRunningJobCondition } from "../documents/catalog/job-store.js";
import type {
  DoclingProcessConfiguration,
  DoclingServiceInstanceConfig,
} from "../config/index.js";
import type { CiteLoomDatabase } from "../database/client.js";
import {
  doclingServiceInstances,
  doclingTaskCheckpoints,
  ingestionJobs,
} from "../database/schema.js";
import {
  decodeDoclingProcessConfiguration,
  decodeDoclingServiceIdentity,
  type DoclingServiceIdentity,
} from "./protocol/run-metadata.js";
import {
  fingerprintDoclingVerificationConfiguration,
} from "./verification-configuration.js";

const REGISTRY_LOCK_KEY = "citeloom:docling-service-registry";
const serviceIdSchema = z.string().trim().min(1).max(100).regex(
  /^[A-Za-z0-9][A-Za-z0-9._:-]*$/,
);
const fingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/);
const serviceRowSchema = z.object({
  baseUrl: z.url().refine(isHttpUrl, "must use http or https"),
  capabilitiesFingerprint: fingerprintSchema.nullable(),
  capacity: z.number().int().min(1).max(16),
  errorCategory: z.string().trim().min(1).max(64).nullable(),
  id: serviceIdSchema,
  lastVerifiedAt: z.date().nullable(),
  processConfig: z.unknown(),
  serviceIdentity: z.unknown().nullable(),
  state: z.enum(["active", "unavailable", "draining"]),
  verificationConfigFingerprint: fingerprintSchema.nullable(),
});
export type DoclingServiceVerification =
  | {
      config: DoclingServiceInstanceConfig;
      capabilitiesFingerprint: string;
      errorCategory: null;
      identity: DoclingServiceIdentity;
      verificationConfigFingerprint: string;
    }
  | {
      config: DoclingServiceInstanceConfig;
      errorCategory: string;
      identity: null;
      verificationConfigFingerprint: string;
    };

export interface DoclingServiceConfiguration {
  config: DoclingServiceInstanceConfig;
  verificationConfigFingerprint: string;
}

export interface DoclingServiceAssignment {
  baseUrl: string;
  id: string;
  process: DoclingProcessConfiguration;
  serviceIdentity: DoclingServiceIdentity;
  slot: number;
  state: "active" | "draining";
}

export interface DoclingServiceSynchronizationResult {
  activeServiceCount: number;
  unavailableServiceCount: number;
}

export interface DoclingServiceVerificationTarget {
  cachedCapabilitiesFingerprint: string | null;
  cachedIdentity: DoclingServiceIdentity | null;
  config: DoclingServiceInstanceConfig;
  errorCategory: string | null;
  state: "active" | "unavailable" | "draining";
  verificationConfigFingerprint: string | null;
}

export class DoclingCapacityUnavailableError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "DoclingCapacityUnavailableError";
  }
}

export class StaleDoclingServiceVerificationError extends Error {
  public constructor(public readonly serviceId: string) {
    super(`Docling service ${serviceId} verification became stale.`);
    this.name = "StaleDoclingServiceVerificationError";
  }
}

interface DecodedServiceRow {
  baseUrl: string;
  capabilitiesFingerprint: string | null;
  capacity: number;
  errorCategory: string | null;
  id: string;
  lastVerifiedAt: Date | null;
  process: DoclingProcessConfiguration;
  serviceIdentity: DoclingServiceIdentity | null;
  state: "active" | "unavailable" | "draining";
  verificationConfigFingerprint: string | null;
}

interface ServiceSynchronizationCounts {
  activeServiceCount: number;
  unavailableServiceCount: number;
}

interface StoredJobAssignment {
  serviceId: string | null;
  slot: number | null;
}

export class DoclingServiceStore {
  public constructor(private readonly database: CiteLoomDatabase) {}

  public async reconcileTopology(
    configurationValues: readonly DoclingServiceConfiguration[],
    settingsVersion: number,
    currentTime: Date = new Date(),
  ): Promise<void> {
    if (!Number.isInteger(settingsVersion) || settingsVersion < 0) {
      throw new Error("Docling verification settings version is invalid.");
    }
    const configurations = readDoclingServiceConfigurations(configurationValues);
    await this.database.transaction(async (transaction) => {
      await lockRegistry(transaction);
      const storedById = await readStoredServices(transaction);
      const assignedSlots = await readAssignedServiceSlots(transaction);
      const referencedServiceIds = await readCheckpointServiceIds(transaction);
      await reconcileUnconfiguredTopologyServices(
        transaction,
        storedById,
        configurations,
        assignedSlots,
        referencedServiceIds,
        settingsVersion,
        currentTime,
      );
      for (const configuration of configurations) {
        const existing = storedById.get(configuration.config.id);
        const slots = assignedSlots.get(configuration.config.id) ?? new Set<number>();
        validateServiceMutation(
          existing,
          configuration.config,
          slots,
        );
        await persistConfiguredService(
          transaction,
          configuration,
          existing,
          currentTime,
        );
      }
    });
  }

  public async readVerificationTargets(
    serviceIds: readonly string[],
  ): Promise<DoclingServiceVerificationTarget[]> {
    const normalizedIds = readUniqueServiceIds(serviceIds);
    if (normalizedIds.length === 0) {
      return [];
    }
    const rows = await this.database
      .select({
        baseUrl: doclingServiceInstances.baseUrl,
        capabilitiesFingerprint: doclingServiceInstances.capabilitiesFingerprint,
        capacity: doclingServiceInstances.capacity,
        errorCategory: doclingServiceInstances.errorCategory,
        id: doclingServiceInstances.id,
        lastVerifiedAt: doclingServiceInstances.lastVerifiedAt,
        processConfig: doclingServiceInstances.processConfig,
        serviceIdentity: doclingServiceInstances.serviceIdentity,
        state: doclingServiceInstances.state,
        verificationConfigFingerprint:
          doclingServiceInstances.verificationConfigFingerprint,
      })
      .from(doclingServiceInstances)
      .where(inArray(doclingServiceInstances.id, normalizedIds))
      .orderBy(asc(doclingServiceInstances.id));
    const targets: DoclingServiceVerificationTarget[] = [];
    for (const row of rows) {
      const service = decodeServiceRow(row);
      targets.push({
        cachedCapabilitiesFingerprint: service.capabilitiesFingerprint,
        cachedIdentity: service.serviceIdentity,
        config: {
          baseUrl: service.baseUrl,
          capacity: service.capacity,
          id: service.id,
          process: service.process,
        },
        errorCategory: service.errorCategory,
        state: service.state,
        verificationConfigFingerprint:
          service.verificationConfigFingerprint,
      });
    }
    if (targets.length !== normalizedIds.length) {
      throw new Error("A required Docling service verification target is missing.");
    }
    return targets;
  }

  public async recordVerification(
    verificationValue: DoclingServiceVerification,
    currentTime: Date = new Date(),
  ): Promise<void> {
    const verification = readDoclingServiceVerifications([verificationValue])[0];
    if (verification === undefined) {
      throw new Error("Docling service verification is missing.");
    }
    await this.database.transaction(async (transaction) => {
      await lockRegistry(transaction);
      const storedById = await readStoredServices(transaction);
      const existing = storedById.get(verification.config.id);
      if (existing === undefined) {
        throw new Error(
          `Docling service ${verification.config.id} is not registered.`,
        );
      }
      if (
        existing.baseUrl !== verification.config.baseUrl
        || existing.capacity !== verification.config.capacity
        || !sameProcessConfiguration(existing.process, verification.config.process)
      ) {
        throw new Error(
          `Docling service ${verification.config.id} changed during verification.`,
        );
      }
      if (
        existing.verificationConfigFingerprint
        !== verification.verificationConfigFingerprint
      ) {
        throw new StaleDoclingServiceVerificationError(
          verification.config.id,
        );
      }
      await persistVerifiedService(
        transaction,
        verification,
        existing,
        currentTime,
      );
    });
  }

  public async synchronize(
    verificationValues: readonly DoclingServiceVerification[],
    currentTime: Date = new Date(),
  ): Promise<DoclingServiceSynchronizationResult> {
    const verifications = readDoclingServiceVerifications(verificationValues);
    const result = await this.database.transaction(async (transaction) => {
      await lockRegistry(transaction);
      const storedById = await readStoredServices(transaction);
      const assignedSlots = await readAssignedServiceSlots(transaction);
      const referencedServiceIds = await readCheckpointServiceIds(transaction);
      await reconcileUnconfiguredServices(
        transaction,
        storedById,
        verifications,
        assignedSlots,
        referencedServiceIds,
        currentTime,
      );
      const counts = await synchronizeConfiguredServices(
        transaction,
        verifications,
        storedById,
        assignedSlots,
        currentTime,
      );
      return {
        activeServiceCount: counts.activeServiceCount,
        unavailableServiceCount: counts.unavailableServiceCount,
      };
    });
    return result;
  }

  public async ensureAssignment(
    ownerId: string,
    sourceFile: string,
  ): Promise<DoclingServiceAssignment> {
    const assignment = await this.database.transaction(async (transaction) => {
      await lockRegistry(transaction);
      const job = await readJobAssignment(transaction, ownerId, sourceFile);
      if (job.serviceId !== null && job.slot !== null) {
        return readAssignment(transaction, job.serviceId, job.slot);
      }
      if (job.serviceId !== null || job.slot !== null) {
        throw new Error(`Incomplete Docling service assignment for ${sourceFile}.`);
      }

      const checkpointServiceId = await readJobCheckpointServiceId(
        transaction,
        sourceFile,
      );
      const activeServices = await readAssignableServices(
        transaction,
        checkpointServiceId,
      );
      if (activeServices.length === 0) {
        throw new DoclingCapacityUnavailableError(
          checkpointServiceId === null
            ? "No verified Docling service instance is available."
            : `The checkpointed Docling service ${checkpointServiceId} is unavailable.`,
        );
      }
      const eligibleServices = checkpointServiceId === null
        ? activeServices
        : activeServices.filter((service) => {
          return service.id === checkpointServiceId;
        });
      if (eligibleServices.length === 0) {
        throw new DoclingCapacityUnavailableError(
          checkpointServiceId === null
            ? "No verified Docling service instance is available."
            : `The checkpointed Docling service ${checkpointServiceId} is unavailable.`,
        );
      }
      const occupiedByService = await readAssignedServiceSlots(transaction);
      const selection = selectAvailableService(
        eligibleServices,
        occupiedByService,
      );
      if (selection === null) {
        throw new DoclingCapacityUnavailableError(
          "All verified Docling service slots are occupied. Check document conversion capacity coordination.",
        );
      }
      await persistServiceAssignment(
        transaction,
        ownerId,
        sourceFile,
        selection.service.id,
        selection.slot,
      );
      return createAssignment(selection.service, selection.slot);
    });
    return assignment;
  }
}

async function readStoredServices(
  database: CiteLoomDatabase,
): Promise<Map<string, DecodedServiceRow>> {
  const values = await database
    .select({
      baseUrl: doclingServiceInstances.baseUrl,
      capabilitiesFingerprint: doclingServiceInstances.capabilitiesFingerprint,
      capacity: doclingServiceInstances.capacity,
      errorCategory: doclingServiceInstances.errorCategory,
      id: doclingServiceInstances.id,
      lastVerifiedAt: doclingServiceInstances.lastVerifiedAt,
      processConfig: doclingServiceInstances.processConfig,
      serviceIdentity: doclingServiceInstances.serviceIdentity,
      state: doclingServiceInstances.state,
      verificationConfigFingerprint:
        doclingServiceInstances.verificationConfigFingerprint,
    })
    .from(doclingServiceInstances)
    .orderBy(asc(doclingServiceInstances.id))
    .for("update");
  const storedById = new Map<string, DecodedServiceRow>();
  for (const value of values) {
    const stored = decodeServiceRow(value);
    storedById.set(stored.id, stored);
  }
  return storedById;
}

async function readAssignedServiceSlots(
  database: CiteLoomDatabase,
): Promise<Map<string, Set<number>>> {
  const rows = await database
    .select({
      serviceId: ingestionJobs.doclingServiceInstanceId,
      slot: ingestionJobs.doclingServiceSlot,
    })
    .from(ingestionJobs)
    .where(isNotNull(ingestionJobs.doclingServiceInstanceId));
  return readAssignedSlots(rows);
}

async function readCheckpointServiceIds(
  database: CiteLoomDatabase,
): Promise<Set<string>> {
  const references = await database
    .select({ serviceId: doclingTaskCheckpoints.serviceInstanceId })
    .from(doclingTaskCheckpoints)
    .where(isNotNull(doclingTaskCheckpoints.serviceInstanceId));
  const serviceIds = new Set<string>();
  for (const reference of references) {
    if (reference.serviceId !== null) {
      serviceIds.add(reference.serviceId);
    }
  }
  return serviceIds;
}

async function reconcileUnconfiguredServices(
  database: CiteLoomDatabase,
  storedById: ReadonlyMap<string, DecodedServiceRow>,
  verifications: readonly DoclingServiceVerification[],
  assignedSlots: ReadonlyMap<string, ReadonlySet<number>>,
  referencedServiceIds: ReadonlySet<string>,
  currentTime: Date,
): Promise<void> {
  const configuredIds = new Set<string>();
  for (const verification of verifications) {
    configuredIds.add(verification.config.id);
  }
  for (const stored of storedById.values()) {
    if (configuredIds.has(stored.id)) {
      continue;
    }
    const hasAssignments = (assignedSlots.get(stored.id)?.size ?? 0) > 0;
    if (hasAssignments || referencedServiceIds.has(stored.id)) {
      await database
        .update(doclingServiceInstances)
        .set({ state: "draining", updatedAt: currentTime })
        .where(eq(doclingServiceInstances.id, stored.id));
      continue;
    }
    await database
      .delete(doclingServiceInstances)
      .where(eq(doclingServiceInstances.id, stored.id));
  }
}

async function reconcileUnconfiguredTopologyServices(
  database: CiteLoomDatabase,
  storedById: ReadonlyMap<string, DecodedServiceRow>,
  configurations: readonly DoclingServiceConfiguration[],
  assignedSlots: ReadonlyMap<string, ReadonlySet<number>>,
  referencedServiceIds: ReadonlySet<string>,
  settingsVersion: number,
  currentTime: Date,
): Promise<void> {
  const configuredIds = new Set<string>();
  for (const configuration of configurations) {
    configuredIds.add(configuration.config.id);
  }
  for (const stored of storedById.values()) {
    if (configuredIds.has(stored.id)) {
      continue;
    }
    const hasAssignments = (assignedSlots.get(stored.id)?.size ?? 0) > 0;
    if (hasAssignments || referencedServiceIds.has(stored.id)) {
      const storedConfig: DoclingServiceInstanceConfig = {
        baseUrl: stored.baseUrl,
        capacity: stored.capacity,
        id: stored.id,
        process: stored.process,
      };
      const verificationConfigFingerprint =
        fingerprintDoclingVerificationConfiguration(
          settingsVersion,
          storedConfig,
          "draining",
        );
      if (
        stored.state === "draining"
        && stored.verificationConfigFingerprint
          === verificationConfigFingerprint
      ) {
        await database
          .update(doclingServiceInstances)
          .set({ updatedAt: currentTime })
          .where(eq(doclingServiceInstances.id, stored.id));
        continue;
      }
      await database
        .update(doclingServiceInstances)
        .set({
          capabilitiesFingerprint: null,
          errorCategory: "CompatibilityUnverified",
          lastVerifiedAt: null,
          serviceIdentity: null,
          state: "draining",
          updatedAt: currentTime,
          verificationConfigFingerprint,
        })
        .where(eq(doclingServiceInstances.id, stored.id));
      continue;
    }
    await database
      .delete(doclingServiceInstances)
      .where(eq(doclingServiceInstances.id, stored.id));
  }
}

async function persistConfiguredService(
  database: CiteLoomDatabase,
  configuration: DoclingServiceConfiguration,
  existing: DecodedServiceRow | undefined,
  currentTime: Date,
): Promise<void> {
  if (existing === undefined) {
    await database.insert(doclingServiceInstances).values({
      baseUrl: configuration.config.baseUrl,
      capabilitiesFingerprint: null,
      capacity: configuration.config.capacity,
      createdAt: currentTime,
      errorCategory: "CompatibilityUnverified",
      id: configuration.config.id,
      lastVerifiedAt: null,
      processConfig: configuration.config.process,
      serviceIdentity: null,
      state: "unavailable",
      updatedAt: currentTime,
      verificationConfigFingerprint:
        configuration.verificationConfigFingerprint,
    });
    return;
  }
  const cacheMatches = existing.verificationConfigFingerprint
    === configuration.verificationConfigFingerprint;
  if (!cacheMatches) {
    await database
      .update(doclingServiceInstances)
      .set({
        baseUrl: configuration.config.baseUrl,
        capabilitiesFingerprint: null,
        capacity: configuration.config.capacity,
        errorCategory: "CompatibilityUnverified",
        lastVerifiedAt: null,
        processConfig: configuration.config.process,
        serviceIdentity: null,
        state: "unavailable",
        updatedAt: currentTime,
        verificationConfigFingerprint:
          configuration.verificationConfigFingerprint,
      })
      .where(eq(doclingServiceInstances.id, configuration.config.id));
    return;
  }
  let state = existing.state;
  if (state === "draining") {
    state = existing.errorCategory === null
      ? "active"
      : "unavailable";
  }
  await database
    .update(doclingServiceInstances)
    .set({
      baseUrl: configuration.config.baseUrl,
      capacity: configuration.config.capacity,
      processConfig: configuration.config.process,
      state,
      updatedAt: currentTime,
    })
    .where(eq(doclingServiceInstances.id, configuration.config.id));
}

async function synchronizeConfiguredServices(
  database: CiteLoomDatabase,
  verifications: readonly DoclingServiceVerification[],
  storedById: ReadonlyMap<string, DecodedServiceRow>,
  assignedSlots: ReadonlyMap<string, ReadonlySet<number>>,
  currentTime: Date,
): Promise<ServiceSynchronizationCounts> {
  let activeServiceCount = 0;
  let unavailableServiceCount = 0;
  for (const verification of verifications) {
    const existing = storedById.get(verification.config.id);
    const slots = assignedSlots.get(verification.config.id) ?? new Set<number>();
    validateServiceMutation(
      existing,
      verification.config,
      slots,
    );
    if (verification.identity === null) {
      unavailableServiceCount += 1;
    } else {
      activeServiceCount += 1;
    }
    await persistVerifiedService(database, verification, existing, currentTime);
  }
  return { activeServiceCount, unavailableServiceCount };
}

async function persistVerifiedService(
  database: CiteLoomDatabase,
  verification: DoclingServiceVerification,
  existing: DecodedServiceRow | undefined,
  currentTime: Date,
): Promise<void> {
  const capabilitiesFingerprint = verification.identity === null
    ? existing?.capabilitiesFingerprint ?? null
    : verification.capabilitiesFingerprint;
  const serviceIdentity = verification.identity
    ?? existing?.serviceIdentity
    ?? null;
  const lastVerifiedAt = verification.identity === null
    ? existing?.lastVerifiedAt ?? null
    : currentTime;
  let state: DecodedServiceRow["state"];
  if (existing?.state === "draining") {
    state = "draining";
  } else {
    state = verification.identity === null ? "unavailable" : "active";
  }
  const verificationConfigFingerprint = verification.identity === null
    ? existing?.verificationConfigFingerprint ?? null
    : verification.verificationConfigFingerprint;
  const values = {
    baseUrl: verification.config.baseUrl,
    capabilitiesFingerprint,
    capacity: verification.config.capacity,
    errorCategory: verification.errorCategory,
    lastVerifiedAt,
    processConfig: verification.config.process,
    serviceIdentity,
    state,
    updatedAt: currentTime,
    verificationConfigFingerprint,
  } as const;
  if (existing === undefined) {
    await database.insert(doclingServiceInstances).values({
      ...values,
      createdAt: currentTime,
      id: verification.config.id,
    });
    return;
  }
  await database
    .update(doclingServiceInstances)
    .set(values)
    .where(eq(doclingServiceInstances.id, verification.config.id));
}

async function readJobAssignment(
  database: CiteLoomDatabase,
  ownerId: string,
  sourceFile: string,
): Promise<StoredJobAssignment> {
  const jobs = await database
    .select({
      serviceId: ingestionJobs.doclingServiceInstanceId,
      slot: ingestionJobs.doclingServiceSlot,
    })
    .from(ingestionJobs)
    .where(and(
      buildOwnedRunningJobCondition(ownerId, sourceFile),
      eq(ingestionJobs.phase, "discovered"),
    ))
    .limit(1)
    .for("update");
  const job = jobs[0];
  if (job === undefined) {
    throw new Error(`Cannot assign a Docling service for ${sourceFile}.`);
  }
  return job;
}

async function readJobCheckpointServiceId(
  database: CiteLoomDatabase,
  sourceFile: string,
): Promise<string | null> {
  const rows = await database
    .selectDistinct({
      serviceId: doclingTaskCheckpoints.serviceInstanceId,
    })
    .from(doclingTaskCheckpoints)
    .where(eq(doclingTaskCheckpoints.sourceFile, sourceFile));
  if (rows.length === 0) {
    return null;
  }
  const serviceIds = new Set<string>();
  for (const row of rows) {
    if (row.serviceId === null) {
      throw new Error(
        `Docling checkpoint for ${sourceFile} has no service instance.`,
      );
    }
    serviceIds.add(row.serviceId);
  }
  if (serviceIds.size !== 1) {
    throw new Error(
      `Docling checkpoints for ${sourceFile} disagree on service affinity.`,
    );
  }
  const serviceId = serviceIds.values().next().value;
  if (serviceId === undefined) {
    throw new Error(
      `Docling checkpoint for ${sourceFile} has no service affinity.`,
    );
  }
  return serviceId;
}

async function readAssignableServices(
  database: CiteLoomDatabase,
  checkpointServiceId: string | null,
): Promise<DecodedServiceRow[]> {
  const stateCondition = checkpointServiceId === null
    ? eq(doclingServiceInstances.state, "active")
    : or(
      eq(doclingServiceInstances.state, "active"),
      and(
        eq(doclingServiceInstances.id, checkpointServiceId),
        eq(doclingServiceInstances.state, "draining"),
      ),
    );
  if (stateCondition === undefined) {
    throw new Error("Could not build Docling service state condition.");
  }
  const values = await database
    .select({
      baseUrl: doclingServiceInstances.baseUrl,
      capabilitiesFingerprint: doclingServiceInstances.capabilitiesFingerprint,
      capacity: doclingServiceInstances.capacity,
      errorCategory: doclingServiceInstances.errorCategory,
      id: doclingServiceInstances.id,
      lastVerifiedAt: doclingServiceInstances.lastVerifiedAt,
      processConfig: doclingServiceInstances.processConfig,
      serviceIdentity: doclingServiceInstances.serviceIdentity,
      state: doclingServiceInstances.state,
      verificationConfigFingerprint:
        doclingServiceInstances.verificationConfigFingerprint,
    })
    .from(doclingServiceInstances)
    .where(stateCondition)
    .orderBy(asc(doclingServiceInstances.id))
    .for("update");
  const services: DecodedServiceRow[] = [];
  for (const value of values) {
    services.push(decodeServiceRow(value));
  }
  return services;
}

async function persistServiceAssignment(
  database: CiteLoomDatabase,
  ownerId: string,
  sourceFile: string,
  serviceId: string,
  slot: number,
): Promise<void> {
  const updated = await database
    .update(ingestionJobs)
    .set({
      doclingServiceInstanceId: serviceId,
      doclingServiceSlot: slot,
    })
    .where(and(
      buildOwnedRunningJobCondition(ownerId, sourceFile),
      eq(ingestionJobs.phase, "discovered"),
      isNull(ingestionJobs.doclingServiceInstanceId),
    ))
    .returning({ sourceFile: ingestionJobs.sourceFile });
  if (updated.length !== 1) {
    throw new Error(`Could not persist the Docling service assignment for ${sourceFile}.`);
  }
}

function readDoclingServiceVerifications(
  values: readonly DoclingServiceVerification[],
): DoclingServiceVerification[] {
  if (values.length === 0) {
    throw new Error("At least one Docling service verification is required.");
  }
  const identifiers = new Set<string>();
  const baseUrls = new Set<string>();
  const verifications: DoclingServiceVerification[] = [];
  for (const value of values) {
    const idResult = serviceIdSchema.safeParse(value.config.id);
    if (!idResult.success) {
      throw new Error(`Invalid Docling service ID: ${value.config.id}.`);
    }
    if (
      !Number.isInteger(value.config.capacity)
      || value.config.capacity < 1
      || value.config.capacity > 16
    ) {
      throw new Error(`Docling service ${value.config.id} has invalid capacity.`);
    }
    if (!isHttpUrl(value.config.baseUrl)) {
      throw new Error(`Docling service ${value.config.id} must use HTTP or HTTPS.`);
    }
    if (identifiers.has(value.config.id)) {
      throw new Error(`Duplicate Docling service ID ${value.config.id}.`);
    }
    if (baseUrls.has(value.config.baseUrl)) {
      throw new Error(`Duplicate Docling service base URL ${value.config.baseUrl}.`);
    }
    if (value.identity === null && (value.errorCategory.length < 1 || value.errorCategory.length > 64)) {
      throw new Error(`Docling service ${value.config.id} has invalid error category.`);
    }
    const process = decodeDoclingProcessConfiguration(value.config.process);
    const config: DoclingServiceInstanceConfig = {
      baseUrl: value.config.baseUrl,
      capacity: value.config.capacity,
      id: value.config.id,
      process,
    };
    identifiers.add(config.id);
    baseUrls.add(config.baseUrl);
    if (value.identity === null) {
      verifications.push({
        config,
        errorCategory: value.errorCategory,
        identity: null,
        verificationConfigFingerprint:
          readFingerprint(
            value.verificationConfigFingerprint,
            `Docling service ${config.id} verification configuration`,
          ),
      });
      continue;
    }
    verifications.push({
      capabilitiesFingerprint: readFingerprint(
        value.capabilitiesFingerprint,
        `Docling service ${config.id} capabilities`,
      ),
      config,
      errorCategory: null,
      identity: decodeDoclingServiceIdentity(value.identity),
      verificationConfigFingerprint: readFingerprint(
        value.verificationConfigFingerprint,
        `Docling service ${config.id} verification configuration`,
      ),
    });
  }
  return verifications;
}

function readDoclingServiceConfigurations(
  values: readonly DoclingServiceConfiguration[],
): DoclingServiceConfiguration[] {
  if (values.length === 0) {
    throw new Error("At least one Docling service configuration is required.");
  }
  const identifiers = new Set<string>();
  const baseUrls = new Set<string>();
  const configurations: DoclingServiceConfiguration[] = [];
  for (const value of values) {
    const idResult = serviceIdSchema.safeParse(value.config.id);
    if (!idResult.success) {
      throw new Error(`Invalid Docling service ID: ${value.config.id}.`);
    }
    if (
      !Number.isInteger(value.config.capacity)
      || value.config.capacity < 1
      || value.config.capacity > 16
    ) {
      throw new Error(`Docling service ${value.config.id} has invalid capacity.`);
    }
    if (!isHttpUrl(value.config.baseUrl)) {
      throw new Error(`Docling service ${value.config.id} must use HTTP or HTTPS.`);
    }
    if (identifiers.has(value.config.id)) {
      throw new Error(`Duplicate Docling service ID ${value.config.id}.`);
    }
    if (baseUrls.has(value.config.baseUrl)) {
      throw new Error(`Duplicate Docling service base URL ${value.config.baseUrl}.`);
    }
    const config: DoclingServiceInstanceConfig = {
      baseUrl: value.config.baseUrl,
      capacity: value.config.capacity,
      id: value.config.id,
      process: decodeDoclingProcessConfiguration(value.config.process),
    };
    configurations.push({
      config,
      verificationConfigFingerprint: readFingerprint(
        value.verificationConfigFingerprint,
        `Docling service ${config.id} verification configuration`,
      ),
    });
    identifiers.add(config.id);
    baseUrls.add(config.baseUrl);
  }
  return configurations;
}

function readUniqueServiceIds(values: readonly string[]): string[] {
  const serviceIds: string[] = [];
  const unique = new Set<string>();
  for (const value of values) {
    const result = serviceIdSchema.safeParse(value);
    if (!result.success) {
      throw new Error(`Invalid Docling service ID: ${value}.`);
    }
    if (unique.has(result.data)) {
      continue;
    }
    unique.add(result.data);
    serviceIds.push(result.data);
  }
  serviceIds.sort((left, right) => left.localeCompare(right));
  return serviceIds;
}

function readFingerprint(value: string, name: string): string {
  const result = fingerprintSchema.safeParse(value);
  if (!result.success) {
    throw new Error(`${name} fingerprint is invalid.`);
  }
  return result.data;
}

function decodeServiceRow(value: unknown): DecodedServiceRow {
  const result = serviceRowSchema.safeParse(value);
  if (!result.success) {
    throw new Error(`Invalid Docling service row: ${result.error.message}`);
  }
  const identity = result.data.serviceIdentity === null
    ? null
    : decodeDoclingServiceIdentity(result.data.serviceIdentity);
  if (result.data.state === "active" && identity === null) {
    throw new Error(`Active Docling service ${result.data.id} has no identity.`);
  }
  if (
    result.data.state === "active"
    && (
      result.data.capabilitiesFingerprint === null
      || result.data.lastVerifiedAt === null
      || result.data.errorCategory !== null
      || result.data.verificationConfigFingerprint === null
    )
  ) {
    throw new Error(
      `Active Docling service ${result.data.id} has invalid verification state.`,
    );
  }
  if (result.data.state === "unavailable" && result.data.errorCategory === null) {
    throw new Error(
      `Unavailable Docling service ${result.data.id} has no error category.`,
    );
  }
  return {
    baseUrl: result.data.baseUrl,
    capabilitiesFingerprint: result.data.capabilitiesFingerprint,
    capacity: result.data.capacity,
    errorCategory: result.data.errorCategory,
    id: result.data.id,
    lastVerifiedAt: result.data.lastVerifiedAt,
    process: decodeDoclingProcessConfiguration(result.data.processConfig),
    serviceIdentity: identity,
    state: result.data.state,
    verificationConfigFingerprint:
      result.data.verificationConfigFingerprint,
  };
}

function validateServiceMutation(
  existing: DecodedServiceRow | undefined,
  configured: DoclingServiceInstanceConfig,
  assignedSlots: ReadonlySet<number>,
): void {
  if (existing === undefined || assignedSlots.size === 0) {
    return;
  }
  if (existing.baseUrl !== configured.baseUrl) {
    throw new Error(
      `Cannot change Docling service ${configured.id} base URL while jobs remain assigned.`,
    );
  }
  if (!sameProcessConfiguration(existing.process, configured.process)) {
    throw new Error(
      `Cannot change Docling service ${configured.id} process configuration while jobs remain assigned.`,
    );
  }
  const highestSlot = Math.max(...assignedSlots);
  if (highestSlot > configured.capacity) {
    throw new Error(
      `Cannot reduce Docling service ${configured.id} capacity below assigned slot ${highestSlot}.`,
    );
  }
}

function readAssignedSlots(
  rows: ReadonlyArray<{ serviceId: string | null; slot: number | null }>,
): Map<string, Set<number>> {
  const result = new Map<string, Set<number>>();
  for (const row of rows) {
    if (row.serviceId === null || row.slot === null) {
      throw new Error("Invalid incomplete Docling service assignment row.");
    }
    if (!Number.isInteger(row.slot) || row.slot < 1) {
      throw new Error(`Invalid Docling service slot ${row.slot}.`);
    }
    const slots = result.get(row.serviceId) ?? new Set<number>();
    if (slots.has(row.slot)) {
      throw new Error(`Duplicate Docling service slot ${row.serviceId}:${row.slot}.`);
    }
    slots.add(row.slot);
    result.set(row.serviceId, slots);
  }
  return result;
}

function selectAvailableService(
  services: readonly DecodedServiceRow[],
  occupiedByService: ReadonlyMap<string, ReadonlySet<number>>,
): { service: DecodedServiceRow; slot: number } | null {
  let selected: DecodedServiceRow | null = null;
  let selectedOccupancy = Number.POSITIVE_INFINITY;
  for (const service of services) {
    const occupied = occupiedByService.get(service.id) ?? new Set<number>();
    if (occupied.size >= service.capacity) {
      continue;
    }
    const occupancy = occupied.size / service.capacity;
    if (selected === null || occupancy < selectedOccupancy) {
      selected = service;
      selectedOccupancy = occupancy;
    }
  }
  if (selected === null) {
    return null;
  }
  const occupied = occupiedByService.get(selected.id) ?? new Set<number>();
  for (let slot = 1; slot <= selected.capacity; slot += 1) {
    if (!occupied.has(slot)) {
      return { service: selected, slot };
    }
  }
  throw new Error(`Docling service ${selected.id} has inconsistent slot occupancy.`);
}

async function readAssignment(
  database: CiteLoomDatabase,
  serviceId: string,
  slot: number,
): Promise<DoclingServiceAssignment> {
  const values = await database
    .select({
      baseUrl: doclingServiceInstances.baseUrl,
      capabilitiesFingerprint: doclingServiceInstances.capabilitiesFingerprint,
      capacity: doclingServiceInstances.capacity,
      errorCategory: doclingServiceInstances.errorCategory,
      id: doclingServiceInstances.id,
      lastVerifiedAt: doclingServiceInstances.lastVerifiedAt,
      processConfig: doclingServiceInstances.processConfig,
      serviceIdentity: doclingServiceInstances.serviceIdentity,
      state: doclingServiceInstances.state,
      verificationConfigFingerprint:
        doclingServiceInstances.verificationConfigFingerprint,
    })
    .from(doclingServiceInstances)
    .where(eq(doclingServiceInstances.id, serviceId))
    .limit(1)
    .for("update");
  const value = values[0];
  if (value === undefined) {
    throw new Error(`Assigned Docling service ${serviceId} is missing.`);
  }
  const service = decodeServiceRow(value);
  if (slot > service.capacity) {
    throw new Error(`Assigned Docling slot ${serviceId}:${slot} exceeds capacity.`);
  }
  return createAssignment(service, slot);
}

function createAssignment(
  service: DecodedServiceRow,
  slot: number,
): DoclingServiceAssignment {
  if (
    service.state === "unavailable"
    || service.errorCategory !== null
    || service.capabilitiesFingerprint === null
    || service.lastVerifiedAt === null
    || service.serviceIdentity === null
    || service.verificationConfigFingerprint === null
  ) {
    throw new DoclingCapacityUnavailableError(
      `Assigned Docling service ${service.id} is not currently available and compatible.`,
    );
  }
  return {
    baseUrl: service.baseUrl,
    id: service.id,
    process: service.process,
    serviceIdentity: service.serviceIdentity,
    slot,
    state: service.state,
  };
}

async function lockRegistry(database: CiteLoomDatabase): Promise<void> {
  await database.execute(sql`
    SELECT pg_advisory_xact_lock(hashtext(${REGISTRY_LOCK_KEY}))
  `);
}

function sameProcessConfiguration(
  left: DoclingProcessConfiguration,
  right: DoclingProcessConfiguration,
): boolean {
  return left.numThreads === right.numThreads
    && left.pageBatchSize === right.pageBatchSize
    && left.profilePipelineTimings === right.profilePipelineTimings;
}

function isHttpUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}
