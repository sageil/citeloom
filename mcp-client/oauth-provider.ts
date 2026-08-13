import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthClientProvider,
  OAuthDiscoveryState,
  OAuthTokens,
} from "@modelcontextprotocol/client";

import {
  MCP_ANSWER_SCOPE,
  MCP_SEARCH_SCOPE,
} from "../src/mcp/contract.js";

export class InMemoryMcpOAuthProvider implements OAuthClientProvider {
  private codeVerifierValue: string | null = null;
  private discoveryStateValue: OAuthDiscoveryState | undefined;
  private tokensValue: OAuthTokens | undefined;
  private readonly clientInformationValue: OAuthClientInformationMixed;
  private readonly metadata: OAuthClientMetadata;

  public constructor(
    clientId: string,
    private readonly callbackUrl: string,
    private readonly oauthState: string,
    private readonly onAuthorization: (url: URL) => void,
  ) {
    this.clientInformationValue = {
      client_id: clientId,
      token_endpoint_auth_method: "none",
    };
    this.metadata = {
      application_type: "native",
      client_name: "CiteLoom MCP smoke client",
      grant_types: ["authorization_code", "refresh_token"],
      redirect_uris: [callbackUrl],
      response_types: ["code"],
      scope: [MCP_SEARCH_SCOPE, MCP_ANSWER_SCOPE].join(" "),
      token_endpoint_auth_method: "none",
    };
  }

  public get redirectUrl(): string {
    return this.callbackUrl;
  }

  public get clientMetadata(): OAuthClientMetadata {
    return this.metadata;
  }

  public state(): string {
    return this.oauthState;
  }

  public clientInformation(): OAuthClientInformationMixed {
    return this.clientInformationValue;
  }

  public tokens(): OAuthTokens | undefined {
    return this.tokensValue;
  }

  public accessToken(): string {
    const tokens = this.tokensValue;
    if (tokens === undefined) {
      throw new Error("The MCP OAuth access token is unavailable.");
    }
    return tokens.access_token;
  }

  public saveTokens(tokens: OAuthTokens): void {
    this.tokensValue = tokens;
  }

  public redirectToAuthorization(authorizationUrl: URL): void {
    this.onAuthorization(authorizationUrl);
  }

  public saveCodeVerifier(codeVerifier: string): void {
    this.codeVerifierValue = codeVerifier;
  }

  public codeVerifier(): string {
    if (this.codeVerifierValue === null) {
      throw new Error("The OAuth PKCE verifier is unavailable.");
    }
    return this.codeVerifierValue;
  }

  public saveDiscoveryState(state: OAuthDiscoveryState): void {
    this.discoveryStateValue = state;
  }

  public discoveryState(): OAuthDiscoveryState | undefined {
    return this.discoveryStateValue;
  }

  public invalidateCredentials(
    scope: "all" | "client" | "tokens" | "verifier" | "discovery",
  ): void {
    if (scope === "all" || scope === "tokens") {
      this.tokensValue = undefined;
    }
    if (scope === "all" || scope === "verifier") {
      this.codeVerifierValue = null;
    }
    if (scope === "all" || scope === "discovery") {
      this.discoveryStateValue = undefined;
    }
  }
}
