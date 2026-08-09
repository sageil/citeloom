const supportedViews = new Set([
  "account",
  "ask",
  "chat",
  "documents",
  "errors",
  "help",
  "login",
  "overview",
  "security",
  "settings",
  "system-health",
]);

const parameters = new URLSearchParams(window.location.search);
const queryView = parameters.get("view");
const requestedPathView = window.location.pathname.slice(1);
const pathView = requestedPathView === "users" ? "security" : requestedPathView;
let initialView = "overview";
if (queryView !== null && supportedViews.has(queryView)) {
  initialView = queryView;
} else if (supportedViews.has(pathView)) {
  initialView = pathView;
}

const workspace = document.getElementById("workspace");
if (workspace instanceof HTMLElement) {
  workspace.setAttribute("hx-get", `./fragments/${initialView}.html`);
}
