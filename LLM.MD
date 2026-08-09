# CiteLoom agent onboarding

Use this page to find the authoritative source for a task.
Read [`AGENTS.md`](AGENTS.md) before inspecting or changing the repository.

## Establish the truth boundary

Treat this guide as navigation, not proof of current behavior.
Use evidence in this order:

1. Current runtime state and stored data when the task concerns a live environment.
2. The owning production code, database schema, configuration boundary, and focused tests.
3. The task-specific documentation linked below.
4. Historical commits, comments, and assumptions only as supporting context.

When sources disagree, report the conflict and verify the current path before editing.
Check `git status --short` first because existing changes belong to the user.

## Product mental model

CiteLoom turns private documents into answers backed by retained source evidence.
Original source bytes stay unchanged in a content store, while PostgreSQL owns metadata, processing state, search indexes, settings, accounts, saved research, and durable workflow coordination.

Ingestion moves through content storage, document conversion when required, searchable section construction, generated retrieval descriptions, embeddings, and atomic index publication.
Answering resolves an authorized document scope, retrieves and ranks evidence, generates a structured response, validates citations, records advisory HHEM checks, and atomically publishes the saved result.

Generated summaries can help retrieval but cannot become source evidence.
The server owns citation identity.
Conversation memory can clarify a Chat follow-up but cannot support a factual claim.

## Route the task

| Task | Start here | Verify next |
| --- | --- | --- |
| Set up a development checkout or prepare a pull request | [`CONTRIBUTING.md`](CONTRIBUTING.md) | [`package.json`](package.json) and the affected scripts |
| Find the server owner for a behavior | [`src/README.md`](src/README.md) | The owning feature directory and focused tests |
| Trace ingestion, retrieval, answers, Chat, or concurrency | [`docs/architecture.md`](docs/architecture.md) | The exact entry point and downstream calls |
| Change a provider or runtime setting | [`docs/configuration.md`](docs/configuration.md) | `src/app/settings.ts`, `src/providers/`, and `drizzle/bootstrap.sql` |
| Change installation, Compose, HTTPS, or scaling | [`docs/deployment.md`](docs/deployment.md) | Compose files and `infra/` |
| Change migrations, backup, restore, reindexing, or retention | [`docs/operations.md`](docs/operations.md) | Schema, scripts, and restart behavior |
| Look up a package or CLI command | [`docs/commands.md`](docs/commands.md) | `package.json` and `src/cli/command-parser.ts` |
| Change datasets, scoring, tuning, or corpus inputs | [`docs/evaluation.md`](docs/evaluation.md) | `tools/evaluation/`, `corpora/`, and `evaluations/` |
| Review user-visible scope or limits | [`docs/features.md`](docs/features.md) | Web fragments, API routes, and settings definitions |
| Handle a vulnerability report | [`SECURITY.md`](SECURITY.md) | The private reporting channel |

## Preserve core invariants

- Put production code in the feature directory that owns the behavior.
- Validate untrusted input once at its boundary, then pass concrete typed data internally.
- Keep citation identity under server control.
- Preserve durable state transitions, lease fencing, failure behavior, and restart behavior.
- Keep completed indexes and answers atomic.
- Keep production independent of offline evaluation tooling.
- Change the source of generated files instead of editing generated output.

Before delivery, review the complete diff and run only the checks authorized for the task and proportional to the affected path.
Never claim a check ran unless it completed successfully.
