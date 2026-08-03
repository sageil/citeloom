# Configuration

CiteLoom has two configuration layers:

- Use the Settings page for providers, models, search, answers, and document conversion.
- Use environment variables for database access, storage paths, web listeners, release information, and service processes.

Settings are stored in PostgreSQL.
Each job and answer run keeps the settings it started with.

## Configure providers

After CiteLoom starts, open Settings.
Configure a provider connection, then choose which features use it.
Ask, Chat, Indexing model, and Embedding model require a provider.
Query expansion requires a provider only when enabled.
Search ranking, Speech input, and Spoken answers are optional.
Each feature can use its own provider, model, maximum input size, URL, and sign-in details.
Existing installations initially copy their Answer route and model settings into Chat, after which later Chat changes are independent.

A fresh database uses Ollama for the required capabilities.
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
Each feature can use a different provider, so the service that writes answers does not have to be the service used for search or speech.

| Provider | Ask | Chat | Query expansion | Indexing model | Embedding model | Search ranking | Speech input | Spoken answers |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| oMLX | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes |
| Ollama | Yes | Yes | Yes | Yes | Yes | - | - | - |
| LM Studio | Yes | Yes | Yes | Yes | Yes | - | - | - |
| OpenAI | Yes | Yes | Yes | Yes | Yes | - | Yes | Yes |
| OpenAI Codex | Yes | Yes | Yes | Yes | - | - | - | - |
| DeepSeek | Yes | Yes | Yes | Yes | - | - | - | - |
| Groq | Yes | Yes | Yes | Yes | - | - | Yes | Yes |
| Cohere | Yes | Yes | Yes | Yes | Yes | Yes | - | - |
| Jina | - | - | - | - | Yes | Yes | - | - |
| Custom | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes |

Assign models that support their selected capabilities.
The Custom profile lets administrators choose the adapter used for each capability.

Docling VLM processing does not add another capability route to this table.
It selects an existing provider connection and reuses that connection's answer endpoint and credential while allowing a document-specific model override.
See [Standard and VLM processing](#standard-and-vlm-processing).

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

Fresh installs use Ollama for Ask, Chat, Query expansion, Indexing model, and Embedding model.
Search ranking and both speech features start unassigned.
The saved oMLX models are ready to use if an administrator selects oMLX for one of those capabilities.
The saved oMLX URL uses port 9000 and can be changed in Settings.

| Feature | Bootstrap provider | Bootstrap model |
| --- | --- | --- |
| Ask | Ollama | `gemma4:e4b-mlx` |
| Chat | Ollama | `gemma4:e4b-mlx` |
| Query expansion | Ollama | `gemma4:e4b-mlx` |
| Indexing model | Ollama | `gemma4:e4b-mlx` |
| Embedding model | Ollama | `snowflake-arctic-embed:137m` |
| Search ranking | Not selected | oMLX default `gte-reranker-modernbert-base` is available |
| Speech input | Not selected | oMLX default `Qwen3-ASR-1.7B-8bit` is available |
| Spoken answers | Not selected | oMLX default `Kokoro-82M-bf16`, voice `af_heart`, is available |

Work already in progress keeps its saved settings snapshot when a model, endpoint, or route changes.

### Ollama automatic context size

Automatic context size is enabled by default for Ollama language models.
It applies only to native Ollama GGUF language models used for Ask, Chat, Query expansion, and Indexing model.
It does not change Embedding model requests, other providers, or MLX runners.

For a bounded answer, CiteLoom calculates the requested context as:

```text
conservative input upper bound + maximum answer output + provider safety margin
```

CiteLoom uses a 65,536-token floor unless the model maximum reported by Ollama is smaller, and it never requests more than that model maximum.
The configured context capacity remains the fixed fallback when CiteLoom cannot inspect Ollama or the loaded model is not a native GGUF model.

These examples assume Ollama reports a model maximum of at least 131,072 tokens and use the fresh-install 20,000-token answer output limit and 2,048-token safety margin:

| Request | Calculation | Requested context |
| --- | --- | --- |
| Answer with a 27,544-token conservative input bound | `27,544 + 20,000 + 2,048 = 49,592` | `65,536`, because the calculated requirement is below the floor |
| Answer with a 50,000-token conservative input bound | `50,000 + 20,000 + 2,048 = 72,048` | `72,048` |
| Small answer while a 131,072-token runner is resident | Requirement is below `65,536`, but the resident runner is larger | Reuse `131,072`; a resident runner is never shrunk |
| Extra search query generation | CiteLoom assigns the adaptive floor directly rather than using answer-output variables | `65,536` |
| Summary, vision request, tool request, reasoning request, or answer without an output limit | CiteLoom cannot establish the same bounded answer requirement | The model maximum reported by Ollama |

Automatic context size requires CiteLoom's Ollama provider limit and Ollama's `OLLAMA_NUM_PARALLEL` setting to both be `1`.
Use a dedicated Ollama endpoint, or coordinate every client that can load the same model, because another client can change the resident runner.
The Settings page locks CiteLoom's provider limit to `1` while Automatic context size is enabled.
Turn Automatic context size off to make every Ollama language request use the configured fixed input size.

Fresh installations and provider resets enable Automatic context size.
An upgraded configuration with no saved Automatic context size choice is enabled when its Ollama provider limit is already `1`.
An explicit opt-out is preserved, and an older configuration with higher concurrency remains fixed-context instead of having its concurrency changed silently.

The fresh Mac language model uses MLX, so it continues to use fixed-context fallback behavior even though the setting is enabled.
Do not infer MLX context resizing from native GGUF behavior.

## Search text formats

Search text formats control how CiteLoom presents documents and searches to the selected embedding model.
CiteLoom does not choose a format from the model name, so select the format required by the model.

A fresh database includes these formats:

| Name | Document template | Query template |
| --- | --- | --- |
| Plain | `{{text}}` | `{{text}}` |
| EmbeddingGemma | `title: none \| text: {{text}}` | `task: search result \| query: {{text}}` |
| Snowflake | `{{text}}` | Use the exact query template required by the selected Snowflake model |

Custom templates must contain exactly one `{{text}}` placeholder.
The document template is applied to each searchable document section during indexing.
The query template is applied to each question or semantic search.
Use the prefixes required by the embedding model, and use Copy when a built-in format is a useful starting point.
Use format version 1 for a new format and increase it only when saving a changed version of an existing format.
Use Settings to select, create, copy, revise, or retire formats.
Revising a format creates a new format, and only unused formats can be retired.
Changing the selected format requires reindexing.

## Thinking mode

Thinking mode is a CiteLoom runtime setting for answer generation, extra search queries, and summarization.
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

## Search and answers

Changing the embedding model, dimensions, document section method, or search text format requires reindexing.
Settings reports when the selected configuration has no indexed documents.

Search and answer settings control how widely CiteLoom searches documents and how much source material it can use in an answer.
Sections considered (`retrievalCandidates`) is the maximum number of document sections CiteLoom checks for Ask, Chat, and semantic Find Sources.
Sections used in answers (`topK`) is the maximum number of the strongest matching sections CiteLoom can use to write an Ask or Chat answer.
Sections considered must be at least as large as Sections used in answers.
CiteLoom does not silently lower either configured value.
CiteLoom can still use fewer sections when fewer useful matches exist or the selected model cannot accept all of them.
Higher values take longer and use more memory and model input space.

Documents shown in Find Sources (`findSourcesResults`) controls both document lists on the Find Sources screen.
The Keyword matches list shows this many documents on each page, with remaining documents available on later pages.
The Semantic matches list shows up to this many documents after CiteLoom orders the configured number of search results and removes matches below the configured minimum score.
Excerpts shown per document controls how many matching excerpts appear inside each document result.
These two display settings do not change how many document sections CiteLoom searches.

### Optional search ranking

Hybrid retrieval searches both by meaning and by exact words, then combines the two result lists.
When search ranking is enabled, CiteLoom uses the configured ranking model to order the matching document sections for the original question.
Ask and Chat then use up to Sections used in answers (`topK`) of the strongest matching sections.
A remote search ranking service adds network time and provider usage.

Minimum score for Find Sources (`rerankDiscoveryMinimumScore`) defaults to `0.9`.
Find Sources does not show semantic matches scored below this value.
Check actual Find Sources results when changing it because different search ranking models use different score scales.
The value is not a percentage or confidence probability.
It affects Find Sources filtering but does not remove evidence from Ask.
Answer publication continues through structured generation and citation validation.
HHEM claim-support checks are advisory metadata and never remove or alter answer content or citations.

Adjust live retrieval behavior in Settings.
Use the [evaluation workflow](evaluation.md) to calibrate discovery thresholds and other tuned values.

### Repeatable answers and searches

Query expansion is disabled by default with `queryExpansions` set to `0`.
At `0`, CiteLoom searches only the original wording and does not ask a model to create more searches.
Values from `1` through `4` allow additional search wording and should be enabled only after a controlled comparison shows better search and answer quality on the intended documents.
Query expansion, Ask, and Chat each use their own temperature setting.
`queryExpansionTemperature`, `answerTemperature`, and `chatTemperature` default to `0` for the most repeatable provider behavior.
`generationSeedMode` defaults to `stable`.
In this mode, CiteLoom derives separate nonnegative seeds for extra search queries and answer generation from the normalized original question and the sorted IDs of the selected documents.
Set the mode to `random` to omit those seeds and let the provider choose the sampling randomness.

Stable mode sends the same temperature and seed for the same question and document scope.
Exact text can still vary when a provider ignores seeds or uses nondeterministic model operations.
Changing the document scope also changes the derived seeds.
When search ranking scores are equal, CiteLoom keeps a consistent order.

Every new research turn saves its generated queries, ordered source results, temperatures, and seeds in a retrieval trace.
Older turns created before traces were added remain readable but may not have one.
Asking the same question again creates a new run that can reflect changed documents, settings, models, or provider behavior.
Opening an existing turn reads the saved answer, citations, run settings, and retrieval trace without running the question again.

## Speech input and spoken answers

Speech input and spoken answers are independent optional routes.
Enabling one does not require enabling the other.
The provider matrix lists which built-in profiles expose each adapter, and the Custom profile can select a compatible speech adapter explicitly.

Speech input currently appears in Ask.
The Language hint and Vocabulary prompt are optional provider hints.
Transcription timeout limits one provider request, and Maximum audio size rejects a browser recording before it is sent when the recording is too large.
CiteLoom accepts supported WebM, Ogg, MP4, or WAV browser recordings and discards the temporary audio after transcription or cancellation.

Spoken answers appear in Ask and Chat.
The selected feature route can override the provider's default model and voice.
Speech speed and Speech generation timeout apply to each generated answer audio request.

When Preload answer audio is off, CiteLoom waits for the user to choose the speaker control before requesting audio.
When it is on, Ask and Chat request audio asynchronously after a completed answer is published or loaded.
Chat preloads only the latest completed assistant answer.
Preloading does not persist an audio file in CiteLoom; the browser holds a temporary object URL and releases it when the answer, research thread, or conversation changes.
Because preloading calls the selected provider even when the user never presses play, it can increase provider use.

## Time limits and cancellation

Ask, the indexing model, query expansion, embedding models, search ranking, citation checks, and Docling each have their own time limit.
For non-PDF files, the conversion time limit increases with file size up to the configured maximum.
PDF conversion uses the configured maximum.

Once Docling returns a task ID, CiteLoom persists it and resumes that task after worker recovery.
Cancelling locally stops CiteLoom from waiting.
The remote Docling task may continue.

## Document conversion

CiteLoom saves the Docling settings used when a conversion attempt begins.
If another worker resumes that attempt, it uses the saved settings even if the live settings have changed.

The Docling settings area is organized into four panels:

- Connection contains the Docling URL, optional API key, and default-service conversion capacity.
- PDF processing contains the Standard or VLM processing choice and the controls used by each mode.
- Performance and limits contains conversion and request time allowances.
- Diagnostics contains conversion-metric collection and retention.

### Standard and VLM processing

Standard is the fresh-install default.
It uses Docling's layout, OCR, and table models.
The PDF reader, scanned-text OCR, table structure, and table reading priority settings apply to Standard processing.
Extracted image quality controls the image scale supplied to the selected conversion pipeline.

The supplied Docling service processes eligible Standard PDFs in page ranges and saves completed range checkpoints.
After interruption, it can resume from the next incomplete range and assemble the completed ranges into one document.
CiteLoom also saves the remote Docling task ID, so a worker restart can continue polling a task that the same service still knows.

VLM processing visually reads each PDF page through a model reached from the Docling service.
The PDF page is encoded as an in-memory PNG and sent with the configured prompt.
This path does not save a persistent PNG copy of every page.
The supplied range-checkpoint and partial-document assembly path does not apply to VLM processing.
If the Docling service loses a VLM task, CiteLoom resubmits the unchanged source instead of continuing from a completed page range.

VLM processing uses an existing provider connection rather than a separate provider capability.
It reads that connection's answer URL, shared or answer-specific token, and answer model.
An explicit VLM model override replaces the answer model for document conversion only.
CiteLoom accepts any model identifier entered by the administrator and does not maintain a model allowlist.
The selected endpoint and model must accept OpenAI-compatible image chat requests and return document text that Docling can consume.

The supplied CiteLoom Docling image enables remote services and custom VLM configuration.
It also sends the prompt before the image and normalizes the inline labels and bounding boxes returned by the saved Unlimited OCR model into Markdown.
An independently managed Docling service must enable its equivalent remote-service and custom-VLM settings and must implement response handling compatible with the selected model.

The Ollama VLM endpoint is derived by adding `/v1/chat/completions` to a native Ollama base URL.
Other provider base URLs use their configured OpenAI-compatible `/chat/completions` route.
If the selected connection has no usable URL or model, CiteLoom rejects the effective configuration instead of starting a conversion with missing values.

Fresh installations save these VLM values while leaving Standard selected:

| Setting | Fresh-install value | Effect |
| --- | --- | --- |
| Processing mode | `standard` | New conversions use the Standard pipeline until an administrator selects VLM. |
| VLM provider | Ollama | Docling sends visual page requests to the saved Ollama connection when VLM is selected. |
| VLM model override | `frob/unlimited-ocr:q8_0` | VLM conversion uses this model instead of the Ollama answer model. |
| VLM instructions | `document parsing.` | The same task instruction is sent with each PDF page. |
| VLM output limit | `32768` tokens | This is the requested maximum output for one page; the provider or model may enforce a smaller limit. |

Saving a model identifier does not download its weights.
Install or make the selected VLM model available at the provider endpoint before switching the processing mode.

Changing the processing mode or its options affects new conversion attempts.
Reindex an existing document when it must be converted with the new mode.
Conversion time varies with page count, page complexity, model speed, endpoint load, and output length, so validate Standard and VLM performance with representative documents before choosing deployment limits.

VLM page content and the configured provider credential pass from the Docling container to the selected endpoint.
Document processing remains local only when that endpoint is local and trusted.

The PDF backend applies only to PDF requests.
Excel worksheets and PowerPoint slides retain their Docling location numbers, and worksheet names appear in section paths.
Excel formulas are indexed from their saved results.
Recalculate and save workbooks before ingestion.
Bounding-box source highlighting is limited to PDFs and standalone image files.

Use document headings in search is a Docling setting because CiteLoom reads headings while processing a document.
When enabled, Ask and Chat can use a document's table of contents to find relevant sections in long documents.
Table-of-contents titles help search but are not used as answer sources or citations.
Run `pnpm dev document-toc backfill` after enabling the setting to update existing documents without converting or fully indexing them again.
For the supplied container deployment, run `./infra/compose.sh --profile worker run --rm --no-deps worker node dist/cli/index.js document-toc backfill`.
The command is safe to rerun because it skips documents that are already updated.
Turning the setting off stops using document headings as an additional search aid. Regular search continues to work.

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

## Provider models and request limits

Configure each provider's supported model defaults on the application Settings page.
Ask, Query expansion, Indexing model, and Embedding model include a configured maximum input size.
Each feature can select a model and input size that differ from the provider defaults.
Spoken answers can also select a different voice.

Each provider sets one maximum number of parallel requests across all capabilities routed to it.
PostgreSQL applies that provider limit across web, command-line, and worker processes.
Routing several capabilities to one provider therefore shares the same capacity instead of creating a separate limit per model.
Docling conversion capacity remains attached to each stable Docling service instance because recovery must return to the service that accepted the task.
