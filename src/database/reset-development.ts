import { Pool } from "pg";

import { readDatabaseConfig } from "../config/index.js";
import { setupDatabase } from "./setup.js";

const developmentDatabaseName = "citeloom";

async function resetDevelopmentDatabase(): Promise<void> {
  const config = readDatabaseConfig();
  const databaseUrl = readSafeDevelopmentDatabaseUrl(config.url);
  const maintenanceUrl = new URL(databaseUrl);
  maintenanceUrl.pathname = "/postgres";
  maintenanceUrl.search = "";
  maintenanceUrl.hash = "";

  const maintenancePool = new Pool({
    connectionString: maintenanceUrl.toString(),
    max: 1,
  });
  try {
    await maintenancePool.query(
      `DROP DATABASE IF EXISTS "${developmentDatabaseName}" WITH (FORCE)`,
    );
    await maintenancePool.query(`CREATE DATABASE "${developmentDatabaseName}"`);
  } finally {
    await maintenancePool.end();
  }

  await setupDatabase(config);
}

function readSafeDevelopmentDatabaseUrl(value: string): URL {
  if (process.env.NODE_ENV === "production") {
    throw new Error("Development database reset is disabled in production.");
  }
  const url = new URL(value);
  const localHosts = new Set(["127.0.0.1", "::1", "localhost"]);
  if (!localHosts.has(url.hostname)) {
    throw new Error(
      `Development database reset requires a local database host, received ${url.hostname}.`,
    );
  }
  const databaseName = decodeURIComponent(url.pathname.slice(1));
  if (databaseName !== developmentDatabaseName) {
    throw new Error(
      `Development database reset requires database ${developmentDatabaseName}, received ${databaseName || "none"}.`,
    );
  }
  return url;
}

await resetDevelopmentDatabase();
console.log("Development database was recreated from the schema and bootstrap SQL.");
