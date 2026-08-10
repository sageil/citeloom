import asyncio
import os
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

from docling.datamodel.base_models import InputFormat
from docling.datamodel.service.responses import FailureCategory
from docling.datamodel.service.options import ConvertDocumentsOptions
from docling.datamodel.service.sources import FileSource
from docling.datamodel.service.targets import InBodyTarget
from docling_jobkit.convert.manager import DoclingConverterManagerConfig
from docling_jobkit.datamodel.task_meta import TaskStatus
from docling_jobkit.orchestrators.local.orchestrator import (
    LocalOrchestratorConfig,
)

from citeloom_docling.pdf_pipeline import (
    CiteLoomConverterManager,
    MissingRetainedPictureImageError,
)
from citeloom_docling.process_orchestrator import (
    CiteLoomProcessOrchestrator,
    TaskIdentityConflictError,
    _ProcessExecution,
    _build_assembly_execution_failure,
    _build_range_public_failure,
)
from citeloom_docling.range_checkpoint import (
    CheckpointedConversionError,
    PageRangeExecutionFailure,
    PageRangeManifest,
)


def run_isolated_sleep_process() -> None:
    os.setsid()
    while True:
        time.sleep(1)


class CiteLoomProcessOrchestratorTest(
    unittest.IsolatedAsyncioTestCase
):
    def setUp(self) -> None:
        self.scratch_directory = tempfile.TemporaryDirectory()
        self.checkpoint_directory = tempfile.TemporaryDirectory()
        config = LocalOrchestratorConfig(
            num_workers=1,
            scratch_dir=Path(self.scratch_directory.name),
            shared_models=True,
        )
        manager = CiteLoomConverterManager(
            DoclingConverterManagerConfig()
        )
        self.deleted_task_content: list[str] = []
        self.orchestrator = CiteLoomProcessOrchestrator(
            config,
            manager,
            Path(self.checkpoint_directory.name),
            4,
            self.deleted_task_content.append,
        )

    def tearDown(self) -> None:
        self.checkpoint_directory.cleanup()
        self.scratch_directory.cleanup()

    async def test_disables_shared_models_and_skips_warm_up(self) -> None:
        self.assertFalse(self.orchestrator.config.shared_models)
        with patch.object(
            self.orchestrator.cm,
            "get_converter",
        ) as get_converter:
            await self.orchestrator.warm_up_caches()
        get_converter.assert_not_called()

    async def test_exposes_structured_range_failure_to_task_clients(
        self,
    ) -> None:
        failure = PageRangeExecutionFailure(
            end_page=30,
            errors=[
                CheckpointedConversionError(
                    category=FailureCategory.BACKEND_FAILURE.value,
                    component_type="document_backend",
                    error_message="page decode failed",
                    module_name="pdf_backend",
                    page_no=23,
                ),
                CheckpointedConversionError(
                    category=FailureCategory.BACKEND_FAILURE.value,
                    component_type="model",
                    error_message="document model failed",
                    module_name="layout_model",
                    page_no=None,
                ),
            ],
            start_page=21,
            status="failure",
        )

        public_failure = _build_range_public_failure(failure)

        self.assertEqual(
            public_failure.category,
            FailureCategory.BACKEND_FAILURE,
        )
        self.assertTrue(public_failure.retryable)
        restored = PageRangeExecutionFailure.model_validate_json(
            public_failure.details["citeloom_conversion_failure"]
        )
        self.assertEqual(restored, failure)

    async def test_describes_known_picture_assembly_failure(self) -> None:
        manifest = PageRangeManifest(
            completed_ranges=[],
            page_count=1124,
            request_fingerprint="a" * 64,
            state="failed",
        )
        error = MissingRetainedPictureImageError(
            docling_label="picture",
            page_no=1,
            source_ref="#/pictures/0",
        )

        failure = _build_assembly_execution_failure(error, manifest)

        self.assertEqual(failure.start_page, 1)
        self.assertEqual(failure.end_page, 1124)
        self.assertEqual(failure.status, "failure")
        self.assertEqual(len(failure.errors), 1)
        detail = failure.errors[0]
        self.assertEqual(detail.category, FailureCategory.INTERNAL.value)
        self.assertEqual(detail.component_type, "document_assembler")
        self.assertEqual(detail.module_name, "citeloom_docling.pdf_pipeline")
        self.assertEqual(detail.page_no, 1)
        self.assertEqual(detail.docling_label, "picture")
        self.assertEqual(detail.element_kind, "image")
        self.assertEqual(detail.source_ref, "#/pictures/0")

    async def test_reuses_one_client_task_identity(self) -> None:
        task = await self.orchestrator.enqueue_with_task_id(
            task_id="00000000-0000-4000-8000-000000000021",
            request_fingerprint="request-a",
            sources=[],
            target=InBodyTarget(),
        )
        repeated = await self.orchestrator.enqueue_with_task_id(
            task_id=task.task_id,
            request_fingerprint="request-a",
            sources=[],
            target=InBodyTarget(),
        )

        self.assertIs(repeated, task)
        self.assertEqual(await self.orchestrator.queue_size(), 1)

        with self.assertRaisesRegex(
            TaskIdentityConflictError,
            "another request",
        ):
            await self.orchestrator.enqueue_with_task_id(
                task_id=task.task_id,
                request_fingerprint="request-b",
                sources=[],
                target=InBodyTarget(),
            )

    async def test_pauses_and_requeues_a_pdf_with_its_checkpoint(self) -> None:
        task_id = "00000000-0000-4000-8000-000000000024"
        fingerprint = "a" * 64
        task = await self.orchestrator.enqueue_with_task_id(
            task_id=task_id,
            request_fingerprint=fingerprint,
            sources=[
                FileSource(
                    base64_string="JVBERi0=",
                    filename="sample.pdf",
                )
            ],
            target=InBodyTarget(),
            convert_options=ConvertDocumentsOptions(
                from_formats=[InputFormat.PDF],
                to_formats=["json"],
            ),
        )

        self.assertEqual(
            await self.orchestrator.pause_task(task_id),
            "paused",
        )
        self.assertEqual(task.task_status, TaskStatus.PENDING)
        manifest = self.orchestrator._checkpoint_store.read(task_id)
        self.assertEqual(manifest.state, "paused")
        self.assertNotIn(task_id, self.orchestrator.queue_list)

        resumed = await self.orchestrator.enqueue_with_task_id(
            task_id=task_id,
            request_fingerprint=fingerprint,
            sources=[
                FileSource(
                    base64_string="JVBERi0=",
                    filename="sample.pdf",
                )
            ],
            target=InBodyTarget(),
            convert_options=ConvertDocumentsOptions(
                from_formats=[InputFormat.PDF],
                to_formats=["json"],
            ),
        )

        self.assertIs(resumed, task)
        self.assertEqual(
            self.orchestrator._checkpoint_store.read(task_id).state,
            "running",
        )
        self.assertIn(task_id, self.orchestrator.queue_list)

        await self.orchestrator.terminate_task(task_id)
        self.assertFalse(
            self.orchestrator._checkpoint_store.exists(task_id)
        )
        self.assertEqual(self.deleted_task_content, [task_id])

    async def test_termination_before_submission_prevents_process_start(
        self,
    ) -> None:
        task_id = "00000000-0000-4000-8000-000000000023"
        await self.orchestrator.terminate_task(task_id)
        await self.orchestrator.terminate_task(task_id)
        task = await self.orchestrator.enqueue_with_task_id(
            task_id=task_id,
            request_fingerprint="request-a",
            sources=[],
            target=InBodyTarget(),
        )

        with patch.object(
            self.orchestrator,
            "_start_execution",
        ) as start_execution:
            await self.orchestrator._process_task(0, task_id)

        start_execution.assert_not_called()
        self.assertEqual(task.task_status, TaskStatus.FAILURE)
        self.assertIn("terminated", task.error_message.lower())

    async def test_terminates_and_reaps_an_active_process(self) -> None:
        task = await self.orchestrator.enqueue_with_task_id(
            task_id="00000000-0000-4000-8000-000000000022",
            request_fingerprint="request-a",
            sources=[],
            target=InBodyTarget(),
        )

        def start_execution(_task, workdir):
            result_path = workdir / "result.pickle"
            error_path = workdir / "error.txt"
            process = self.orchestrator._process_context.Process(
                target=run_isolated_sleep_process,
                daemon=False,
            )
            process.start()
            return _ProcessExecution(
                error_path=error_path,
                process=process,
                result_path=result_path,
            )

        with patch.object(
            self.orchestrator,
            "_start_execution",
            side_effect=start_execution,
        ):
            worker = asyncio.create_task(
                self.orchestrator._process_task(0, task.task_id)
            )
            process_id = await self.wait_for_process_id(task.task_id)
            await self.orchestrator.terminate_task(task.task_id)
            await worker

        self.assertEqual(task.task_status, TaskStatus.FAILURE)
        self.assertIn("terminated", task.error_message.lower())
        self.assertNotIn(
            task.task_id,
            self.orchestrator._active_executions,
        )
        with self.assertRaises(ProcessLookupError):
            os.kill(process_id, 0)

    async def wait_for_process_id(self, task_id: str) -> int:
        for _attempt in range(100):
            execution = self.orchestrator._active_executions.get(task_id)
            if execution is not None and execution.process.pid is not None:
                return execution.process.pid
            await asyncio.sleep(0.01)
        self.fail("Disposable process did not start.")
