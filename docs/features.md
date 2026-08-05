# Features

This guide describes the product features available in the current CiteLoom web application, command-line tools, and supplied self-hosted deployment.
It is written for workspace members and administrators who need to know what CiteLoom can do and where each control belongs.

## Accounts and workspace access

CiteLoom uses workspace accounts backed by PostgreSQL sessions.
Every user can change their own password from Account and access.
New users set their first password through the time-limited setup link created by an administrator.
Sign-in can create a regular session or a longer remembered session, and signing out revokes the current session.

Workspace members can upload and manage documents, control their own ingestion jobs, search, ask questions, chat, and save research.
Workspace administrators can also add and remove users, assign member or administrator roles, create password-reset links, change application settings, run provider diagnostics, and review operational errors.
CiteLoom prevents removal of the final active administrator.

See [Deployment](deployment.md#administrator-bootstrap) for authentication, session, and administrator bootstrap details.

## Document library and ingestion

CiteLoom accepts PDF, HTML, DOCX, XLSX, PPTX, JPEG, PNG, WebP, and nonempty UTF-8 text files.
Uploaded source bytes are stored unchanged in the content store and identified by SHA-256.
PostgreSQL stores document metadata, processing state, version records, and search indexes.

The Overview and Documents screens provide these controls:

- Upload one or more documents and assign tags during intake.
- Browse all documents, uploads, untagged documents, and tag-based collections.
- Search the catalog and filter it by processing state or tag.
- Sort documents by update time or name.
- Inspect stored, normalized, embedded, and ready progress.
- View the stored source path, indexed text, tables, images, page counts, and processing failures.
- Add, remove, and save document tags.
- Pause, resume, or cancel an eligible PDF ingestion owned by the current user.
- Retry a failed ingestion job.
- Reindex a ready document while its current version remains searchable.
- Delete a document after confirmation when no ingestion or reindex is active.
- Open the saved source for the active document version.
- Review document version history and compare added, modified, and removed evidence between adjacent versions.
- Select documents and carry that selection into Ask or Chat.

Administrators can pause, resume, or cancel any workspace ingestion job.
Cancellation removes partial indexing work, while canceling a reindex preserves the current searchable version.
Document deletion and unreferenced source cleanup are durable operations that resume after a restart.

See [Configuration](configuration.md#document-conversion) for processing choices and [Operations](operations.md#reindexing) for reindexing behavior.

## Ask and saved research

Ask retrieves evidence from the chosen scope and generates a structured answer with validated citations.
A question can search all ready documents, selected documents, or any document carrying one of the selected tags.

Each saved research thread can contain multiple turns.
Opening an existing turn reads its stored answer, citations, settings snapshot, and retrieval trace without running the models again.
Users can create and delete threads, export a thread as Markdown or JSON, and rate retrieval relevance, answer usefulness, and citation correctness.

Ask streams the completed published answer and exposes:

- A direct answer without citation markers and supporting findings with inline citation markers.
- The documents and pages used by the answer.
- Original text, structured table, image, and highlighted PDF evidence.
- The exact retained document version when the current library version has changed.
- Advisory HHEM support checks for cited findings.
- Advanced retrieval, model, timing, and run diagnostics when available.

The answer model can cite only evidence references supplied for the current request.
The server validates those references and creates the stored citation records.
The direct answer remains separate from citations, while supporting findings link to the evidence that HHEM checks.
HHEM scores are advisory and never remove, rewrite, or add answer content or citations.

## Find Sources

Find Sources searches without generating an answer.
Keyword search finds exact words and phrases through PostgreSQL BM25 indexes.
Optional semantic search finds related meaning through the configured embedding and search-ranking pipeline.

Results are grouped by document and show configurable matching excerpts.
Keyword results are paginated.
Semantic results are limited by the configured result count and optional ranking-score threshold.
Users can add useful result documents to the current question selection and continue in Ask.

## Document-grounded Chat

Chat provides private, multi-turn conversations grounded in selected documents.
A conversation can use all ready documents, selected documents, or selected tags.
Each conversation is visible only to its creator in the active workspace.

CiteLoom stores every user message and completed assistant response.
It uses complete recent turns and, when needed, semantically relevant earlier turns to clarify follow-up questions.
Conversation memory is context only and cannot serve as evidence for a factual claim.
Each factual response must use currently retrieved document evidence and validated citations.
When retrieval finds no relevant evidence, Chat returns an uncited response instead of relying on general model knowledge.

Chat preserves its message text, citation snapshots, retained image evidence, retrieval trace, memory trace, and run configuration.
Deleting a library document does not change existing chat evidence.
Deleting a chat permanently removes its messages and citation records, then makes otherwise unreferenced source bytes eligible for durable cleanup.

## Evidence inspection and document history

Ask and Chat use the same evidence presentation components.
Text is shown with its retained section and page location.
Structured tables render as HTML when table structure is available.
Images use retained source crops.
PDF citations can open a generated copy with the cited region highlighted.

Citation evidence remains tied to the exact document version used for the answer.
The inspector identifies superseded versions and lets the user open the retained original instead of silently substituting the current library version.

## Speech input and spoken answers

Speech input is optional and currently applies to Ask.
Users can record with the microphone control or hold Option on macOS or Alt on Windows and Linux, then edit the transcript before submitting it.
CiteLoom sends the temporary recording to the configured transcription provider and discards it after transcription or cancellation.

Spoken answers are optional in both Ask and Chat.
Ask can play the displayed answer, and Chat can play any completed assistant answer in the conversation.
The administrator selects the provider, model, voice, speed, and timeout in Settings.
When Preload answer audio is enabled, the browser requests the audio asynchronously after a completed answer is loaded or published.
When it is disabled, CiteLoom requests audio only after the user chooses the play control.
Generated browser audio URLs are released when the answer, thread, or conversation changes.

## Search and answer controls

Administrators can choose Keyword, Semantic, or Hybrid retrieval for Ask and Chat.
Keyword uses BM25 exact-word retrieval and does not embed the document query.
Semantic embeds the document query and searches by vector similarity.
Hybrid runs both paths and combines them through weighted Reciprocal Rank Fusion.
Administrators can also configure how many matching sections are reviewed, how many sections an answer may use, how many Find Sources results and excerpts are displayed, and how semantic, lexical, and repeated matches influence ordering.

Optional Query Expansion creates up to four alternative searches for a question.
Optional search ranking reorders the strongest candidates from any search method with a dedicated relevance model.
Stable seed mode asks compatible providers for repeatable Query Expansion results and answer text, while random mode omits those deterministic seeds.

Document table-of-contents routing can use stored headings as an additional way to reach relevant branches in long documents.
Headings improve routing but are never answer evidence or citations.

Search text formats control the document and query templates sent to an embedding model.
Administrators can create a format, copy a built-in format, create a new revision of a used format, and retire an unused format.
Changing the selected format requires reindexing because it changes both stored document embeddings and future query embeddings.

See [Configuration](configuration.md#search-and-answers) for the exact controls and constraints.

## Providers and feature routing

Administrators can route Ask, Chat, Query Expansion, indexing summaries, embeddings, search ranking, speech input, and spoken answers independently.
Feature routes can override the provider model and, where the capability exposes it, input capacity or speech voice.
Provider connections contain their endpoint, credentials, default models, and one deployment-wide concurrency limit shared by all capabilities using that provider.

Built-in profiles are available for oMLX, Ollama, LM Studio, OpenAI, OpenRouter, OpenAI Codex, DeepSeek, Groq, Cohere, Jina, and Custom endpoints.
OpenAI Codex uses device authorization from Settings.
The Custom profile lets the administrator select the protocol adapter for each supported capability.

Ollama language routes can use automatic context sizing for native GGUF models.
It calculates bounded answer requirements, applies a 65,536-token floor without exceeding the model maximum, and reuses a larger resident runner without shrinking it.
MLX runners, embeddings, and other providers continue to use their fixed configured limits.

See [Configuration](configuration.md#provider-reference) for the capability matrix and endpoint conventions.

## Standard and VLM document processing

Standard is the default Docling processing mode.
It uses Docling's layout, OCR, and table models and exposes PDF reader, OCR, table-structure, and table-priority controls.
Standard PDF processing uses page-range checkpoints in the supplied Docling service, so interrupted work can resume from completed ranges.

VLM mode visually reads each PDF page with a model reached through an existing CiteLoom provider connection.
The administrator can select the provider, enter any model identifier accepted by that endpoint, override the page prompt, and set the maximum output tokens per page.
Leaving the model override blank uses the provider's configured answer model.
CiteLoom does not restrict model identifiers, but the selected endpoint and model must accept OpenAI-compatible image chat requests and return usable document text.

The VLM request renders a page as an in-memory PNG and sends the prompt and image to the configured endpoint.
CiteLoom does not create a persistent PNG copy of every PDF page for this path.
Provider credentials and document page content leave the Docling container for the configured VLM endpoint, so processing remains local only when that endpoint is local and trusted.

CiteLoom persists the Docling task ID in both modes and can resume polling a task that the same Docling service still knows.
The supplied page-range checkpoint and partial-document assembly path applies only to Standard PDFs.
If a VLM task is lost by the Docling service, CiteLoom must resubmit the unchanged source rather than continue from a completed page range.

See [Configuration](configuration.md#document-conversion) for setup and lifecycle details.

## Settings and safe resets

The Settings page separates provider connections, feature routes, runtime controls, and startup-only deployment values.
Runtime changes are versioned in PostgreSQL and new work receives the effective settings snapshot that exists when it starts.
Work already in progress continues with its saved snapshot.

Administrators can search settings, filter them by state or area, save pending changes, reset one setting to its database default, reset one feature or settings panel, or reset all runtime settings.
Feature, panel, and global resets show a branded confirmation dialog and name the affected scope before applying changes.
Changing an embedding model, dimensions, search text format, section method, or search-index name can require document reindexing.

The Docling settings area groups its controls into Connection, PDF processing, Performance and limits, and Diagnostics panels.
See [Configuration](configuration.md) for the settings reference.

## System health, diagnostics, and error reports

System health shows the current runtime state, model and service configuration, request capacity, worker and scheduling telemetry, and recent usage metrics when collection is enabled.
An administrator can run service-readiness diagnostics without model inference, then explicitly select optional live model, speech, or reranking tests that may use provider credits or local compute.

The Error reports screen is administrator-only.
It lists sanitized operational failures by ingestion, application, or general area and includes identifiers and Docling details useful for diagnosis.
Purge logs opens a confirmation dialog and deletes the operational error rows visible to the current workspace, including global rows visible there.
It does not delete Docker or host process logs.

Retention limits for stored operational errors are configured through environment variables.
AI request diagnostics and Docling conversion diagnostics can be enabled separately and do not store document or question content.
See [Operations](operations.md#health-diagnostics-and-error-reports) for the operator workflow.

## Durability, recovery, and operations

PostgreSQL leases coordinate ingestion workers, Chat runs, and provider request capacity across processes.
Renewable leases and fenced attempts prevent an expired worker or Chat attempt from publishing after a newer attempt has taken ownership.
Completed document indexes and answers are published atomically so partial results remain unavailable.

CiteLoom supports coordinated PostgreSQL and source-content backups, guarded restore, embedding-space retention, document TOC backfill, queue inspection, failed-job retries, and dependency diagnostics.
Docker Compose reconciles interrupted starts while preserving bind-mounted PostgreSQL and source-content data.

See [Operations](operations.md), [pnpm commands](commands.md), and [Architecture](architecture.md) for the complete operational and internal behavior.

## Evaluation tooling

The repository includes offline tools for preparing corpora, generating and scoring datasets, tuning retrieval parameters, freezing configurations, and auditing claim verification.
These tools are not part of the production application image.
See [Evaluation](evaluation.md) and [Evaluation corpora](../corpora/README.md).
