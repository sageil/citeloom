import hashlib
import json
import os
import shutil
import stat
import time
from pathlib import Path
from typing import Annotated, Literal, Self
from uuid import UUID, uuid4

from fastapi import (
    Depends,
    Header,
    HTTPException,
    Path as PathParameter,
    Request,
    status,
)
from pydantic import BaseModel, ConfigDict, Field, HttpUrl, model_validator

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

CHECKPOINT_DIRECTORY_ENVIRONMENT_VARIABLE = (
    "CITELOOM_DOCLING_CHECKPOINT_DIRECTORY"
)
MAXIMUM_SOURCE_CONTENT_BYTES = 1024 * 1024 * 1024
TASK_CONTENT_DIRECTORY_NAME = "source-content"
ABANDONED_TASK_CONTENT_MAX_AGE_SECONDS = 24 * 60 * 60
CONTENT_ID_PATTERN = r"^[0-9a-f]{64}$"
FILENAME_PATTERN = r"^[^/\\\x00]+$"


class CiteLoomVlmParameters(BaseModel):
    model_config = ConfigDict(extra="forbid")

    model: str = Field(min_length=1, max_length=300)


class CiteLoomVlmEngineOptions(BaseModel):
    model_config = ConfigDict(extra="forbid")

    concurrency: Literal[1]
    engine_type: Literal[
        "api",
        "api_lmstudio",
        "api_ollama",
        "api_openai",
    ]
    headers: dict[str, str]
    params: CiteLoomVlmParameters
    timeout: float = Field(gt=0)
    url: HttpUrl


class CiteLoomVlmModelSpec(BaseModel):
    model_config = ConfigDict(extra="forbid")

    default_repo_id: str = Field(min_length=1, max_length=300)
    max_new_tokens: int = Field(ge=1, le=262_144)
    name: str = Field(min_length=1, max_length=100)
    prompt: str = Field(min_length=1, max_length=2_000)
    response_format: Literal["markdown"]
    supported_engines: list[
        Literal[
            "api",
            "api_lmstudio",
            "api_ollama",
            "api_openai",
        ]
    ] = Field(min_length=1, max_length=1)
    temperature: Literal[0]


class CiteLoomVlmConvertOptions(BaseModel):
    model_config = ConfigDict(extra="forbid")

    batch_size: Literal[1]
    engine_options: CiteLoomVlmEngineOptions
    force_backend_text: Literal[False]
    model_spec: CiteLoomVlmModelSpec
    scale: float = Field(gt=0, le=8)

    @model_validator(mode="after")
    def validate_engine(self) -> Self:
        supported_engine = self.model_spec.supported_engines[0]
        if supported_engine != self.engine_options.engine_type:
            raise ValueError(
                "VLM model and runtime engine types must match."
            )
        if self.model_spec.default_repo_id != self.engine_options.params.model:
            raise ValueError(
                "VLM model identifiers must match."
            )
        return self


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
    pipeline: Literal["standard", "vlm"]
    table_cell_matching: Literal[True]
    table_mode: Literal["accurate", "fast"]
    to_formats: list[Literal["json"]] = Field(min_length=1, max_length=1)
    vlm_pipeline_custom_config: CiteLoomVlmConvertOptions | None = None

    @model_validator(mode="after")
    def validate_pipeline(self) -> Self:
        if self.pipeline == "vlm" and self.vlm_pipeline_custom_config is None:
            raise ValueError(
                "VLM processing requires a custom VLM configuration."
            )
        if (
            self.pipeline == "standard"
            and self.vlm_pipeline_custom_config is not None
        ):
            raise ValueError(
                "Standard processing cannot include a VLM configuration."
            )
        return self


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


class ContentUploadResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    byte_length: int = Field(gt=0)
    document_id: str = Field(pattern=CONTENT_ID_PATTERN)
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

    checkpoint_directory = read_checkpoint_directory()
    reset_task_content_directory(checkpoint_directory)
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
        lambda task_id: delete_task_content(
            checkpoint_directory,
            task_id,
        ),
    )

    def read_process_orchestrator() -> CiteLoomProcessOrchestrator:
        return orchestrator

    upstream_docling_app.get_async_orchestrator = read_process_orchestrator
    app = create_docling_app()

    @app.put(
        "/v1/tasks/{task_id}/content/{document_id}",
        tags=["tasks"],
        response_model=ContentUploadResponse,
    )
    async def upload_task_content(
        task_id: UUID,
        document_id: Annotated[
            str,
            PathParameter(pattern=CONTENT_ID_PATTERN),
        ],
        request: Request,
        content_length: Annotated[int, Header(alias="content-length")],
        auth: Annotated[AuthenticationResult, Depends(require_auth)],
    ) -> ContentUploadResponse:
        del auth
        retained_task_ids = {
            known_task_id
            for known_task_id, task in orchestrator.tasks.items()
            if not task.is_completed()
        }
        retained_task_ids.add(str(task_id))
        reconcile_abandoned_task_content(
            checkpoint_directory,
            retained_task_ids,
        )
        if (
            content_length <= 0
            or content_length > MAXIMUM_SOURCE_CONTENT_BYTES
        ):
            raise HTTPException(
                status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                detail="Source content length is outside the supported range.",
            )
        await store_task_content(
            checkpoint_directory,
            str(task_id),
            document_id,
            content_length,
            request,
        )
        return ContentUploadResponse(
            byte_length=content_length,
            document_id=document_id,
            task_id=task_id,
        )

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
        try:
            content_path = resolve_task_content_path(
                checkpoint_directory,
                str(request.task_id),
                request.document_id,
            )
            assert_shared_content_file(content_path, request.byte_length)
            assert_filename_matches_format(
                request.filename,
                request.options.from_formats[0],
            )
            assert_page_image_policy(request.options)
            raw_options = ConvertDocumentsOptions.model_validate(
                request.options.model_dump(mode="json")
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
            known_task = orchestrator.tasks.get(str(request.task_id))
            if known_task is None or known_task.is_completed():
                delete_task_content(
                    checkpoint_directory,
                    str(request.task_id),
                )
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=str(error),
            ) from error
        except Exception:
            known_task = orchestrator.tasks.get(str(request.task_id))
            if known_task is None or known_task.is_completed():
                delete_task_content(
                    checkpoint_directory,
                    str(request.task_id),
                )
            raise
        if task.is_completed():
            delete_task_content(
                checkpoint_directory,
                str(request.task_id),
            )
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


def reset_task_content_directory(checkpoint_directory: Path) -> None:
    content_directory = checkpoint_directory / TASK_CONTENT_DIRECTORY_NAME
    if content_directory.exists():
        assert_not_symbolic_link(content_directory)
        if not content_directory.is_dir():
            raise RuntimeError(
                "Docling task content path is not a directory."
            )
        shutil.rmtree(content_directory)
        fsync_directory(checkpoint_directory)
    content_directory.mkdir(mode=0o700)
    fsync_directory(checkpoint_directory)


def reconcile_abandoned_task_content(
    checkpoint_directory: Path,
    retained_task_ids: set[str],
    current_time_seconds: float | None = None,
) -> int:
    content_directory = checkpoint_directory / TASK_CONTENT_DIRECTORY_NAME
    try:
        assert_not_symbolic_link(content_directory)
        entries = list(content_directory.iterdir())
    except FileNotFoundError:
        return 0
    cutoff = (
        current_time_seconds
        if current_time_seconds is not None
        else time.time()
    ) - ABANDONED_TASK_CONTENT_MAX_AGE_SECONDS
    removed = 0
    for task_directory in entries:
        if task_directory.name in retained_task_ids:
            continue
        try:
            UUID(task_directory.name)
            metadata = task_directory.lstat()
        except (OSError, ValueError):
            continue
        if not stat.S_ISDIR(metadata.st_mode) or metadata.st_mtime > cutoff:
            continue
        shutil.rmtree(task_directory)
        removed += 1
    if removed > 0:
        fsync_directory(content_directory)
    return removed


async def store_task_content(
    checkpoint_directory: Path,
    task_id: str,
    document_id: str,
    byte_length: int,
    request: Request,
) -> Path:
    content_directory = checkpoint_directory / TASK_CONTENT_DIRECTORY_NAME
    ensure_private_directory(content_directory, checkpoint_directory)
    task_directory = read_task_content_directory(checkpoint_directory, task_id)
    ensure_private_directory(task_directory, content_directory)
    destination = task_directory / document_id
    temporary_path = task_directory / f".{document_id}.{uuid4()}.tmp"
    digest = hashlib.sha256()
    written = 0
    try:
        with temporary_path.open("xb") as content_file:
            os.chmod(temporary_path, 0o600)
            async for chunk in request.stream():
                written += len(chunk)
                if written > byte_length:
                    raise HTTPException(
                        status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                        detail="Uploaded source content exceeds its declared length.",
                    )
                digest.update(chunk)
                content_file.write(chunk)
            content_file.flush()
            os.fsync(content_file.fileno())
        if written != byte_length:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail="Uploaded source content length does not match.",
            )
        if digest.hexdigest() != document_id:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail="Uploaded source content hash does not match.",
            )
        temporary_path.replace(destination)
        fsync_directory(task_directory)
        return destination
    finally:
        temporary_path.unlink(missing_ok=True)
        try:
            task_directory.rmdir()
        except OSError:
            pass
        else:
            fsync_directory(content_directory)


def resolve_task_content_path(
    checkpoint_directory: Path,
    task_id: str,
    document_id: str,
) -> Path:
    task_directory = read_task_content_directory(
        checkpoint_directory,
        task_id,
    )
    candidate = task_directory / document_id
    try:
        assert_not_symbolic_link(task_directory)
        assert_not_symbolic_link(candidate)
        resolved = candidate.resolve(strict=True)
        resolved.relative_to(task_directory)
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


def read_task_content_directory(
    checkpoint_directory: Path,
    task_id: str,
) -> Path:
    normalized_task_id = str(UUID(task_id))
    return checkpoint_directory / TASK_CONTENT_DIRECTORY_NAME / normalized_task_id


def delete_task_content(
    checkpoint_directory: Path,
    task_id: str,
) -> None:
    task_directory = read_task_content_directory(
        checkpoint_directory,
        task_id,
    )
    if not task_directory.exists():
        return
    shutil.rmtree(task_directory)
    fsync_directory(task_directory.parent)


def ensure_private_directory(path: Path, parent: Path) -> None:
    try:
        path.mkdir(mode=0o700)
    except FileExistsError:
        assert_not_symbolic_link(path)
        if not path.is_dir():
            raise RuntimeError(f"Docling task content path is not a directory: {path}")
        return
    fsync_directory(parent)


def fsync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


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
