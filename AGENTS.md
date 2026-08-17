# Citeloom

## Engineering OS

Use installed Engineering OS skills when their activation conditions apply.

## Command use

Run commands from the repository root unless a command uses `--dir docsite`.
Use the narrowest command that verifies the changed behavior.
Use `pnpm check` for broad changes or final repository verification.

## Release version

Pass the semantic version directly to the release script.
Do not put `--` before the version.

```bash
pnpm release:version <next-semantic-version>
pnpm release:check
```

The release command synchronizes `package.json`, Compose defaults, and deployment documentation.

## Install and run locally

```bash
pnpm install
pnpm services:up
pnpm db:migrate
pnpm run doctor:docker
```

Run the worker and web application in separate terminals.

```bash
pnpm worker
pnpm dev:web
```

Inspect or stop the supporting services.

```bash
pnpm services:logs
pnpm services:down
```

## Focused verification

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Run one test file.

```bash
pnpm exec vitest run <test-file>
```

Apply automatic lint fixes only after reviewing the affected files.

```bash
pnpm lint:fix
```

Run broader verification when the change scope requires it.

```bash
pnpm test:coverage
pnpm test:all
pnpm check
```

## Database integration tests

```bash
pnpm services:test:up
pnpm test:integration
pnpm services:test:stop
```

## Database changes

```bash
pnpm db:generate
pnpm db:migrate
pnpm db:migrate:production
```

`pnpm db:reset:development` deletes and recreates development data.
Run it only when the task explicitly requires a development database reset.

## Application diagnostics

```bash
pnpm doctor:source
pnpm status
pnpm jobs
pnpm documents
```

## Documentation site

```bash
pnpm --dir docsite install
pnpm --dir docsite check
pnpm --dir docsite build
pnpm --dir docsite dev
```
