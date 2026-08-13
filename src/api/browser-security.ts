import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

export const BROWSER_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "connect-src 'self' https:",
  "font-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "img-src 'self' data: blob:",
  "manifest-src 'self'",
  "media-src 'self' blob:",
  "object-src 'none'",
  "script-src 'self' 'unsafe-eval'",
  "style-src-attr 'unsafe-inline'",
  "style-src-elem 'self'",
].join("; ");

interface BrowserVendorAssetDefinition {
  moduleSpecifier: string;
  relativePath: string;
  route: string;
}

export interface BrowserVendorAsset {
  content: Buffer;
  route: string;
}

const browserVendorAssetDefinitions: readonly BrowserVendorAssetDefinition[] = [
  {
    moduleSpecifier: "htmx.org",
    relativePath: "htmx.min.js",
    route: "/assets/vendor/htmx.min.js",
  },
  {
    moduleSpecifier: "marked",
    relativePath: "marked.umd.js",
    route: "/assets/vendor/marked.umd.js",
  },
  {
    moduleSpecifier: "dompurify",
    relativePath: "purify.min.js",
    route: "/assets/vendor/purify.min.js",
  },
  {
    moduleSpecifier: "alpinejs",
    relativePath: "cdn.min.js",
    route: "/assets/vendor/alpine.min.js",
  },
];

export async function readBrowserVendorAssets(): Promise<BrowserVendorAsset[]> {
  const assets: BrowserVendorAsset[] = [];
  for (const definition of browserVendorAssetDefinitions) {
    const moduleFile = require.resolve(definition.moduleSpecifier);
    const content = await readFile(join(dirname(moduleFile), definition.relativePath));
    assets.push({ content, route: definition.route });
  }
  return assets;
}
