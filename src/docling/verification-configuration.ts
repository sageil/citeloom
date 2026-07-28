import { createHash } from "node:crypto";

import type { DoclingServiceInstanceConfig } from "../config/index.js";

export type DoclingServiceTopologyState = "configured" | "draining";

export function fingerprintDoclingVerificationConfiguration(
  settingsVersion: number,
  service: DoclingServiceInstanceConfig,
  topologyState: DoclingServiceTopologyState,
): string {
  const serialized = JSON.stringify({
    service: {
      baseUrl: service.baseUrl,
      capacity: service.capacity,
      id: service.id,
      process: service.process,
    },
    settingsVersion,
    topologyState,
  });
  return createHash("sha256").update(serialized).digest("hex");
}
