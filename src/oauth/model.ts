import type {
  AuthorizationPrincipal,
  UserAccountState,
} from "../auth/model.js";
import type { OAuthResourceSettings } from "./config.js";

export interface OAuthUserIdentityLink {
  createdAt: string;
  displayName: string;
  subject: string;
  userState: UserAccountState;
  userId: string;
  username: string;
}

export interface OAuthWorkspaceLink {
  createdAt: string;
  externalWorkspaceId: string;
  workspaceId: string;
  workspaceName: string;
  workspaceState: "active" | "archived";
}

export interface OAuthSecurityOverview {
  configuration: OAuthResourceSettings;
  userIdentityLinks: OAuthUserIdentityLink[];
  workspaceLinks: OAuthWorkspaceLink[];
}

export interface VerifiedOAuthAccessToken {
  issuer: string;
  scopes: string[];
  subject: string;
  workspaceExternalId: string;
}

export interface OAuthPrincipal extends AuthorizationPrincipal {
  issuer: string;
  scopes: string[];
  subject: string;
  workspaceExternalId: string;
}
