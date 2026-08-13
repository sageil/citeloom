import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";

import type {
  WebServices,
} from "./services.js";
import {
  buildProtectedResourceMetadataPath,
  isOAuthProtectedResourceMetadataPath,
  OAUTH_PROTECTED_RESOURCE_METADATA_PATH,
} from "../oauth/protected-resource.js";

export { isOAuthProtectedResourceMetadataPath };

export function registerOAuthProtectedResourceMetadata(
  server: FastifyInstance,
  options: {
    publicOrigin: string;
    services: Pick<WebServices, "readAuthenticationSettings">;
  },
): void {
  const handler = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<unknown> => {
    const settings = await options.services.readAuthenticationSettings(
      options.publicOrigin,
    );
    const configuration = settings.activeOAuthConfiguration;
    if (settings.mode !== "oauth" || configuration === null) {
      return reply.header("Cache-Control", "no-store").status(404).send();
    }
    const pathname = readRequestPathname(request.url);
    const resource = readProtectedResource(configuration, pathname);
    if (resource === null) {
      return reply.header("Cache-Control", "no-store").status(404).send();
    }
    reply.header("Cache-Control", "public, max-age=60");
    return {
      authorization_servers: [configuration.issuer],
      bearer_methods_supported: ["header"],
      resource: resource.identifier,
      scopes_supported: [...resource.scopes],
    };
  };
  server.get(OAUTH_PROTECTED_RESOURCE_METADATA_PATH, handler);
  server.get(`${OAUTH_PROTECTED_RESOURCE_METADATA_PATH}/*`, handler);
}

function readProtectedResource(
  configuration: NonNullable<
    Awaited<ReturnType<WebServices["readAuthenticationSettings"]>>[
      "activeOAuthConfiguration"
    ]
  >,
  pathname: string,
): { identifier: string; scopes: string[] } | null {
  const resources = [
    {
      identifier: configuration.apiResource,
      scopes: configuration.apiScopes,
    },
    {
      identifier: configuration.mcpResource,
      scopes: configuration.mcpScopes,
    },
  ];
  for (const resource of resources) {
    const metadataPath = buildProtectedResourceMetadataPath(
      resource.identifier,
    );
    if (pathname === metadataPath) {
      return { identifier: resource.identifier, scopes: [...resource.scopes] };
    }
  }
  return null;
}

function readRequestPathname(url: string): string {
  return url.split("?", 1)[0] ?? url;
}
