INSERT INTO "application_revisions" ("channel")
VALUES ('catalog'), ('jobs'), ('settings')
ON CONFLICT ("channel") DO NOTHING;

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
          "apiToken": null,
          "answer": {
            "apiToken": null,
            "baseUrl": null,
            "contextCapacityTokens": 131072,
            "model": "gemma4:e4b"
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
            "model": "embeddinggemma"
          },
          "queryExpansion": {
            "apiToken": null,
            "baseUrl": null,
            "contextCapacityTokens": 131072,
            "model": "gemma4:e4b"
          },
          "maximumParallelRequests": 1,
          "name": null,
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
            "model": "gemma4:e4b"
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
          "reranking": {
            "apiToken": null,
            "baseUrl": "http://host.docker.internal:9000/v1",
            "model": "Qwen3-Reranker-4B-mxfp8"
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
          "modelOverride": null
        },
        "embedding": {
          "contextCapacityTokensOverride": null,
          "modelOverride": null
        },
        "queryExpansion": {
          "contextCapacityTokensOverride": null,
          "modelOverride": null
        },
        "reranking": {
          "modelOverride": null
        },
        "speechToText": {
          "modelOverride": null
        },
        "summarization": {
          "contextCapacityTokensOverride": null,
          "modelOverride": null
        },
        "textToSpeech": {
          "modelOverride": null,
          "voiceOverride": null
        }
      },
      "routing": {
        "answer": "lmstudio",
        "embedding": "lmstudio",
        "queryExpansion": "lmstudio",
        "reranking": null,
        "speechToText": null,
        "summarization": "lmstudio",
        "textToSpeech": null
      }
    },
    "runtime": {
      "answerMaximumOutputTokens": 8192,
      "answerMinimumOutputTokens": 256,
      "answerProviderSafetyMarginTokens": 2048,
      "answerTemperature": 0,
      "answerTimeoutSeconds": 900,
      "aiMetricsEnabled": true,
      "backgroundProgressIntervalMs": 5000,
      "claimVerifierBaseUrl": "http://host.docker.internal:8088",
      "claimVerifierRuntimeName": "HHEM-2.1-Open",
      "claimVerifierSupportThreshold": 0.7,
      "claimVerifierTimeoutSeconds": 120,
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
      "doclingRequestTimeoutSeconds": 300,
      "doclingSecondaryImageScale": 2,
      "doclingTableMode": "accurate",
      "doclingTableStructureEnabled": true,
      "doclingTimeoutSeconds": 1800,
      "embeddingDimensions": 768,
      "embeddingProfile": "embeddinggemma",
      "embeddingSpaceId": null,
      "embeddingTimeoutSeconds": 21600,
      "expansionDecay": 1,
      "expansionQueryWeight": 1,
      "generationSeedMode": "stable",
      "inferenceThinkingMode": "disabled",
      "lexicalWeight": 1,
      "maxAttempts": 3,
      "maxDocumentMegabytes": 100,
      "originalQueryWeight": 1,
      "queryExpansionTemperature": 0,
      "queryExpansionTimeoutSeconds": 900,
      "queryExpansions": 2,
      "rerankDiscoveryMinimumScore": 0.5,
      "rerankTimeoutSeconds": 300,
      "retrievalCandidates": 50,
      "retrievalChunkTargetTokens": 512,
      "retrievalVariantConcurrency": 2,
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
    "application_settings"."defaults",
    '{sourceContent}',
    EXCLUDED."defaults"->'sourceContent',
    true
  ),
  "settings" = jsonb_set(
    "application_settings"."settings",
    '{sourceContent}',
    EXCLUDED."settings"->'sourceContent',
    true
  ),
  "updated_at" = now(),
  "version" = "application_settings"."version" + 1
WHERE
  "application_settings"."defaults"->'sourceContent'
    IS DISTINCT FROM EXCLUDED."defaults"->'sourceContent'
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
