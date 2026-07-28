import { readJsonResponse } from "./citeloom-boundaries.js";
import { dispatchNotice } from "./citeloom-notices.js";

export function registerPage(alpine) {
  alpine.data("citeloomAccountPage", () => ({
    busy: false,
    confirmation: "",
    currentPassword: "",
    errorMessage: "",
    newPassword: "",
    passwordFormOpen: false,
    successMessage: "",

    closePasswordForm() {
      this.currentPassword = "";
      this.newPassword = "";
      this.confirmation = "";
      this.errorMessage = "";
      this.passwordFormOpen = false;
    },

    openPasswordForm() {
      this.passwordFormOpen = true;
      this.successMessage = "";
    },

    async changePassword() {
      this.errorMessage = "";
      this.successMessage = "";
      if (this.newPassword !== this.confirmation) {
        this.errorMessage = "The new passwords do not match.";
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
        this.successMessage = "Your password has been changed.";
        this.passwordFormOpen = false;
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
