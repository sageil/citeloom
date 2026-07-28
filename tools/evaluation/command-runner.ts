import { unlink } from "node:fs/promises";

import {
  ApplicationSettingsRepository,
  type EffectiveApplicationSettings,
} from "../../src/app/settings.js";
import {
  readStartupConfig,
  type AppConfig,
  type DoclingServiceTopology,
} from "../../src/config/index.js";
import { openDatabase } from "../../src/database/client.js";
import {
  printEvaluationResult,
  printEvaluationTuningSelection,
  printHelp,
  printProgress,
} from "./command-output.js";
import { parseEvaluationCommand } from "./command-parser.js";

export async function main(arguments_: string[] = process.argv.slice(2)): Promise<void> {
  const command = parseEvaluationCommand(arguments_);
  if (command.name === "help") {
    printHelp();
    return;
  }

  if (command.name === "score-evaluation") {
    const {
      readEvaluationPreparationArtifact,
    } = await import("./artifact.js");
    const {
      scorePreparedEvaluation,
      writeEvaluationResult,
    } = await import("./index.js");
    const preparation = await readEvaluationPreparationArtifact(
      command.preparationPath,
    );
    const result = scorePreparedEvaluation(preparation);
    printEvaluationResult(result);
    if (command.outputPath !== null) {
      await writeEvaluationResult(command.outputPath, result);
      console.log(`\nWrote evaluation result to ${command.outputPath}`);
    }
    return;
  }

  if (command.name === "evaluate-claims") {
    const {
      evaluateAuditedClaims,
      writeClaimEvaluationReport,
    } = await import("./claim-evaluation.js");
    const report = await evaluateAuditedClaims(command.datasetPath);
    await writeClaimEvaluationReport(command.outputPath, report);
    console.log(JSON.stringify(report, null, 2));
    console.log(`\nWrote claim evaluation report to ${command.outputPath}`);
    return;
  }

  if (command.name === "select-answer-threshold") {
    const {
      readAnswerThresholdPreparation,
      selectAnswerThreshold,
      writeAnswerThresholdSelection,
    } = await import("./answer-threshold.js");
    const preparations = [];
    for (const preparationPath of command.preparationPaths) {
      preparations.push(await readAnswerThresholdPreparation(preparationPath));
    }
    const selection = selectAnswerThreshold(
      preparations,
      command.maximumFalseAcceptanceRate,
    );
    await writeAnswerThresholdSelection(command.outputPath, selection);
    console.log(JSON.stringify(selection, null, 2));
    console.log(`\nWrote answer-threshold selection to ${command.outputPath}`);
    return;
  }

  const startup = readStartupConfig();
  const effectiveSettings = await readEffectiveCliConfig(
    startup.database,
    startup.doclingTopology,
  );
  let config = effectiveSettings.config;
  if (command.name === "tune-evaluation") {
    const { readEvaluationCodeIdentity } = await import("./code-identity.js");
    const {
      readEvaluationPreparationArtifact,
    } = await import("./artifact.js");
    const {
      writeEvaluationConfigurationFreeze,
    } = await import("./freeze.js");
    const {
      readEvaluationTuningSpecification,
      runEvaluationTuning,
      writeEvaluationTuningSelection,
    } = await import("./tuning.js");
    const preparations = [];
    for (const preparationPath of command.preparationPaths) {
      preparations.push(await readEvaluationPreparationArtifact(preparationPath));
    }
    const specification = await readEvaluationTuningSpecification(
      command.specificationPath,
    );
    const run = runEvaluationTuning(
      config,
      await readEvaluationCodeIdentity(),
      effectiveSettings.version,
      preparations,
      specification,
    );
    await writeEvaluationConfigurationFreeze(
      command.freezeOutputPath,
      run.freeze,
    );
    try {
      await writeEvaluationTuningSelection(command.outputPath, run.selection);
    } catch (error: unknown) {
      try {
        await unlink(command.freezeOutputPath);
      } catch (rollbackError: unknown) {
        throw new AggregateError(
          [error, rollbackError],
          "Writing the tuning selection failed and its frozen configuration could not be removed.",
        );
      }
      throw error;
    }
    printEvaluationTuningSelection(run.selection);
    console.log(`\nWrote tuning selection to ${command.outputPath}`);
    console.log(`Wrote frozen selected configuration to ${command.freezeOutputPath}`);
    return;
  }
  if (command.name === "freeze-evaluation-configuration") {
    const { readEvaluationCodeIdentity } = await import("./code-identity.js");
    const {
      createEvaluationConfigurationFreeze,
      writeEvaluationConfigurationFreeze,
    } = await import("./freeze.js");
    const freeze = createEvaluationConfigurationFreeze(
      config,
      await readEvaluationCodeIdentity(),
      effectiveSettings.version,
    );
    await writeEvaluationConfigurationFreeze(command.outputPath, freeze);
    console.log(`Wrote frozen evaluation configuration to ${command.outputPath}`);
    return;
  }
  if (command.name === "evaluate") {
    const { readEvaluationCodeIdentity } = await import("./code-identity.js");
    const {
      evaluateRetrieval,
      writeEvaluationResult,
    } = await import("./index.js");
    const {
      writeEvaluationPreparationArtifact,
    } = await import("./artifact.js");
    const {
      readEvaluationConfigurationFreeze,
    } = await import("./freeze.js");
    const codeRevision = await readEvaluationCodeIdentity();
    const frozenConfiguration = command.frozenConfigurationPath === null
      ? null
      : await readEvaluationConfigurationFreeze(
        command.frozenConfigurationPath,
      );
    if (command.tuningSelectionPath !== null) {
      if (frozenConfiguration === null) {
        throw new Error(
          "A tuning selection requires its frozen evaluation configuration.",
        );
      }
      const {
        applyEvaluationTuningSelection,
        readEvaluationTuningSelection,
      } = await import("./tuning.js");
      const selection = await readEvaluationTuningSelection(
        command.tuningSelectionPath,
      );
      config = applyEvaluationTuningSelection(
        config,
        codeRevision,
        effectiveSettings.version,
        selection,
        frozenConfiguration,
      );
    }
    const run = await evaluateRetrieval(
      config,
      command.datasetPath,
      {
        codeRevision,
        frozenConfiguration,
        settingsVersion: effectiveSettings.version,
      },
      printProgress,
    );
    await writeEvaluationPreparationArtifact(
      command.preparationOutputPath,
      run.preparation,
    );
    console.log(
      `\nWrote evaluation preparation to ${command.preparationOutputPath}`,
    );
    printEvaluationResult(run.result);
    if (command.outputPath !== null) {
      await writeEvaluationResult(command.outputPath, run.result);
      console.log(`\nWrote evaluation result to ${command.outputPath}`);
    }
    return;
  }

  if (command.name === "prepare-answer-threshold-calibration") {
    const { readEvaluationCodeIdentity } = await import("./code-identity.js");
    const {
      writeAnswerThresholdPreparation,
    } = await import("./answer-threshold.js");
    const {
      prepareAnswerThresholdCalibration,
    } = await import("./preparation.js");
    const preparation = await prepareAnswerThresholdCalibration(
      config,
      command.datasetPath,
      command.negativeDomain,
      {
        codeRevision: await readEvaluationCodeIdentity(),
        frozenConfiguration: null,
        settingsVersion: effectiveSettings.version,
      },
      printProgress,
    );
    await writeAnswerThresholdPreparation(command.outputPath, preparation);
    console.log(
      `\nWrote answer-threshold preparation to ${command.outputPath}`,
    );
    return;
  }

  if (command.name === "generate-evaluation") {
    const { generateEvaluationDataset } = await import(
      "./generator.js"
    );
    const { writeEvaluationDataset } = await import(
      "./dataset.js"
    );
    const dataset = await generateEvaluationDataset(
      config,
      {
        atK: command.atK,
        caseCount: command.caseCount,
        domain: command.domain,
        enrich: command.enrich,
        language: command.language,
        questionType: command.questionType,
        scope: command.scope,
        seed: command.seed,
        split: command.split,
        statisticalDesign: command.statisticalDesign,
      },
      printProgress,
    );
    await writeEvaluationDataset(
      command.outputPath,
      dataset,
      command.overwrite,
    );
    console.log(
      `Wrote ${dataset.cases.length} ${dataset.split} cases to ${command.outputPath}`,
    );
    return;
  }
}

async function readEffectiveCliConfig(
  database: AppConfig["database"],
  doclingTopology: DoclingServiceTopology,
): Promise<EffectiveApplicationSettings> {
  const session = await openDatabase(database);
  try {
    const repository = new ApplicationSettingsRepository(session.database);
    return await repository.read(
      database,
      doclingTopology,
    );
  } finally {
    await session.close();
  }
}
