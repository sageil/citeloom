# Contributing to CiteLoom

Thank you for contributing to CiteLoom.
Keep each change focused, protect CiteLoom's evidence and citation guarantees, and tell reviewers how you verified the result.

## Prerequisites

- Node.js 26.5.0
- pnpm 11
- Docker with Docker Compose
- Configured model providers for workflows that call a model

## Get started

Fork and clone the repository, then create the development configuration.

```bash
git clone https://github.com/<your-username>/citeloom.git
cd citeloom
pnpm install
cp .env.example .env.development
```

Set `CITELOOM_ADMIN_USERNAME` and `CITELOOM_ADMIN_PASSWORD` in `.env.development`.
A new database uses these values to create its first administrator.
Migration commands continue to require both values, while existing accounts remain unchanged.

Start the supporting services and prepare the database.

```bash
pnpm services:up
pnpm db:migrate
pnpm run doctor:docker
```

Start the worker in one terminal.

```bash
pnpm worker
```

Start the web application in another terminal.

```bash
pnpm dev:web
```

Open `http://127.0.0.1:3000` for the host-run web application.
Before using state-changing actions on this HTTP origin, set Public origin to `http://127.0.0.1:3000` and disable Secure session cookie on the Web server Settings page, then restart the host-run web process.

See [Configuration](docs/configuration.md) for model providers, retrieval settings, and processing capacity.

## Project structure

```text
src/                 Application, ingestion, retrieval, provider, and server code
web/                 Browser application and static frontend assets
docs/                Architecture, configuration, deployment, and operations
scripts/             Repository validation, maintenance, probes, and development benchmark tooling
tools/               Offline evaluation and corpus tools that use the application core
corpora/             Evaluation corpus manifests and provenance
evaluations/         Evaluation datasets and frozen configurations
infra/               Compose, container, backup, and restore tooling
```

Read [Architecture](docs/architecture.md) and the [server source layout](src/README.md) before changing the search pipeline, citation validation, research storage, or HHEM behavior.

## Development workflow

1. Create a branch from `main`.
2. Find and understand the existing execution path before editing it.
3. Keep unrelated cleanup out of the change.
4. Add or update focused tests when production behavior changes.
5. Run the checks that cover the affected behavior.
6. Open a pull request against `main`.

## Code style

- Follow the existing TypeScript, JavaScript, and SQL patterns.
- Validate untrusted data once when it enters the system, then pass concrete typed objects through the remaining code.
- Keep citation identity under server control and publish answers only after required validation passes.
- Use readable imperative code and named intermediate values for branching or multi-step logic.
- Change the source of generated files and regenerate their output.
- Run `pnpm lint` and use `pnpm lint:fix` only after reviewing the resulting changes.

## Verification

Run the production-focused unit suite during routine development.

```bash
pnpm test
```

Every production feature must expose its decisions through deterministic unit or contract tests in this suite.
Use injected fakes for database, provider, filesystem, HTTP, clock, and identifier boundaries instead of requiring external services.

Run the GitHub-compatible suite with production-source coverage thresholds before requesting review.

```bash
pnpm test:coverage
```

GitHub coverage does not run corpus, database integration, Docker, live-model, or browser-automation tests.
Those workflows remain separate validation tools and do not replace deterministic feature coverage.

Run the complete isolated test suite when changing evaluation, corpus, or command-line behavior.

```bash
pnpm test:all
```

Run the complete repository check before asking for final review.

```bash
pnpm check
```

Database changes require the isolated integration service and integration suite.

```bash
pnpm services:test:up
pnpm test:integration
pnpm services:test:stop
```

Live model probes are optional.
Report them separately from repeatable unit-test coverage.

## Pull requests

- Explain the problem and the resulting behavior.
- Link related issues.
- Include screenshots for visible interface changes.
- List the commands and manual checks you ran.
- Describe any migrations, configuration changes, compatibility concerns, and known limitations.
- Respond to review feedback and keep follow-up commits within the pull request's scope.

## Report an issue

Search existing issues before opening a new one.
For a bug, include steps to reproduce it, the expected and actual behavior, environment details, and relevant logs.
Remove credentials and private document content from those logs.
Feature requests should describe the problem and desired outcome before proposing an implementation.

Report vulnerabilities according to the [Security Policy](SECURITY.md), not through a public issue.

## License

By contributing, you agree that your contributions will be licensed under the [GNU Affero General Public License v3](LICENSE).
