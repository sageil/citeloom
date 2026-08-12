export const DEFAULT_WORKSPACE_SECURITY_POLICY = {
  minimumPasswordLength: 15,
  requireLetterAndNumber: false,
  requireSpecialCharacter: false,
  resetLinkLifetimeSeconds: 24 * 60 * 60,
  version: 1,
} as const;

export const DEFAULT_PASSWORD_REQUIREMENTS = {
  minimumPasswordLength: DEFAULT_WORKSPACE_SECURITY_POLICY.minimumPasswordLength,
  requireLetterAndNumber: DEFAULT_WORKSPACE_SECURITY_POLICY.requireLetterAndNumber,
  requireSpecialCharacter: DEFAULT_WORKSPACE_SECURITY_POLICY.requireSpecialCharacter,
} as const;
