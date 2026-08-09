export const APP_SECTION_PATHS = {
  account: "/account",
  ask: "/ask",
  chat: "/chat",
  documents: "/documents",
  errors: "/errors",
  help: "/help",
  login: "/login",
  overview: "/overview",
  security: "/security",
  settings: "/settings",
  "system-health": "/system-health",
  users: "/users",
} as const;

export type AppSectionName = keyof typeof APP_SECTION_PATHS;

export const APP_SECTION_ROUTES = Object.values(APP_SECTION_PATHS);

export function readAppSectionName(value: string | null): AppSectionName | null {
  switch (value) {
    case "account":
    case "ask":
    case "chat":
    case "documents":
    case "errors":
    case "help":
    case "login":
    case "overview":
    case "security":
    case "settings":
    case "system-health":
    case "users":
      return value;
    default:
      return null;
  }
}

export function readAppSectionPath(pathname: string): AppSectionName | null {
  switch (pathname) {
    case APP_SECTION_PATHS.account:
      return "account";
    case APP_SECTION_PATHS.ask:
      return "ask";
    case APP_SECTION_PATHS.chat:
      return "chat";
    case APP_SECTION_PATHS.documents:
      return "documents";
    case APP_SECTION_PATHS.errors:
      return "errors";
    case APP_SECTION_PATHS.help:
      return "help";
    case APP_SECTION_PATHS.login:
      return "login";
    case APP_SECTION_PATHS.overview:
      return "overview";
    case APP_SECTION_PATHS.security:
      return "security";
    case APP_SECTION_PATHS.settings:
      return "settings";
    case APP_SECTION_PATHS["system-health"]:
      return "system-health";
    case APP_SECTION_PATHS.users:
      return "users";
    default:
      return null;
  }
}
