# CiteLoom web frontend

This directory contains CiteLoom's web interface, built with HTMX and Alpine.js.
Fastify serves the files directly with no separate frontend package installation or build step.
Application scripts, styles, images, icons, and fonts live under `assets/`.
The browser loads the pinned HTMX and Alpine.js files from jsDelivr.

## Run the frontend

Start the integrated Node server from the repository root.

```bash
CITELOOM_PUBLIC_ORIGIN=http://127.0.0.1:3000 \
CITELOOM_SECURE_SESSION_COOKIE=false \
pnpm dev:web
```

Open `http://127.0.0.1:3000`.

To work on the frontend separately from the API, first start the backend with the standalone development server's origin.

```bash
CITELOOM_PUBLIC_ORIGIN=http://127.0.0.1:5175 \
CITELOOM_SECURE_SESSION_COOKIE=false \
pnpm dev:web
```

In another terminal, start the standalone frontend server.
It serves the web files and forwards `/api` requests to the Node backend at `http://127.0.0.1:3000`.

```bash
node web/citeloom-server.mjs
```

Open `http://127.0.0.1:5175/web/`.
An internet connection is currently required because the frontend loads pinned HTMX and Alpine builds from jsDelivr.
Set `CITELOOM_WEB_DEV_HOST` and `CITELOOM_WEB_DEV_PORT` to change where the development server listens.
Set `CITELOOM_API_ORIGIN` if the backend runs at a different origin.

## File ownership

- `index.html` owns the persistent application shell.
- `fragments/` contains the page content swapped by HTMX.
- `assets/scripts/citeloom-app.js` registers the Alpine shell component and loads each route's JavaScript before HTMX requests its HTML fragment.
- `assets/scripts/citeloom-ask.js` loads on the first Ask visit.
  It manages research threads, scoped questions, source discovery, streamed answers, citations, feedback, speech playback, and dictation.
- `assets/scripts/citeloom-chat.js` loads on the first Chat visit and manages private grounded conversations, retained citation evidence, and message submission.
- `assets/scripts/citeloom-account.js` owns authenticated account and password changes.
- `assets/scripts/citeloom-documents.js` loads on the first Documents visit.
  It manages catalog validation, filtering, pagination, inspection, version history, retry, and reindex behavior.
- `assets/scripts/citeloom-login.js` loads on the first Login visit and manages setup, sign-in submission, password visibility, and Remember me state.
- `assets/scripts/citeloom-overview.js` loads on the first Overview visit and manages document selection, tags, ingestion options, response validation, and submission state.
- `assets/scripts/citeloom-settings.js` loads on the first Settings visit and manages Settings response validation, drafts, filtering, provider configuration, OpenAI Codex device sign-in, and versioned saves.
- `assets/scripts/citeloom-system-health.js` owns health checks, diagnostics, and retry presentation.
- `assets/scripts/citeloom-users.js` owns administrator membership management.
- `assets/styles/` contains CiteLoom style files and the HTMX shell rules.
- `assets/fonts/` contains the local Space Grotesk variable font used by the CiteLoom interface.
- `assets/images/` contains the CiteLoom mark, ambient background, and interface icon sprite.
- The Overview fragment shows workspace status, workflow progress, document ingestion, and pipeline diagnostics from the Node API.
- The Documents fragment shows the catalog, attention queue, document inspector, version history, and question-document selection.
- The Help fragment contains CiteLoom's in-app user guide and supports direct links to each topic.
- The Login, Account, and Users fragments use the Fastify server's authentication, password, session, and membership APIs.
- The Ask fragment shows saved research, answer sections, cited sources, claim checks, source discovery, and evidence.
- The System health fragment shows capacity, configured models, telemetry, diagnostics, and retryable failures from the Node API.
- The Settings fragment shows searchable runtime settings, startup values, supported provider connections, capability routing, OpenAI Codex device authorization, and saved changes.
- The Fastify server owns API routes and serves this directory as its static application root.
