from __future__ import annotations

import os
import sys
from dataclasses import dataclass
from typing import Mapping

@dataclass(frozen=True)
class DoclingProcessSettings:
    num_threads: int
    page_batch_size: int
    profile_pipeline_timings: bool
    queue_max_size: int
    serve_engine_workers: int
    serve_share_models: bool


@dataclass(frozen=True)
class HhemProcessSettings:
    max_attention_cells: int
    max_padded_tokens: int
    model_batch_size: int
    torch_threads: int


def _read_integer(
    settings: Mapping[str, object],
    key: str,
    minimum: int,
    maximum: int,
) -> int:
    value = settings.get(key)
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(f"Application setting {key} must be an integer.")
    if value < minimum or value > maximum:
        raise ValueError(
            f"Application setting {key} must be between {minimum} and {maximum}."
        )
    return value


def _read_boolean(settings: Mapping[str, object], key: str) -> bool:
    value = settings.get(key)
    if not isinstance(value, bool):
        raise ValueError(f"Application setting {key} must be a boolean.")
    return value


def parse_docling_process_settings(value: object) -> DoclingProcessSettings:
    if not isinstance(value, dict):
        raise ValueError("Application runtime settings must be a JSON object.")
    return DoclingProcessSettings(
        num_threads=_read_integer(value, "doclingNumThreads", 1, 1_024),
        page_batch_size=_read_integer(value, "doclingPageBatchSize", 1, 1_024),
        profile_pipeline_timings=_read_boolean(
            value, "doclingProfilePipelineTimings"
        ),
        queue_max_size=_read_integer(value, "doclingQueueMaxSize", 1, 10_000),
        serve_engine_workers=_read_integer(
            value, "doclingServeEngineWorkers", 1, 64
        ),
        serve_share_models=_read_boolean(value, "doclingServeShareModels"),
    )


def parse_hhem_process_settings(value: object) -> HhemProcessSettings:
    if not isinstance(value, dict):
        raise ValueError("Application runtime settings must be a JSON object.")
    return HhemProcessSettings(
        max_attention_cells=_read_integer(
            value, "hhemMaxAttentionCells", 1, 100_000_000
        ),
        max_padded_tokens=_read_integer(value, "hhemMaxPaddedTokens", 1, 1_000_000),
        model_batch_size=_read_integer(value, "hhemModelBatchSize", 1, 64),
        torch_threads=_read_integer(value, "hhemTorchThreads", 1, 256),
    )


def _read_runtime_settings(database_url: str) -> object:
    import psycopg

    with psycopg.connect(database_url, connect_timeout=10) as connection:
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT settings->'runtime' FROM application_settings WHERE id = %s",
                ("runtime",),
            )
            row = cursor.fetchone()
    if row is None:
        raise RuntimeError("The database does not contain application settings.")
    return row[0]


def _boolean_environment_value(value: bool) -> str:
    return "true" if value else "false"


def build_docling_environment(settings: DoclingProcessSettings) -> dict[str, str]:
    return {
        "DOCLING_DEBUG_PROFILE_PIPELINE_TIMINGS": _boolean_environment_value(
            settings.profile_pipeline_timings
        ),
        "DOCLING_NUM_THREADS": str(settings.num_threads),
        "DOCLING_PERF_PAGE_BATCH_SIZE": str(settings.page_batch_size),
        "DOCLING_SERVE_ENG_LOC_NUM_WORKERS": str(settings.serve_engine_workers),
        "DOCLING_SERVE_ENG_LOC_SHARE_MODELS": _boolean_environment_value(
            settings.serve_share_models
        ),
        "DOCLING_SERVE_QUEUE_MAX_SIZE": str(settings.queue_max_size),
    }


def build_hhem_environment(settings: HhemProcessSettings) -> dict[str, str]:
    return {
        "HHEM_MAX_ATTENTION_CELLS": str(settings.max_attention_cells),
        "HHEM_MAX_PADDED_TOKENS": str(settings.max_padded_tokens),
        "HHEM_MODEL_BATCH_SIZE": str(settings.model_batch_size),
        "HHEM_TORCH_THREADS": str(settings.torch_threads),
    }


def main(arguments: list[str]) -> None:
    if len(arguments) < 2 or arguments[0] not in {"docling", "hhem"}:
        raise ValueError(
            "Usage: runtime_settings_bootstrap.py <docling|hhem> <command> [args...]"
        )
    component = arguments[0]
    command = arguments[1:]
    database_url = os.environ.get("DATABASE_URL")
    if database_url is None or database_url.strip() == "":
        raise ValueError("DATABASE_URL is required.")
    runtime_settings = _read_runtime_settings(database_url)
    if component == "docling":
        process_environment = build_docling_environment(
            parse_docling_process_settings(runtime_settings)
        )
    else:
        process_environment = build_hhem_environment(
            parse_hhem_process_settings(runtime_settings)
        )
    environment = os.environ.copy()
    environment.update(process_environment)
    os.execvpe(command[0], command, environment)


if __name__ == "__main__":
    main(sys.argv[1:])
