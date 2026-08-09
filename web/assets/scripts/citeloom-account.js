import {
  readBoolean,
  readJsonResponse,
  readPlainObject,
  readPositiveInteger,
} from "./citeloom-boundaries.js";
import { dispatchNotice } from "./citeloom-notices.js";

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
    minimumPasswordLength: 15,
    newPassword: "",
    passwordFormOpen: false,
    requireLetterAndNumber: false,
    requireSpecialCharacter: false,

    get passwordRequirementSummary() {
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
      this.passwordFormOpen = false;
    },

    openPasswordForm() {
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
        dispatchNotice(
          "error",
          error instanceof Error ? error.message : "Password policy could not be loaded.",
        );
      }
    },

    async changePassword() {
      if (this.newPassword !== this.confirmation) {
        dispatchNotice("error", "The new passwords do not match.");
        return;
      }
      this.busy = true;
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
        dispatchNotice("success", "Your password has been changed.");
      } catch (error) {
        dispatchNotice(
          "error",
          error instanceof Error
            ? error.message
            : "Your password could not be changed.",
        );
      } finally {
        this.busy = false;
      }
    },
  }));
}
