import {
  ApplicationSettingsRepository,
  type EffectiveApplicationSettings,
} from "../../src/app/settings.js";
import type { AppConfig } from "../../src/config/index.js";
import { openDatabase } from "../../src/database/client.js";

export async function readEffectiveEvaluationConfig(
  database: AppConfig["database"],
): Promise<EffectiveApplicationSettings> {
  const session = await openDatabase(database);
  try {
    const repository = new ApplicationSettingsRepository(session.database);
    return await repository.read(database);
  } finally {
    await session.close();
  }
}
