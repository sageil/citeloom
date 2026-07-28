from __future__ import annotations

import gzip
import os
import re
import shutil
from pathlib import Path
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from docling.datamodel.base_models import (
    AssembledUnit,
    BasePageElement,
    ContainerElement,
    ConversionStatus,
    ErrorItem,
    FigureElement,
    Page,
    Table,
    TextElement,
)
from docling.datamodel.document import ConfidenceReport
from docling_core.types.doc import BoundingBox, ImageRef, Size
from docling_jobkit.datamodel.exportable_document import ExportableDocument


_FINGERPRINT_PATTERN = re.compile(r"^[0-9a-f]{64}$")
_RANGE_ARTIFACT_PATTERN = re.compile(
    r"^(?P<start>[0-9]{8})-(?P<end>[0-9]{8})\.json\.gz$"
)
_SCHEMA_VERSION = 1


class RangeCheckpointError(RuntimeError):
    pass


class CheckpointedConversionError(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    category: str
    component_type: str
    docling_label: str | None = None
    element_kind: Literal["image", "table", "text"] | None = None
    error_message: str
    module_name: str
    page_no: int | None = Field(default=None, gt=0)
    source_ref: str | None = None

    @classmethod
    def from_error_item(
        cls,
        error: ErrorItem,
    ) -> "CheckpointedConversionError":
        return cls(
            category=error.category.value,
            component_type=error.component_type.value,
            error_message=error.error_message,
            module_name=error.module_name,
            page_no=error.page_no,
        )


class CheckpointedPictureImage(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    bbox: BoundingBox
    image: ImageRef
    page_no: int = Field(gt=0)


# Docling's untagged element union can restore containers as figures.
# Keep the concrete type explicit in every persisted checkpoint collection.
class CheckpointedTextElement(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    element: TextElement
    element_type: Literal["text"] = "text"


class CheckpointedTableElement(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    element: Table
    element_type: Literal["table"] = "table"


class CheckpointedFigureElement(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    element: FigureElement
    element_type: Literal["figure"] = "figure"


class CheckpointedContainerElement(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    element: ContainerElement
    element_type: Literal["container"] = "container"


CheckpointedPageElement = Annotated[
    CheckpointedTextElement
    | CheckpointedTableElement
    | CheckpointedFigureElement
    | CheckpointedContainerElement,
    Field(discriminator="element_type"),
]


class CheckpointedAssembledUnit(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    body: list[CheckpointedPageElement]
    elements: list[CheckpointedPageElement]
    headers: list[CheckpointedPageElement]


class CheckpointedPage(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    assembled: CheckpointedAssembledUnit
    page_no: int = Field(gt=0)
    size: Size


def encode_checkpointed_page(page: Page) -> CheckpointedPage:
    if page.assembled is None or page.size is None:
        raise ValueError(f"Docling page {page.page_no} is incomplete.")
    return CheckpointedPage(
        assembled=CheckpointedAssembledUnit(
            body=_encode_checkpointed_elements(page.assembled.body),
            elements=_encode_checkpointed_elements(page.assembled.elements),
            headers=_encode_checkpointed_elements(page.assembled.headers),
        ),
        page_no=page.page_no,
        size=page.size,
    )


def decode_checkpointed_page(page: CheckpointedPage) -> Page:
    assembled = AssembledUnit(
        body=_decode_checkpointed_elements(page.assembled.body),
        elements=_decode_checkpointed_elements(page.assembled.elements),
        headers=_decode_checkpointed_elements(page.assembled.headers),
    )
    return Page(
        assembled=assembled,
        page_no=page.page_no,
        size=page.size,
    )


def _encode_checkpointed_elements(
    elements: list[BasePageElement],
) -> list[CheckpointedPageElement]:
    encoded: list[CheckpointedPageElement] = []
    for element in elements:
        encoded.append(_encode_checkpointed_element(element))
    return encoded


def _decode_checkpointed_elements(
    elements: list[CheckpointedPageElement],
) -> list[BasePageElement]:
    decoded: list[BasePageElement] = []
    for checkpointed in elements:
        decoded.append(checkpointed.element)
    return decoded


def _encode_checkpointed_element(
    element: BasePageElement,
) -> CheckpointedPageElement:
    if isinstance(element, TextElement):
        return CheckpointedTextElement(element=element)
    if isinstance(element, Table):
        return CheckpointedTableElement(element=element)
    if isinstance(element, FigureElement):
        return CheckpointedFigureElement(element=element)
    if isinstance(element, ContainerElement):
        return CheckpointedContainerElement(element=element)
    raise TypeError(
        f"Unsupported Docling page element type: {type(element).__name__}."
    )


class PageRangeArtifact(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    confidence: ConfidenceReport
    metadata: ExportableDocument
    pages: list[CheckpointedPage]
    picture_images: list[CheckpointedPictureImage]

    @model_validator(mode="after")
    def validate_artifact(self) -> "PageRangeArtifact":
        if self.metadata.document is not None:
            raise ValueError(
                "Page range metadata must not contain an assembled document."
            )
        if self.metadata.status != ConversionStatus.SUCCESS:
            raise ValueError(
                "Page range metadata did not complete successfully."
            )
        if self.metadata.errors:
            raise ValueError(
                "Page range metadata contains conversion errors."
            )
        if self.metadata.page_range is None:
            raise ValueError("Page range metadata has no page range.")
        start_page, end_page = self.metadata.page_range
        expected_pages = list(range(start_page, end_page + 1))
        actual_pages = [page.page_no for page in self.pages]
        if actual_pages != expected_pages:
            raise ValueError(
                "Checkpointed page numbers do not match the page range."
            )
        confidence_pages = sorted(self.confidence.pages)
        if confidence_pages != expected_pages:
            raise ValueError(
                "Checkpointed confidence does not match the page range."
            )
        expected_page_set = set(expected_pages)
        for picture in self.picture_images:
            if picture.page_no not in expected_page_set:
                raise ValueError(
                    "Checkpointed picture is outside the page range."
                )
        return self


class CompletedPageRange(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    artifact_name: str
    end_page: int = Field(gt=0)
    processing_time_seconds: float = Field(ge=0)
    start_page: int = Field(gt=0)

    @model_validator(mode="after")
    def validate_range(self) -> "CompletedPageRange":
        if self.end_page < self.start_page:
            raise ValueError("Completed page range ends before it starts.")
        match = _RANGE_ARTIFACT_PATTERN.fullmatch(self.artifact_name)
        if match is None:
            raise ValueError("Completed page range artifact name is invalid.")
        if int(match.group("start")) != self.start_page:
            raise ValueError("Completed page range artifact start does not match.")
        if int(match.group("end")) != self.end_page:
            raise ValueError("Completed page range artifact end does not match.")
        return self


class PageRangeManifest(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    completed_ranges: list[CompletedPageRange]
    page_count: int | None = Field(default=None, gt=0)
    request_fingerprint: str
    schema_version: Literal[1] = _SCHEMA_VERSION
    state: Literal["running", "paused", "failed", "succeeded"]

    @model_validator(mode="after")
    def validate_manifest(self) -> "PageRangeManifest":
        if _FINGERPRINT_PATTERN.fullmatch(self.request_fingerprint) is None:
            raise ValueError("Range manifest request fingerprint is invalid.")
        expected_start = 1
        for completed_range in self.completed_ranges:
            if completed_range.start_page != expected_start:
                raise ValueError("Completed page ranges must be contiguous.")
            expected_start = completed_range.end_page + 1
        if (
            self.page_count is not None
            and self.completed_ranges
            and self.completed_ranges[-1].end_page > self.page_count
        ):
            raise ValueError("Completed page range exceeds the document page count.")
        if self.state == "succeeded":
            if self.page_count is None or not self.completed_ranges:
                raise ValueError("Succeeded range manifest is incomplete.")
            if self.completed_ranges[-1].end_page != self.page_count:
                raise ValueError("Succeeded range manifest does not cover every page.")
        return self

    @property
    def next_page(self) -> int:
        if not self.completed_ranges:
            return 1
        return self.completed_ranges[-1].end_page + 1

    @property
    def processing_time_seconds(self) -> float:
        total = 0.0
        for completed_range in self.completed_ranges:
            total += completed_range.processing_time_seconds
        return total


class PageRangeExecutionResult(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    artifact_name: str
    end_page: int = Field(gt=0)
    page_count: int = Field(gt=0)
    processing_time_seconds: float = Field(ge=0)
    start_page: int = Field(gt=0)

    @model_validator(mode="after")
    def validate_result(self) -> "PageRangeExecutionResult":
        completed_range = CompletedPageRange(
            artifact_name=self.artifact_name,
            end_page=self.end_page,
            processing_time_seconds=self.processing_time_seconds,
            start_page=self.start_page,
        )
        if completed_range.end_page > self.page_count:
            raise ValueError("Completed page range exceeds the document page count.")
        return self

    def to_completed_range(self) -> CompletedPageRange:
        return CompletedPageRange(
            artifact_name=self.artifact_name,
            end_page=self.end_page,
            processing_time_seconds=self.processing_time_seconds,
            start_page=self.start_page,
        )


class PageRangeExecutionFailure(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    end_page: int = Field(gt=0)
    errors: list[CheckpointedConversionError]
    page_number_basis: Literal["absolute"] = "absolute"
    start_page: int = Field(gt=0)
    status: Literal["failure", "partial_success", "success"]

    @model_validator(mode="after")
    def validate_failure(self) -> "PageRangeExecutionFailure":
        if self.end_page < self.start_page:
            raise ValueError("Failed page range ends before it starts.")
        if not self.errors:
            raise ValueError(
                "Failed page range must retain structured conversion errors."
            )
        return self


class PageRangeCheckpointStore:
    def __init__(self, root: Path) -> None:
        if not root.is_absolute():
            raise ValueError("Docling checkpoint directory must be absolute.")
        self.root = root

    def read_or_create(
        self,
        task_id: str,
        request_fingerprint: str,
    ) -> PageRangeManifest:
        task_directory = self.task_directory(task_id)
        manifest_path = task_directory / "manifest.json"
        if manifest_path.exists():
            manifest = read_manifest(manifest_path)
            if manifest.request_fingerprint != request_fingerprint:
                raise RangeCheckpointError(
                    f"Task {task_id} already represents another request."
                )
            self.remove_temporary_files(task_id)
            return manifest

        if task_directory.exists():
            shutil.rmtree(task_directory)
        ranges_directory = task_directory / "ranges"
        ranges_directory.mkdir(parents=True, exist_ok=False)
        manifest = PageRangeManifest(
            completed_ranges=[],
            page_count=None,
            request_fingerprint=request_fingerprint,
            state="running",
        )
        write_manifest(manifest_path, manifest)
        fsync_directory(self.root)
        return manifest

    def read(self, task_id: str) -> PageRangeManifest:
        return read_manifest(self.task_directory(task_id) / "manifest.json")

    def write(self, task_id: str, manifest: PageRangeManifest) -> None:
        write_manifest(
            self.task_directory(task_id) / "manifest.json",
            manifest,
        )

    def delete(self, task_id: str) -> None:
        task_directory = self.task_directory(task_id)
        if not task_directory.exists():
            return
        shutil.rmtree(task_directory)
        fsync_directory(self.root)

    def exists(self, task_id: str) -> bool:
        return (self.task_directory(task_id) / "manifest.json").is_file()

    def task_directory(self, task_id: str) -> Path:
        if not re.fullmatch(
            r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}",
            task_id,
            re.IGNORECASE,
        ):
            raise ValueError("Docling task ID is invalid.")
        return self.root / task_id.lower()

    def remove_temporary_files(self, task_id: str) -> None:
        task_directory = self.task_directory(task_id)
        if not task_directory.exists():
            return
        for path in task_directory.rglob("*.tmp"):
            if path.is_file():
                path.unlink()


def create_range_artifact_name(start_page: int, end_page: int) -> str:
    if start_page <= 0 or end_page < start_page:
        raise ValueError("Docling page range is invalid.")
    return f"{start_page:08d}-{end_page:08d}.json.gz"


def write_range_artifact(
    task_directory: Path,
    start_page: int,
    end_page: int,
    artifact: PageRangeArtifact,
) -> str:
    artifact_name = create_range_artifact_name(start_page, end_page)
    artifact_path = task_directory / "ranges" / artifact_name
    temporary_path = artifact_path.with_suffix(artifact_path.suffix + ".tmp")
    serialized = artifact.model_dump_json().encode("utf-8")
    with temporary_path.open("wb") as raw_file:
        with gzip.GzipFile(
            fileobj=raw_file,
            mode="wb",
            mtime=0,
        ) as compressed_file:
            compressed_file.write(serialized)
        raw_file.flush()
        os.fsync(raw_file.fileno())
    temporary_path.replace(artifact_path)
    fsync_directory(artifact_path.parent)
    return artifact_name


def read_range_artifacts(
    task_directory: Path,
    manifest: PageRangeManifest,
) -> list[PageRangeArtifact]:
    artifacts: list[PageRangeArtifact] = []
    for completed_range in manifest.completed_ranges:
        artifact_path = (
            task_directory
            / "ranges"
            / completed_range.artifact_name
        )
        try:
            with gzip.open(artifact_path, "rb") as artifact_file:
                serialized = artifact_file.read()
            artifact = PageRangeArtifact.model_validate_json(serialized)
        except (OSError, ValueError) as error:
            raise RangeCheckpointError(
                f"Docling range artifact {artifact_path.name} is unreadable."
            ) from error
        expected_range = (
            completed_range.start_page,
            completed_range.end_page,
        )
        if artifact.metadata.page_range != expected_range:
            raise RangeCheckpointError(
                f"Docling range artifact {artifact_path.name} covers "
                "unexpected pages."
            )
        artifacts.append(artifact)
    return artifacts


def read_execution_result(path: Path) -> PageRangeExecutionResult:
    try:
        serialized = path.read_text(encoding="utf-8")
        return PageRangeExecutionResult.model_validate_json(serialized)
    except (OSError, ValueError) as error:
        raise RangeCheckpointError(
            "Docling range execution result is unreadable."
        ) from error


def read_execution_failure(path: Path) -> PageRangeExecutionFailure:
    try:
        serialized = path.read_text(encoding="utf-8")
        return PageRangeExecutionFailure.model_validate_json(serialized)
    except (OSError, ValueError) as error:
        raise RangeCheckpointError(
            "Docling range execution failure is unreadable."
        ) from error


def write_execution_result(
    path: Path,
    result: PageRangeExecutionResult,
) -> None:
    write_atomic_text(path, result.model_dump_json())


def write_execution_failure(
    path: Path,
    result: PageRangeExecutionFailure,
) -> None:
    write_atomic_text(path, result.model_dump_json())


def read_manifest(path: Path) -> PageRangeManifest:
    try:
        serialized = path.read_text(encoding="utf-8")
        return PageRangeManifest.model_validate_json(serialized)
    except (OSError, ValueError) as error:
        raise RangeCheckpointError(
            f"Docling range manifest {path} is unreadable."
        ) from error


def write_manifest(path: Path, manifest: PageRangeManifest) -> None:
    write_atomic_text(path, manifest.model_dump_json(indent=2))


def write_atomic_text(path: Path, value: str) -> None:
    temporary_path = path.with_suffix(path.suffix + ".tmp")
    with temporary_path.open("w", encoding="utf-8") as output_file:
        output_file.write(value)
        output_file.flush()
        os.fsync(output_file.fileno())
    temporary_path.replace(path)
    fsync_directory(path.parent)


def fsync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
