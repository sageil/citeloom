import {
  readBoolean,
  readJsonResponse,
  readPlainObject,
  readPositiveInteger,
} from "./boundary-readers.js";

function readPasswordPolicy(value) {
  const policy = readPlainObject(value, "password policy");
  const minimumPasswordLength = readPositiveInteger(
    policy.minimumPasswordLength,
    "minimum password length",
  );
  if (minimumPasswordLength < 9 || minimumPasswordLength > 64) {
    throw new Error("The minimum password length response is invalid.");
  }
  return {
    minimumPasswordLength,
    requireLetterAndNumber: readBoolean(
      policy.requireLetterAndNumber,
      "letter and number requirement",
    ),
    requireSpecialCharacter: readBoolean(
      policy.requireSpecialCharacter,
      "special character requirement",
    ),
  };
}

export function registerPage(alpine) {
  alpine.data("citeloomAccountPage", () => ({
    busy: false,
    confirmation: "",
    currentPassword: "",
    errorMessage: "",
    minimumPasswordLength: null,
    newPassword: "",
    passwordFormOpen: false,
    requireLetterAndNumber: null,
    requireSpecialCharacter: null,

    get passwordRequirementSummary() {
      if (this.minimumPasswordLength === null) {
        return "Loading requirements…";
      }
      const requirements = [`At least ${this.minimumPasswordLength} characters`];
      if (this.requireLetterAndNumber) {
        requirements.push("one letter and one number");
      }
      if (this.requireSpecialCharacter) {
        requirements.push("one special character");
      }
      return requirements.join(", ");
    },

    initialize() {
      void this.loadPasswordPolicy();
    },

    closePasswordForm() {
      this.currentPassword = "";
      this.newPassword = "";
      this.confirmation = "";
      this.errorMessage = "";
      this.passwordFormOpen = false;
    },

    openPasswordForm() {
      if (this.minimumPasswordLength === null) {
        return;
      }
      this.errorMessage = "";
      this.passwordFormOpen = true;
    },

    async loadPasswordPolicy() {
      try {
        const response = await fetch("/api/auth/password-policy", {
          headers: { accept: "application/json" },
        });
        const value = await readJsonResponse(response, "Password policy");
        const policy = readPasswordPolicy(value);
        this.minimumPasswordLength = policy.minimumPasswordLength;
        this.requireLetterAndNumber = policy.requireLetterAndNumber;
        this.requireSpecialCharacter = policy.requireSpecialCharacter;
      } catch (error) {
        this.errorMessage = error instanceof Error
          ? error.message
          : "Password policy could not be loaded.";
      }
    },

    async changePassword() {
      if (this.minimumPasswordLength === null) {
        this.errorMessage = "Password requirements are still loading.";
        return;
      }
      if (this.newPassword !== this.confirmation) {
        this.errorMessage = "The new passwords do not match.";
        return;
      }
      this.busy = true;
      this.errorMessage = "";
      try {
        const response = await fetch("/api/auth/password", {
          body: JSON.stringify({
            currentPassword: this.currentPassword,
            newPassword: this.newPassword,
          }),
          headers: { "Content-Type": "application/json" },
          method: "PUT",
        });
        if (!response.ok) {
          await readJsonResponse(response, "Password change");
        }
        this.currentPassword = "";
        this.newPassword = "";
        this.confirmation = "";
        this.passwordFormOpen = false;
      } catch (error) {
        this.errorMessage = error instanceof Error
          ? error.message
          : "Your password could not be changed.";
      } finally {
        this.busy = false;
      }
    },
  }));
}
