import { fileURLToPath } from "node:url";

import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";

import { OAUTH_BROWSER_CALLBACK_PATH } from "../oauth/application-configuration.js";
import { APP_SECTION_ROUTES } from "./app-routes.js";
import { readBrowserVendorAssets } from "./browser-security.js";

export const DEFAULT_BROWSER_STATIC_DIRECTORY = fileURLToPath(
  new URL("../../web", import.meta.url),
);

export async function registerBrowserApplicationRoutes(
  server: FastifyInstance,
  staticDirectory: string,
): Promise<void> {
  const vendorAssets = await readBrowserVendorAssets();
  for (const asset of vendorAssets) {
    server.get(asset.route, async (_request, reply) => {
      return reply
        .header("Cache-Control", "public, max-age=31536000, immutable")
        .type("application/javascript; charset=utf-8")
        .send(asset.content);
    });
  }
  await server.register(fastifyStatic, {
    index: false,
    root: staticDirectory,
  });
  server.get("/", async (_request, reply) => {
    return reply.sendFile("index.html");
  });
  server.get(OAUTH_BROWSER_CALLBACK_PATH, async (_request, reply) => {
    return reply.sendFile("index.html");
  });
  for (const route of APP_SECTION_ROUTES) {
    server.get(route, async (_request, reply) => {
      return reply.sendFile("index.html");
    });
  }
}
