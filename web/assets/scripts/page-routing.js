const defaultView = "overview";
const helpAnchorPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export const routes = Object.freeze({
  account: {
    fragment: "./fragments/account.html",
    pageScript: { id: "account", source: "./account.js" },
    pageStyles: ["./assets/styles/citeloom-access.css"],
    title: "Account | CiteLoom",
  },
  ask: {
    fragment: "./fragments/ask.html",
    pageScript: { id: "ask", source: "./ask.js" },
    pageStyles: [
      "./assets/styles/citeloom-answer-content.css",
      "./assets/styles/citeloom-evidence-table.css",
      "./assets/styles/citeloom-evidence-ui.css",
      "./assets/styles/citeloom-ask.css",
    ],
    title: "Ask | CiteLoom",
  },
  chat: {
    fragment: "./fragments/chat.html",
    pageScript: { id: "chat", source: "./chat.js" },
    pageStyles: [
      "./assets/styles/citeloom-answer-content.css",
      "./assets/styles/citeloom-evidence-table.css",
      "./assets/styles/citeloom-evidence-ui.css",
      "./assets/styles/citeloom-chat.css",
    ],
    title: "Chat | CiteLoom",
  },
  documents: {
    fragment: "./fragments/documents.html",
    pageScript: { id: "documents", source: "./documents.js" },
    pageStyles: ["./assets/styles/citeloom-documents.css"],
    title: "Documents | CiteLoom",
  },
  errors: {
    fragment: "./fragments/errors.html",
    pageScript: { id: "errors", source: "./errors.js" },
    pageStyles: ["./assets/styles/citeloom-errors.css"],
    title: "Error reports | CiteLoom",
  },
  help: {
    fragment: "./fragments/help.html",
    pageScript: null,
    pageStyles: ["./assets/styles/citeloom-help.css"],
    title: "Help | CiteLoom",
  },
  login: {
    fragment: "./fragments/login.html",
    pageScript: { id: "login", source: "./login.js" },
    pageStyles: ["./assets/styles/citeloom-login.css"],
    title: "Sign in | CiteLoom",
  },
  overview: {
    fragment: "./fragments/overview.html",
    pageScript: { id: "overview", source: "./overview.js" },
    pageStyles: ["./assets/styles/citeloom-overview.css"],
    title: "CiteLoom",
  },
  security: {
    fragment: "./fragments/security.html",
    pageScript: { id: "security", source: "./security.js" },
    pageStyles: [
      "./assets/styles/citeloom-access.css",
      "./assets/styles/citeloom-security.css",
    ],
    title: "Security | CiteLoom",
  },
  settings: {
    fragment: "./fragments/settings.html",
    pageScript: { id: "settings", source: "./settings.js" },
    pageStyles: [
      "./assets/styles/citeloom-access.css",
      "./assets/styles/citeloom-settings.css",
      "./assets/styles/citeloom-settings-source-libraries.css",
    ],
    title: "Settings | CiteLoom",
  },
  "system-health": {
    fragment: "./fragments/system-health.html",
    pageScript: { id: "system-health", source: "./system-health.js" },
    pageStyles: ["./assets/styles/citeloom-system-health.css"],
    title: "System health | CiteLoom",
  },
});

const pathViews = Object.freeze({
  "/account": "account",
  "/ask": "ask",
  "/chat": "chat",
  "/documents": "documents",
  "/errors": "errors",
  "/help": "help",
  "/login": "login",
  "/overview": "overview",
  "/security": "security",
  "/settings": "settings",
  "/system-health": "system-health",
  "/users": "security",
});

const loadedPageScripts = new Set();
const loadedPageStyles = new Set();
const pageScriptPromises = new Map();
const pageStylePromises = new Map();
let pageNavigationGeneration = 0;

function readView(value) {
  if (typeof value === "string" && Object.hasOwn(routes, value)) {
    return value;
  }
  return defaultView;
}

export function readLocationView() {
  const parameters = new URLSearchParams(window.location.search);
  const queryView = parameters.get("view");
  if (queryView !== null) {
    return readView(queryView);
  }
  return readView(pathViews[window.location.pathname]);
}

export function readLocationAnchor() {
  const encodedAnchor = window.location.hash.slice(1);
  if (encodedAnchor === "") {
    return null;
  }

  let anchor;
  try {
    anchor = decodeURIComponent(encodedAnchor);
  } catch {
    return null;
  }

  return helpAnchorPattern.test(anchor) ? anchor : null;
}

function readHtmxWorkspaceRequest(event) {
  if (!(event instanceof CustomEvent)) {
    return null;
  }
  const detail = event.detail;
  if (typeof detail !== "object" || detail === null) {
    return null;
  }
  if (!(detail.target instanceof HTMLElement) || detail.target.id !== "workspace") {
    return null;
  }
  if (!(detail.elt instanceof HTMLElement) || typeof detail.issueRequest !== "function") {
    return null;
  }

  const requestedView = detail.elt.dataset.view;
  let view;
  if (requestedView !== undefined && Object.hasOwn(routes, requestedView)) {
    view = requestedView;
  } else if (detail.elt.id === "workspace") {
    view = readLocationView();
  } else {
    return null;
  }
  return {
    issueRequest(skipConfirmation) {
      detail.issueRequest(skipConfirmation);
    },
    view,
  };
}

function loadPageScript(pageScript) {
  if (loadedPageScripts.has(pageScript.id)) {
    return Promise.resolve();
  }
  const existingPromise = pageScriptPromises.get(pageScript.id);
  if (existingPromise !== undefined) {
    return existingPromise;
  }

  const promise = import(pageScript.source).then((pageModule) => {
    if (typeof pageModule.registerPage !== "function") {
      throw new Error(`The ${pageScript.id} page module did not export registerPage.`);
    }
    if (window.Alpine === undefined) {
      throw new Error(`The ${pageScript.id} page module loaded before Alpine.`);
    }
    pageModule.registerPage(window.Alpine);
    loadedPageScripts.add(pageScript.id);
  });
  pageScriptPromises.set(pageScript.id, promise);
  void promise.catch(() => {
    pageScriptPromises.delete(pageScript.id);
  });
  return promise;
}

function loadPageStyle(source) {
  if (loadedPageStyles.has(source)) {
    return Promise.resolve();
  }
  const existingPromise = pageStylePromises.get(source);
  if (existingPromise !== undefined) {
    return existingPromise;
  }

  const promise = new Promise((resolve, reject) => {
    const link = document.createElement("link");
    link.dataset.citeloomPageStyle = source;
    link.href = source;
    link.rel = "stylesheet";

    function cleanup() {
      link.removeEventListener("error", handleError);
      link.removeEventListener("load", handleLoad);
    }
    function handleError() {
      cleanup();
      link.remove();
      reject(new Error(`The page stylesheet ${source} could not be loaded.`));
    }
    function handleLoad() {
      loadedPageStyles.add(source);
      cleanup();
      resolve();
    }

    link.addEventListener("error", handleError);
    link.addEventListener("load", handleLoad);
    document.head.append(link);
  });
  pageStylePromises.set(source, promise);
  void promise.catch(() => {
    pageStylePromises.delete(source);
  });
  return promise;
}

function routeResourcesLoaded(route) {
  for (const source of route.pageStyles) {
    if (!loadedPageStyles.has(source)) {
      return false;
    }
  }
  return route.pageScript === null || loadedPageScripts.has(route.pageScript.id);
}

function loadRouteResources(route) {
  const resourcePromises = [];
  for (const source of route.pageStyles) {
    resourcePromises.push(loadPageStyle(source));
  }
  if (route.pageScript !== null) {
    resourcePromises.push(loadPageScript(route.pageScript));
  }
  return Promise.all(resourcePromises);
}

function showPageLoadError(error) {
  const workspace = document.getElementById("workspace");
  if (workspace === null) {
    return;
  }
  const message = error instanceof Error
    ? error.message
    : "The requested page resources could not be loaded.";
  const section = document.createElement("section");
  section.className = "empty-state";
  const heading = document.createElement("h1");
  heading.textContent = "This page could not be loaded";
  const description = document.createElement("p");
  description.textContent = message;
  const retryButton = document.createElement("button");
  retryButton.className = "button secondary";
  retryButton.type = "button";
  retryButton.textContent = "Try again";
  retryButton.addEventListener("click", () => window.location.reload());
  section.append(heading, description, retryButton);
  workspace.replaceChildren(section);
}

export function initializePageRouting() {
  document.addEventListener("htmx:confirm", (event) => {
    const request = readHtmxWorkspaceRequest(event);
    if (request === null) {
      return;
    }

    pageNavigationGeneration += 1;
    const requestGeneration = pageNavigationGeneration;
    const route = routes[request.view];
    if (routeResourcesLoaded(route)) {
      return;
    }

    event.preventDefault();
    void loadRouteResources(route).then(() => {
      if (requestGeneration === pageNavigationGeneration) {
        request.issueRequest(true);
      }
    }).catch((error) => {
      if (requestGeneration === pageNavigationGeneration) {
        showPageLoadError(error);
      }
    });
  });

  window.addEventListener("popstate", () => {
    pageNavigationGeneration += 1;
  });
}

export function configureInitialFragment() {
  const workspace = document.getElementById("workspace");
  if (workspace === null) {
    return;
  }
  const route = routes[readLocationView()];
  workspace.setAttribute("hx-get", route.fragment);
  document.title = route.title;
}
