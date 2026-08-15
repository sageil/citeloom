import type {
  RuntimeSettingKey,
} from "../config/index.js";
import type { ProviderCapability } from "../providers/profiles.js";

export type RuntimeSettingGroup =
  | "Database"
  | "Docling"
  | "Hughes Hallucination Evaluation Model"
  | "MCP"
  | "Document processing"
  | "Search and answers"
  | "Embedding space"
  | "Search ranking"
  | "Speech input"
  | "Spoken answers"
  | "Web server"
  | "Usage diagnostics";

export type RuntimeSettingInput =
  | "boolean"
  | "json"
  | "number"
  | "password"
  | "select"
  | "text"
  | "url";

export interface RuntimeSettingOption {
  label: string;
  value: string | number;
}

export interface RuntimeSettingPanel {
  description: string;
  id: string;
  label: string;
}

export interface RuntimeSettingDefinition {
  description: string;
  feature?: ProviderCapability;
  group: RuntimeSettingGroup;
  input: RuntimeSettingInput;
  key: RuntimeSettingKey;
  label: string;
  providerManagedSetting?: boolean;
  nullable?: boolean;
  max?: number;
  min?: number;
  options?: RuntimeSettingOption[];
  panel?: RuntimeSettingPanel;
  sensitive?: boolean;
  step?: number;
  unit?: string;
  workspaceConfigurable?: boolean;
}

export function setting(
  key: RuntimeSettingKey,
  group: RuntimeSettingGroup,
  label: string,
  input: RuntimeSettingInput,
  description: string,
): RuntimeSettingDefinition {
  return { description, group, input, key, label };
}

export function featureSetting(
  definition: RuntimeSettingDefinition,
  feature: ProviderCapability,
): RuntimeSettingDefinition {
  return { ...definition, feature };
}

export function panelSetting(
  definition: RuntimeSettingDefinition,
  panel: RuntimeSettingPanel,
): RuntimeSettingDefinition {
  return { ...definition, panel };
}

export function workspaceSetting(
  definition: RuntimeSettingDefinition,
): RuntimeSettingDefinition {
  return { ...definition, workspaceConfigurable: true };
}

export function sensitiveSetting(
  key: RuntimeSettingKey,
  group: RuntimeSettingGroup,
  label: string,
  description: string,
): RuntimeSettingDefinition {
  return {
    description,
    group,
    input: "password",
    key,
    label,
    nullable: true,
    sensitive: true,
  };
}

export function nullableSetting(
  key: RuntimeSettingKey,
  group: RuntimeSettingGroup,
  label: string,
  input: RuntimeSettingInput,
  description: string,
): RuntimeSettingDefinition {
  return { description, group, input, key, label, nullable: true };
}

export function numberSetting(
  key: RuntimeSettingKey,
  group: RuntimeSettingGroup,
  label: string,
  description: string,
  min: number,
  max: number,
  step: number,
  unit?: string,
): RuntimeSettingDefinition {
  const definition: RuntimeSettingDefinition = {
    description,
    group,
    input: "number",
    key,
    label,
    max,
    min,
    step,
  };
  if (unit !== undefined) {
    definition.unit = unit;
  }
  return definition;
}

export function positiveIntegerSetting(
  key: RuntimeSettingKey,
  group: RuntimeSettingGroup,
  label: string,
  description: string,
  unit: string,
): RuntimeSettingDefinition {
  return {
    description,
    group,
    input: "number",
    key,
    label,
    min: 1,
    step: 1,
    unit,
  };
}

export function selectSetting(
  key: RuntimeSettingKey,
  group: RuntimeSettingGroup,
  label: string,
  description: string,
  options: RuntimeSettingOption[],
): RuntimeSettingDefinition {
  return {
    description,
    group,
    input: "select",
    key,
    label,
    options,
  };
}
