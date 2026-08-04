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
