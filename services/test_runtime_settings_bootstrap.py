import unittest

from runtime_settings_bootstrap import (
    build_docling_environment,
    build_hhem_environment,
    parse_docling_process_settings,
    parse_hhem_process_settings,
)


class RuntimeSettingsBootstrapTest(unittest.TestCase):
    def test_decodes_docling_settings_into_environment(self) -> None:
        settings = parse_docling_process_settings(
            {
                "doclingNumThreads": 6,
                "doclingPageBatchSize": 3,
                "doclingProfilePipelineTimings": True,
                "doclingQueueMaxSize": 12,
                "doclingServeEngineWorkers": 2,
                "doclingServeShareModels": False,
            }
        )
        self.assertEqual(
            build_docling_environment(settings),
            {
                "DOCLING_DEBUG_PROFILE_PIPELINE_TIMINGS": "true",
                "DOCLING_NUM_THREADS": "6",
                "DOCLING_PERF_PAGE_BATCH_SIZE": "3",
                "DOCLING_SERVE_ENG_LOC_NUM_WORKERS": "2",
                "DOCLING_SERVE_ENG_LOC_SHARE_MODELS": "false",
                "DOCLING_SERVE_QUEUE_MAX_SIZE": "12",
            },
        )

    def test_decodes_hhem_settings_into_environment(self) -> None:
        settings = parse_hhem_process_settings(
            {
                "hhemMaxAttentionCells": 500,
                "hhemMaxPaddedTokens": 100,
                "hhemModelBatchSize": 8,
                "hhemTorchThreads": 3,
            }
        )
        self.assertEqual(
            build_hhem_environment(settings),
            {
                "HHEM_MAX_ATTENTION_CELLS": "500",
                "HHEM_MAX_PADDED_TOKENS": "100",
                "HHEM_MODEL_BATCH_SIZE": "8",
                "HHEM_TORCH_THREADS": "3",
            },
        )

    def test_rejects_boolean_for_integer_setting(self) -> None:
        with self.assertRaisesRegex(ValueError, "hhemTorchThreads must be an integer"):
            parse_hhem_process_settings(
                {
                    "hhemMaxAttentionCells": 500,
                    "hhemMaxPaddedTokens": 100,
                    "hhemModelBatchSize": 8,
                    "hhemTorchThreads": True,
                }
            )


if __name__ == "__main__":
    unittest.main()
