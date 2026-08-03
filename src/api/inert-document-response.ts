import type { FastifyReply } from "fastify";

const inertDocumentContentSecurityPolicy = [
  "sandbox",
  "default-src 'none'",
  "script-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "img-src data:",
  "style-src 'unsafe-inline'",
].join("; ");

export function applyInertDocumentHeaders(reply: FastifyReply): void {
  reply.header("Cache-Control", "private, no-store");
  reply.header("Content-Security-Policy", inertDocumentContentSecurityPolicy);
  reply.header("Cross-Origin-Resource-Policy", "same-origin");
  reply.header("X-Content-Type-Options", "nosniff");
}
