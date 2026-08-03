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

UPDATE "embedding_spaces" AS space
SET
  "input_format_document_template" = input_format."document_template",
  "input_format_hash" = input_format."input_format_hash",
  "input_format_id" = input_format."id",
  "input_format_query_template" = input_format."query_template",
  "input_format_schema_version" = input_format."schema_version"
FROM "embedding_input_formats" AS input_format
WHERE space."input_format_id" IS NULL
  AND (
    (space."profile" = 'plain'
      AND input_format."id" = '00000000-0000-4000-8000-000000000001')
    OR
    (space."profile" = 'embeddinggemma'
      AND input_format."id" = '00000000-0000-4000-8000-000000000002')
  );

DO $embedding_input_format_backfill$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "embedding_spaces"
    WHERE "input_format_id" IS NULL
  ) THEN
    RAISE EXCEPTION
      'Embedding input-format backfill found an unmapped legacy embedding space.';
  END IF;
END
$embedding_input_format_backfill$;

UPDATE "embedding_space_gc_spaces" AS space
SET
  "input_format_hash" = input_format."input_format_hash",
  "input_format_name" = input_format."name"
FROM "embedding_input_formats" AS input_format
WHERE space."input_format_hash" IS NULL
  AND (
    (space."profile" = 'plain'
      AND input_format."id" = '00000000-0000-4000-8000-000000000001')
    OR
    (space."profile" = 'embeddinggemma'
      AND input_format."id" = '00000000-0000-4000-8000-000000000002')
  );

DO $embedding_input_format_gc_backfill$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "embedding_space_gc_spaces"
    WHERE "input_format_hash" IS NULL
      OR "input_format_name" IS NULL
  ) THEN
    RAISE EXCEPTION
      'Embedding input-format backfill found an unmapped garbage-collection record.';
  END IF;
END
$embedding_input_format_gc_backfill$;

CREATE OR REPLACE FUNCTION "protect_embedding_input_format_records"()
RETURNS trigger AS $embedding_input_format_immutability$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Embedding input-format records cannot be deleted.';
  END IF;
  IF OLD."retired_at" IS NULL
    AND NEW."retired_at" IS NOT NULL
    AND OLD."created_at" = NEW."created_at"
    AND OLD."document_template" = NEW."document_template"
    AND OLD."id" = NEW."id"
    AND OLD."input_format_hash" = NEW."input_format_hash"
    AND OLD."name" = NEW."name"
    AND OLD."query_template" = NEW."query_template"
    AND OLD."schema_version" = NEW."schema_version"
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION
    'Embedding input-format records are immutable except for first retirement.';
END
$embedding_input_format_immutability$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "embedding_input_formats_immutable"
ON "embedding_input_formats";
CREATE TRIGGER "embedding_input_formats_immutable"
BEFORE UPDATE OR DELETE ON "embedding_input_formats"
FOR EACH ROW EXECUTE FUNCTION "protect_embedding_input_format_records"();

DROP TRIGGER IF EXISTS "embedding_input_formats_publish_settings_revision"
ON "embedding_input_formats";
CREATE TRIGGER "embedding_input_formats_publish_settings_revision"
AFTER INSERT OR UPDATE ON "embedding_input_formats"
FOR EACH ROW EXECUTE FUNCTION "publish_application_revision"('settings');

CREATE OR REPLACE FUNCTION "require_active_embedding_space_input_format"()
RETURNS trigger AS $embedding_space_input_format_active$
DECLARE
  input_format_retired_at timestamp with time zone;
BEGIN
  SELECT "retired_at"
  INTO input_format_retired_at
  FROM "embedding_input_formats"
  WHERE "id" = NEW."input_format_id"
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Embedding space input format does not exist.';
  END IF;
  IF input_format_retired_at IS NOT NULL THEN
    RAISE EXCEPTION 'Embedding spaces cannot use a retired input format.';
  END IF;
  RETURN NEW;
END
$embedding_space_input_format_active$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "embedding_spaces_require_active_input_format"
ON "embedding_spaces";
CREATE TRIGGER "embedding_spaces_require_active_input_format"
BEFORE INSERT OR UPDATE OF "input_format_id" ON "embedding_spaces"
FOR EACH ROW
WHEN (NEW."input_format_id" IS NOT NULL)
EXECUTE FUNCTION "require_active_embedding_space_input_format"();

DO $embedding_input_format_settings_validation$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "application_settings"
    WHERE (
      "defaults"#>>'{runtime,embeddingInputFormatId}' IS NULL
      AND COALESCE("defaults"#>>'{runtime,embeddingProfile}', '')
        NOT IN ('plain', 'embeddinggemma')
    ) OR (
      "settings"#>>'{runtime,embeddingInputFormatId}' IS NULL
      AND COALESCE("settings"#>>'{runtime,embeddingProfile}', '')
        NOT IN ('plain', 'embeddinggemma')
    )
  ) THEN
    RAISE EXCEPTION
      'Application settings contain an unmapped legacy embedding profile.';
  END IF;
END
$embedding_input_format_settings_validation$;

UPDATE "application_settings"
SET
  "defaults" = CASE
    WHEN "defaults"#>>'{runtime,embeddingInputFormatId}' IS NULL THEN jsonb_set(
      "defaults" #- '{runtime,embeddingProfile}',
      '{runtime,embeddingInputFormatId}',
      to_jsonb(
        CASE "defaults"#>>'{runtime,embeddingProfile}'
          WHEN 'plain' THEN '00000000-0000-4000-8000-000000000001'
          WHEN 'embeddinggemma' THEN '00000000-0000-4000-8000-000000000002'
        END
      ),
      true
    )
    ELSE "defaults" #- '{runtime,embeddingProfile}'
  END,
  "settings" = CASE
    WHEN "settings"#>>'{runtime,embeddingInputFormatId}' IS NULL THEN jsonb_set(
      "settings" #- '{runtime,embeddingProfile}',
      '{runtime,embeddingInputFormatId}',
      to_jsonb(
        CASE "settings"#>>'{runtime,embeddingProfile}'
          WHEN 'plain' THEN '00000000-0000-4000-8000-000000000001'
          WHEN 'embeddinggemma' THEN '00000000-0000-4000-8000-000000000002'
        END
      ),
      true
    )
    ELSE "settings" #- '{runtime,embeddingProfile}'
  END,
  "updated_at" = now(),
  "version" = "version" + 1
WHERE "defaults"#>'{runtime,embeddingProfile}' IS NOT NULL
  OR "settings"#>'{runtime,embeddingProfile}' IS NOT NULL
  OR "defaults"#>>'{runtime,embeddingInputFormatId}' IS NULL
  OR "settings"#>>'{runtime,embeddingInputFormatId}' IS NULL;

WITH canonical_settings AS (
  SELECT jsonb_set(
    $settings$
  {
    "providers": {
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
            "summarization": "openai-compatible-language",
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
          "summarization": {
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
            "summarization": "openai-compatible-language",
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
          "summarization": {
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
            "summarization": "openai-compatible-language",
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
          "summarization": {
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
            "summarization": "openai-compatible-language",
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
          "summarization": {
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
            "summarization": "openai-compatible-language",
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
          "summarization": {
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
            "summarization": "openai-compatible-language",
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
          "summarization": {
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
        "ollama": {
          "adaptiveContextEnabled": true,
          "apiToken": null,
          "answer": {
            "apiToken": null,
            "baseUrl": null,
            "contextCapacityTokens": 131072,
            "model": "gemma4:e4b-mlx"
          },
          "baseUrl": "http://host.docker.internal:11434",
          "customAdapters": {
            "answer": "openai-compatible-language",
            "embedding": "ollama-embedding",
            "queryExpansion": "openai-compatible-language",
            "reranking": "top-n-rerank",
            "speechToText": "openai-transcription",
            "summarization": "openai-compatible-language",
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
            "model": "gemma4:e4b-mlx"
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
          "summarization": {
            "apiToken": null,
            "baseUrl": null,
            "contextCapacityTokens": 131072,
            "model": "gemma4:e4b-mlx"
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
            "summarization": "openai-compatible-language",
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
          "summarization": {
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
            "summarization": "openai-compatible-language",
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
          "summarization": {
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
            "summarization": "openai-compatible-language",
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
          "summarization": {
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
        "summarization": {
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
        "summarization": "ollama",
        "textToSpeech": null
      }
    },
    "runtime": {
      "answerMaximumOutputTokens": 20000,
      "answerMinimumOutputTokens": 256,
      "answerProviderSafetyMarginTokens": 2048,
      "answerTemperature": 0,
      "answerTimeoutSeconds": 600,
      "aiMetricsEnabled": true,
      "backgroundProgressIntervalMs": 5000,
      "claimVerifierBaseUrl": "http://host.docker.internal:8088",
      "claimVerifierRuntimeName": "HHEM-2.1-Open",
      "claimVerifierSupportThreshold": 0.7,
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
      "sttLanguage": "English",
      "sttMaxAudioMegabytes": 10,
      "sttPrompt": null,
      "sttTimeoutSeconds": 60,
      "summaryTimeoutSeconds": 21600,
      "topK": 10,
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
)
INSERT INTO "application_settings" (
  "defaults",
  "id",
  "settings"
)
SELECT
  "document",
  'runtime',
  "document"
FROM canonical_settings
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
              '{providers,connections,omlx}',
              EXCLUDED."defaults"#>'{providers,connections,omlx}',
              true
            ),
            '{providers,connections,ollama}',
            EXCLUDED."defaults"#>'{providers,connections,ollama}',
            true
          ),
          '{runtime,answerMaximumOutputTokens}',
          EXCLUDED."defaults"#>'{runtime,answerMaximumOutputTokens}',
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
  "settings" = jsonb_set(
    jsonb_set(
    jsonb_set(
      jsonb_set(
        jsonb_set(
          "application_settings"."settings",
          '{runtime,answerMaximumOutputTokens}',
          CASE
            WHEN
              "application_settings"."settings"#>'{runtime,answerMaximumOutputTokens}'
                IS NULL
              OR "application_settings"."settings"#>'{runtime,answerMaximumOutputTokens}'
                = "application_settings"."defaults"#>'{runtime,answerMaximumOutputTokens}'
            THEN EXCLUDED."settings"#>'{runtime,answerMaximumOutputTokens}'
            ELSE "application_settings"."settings"#>'{runtime,answerMaximumOutputTokens}'
          END,
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
  "updated_at" = now(),
  "version" = "application_settings"."version" + 1
WHERE
  "application_settings"."defaults"#>'{providers,routing}'
    IS DISTINCT FROM EXCLUDED."defaults"#>'{providers,routing}'
  OR "application_settings"."defaults"#>'{providers,connections,omlx}'
    IS DISTINCT FROM EXCLUDED."defaults"#>'{providers,connections,omlx}'
  OR "application_settings"."defaults"#>'{providers,connections,ollama}'
    IS DISTINCT FROM EXCLUDED."defaults"#>'{providers,connections,ollama}'
  OR "application_settings"."defaults"#>'{runtime,answerMaximumOutputTokens}'
    IS DISTINCT FROM EXCLUDED."defaults"#>'{runtime,answerMaximumOutputTokens}'
  OR "application_settings"."defaults"#>'{runtime,embeddingInputFormatId}'
    IS DISTINCT FROM EXCLUDED."defaults"#>'{runtime,embeddingInputFormatId}'
  OR "application_settings"."defaults"#>'{runtime,queryExpansions}'
    IS DISTINCT FROM EXCLUDED."defaults"#>'{runtime,queryExpansions}'
  OR "application_settings"."defaults"#>'{runtime,doclingTocEnabled}'
    IS DISTINCT FROM EXCLUDED."defaults"#>'{runtime,doclingTocEnabled}'
  OR "application_settings"."defaults"->'sourceContent'
    IS DISTINCT FROM EXCLUDED."defaults"->'sourceContent'
  OR "application_settings"."settings"#>'{providers,connections,ollama,adaptiveContextEnabled}'
    IS NULL
  OR "application_settings"."settings"->'sourceContent'
    IS DISTINCT FROM EXCLUDED."settings"->'sourceContent';

UPDATE "application_settings"
SET
  "defaults" = jsonb_set(
    "defaults",
    '{runtime}',
    COALESCE("defaults"->'runtime', '{}'::jsonb) || jsonb_build_object(
      'doclingPipeline', 'standard',
      'doclingVlmProviderId', 'ollama',
      'doclingVlmModelOverride', 'frob/unlimited-ocr:q8_0',
      'doclingVlmPrompt', 'document parsing.',
      'doclingVlmMaxOutputTokens', 32768
    ),
    true
  ),
  "settings" = jsonb_set(
    "settings",
    '{runtime}',
    COALESCE("settings"->'runtime', '{}'::jsonb) || jsonb_build_object(
      'doclingPipeline', COALESCE(
        "settings"#>'{runtime,doclingPipeline}',
        to_jsonb('standard'::text)
      ),
      'doclingVlmProviderId', COALESCE(
        "settings"#>'{runtime,doclingVlmProviderId}',
        to_jsonb('ollama'::text)
      ),
      'doclingVlmModelOverride', COALESCE(
        "settings"#>'{runtime,doclingVlmModelOverride}',
        to_jsonb('frob/unlimited-ocr:q8_0'::text)
      ),
      'doclingVlmPrompt', COALESCE(
        "settings"#>'{runtime,doclingVlmPrompt}',
        to_jsonb('document parsing.'::text)
      ),
      'doclingVlmMaxOutputTokens', COALESCE(
        "settings"#>'{runtime,doclingVlmMaxOutputTokens}',
        '32768'::jsonb
      )
    ),
    true
  ),
  "updated_at" = now(),
  "version" = "version" + 1
WHERE
  "id" = 'runtime'
  AND (
    "defaults"#>'{runtime,doclingPipeline}'
      IS DISTINCT FROM to_jsonb('standard'::text)
    OR "defaults"#>'{runtime,doclingVlmProviderId}'
      IS DISTINCT FROM to_jsonb('ollama'::text)
    OR "defaults"#>'{runtime,doclingVlmModelOverride}'
      IS DISTINCT FROM to_jsonb('frob/unlimited-ocr:q8_0'::text)
    OR "defaults"#>'{runtime,doclingVlmPrompt}'
      IS DISTINCT FROM to_jsonb('document parsing.'::text)
    OR "defaults"#>'{runtime,doclingVlmMaxOutputTokens}'
      IS DISTINCT FROM '32768'::jsonb
    OR "settings"#>'{runtime,doclingPipeline}' IS NULL
    OR "settings"#>'{runtime,doclingVlmProviderId}' IS NULL
    OR "settings"#>'{runtime,doclingVlmModelOverride}' IS NULL
    OR "settings"#>'{runtime,doclingVlmPrompt}' IS NULL
    OR "settings"#>'{runtime,doclingVlmMaxOutputTokens}' IS NULL
  );

UPDATE "application_settings"
SET
  "defaults" = jsonb_set(
    jsonb_set(
      "defaults",
      '{runtime,findSourcesPassagesPerDocument}',
      '3'::jsonb,
      true
    ),
    '{runtime,findSourcesResults}',
    '10'::jsonb,
    true
  ),
  "settings" = jsonb_set(
    jsonb_set(
      "settings",
      '{runtime,findSourcesPassagesPerDocument}',
      COALESCE(
        "settings"#>'{runtime,findSourcesPassagesPerDocument}',
        '3'::jsonb
      ),
      true
    ),
    '{runtime,findSourcesResults}',
    COALESCE(
      "settings"#>'{runtime,findSourcesResults}',
      '10'::jsonb
    ),
    true
  ),
  "updated_at" = now(),
  "version" = "version" + 1
WHERE
  "id" = 'runtime'
  AND (
    "defaults"#>'{runtime,findSourcesPassagesPerDocument}'
      IS DISTINCT FROM '3'::jsonb
    OR "defaults"#>'{runtime,findSourcesResults}'
      IS DISTINCT FROM '10'::jsonb
    OR "settings"#>'{runtime,findSourcesPassagesPerDocument}' IS NULL
    OR "settings"#>'{runtime,findSourcesResults}' IS NULL
  );

UPDATE "application_settings"
SET
  "defaults" = jsonb_set(
    "defaults",
    '{runtime}',
    "defaults"->'runtime' || jsonb_build_object(
      'answerTimeoutSeconds', 600,
      'embeddingTimeoutSeconds', 600,
      'queryExpansionTimeoutSeconds', 60,
      'rerankTimeoutSeconds', 120
    ),
    true
  ),
  "settings" = jsonb_set(
    "settings",
    '{runtime}',
    "settings"->'runtime' || jsonb_build_object(
      'answerTimeoutSeconds',
      CASE
        WHEN "settings"#>'{runtime,answerTimeoutSeconds}' IS NULL
          OR "settings"#>'{runtime,answerTimeoutSeconds}'
            = "defaults"#>'{runtime,answerTimeoutSeconds}'
        THEN '600'::jsonb
        ELSE "settings"#>'{runtime,answerTimeoutSeconds}'
      END,
      'embeddingTimeoutSeconds',
      CASE
        WHEN "settings"#>'{runtime,embeddingTimeoutSeconds}' IS NULL
          OR "settings"#>'{runtime,embeddingTimeoutSeconds}'
            = "defaults"#>'{runtime,embeddingTimeoutSeconds}'
        THEN '600'::jsonb
        ELSE "settings"#>'{runtime,embeddingTimeoutSeconds}'
      END,
      'queryExpansionTimeoutSeconds',
      CASE
        WHEN "settings"#>'{runtime,queryExpansionTimeoutSeconds}' IS NULL
          OR "settings"#>'{runtime,queryExpansionTimeoutSeconds}'
            = "defaults"#>'{runtime,queryExpansionTimeoutSeconds}'
        THEN '60'::jsonb
        ELSE "settings"#>'{runtime,queryExpansionTimeoutSeconds}'
      END,
      'rerankTimeoutSeconds',
      CASE
        WHEN "settings"#>'{runtime,rerankTimeoutSeconds}' IS NULL
          OR "settings"#>'{runtime,rerankTimeoutSeconds}'
            = "defaults"#>'{runtime,rerankTimeoutSeconds}'
        THEN '120'::jsonb
        ELSE "settings"#>'{runtime,rerankTimeoutSeconds}'
      END
    ),
    true
  ),
  "updated_at" = now(),
  "version" = "version" + 1
WHERE
  "id" = 'runtime'
  AND (
    "defaults"#>'{runtime,answerTimeoutSeconds}'
      IS DISTINCT FROM '600'::jsonb
    OR "defaults"#>'{runtime,embeddingTimeoutSeconds}'
      IS DISTINCT FROM '600'::jsonb
    OR "defaults"#>'{runtime,queryExpansionTimeoutSeconds}'
      IS DISTINCT FROM '60'::jsonb
    OR "defaults"#>'{runtime,rerankTimeoutSeconds}'
      IS DISTINCT FROM '120'::jsonb
  );

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
