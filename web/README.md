# CiteLoom web application

This guide is for contributors running or changing the browser interface.
Use [Features](../docs/features.md) for product behavior and [Deployment](../docs/deployment.md) to install the complete application.

## Development

Start the integrated application server from the repository root.

```bash
pnpm dev:web
```

Open `http://127.0.0.1:3000`.
Set Public origin to `http://127.0.0.1:3000` and disable Secure session cookie on the Web server Settings page before using this HTTP development origin, then restart the backend.

To run the browser interface separately from the API, start the backend with the standalone development server's origin.

```bash
pnpm dev:web
```

Start the standalone frontend server in another terminal.

```bash
node web/citeloom-server.mjs
```

Open `http://127.0.0.1:5175/web/`.
For this layout, save `http://127.0.0.1:5175` as Public origin on the Web server Settings page and restart the backend.
The standalone server forwards `/api` requests to `http://127.0.0.1:3000` by default.
Set `CITELOOM_WEB_DEV_HOST` and `CITELOOM_WEB_DEV_PORT` to change where the standalone server listens.
Set `CITELOOM_API_ORIGIN` when the backend uses a different origin.

## Frontend boundaries

The web application uses a persistent browser shell with HTMX for navigation and server-rendered content updates.
Alpine.js manages interactive state, forms, dialogs, streaming updates, and other client-side behavior.
Fastify serves the interface, authenticates requests, and exposes the same-origin API used by the browser.
The API coordinates persistence, background workflows, document conversion, retrieval, inference providers, and speech services.
The browser does not connect directly to databases, workers, document processors, or model providers.

The frontend does not require a separate package installation or production build step.
The web server serves pinned HTMX, Marked, DOMPurify, and Alpine.js releases from local dependencies, so the browser does not depend on a public CDN.

See [Architecture](../docs/architecture.md) for the complete system boundaries.
