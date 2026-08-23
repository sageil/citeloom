import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";
import type { FastifyInstance } from "fastify";

import { buildWebServer } from "../src/web-server.js";
import {
  buildConfig,
  buildServices,
} from "../test/web-server-fixture.js";

const staticDirectory = fileURLToPath(new URL("../web", import.meta.url));

let baseUrl: string;
let server: FastifyInstance | null = null;

test.beforeAll(async () => {
  server = await buildWebServer(buildConfig(), {
    authentication: "disabled",
    logger: false,
    services: buildServices(),
    staticDirectory,
  });
  baseUrl = await server.listen({ host: "127.0.0.1", port: 0 });
});

test.afterAll(async () => {
  if (server !== null) {
    await server.close();
  }
});

test("shows the Documents page after primary browser navigation", async ({
  page,
}) => {
  const browserErrors: Error[] = [];
  page.on("pageerror", (error) => {
    browserErrors.push(error);
  });
  await page.goto(baseUrl);
  const navigation = page.getByRole("navigation", {
    name: "Primary workspace",
  });
  const documentsLink = navigation.getByRole("link", { name: "Documents" });
  const fragmentResponse = page.waitForResponse((response) => {
    return new URL(response.url()).pathname === "/fragments/documents.html";
  });

  await documentsLink.click();
  await fragmentResponse;

  await expect(page).toHaveTitle("Documents | CiteLoom");
  await expect(page).toHaveURL(/\?view=documents$/u);
  await expect(documentsLink).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("region", { name: "Documents page" })).toBeVisible();
  expect(browserErrors).toEqual([]);
});
