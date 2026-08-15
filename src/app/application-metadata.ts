import { readFileSync } from "node:fs";

import { z } from "zod";

const applicationPackageSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
}).passthrough();

export interface ApplicationMetadata {
  name: string;
  version: string;
}

export function readApplicationMetadata(): ApplicationMetadata {
  const packageUrl = new URL("../../package.json", import.meta.url);
  const contents = readFileSync(packageUrl, "utf8");
  const metadata = applicationPackageSchema.parse(JSON.parse(contents));
  return { name: metadata.name, version: metadata.version };
}

export const applicationMetadata = readApplicationMetadata();
