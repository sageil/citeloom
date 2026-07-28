import unittest
from pathlib import Path
import tempfile

from docling.datamodel.base_models import (
    AssembledUnit,
    BasePageElement,
    Cluster,
    ContainerElement,
    ConversionStatus,
    DoclingComponentType,
    ErrorItem,
    FigureElement,
    InputFormat,
    Page,
    PageConfidenceScores,
    Table,
    TextElement,
)
from docling.datamodel.document import ConfidenceReport, InputDocument
from docling.datamodel.pipeline_options import PdfPipelineOptions
from docling.datamodel.service.responses import FailureCategory
from docling_core.types.doc import (
    BoundingBox,
    CoordOrigin,
    DocItemLabel,
    Size,
)
from docling_jobkit.datamodel.exportable_document import ExportableDocument

from citeloom_docling.pdf_pipeline import assemble_checkpointed_pdf_document
from citeloom_docling.range_checkpoint import (
    CheckpointedConversionError,
    CheckpointedPage,
    PageRangeArtifact,
    PageRangeExecutionFailure,
    decode_checkpointed_page,
    encode_checkpointed_page,
    read_execution_failure,
    write_execution_failure,
)


class RangeCheckpointTest(unittest.TestCase):
    def test_accepts_a_clean_successful_page_range(self) -> None:
        artifact = build_page_range_artifact(
            status=ConversionStatus.SUCCESS,
        )

        self.assertEqual(
            artifact.metadata.status,
            ConversionStatus.SUCCESS,
        )

    def test_rejects_a_successful_page_range_with_errors(self) -> None:
        with self.assertRaisesRegex(
            ValueError,
            "contains conversion errors",
        ):
            build_page_range_artifact(
                status=ConversionStatus.SUCCESS,
                errors=[
                    ErrorItem(
                        component_type=(
                            DoclingComponentType.DOCUMENT_BACKEND
                        ),
                        error_message="one page failed",
                        module_name="pdf_backend",
                        page_no=1,
                    )
                ],
            )

    def test_rejects_a_partial_page_range(self) -> None:
        with self.assertRaisesRegex(
            ValueError,
            "did not complete successfully",
        ):
            build_page_range_artifact(
                status=ConversionStatus.PARTIAL_SUCCESS,
            )

    def test_round_trip_preserves_structured_absolute_page_errors(
        self,
    ) -> None:
        error = ErrorItem(
            category=FailureCategory.BACKEND_FAILURE,
            component_type=DoclingComponentType.DOCUMENT_BACKEND,
            error_message="page decode failed",
            module_name="pdf_backend",
            page_no=23,
        )
        failure = PageRangeExecutionFailure(
            end_page=30,
            errors=[CheckpointedConversionError.from_error_item(error)],
            start_page=21,
            status=ConversionStatus.FAILURE.value,
        )

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "failure.json"
            write_execution_failure(path, failure)
            restored = read_execution_failure(path)

        self.assertEqual(restored, failure)
        self.assertEqual(restored.page_number_basis, "absolute")
        self.assertEqual(restored.errors[0].page_no, 23)
        self.assertEqual(
            restored.errors[0].category,
            FailureCategory.BACKEND_FAILURE.value,
        )

    def test_round_trip_preserves_every_page_element_type(self) -> None:
        elements = build_page_elements(page_no=1)
        page = Page(
            assembled=AssembledUnit(
                body=elements,
                elements=elements,
                headers=elements,
            ),
            page_no=1,
            size=Size(width=100, height=100),
        )

        encoded = encode_checkpointed_page(page)
        serialized = encoded.model_dump_json()
        restored_checkpoint = CheckpointedPage.model_validate_json(serialized)
        restored = decode_checkpointed_page(restored_checkpoint)

        expected_types = [
            TextElement,
            Table,
            FigureElement,
            ContainerElement,
        ]
        self.assertEqual(
            [type(element) for element in restored.assembled.elements],
            expected_types,
        )
        self.assertEqual(
            [type(element) for element in restored.assembled.body],
            expected_types,
        )
        self.assertEqual(
            [type(element) for element in restored.assembled.headers],
            expected_types,
        )
        self.assertEqual(
            [
                checkpoint.element_type
                for checkpoint in restored_checkpoint.assembled.elements
            ],
            ["text", "table", "figure", "container"],
        )

    def test_key_value_container_does_not_become_picture(self) -> None:
        container = build_container_element(page_no=1, element_id=1)
        page = Page(
            assembled=AssembledUnit(
                body=[container],
                elements=[container],
            ),
            page_no=1,
            size=Size(width=100, height=100),
        )
        checkpoint = encode_checkpointed_page(page)
        restored_checkpoint = CheckpointedPage.model_validate_json(
            checkpoint.model_dump_json()
        )
        restored_page = decode_checkpointed_page(restored_checkpoint)
        input_document = InputDocument.model_construct(
            document_hash="a" * 64,
            file=Path("key-value-region.pdf"),
            format=InputFormat.PDF,
            page_count=1,
            valid=True,
        )

        result = assemble_checkpointed_pdf_document(
            input_document,
            [restored_page],
            [],
            PdfPipelineOptions(generate_picture_images=True),
            None,
        )

        self.assertEqual(result.document.pictures, [])


def build_page_range_artifact(
    *,
    status: ConversionStatus,
    errors: list[ErrorItem] | None = None,
) -> PageRangeArtifact:
    page = Page(
        assembled=AssembledUnit(),
        page_no=1,
        size=Size(width=100, height=100),
    )
    metadata = ExportableDocument(
        document=None,
        errors=[] if errors is None else errors,
        file=Path("sample.pdf"),
        page_range=(1, 1),
        status=status,
    )
    return PageRangeArtifact(
        confidence=ConfidenceReport(
            pages={1: PageConfidenceScores()},
        ),
        metadata=metadata,
        pages=[encode_checkpointed_page(page)],
        picture_images=[],
    )


def build_page_elements(page_no: int) -> list[BasePageElement]:
    return [
        TextElement(
            cluster=build_cluster(1, DocItemLabel.TEXT),
            id=1,
            label=DocItemLabel.TEXT,
            page_no=page_no,
            text="Text",
        ),
        Table(
            cluster=build_cluster(2, DocItemLabel.TABLE),
            id=2,
            label=DocItemLabel.TABLE,
            otsl_seq=[],
            page_no=page_no,
            table_cells=[],
        ),
        FigureElement(
            cluster=build_cluster(3, DocItemLabel.PICTURE),
            id=3,
            label=DocItemLabel.PICTURE,
            page_no=page_no,
        ),
        build_container_element(page_no=page_no, element_id=4),
    ]


def build_container_element(
    *,
    page_no: int,
    element_id: int,
) -> ContainerElement:
    return ContainerElement(
        cluster=build_cluster(
            element_id,
            DocItemLabel.KEY_VALUE_REGION,
        ),
        id=element_id,
        label=DocItemLabel.KEY_VALUE_REGION,
        page_no=page_no,
    )


def build_cluster(
    cluster_id: int,
    label: DocItemLabel,
) -> Cluster:
    return Cluster(
        bbox=BoundingBox(
            l=10,
            t=20,
            r=90,
            b=40,
            coord_origin=CoordOrigin.TOPLEFT,
        ),
        id=cluster_id,
        label=label,
    )


if __name__ == "__main__":
    unittest.main()
