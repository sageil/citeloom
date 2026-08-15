import {
  readArray,
  readBoolean,
  readEnum,
  readJsonResponse,
  readNonEmptyString,
  readPlainObject,
  readPositiveInteger,
} from "./boundary-readers.js";

const oauthTokenStorageKey = "citeloom.oauth.tokens.v1";
const oauthTransactionStorageKey = "citeloom.oauth.transaction.v1";
const oauthWorkspaceStorageKey = "citeloom.oauth.workspace.v1";
const oauthActivationProofHeaderName = "x-citeloom-oauth-activation-proof";
const objectUrlRetentionMs = 60_000;
const tokenRefreshWindowMs = 30_000;
const transactionLifetimeMs = 10 * 60 * 1_000;
const workspaceHeaderName = "x-citeloom-workspace-id";

function encodeBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return window.btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function createRandomValue() {
  const bytes = new Uint8Array(32);
  window.crypto.getRandomValues(bytes);
  return encodeBase64Url(bytes);
}

async function createCodeChallenge(verifier) {
  const digest = await window.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return encodeBase64Url(new Uint8Array(digest));
}

function readHttpsUrl(value, label) {
  const url = new URL(readNonEmptyString(value, label));
  if (url.protocol !== "https:") {
    throw new Error(`${label} must use HTTPS.`);
  }
  return url;
}

function readApplicationUrl(value, label) {
  const url = new URL(readNonEmptyString(value, label));
  if (url.origin !== window.location.origin) {
    throw new Error(
      `This page uses ${window.location.origin}, but the configured ${label} uses ${url.origin}. Open ${url.origin} and try again.`,
    );
  }
  return url;
}

function readOAuthBootstrap(value) {
  const bootstrap = readPlainObject(value, "authentication bootstrap");
  const mode = readEnum(
    bootstrap.mode,
    ["local", "oauth"],
    "authentication mode",
  );
  if (mode === "local") {
    if (bootstrap.oauth !== null) {
      throw new Error("The local authentication bootstrap is invalid.");
    }
    return { mode, oauth: null };
  }
  return { mode, oauth: readOAuthClientConfiguration(bootstrap.oauth) };
}

function readOAuthClientConfiguration(value) {
  const oauth = readPlainObject(value, "OAuth browser configuration");
  const browserScopes = [];
  for (const scope of readArray(oauth.browserScopes, "browser OAuth scopes")) {
    browserScopes.push(readNonEmptyString(scope, "browser OAuth scope"));
  }
  return {
    apiResource: readApplicationUrl(oauth.apiResource, "API resource").toString(),
    browserCallbackUri: readApplicationUrl(
      oauth.browserCallbackUri,
      "browser callback URI",
    ).toString(),
    browserClientId: readNonEmptyString(
      oauth.browserClientId,
      "browser client ID",
    ),
    browserPostLogoutRedirectUri: readApplicationUrl(
      oauth.browserPostLogoutRedirectUri,
      "browser post-logout redirect URI",
    ).toString(),
    browserScopes,
    issuer: readHttpsUrl(oauth.issuer, "OAuth issuer").toString(),
  };
}

function buildDiscoveryUrl(issuer) {
  const url = new URL(issuer);
  const path = url.pathname.endsWith("/")
    ? url.pathname
    : `${url.pathname}/`;
  url.pathname = `${path}.well-known/openid-configuration`;
  return url;
}

function readAuthorizationServerMetadata(value, expectedIssuer) {
  const metadata = readPlainObject(value, "authorization server metadata");
  const issuer = readHttpsUrl(metadata.issuer, "metadata issuer").toString();
  if (issuer !== expectedIssuer) {
    throw new Error("The authorization server returned another issuer.");
  }
  const result = {
    authorizationEndpoint: readHttpsUrl(
      metadata.authorization_endpoint,
      "authorization endpoint",
    ).toString(),
    authorizationResponseIssuerParameterSupported: false,
    endSessionEndpoint: null,
    issuer,
    tokenEndpoint: readHttpsUrl(
      metadata.token_endpoint,
      "token endpoint",
    ).toString(),
  };
  if (metadata.end_session_endpoint !== undefined) {
    result.endSessionEndpoint = readHttpsUrl(
      metadata.end_session_endpoint,
      "end-session endpoint",
    ).toString();
  }
  if (metadata.authorization_response_iss_parameter_supported !== undefined) {
    result.authorizationResponseIssuerParameterSupported = readBoolean(
      metadata.authorization_response_iss_parameter_supported,
      "authorization response issuer support",
    );
  }
  return result;
}

function readTokenResponse(value, previousTokens = null) {
  const response = readPlainObject(value, "OAuth token response");
  const tokenType = readNonEmptyString(response.token_type, "OAuth token type");
  if (tokenType.toLocaleLowerCase("en-US") !== "bearer") {
    throw new Error("The authorization server returned an unsupported token type.");
  }
  let refreshToken = previousTokens?.refreshToken ?? null;
  if (response.refresh_token !== undefined) {
    refreshToken = readNonEmptyString(response.refresh_token, "OAuth refresh token");
  }
  let idToken = previousTokens?.idToken ?? null;
  if (response.id_token !== undefined) {
    idToken = readNonEmptyString(response.id_token, "OpenID Connect ID token");
  }
  return {
    accessToken: readNonEmptyString(response.access_token, "OAuth access token"),
    expiresAt: Date.now()
      + readPositiveInteger(response.expires_in, "OAuth token lifetime") * 1_000,
    idToken,
    refreshToken,
  };
}

function readStoredTokens(storage) {
  const serialized = storage.getItem(oauthTokenStorageKey);
  if (serialized === null) {
    return null;
  }
  try {
    const value = readPlainObject(JSON.parse(serialized), "stored OAuth tokens");
    return {
      accessToken: readNonEmptyString(value.accessToken, "stored access token"),
      clientId: readNonEmptyString(value.clientId, "stored OAuth client ID"),
      expiresAt: readPositiveInteger(value.expiresAt, "stored token expiry"),
      idToken: value.idToken === null
        ? null
        : readNonEmptyString(value.idToken, "stored ID token"),
      refreshToken: value.refreshToken === null
        ? null
        : readNonEmptyString(value.refreshToken, "stored refresh token"),
      resource: readApplicationUrl(
        value.resource,
        "stored OAuth resource",
      ).toString(),
      issuer: readHttpsUrl(value.issuer, "stored OAuth issuer").toString(),
    };
  } catch {
    storage.removeItem(oauthTokenStorageKey);
    return null;
  }
}

function readStoredTransaction(storage) {
  const serialized = storage.getItem(oauthTransactionStorageKey);
  if (serialized === null) {
    return null;
  }
  try {
    const value = readPlainObject(
      JSON.parse(serialized),
      "stored OAuth transaction",
    );
    const createdAt = readPositiveInteger(
      value.createdAt,
      "OAuth transaction creation time",
    );
    if (createdAt + transactionLifetimeMs <= Date.now()) {
      throw new Error("The OAuth transaction expired.");
    }
    return {
      codeVerifier: readNonEmptyString(value.codeVerifier, "PKCE verifier"),
      createdAt,
      expectedVersion: value.expectedVersion === null
        ? null
        : readPositiveInteger(value.expectedVersion, "OAuth settings version"),
      oauth: readOAuthClientConfiguration(value.oauth),
      purpose: readEnum(
        value.purpose,
        ["activation", "sign-in"],
        "OAuth transaction purpose",
      ),
      returnTo: readReturnPath(value.returnTo),
      state: readNonEmptyString(value.state, "OAuth state"),
    };
  } catch {
    storage.removeItem(oauthTransactionStorageKey);
    return null;
  }
}

function readReturnPath(value) {
  const path = readNonEmptyString(value, "OAuth return path");
  if (!path.startsWith("/") || path.startsWith("//")) {
    throw new Error("The OAuth return path is invalid.");
  }
  return path;
}

function readIdentityContext(value) {
  const context = readPlainObject(value, "OAuth identity context");
  const workspaces = [];
  for (const item of readArray(context.workspaces, "OAuth workspaces")) {
    const workspace = readPlainObject(item, "OAuth workspace");
    workspaces.push({
      id: readNonEmptyString(workspace.id, "workspace ID"),
      name: readNonEmptyString(workspace.name, "workspace name"),
      role: readEnum(workspace.role, ["admin", "member"], "workspace role"),
    });
  }
  if (workspaces.length === 0) {
    throw new Error("The OAuth identity has no accessible CiteLoom workspace.");
  }
  return {
    displayName: readNonEmptyString(context.displayName, "display name"),
    globalRole: readEnum(
      context.globalRole,
      ["global_admin", "standard"],
      "global role",
    ),
    userId: readNonEmptyString(context.userId, "user ID"),
    username: readNonEmptyString(context.username, "username"),
    workspaces,
  };
}

function readCurrentReturnPath() {
  const value = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (window.location.pathname === "/login"
    || window.location.pathname === "/oauth/callback") {
    return "/overview";
  }
  return readReturnPath(value);
}

export function createBrowserAuthentication({
  fetchImplementation = window.fetch.bind(window),
  sessionStorage = window.sessionStorage,
} = {}) {
  let bootstrap = null;
  let context = null;
  const metadataByIssuer = new Map();
  let refreshPromise = null;
  let tokens = readStoredTokens(sessionStorage);

  const replaceTokens = (nextTokens) => {
    tokens = nextTokens;
    sessionStorage.setItem(oauthTokenStorageKey, JSON.stringify(tokens));
  };

  const clearTokens = () => {
    tokens = null;
    context = null;
    sessionStorage.removeItem(oauthTokenStorageKey);
  };

  const discover = async (oauthConfiguration) => {
    const existing = metadataByIssuer.get(oauthConfiguration.issuer);
    if (existing !== undefined) {
      return existing;
    }
    const response = await fetchImplementation(
      buildDiscoveryUrl(oauthConfiguration.issuer),
      { headers: { accept: "application/json" }, redirect: "error" },
    );
    const value = await readJsonResponse(
      response,
      "Authorization server discovery",
    );
    const discovered = readAuthorizationServerMetadata(
      value,
      oauthConfiguration.issuer,
    );
    metadataByIssuer.set(oauthConfiguration.issuer, discovered);
    return discovered;
  };

  const storeTokens = (value, oauthConfiguration) => {
    replaceTokens({
      ...value,
      clientId: oauthConfiguration.browserClientId,
      issuer: oauthConfiguration.issuer,
      resource: oauthConfiguration.apiResource,
    });
  };

  const exchangeToken = async (
    oauthConfiguration,
    parameters,
    previousTokens = null,
  ) => {
    const server = await discover(oauthConfiguration);
    const response = await fetchImplementation(server.tokenEndpoint, {
      body: parameters,
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      method: "POST",
    });
    const value = await readJsonResponse(response, "OAuth token exchange");
    const nextTokens = readTokenResponse(value, previousTokens);
    storeTokens(nextTokens, oauthConfiguration);
    return nextTokens.accessToken;
  };

  const refreshAccessToken = async () => {
    if (tokens?.refreshToken === null || tokens?.refreshToken === undefined) {
      return null;
    }
    const parameters = new URLSearchParams({
      client_id: bootstrap.oauth.browserClientId,
      grant_type: "refresh_token",
      refresh_token: tokens.refreshToken,
      resource: bootstrap.oauth.apiResource,
    });
    return exchangeToken(bootstrap.oauth, parameters, tokens);
  };

  const requireAccessToken = async () => {
    if (tokens !== null && tokens.expiresAt > Date.now() + tokenRefreshWindowMs) {
      return tokens.accessToken;
    }
    refreshPromise ??= refreshAccessToken().finally(() => {
      refreshPromise = null;
    });
    let refreshed = null;
    try {
      refreshed = await refreshPromise;
    } catch {
      clearTokens();
    }
    if (refreshed !== null) {
      return refreshed;
    }
    await beginSignIn(readCurrentReturnPath());
    return new Promise(() => {});
  };

  const loadContext = async () => {
    if (context !== null) {
      return context;
    }
    const accessToken = await requireAccessToken();
    const response = await fetchImplementation("/api/auth/context", {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${accessToken}`,
      },
    });
    const value = await readJsonResponse(response, "OAuth identity context");
    context = readIdentityContext(value);
    const storedWorkspaceId = sessionStorage.getItem(oauthWorkspaceStorageKey);
    const selected = context.workspaces.find((workspace) => {
      return workspace.id === storedWorkspaceId;
    }) ?? context.workspaces[0];
    sessionStorage.setItem(oauthWorkspaceStorageKey, selected.id);
    return context;
  };

  const beginAuthorization = async (
    oauthConfiguration,
    returnTo,
    purpose,
    expectedVersion,
  ) => {
    const server = await discover(oauthConfiguration);
    const codeVerifier = createRandomValue();
    const state = createRandomValue();
    const transaction = {
      codeVerifier,
      createdAt: Date.now(),
      expectedVersion,
      oauth: oauthConfiguration,
      purpose,
      returnTo: readReturnPath(returnTo),
      state,
    };
    sessionStorage.setItem(
      oauthTransactionStorageKey,
      JSON.stringify(transaction),
    );
    const authorizationUrl = new URL(server.authorizationEndpoint);
    authorizationUrl.searchParams.set("client_id", oauthConfiguration.browserClientId);
    authorizationUrl.searchParams.set("code_challenge", await createCodeChallenge(codeVerifier));
    authorizationUrl.searchParams.set("code_challenge_method", "S256");
    authorizationUrl.searchParams.set("redirect_uri", oauthConfiguration.browserCallbackUri);
    authorizationUrl.searchParams.set("resource", oauthConfiguration.apiResource);
    authorizationUrl.searchParams.set("response_type", "code");
    authorizationUrl.searchParams.set("scope", oauthConfiguration.browserScopes.join(" "));
    authorizationUrl.searchParams.set("state", state);
    window.location.assign(authorizationUrl.toString());
  };

  const beginSignIn = async (returnTo = readCurrentReturnPath()) => {
    if (bootstrap?.mode !== "oauth" || bootstrap.oauth === null) {
      throw new Error("OAuth authentication is not enabled.");
    }
    return beginAuthorization(
      bootstrap.oauth,
      returnTo,
      "sign-in",
      null,
    );
  };

  const completeCallback = async () => {
    const parameters = new URL(window.location.href).searchParams;
    const state = parameters.get("state");
    const transaction = readStoredTransaction(sessionStorage);
    if (state === null || transaction?.state !== state) {
      throw new Error("The OAuth callback could not be verified.");
    }
    const server = await discover(transaction.oauth);
    verifyAuthorizationResponseIssuer(parameters, server);
    const oauthError = parameters.get("error");
    if (oauthError !== null) {
      sessionStorage.removeItem(oauthTransactionStorageKey);
      throw new Error(`OAuth authorization failed: ${oauthError}.`);
    }
    const code = parameters.get("code");
    if (code === null) {
      throw new Error("The OAuth callback could not be verified.");
    }
    const previousTokens = tokens === null ? null : { ...tokens };
    const currentAccessToken = previousTokens?.accessToken ?? null;
    const tokenParameters = new URLSearchParams({
      client_id: transaction.oauth.browserClientId,
      code,
      code_verifier: transaction.codeVerifier,
      grant_type: "authorization_code",
      redirect_uri: transaction.oauth.browserCallbackUri,
      resource: transaction.oauth.apiResource,
    });
    const accessToken = await exchangeToken(transaction.oauth, tokenParameters);
    sessionStorage.removeItem(oauthTransactionStorageKey);
    if (transaction.purpose === "activation") {
      if (transaction.expectedVersion === null) {
        throw new Error("The OAuth activation version is missing.");
      }
      const activationHeaders = new Headers({
        [oauthActivationProofHeaderName]: `Bearer ${accessToken}`,
        "content-type": "application/json",
      });
      const workspaceId = sessionStorage.getItem(oauthWorkspaceStorageKey);
      if (currentAccessToken !== null) {
        activationHeaders.set("authorization", `Bearer ${currentAccessToken}`);
      }
      if (workspaceId !== null) {
        activationHeaders.set(workspaceHeaderName, workspaceId);
      }
      const response = await fetchImplementation(
        "/api/security/authentication/oauth/activate",
        {
          body: JSON.stringify({
            expectedVersion: transaction.expectedVersion,
          }),
          headers: activationHeaders,
          method: "POST",
        },
      );
      try {
        await readJsonResponse(response, "Activate OAuth authentication");
      } catch (error) {
        if (previousTokens === null) {
          clearTokens();
        } else {
          replaceTokens(previousTokens);
        }
        throw error;
      }
      window.location.replace("/overview");
      return;
    }
    window.location.replace(transaction.returnTo);
  };

  const initialize = async () => {
    const response = await fetchImplementation("/api/auth/bootstrap", {
      headers: { accept: "application/json" },
    });
    bootstrap = readOAuthBootstrap(
      await readJsonResponse(response, "Authentication bootstrap"),
    );
    if (window.location.pathname === "/oauth/callback") {
      await completeCallback();
      return;
    }
    if (bootstrap.mode !== "oauth") {
      clearTokens();
      return;
    }
    if (tokens !== null && !tokensMatchConfiguration(tokens, bootstrap.oauth)) {
      clearTokens();
    }
    if (window.location.pathname !== "/login" && tokens === null) {
      await beginSignIn(readCurrentReturnPath());
    }
  };

  const readyPromise = initialize();

  const withAuthentication = async (input, init) => {
    await readyPromise;
    if (bootstrap.mode !== "oauth") {
      return fetchImplementation(input, init);
    }
    const inputUrl = input instanceof Request ? input.url : input;
    const url = new URL(inputUrl, window.location.origin);
    if (url.origin !== window.location.origin
      || !url.pathname.startsWith("/api/")
      || url.pathname === "/api/auth/bootstrap") {
      return fetchImplementation(input, init);
    }
    const accessToken = await requireAccessToken();
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    const suppliedHeaders = new Headers(init?.headers);
    for (const [name, value] of suppliedHeaders) {
      headers.set(name, value);
    }
    headers.set("authorization", `Bearer ${accessToken}`);
    if (url.pathname !== "/api/auth/context") {
      await loadContext();
      const workspaceId = sessionStorage.getItem(oauthWorkspaceStorageKey);
      if (workspaceId === null) {
        throw new Error("No CiteLoom workspace is selected.");
      }
      headers.set(workspaceHeaderName, workspaceId);
    }
    return fetchImplementation(input, { ...init, headers });
  };

  const readAuthorizedResource = async (input) => {
    await readyPromise;
    const resourceUrl = new URL(input, window.location.origin);
    if (bootstrap.mode !== "oauth") {
      return {
        contentDisposition: null,
        href: resourceUrl.toString(),
        revoke() {},
      };
    }
    const fragment = resourceUrl.hash;
    resourceUrl.hash = "";
    const response = await withAuthentication(resourceUrl.toString(), {
      headers: { accept: "*/*" },
    });
    if (!response.ok) {
      throw new Error(
        `The protected resource request failed with status ${response.status}.`,
      );
    }
    const objectUrl = URL.createObjectURL(await response.blob());
    return {
      contentDisposition: response.headers.get("content-disposition"),
      href: `${objectUrl}${fragment}`,
      revoke() {
        URL.revokeObjectURL(objectUrl);
      },
    };
  };

  return {
    beginActivation: async (configuration, expectedVersion) => {
      await readyPromise;
      const oauthConfiguration = readOAuthClientConfiguration(configuration);
      return beginAuthorization(
        oauthConfiguration,
        "/overview",
        "activation",
        readPositiveInteger(expectedVersion, "OAuth settings version"),
      );
    },
    beginSignIn: async (returnTo) => {
      await readyPromise;
      return beginSignIn(returnTo);
    },
    identityContext: async () => {
      await readyPromise;
      if (bootstrap.mode !== "oauth") {
        return null;
      }
      return loadContext();
    },
    isOAuthEnabled: async () => {
      await readyPromise;
      return bootstrap.mode === "oauth";
    },
    isOAuthEnabledNow: () => bootstrap?.mode === "oauth",
    readAuthorizedResource,
    ready: () => readyPromise,
    selectedWorkspaceId: async () => {
      await readyPromise;
      if (bootstrap.mode !== "oauth") {
        return null;
      }
      await loadContext();
      return sessionStorage.getItem(oauthWorkspaceStorageKey);
    },
    selectWorkspace: async (workspaceId) => {
      await readyPromise;
      const identity = await loadContext();
      if (!identity.workspaces.some((workspace) => workspace.id === workspaceId)) {
        throw new Error("The selected workspace is unavailable.");
      }
      sessionStorage.setItem(oauthWorkspaceStorageKey, workspaceId);
    },
    signOut: async () => {
      await readyPromise;
      const server = bootstrap.mode === "oauth"
        ? await discover(bootstrap.oauth)
        : null;
      const idToken = tokens?.idToken ?? null;
      clearTokens();
      sessionStorage.removeItem(oauthTransactionStorageKey);
      sessionStorage.removeItem(oauthWorkspaceStorageKey);
      if (
        bootstrap.mode === "oauth"
        && server?.endSessionEndpoint !== null
        && server?.endSessionEndpoint !== undefined
      ) {
        const logoutUrl = new URL(server.endSessionEndpoint);
        if (idToken !== null) {
          logoutUrl.searchParams.set("id_token_hint", idToken);
        }
        logoutUrl.searchParams.set(
          "post_logout_redirect_uri",
          bootstrap.oauth.browserPostLogoutRedirectUri,
        );
        window.location.assign(logoutUrl.toString());
        return;
      }
      window.location.assign("/login");
    },
    withAuthentication,
  };
}

function verifyAuthorizationResponseIssuer(parameters, server) {
  const value = parameters.get("iss");
  if (value === null) {
    if (server.authorizationResponseIssuerParameterSupported) {
      throw new Error("The OAuth callback issuer is missing.");
    }
    return;
  }
  let issuer;
  try {
    issuer = readHttpsUrl(value, "OAuth callback issuer").toString();
  } catch {
    throw new Error("The OAuth callback issuer is invalid.");
  }
  if (issuer !== server.issuer) {
    throw new Error(
      "The OAuth callback issuer does not match the authorization server.",
    );
  }
}

function tokensMatchConfiguration(tokens, configuration) {
  return tokens.clientId === configuration.browserClientId
    && tokens.issuer === configuration.issuer
    && tokens.resource === configuration.apiResource;
}

export const browserAuthentication = typeof window === "undefined"
  ? createUnavailableBrowserAuthentication()
  : createBrowserAuthentication();

if (typeof window !== "undefined") {
  window.fetch = (input, init) => {
    return browserAuthentication.withAuthentication(input, init);
  };
  registerProtectedResourceLinks(browserAuthentication);
}

function registerProtectedResourceLinks(authentication) {
  if (typeof document === "undefined") {
    return;
  }
  document.addEventListener("click", (event) => {
    if (
      event.defaultPrevented
      || event.button !== 0
      || !authentication.isOAuthEnabledNow()
      || !(event.target instanceof Element)
    ) {
      return;
    }
    const anchor = event.target.closest("a[href]");
    if (!(anchor instanceof HTMLAnchorElement)) {
      return;
    }
    const url = new URL(anchor.href, window.location.origin);
    if (url.origin !== window.location.origin || !url.pathname.startsWith("/api/")) {
      return;
    }
    event.preventDefault();
    const targetWindow = anchor.target === "_blank"
      ? window.open("about:blank", "_blank")
      : null;
    if (targetWindow !== null) {
      targetWindow.opener = null;
    }
    void authentication.readAuthorizedResource(url.toString())
      .then((resource) => {
        if (
          anchor.hasAttribute("download")
          || resource.contentDisposition?.toLowerCase().startsWith("attachment")
        ) {
          const filename = anchor.download
            || readContentDispositionFilename(resource.contentDisposition);
          downloadAuthorizedResource(resource.href, filename);
        } else if (targetWindow !== null) {
          targetWindow.location.replace(resource.href);
        } else {
          window.location.assign(resource.href);
        }
        window.setTimeout(resource.revoke, objectUrlRetentionMs);
      })
      .catch((error) => {
        targetWindow?.close();
        window.dispatchEvent(new CustomEvent("citeloom:protected-resource-error", {
          detail: {
            message: error instanceof Error
              ? error.message
              : "The protected resource could not be opened.",
          },
        }));
      });
  }, true);
}

function downloadAuthorizedResource(href, filename) {
  const anchor = document.createElement("a");
  anchor.download = filename;
  anchor.href = href;
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}

function readContentDispositionFilename(value) {
  if (value === null) {
    return "";
  }
  const encoded = /filename\*=UTF-8''([^;]+)/iu.exec(value)?.[1];
  if (encoded !== undefined) {
    try {
      return decodeURIComponent(encoded);
    } catch {
      return "";
    }
  }
  return /filename="?([^";]+)"?/iu.exec(value)?.[1] ?? "";
}

function createUnavailableBrowserAuthentication() {
  return {
    identityContext: async () => null,
    isOAuthEnabled: async () => false,
    isOAuthEnabledNow: () => false,
    readAuthorizedResource: async (input) => ({
      contentDisposition: null,
      href: String(input),
      revoke() {},
    }),
    ready: async () => {},
    selectedWorkspaceId: async () => null,
    withAuthentication: (input, init) => fetch(input, init),
  };
}
