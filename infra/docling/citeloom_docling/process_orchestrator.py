from __future__ import annotations

import asyncio
import logging
import math
import multiprocessing
import os
import pickle
import shutil
import signal
import time
from dataclasses import dataclass, field
from multiprocessing.process import BaseProcess
from pathlib import Path
from typing import Callable, Literal

from docling.backend.pdf_backend import PdfDocumentBackend
from docling.datamodel.base_models import (
    ConversionStatus,
    DocumentStream,
    InputFormat,
    Page,
)
from docling.datamodel.document import ConfidenceReport, InputDocument
from docling.datamodel.pipeline_options import PdfPipelineOptions
from docling.datamodel.service.callbacks import CallbackSpec
from docling.datamodel.service.chunking import BaseChunkerOptions
from docling.datamodel.service.options import ConvertDocumentsOptions
from docling.datamodel.service.responses import (
    FailureCategory,
    FailurePhase,
    PublicFailureInfo,
)
from docling.datamodel.settings import DocumentLimits
from docling.datamodel.service.tasks import TaskType
from docling.utils.profiling import ProfilingItem
from docling_jobkit.convert.chunking import (
    DocumentChunkerManager,
    process_chunkable_results,
)
from docling_jobkit.convert.manager import DoclingConverterManagerConfig
from docling_jobkit.convert.results import process_exportable_results
from docling_jobkit.convert.source_expansion import expand_task_sources
from docling_jobkit.config.target_config import S3PresignedConfig
from docling_jobkit.datamodel.chunking import ChunkingExportOptions
from docling_jobkit.datamodel.exportable_document import (
    ConfidenceScores,
    ExportableDocument,
    source_to_public_uri,
)
from docling_jobkit.datamodel.result import DoclingTaskResult
from docling_jobkit.datamodel.task import Task, TaskSource, TaskTarget
from docling_jobkit.datamodel.task_meta import TaskStatus
from docling_jobkit.orchestrators.callback_invoker import CallbackInvoker
from docling_jobkit.orchestrators.local.orchestrator import (
    LocalOrchestrator,
    LocalOrchestratorConfig,
)
from docling_jobkit.public_errors import (
    build_public_task_error,
    classify_public_task_failure,
)

from citeloom_docling.pdf_pipeline import (
    CiteLoomConverterManager,
    MissingRetainedPictureImageError,
    assemble_checkpointed_pdf_document,
    checkpoint_conversion_pages,
    read_checkpointed_picture_images,
)
from citeloom_docling.range_checkpoint import (
    CheckpointedConversionError,
    CheckpointedPictureImage,
    PageRangeCheckpointStore,
    PageRangeArtifact,
    PageRangeExecutionFailure,
    PageRangeExecutionResult,
    PageRangeManifest,
    RangeCheckpointError,
    decode_checkpointed_page,
    read_execution_failure,
    read_execution_result,
    read_range_artifacts,
    write_execution_result,
    write_execution_failure,
    write_range_artifact,
)

_log = logging.getLogger(__name__)

_PROCESS_EXIT_GRACE_SECONDS = 2.0
_PROCESS_TIMEOUT_GRACE_SECONDS = 30.0


class TaskIdentityConflictError(Exception):
    pass


class RangeConversionFailure(RuntimeError):
    def __init__(self, failure: PageRangeExecutionFailure) -> None:
        super().__init__(
            "Resumable PDF range conversion returned structured errors."
        )
        self.failure = failure


@dataclass
class _ProcessExecution:
    process: BaseProcess
    result_path: Path
    error_path: Path
    closed: bool = False
    exit_code: int | None = None
    finished: asyncio.Event = field(default_factory=asyncio.Event)
    stop_lock: asyncio.Lock = field(default_factory=asyncio.Lock)


class CiteLoomProcessOrchestrator(LocalOrchestrator):
    def __init__(
        self,
        config: LocalOrchestratorConfig,
        converter_manager: CiteLoomConverterManager,
        checkpoint_directory: Path,
        page_range_size: int,
    ) -> None:
        if page_range_size <= 0:
            raise ValueError("Docling page range size must be positive.")
        process_config = config.model_copy(update={"shared_models": False})
        super().__init__(
            config=process_config,
            converter_manager=converter_manager,
        )
        self._checkpoint_store = PageRangeCheckpointStore(
            checkpoint_directory
        )
        self._page_range_size = page_range_size
        self._active_executions: dict[str, _ProcessExecution] = {}
        self._execution_lock = asyncio.Lock()
        self._pause_requests: set[str] = set()
        self._process_context = multiprocessing.get_context("spawn")
        self._termination_requests: set[str] = set()

    async def enqueue_with_task_id(
        self,
        *,
        task_id: str,
        request_fingerprint: str,
        sources: list[TaskSource],
        target: TaskTarget,
        task_type: TaskType = TaskType.CONVERT,
        convert_options: ConvertDocumentsOptions | None = None,
        chunking_options: BaseChunkerOptions | None = None,
        chunking_export_options: ChunkingExportOptions | None = None,
        callbacks: list[CallbackSpec] | None = None,
        metadata: dict[str, object] | None = None,
    ) -> Task:
        self._validate_target(target)
        async with self._execution_lock:
            existing = self.tasks.get(task_id)
            if existing is not None:
                existing_fingerprint = existing.metadata.get(
                    "request_fingerprint"
                )
                if existing_fingerprint != request_fingerprint:
                    raise TaskIdentityConflictError(
                        f"Task {task_id} already represents another request."
                    )
                if self._is_resumable_pdf_task(existing):
                    manifest = self._checkpoint_store.read_or_create(
                        task_id,
                        request_fingerprint,
                    )
                    if (
                        task_id in self._pause_requests
                        or existing.task_status == TaskStatus.FAILURE
                    ):
                        await self._resume_range_task(existing, manifest)
                return existing

            task_metadata = dict(metadata or {})
            task_metadata["request_fingerprint"] = request_fingerprint
            task = Task(
                task_id=task_id,
                task_type=task_type,
                sources=sources,
                convert_options=convert_options,
                chunking_options=chunking_options,
                chunking_export_options=(
                    chunking_export_options or ChunkingExportOptions()
                ),
                target=target,
                callbacks=callbacks or [],
                metadata=task_metadata,
            )
            if self._is_resumable_pdf_task(task):
                manifest = self._checkpoint_store.read_or_create(
                    task_id,
                    request_fingerprint,
                )
                if manifest.state != "running":
                    self._checkpoint_store.write(
                        task_id,
                        manifest.model_copy(update={"state": "running"}),
                    )
            await self.init_task_tracking(task)
            self.queue_list.append(task_id)
            await self.task_queue.put(task_id)
            return task

    async def process_queue(self) -> None:
        workers = [
            asyncio.create_task(self._worker_loop(worker_id))
            for worker_id in range(self.config.num_workers)
        ]
        try:
            await asyncio.gather(*workers)
        finally:
            for worker in workers:
                worker.cancel()
            await asyncio.gather(*workers, return_exceptions=True)
            await self._terminate_all_executions()

    async def warm_up_caches(self) -> None:
        _log.info(
            "Skipping Docling model warm-up in the lightweight supervisor."
        )

    async def clear_converters(self) -> None:
        return

    async def pause_task(
        self,
        task_id: str,
    ) -> Literal["paused", "terminated"]:
        execution: _ProcessExecution | None
        async with self._execution_lock:
            task = self.tasks.get(task_id)
            if (
                task is not None
                and not self._is_resumable_pdf_task(task)
            ):
                execution = None
            elif task is None and not self._checkpoint_store.exists(task_id):
                execution = None
            else:
                self._pause_requests.add(task_id)
                execution = self._active_executions.get(task_id)
                if task_id in self.queue_list:
                    self.queue_list.remove(task_id)

        if (
            task is not None
            and not self._is_resumable_pdf_task(task)
        ) or (
            task is None
            and not self._checkpoint_store.exists(task_id)
        ):
            await self.terminate_task(task_id)
            return "terminated"

        if execution is not None:
            await self._stop_execution(execution)
            await execution.finished.wait()

        async with self._execution_lock:
            if self._checkpoint_store.exists(task_id):
                manifest = self._checkpoint_store.read(task_id)
                self._checkpoint_store.write(
                    task_id,
                    manifest.model_copy(update={"state": "paused"}),
                )
            task = self.tasks.get(task_id)
            if task is not None and not task.is_completed():
                task.set_status(TaskStatus.PENDING)
        await self._notify_task(task_id)
        await self._notify_queue_positions()
        return "paused"

    async def terminate_task(self, task_id: str) -> None:
        execution: _ProcessExecution | None
        notify_task = False
        async with self._execution_lock:
            self._termination_requests.add(task_id)
            self._pause_requests.discard(task_id)
            execution = self._active_executions.get(task_id)
            if execution is None:
                task = self.tasks.get(task_id)
                if task is not None and not task.is_completed():
                    self._mark_task_terminated(task)
                    notify_task = True
                if task_id in self.queue_list:
                    self.queue_list.remove(task_id)

        if execution is not None:
            await self._stop_execution(execution)
            await execution.finished.wait()
        elif notify_task:
            await self._notify_task(task_id)
            await self._notify_queue_positions()
        self._checkpoint_store.delete(task_id)

    async def delete_task(self, task_id: str) -> None:
        await self.terminate_task(task_id)
        self._task_results.pop(task_id, None)
        self._pause_requests.discard(task_id)
        self._termination_requests.discard(task_id)
        await super().delete_task(task_id)

    async def _worker_loop(self, worker_id: int) -> None:
        while True:
            task_id = await self.task_queue.get()
            try:
                await self._process_task(worker_id, task_id)
            finally:
                self.task_queue.task_done()

    async def _process_task(
        self,
        worker_id: int,
        task_id: str,
    ) -> None:
        async with self._execution_lock:
            candidate = self.tasks.get(task_id)
            resumable_pdf = (
                candidate is not None
                and self._is_resumable_pdf_task(candidate)
            )
        if resumable_pdf:
            await self._process_resumable_pdf_task(worker_id, task_id)
            return

        execution: _ProcessExecution | None = None
        task: Task | None = None
        workdir = self.scratch_dir / task_id
        try:
            async with self._execution_lock:
                if task_id in self.queue_list:
                    self.queue_list.remove(task_id)
                task = self.tasks.get(task_id)
                if task is None:
                    return
                if task_id in self._termination_requests:
                    self._mark_task_terminated(task)
                    return

                workdir.mkdir(parents=True, exist_ok=True)
                execution = self._start_execution(task, workdir)
                self._active_executions[task_id] = execution
                task.set_status(TaskStatus.STARTED)

            _log.info(
                "Disposable worker %s processing task %s in process %s",
                worker_id,
                task_id,
                execution.process.pid,
            )
            await self._notify_task(task_id)
            await self._notify_queue_positions()

            timed_out = False
            try:
                await asyncio.wait_for(
                    asyncio.to_thread(execution.process.join),
                    timeout=_read_process_timeout_seconds(task),
                )
            except TimeoutError:
                timed_out = True
                await self._stop_execution(execution)
            except asyncio.CancelledError:
                await self._stop_execution(execution)
                raise

            if task_id in self._termination_requests:
                self._mark_task_terminated(task)
                return
            if timed_out:
                self._mark_task_failed(
                    task,
                    RuntimeError(
                        f"Docling task {task_id} exceeded its process deadline."
                    ),
                )
                return
            if execution.process.exitcode != 0:
                detail = _read_worker_error(execution.error_path)
                self._mark_task_failed(task, RuntimeError(detail))
                return

            result = _read_task_result(execution.result_path)
            self._task_results[task_id] = result
            task.sources = []
            task.set_status(TaskStatus.SUCCESS)
            _log.info(
                "Disposable Docling process completed task %s in %.2f seconds",
                task_id,
                result.processing_time,
            )
        except asyncio.CancelledError:
            raise
        except Exception as error:
            if task is not None:
                self._mark_task_failed(task, error)
            else:
                _log.exception(
                    "Could not start disposable Docling task %s.",
                    task_id,
                )
        finally:
            try:
                if execution is not None:
                    try:
                        await self._stop_execution(execution)
                        await self._close_execution(execution)
                    finally:
                        async with self._execution_lock:
                            self._active_executions.pop(task_id, None)
                        execution.finished.set()
            finally:
                shutil.rmtree(workdir, ignore_errors=True)
                if task is not None:
                    await self._notify_task(task_id)
                await self._notify_queue_positions()

    async def _process_resumable_pdf_task(
        self,
        worker_id: int,
        task_id: str,
    ) -> None:
        task: Task | None = None
        workdir = self.scratch_dir / task_id
        try:
            async with self._execution_lock:
                if task_id in self.queue_list:
                    self.queue_list.remove(task_id)
                task = self.tasks.get(task_id)
                if task is None:
                    return
                if task_id in self._termination_requests:
                    self._mark_task_terminated(task)
                    return
                if task_id in self._pause_requests:
                    task.set_status(TaskStatus.PENDING)
                    return
                workdir.mkdir(parents=True, exist_ok=True)
                manifest = self._checkpoint_store.read(task_id)
                if manifest.state != "running":
                    manifest = manifest.model_copy(
                        update={"state": "running"}
                    )
                    self._checkpoint_store.write(task_id, manifest)
                task.set_status(TaskStatus.STARTED)

            _log.info(
                "Disposable worker %s processing resumable PDF task %s",
                worker_id,
                task_id,
            )
            await self._notify_task(task_id)
            await self._notify_queue_positions()

            while True:
                manifest = self._checkpoint_store.read(task_id)
                if (
                    manifest.page_count is not None
                    and manifest.next_page > manifest.page_count
                ):
                    completed = await self._assemble_resumable_pdf_task(
                        task,
                        manifest,
                        workdir,
                    )
                    if not completed:
                        return
                    manifest = self._checkpoint_store.read(task_id)
                    self._checkpoint_store.write(
                        task_id,
                        manifest.model_copy(update={"state": "succeeded"}),
                    )
                    task.sources = []
                    task.set_status(TaskStatus.SUCCESS)
                    result = self._task_results[task_id]
                    _log.info(
                        "Resumable Docling PDF task %s completed in %.2f seconds",
                        task_id,
                        result.processing_time,
                    )
                    return

                start_page = manifest.next_page
                end_page = start_page + self._page_range_size - 1
                execution = await self._start_managed_execution(
                    task,
                    lambda: self._start_range_execution(
                        task,
                        workdir,
                        start_page,
                        end_page,
                    ),
                )
                if execution is None:
                    return
                timed_out = await self._wait_for_managed_execution(
                    task_id,
                    task,
                    execution,
                )
                if task_id in self._termination_requests:
                    self._mark_task_terminated(task)
                    return
                if timed_out:
                    self._mark_range_task_failed(
                        task,
                        RuntimeError(
                            f"Docling task {task_id} exceeded its process deadline."
                        ),
                    )
                    return
                if execution.exit_code != 0:
                    if task_id in self._pause_requests:
                        task.set_status(TaskStatus.PENDING)
                        return
                    self._mark_range_task_failed(
                        task,
                        _read_range_worker_failure(execution.error_path),
                    )
                    return

                range_result = read_execution_result(execution.result_path)
                async with self._execution_lock:
                    current = self._checkpoint_store.read(task_id)
                    self._validate_range_completion(
                        current,
                        range_result,
                    )
                    next_manifest = current.model_copy(
                        update={
                            "completed_ranges": [
                                *current.completed_ranges,
                                range_result.to_completed_range(),
                            ],
                            "page_count": range_result.page_count,
                            "state": (
                                "paused"
                                if task_id in self._pause_requests
                                else "running"
                            ),
                        }
                    )
                    self._checkpoint_store.write(task_id, next_manifest)
                    if task_id in self._pause_requests:
                        task.set_status(TaskStatus.PENDING)
                        return
        except asyncio.CancelledError:
            raise
        except Exception as error:
            if task is not None:
                self._mark_range_task_failed(task, error)
            else:
                _log.exception(
                    "Could not start resumable Docling task %s.",
                    task_id,
                )
        finally:
            shutil.rmtree(workdir, ignore_errors=True)
            if task is not None:
                await self._notify_task(task_id)
            await self._notify_queue_positions()

    async def _assemble_resumable_pdf_task(
        self,
        task: Task,
        manifest: PageRangeManifest,
        workdir: Path,
    ) -> bool:
        execution = await self._start_managed_execution(
            task,
            lambda: self._start_assembly_execution(
                task,
                manifest,
                workdir,
            ),
        )
        if execution is None:
            return False
        timed_out = await self._wait_for_managed_execution(
            task.task_id,
            task,
            execution,
        )
        if task.task_id in self._termination_requests:
            self._mark_task_terminated(task)
            return False
        if timed_out:
            self._mark_range_task_failed(
                task,
                RuntimeError(
                    f"Docling task {task.task_id} exceeded its assembly deadline."
                ),
            )
            return False
        if execution.exit_code != 0:
            if task.task_id in self._pause_requests:
                task.set_status(TaskStatus.PENDING)
                return False
            self._mark_range_task_failed(
                task,
                _read_range_worker_failure(execution.error_path),
            )
            return False
        result = _read_task_result(execution.result_path)
        self._task_results[task.task_id] = result
        if task.task_id in self._pause_requests:
            task.set_status(TaskStatus.PENDING)
            return False
        return True

    async def _start_managed_execution(
        self,
        task: Task,
        start_execution: Callable[[], _ProcessExecution],
    ) -> _ProcessExecution | None:
        async with self._execution_lock:
            if task.task_id in self._termination_requests:
                self._mark_task_terminated(task)
                return None
            if task.task_id in self._pause_requests:
                task.set_status(TaskStatus.PENDING)
                return None
            execution = start_execution()
            self._active_executions[task.task_id] = execution
            task.set_status(TaskStatus.STARTED)
            return execution

    async def _wait_for_managed_execution(
        self,
        task_id: str,
        task: Task,
        execution: _ProcessExecution,
    ) -> bool:
        timed_out = False
        try:
            try:
                await asyncio.wait_for(
                    asyncio.to_thread(execution.process.join),
                    timeout=_read_process_timeout_seconds(task),
                )
            except TimeoutError:
                timed_out = True
                await self._stop_execution(execution)
            except asyncio.CancelledError:
                await self._stop_execution(execution)
                raise
            return timed_out
        finally:
            try:
                await self._stop_execution(execution)
                execution.exit_code = execution.process.exitcode
                await self._close_execution(execution)
            finally:
                async with self._execution_lock:
                    self._active_executions.pop(task_id, None)
                execution.finished.set()

    def _start_range_execution(
        self,
        task: Task,
        workdir: Path,
        start_page: int,
        end_page: int,
    ) -> _ProcessExecution:
        result_path = workdir / "range-result.json"
        error_path = workdir / "range-error.txt"
        result_path.unlink(missing_ok=True)
        error_path.unlink(missing_ok=True)
        process = self._process_context.Process(
            target=_run_docling_page_range_process,
            args=(
                task,
                self.cm.config,
                self._checkpoint_store.task_directory(task.task_id),
                start_page,
                end_page,
                result_path,
                error_path,
            ),
            daemon=False,
            name=(
                f"docling-task-{task.task_id}-"
                f"pages-{start_page}-{end_page}"
            ),
        )
        process.start()
        return _ProcessExecution(
            error_path=error_path,
            process=process,
            result_path=result_path,
        )

    def _start_assembly_execution(
        self,
        task: Task,
        manifest: PageRangeManifest,
        workdir: Path,
    ) -> _ProcessExecution:
        result_path = workdir / "result.pickle"
        error_path = workdir / "assembly-error.txt"
        result_path.unlink(missing_ok=True)
        error_path.unlink(missing_ok=True)
        process = self._process_context.Process(
            target=_run_docling_range_assembly_process,
            args=(
                task,
                self.cm.config,
                self.config.s3_presigned_config,
                self._checkpoint_store.task_directory(task.task_id),
                manifest,
                workdir,
                result_path,
                error_path,
            ),
            daemon=False,
            name=f"docling-task-{task.task_id}-assembly",
        )
        process.start()
        return _ProcessExecution(
            error_path=error_path,
            process=process,
            result_path=result_path,
        )

    async def _resume_range_task(
        self,
        task: Task,
        manifest: PageRangeManifest,
    ) -> None:
        self._pause_requests.discard(task.task_id)
        self._termination_requests.discard(task.task_id)
        if (
            task.task_id in self._task_results
            and manifest.page_count is not None
            and manifest.next_page > manifest.page_count
        ):
            self._checkpoint_store.write(
                task.task_id,
                manifest.model_copy(update={"state": "succeeded"}),
            )
            task.sources = []
            task.set_status(TaskStatus.SUCCESS)
            return
        task.set_status(TaskStatus.PENDING)
        task.error_message = None
        task.failure = None
        task.finished_at = None
        self._checkpoint_store.write(
            task.task_id,
            manifest.model_copy(update={"state": "running"}),
        )
        if (
            task.task_id not in self.queue_list
            and task.task_id not in self._active_executions
        ):
            self.queue_list.append(task.task_id)
            await self.task_queue.put(task.task_id)

    def _mark_range_task_failed(
        self,
        task: Task,
        error: Exception,
    ) -> None:
        if self._checkpoint_store.exists(task.task_id):
            manifest = self._checkpoint_store.read(task.task_id)
            self._checkpoint_store.write(
                task.task_id,
                manifest.model_copy(update={"state": "failed"}),
            )
        self._mark_task_failed(task, error)

    def _is_resumable_pdf_task(self, task: Task) -> bool:
        options = task.convert_options
        return (
            task.task_type == TaskType.CONVERT
            and options is not None
            and len(task.sources) == 1
            and options.from_formats == [InputFormat.PDF]
            and not options.include_page_images
            and not options.do_chart_extraction
            and not options.do_code_enrichment
            and not options.do_formula_enrichment
            and not options.do_picture_classification
            and not options.do_picture_description
        )

    def _validate_range_completion(
        self,
        manifest: PageRangeManifest,
        result: PageRangeExecutionResult,
    ) -> None:
        if result.start_page != manifest.next_page:
            raise RangeCheckpointError(
                "Docling range completion does not match the next page."
            )
        if (
            manifest.page_count is not None
            and result.page_count != manifest.page_count
        ):
            raise RangeCheckpointError(
                "Docling document page count changed while resuming."
            )
        expected_end_page = min(
            result.start_page + self._page_range_size - 1,
            result.page_count,
        )
        if result.end_page != expected_end_page:
            raise RangeCheckpointError(
                "Docling range completion does not cover the expected pages."
            )

    def _start_execution(
        self,
        task: Task,
        workdir: Path,
    ) -> _ProcessExecution:
        result_path = workdir / "result.pickle"
        error_path = workdir / "error.txt"
        process = self._process_context.Process(
            target=_run_docling_task_process,
            args=(
                task,
                self.cm.config,
                self.config.s3_presigned_config,
                workdir,
                result_path,
                error_path,
            ),
            daemon=False,
            name=f"docling-task-{task.task_id}",
        )
        process.start()
        return _ProcessExecution(
            error_path=error_path,
            process=process,
            result_path=result_path,
        )

    async def _stop_execution(
        self,
        execution: _ProcessExecution,
    ) -> None:
        async with execution.stop_lock:
            if execution.closed:
                return
            process = execution.process
            if not process.is_alive():
                await asyncio.to_thread(process.join)
                return

            _signal_process_group(process, signal.SIGTERM)
            try:
                await asyncio.wait_for(
                    asyncio.to_thread(process.join),
                    timeout=_PROCESS_EXIT_GRACE_SECONDS,
                )
            except TimeoutError:
                _signal_process_group(process, signal.SIGKILL)
                await asyncio.to_thread(process.join)

            if process.is_alive():
                raise RuntimeError(
                    f"Docling process {process.pid} did not terminate."
                )

    async def _close_execution(
        self,
        execution: _ProcessExecution,
    ) -> None:
        async with execution.stop_lock:
            if execution.closed:
                return
            execution.process.join()
            execution.process.close()
            execution.closed = True

    async def _terminate_all_executions(self) -> None:
        async with self._execution_lock:
            executions = list(self._active_executions.values())
        for execution in executions:
            await self._stop_execution(execution)

    def _mark_task_terminated(self, task: Task) -> None:
        if task.is_completed():
            return
        task.set_status(TaskStatus.FAILURE)
        task.error_message = "Task terminated by an ingestion control request."

    def _mark_task_failed(self, task: Task, error: Exception) -> None:
        _log.error("Docling task %s failed: %s", task.task_id, error)
        if not task.is_completed():
            task.set_status(TaskStatus.FAILURE)
        if isinstance(error, RangeConversionFailure):
            task.failure = _build_range_public_failure(error.failure)
        else:
            task.failure = classify_public_task_failure(
                error,
                task_id=task.task_id,
                phase=FailurePhase.EXECUTION,
            )
        task.error_message = build_public_task_error(error)

    async def _notify_task(self, task_id: str) -> None:
        if self.notifier is not None:
            await self.notifier.notify_task_subscribers(task_id)

    async def _notify_queue_positions(self) -> None:
        if self.notifier is not None:
            await self.notifier.notify_queue_positions()


def build_citeloom_process_orchestrator(
    orchestrator: LocalOrchestrator,
    checkpoint_directory: Path,
    page_range_size: int,
) -> CiteLoomProcessOrchestrator:
    manager = CiteLoomConverterManager(orchestrator.cm.config)
    return CiteLoomProcessOrchestrator(
        orchestrator.config,
        manager,
        checkpoint_directory,
        page_range_size,
    )


def _run_docling_task_process(
    task: Task,
    manager_config: DoclingConverterManagerConfig,
    s3_presigned_config: S3PresignedConfig | None,
    workdir: Path,
    result_path: Path,
    error_path: Path,
) -> None:
    os.setsid()
    try:
        manager = CiteLoomConverterManager(manager_config)
        chunker_manager = DocumentChunkerManager()
        callback_invoker = CallbackInvoker() if task.callbacks else None
        convert_sources, headers = expand_task_sources(
            task,
            max_file_size=manager.config.max_file_size,
        )
        conversion_results = manager.convert_documents(
            sources=convert_sources,
            options=task.convert_options,
            headers=headers,
        )
        exportable_documents = (
            ExportableDocument.from_conversion_result(
                conversion_result,
                source_index=index,
                source_uri=(
                    source_to_public_uri(task.sources[index])
                    if index < len(task.sources)
                    else str(conversion_result.input.file)
                ),
            )
            for index, conversion_result in enumerate(conversion_results)
        )
        if task.task_type == TaskType.CONVERT:
            result = process_exportable_results(
                task=task,
                exportable_documents=exportable_documents,
                work_dir=workdir,
                s3_presigned_config=s3_presigned_config,
                callback_invoker=callback_invoker,
            )
        elif task.task_type == TaskType.CHUNK:
            result = process_chunkable_results(
                task=task,
                exportable_documents=exportable_documents,
                work_dir=workdir,
                chunker_manager=chunker_manager,
                callback_invoker=callback_invoker,
            )
        else:
            raise RuntimeError(f"Unsupported task type: {task.task_type}")
        _write_task_result(result_path, result)
    except BaseException as error:
        error_path.write_text(str(error), encoding="utf-8")
        raise


def _run_docling_page_range_process(
    task: Task,
    manager_config: DoclingConverterManagerConfig,
    task_directory: Path,
    start_page: int,
    end_page: int,
    result_path: Path,
    error_path: Path,
) -> None:
    os.setsid()
    started_at = time.monotonic()
    try:
        if task.convert_options is None:
            raise RuntimeError(
                "Resumable PDF conversion requires conversion options."
            )
        manager = CiteLoomConverterManager(manager_config)
        convert_sources, headers = expand_task_sources(
            task,
            max_file_size=manager.config.max_file_size,
        )
        range_options = task.convert_options.model_copy(
            update={"page_range": (start_page, end_page)}
        )
        conversion_results = list(
            manager.convert_documents(
                sources=convert_sources,
                options=range_options,
                headers=headers,
            )
        )
        if len(conversion_results) != 1:
            raise RuntimeError(
                "Resumable PDF conversion produced an unexpected document count."
            )
        conversion_result = conversion_results[0]
        if conversion_result.errors:
            page_count = conversion_result.input.page_count
            actual_end_page = (
                end_page if page_count <= 0 else min(end_page, page_count)
            )
            failure = PageRangeExecutionFailure(
                end_page=actual_end_page,
                errors=[
                    CheckpointedConversionError.from_error_item(error)
                    for error in conversion_result.errors
                ],
                start_page=start_page,
                status=conversion_result.status.value,
            )
            write_execution_failure(error_path, failure)
            raise RangeConversionFailure(failure)
        if conversion_result.status != ConversionStatus.SUCCESS:
            raise RuntimeError(
                "Resumable PDF range did not complete successfully and "
                "provided no structured conversion errors."
            )
        page_count = conversion_result.input.page_count
        if page_count <= 0:
            raise RuntimeError(
                "Resumable PDF conversion found no document pages."
            )
        actual_end_page = min(end_page, page_count)
        if actual_end_page < start_page:
            raise RuntimeError(
                "Resumable PDF conversion produced an empty page range."
            )
        exportable_document = ExportableDocument.from_conversion_result(
            conversion_result,
            source_index=0,
            source_uri=source_to_public_uri(task.sources[0]),
            page_range=(start_page, actual_end_page),
            slice_index=start_page - 1,
        )
        if exportable_document.document is None:
            raise RuntimeError(
                "Resumable PDF range did not produce an exportable document."
            )
        artifact = PageRangeArtifact(
            confidence=conversion_result.confidence,
            metadata=exportable_document.model_copy(
                update={"document": None}
            ),
            pages=checkpoint_conversion_pages(conversion_result),
            picture_images=read_checkpointed_picture_images(
                conversion_result
            ),
        )
        artifact_name = write_range_artifact(
            task_directory,
            start_page,
            actual_end_page,
            artifact,
        )
        execution_result = PageRangeExecutionResult(
            artifact_name=artifact_name,
            end_page=actual_end_page,
            page_count=page_count,
            processing_time_seconds=time.monotonic() - started_at,
            start_page=start_page,
        )
        write_execution_result(result_path, execution_result)
    except BaseException as error:
        if not error_path.exists():
            error_path.write_text(str(error), encoding="utf-8")
        raise


def _run_docling_range_assembly_process(
    task: Task,
    manager_config: DoclingConverterManagerConfig,
    s3_presigned_config: S3PresignedConfig | None,
    task_directory: Path,
    manifest: PageRangeManifest,
    workdir: Path,
    result_path: Path,
    error_path: Path,
) -> None:
    os.setsid()
    input_document: InputDocument | None = None
    try:
        artifacts = read_range_artifacts(
            task_directory,
            manifest,
        )
        if len(artifacts) != len(manifest.completed_ranges):
            raise RuntimeError(
                "Resumable PDF assembly is missing completed ranges."
            )
        if not artifacts:
            raise RuntimeError(
                "Resumable PDF assembly has no checkpointed pages."
            )
        manager = CiteLoomConverterManager(manager_config)
        input_document, pipeline_options, pdf_outline = (
            _open_checkpointed_pdf_for_assembly(
                task,
                manager,
                manifest,
            )
        )
        first = artifacts[0].metadata
        if input_document.document_hash != first.document_hash:
            raise RuntimeError(
                "Resumable PDF source changed before final assembly."
            )
        pages, picture_images = _read_checkpointed_page_state(
            artifacts,
            manifest,
        )
        assembled = assemble_checkpointed_pdf_document(
            input_document,
            pages,
            picture_images,
            pipeline_options,
            pdf_outline,
        )
        combined = ExportableDocument(
            confidence=_read_range_confidence(artifacts, manifest),
            document=assembled.document,
            document_hash=first.document_hash,
            document_type=first.document_type,
            errors=[],
            file=first.file,
            source_index=first.source_index,
            source_uri=first.source_uri,
            status=ConversionStatus.SUCCESS,
            timings=_read_range_timings(
                artifacts,
                assembled.timings,
            ),
        )
        callback_invoker = CallbackInvoker() if task.callbacks else None
        result = process_exportable_results(
            task=task,
            exportable_documents=[combined],
            work_dir=workdir,
            s3_presigned_config=s3_presigned_config,
            callback_invoker=callback_invoker,
        )
        result.processing_time += manifest.processing_time_seconds
        _write_task_result(result_path, result)
    except BaseException as error:
        failure = _build_assembly_execution_failure(error, manifest)
        write_execution_failure(error_path, failure)
        raise RangeConversionFailure(failure) from error
    finally:
        if input_document is not None:
            input_document._backend.unload()


def _open_checkpointed_pdf_for_assembly(
    task: Task,
    manager: CiteLoomConverterManager,
    manifest: PageRangeManifest,
) -> tuple[InputDocument, PdfPipelineOptions, object | None]:
    if task.convert_options is None:
        raise RuntimeError(
            "Resumable PDF assembly requires conversion options."
        )
    if manifest.page_count is None:
        raise RuntimeError(
            "Resumable PDF assembly has no document page count."
        )
    sources, _headers = expand_task_sources(
        task,
        max_file_size=manager.config.max_file_size,
    )
    source_values = list(sources)
    if len(source_values) != 1:
        raise RuntimeError(
            "Resumable PDF assembly requires exactly one source."
        )
    format_option = manager.get_pdf_pipeline_opts(task.convert_options)
    pipeline_options = format_option.pipeline_options
    if not isinstance(pipeline_options, PdfPipelineOptions):
        raise RuntimeError(
            "Resumable PDF assembly requires the standard PDF pipeline."
        )
    source = source_values[0]
    filename: str | None = None
    if isinstance(source, DocumentStream):
        filename = source.name
        path_or_stream = source.stream
    elif isinstance(source, Path):
        path_or_stream = source
    else:
        raise RuntimeError(
            "Resumable PDF assembly requires a local PDF source."
        )
    limits = DocumentLimits(
        max_file_size=manager.config.max_file_size,
        max_num_pages=manager.config.max_num_pages,
        page_range=(1, manifest.page_count),
    )
    input_document = InputDocument(
        path_or_stream=path_or_stream,
        filename=filename,
        format=InputFormat.PDF,
        backend=format_option.backend,
        backend_options=format_option.backend_options,
        limits=limits,
    )
    if not input_document.valid or not input_document._backend.is_valid():
        raise RuntimeError(
            "Resumable PDF assembly could not reopen the source document."
        )
    if input_document.page_count != manifest.page_count:
        raise RuntimeError(
            "Resumable PDF page count changed before final assembly."
        )
    pdf_outline: object | None = None
    heading_options = pipeline_options.heading_hierarchy_options
    if heading_options.enabled and heading_options.use_bookmarks:
        backend = input_document._backend
        if not isinstance(backend, PdfDocumentBackend):
            raise RuntimeError(
                "Resumable PDF assembly requires a PDF backend."
            )
        pdf_outline = backend.get_document_outline()
    return input_document, pipeline_options, pdf_outline


def _read_checkpointed_page_state(
    artifacts: list[PageRangeArtifact],
    manifest: PageRangeManifest,
) -> tuple[list[Page], list[CheckpointedPictureImage]]:
    pages: list[Page] = []
    pictures: list[CheckpointedPictureImage] = []
    first_metadata = artifacts[0].metadata
    for artifact in artifacts:
        metadata = artifact.metadata
        if (
            metadata.document_hash != first_metadata.document_hash
            or metadata.document_type != first_metadata.document_type
            or metadata.file != first_metadata.file
            or metadata.source_index != first_metadata.source_index
            or metadata.source_uri != first_metadata.source_uri
        ):
            raise RuntimeError(
                "Resumable PDF range metadata does not match."
            )
        for checkpointed_page in artifact.pages:
            pages.append(decode_checkpointed_page(checkpointed_page))
        pictures.extend(artifact.picture_images)
    if manifest.page_count is None:
        raise RuntimeError(
            "Resumable PDF assembly has no document page count."
        )
    expected_pages = list(range(1, manifest.page_count + 1))
    actual_pages = [page.page_no for page in pages]
    if actual_pages != expected_pages:
        raise RuntimeError(
            "Resumable PDF assembly does not cover every page exactly once."
        )
    return pages, pictures


def _read_range_confidence(
    artifacts: list[PageRangeArtifact],
    manifest: PageRangeManifest,
) -> ConfidenceScores:
    confidence = ConfidenceReport()
    for artifact in artifacts:
        for page_no, scores in artifact.confidence.pages.items():
            if page_no in confidence.pages:
                raise RuntimeError(
                    "Resumable PDF confidence contains a duplicate page."
                )
            confidence.pages[page_no] = scores
    if manifest.page_count is None:
        raise RuntimeError(
            "Resumable PDF confidence has no document page count."
        )
    expected_pages = list(range(1, manifest.page_count + 1))
    if sorted(confidence.pages) != expected_pages:
        raise RuntimeError(
            "Resumable PDF confidence does not cover every page."
        )
    page_scores = list(confidence.pages.values())
    combined = ConfidenceReport(
        layout_score=_mean_known_scores([
            float(scores.layout_score) for scores in page_scores
        ]),
        ocr_score=_mean_known_scores([
            float(scores.ocr_score) for scores in page_scores
        ]),
        pages=confidence.pages,
        parse_score=_mean_known_scores([
            float(scores.parse_score) for scores in page_scores
        ]),
        table_score=_mean_known_scores([
            float(scores.table_score) for scores in page_scores
        ]),
    )
    return ConfidenceScores.from_scores(combined)


def _mean_known_scores(values: list[float]) -> float:
    known_values: list[float] = []
    for value in values:
        if not math.isnan(value):
            known_values.append(value)
    if not known_values:
        return math.nan
    return sum(known_values) / len(known_values)


def _read_range_timings(
    artifacts: list[PageRangeArtifact],
    assembly_timings: dict[str, ProfilingItem],
) -> dict[str, ProfilingItem]:
    combined: dict[str, ProfilingItem] = {}
    for artifact in artifacts:
        _merge_timings(combined, artifact.metadata.timings)
    _merge_timings(combined, assembly_timings)
    return combined


def _merge_timings(
    combined: dict[str, ProfilingItem],
    additions: dict[str, ProfilingItem],
) -> None:
    for name, addition in additions.items():
        current = combined.get(name)
        if current is None:
            combined[name] = addition.model_copy(deep=True)
            continue
        if current.scope != addition.scope:
            raise RuntimeError(
                f"Resumable PDF timing scope changed for {name}."
            )
        combined[name] = ProfilingItem(
            count=current.count + addition.count,
            scope=current.scope,
            start_timestamps=[
                *current.start_timestamps,
                *addition.start_timestamps,
            ],
            times=[*current.times, *addition.times],
        )


def _write_task_result(
    result_path: Path,
    result: DoclingTaskResult,
) -> None:
    temporary_path = result_path.with_suffix(".tmp")
    with temporary_path.open("wb") as result_file:
        pickle.dump(result, result_file, protocol=pickle.HIGHEST_PROTOCOL)
        result_file.flush()
        os.fsync(result_file.fileno())
    temporary_path.replace(result_path)


def _read_task_result(result_path: Path) -> DoclingTaskResult:
    try:
        with result_path.open("rb") as result_file:
            value = pickle.load(result_file)
    except (
        AttributeError,
        EOFError,
        ImportError,
        IndexError,
        OSError,
        pickle.PickleError,
    ) as error:
        raise RuntimeError("Disposable Docling result is unreadable.") from error
    if not isinstance(value, DoclingTaskResult):
        raise RuntimeError("Disposable Docling result has an invalid type.")
    return value


def _read_worker_error(error_path: Path) -> str:
    try:
        detail = error_path.read_text(encoding="utf-8").strip()
    except OSError:
        detail = ""
    return detail or "Disposable Docling process failed without an error."


def _read_range_worker_failure(error_path: Path) -> Exception:
    try:
        return RangeConversionFailure(read_execution_failure(error_path))
    except RangeCheckpointError:
        return RuntimeError(_read_worker_error(error_path))


def _build_assembly_execution_failure(
    error: BaseException,
    manifest: PageRangeManifest,
) -> PageRangeExecutionFailure:
    if manifest.page_count is None:
        raise RangeCheckpointError(
            "Cannot describe an assembly failure without a page count."
        )
    page_no: int | None = None
    docling_label: str | None = None
    element_kind: Literal["image", "table", "text"] | None = None
    source_ref: str | None = None
    module_name = "citeloom_docling.process_orchestrator"
    if isinstance(error, MissingRetainedPictureImageError):
        docling_label = error.docling_label
        element_kind = error.element_kind
        module_name = "citeloom_docling.pdf_pipeline"
        page_no = error.page_no
        source_ref = error.source_ref
    return PageRangeExecutionFailure(
        end_page=manifest.page_count,
        errors=[
            CheckpointedConversionError(
                category=FailureCategory.INTERNAL.value,
                component_type="document_assembler",
                docling_label=docling_label,
                element_kind=element_kind,
                error_message=str(error),
                module_name=module_name,
                page_no=page_no,
                source_ref=source_ref,
            )
        ],
        start_page=1,
        status=ConversionStatus.FAILURE.value,
    )


def _build_range_public_failure(
    failure: PageRangeExecutionFailure,
) -> PublicFailureInfo:
    categories = {error.category for error in failure.errors}
    category = FailureCategory.UNKNOWN
    if len(categories) == 1:
        candidate = next(iter(categories))
        try:
            category = FailureCategory(candidate)
        except ValueError:
            category = FailureCategory.UNKNOWN
    retryable_categories = {
        FailureCategory.BACKEND_FAILURE,
        FailureCategory.CAPACITY,
        FailureCategory.INFERENCE_FAILURE,
        FailureCategory.SOURCE_UNAVAILABLE,
        FailureCategory.TIMEOUT,
        FailureCategory.UNKNOWN,
    }
    return PublicFailureInfo(
        category=category,
        details={
            "citeloom_conversion_failure": failure.model_dump_json(),
        },
        message="Document conversion failed.",
        phase=FailurePhase.EXECUTION,
        retryable=category in retryable_categories,
    )


def _read_process_timeout_seconds(task: Task) -> float:
    configured = (
        task.convert_options.document_timeout
        if task.convert_options is not None
        else None
    )
    if configured is None:
        return 14_400.0
    return max(1.0, float(configured)) + _PROCESS_TIMEOUT_GRACE_SECONDS


def _signal_process_group(
    process: BaseProcess,
    signal_number: signal.Signals,
) -> None:
    process_id = process.pid
    if process_id is None:
        return
    try:
        os.killpg(process_id, signal_number)
    except ProcessLookupError:
        if not process.is_alive():
            return
        if signal_number == signal.SIGTERM:
            process.terminate()
        else:
            process.kill()
