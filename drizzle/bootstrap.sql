INSERT INTO "application_revisions" ("channel")
VALUES ('catalog'), ('jobs'), ('settings')
ON CONFLICT ("channel") DO NOTHING;

INSERT INTO "embedding_input_formats" (
  "id",
  "input_format_hash",
  "name",
  "schema_version",
  "document_template",
  "query_template"
)
VALUES
  (
    '00000000-0000-4000-8000-000000000001',
    'd6a52dbb7576b4b903d1b38cf25ed56bb1323e538ef84535897b84f0e97b0a9b',
    'Plain',
    1,
    '{{text}}',
    '{{text}}'
  ),
  (
    '00000000-0000-4000-8000-000000000002',
    'a50500d0b2118ae88820af216c21f2a7bdc344a14286574c517f93a8e45ce227',
    'EmbeddingGemma',
    1,
    'title: none | text: {{text}}',
    'task: search result | query: {{text}}'
  ),
  (
    '00000000-0000-4000-8000-000000000003',
    '68be6162f967ab76390e9e1e897c9a0c5297f27e02ac83c45594ffc73cf0862b',
    'Snowflake',
    1,
    '{{text}}',
    'Represent this sentence for searching relevant passages: {{text}}'
  )
ON CONFLICT ("id") DO NOTHING;

WITH canonical_settings AS (
  SELECT jsonb_set(
    $settings$
  {
    "providers": {
      "catalog": [
        {
          "adapterConfiguration": "catalog",
          "authentication": "api-token",
          "capabilities": [
            { "adapter": "openai-compatible-language", "capability": "answer" },
            { "adapter": "openai-compatible-language", "capability": "chat" },
            { "adapter": "openai-compatible-language", "capability": "queryExpansion" },
            { "adapter": "openai-compatible-language", "capability": "indexing" },
            { "adapter": "openai-compatible-embedding", "capability": "embedding" },
            { "adapter": "top-n-rerank", "capability": "reranking" },
            { "adapter": "omlx-transcription", "capability": "speechToText" },
            { "adapter": "omlx-speech", "capability": "textToSpeech" }
          ],
          "displayName": "oMLX",
          "doclingVlm": { "endpointStyle": "openai", "engineType": "api" },
          "id": "omlx"
        },
        {
          "adapterConfiguration": "catalog",
          "authentication": "api-token",
          "capabilities": [
            { "adapter": "ollama-language", "capability": "answer" },
            { "adapter": "ollama-language", "capability": "chat" },
            { "adapter": "ollama-language", "capability": "queryExpansion" },
            { "adapter": "ollama-embedding", "capability": "embedding" },
            { "adapter": "ollama-language", "capability": "indexing" }
          ],
          "displayName": "Ollama",
          "doclingVlm": { "endpointStyle": "ollama", "engineType": "api_ollama" },
          "id": "ollama"
        },
        {
          "adapterConfiguration": "catalog",
          "authentication": "api-token",
          "capabilities": [
            { "adapter": "openai-compatible-language", "capability": "answer" },
            { "adapter": "openai-compatible-language", "capability": "chat" },
            { "adapter": "openai-compatible-language", "capability": "queryExpansion" },
            { "adapter": "openai-compatible-language", "capability": "indexing" },
            { "adapter": "openai-compatible-embedding", "capability": "embedding" }
          ],
          "displayName": "LM Studio",
          "doclingVlm": { "endpointStyle": "openai", "engineType": "api_lmstudio" },
          "id": "lmstudio"
        },
        {
          "adapterConfiguration": "catalog",
          "authentication": "api-token",
          "capabilities": [
            { "adapter": "openai-compatible-language", "capability": "answer" },
            { "adapter": "openai-compatible-language", "capability": "chat" },
            { "adapter": "openai-compatible-language", "capability": "queryExpansion" },
            { "adapter": "openai-compatible-language", "capability": "indexing" },
            { "adapter": "openai-compatible-embedding", "capability": "embedding" },
            { "adapter": "openai-transcription", "capability": "speechToText" },
            { "adapter": "openai-speech", "capability": "textToSpeech" }
          ],
          "displayName": "OpenAI",
          "doclingVlm": { "endpointStyle": "openai", "engineType": "api_openai" },
          "id": "openai"
        },
        {
          "adapterConfiguration": "catalog",
          "authentication": "api-token",
          "capabilities": [
            { "adapter": "openrouter-language", "capability": "answer" },
            { "adapter": "openrouter-language", "capability": "chat" },
            { "adapter": "openrouter-language", "capability": "queryExpansion" },
            { "adapter": "openrouter-language", "capability": "indexing" },
            { "adapter": "openai-compatible-embedding", "capability": "embedding" },
            { "adapter": "top-n-rerank", "capability": "reranking" },
            { "adapter": "openrouter-transcription", "capability": "speechToText" },
            { "adapter": "openrouter-speech", "capability": "textToSpeech" }
          ],
          "displayName": "OpenRouter",
          "doclingVlm": { "endpointStyle": "openai", "engineType": "api" },
          "id": "openrouter"
        },
        {
          "adapterConfiguration": "catalog",
          "authentication": "openai-device",
          "capabilities": [
            { "adapter": "openai-codex-language", "capability": "answer" },
            { "adapter": "openai-codex-language", "capability": "chat" },
            { "adapter": "openai-codex-language", "capability": "queryExpansion" },
            { "adapter": "openai-codex-language", "capability": "indexing" }
          ],
          "displayName": "OpenAI Codex",
          "doclingVlm": null,
          "id": "openai-codex"
        },
        {
          "adapterConfiguration": "catalog",
          "authentication": "api-token",
          "capabilities": [
            { "adapter": "deepseek-language", "capability": "answer" },
            { "adapter": "deepseek-language", "capability": "chat" },
            { "adapter": "deepseek-language", "capability": "queryExpansion" },
            { "adapter": "deepseek-language", "capability": "indexing" }
          ],
          "displayName": "DeepSeek",
          "doclingVlm": { "endpointStyle": "openai", "engineType": "api" },
          "id": "deepseek"
        },
        {
          "adapterConfiguration": "catalog",
          "authentication": "api-token",
          "capabilities": [
            { "adapter": "openai-compatible-language", "capability": "answer" },
            { "adapter": "openai-compatible-language", "capability": "chat" },
            { "adapter": "openai-compatible-language", "capability": "queryExpansion" },
            { "adapter": "openai-compatible-language", "capability": "indexing" },
            { "adapter": "openai-transcription", "capability": "speechToText" },
            { "adapter": "groq-speech", "capability": "textToSpeech" }
          ],
          "displayName": "Groq",
          "doclingVlm": { "endpointStyle": "openai", "engineType": "api" },
          "id": "groq"
        },
        {
          "adapterConfiguration": "catalog",
          "authentication": "api-token",
          "capabilities": [
            { "adapter": "openai-compatible-language", "capability": "answer" },
            { "adapter": "openai-compatible-language", "capability": "chat" },
            { "adapter": "openai-compatible-language", "capability": "queryExpansion" },
            { "adapter": "openai-compatible-language", "capability": "indexing" },
            { "adapter": "openai-compatible-embedding", "capability": "embedding" },
            { "adapter": "mistral-transcription", "capability": "speechToText" },
            { "adapter": "mistral-speech", "capability": "textToSpeech" }
          ],
          "displayName": "Mistral AI",
          "doclingVlm": { "endpointStyle": "openai", "engineType": "api" },
          "id": "mistral"
        },
        {
          "adapterConfiguration": "catalog",
          "authentication": "api-token",
          "capabilities": [
            { "adapter": "openai-compatible-language", "capability": "answer" },
            { "adapter": "openai-compatible-language", "capability": "chat" },
            { "adapter": "openai-compatible-language", "capability": "queryExpansion" },
            { "adapter": "openai-compatible-language", "capability": "indexing" },
            { "adapter": "openai-compatible-embedding", "capability": "embedding" },
            { "adapter": "openai-transcription", "capability": "speechToText" },
            { "adapter": "openai-speech", "capability": "textToSpeech" }
          ],
          "displayName": "Together AI",
          "doclingVlm": { "endpointStyle": "openai", "engineType": "api" },
          "id": "together"
        },
        {
          "adapterConfiguration": "catalog",
          "authentication": "api-token",
          "capabilities": [
            { "adapter": "cohere-language", "capability": "answer" },
            { "adapter": "cohere-language", "capability": "chat" },
            { "adapter": "cohere-language", "capability": "queryExpansion" },
            { "adapter": "cohere-language", "capability": "indexing" },
            { "adapter": "cohere-embedding", "capability": "embedding" },
            { "adapter": "cohere-rerank", "capability": "reranking" }
          ],
          "displayName": "Cohere",
          "doclingVlm": null,
          "id": "cohere"
        },
        {
          "adapterConfiguration": "catalog",
          "authentication": "api-token",
          "capabilities": [
            { "adapter": "openai-compatible-embedding", "capability": "embedding" },
            { "adapter": "top-n-rerank", "capability": "reranking" }
          ],
          "displayName": "Jina",
          "doclingVlm": null,
          "id": "jina"
        },
        {
          "adapterConfiguration": "connection",
          "authentication": "api-token",
          "capabilities": [
            { "adapter": "openai-compatible-language", "capability": "answer" },
            { "adapter": "openai-compatible-language", "capability": "chat" },
            { "adapter": "openai-compatible-language", "capability": "queryExpansion" },
            { "adapter": "openai-compatible-language", "capability": "indexing" },
            { "adapter": "openai-compatible-embedding", "capability": "embedding" },
            { "adapter": "top-n-rerank", "capability": "reranking" },
            { "adapter": "openai-transcription", "capability": "speechToText" },
            { "adapter": "openai-speech", "capability": "textToSpeech" }
          ],
          "displayName": "Custom",
          "doclingVlm": { "endpointStyle": "openai", "engineType": "api" },
          "id": "custom"
        }
      ],
      "connections": {
        "cohere": {
          "apiToken": null,
          "answer": {
            "apiToken": null,
            "baseUrl": null,
            "contextCapacityTokens": null,
            "model": null
          },
          "baseUrl": "https://api.cohere.com/v2",
          "customAdapters": {
            "answer": "openai-compatible-language",
            "embedding": "openai-compatible-embedding",
            "queryExpansion": "openai-compatible-language",
            "reranking": "top-n-rerank",
            "speechToText": "openai-transcription",
            "indexing": "openai-compatible-language",
            "textToSpeech": "openai-speech"
          },
          "embedding": {
            "apiToken": null,
            "baseUrl": null,
            "contextCapacityTokens": null,
            "model": null
          },
          "queryExpansion": {
            "apiToken": null,
            "baseUrl": null,
            "contextCapacityTokens": null,
            "model": null
          },
          "maximumParallelRequests": 1,
          "name": null,
          "thinkingMode": "disabled",
          "reranking": {
            "apiToken": null,
            "baseUrl": null,
            "model": null
          },
          "speechToText": {
            "apiToken": null,
            "baseUrl": null,
            "model": null
          },
          "indexing": {
            "apiToken": null,
            "baseUrl": null,
            "contextCapacityTokens": null,
            "model": null
          },
          "textToSpeech": {
            "apiToken": null,
            "baseUrl": null,
            "model": null,
            "voice": null
          }
        },
        "custom": {
          "apiToken": null,
          "answer": {
            "apiToken": null,
            "baseUrl": null,
            "contextCapacityTokens": null,
            "model": null
          },
          "baseUrl": null,
          "customAdapters": {
            "answer": "openai-compatible-language",
            "embedding": "openai-compatible-embedding",
            "queryExpansion": "openai-compatible-language",
            "reranking": "top-n-rerank",
            "speechToText": "openai-transcription",
            "indexing": "openai-compatible-language",
            "textToSpeech": "openai-speech"
          },
          "embedding": {
            "apiToken": null,
            "baseUrl": null,
            "contextCapacityTokens": null,
            "model": null
          },
          "queryExpansion": {
            "apiToken": null,
            "baseUrl": null,
            "contextCapacityTokens": null,
            "model": null
          },
          "maximumParallelRequests": 1,
          "name": null,
          "thinkingMode": "disabled",
          "reranking": {
            "apiToken": null,
            "baseUrl": null,
            "model": null
          },
          "speechToText": {
            "apiToken": null,
            "baseUrl": null,
            "model": null
          },
          "indexing": {
            "apiToken": null,
            "baseUrl": null,
            "contextCapacityTokens": null,
            "model": null
          },
          "textToSpeech": {
            "apiToken": null,
            "baseUrl": null,
            "model": null,
            "voice": null
          }
        },
        "deepseek": {
          "apiToken": null,
          "answer": {
            "apiToken": null,
            "baseUrl": null,
            "contextCapacityTokens": 1000000,
            "model": "deepseek-v4-flash"
          },
          "baseUrl": "https://api.deepseek.com",
          "customAdapters": {
            "answer": "openai-compatible-language",
            "embedding": "openai-compatible-embedding",
            "queryExpansion": "openai-compatible-language",
            "reranking": "top-n-rerank",
            "speechToText": "openai-transcription",
            "indexing": "openai-compatible-language",
            "textToSpeech": "openai-speech"
          },
          "embedding": {
            "apiToken": null,
            "baseUrl": null,
            "contextCapacityTokens": null,
            "model": null
          },
          "queryExpansion": {
            "apiToken": null,
            "baseUrl": null,
            "contextCapacityTokens": 1000000,
            "model": "deepseek-v4-flash"
          },
          "maximumParallelRequests": 1,
          "name": null,
          "thinkingMode": "disabled",
          "reranking": {
            "apiToken": null,
            "baseUrl": null,
            "model": null
          },
          "speechToText": {
            "apiToken": null,
            "baseUrl": null,
            "model": null
          },
          "indexing": {
            "apiToken": null,
            "baseUrl": null,
            "contextCapacityTokens": 1000000,
            "model": "deepseek-v4-flash"
          },
          "textToSpeech": {
            "apiToken": null,
            "baseUrl": null,
            "model": null,
            "voice": null
          }
        },
        "groq": {
          "apiToken": null,
          "answer": {
            "apiToken": null,
            "baseUrl": null,
            "contextCapacityTokens": null,
            "model": null
          },
          "baseUrl": "https://api.groq.com/openai/v1",
          "customAdapters": {
            "answer": "openai-compatible-language",
            "embedding": "openai-compatible-embedding",
            "queryExpansion": "openai-compatible-language",
            "reranking": "top-n-rerank",
            "speechToText": "openai-transcription",
            "indexing": "openai-compatible-language",
            "textToSpeech": "openai-speech"
          },
          "embedding": {
            "apiToken": null,
            "baseUrl": null,
            "contextCapacityTokens": null,
            "model": null
          },
          "queryExpansion": {
            "apiToken": null,
            "baseUrl": null,
            "contextCapacityTokens": null,
            "model": null
          },
          "maximumParallelRequests": 1,
          "name": null,
          "thinkingMode": "disabled",
          "reranking": {
            "apiToken": null,
            "baseUrl": null,
            "model": null
          },
          "speechToText": {
            "apiToken": null,
            "baseUrl": null,
            "model": null
          },
          "indexing": {
            "apiToken": null,
            "baseUrl": null,
            "contextCapacityTokens": null,
            "model": null
          },
          "textToSpeech": {
            "apiToken": null,
            "baseUrl": null,
            "model": null,
            "voice": null
          }
        },
        "jina": {
          "apiToken": null,
          "answer": {
            "apiToken": null,
            "baseUrl": null,
            "contextCapacityTokens": null,
            "model": null
          },
          "baseUrl": "https://api.jina.ai/v1",
          "customAdapters": {
            "answer": "openai-compatible-language",
            "embedding": "openai-compatible-embedding",
            "queryExpansion": "openai-compatible-language",
            "reranking": "top-n-rerank",
            "speechToText": "openai-transcription",
            "indexing": "openai-compatible-language",
            "textToSpeech": "openai-speech"
          },
          "embedding": {
            "apiToken": null,
            "baseUrl": null,
            "contextCapacityTokens": null,
            "model": null
          },
          "queryExpansion": {
            "apiToken": null,
            "baseUrl": null,
            "contextCapacityTokens": null,
            "model": null
          },
          "maximumParallelRequests": 1,
          "name": null,
          "thinkingMode": "disabled",
          "reranking": {
            "apiToken": null,
            "baseUrl": null,
            "model": null
          },
          "speechToText": {
            "apiToken": null,
            "baseUrl": null,
            "model": null
          },
          "indexing": {
            "apiToken": null,
            "baseUrl": null,
            "contextCapacityTokens": null,
            "model": null
          },
          "textToSpeech": {
            "apiToken": null,
            "baseUrl": null,
            "model": null,
            "voice": null
          }
        },
        "lmstudio": {
          "apiToken": null,
          "answer": {
            "apiToken": null,
            "baseUrl": "http://host.docker.internal:1234/v1",
            "contextCapacityTokens": 131072,
            "model": "google/gemma-4-e4b"
          },
          "baseUrl": "http://host.docker.internal:1234/v1",
          "customAdapters": {
            "answer": "openai-compatible-language",
            "embedding": "openai-compatible-embedding",
            "queryExpansion": "openai-compatible-language",
            "reranking": "top-n-rerank",
            "speechToText": "openai-transcription",
            "indexing": "openai-compatible-language",
            "textToSpeech": "openai-speech"
          },
          "embedding": {
            "apiToken": null,
            "baseUrl": "http://host.docker.internal:1234/v1",
            "contextCapacityTokens": 2048,
            "model": "text-embedding-embeddinggemma-300m-qat"
          },
          "queryExpansion": {
            "apiToken": null,
            "baseUrl": "http://host.docker.internal:1234/v1",
            "contextCapacityTokens": 131072,
            "model": "google/gemma-4-e4b"
          },
          "maximumParallelRequests": 1,
          "name": null,
          "thinkingMode": "disabled",
          "reranking": {
            "apiToken": null,
            "baseUrl": null,
            "model": null
          },
          "speechToText": {
            "apiToken": null,
            "baseUrl": null,
            "model": null
          },
          "indexing": {
            "apiToken": null,
            "baseUrl": "http://host.docker.internal:1234/v1",
            "contextCapacityTokens": 131072,
            "model": "google/gemma-4-e4b"
          },
          "textToSpeech": {
            "apiToken": null,
            "baseUrl": null,
            "model": null,
            "voice": null
          }
        },
        "mistral": {
          "apiToken": null,
          "answer": {
            "apiToken": null,
            "baseUrl": null,
            "contextCapacityTokens": 256000,
            "model": "mistral-large-2512"
          },
          "baseUrl": "https://api.mistral.ai/v1",
          "customAdapters": {
            "answer": "openai-compatible-language",
            "embedding": "openai-compatible-embedding",
            "queryExpansion": "openai-compatible-language",
            "reranking": "top-n-rerank",
            "speechToText": "mistral-transcription",
            "indexing": "openai-compatible-language",
            "textToSpeech": "mistral-speech"
          },
          "embedding": {
            "apiToken": null,
            "baseUrl": null,
            "contextCapacityTokens": 8192,
            "model": "mistral-embed"
          },
          "queryExpansion": {
            "apiToken": null,
            "baseUrl": null,
            "contextCapacityTokens": 256000,
            "model": "mistral-large-2512"
          },
          "maximumParallelRequests": 1,
          "name": null,
          "thinkingMode": "auto",
          "reranking": {
            "apiToken": null,
            "baseUrl": null,
            "model": null
          },
          "speechToText": {
            "apiToken": null,
            "baseUrl": null,
            "model": "voxtral-mini-latest"
          },
          "indexing": {
            "apiToken": null,
            "baseUrl": null,
            "contextCapacityTokens": 256000,
            "model": "mistral-large-2512"
          },
          "textToSpeech": {
            "apiToken": null,
            "baseUrl": null,
            "model": "voxtral-mini-tts-2603",
            "voice": null
          }
        },
        "ollama": {
          "adaptiveContextEnabled": true,
          "apiToken": null,
          "answer": {
            "apiToken": null,
            "baseUrl": null,
            "contextCapacityTokens": 131072,
            "model": "qwen3.5:9b-mlx"
          },
          "baseUrl": "http://host.docker.internal:11434",
          "customAdapters": {
            "answer": "openai-compatible-language",
            "embedding": "ollama-embedding",
            "queryExpansion": "openai-compatible-language",
            "reranking": "top-n-rerank",
            "speechToText": "openai-transcription",
            "indexing": "openai-compatible-language",
            "textToSpeech": "openai-speech"
          },
          "embedding": {
            "apiToken": null,
            "baseUrl": null,
            "contextCapacityTokens": 2048,
            "model": "snowflake-arctic-embed:137m"
          },
          "queryExpansion": {
            "apiToken": null,
            "baseUrl": null,
            "contextCapacityTokens": 131072,
            "model": "qwen3.5:9b-mlx"
          },
          "maximumParallelRequests": 1,
          "name": null,
          "thinkingMode": "disabled",
          "reranking": {
            "apiToken": null,
            "baseUrl": null,
            "model": null
          },
          "speechToText": {
            "apiToken": null,
            "baseUrl": null,
            "model": null
          },
          "indexing": {
            "apiToken": null,
            "baseUrl": null,
            "contextCapacityTokens": 131072,
            "model": "qwen3.5:9b"
          },
          "textToSpeech": {
            "apiToken": null,
            "baseUrl": null,
            "model": null,
            "voice": null
          }
        },
        "omlx": {
          "apiToken": null,
          "answer": {
            "apiToken": null,
            "baseUrl": null,
            "contextCapacityTokens": null,
            "model": null
          },
          "baseUrl": "http://host.docker.internal:9000/v1",
          "customAdapters": {
            "answer": "openai-compatible-language",
            "embedding": "openai-compatible-embedding",
            "queryExpansion": "openai-compatible-language",
            "reranking": "top-n-rerank",
            "speechToText": "openai-transcription",
            "indexing": "openai-compatible-language",
            "textToSpeech": "openai-speech"
          },
          "embedding": {
            "apiToken": null,
            "baseUrl": null,
            "contextCapacityTokens": null,
            "model": null
          },
          "queryExpansion": {
            "apiToken": null,
            "baseUrl": null,
            "contextCapacityTokens": null,
            "model": null
          },
          "maximumParallelRequests": 1,
          "name": null,
          "thinkingMode": "disabled",
          "reranking": {
            "apiToken": null,
            "baseUrl": "http://host.docker.internal:9000/v1",
            "model": "gte-reranker-modernbert-base"
          },
          "speechToText": {
            "apiToken": null,
            "baseUrl": null,
            "model": "Qwen3-ASR-1.7B-8bit"
          },
          "indexing": {
            "apiToken": null,
            "baseUrl": null,
            "contextCapacityTokens": null,
            "model": null
          },
          "textToSpeech": {
            "apiToken": null,
            "baseUrl": null,
            "model": "Kokoro-82M-bf16",
            "voice": "af_heart"
          }
        },
        "openai": {
          "apiToken": null,
          "answer": {
            "apiToken": null,
            "baseUrl": null,
            "contextCapacityTokens": null,
            "model": null
          },
          "baseUrl": "https://api.openai.com/v1",
          "customAdapters": {
            "answer": "openai-compatible-language",
            "embedding": "openai-compatible-embedding",
            "queryExpansion": "openai-compatible-language",
            "reranking": "top-n-rerank",
            "speechToText": "openai-transcription",
            "indexing": "openai-compatible-language",
            "textToSpeech": "openai-speech"
          },
          "embedding": {
            "apiToken": null,
            "baseUrl": null,
            "contextCapacityTokens": null,
            "model": null
          },
          "queryExpansion": {
            "apiToken": null,
            "baseUrl": null,
            "contextCapacityTokens": null,
            "model": null
          },
          "maximumParallelRequests": 1,
          "name": null,
          "thinkingMode": "disabled",
          "reranking": {
            "apiToken": null,
            "baseUrl": null,
            "model": null
          },
          "speechToText": {
            "apiToken": null,
            "baseUrl": null,
            "model": null
          },
          "indexing": {
            "apiToken": null,
            "baseUrl": null,
            "contextCapacityTokens": null,
            "model": null
          },
          "textToSpeech": {
            "apiToken": null,
            "baseUrl": null,
            "model": null,
            "voice": null
          }
        },
        "openrouter": {
          "apiToken": null,
          "answer": {
            "apiToken": null,
            "baseUrl": null,
            "contextCapacityTokens": 200000,
            "model": "openrouter/free"
          },
          "baseUrl": "https://openrouter.ai/api/v1",
          "customAdapters": {
            "answer": "openai-compatible-language",
            "embedding": "openai-compatible-embedding",
            "queryExpansion": "openai-compatible-language",
            "reranking": "top-n-rerank",
            "speechToText": "openrouter-transcription",
            "indexing": "openai-compatible-language",
            "textToSpeech": "openrouter-speech"
          },
          "embedding": {
            "apiToken": null,
            "baseUrl": null,
            "contextCapacityTokens": 32768,
            "model": "nvidia/nemotron-3-embed-1b:free"
          },
          "queryExpansion": {
            "apiToken": null,
            "baseUrl": null,
            "contextCapacityTokens": 200000,
            "model": "openrouter/free"
          },
          "maximumParallelRequests": 1,
          "name": null,
          "thinkingMode": "disabled",
          "reranking": {
            "apiToken": null,
            "baseUrl": null,
            "model": "nvidia/llama-nemotron-rerank-vl-1b-v2:free"
          },
          "speechToText": {
            "apiToken": null,
            "baseUrl": null,
            "model": "openai/gpt-4o-mini-transcribe"
          },
          "indexing": {
            "apiToken": null,
            "baseUrl": null,
            "contextCapacityTokens": 200000,
            "model": "openrouter/free"
          },
          "textToSpeech": {
            "apiToken": null,
            "baseUrl": null,
            "model": "fish-audio/s2.1-pro-free:free",
            "voice": "alloy"
          }
        },
        "openai-codex": {
          "apiToken": null,
          "answer": {
            "apiToken": null,
            "baseUrl": null,
            "contextCapacityTokens": 272000,
            "model": "gpt-5.6-terra"
          },
          "baseUrl": "https://chatgpt.com/backend-api/codex",
          "customAdapters": {
            "answer": "openai-compatible-language",
            "embedding": "openai-compatible-embedding",
            "queryExpansion": "openai-compatible-language",
            "reranking": "top-n-rerank",
            "speechToText": "openai-transcription",
            "indexing": "openai-compatible-language",
            "textToSpeech": "openai-speech"
          },
          "embedding": {
            "apiToken": null,
            "baseUrl": null,
            "contextCapacityTokens": null,
            "model": null
          },
          "queryExpansion": {
            "apiToken": null,
            "baseUrl": null,
            "contextCapacityTokens": 272000,
            "model": "gpt-5.6-terra"
          },
          "maximumParallelRequests": 1,
          "name": null,
          "thinkingMode": "disabled",
          "reranking": {
            "apiToken": null,
            "baseUrl": null,
            "model": null
          },
          "speechToText": {
            "apiToken": null,
            "baseUrl": null,
            "model": null
          },
          "indexing": {
            "apiToken": null,
            "baseUrl": null,
            "contextCapacityTokens": 272000,
            "model": "gpt-5.6-terra"
          },
          "textToSpeech": {
            "apiToken": null,
            "baseUrl": null,
            "model": null,
            "voice": null
          }
        },
        "together": {
          "apiToken": null,
          "answer": {
            "apiToken": null,
            "baseUrl": null,
            "contextCapacityTokens": 262144,
            "model": "moonshotai/Kimi-K2.6"
          },
          "baseUrl": "https://api.together.xyz/v1",
          "customAdapters": {
            "answer": "openai-compatible-language",
            "embedding": "openai-compatible-embedding",
            "queryExpansion": "openai-compatible-language",
            "reranking": "top-n-rerank",
            "speechToText": "openai-transcription",
            "indexing": "openai-compatible-language",
            "textToSpeech": "openai-speech"
          },
          "embedding": {
            "apiToken": null,
            "baseUrl": null,
            "contextCapacityTokens": 514,
            "model": "intfloat/multilingual-e5-large-instruct"
          },
          "queryExpansion": {
            "apiToken": null,
            "baseUrl": null,
            "contextCapacityTokens": 262144,
            "model": "moonshotai/Kimi-K2.6"
          },
          "maximumParallelRequests": 1,
          "name": null,
          "thinkingMode": "disabled",
          "reranking": {
            "apiToken": null,
            "baseUrl": null,
            "model": null
          },
          "speechToText": {
            "apiToken": null,
            "baseUrl": null,
            "model": "openai/whisper-large-v3"
          },
          "indexing": {
            "apiToken": null,
            "baseUrl": null,
            "contextCapacityTokens": 262144,
            "model": "moonshotai/Kimi-K2.6"
          },
          "textToSpeech": {
            "apiToken": null,
            "baseUrl": null,
            "model": "hexgrad/Kokoro-82M",
            "voice": "af_heart"
          }
        }
      },
      "featureOverrides": {
        "answer": {
          "contextCapacityTokensOverride": null,
          "modelOverride": null,
          "thinkingModeOverride": null
        },
        "embedding": {
          "contextCapacityTokensOverride": null,
          "modelOverride": null
        },
        "queryExpansion": {
          "contextCapacityTokensOverride": null,
          "modelOverride": null,
          "thinkingModeOverride": null
        },
        "reranking": {
          "modelOverride": null
        },
        "speechToText": {
          "modelOverride": null
        },
        "indexing": {
          "contextCapacityTokensOverride": null,
          "modelOverride": null,
          "thinkingModeOverride": null
        },
        "textToSpeech": {
          "modelOverride": null,
          "voiceOverride": null
        }
      },
      "routing": {
        "answer": "ollama",
        "embedding": "ollama",
        "queryExpansion": "ollama",
        "reranking": null,
        "speechToText": null,
        "indexing": "ollama",
        "textToSpeech": null
      }
    },
    "runtime": {
      "answerMinimumOutputTokens": 256,
      "answerProviderSafetyMarginTokens": 2048,
      "answerTemperature": 0,
      "answerTimeoutSeconds": 600,
      "aiMetricsEnabled": true,
      "backgroundProgressIntervalMs": 5000,
      "claimVerifierBaseUrl": "http://host.docker.internal:8088",
      "claimVerifierRuntimeName": "HHEM-2.1-Open",
      "claimVerifierSupportThreshold": 0.5,
      "claimVerifierTimeoutSeconds": 120,
      "chatTemperature": 0,
      "denseWeight": 1,
      "doclingApiKey": null,
      "doclingBaseUrl": "http://host.docker.internal:5001",
      "doclingDefaultServiceCapacity": 2,
      "doclingMaxTimeoutSeconds": 43200,
      "doclingMegabyteTimeoutSeconds": 60,
      "doclingOcrEnabled": true,
      "doclingPageTimeoutSeconds": 30,
      "doclingPdfBackend": "docling_parse",
      "doclingPerformanceMetricsEnabled": false,
      "doclingPerformanceMetricsRetentionDays": 30,
      "doclingPipeline": "standard",
      "doclingRequestTimeoutSeconds": 300,
      "doclingSecondaryImageScale": 2,
      "doclingTableMode": "accurate",
      "doclingTableStructureEnabled": true,
      "doclingTocEnabled": true,
      "doclingTimeoutSeconds": 1800,
      "doclingVlmMaxOutputTokens": 32768,
      "doclingVlmModelOverride": "frob/unlimited-ocr:q8_0",
      "doclingVlmPrompt": "document parsing.",
      "doclingVlmProviderId": "ollama",
      "embeddingDimensions": 768,
      "embeddingInputFormatId": "00000000-0000-4000-8000-000000000003",
      "embeddingSpaceId": null,
      "embeddingTimeoutSeconds": 600,
      "expansionDecay": 1,
      "expansionQueryWeight": 1,
      "findSourcesPassagesPerDocument": 3,
      "findSourcesResults": 10,
      "generationSeedMode": "stable",
      "lexicalWeight": 1,
      "maxAttempts": 3,
      "maxDocumentMegabytes": 100,
      "originalQueryWeight": 1,
      "queryExpansionTemperature": 0,
      "queryExpansionTimeoutSeconds": 60,
      "queryExpansions": 0,
      "rerankDiscoveryMinimumScore": 0.9,
      "rerankTimeoutSeconds": 120,
      "retrievalCandidates": 50,
      "retrievalChunkTargetTokens": 512,
      "retrievalWindowPolicy": "structured-token-v3",
      "retryBaseMs": 5000,
      "rrfK": 60,
      "searchMethod": "hybrid",
      "sttLanguage": "English",
      "sttMaxAudioMegabytes": 10,
      "sttPrompt": null,
      "sttTimeoutSeconds": 60,
      "indexingTimeoutSeconds": 21600,
      "topK": 50,
      "ttsPreloadEnabled": false,
      "ttsSpeed": 1,
      "ttsTimeoutSeconds": 30,
      "workerConcurrency": 2,
      "workerFallbackPollMs": 60000
    },
    "schemaVersion": 1
  }
    $settings$::jsonb,
    '{sourceContent}',
    jsonb_build_object(
      'directory',
      current_setting('citeloom.source_content_directory')
    ),
    true
  ) AS document
), settings_documents AS (
  SELECT
    canonical_settings.document AS defaults_document,
    jsonb_set(
      jsonb_set(
        canonical_settings.document,
        '{providers,catalog}',
        canonical_settings.document#>'{providers,catalog}'
          || COALESCE(
            (
              SELECT jsonb_agg(
                existing_profile.value
                ORDER BY existing_profile.ordinality
              )
              FROM jsonb_array_elements(
                COALESCE(
                  existing_settings.settings#>'{providers,catalog}',
                  '[]'::jsonb
                )
              ) WITH ORDINALITY AS existing_profile(value, ordinality)
              WHERE NOT EXISTS (
                SELECT 1
                FROM jsonb_array_elements(
                  canonical_settings.document#>'{providers,catalog}'
                ) AS canonical_profile(value)
                WHERE canonical_profile.value->>'id'
                  = existing_profile.value->>'id'
              )
            ),
            '[]'::jsonb
          ),
        true
      ),
      '{providers,connections}',
      merged_connections.document,
      true
    ) AS settings_document
  FROM canonical_settings
  LEFT JOIN application_settings AS existing_settings
    ON existing_settings.id = 'runtime'
  CROSS JOIN LATERAL (
    SELECT
      COALESCE(
        jsonb_object_agg(
          canonical_connection.key,
          (
            SELECT jsonb_object_agg(
              canonical_field.key,
              CASE
                WHEN
                  existing_field.current_value IS NULL
                  OR existing_field.current_value
                    = existing_field.previous_default_value
                THEN canonical_field.value
                ELSE existing_field.current_value
              END
            )
            FROM jsonb_each(canonical_connection.value) AS canonical_field
            CROSS JOIN LATERAL (
              SELECT ARRAY[
                'providers',
                'connections',
                canonical_connection.key,
                canonical_field.key
              ]::text[] AS path
            ) AS field_path
            CROSS JOIN LATERAL (
              SELECT
                existing_settings.settings#>field_path.path AS current_value,
                existing_settings.defaults#>field_path.path
                  AS previous_default_value
            ) AS existing_field
          )
        ),
        '{}'::jsonb
      )
        || COALESCE(
          (
            SELECT jsonb_object_agg(
              existing_connection.key,
              existing_connection.value
            )
            FROM jsonb_each(
              COALESCE(
                existing_settings.settings#>'{providers,connections}',
                '{}'::jsonb
              )
            ) AS existing_connection
            WHERE NOT (
              canonical_settings.document#>'{providers,connections}'
            ) ? existing_connection.key
          ),
          '{}'::jsonb
        ) AS document
    FROM jsonb_each(
      canonical_settings.document#>'{providers,connections}'
    ) AS canonical_connection
  ) AS merged_connections
)
INSERT INTO "application_settings" (
  "defaults",
  "id",
  "settings"
)
SELECT
  "defaults_document",
  'runtime',
  "settings_document"
FROM settings_documents
ON CONFLICT ("id") DO UPDATE
SET
  "defaults" = jsonb_set(
    jsonb_set(
      jsonb_set(
        jsonb_set(
          jsonb_set(
            jsonb_set(
              jsonb_set(
                jsonb_set(
                  "application_settings"."defaults",
                  '{providers,routing}',
                  EXCLUDED."defaults"#>'{providers,routing}',
                  true
                ),
                '{providers,catalog}',
                EXCLUDED."defaults"#>'{providers,catalog}',
                true
              ),
              '{providers,connections}',
              EXCLUDED."defaults"#>'{providers,connections}',
              true
            ),
            '{runtime,embeddingInputFormatId}',
            EXCLUDED."defaults"#>'{runtime,embeddingInputFormatId}',
            true
          ),
          '{runtime,queryExpansions}',
          EXCLUDED."defaults"#>'{runtime,queryExpansions}',
          true
        ),
        '{sourceContent}',
        EXCLUDED."defaults"->'sourceContent',
        true
      ),
      '{runtime,doclingTocEnabled}',
      EXCLUDED."defaults"#>'{runtime,doclingTocEnabled}',
      true
    ),
    '{runtime,searchMethod}',
    EXCLUDED."defaults"#>'{runtime,searchMethod}',
    true
  ) #- '{runtime,answerMaximumOutputTokens}',
  "settings" = jsonb_set(
    jsonb_set(
      jsonb_set(
        jsonb_set(
          jsonb_set(
            jsonb_set(
              jsonb_set(
                "application_settings"."settings",
                '{providers,catalog}',
                EXCLUDED."settings"#>'{providers,catalog}',
                true
              ),
              '{providers,connections}',
              EXCLUDED."settings"#>'{providers,connections}',
              true
            ),
            '{runtime,queryExpansions}',
            CASE
              WHEN
                "application_settings"."settings"#>'{runtime,queryExpansions}'
                  IS NULL
                OR "application_settings"."settings"#>'{runtime,queryExpansions}'
                  = "application_settings"."defaults"#>'{runtime,queryExpansions}'
              THEN EXCLUDED."settings"#>'{runtime,queryExpansions}'
              ELSE "application_settings"."settings"#>'{runtime,queryExpansions}'
            END,
            true
          ),
          '{providers,connections,ollama,adaptiveContextEnabled}',
          CASE
            WHEN
              "application_settings"."settings"#>'{providers,connections,ollama,adaptiveContextEnabled}'
                IS NOT NULL
            THEN
              "application_settings"."settings"#>'{providers,connections,ollama,adaptiveContextEnabled}'
            WHEN
              "application_settings"."settings"#>>'{providers,connections,ollama,maximumParallelRequests}'
                = '1'
            THEN 'true'::jsonb
            ELSE 'false'::jsonb
          END,
          true
        ),
        '{sourceContent}',
        EXCLUDED."settings"->'sourceContent',
        true
      ),
      '{runtime,doclingTocEnabled}',
      CASE
        WHEN
          "application_settings"."settings"#>'{runtime,doclingTocEnabled}'
            IS NULL
          OR "application_settings"."settings"#>'{runtime,doclingTocEnabled}'
            = "application_settings"."defaults"#>'{runtime,doclingTocEnabled}'
        THEN EXCLUDED."settings"#>'{runtime,doclingTocEnabled}'
        ELSE "application_settings"."settings"#>'{runtime,doclingTocEnabled}'
      END,
      true
    ),
    '{runtime,searchMethod}',
    CASE
      WHEN
        "application_settings"."settings"#>'{runtime,searchMethod}'
          IS NULL
        OR "application_settings"."settings"#>'{runtime,searchMethod}'
          = "application_settings"."defaults"#>'{runtime,searchMethod}'
      THEN EXCLUDED."settings"#>'{runtime,searchMethod}'
      ELSE "application_settings"."settings"#>'{runtime,searchMethod}'
    END,
    true
  ) #- '{runtime,answerMaximumOutputTokens}',
  "updated_at" = now(),
  "version" = "application_settings"."version" + 1
WHERE
  "application_settings"."defaults"#>'{providers,routing}'
    IS DISTINCT FROM EXCLUDED."defaults"#>'{providers,routing}'
  OR "application_settings"."defaults"#>'{providers,catalog}'
    IS DISTINCT FROM EXCLUDED."defaults"#>'{providers,catalog}'
  OR "application_settings"."defaults"#>'{providers,connections}'
    IS DISTINCT FROM EXCLUDED."defaults"#>'{providers,connections}'
  OR "application_settings"."defaults"#>'{runtime,answerMaximumOutputTokens}'
    IS NOT NULL
  OR "application_settings"."settings"#>'{runtime,answerMaximumOutputTokens}'
    IS NOT NULL
  OR "application_settings"."defaults"#>'{runtime,embeddingInputFormatId}'
    IS DISTINCT FROM EXCLUDED."defaults"#>'{runtime,embeddingInputFormatId}'
  OR "application_settings"."defaults"#>'{runtime,queryExpansions}'
    IS DISTINCT FROM EXCLUDED."defaults"#>'{runtime,queryExpansions}'
  OR "application_settings"."defaults"#>'{runtime,doclingTocEnabled}'
    IS DISTINCT FROM EXCLUDED."defaults"#>'{runtime,doclingTocEnabled}'
  OR "application_settings"."defaults"#>'{runtime,searchMethod}'
    IS DISTINCT FROM EXCLUDED."defaults"#>'{runtime,searchMethod}'
  OR "application_settings"."defaults"->'sourceContent'
    IS DISTINCT FROM EXCLUDED."defaults"->'sourceContent'
  OR "application_settings"."settings"#>'{providers,connections,ollama,adaptiveContextEnabled}'
    IS NULL
  OR "application_settings"."settings"#>'{providers,catalog}'
    IS DISTINCT FROM EXCLUDED."settings"#>'{providers,catalog}'
  OR "application_settings"."settings"#>'{providers,connections}'
    IS DISTINCT FROM (
      EXCLUDED."settings"#>'{providers,connections}'
        || COALESCE(
          "application_settings"."settings"#>'{providers,connections}',
          '{}'::jsonb
        )
    )
  OR "application_settings"."settings"->'sourceContent'
    IS DISTINCT FROM EXCLUDED."settings"->'sourceContent';

DO $bootstrap$
DECLARE
  administrator_display_name text;
  administrator_password_hash text;
  administrator_user_id uuid;
  administrator_username text;
  administrator_username_normalized text;
  administrator_workspace_id uuid;
  existing_user_count bigint;
  existing_workspace_count bigint;
  ready_administrator_count bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('citeloom.bootstrap'));

  SELECT count(*) INTO existing_user_count FROM "users";
  SELECT count(*) INTO existing_workspace_count FROM "workspaces";

  IF existing_user_count > 0 THEN
    SELECT count(*)
    INTO ready_administrator_count
    FROM "users" AS application_user
    INNER JOIN "user_password_credentials" AS credential
      ON credential."user_id" = application_user."id"
    INNER JOIN "workspace_memberships" AS membership
      ON membership."user_id" = application_user."id"
    WHERE application_user."state" = 'active'
      AND membership."role" = 'admin';

    IF ready_administrator_count = 0 THEN
      RAISE EXCEPTION
        'Administrator bootstrap is incomplete: users exist, but no active administrator with a password credential exists.';
    END IF;
    RETURN;
  END IF;

  IF existing_workspace_count > 0 THEN
    RAISE EXCEPTION
      'Administrator bootstrap cannot start because workspaces exist without users.';
  END IF;

  administrator_display_name :=
    current_setting('citeloom.bootstrap_administrator_display_name', true);
  administrator_password_hash :=
    current_setting('citeloom.bootstrap_administrator_password_hash', true);
  administrator_username :=
    current_setting('citeloom.bootstrap_administrator_username', true);
  administrator_username_normalized :=
    current_setting('citeloom.bootstrap_administrator_username_normalized', true);

  IF administrator_display_name IS NULL
    OR administrator_password_hash IS NULL
    OR administrator_username IS NULL
    OR administrator_username_normalized IS NULL
  THEN
    RAISE EXCEPTION
      'Administrator bootstrap settings were not supplied.';
  END IF;

  IF administrator_password_hash NOT LIKE '$argon2id$%' THEN
    RAISE EXCEPTION
      'Administrator bootstrap password hash must use Argon2id.';
  END IF;

  administrator_user_id := gen_random_uuid();
  administrator_workspace_id := gen_random_uuid();

  INSERT INTO "workspaces" ("id", "name", "slug")
  VALUES (administrator_workspace_id, 'CiteLoom', 'citeloom');

  INSERT INTO "users" (
    "display_name",
    "id",
    "state",
    "username",
    "username_normalized"
  )
  VALUES (
    administrator_display_name,
    administrator_user_id,
    'active',
    administrator_username,
    administrator_username_normalized
  );

  INSERT INTO "user_password_credentials" ("password_hash", "user_id")
  VALUES (administrator_password_hash, administrator_user_id);

  INSERT INTO "workspace_memberships" ("role", "user_id", "workspace_id")
  VALUES ('admin', administrator_user_id, administrator_workspace_id);
END;
$bootstrap$;
