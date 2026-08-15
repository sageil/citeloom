from __future__ import annotations

import os


def _read_value(name: str) -> str:
    value = os.environ.get(name)
    if value is None or value.strip() == "":
        raise ValueError(f"{name} is required.")
    return value


environment = os.environ.copy()
environment.update(
    {
        "DOCLING_DEBUG_PROFILE_PIPELINE_TIMINGS": _read_value(
            "DOCLING_BENCHMARK_PROFILE_PIPELINE_TIMINGS"
        ),
        "DOCLING_NUM_THREADS": _read_value("DOCLING_BENCHMARK_NUM_THREADS"),
        "DOCLING_SERVE_ENG_LOC_NUM_WORKERS": _read_value(
            "DOCLING_BENCHMARK_LOCAL_WORKER_COUNT"
        ),
        "DOCLING_SERVE_ENG_LOC_SHARE_MODELS": _read_value(
            "DOCLING_BENCHMARK_LOCAL_MODELS_SHARED"
        ),
        "DOCLING_SERVE_QUEUE_MAX_SIZE": _read_value(
            "DOCLING_BENCHMARK_QUEUE_MAX_SIZE"
        ),
    }
)
command = [
    "python",
    "-m",
    "uvicorn",
    "citeloom_docling.app:create_app",
    "--factory",
    "--host",
    "0.0.0.0",
    "--port",
    "5001",
]
os.execvpe(command[0], command, environment)
