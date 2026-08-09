# Features

This guide explains what CiteLoom can do, who can use each feature, and where its important limits are.
Workspace members should use the in-app Help page for step-by-step instructions.
Administrators should use [Configuration](configuration.md) for exact settings and [Operations](operations.md) for maintenance and recovery.

## How CiteLoom uses AI

CiteLoom answers from the ready documents in the scope you choose.
It does not treat the language model's general knowledge or earlier chat messages as source evidence.

The answer has two layers:

- The direct answer summarizes the result without citation markers.
- Supporting findings or topics link to the original evidence with citations such as `[1]`.

The server validates citation references before publishing an answer.
An advisory Hughes Hallucination Evaluation Model (HHEM) score can help you review whether a cited passage supports a finding, but it is not a correctness guarantee.
Always inspect the cited evidence before relying on an important result.

## Accounts and access

Every person uses an individual workspace account.
Members can manage documents, run searches, ask questions, chat, and save research.
Administrators can also manage users, providers, application settings, diagnostics, and retained error reports.

New users set their password from a time-limited link created by an administrator.
Every user can change their own password, and the workspace always keeps at least one active administrator.

## Build a document library

CiteLoom accepts these inputs:

| Type | Formats |
| --- | --- |
| Documents | PDF, HTML, and DOCX |
| Spreadsheets | XLSX |
| Presentations | PPTX |
| Images | JPEG, PNG, and WebP |
| Text | Nonempty, readable UTF-8 files, including files with an unknown extension or no extension |

Uploaded source bytes stay unchanged in the content store.
The library tracks metadata, tags, processing state, searchable versions, and document history in PostgreSQL.

From Overview or Documents, members can:

- Upload one or more files and add tags.
- Browse all, uploaded, untagged, or tagged documents.
- Search, filter, and sort the catalog.
- Inspect processing progress, extracted text, tables, images, page counts, and errors.
- Pause or resume eligible PDF work, cancel active work, and retry failures they own.
- Ask the browser to notify them when a processing document becomes ready or needs attention.
- Reindex a ready document while its current version remains searchable.
- Compare evidence changes between adjacent versions.
- Open the source file for the active or retained version.
- Delete an idle document after confirmation.
- Select documents and carry that scope into Ask or Chat.

Administrators can control any workspace ingestion job.
Cancelling a new ingestion removes its partial indexing work.
Cancelling a reindex keeps the current searchable version.

Browser notifications require a secure browser context, notification permission, and an open CiteLoom page.
The notification preference is stored for the signed-in user and workspace in that browser.

## Ask questions and save research

Ask retrieves evidence from all ready documents, selected documents, or documents matching any selected tag.
Each completed question becomes a turn in a saved research thread.

A saved turn keeps its answer, citations, exact evidence, settings snapshot, and retrieval trace.
Opening it later reads the stored result without running retrieval or generation again.
A new submission creates a new run that can reflect changed documents, settings, models, or provider behavior.

Members can create or delete threads, export a thread as Markdown or JSON, and rate source relevance, answer usefulness, and citation correctness where those controls appear.

## Find source material without an answer

Find Sources is for discovery rather than synthesis.
Keyword matching finds exact terms and phrases.
Semantic matching can also return related content that uses different wording.

Results are grouped by document and include matching excerpts.
Keyword results continue across pages, while semantic results use the configured display limit and ranking threshold.
Members can add useful result documents to the current question scope and continue in Ask.

## Chat with selected documents

Chat supports private, multi-turn conversations over all ready documents, selected files, or selected tags.
Only the conversation creator can open a chat in the current workspace.

CiteLoom stores every user message and completed assistant response.
It keeps complete recent turns and may retrieve relevant earlier turns when the whole conversation no longer fits.
Conversation history can clarify a follow-up question, but every factual response still needs currently retrieved document evidence.
If no relevant document evidence is available, Chat returns an uncited response instead of filling the gap with general model knowledge.

Deleting a library document does not rewrite saved chat evidence.
Deleting a chat permanently removes its messages and citation records, then makes otherwise unreferenced source bytes eligible for durable cleanup.

## Inspect citations and retained evidence

Ask and Chat can show:

- Original text with its section and page location.
- Structured tables when the source contains usable table structure.
- Retained source images and image crops.
- A highlighted PDF region or highlighted HTML or plain-text source view.
- The exact older source version when the library has since changed.
- HHEM score markers alongside the workspace's configured support threshold.

Retrieved source material lists what CiteLoom reviewed while preparing the answer.
Relevant material does not automatically become a citation, so this list can be longer than the cited-source list.

## Dictate questions and listen to evidence

Speech input and spoken answers are separate optional features.

When speech input is enabled, members can dictate an Ask question or Chat message, review the transcript, and edit it before submission.
The temporary browser recording is sent to the configured transcription provider and discarded after transcription or cancellation.

When spoken answers are enabled, members can play completed Ask and Chat answers and supported text evidence.
Audio can be generated on demand or preloaded after an answer finishes.
The browser holds the generated audio temporarily and releases it when the answer, thread, or conversation changes.

## Control search and answer behavior

Administrators can choose:

- Keyword, Semantic, or Hybrid document retrieval.
- The candidate search size and the maximum evidence sent to the answer model.
- Optional Query Expansion with up to four alternative searches.
- Optional model-based search ranking.
- Find Sources result and excerpt counts.
- Relative influence for exact, semantic, and repeated matches.
- Embedding dimensions, document section size, and search text format.
- Document heading routes that help reach relevant branches in long documents.

Generated headings, descriptions, and summaries can improve discovery, but they are not answer sources or citations.
Changing an embedding model, vector dimensions, search text format, section method, or search-index name requires reindexing.

## Route work to model providers

Administrators can route Ask, Chat, Query Expansion, the Indexing model, embeddings, search ranking, speech input, and spoken answers independently.
Feature routes can override a provider's default model and supported capacity or voice settings.

Built-in profiles are available for oMLX, Ollama, LM Studio, OpenAI, OpenRouter, OpenAI Codex, DeepSeek, Groq, Mistral AI, Together AI, Cohere, Jina, and Custom connections.
OpenAI Codex uses device authorization.
Other profiles use API tokens when their endpoints require authentication.

One concurrency limit applies across every capability routed to the same provider.
See the [provider reference](configuration.md#provider-reference) for supported combinations and endpoint conventions.

## Choose document processing

Standard Docling processing is the default.
It uses layout, optical character recognition (OCR), and table models.
Eligible Standard PDFs use page-range checkpoints so interrupted work can continue from completed ranges.

Visual language model (VLM) processing sends each rendered PDF page to an image-capable model through an existing provider connection.
It does not persist a separate PNG copy of every page, and it does not use Standard PDF page-range checkpoints.
Document pages and provider credentials leave the Docling container for the configured endpoint, so VLM processing stays local only when that endpoint is local and trusted.

## Administer and recover the workspace

Settings changes are versioned in PostgreSQL.
New work uses the effective settings snapshot available when it starts, while work already running keeps its original snapshot.
Administrators can reset one value, one settings area, or all runtime settings after confirming the scope.

System health shows runtime state, configured models, service and provider capacity, worker state, scheduling telemetry, and enabled usage metrics.
Service-readiness diagnostics avoid model inference.
Optional live tests can use provider credits or local compute and must be selected explicitly.

Error reports contain sanitized operational failures stored in PostgreSQL.
Purging them does not delete Docker, systemd, or other host logs.

PostgreSQL leases coordinate workers, Chat runs, and provider capacity across processes.
Document indexes and answers are published atomically so partial results do not become available.
The supplied tools support coordinated backup and restore, queue inspection, retries, reindexing, document-heading backfill, and embedding-space retention.

## Evaluate retrieval and citation support

The repository includes offline tools for corpus management, reviewed datasets, retrieval scoring, parameter search, configuration freezes, and claim-verification audits.
These tools are excluded from the production application image.
See [Evaluation](evaluation.md) for the workflow and [Evaluation corpora](../corpora/README.md) for source provenance.
