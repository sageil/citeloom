import { readJsonResponse } from "./boundary-readers.js";

export function registerPage(alpine) {
  alpine.data("citeloomLoginPage", () => ({
    busy: false,
    confirmPassword: "",
    errorMessage: "",
    password: "",
    passwordVisible: false,
    remembered: false,
    resetMode: false,
    setupMode: false,
    setupToken: null,
    username: "",

    initialize() {
      const setupToken = new URL(window.location.href).searchParams.get("setup");
      if (setupToken !== null && setupToken !== "") {
        this.setupMode = true;
        this.setupToken = setupToken;
        this.resetMode = new URL(window.location.href).searchParams.get("mode") === "reset";
      }
    },

    pageTitle() {
      if (this.resetMode) {
        return "Reset your password";
      }
      return this.setupMode ? "Set your password" : "Enter your workspace";
    },

    pageDescription() {
      if (this.setupMode) {
        return this.resetMode
          ? "Choose a new password for your CiteLoom account."
          : "Choose a password to activate your CiteLoom account.";
      }
      return "Your documents and research remain private to this configured environment.";
    },

    passwordToggleLabel() {
      return this.passwordVisible ? "Hide password" : "Show password";
    },

    passwordType() {
      return this.passwordVisible ? "text" : "password";
    },

    togglePasswordVisibility() {
      this.passwordVisible = !this.passwordVisible;
    },

    async submit() {
      if (this.busy) {
        return;
      }
      this.errorMessage = "";
      if (this.setupMode && this.password !== this.confirmPassword) {
        this.errorMessage = "The passwords do not match.";
        return;
      }
      const endpoint = this.setupMode ? "/api/auth/setup" : "/api/auth/login";
      const payload = this.setupMode
        ? { password: this.password, setupToken: this.setupToken }
        : {
            password: this.password,
            remember: this.remembered,
            username: this.username,
          };
      this.busy = true;
      try {
        const response = await fetch(endpoint, {
          body: JSON.stringify(payload),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        });
        await readJsonResponse(response, "Authentication");
        window.location.assign("/overview");
      } catch (error) {
        this.errorMessage = error instanceof Error
          ? error.message
          : "Authentication could not be completed.";
      } finally {
        this.busy = false;
      }
    },
  }));
}
