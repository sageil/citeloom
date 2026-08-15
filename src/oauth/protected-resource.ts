const OAUTH_PROTECTED_RESOURCE_METADATA_PATH =
  "/.well-known/oauth-protected-resource";

export function buildProtectedResourceMetadataPath(resource: string): string {
  const resourcePath = new URL(resource).pathname;
  if (resourcePath === "/") {
    return OAUTH_PROTECTED_RESOURCE_METADATA_PATH;
  }
  return `${OAUTH_PROTECTED_RESOURCE_METADATA_PATH}${resourcePath}`;
}

export function isOAuthProtectedResourceMetadataPath(
  pathname: string,
): boolean {
  return pathname === OAUTH_PROTECTED_RESOURCE_METADATA_PATH
    || pathname.startsWith(`${OAUTH_PROTECTED_RESOURCE_METADATA_PATH}/`);
}

export { OAUTH_PROTECTED_RESOURCE_METADATA_PATH };
