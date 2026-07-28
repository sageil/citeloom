import {
  readDatabaseEnvironment,
  readDoclingServiceTopology,
} from "./schemas.js";
import type {
  DatabaseConfig,
  StartupConfig,
} from "./types.js";

export function readStartupConfig(
  environment: NodeJS.ProcessEnv = process.env,
): StartupConfig {
  return {
    database: readDatabaseEnvironment(environment),
    doclingTopology: readDoclingServiceTopology(environment),
  };
}

export function readDatabaseConfig(
  environment: NodeJS.ProcessEnv = process.env,
): DatabaseConfig {
  return readDatabaseEnvironment(environment);
}
