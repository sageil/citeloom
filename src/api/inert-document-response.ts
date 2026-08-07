import type { FastifyReply } from "fastify";

const inertDocumentDirectives = [
  "default-src 'none'",
  "script-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "img-src data:",
  "style-src 'unsafe-inline'",
];

const inertDocumentContentSecurityPolicy = buildDocumentContentSecurityPolicy(
  "sandbox",
);
const highlightedHtmlContentSecurityPolicy = buildDocumentContentSecurityPolicy(
  "sandbox allow-same-origin",
);

export function applyInertDocumentHeaders(reply: FastifyReply): void {
  applyDocumentHeaders(reply, inertDocumentContentSecurityPolicy);
}

export function applyHighlightedDocumentHeaders(
  reply: FastifyReply,
  mediaType: string,
): void {
  const contentSecurityPolicy = mediaType === "text/html"
    ? highlightedHtmlContentSecurityPolicy
    : inertDocumentContentSecurityPolicy;
  applyDocumentHeaders(reply, contentSecurityPolicy);
}

function buildDocumentContentSecurityPolicy(sandbox: string): string {
  return [sandbox, ...inertDocumentDirectives].join("; ");
}

function applyDocumentHeaders(
  reply: FastifyReply,
  contentSecurityPolicy: string,
): void {
  reply.header("Cache-Control", "private, no-store");
  reply.header("Content-Security-Policy", contentSecurityPolicy);
  reply.header("Cross-Origin-Resource-Policy", "same-origin");
  reply.header("X-Content-Type-Options", "nosniff");
}
