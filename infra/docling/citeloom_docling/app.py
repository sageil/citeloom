import hashlib
import json
import os
import stat
from pathlib import Path
from typing import Annotated, Literal
from uuid import UUID

from fastapi import Depends, Header, HTTPException, status
from pydantic import BaseModel, ConfigDict, Field

from docling.datamodel.service.options import ConvertDocumentsOptions
from docling.datamodel.service.responses import TaskStatusResponse
from docling.datamodel.service.sources import FileSource
from docling.datamodel.service.targets import InBodyTarget
from docling.datamodel.service.tasks import TaskType
from docling.datamodel.settings import settings as docling_settings
from docling_jobkit.orchestrators.local.orchestrator import LocalOrchestrator
import docling_serve.app as upstream_docling_app
from docling_serve.app import create_app as create_docling_app
from docling_serve.auth import APIKeyAuth, AuthenticationResult
from docling_serve.orchestrator_factory import get_async_orchestrator
from docling_serve.policy import (
    build_service_policy,
    normalize_convert_options,
    validate_convert_options,
)
from docling_serve.settings import AsyncEngine, docling_serve_settings

from citeloom_docling.process_orchestrator import (
    CiteLoomProcessOrchestrator,
    TaskIdentityConflictError,
    build_citeloom_process_orchestrator,
)

SOURCE_CONTENT_DIRECTORY_ENVIRONMENT_VARIABLE = (
    "CITELOOM_SOURCE_CONTENT_DIRECTORY"
)
CHECKPOINT_DIRECTORY_ENVIRONMENT_VARIABLE = (
    "CITELOOM_DOCLING_CHECKPOINT_DIRECTORY"
)
CONTENT_ID_PATTERN = r"^[0-9a-f]{64}$"
FILENAME_PATTERN = r"^[^/\\\x00]+$"


class CiteLoomConvertOptions(BaseModel):
    model_config = ConfigDict(extra="forbid")

    abort_on_error: Literal[True]
    do_ocr: bool
    do_table_structure: bool
    document_timeout: float = Field(gt=0)
    force_ocr: Literal[False]
    from_formats: list[
        Literal["docx", "html", "image", "pdf", "pptx", "xlsx"]
    ] = Field(min_length=1, max_length=1)
    image_export_mode: Literal["embedded"]
    images_scale: float = Field(gt=0)
    include_images: Literal[True]
    include_page_images: bool
    ocr_preset: Literal["rapidocr"]
    pdf_backend: Literal[
        "docling_parse",
        "pypdfium2",
        "threaded_docling_parse",
    ]
    pipeline: Literal["standard"]
    table_cell_matching: Literal[True]
    table_mode: Literal["accurate", "fast"]
    to_formats: list[Literal["json"]] = Field(min_length=1, max_length=1)


class ConvertContentRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    task_id: UUID
    document_id: str = Field(pattern=CONTENT_ID_PATTERN)
    byte_length: int = Field(gt=0)
    filename: str = Field(min_length=1, max_length=255, pattern=FILENAME_PATTERN)
    options: CiteLoomConvertOptions


class TerminateTaskResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    state: Literal["terminated"]
    task_id: UUID


class PauseTaskResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    state: Literal["paused", "terminated"]
    task_id: UUID


class SharedContentSource(FileSource):
    content_path: Path = Field(exclude=True)
    byte_length: int = Field(exclude=True)
    base64_string: str = Field(default="", exclude=True)

    def to_document_stream(self) -> Path:
        assert_shared_content_file(self.content_path, self.byte_length)
        return self.content_path


def create_app():
    if docling_serve_settings.eng_kind != AsyncEngine.LOCAL:
        raise RuntimeError(
            "CiteLoom content-ID conversion requires the local Docling engine."
        )

    source_content_directory = read_source_content_directory()
    checkpoint_directory = read_checkpoint_directory()
    require_auth = APIKeyAuth(docling_serve_settings.api_key)
    service_policy = build_service_policy(docling_serve_settings)
    upstream_orchestrator = get_async_orchestrator()
    if not isinstance(upstream_orchestrator, LocalOrchestrator):
        raise RuntimeError(
            "CiteLoom content-ID conversion requires the local Docling engine."
        )
    orchestrator = build_citeloom_process_orchestrator(
        upstream_orchestrator,
        checkpoint_directory,
        docling_settings.perf.page_batch_size,
    )

    def read_process_orchestrator() -> CiteLoomProcessOrchestrator:
        return orchestrator

    upstream_docling_app.get_async_orchestrator = read_process_orchestrator
    app = create_docling_app()

    @app.post(
        "/v1/convert/content/async",
        tags=["convert"],
        response_model=TaskStatusResponse,
    )
    async def process_content_async(
        request: ConvertContentRequest,
        auth: Annotated[AuthenticationResult, Depends(require_auth)],
        x_tenant_id: Annotated[
            str | None,
            Header(alias=docling_serve_settings.eng_ray_tenant_id_header),
        ] = None,
    ) -> TaskStatusResponse:
        del auth
        content_path = resolve_content_path(
            source_content_directory,
            request.document_id,
        )
        assert_shared_content_file(content_path, request.byte_length)
        assert_filename_matches_format(
            request.filename,
            request.options.from_formats[0],
        )
        assert_page_image_policy(request.options)
        raw_options = ConvertDocumentsOptions.model_validate(
            request.options.model_dump()
        )
        options = normalize_convert_options(raw_options, service_policy)
        validate_convert_options(options, service_policy)
        source = SharedContentSource(
            byte_length=request.byte_length,
            content_path=content_path,
            filename=request.filename,
        )
        tenant_id = x_tenant_id or "default"
        request_fingerprint = fingerprint_conversion_request(
            request,
            options,
            tenant_id,
        )
        try:
            task = await orchestrator.enqueue_with_task_id(
                task_id=str(request.task_id),
                request_fingerprint=request_fingerprint,
                task_type=TaskType.CONVERT,
                sources=[source],
                convert_options=options,
                target=InBodyTarget(),
                callbacks=[],
                metadata={"tenant_id": tenant_id},
            )
        except TaskIdentityConflictError as error:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=str(error),
            ) from error
        task_position = await orchestrator.get_queue_position(
            task_id=task.task_id
        )
        return TaskStatusResponse(
            task_id=task.task_id,
            task_type=task.task_type,
            task_status=task.task_status,
            task_position=task_position,
            task_meta=task.processing_meta,
            error_message=task.error_message,
            failure=task.failure,
        )

    @app.post(
        "/v1/tasks/{task_id}/pause",
        tags=["tasks"],
        response_model=PauseTaskResponse,
    )
    async def pause_task(
        task_id: UUID,
        auth: Annotated[AuthenticationResult, Depends(require_auth)],
    ) -> PauseTaskResponse:
        del auth
        state_value = await orchestrator.pause_task(str(task_id))
        return PauseTaskResponse(
            state=state_value,
            task_id=task_id,
        )

    @app.post(
        "/v1/tasks/{task_id}/terminate",
        tags=["tasks"],
        response_model=TerminateTaskResponse,
    )
    async def terminate_task(
        task_id: UUID,
        auth: Annotated[AuthenticationResult, Depends(require_auth)],
    ) -> TerminateTaskResponse:
        del auth
        await orchestrator.terminate_task(str(task_id))
        return TerminateTaskResponse(
            state="terminated",
            task_id=task_id,
        )

    return app


def fingerprint_conversion_request(
    request: ConvertContentRequest,
    options: ConvertDocumentsOptions,
    tenant_id: str,
) -> str:
    value = {
        "byte_length": request.byte_length,
        "document_id": request.document_id,
        "filename": request.filename,
        "options": options.model_dump(mode="json"),
        "tenant_id": tenant_id,
    }
    serialized = json.dumps(
        value,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    )
    return hashlib.sha256(serialized.encode("utf-8")).hexdigest()


def read_source_content_directory() -> Path:
    configured = os.environ.get(
        SOURCE_CONTENT_DIRECTORY_ENVIRONMENT_VARIABLE,
        "",
    )
    path = Path(configured)
    if not path.is_absolute():
        raise RuntimeError(
            f"{SOURCE_CONTENT_DIRECTORY_ENVIRONMENT_VARIABLE} must be an "
            "absolute path."
        )
    try:
        resolved = path.resolve(strict=True)
    except OSError as error:
        raise RuntimeError(
            f"{SOURCE_CONTENT_DIRECTORY_ENVIRONMENT_VARIABLE} is unavailable."
        ) from error
    if not resolved.is_dir():
        raise RuntimeError(
            f"{SOURCE_CONTENT_DIRECTORY_ENVIRONMENT_VARIABLE} is not a directory."
        )
    return resolved


def read_checkpoint_directory() -> Path:
    configured = os.environ.get(
        CHECKPOINT_DIRECTORY_ENVIRONMENT_VARIABLE,
        "",
    )
    path = Path(configured)
    if not path.is_absolute():
        raise RuntimeError(
            f"{CHECKPOINT_DIRECTORY_ENVIRONMENT_VARIABLE} must be an "
            "absolute path."
        )
    try:
        path.mkdir(parents=True, exist_ok=True)
        resolved = path.resolve(strict=True)
    except OSError as error:
        raise RuntimeError(
            f"{CHECKPOINT_DIRECTORY_ENVIRONMENT_VARIABLE} is unavailable."
        ) from error
    if not resolved.is_dir():
        raise RuntimeError(
            f"{CHECKPOINT_DIRECTORY_ENVIRONMENT_VARIABLE} is not a directory."
        )
    if not os.access(resolved, os.W_OK | os.X_OK):
        raise RuntimeError(
            f"{CHECKPOINT_DIRECTORY_ENVIRONMENT_VARIABLE} is not writable."
        )
    return resolved


def resolve_content_path(
    source_content_directory: Path,
    document_id: str,
) -> Path:
    algorithm_directory = source_content_directory / "sha256"
    shard_directory = algorithm_directory / document_id[:2]
    candidate = shard_directory / document_id
    try:
        assert_not_symbolic_link(algorithm_directory)
        assert_not_symbolic_link(shard_directory)
        assert_not_symbolic_link(candidate)
        resolved = candidate.resolve(strict=True)
        resolved.relative_to(source_content_directory)
    except FileNotFoundError as error:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Source content is unavailable.",
        ) from error
    except (OSError, ValueError) as error:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="Source content path is invalid.",
        ) from error
    return resolved


def assert_shared_content_file(path: Path, byte_length: int) -> None:
    try:
        metadata = path.lstat()
    except OSError as error:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Source content is unavailable.",
        ) from error
    if stat.S_ISLNK(metadata.st_mode):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="Source content must not be a symbolic link.",
        )
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_size != byte_length:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="Source content metadata does not match.",
        )


def assert_not_symbolic_link(path: Path) -> None:
    if stat.S_ISLNK(path.lstat().st_mode):
        raise OSError(f"Symbolic links are not allowed in source content: {path}")


def assert_filename_matches_format(filename: str, input_format: str) -> None:
    extensions_by_format = {
        "docx": {".docx"},
        "html": {".htm", ".html"},
        "image": {".jpeg", ".jpg", ".png", ".webp"},
        "pdf": {".pdf"},
        "pptx": {".pptx"},
        "xlsx": {".xlsx"},
    }
    suffix = Path(filename).suffix.lower()
    if suffix not in extensions_by_format[input_format]:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="Filename extension does not match the input format.",
        )


def assert_page_image_policy(options: CiteLoomConvertOptions) -> None:
    expected = options.from_formats[0] == "image"
    if options.include_page_images != expected:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=(
                "Page images must be enabled only for standalone image "
                "conversion."
            ),
        )
