# Configuration

CiteLoom has two configuration layers:

- Use the Settings page for providers, models, feature routing, retrieval, and document conversion.
- Use environment variables for database access, storage paths, web listeners, release information, and service processes.

Settings are stored in PostgreSQL.
Each job and answer run keeps the settings it started with.

## Configure providers

After CiteLoom starts, open Settings.
Configure a provider connection, then assign it to one or more capabilities.
Answers, query expansion, summaries, and embeddings require a provider.
Reranking, speech-to-text, and text-to-speech are optional.

A fresh database uses LM Studio for the required capabilities.
Optional capabilities start unassigned and can be enabled at any time.
See [Provider reference](#provider-reference) for supported combinations and endpoint formats.

After saving provider settings, verify the connections from the environment where CiteLoom runs.

```bash
pnpm run doctor:docker
```

Use `pnpm run doctor:source` for a host-run application.

## Environment and storage

Use [`.env.example`](../.env.example) as the environment-variable reference.
Copy it to `.env.development` for source development or `.env` for Docker Compose and production builds.
Values set directly in the process environment take precedence.
The [standalone frontend guide](../web/README.md) documents its additional variables.

### Application and deployment variables

| Setting | Purpose |
| --- | --- |
| `CITELOOM_IMAGE_TAG` | Exact semantic-version tag used by `compose.dockerhub.yml` for every CiteLoom image |
| `CITELOOM_RELEASE` | Release identifier stored with operational error events |
| `CITELOOM_APPLICATION_ERROR_RETENTION_DAYS` | Maximum age of retained operational errors |
| `CITELOOM_APPLICATION_ERROR_MAXIMUM_ROWS` | Maximum number of retained operational error rows |
| `DATABASE_URL` | PostgreSQL connection string |
| `DATABASE_POOL_MAX` | Maximum PostgreSQL connections per process |
| `CITELOOM_POSTGRES_DATA_DIRECTORY` | Host directory bind-mounted for Compose PostgreSQL data |
| `CITELOOM_SOURCE_CONTENT_HOST_DIRECTORY` | Host directory bind-mounted as immutable source content by Compose |
| `CITELOOM_SOURCE_CONTENT_DIRECTORY` | Process-visible source-content path written to PostgreSQL during migration bootstrap |
| `CITELOOM_UPLOAD_DIRECTORY` | Web staging directory for in-progress uploads |
| `CITELOOM_MAX_UPLOAD_REQUEST_MEGABYTES` | Aggregate byte limit for one multipart upload request |
| `CITELOOM_WEB_HOST` | Listener address for a host-run web process |
| `CITELOOM_WEB_PORT` | Listener port for a host-run web process; Docker replicas use internal port 3000 |
| `CITELOOM_ADMIN_USERNAME` | Required migration input used to create the first administrator in a new database |
| `CITELOOM_ADMIN_PASSWORD` | Required migration input used to create the first administrator password in a new database |
| `CITELOOM_PUBLIC_ORIGIN` | Required browser origin for state-changing requests |
| `CITELOOM_SECURE_SESSION_COOKIE` | Secure-cookie enforcement |
| `CITELOOM_TRUST_PROXY` | Explicit trusted-proxy mode for a host-run web process; the supplied Compose web service enables it behind Caddy |

### Service process variables

| Setting | Purpose |
| --- | --- |
| `DOCLING_NUM_THREADS` | Worker threads used by each Docling service |
| `DOCLING_PERF_PAGE_BATCH_SIZE` | Docling page-processing batch size |
| `DOCLING_DEBUG_PROFILE_PIPELINE_TIMINGS` | Enables Docling pipeline timing diagnostics |
| `DOCLING_SERVE_QUEUE_MAX_SIZE` | Maximum number of queued tasks in each Docling service |
| `DOCLING_ADDITIONAL_SERVICE_INSTANCES` | JSON list of additional Docling instances reachable by a host-run application |
| `DOCLING_CONTAINER_ADDITIONAL_SERVICE_INSTANCES` | JSON list of the same stable Docling instances using container-reachable URLs |
| `HHEM_MAX_PADDED_TOKENS` | Maximum padded tokens accepted by one HHEM batch |
| `HHEM_MAX_ATTENTION_CELLS` | Maximum estimated attention cells accepted by one HHEM batch |
| `HHEM_MODEL_BATCH_SIZE` | Maximum number of claim-evidence pairs in one HHEM model batch |
| `HHEM_TORCH_THREADS` | CPU thread count used by HHEM |
| `HHEM_PORT` | Host port published for the HHEM service |

The local installer defaults `CITELOOM_POSTGRES_DATA_DIRECTORY` to `./data/citeloomdb`, resolved from the repository root.
It also creates and checks `CITELOOM_SOURCE_CONTENT_HOST_DIRECTORY`, which defaults to `./documents/blobs`.

The database setting `sourceContent.directory` tells CiteLoom where processes can read stored source files.
The web application, worker, and ordinary command-line tools use this database value instead of the environment variable.
The host-run development benchmark is the exception.
It reads `CITELOOM_SOURCE_CONTENT_DIRECTORY` because a Docker Compose database may contain the container-only path `/app/documents/blobs`.

To change the stored path, first stop every process that can write data.
Copy all existing content to the new directory, set `CITELOOM_SOURCE_CONTENT_DIRECTORY` to the path visible to the process running the migration, and run the migration.
The migration checks every stored source before updating the database.
If validation fails, the previous setting remains active.

## Provider reference

[`providerCatalog`](../src/providers/profiles.ts) is the source of truth for built-in provider profiles and capabilities.
Each capability is routed independently, so one provider can generate answers while other providers supply embeddings, reranking, or speech.

| Provider | Answers | Query expansion | Summaries | Embeddings | Reranking | Speech-to-text | Text-to-speech |
| --- | --- | --- | --- | --- | --- | --- | --- |
| oMLX | Yes | Yes | Yes | Yes | Yes | Yes | Yes |
| Ollama | Yes | Yes | Yes | Yes | - | - | - |
| LM Studio | Yes | Yes | Yes | Yes | - | - | - |
| OpenAI | Yes | Yes | Yes | Yes | - | Yes | Yes |
| OpenAI Codex | Yes | Yes | Yes | - | - | - | - |
| DeepSeek | Yes | Yes | Yes | - | - | - | - |
| Groq | Yes | Yes | Yes | - | - | Yes | Yes |
| Cohere | Yes | Yes | Yes | Yes | Yes | - | - |
| Jina | - | - | - | Yes | Yes | - | - |
| Custom | Yes | Yes | Yes | Yes | Yes | Yes | Yes |

Assign models that support their selected capabilities.
The Custom profile lets administrators choose the adapter used for each capability.

OpenAI Codex uses OpenAI device sign-in from the Settings page.
Other profiles support a shared API token and capability-specific overrides.
Local endpoints can leave the token blank when authentication is not required.

### Endpoint conventions

Compose services reach model servers on the host through `host.docker.internal`.
A source-run process normally uses the equivalent `127.0.0.1` or network address.

| Provider | Bootstrap base URL | API convention |
| --- | --- | --- |
| oMLX | `http://host.docker.internal:9000/v1` | OpenAI-compatible language, embedding, reranking, and speech endpoints |
| Ollama | `http://host.docker.internal:11434` | Native Ollama API without an OpenAI-compatible `/v1` suffix |
| LM Studio | `http://host.docker.internal:1234/v1` | LM Studio OpenAI-compatible endpoints |
| OpenAI | `https://api.openai.com/v1` | OpenAI-compatible language, embedding, and audio endpoints |
| OpenAI Codex | Fixed by the adapter | OpenAI device sign-in and the Codex model catalog |
| DeepSeek | `https://api.deepseek.com` | DeepSeek OpenAI-compatible Chat Completions contract |
| Groq | `https://api.groq.com/openai/v1` | Groq OpenAI-compatible language and audio endpoints |
| Cohere | `https://api.cohere.com/v2` | Cohere v2 chat, embedding, and reranking endpoints |
| Jina | `https://api.jina.ai/v1` | Jina embedding and reranking endpoints |
| Custom | None | Administrator-selected adapters, base URLs, models, and credentials |

Base URLs, model IDs, context capacities, and maximum parallel requests are editable in Settings.
Use the exact model identifier exposed by the configured endpoint.
Provider APIs and model catalogs change independently of CiteLoom.
Confirm current details in the official documentation for [oMLX](https://github.com/jundot/omlx), [Ollama](https://docs.ollama.com/api/introduction), [LM Studio](https://lmstudio.ai/docs/developer/core/server), [OpenAI](https://platform.openai.com/docs/api-reference), [DeepSeek](https://api-docs.deepseek.com/), [Groq](https://console.groq.com/docs/openai), [Cohere](https://docs.cohere.com/v2), and [Jina](https://jina.ai/en-US/reranker/).

### Fresh-install routes and models

Fresh installs use LM Studio for answers, query expansion, summaries, and embeddings.
Reranking and both speech capabilities start unassigned.
The saved oMLX models are ready to use if an administrator selects oMLX for one of those capabilities.
The saved oMLX URL uses port 9000 and can be changed in Settings.

| Capability | Bootstrap provider | Bootstrap model |
| --- | --- | --- |
| Answers | LM Studio | `google/gemma-4-e4b` |
| Query expansion | LM Studio | `google/gemma-4-e4b` |
| Summaries | LM Studio | `google/gemma-4-e4b` |
| Embeddings | LM Studio | `text-embedding-embeddinggemma-300m-qat` |
| Reranking | Not selected | oMLX default `Qwen3-Reranker-4B-mxfp8` is available |
| Speech-to-text | Not selected | oMLX default `Qwen3-ASR-1.7B-8bit` is available |
| Text-to-speech | Not selected | oMLX default `Kokoro-82M-bf16`, voice `af_heart`, is available |

Work already in progress keeps its saved settings snapshot when a model, endpoint, or route changes.

## Embedding input formats

Embedding input formats are immutable PostgreSQL records that define how CiteLoom renders document text and query text before sending either to the embedding provider.
Each record has a human-readable name, schema version, document template, query template, deterministic SHA-256 input-format hash, creation time, and optional retirement time.
Each template must contain exactly one `{{text}}` placeholder.
The hash is derived from the schema version and both templates, so it can be verified without trusting the stored hash.
CiteLoom never infers an input format from an embedding model name.

A fresh database includes these formats:

| Name | Document template | Query template |
| --- | --- | --- |
| Plain | `{{text}}` | `{{text}}` |
| EmbeddingGemma | `title: none \| text: {{text}}` | `task: search result \| query: {{text}}` |
| Snowflake | `{{text}}` | `Represent this sentence for searching relevant passages: {{text}}` |

Use Settings to select an active format, create a format, copy an existing format, or create an immutable revision with different fields.
Creating a revision always inserts a new record instead of changing the meaning of the source record.
An unused format can be retired, but a format referenced by saved settings or any embedding space cannot be retired.
Retired records remain available for history and verification but cannot be selected.

## Thinking mode

Thinking mode is a CiteLoom runtime setting for answer generation, query expansion, and summarization.
CiteLoom handles reasoning output through its provider adapters, so no runtime-specific delimiter setup is needed.

| Setting | Behavior |
| --- | --- |
| Disabled | Default. Requests the adapter's non-thinking or lowest-reasoning behavior. |
| Enabled | Requests the adapter's high-reasoning behavior. |
| Provider default | Sends no CiteLoom thinking override and lets the provider or model decide. |

For OpenAI-compatible language adapters, CiteLoom sends `reasoning_effort` as `none` or `high`.
The DeepSeek adapter translates those values to its `thinking.type` contract.
The Ollama and Cohere adapters receive the AI SDK reasoning setting.
OpenAI Codex always uses a reasoning-capable request, so Disabled selects `low`, Enabled selects `high`, and Provider default omits the effort override.

Model support still varies within each provider.
Use Provider default if an endpoint rejects explicit thinking controls, and confirm behavior with the exact configured model rather than relying on model-family assumptions.

## Retrieval

The embedding input format, input-format hash, model, dimensions, retrieval-window policy, and optional space ID determine which document and query embeddings can be compared.
Each embedding space stores the selected format reference, hash, schema version, and both templates so the hash and rendering contract can be verified independently.
Changing the embedding model, dimensions, retrieval-window policy, or input format creates a new embedding space and requires reindexing.
A newly created selected space has no searchable documents until documents are reindexed for that configuration.
Settings reports this state to administrators instead of silently treating the old space as the selected one.

Retrieval settings control the search process.
They set how many passages CiteLoom considers, how it expands a question, how it combines meaning-based and keyword results, whether it reranks them, and how many passages reach the answer model.
Set Candidate count (`retrievalCandidates`) at least as high as Answer context count (`topK`).

### Optional reranking

Hybrid retrieval first combines meaning-based and keyword rankings.
Reranking can improve answer and citation accuracy by moving more relevant evidence into the answer context.
When reranking is enabled, CiteLoom sends the resulting candidate passages and original question to a specialized relevance model, reorders the candidates by its scores, and passes the best `topK` passages to the answer model.
A remote reranking provider adds inference cost.

Semantic discovery minimum (`rerankDiscoveryMinimumScore`) hides lower-scoring semantic results in Find Sources after reranking.
Calibrate this value for the configured reranker because different providers use different score scales.
Reranker scores control result order and Find Sources filtering.
Answer publication continues through structured generation, citation validation, and independent HHEM claim-support verification.

Adjust live retrieval behavior in Settings.
Use the [evaluation workflow](evaluation.md) to calibrate discovery thresholds and other tuned values.

### Reproducible generation

Query expansion and answer generation use separate sampling temperatures.
Both `queryExpansionTemperature` and `answerTemperature` default to `0` for the most repeatable provider behavior.
`generationSeedMode` defaults to `stable`.
In this mode, CiteLoom derives separate nonnegative seeds for query expansion and answer generation from the normalized question and the sorted IDs of the selected documents.
Set the mode to `random` to omit those seeds and let the provider choose the sampling randomness.

Stable mode sends the same temperature and seed for the same question and document scope.
Exact text can still vary when a provider ignores seeds or uses nondeterministic model operations.
Changing the document scope also changes the derived seeds.
When reranker scores are equal, CiteLoom uses stored document, version, file, and element IDs to produce a consistent order.

Every new research turn saves its generated queries, ordered source results, temperatures, and seeds in a retrieval trace.
Older turns created before traces were added remain readable but may not have one.
Asking the same question again creates a new run that can reflect changed documents, settings, models, or provider behavior.
Opening an existing turn reads the saved answer, citations, run settings, and retrieval trace without running the question again.

## Timeouts and cancellation

Answer, summary, query-expansion, embedding, reranking, HHEM, and Docling requests each have their own time limit.
For non-PDF files, the conversion time limit increases with file size up to the configured maximum.
PDF conversion uses the configured maximum.

Once Docling returns a task ID, CiteLoom persists it and resumes that task after worker recovery.
Cancelling locally stops CiteLoom from waiting.
The remote Docling task may continue.

## Document conversion

CiteLoom saves the Docling settings used when a conversion attempt begins.
If another worker resumes that attempt, it uses the saved settings even if the live settings have changed.

The PDF backend applies only to PDF requests.
Excel worksheets and PowerPoint slides retain their Docling location numbers, and worksheet names appear in section paths.
Excel formulas are indexed from their saved results.
Recalculate and save workbooks before ingestion.
Bounding-box source highlighting is limited to PDFs and standalone image files.

Thread count, page batch size, and pipeline profiling are process settings that require the Docling service to restart.
Restart workers with the same declared process settings so operational records remain accurate.

## Multiple Docling instances

CiteLoom coordinates multiple Docling instances through PostgreSQL.
Each instance needs a unique ID, URL, and capacity because only the instance that accepted a remote task can resume it.
Mount the same complete source-content store at `CITELOOM_SOURCE_CONTENT_DIRECTORY` as read-only storage in every instance.

Give every Docling instance a stable URL that recovery can reach.
The supplied topology uses named services instead of `docker compose --scale docling=N` or round-robin balancing behind one URL.

Maximum parallel conversions (`doclingDefaultServiceCapacity`) in the application Settings page limits the default service, and each additional service declares its own independent capacity.
The optional `docling-scale` Compose profile provides one named replica for local multi-instance operation.

```dotenv
DOCLING_ADDITIONAL_SERVICE_INSTANCES=[{"id":"replica-b","baseUrl":"http://127.0.0.1:5003","capacity":2}]
DOCLING_CONTAINER_ADDITIONAL_SERVICE_INSTANCES=[{"id":"replica-b","baseUrl":"http://docling-replica:5001","capacity":2}]
```

```bash
./infra/compose.sh --profile docling-scale up -d --wait docling-replica
```

## Provider models, overrides, and capacity

Configure each provider's supported model defaults on the application Settings page.
Answer, query-expansion, summarization, and embedding defaults include a configured context capacity.
Feature routing can override the selected model, and model capabilities can also override their context capacity.
Text-to-speech can override its voice.

Each provider sets one maximum number of parallel requests across all capabilities routed to it.
PostgreSQL applies that provider limit across web, command-line, and worker processes.
Routing several capabilities to one provider therefore shares the same capacity instead of creating a separate limit per model.
Docling conversion capacity remains attached to each stable Docling service instance because recovery must return to the service that accepted the task.
