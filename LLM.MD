# CiteLoom Agent Onboarding

Use this guide to clone CiteLoom, understand its boundaries, and find the authoritative instructions for a task.
Read [`AGENTS.md`](AGENTS.md) before changing code.
Verify current behavior from source and live state because this guide is an orientation map, not a substitute for inspection.

## Clone the repository

```bash
git clone git@github.com:sageil/citeloom.git
cd citeloom
pnpm install
```

CiteLoom requires Node.js 26.5 and pnpm 11 for source-based development.
The Docker Compose stack does not require Node.js on the host.

Check the working tree before making changes.

```bash
git status --short
```

Existing changes belong to the user unless the task clearly says otherwise.

## Read in this order

Start with [`AGENTS.md`](AGENTS.md), [`README.md`](README.md), [`docs/architecture.md`](docs/architecture.md), and [`src/README.md`](src/README.md).
Use the [documentation map](#documentation-map) to choose the task-specific guide, then inspect the relevant source path.
Treat source files, database state, and runtime probes as more current than descriptive documentation.

## Product mental model

CiteLoom turns private documents into answers backed by citations.
It keeps original source files unchanged and stores their metadata, processing state, search indexes, application settings, and durable workflow state in PostgreSQL.

Document ingestion follows this path:

```text
source file
  -> immutable content store
  -> document catalog and durable job
  -> Docling conversion when required
  -> summaries and embeddings
  -> atomic index publication
```

Question answering follows this path:

```text
question and document scope
  -> generated query variations
  -> vector and BM25 retrieval
  -> rank fusion
  -> optional reranking
  -> original source evidence
  -> structured cited answer
  -> citation validation
  -> HHEM claim-support verification
  -> published answer
```

Generated summaries help discovery but are not cited as original evidence.
The server owns citation identity and source metadata.
An answer is not published when required validation fails.

## Repository map

| Path | Responsibility |
| --- | --- |
| `src/` | Production application core, API, command line, worker, and web-server entry point |
| `web/` | Browser interface and static assets |
| `tools/evaluation/` | Offline corpus and evaluation tooling |
| `test/` | Unit, integration, boundary, and live-service tests |
| `drizzle/` | Greenfield PostgreSQL schema and bootstrap SQL |
| `queries/` | SQL used while the application runs |
| `compose.yml` | Local source-build Docker Compose topology |
| `infra/` | Docker images, backup, restore, and local HTTPS |
| `scripts/` | Build, validation, probes, and development benchmark tooling |
| `docs/` | Architecture, configuration, deployment, operations, evaluation, and command guides |
| `corpora/` | Evaluation corpus manifests and provenance |
| `evaluations/` | Evaluation datasets, frozen configurations, and tuning inputs |

Put production code in the feature directory that owns its behavior.
Do not add unrelated modules to the `src` root.

## Production and evaluation boundary

Production code lives under `src/`.
Offline evaluation and corpus code lives under `tools/evaluation/`.

Evaluation tools may import the production application core.
Production code must never import evaluation tools.
Deleting `tools/evaluation/` must not prevent the production build from succeeding.

`tsconfig.build.json` compiles only `src/**/*.ts` into `dist/`.
The production image builds `src` and packages only the compiled output, database migrations, runtime queries, dependencies, and web assets.
It never copies evaluation tools into the build or runtime stages.

Keep reusable product behavior in `src/`.
Keep datasets, scoring, tuning, corpus reconciliation, and other evaluation-only behavior in `tools/evaluation/`.

## Set up a source development environment

Copy the development environment template.

```bash
cp .env.example .env.development
```

Set `CITELOOM_ADMIN_USERNAME` and `CITELOOM_ADMIN_PASSWORD` in `.env.development`.
A new database uses these values to create its first administrator.
Migration commands continue to require both values, while existing accounts remain unchanged.
Keep credentials in untracked environment files.

Start the supporting services and prepare the database.

```bash
pnpm services:up
pnpm db:migrate
pnpm run doctor:docker
```

Run the worker and web server in separate terminals.

```bash
pnpm worker
```

```bash
CITELOOM_PUBLIC_ORIGIN=http://127.0.0.1:3000 \
CITELOOM_SECURE_SESSION_COOKIE=false \
pnpm dev:web
```

Open `http://127.0.0.1:3000`.
Configure model providers and feature routing in the application Settings page.
Treat [`src/providers/profiles.ts`](src/providers/profiles.ts) as the source of truth for supported provider capabilities and [`drizzle/bootstrap.sql`](drizzle/bootstrap.sql) as the source of truth for greenfield provider defaults.
See [`CONTRIBUTING.md`](CONTRIBUTING.md) and [`docs/configuration.md`](docs/configuration.md) when the task requires a running source environment.

## Database rules

`src/database/schema.ts` defines the database schema.
`drizzle/0000_citeloom_schema.sql` is the complete greenfield migration.

During greenfield development, a regenerated baseline does not upgrade a database created from an older baseline.
Recreate a disposable development database with the guarded command below.

```bash
pnpm db:reset:development
```

This command permanently deletes records from the local database named `citeloom`.
It refuses production mode and non-local database hosts.
It does not delete files under `documents/`.

If existing data must be preserved, stop and design a forward migration before changing the database.
Read [`docs/operations.md`](docs/operations.md) before schema, backup, restore, or retention work.

## Change workflow

1. Confirm the requested outcome and inspect the existing execution path.
2. Ask whether the proposed change is the best long-term option for this greenfield application.
3. Read the owning feature, its boundary adapters, and its tests before editing.
4. Keep the change inside the requested scope.
5. Validate untrusted input once at the system boundary and pass concrete typed data internally.
6. Preserve citation identity, durable workflow state, failure behavior, and restart behavior.
7. Review the complete diff before reporting completion.

Do not edit generated files or `CHANGELOG.md` manually.
Do not use destructive Git or database commands without confirming the exact target.

## Verification

Choose checks that cover the changed behavior.

| Change | Minimum relevant checks |
| --- | --- |
| Documentation only | Review the rendered structure or Markdown diff, check links, and run `git diff --check` |
| Production TypeScript | `pnpm typecheck`, `pnpm lint`, and `pnpm build` |
| Isolated application logic | Relevant focused tests, then `pnpm test` |
| Evaluation or corpus tooling | `pnpm test:all` and the relevant validation command |
| Database behavior | Start the test database and run `pnpm test:integration` |
| Release-wide change | `pnpm check` plus any required integration or end-to-end verification |

Tests against production must start with a question and end with an answer.
Do not present an offline probe or isolated unit test as production end-to-end evidence.

## Documentation map

| Guide | Use it for |
| --- | --- |
| [`README.md`](README.md) | Product overview, installation, common commands, and supported scope |
| [`AGENTS.md`](AGENTS.md) | Mandatory rules for agents |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | Development workflow and pull requests |
| [`docs/architecture.md`](docs/architecture.md) | Runtime components and end-to-end execution paths |
| [`src/README.md`](src/README.md) | Source ownership and dependency direction |
| [`docs/commands.md`](docs/commands.md) | Complete pnpm script reference |
| [`docs/configuration.md`](docs/configuration.md) | Environment variables, supported provider matrix, feature routing, Thinking mode, retrieval, timeouts, and capacity |
| [`docs/deployment.md`](docs/deployment.md) | Complete local installation, HTTPS, scaling, and deployment checks |
| [`docs/operations.md`](docs/operations.md) | Migrations, backup, restore, reindexing, and retention |
| [`docs/evaluation.md`](docs/evaluation.md) | Offline datasets, preparation, scoring, tuning, and frozen configurations |
| [`corpora/README.md`](corpora/README.md) | Evaluation corpus sources, downloads, and reconciliation |
| [`SECURITY.md`](SECURITY.md) | Security scope and vulnerability reporting |

When a documented claim conflicts with current source or runtime behavior, follow the verified current behavior and update the documentation in the same change.
