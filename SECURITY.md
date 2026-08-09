# Security policy

## Report a vulnerability

If you find a security vulnerability in CiteLoom, report it privately so it can be investigated before public disclosure.

**Do not open a public issue.**
Use GitHub's [private vulnerability reporting](https://github.com/sageil/citeloom/security/advisories/new).

Include:

- A description of the vulnerability
- Steps to reproduce it
- Its potential impact
- A suggested fix, if available

You should receive an acknowledgment within 48 hours.
We will then work with you to confirm the issue, prepare a fix, and coordinate public disclosure.

## In scope

Security issues in the following areas are in scope:

- Authentication or authorization bypasses
- Access to documents, citations, research threads, or administration features across authorization boundaries
- Path traversal or unintended filesystem access during upload, ingestion, evidence loading, backup, or restore
- Command, SQL, prompt, markup, or script injection
- Server-side request forgery through provider or service configuration
- Exposure of credentials, private document content, generated research, or sensitive metadata
- Validation failures that publish or persist unsafe generated answers
- Inputs that repeatedly exhaust resources, crash the service, or leave ingestion unable to recover

## Out of scope

- Vulnerabilities in upstream dependencies with no demonstrated impact on CiteLoom
- Issues that require physical access to the host
- Social engineering
- Denial of service caused only by an administrator intentionally configuring insufficient local resources

## Supported versions

Security fixes are applied to the latest release and the `main` branch.
Run the latest available version and keep external services and model runtimes patched.
