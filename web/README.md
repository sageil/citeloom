# CiteLoom web application

CiteLoom is a self-hosted research workspace for finding, understanding, and discussing information in private document collections.
The web application provides the browser interface for the complete CiteLoom workflow, from document ingestion through cited answers and evidence review.

## Features

- Upload, organize, inspect, retry, and reindex documents.
- Ask document-grounded questions and review citations, source excerpts, and claim checks.
- Continue private, cited conversations about selected documents.
- Discover additional sources and retain useful evidence in research threads.
- Dictate questions and listen to generated answers when speech services are enabled.
- Configure providers, models, document processing, search behavior, and application features.
- Manage accounts, users, system health, diagnostics, and error reports.

See [Features](../docs/features.md) for the complete member and administrator feature set.

## Installation

CiteLoom supports two installation methods:

- Pull the published container images from Docker Hub and run the complete stack with Docker Compose.
- Build and install the complete stack locally from this repository.

See [Deployment](../docs/deployment.md) for prerequisites, installation commands, storage configuration, HTTPS setup, and administrator bootstrap.

## Development

Start the integrated application server from the repository root.

```bash
CITELOOM_PUBLIC_ORIGIN=http://127.0.0.1:3000 \
CITELOOM_SECURE_SESSION_COOKIE=false \
pnpm dev:web
```

Open `http://127.0.0.1:3000`.

To run the browser interface separately from the API, start the backend with the standalone development server's origin.

```bash
CITELOOM_PUBLIC_ORIGIN=http://127.0.0.1:5175 \
CITELOOM_SECURE_SESSION_COOKIE=false \
pnpm dev:web
```

Start the standalone frontend server in another terminal.

```bash
node web/citeloom-server.mjs
```

Open `http://127.0.0.1:5175/web/`.
The standalone server forwards `/api` requests to `http://127.0.0.1:3000` by default.
Set `CITELOOM_WEB_DEV_HOST` and `CITELOOM_WEB_DEV_PORT` to change where the standalone server listens.
Set `CITELOOM_API_ORIGIN` when the backend uses a different origin.

## Architecture

The web application uses a persistent browser shell with HTMX for navigation and server-rendered content updates.
Alpine.js manages interactive state, forms, dialogs, streaming updates, and other client-side behavior.
Fastify serves the interface, authenticates requests, and exposes the same-origin API used by the browser.
The API coordinates persistence, background workflows, document conversion, retrieval, inference providers, and speech services.
The browser does not connect directly to databases, workers, document processors, or model providers.

The frontend does not require a separate package installation or production build step.
An internet connection is currently required because the browser loads pinned HTMX and Alpine.js releases from jsDelivr.

See [Architecture](../docs/architecture.md) for system boundaries and execution paths, and [Configuration](../docs/configuration.md) for runtime settings and provider behavior.
