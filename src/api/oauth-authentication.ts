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
import {
  MCP_DOCUMENTATION_URL,
  MCP_SERVER_TITLE,
} from "../mcp/contract.js";

const OAUTH_DOCUMENTATION_URL =
  "https://sammyageil.com/citeloom/reference/oauth/";

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
      resource_documentation: resource.documentationUrl,
      resource_name: resource.name,
      scopes_supported: [...resource.scopes],
    };
  };
  server.get(OAUTH_PROTECTED_RESOURCE_METADATA_PATH, handler);
  server.get(`${OAUTH_PROTECTED_RESOURCE_METADATA_PATH}/*`, handler);
}

interface ProtectedResourceDescription {
  documentationUrl: string;
  identifier: string;
  name: string;
  scopes: string[];
}

function readProtectedResource(
  configuration: NonNullable<
    Awaited<ReturnType<WebServices["readAuthenticationSettings"]>>[
      "activeOAuthConfiguration"
    ]
  >,
  pathname: string,
): ProtectedResourceDescription | null {
  const resources: ProtectedResourceDescription[] = [
    {
      documentationUrl: OAUTH_DOCUMENTATION_URL,
      identifier: configuration.apiResource,
      name: "CiteLoom API",
      scopes: configuration.apiScopes,
    },
    {
      documentationUrl: MCP_DOCUMENTATION_URL,
      identifier: configuration.mcpResource,
      name: `${MCP_SERVER_TITLE} MCP`,
      scopes: configuration.mcpScopes,
    },
  ];
  for (const resource of resources) {
    const metadataPath = buildProtectedResourceMetadataPath(
      resource.identifier,
    );
    if (pathname === metadataPath) {
      return {
        documentationUrl: resource.documentationUrl,
        identifier: resource.identifier,
        name: resource.name,
        scopes: [...resource.scopes],
      };
    }
  }
  return null;
}

function readRequestPathname(url: string): string {
  return url.split("?", 1)[0] ?? url;
}
