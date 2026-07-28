# Docling benchmark development tool

Use this development tool to compare Docling settings with documents already stored in a development database.
It is not included in the production build or application container.

The benchmark reads documents and settings from the configured development PostgreSQL database.
It stores runs and results in a separate `citeloom_benchmark` schema in that database.
When started, the tool creates the schema if needed and launches its own isolated Docling service.

Prepare the development database, then run the benchmark.

```bash
pnpm db:migrate
pnpm docling:benchmark
```

If a compatible run was interrupted, resume it with its saved ID.

```bash
pnpm docling:benchmark --resume <run-id>
```

Include the exploratory quality settings only when the experiment is meant to compare those tradeoffs.

```bash
pnpm docling:benchmark --include-quality-tradeoffs
```

The benchmark does not change the configured production Docling backend or select a candidate for production.
