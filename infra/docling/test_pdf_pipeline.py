import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from PIL import Image

from docling.datamodel.base_models import (
    AssembledUnit,
    Cluster,
    FigureElement,
    InputFormat,
    Page,
    Size,
    TextElement,
)
from docling.datamodel.document import InputDocument
from docling.datamodel.pipeline_options import PdfPipelineOptions
from docling.datamodel.service.options import ConvertDocumentsOptions
from docling.document_converter import PdfFormatOption
from docling.pipeline.standard_pdf_pipeline import (
    StandardPdfPipeline,
    ThreadedItem,
)
from docling_core.types.doc import (
    BoundingBox,
    CoordOrigin,
    DocItemLabel,
    PictureItem,
    ProvenanceItem,
)
from docling_jobkit.convert.manager import (
    DoclingConverterManager,
)

from citeloom_docling.pdf_pipeline import (
    CiteLoomConverterManager,
    CiteLoomPdfPipeline,
    MissingRetainedPictureImageError,
    assemble_checkpointed_pdf_document,
)


class CiteLoomPdfPipelineTest(unittest.TestCase):
    def test_releases_full_page_image_after_retaining_picture_crop(self) -> None:
        pipeline = build_pipeline()
        conv_res = SimpleNamespace()
        page = build_picture_page()
        backend = Mock()
        page._backend = backend
        item = ThreadedItem(
            payload=page,
            run_id=1,
            page_no=1,
            conv_res=conv_res,
        )

        pipeline._release_page_resources(item)

        self.assertEqual(page._image_cache, {})
        backend.unload.assert_called_once_with()
        self.assertIsNone(page._backend)
        retained = pipeline._retained_picture_images_by_run[id(conv_res)]
        self.assertEqual(len(retained), 1)
        self.assertEqual(retained[0].image.size, Size(width=40, height=40))

    def test_attaches_retained_crop_to_final_picture(self) -> None:
        pipeline = build_pipeline()
        conv_res = SimpleNamespace()
        page = build_picture_page()
        item = ThreadedItem(
            payload=page,
            run_id=1,
            page_no=1,
            conv_res=conv_res,
        )
        pipeline._release_page_resources(item)
        picture = PictureItem.model_construct(
            image=None,
            label=DocItemLabel.PICTURE,
            prov=[
                ProvenanceItem(
                    page_no=1,
                    charspan=(0, 0),
                    bbox=BoundingBox(
                        l=10,
                        t=80,
                        r=30,
                        b=60,
                        coord_origin=CoordOrigin.BOTTOMLEFT,
                    ),
                )
            ],
            self_ref="#/pictures/0",
        )
        conv_res.document = SimpleNamespace(
            iterate_items=lambda: [(picture, 0)]
        )
        conv_res.pages = [page]

        pipeline._attach_element_images(conv_res)

        self.assertIsNotNone(picture.image)
        self.assertEqual(picture.image.size, Size(width=40, height=40))
        self.assertNotIn(
            id(conv_res),
            pipeline._retained_picture_images_by_run,
        )

    def test_matches_crop_when_docling_clips_provenance_to_page(self) -> None:
        pipeline = build_pipeline()
        conv_res = SimpleNamespace()
        page = build_picture_page(right=100.25)
        item = ThreadedItem(
            payload=page,
            run_id=1,
            page_no=1,
            conv_res=conv_res,
        )
        pipeline._release_page_resources(item)
        picture = build_picture_item(right=100)
        conv_res.document = SimpleNamespace(
            iterate_items=lambda: [(picture, 0)]
        )
        conv_res.pages = [page]

        pipeline._attach_element_images(conv_res)

        self.assertIsNotNone(picture.image)

    def test_reports_unmatched_picture_with_known_element_fields(self) -> None:
        pipeline = build_pipeline()
        conv_res = SimpleNamespace()
        page = build_picture_page(right=90)
        item = ThreadedItem(
            payload=page,
            run_id=1,
            page_no=1,
            conv_res=conv_res,
        )
        pipeline._release_page_resources(item)
        picture = build_picture_item(right=70)
        conv_res.document = SimpleNamespace(
            iterate_items=lambda: [(picture, 0)]
        )
        conv_res.pages = [page]

        with self.assertRaises(MissingRetainedPictureImageError) as caught:
            pipeline._attach_element_images(conv_res)

        self.assertEqual(caught.exception.page_no, 1)
        self.assertEqual(caught.exception.docling_label, "picture")
        self.assertEqual(caught.exception.element_kind, "image")
        self.assertEqual(caught.exception.source_ref, "#/pictures/0")

    def test_releases_ordinary_page_without_retaining_an_image(self) -> None:
        pipeline = build_pipeline()
        conv_res = SimpleNamespace()
        page = Page(
            page_no=1,
            size=Size(width=100, height=100),
            assembled=AssembledUnit(),
        )
        page._default_image_scale = 2
        page._image_cache = {
            2: Image.new("RGB", (200, 200), color="white")
        }
        item = ThreadedItem(
            payload=page,
            run_id=1,
            page_no=1,
            conv_res=conv_res,
        )

        pipeline._release_page_resources(item)

        self.assertEqual(page._image_cache, {})
        self.assertNotIn(
            id(conv_res),
            pipeline._retained_picture_images_by_run,
        )

    def test_releases_page_when_picture_encoding_fails(self) -> None:
        pipeline = build_pipeline()
        conv_res = SimpleNamespace()
        page = build_picture_page()
        backend = Mock()
        page._backend = backend
        item = ThreadedItem(
            payload=page,
            run_id=1,
            page_no=1,
            conv_res=conv_res,
        )

        with (
            patch(
                "citeloom_docling.pdf_pipeline.ImageRef.from_pil",
                side_effect=RuntimeError("encoding failed"),
            ),
            self.assertRaisesRegex(RuntimeError, "encoding failed"),
        ):
            pipeline._release_page_resources(item)

        self.assertEqual(page._image_cache, {})
        backend.unload.assert_called_once_with()
        self.assertIsNone(page._backend)
        self.assertNotIn(
            id(conv_res),
            pipeline._retained_picture_images_by_run,
        )

    def test_copies_options_before_disabling_document_wide_cropping(self) -> None:
        options = PdfPipelineOptions(
            do_table_structure=True,
            generate_page_images=True,
            generate_picture_images=True,
        )
        with patch.object(StandardPdfPipeline, "__init__") as upstream_init:
            CiteLoomPdfPipeline(options)

        bounded_options = upstream_init.call_args.args[0]
        self.assertTrue(options.generate_picture_images)
        self.assertTrue(bounded_options.generate_page_images)
        self.assertFalse(bounded_options.generate_picture_images)
        self.assertTrue(bounded_options.do_table_structure)

    def test_manager_selects_citeloom_pipeline_for_standard_pdf(self) -> None:
        manager = object.__new__(CiteLoomConverterManager)
        upstream_option = PdfFormatOption(
            pipeline_cls=StandardPdfPipeline,
            pipeline_options=PdfPipelineOptions(),
        )
        with patch.object(
            DoclingConverterManager,
            "get_pdf_pipeline_opts",
            return_value=upstream_option,
        ):
            selected = manager.get_pdf_pipeline_opts(
                ConvertDocumentsOptions()
            )

        self.assertIs(selected.pipeline_cls, CiteLoomPdfPipeline)
        self.assertIs(
            selected.pipeline_options,
            upstream_option.pipeline_options,
        )

    def test_manager_uses_upstream_conversion_cache_lifecycle(self) -> None:
        self.assertIs(
            CiteLoomConverterManager.convert_documents,
            DoclingConverterManager.convert_documents,
        )

    def test_assembles_cross_page_text_after_restoring_pages(self) -> None:
        input_document = InputDocument.model_construct(
            document_hash="a" * 64,
            file=Path("boundary.pdf"),
            format=InputFormat.PDF,
            page_count=2,
            valid=True,
        )
        pages = [
            build_text_page(
                page_no=1,
                text="This paragraph continues",
            ),
            build_text_page(
                page_no=2,
                text="across the boundary.",
            ),
        ]

        result = assemble_checkpointed_pdf_document(
            input_document,
            pages,
            [],
            PdfPipelineOptions(),
            None,
        )

        self.assertEqual(len(result.document.texts), 1)
        text = result.document.texts[0]
        self.assertEqual(
            text.text,
            "This paragraph continues across the boundary.",
        )
        self.assertEqual(
            [provenance.page_no for provenance in text.prov],
            [1, 2],
        )


def build_pipeline() -> CiteLoomPdfPipeline:
    pipeline = object.__new__(CiteLoomPdfPipeline)
    pipeline._generate_picture_images = True
    pipeline.pipeline_options = PdfPipelineOptions(
        generate_picture_images=False,
        images_scale=2,
    )
    pipeline.keep_images = False
    pipeline.keep_backend = False
    pipeline._retained_picture_images_by_run = {}
    pipeline._retained_picture_images_lock = threading.Lock()
    return pipeline


def build_picture_page(*, right: float = 30) -> Page:
    figure = FigureElement.model_construct(
        cluster=SimpleNamespace(
            bbox=BoundingBox(
                l=10,
                t=20,
                r=right,
                b=40,
                coord_origin=CoordOrigin.TOPLEFT,
            )
        ),
        page_no=1,
    )
    return build_page(assembled=AssembledUnit(elements=[figure]))


def build_picture_item(*, right: float) -> PictureItem:
    return PictureItem.model_construct(
        image=None,
        label=DocItemLabel.PICTURE,
        prov=[
            ProvenanceItem(
                page_no=1,
                charspan=(0, 0),
                bbox=BoundingBox(
                    l=10,
                    t=80,
                    r=right,
                    b=60,
                    coord_origin=CoordOrigin.BOTTOMLEFT,
                ),
            )
        ],
        self_ref="#/pictures/0",
    )


def build_page(*, assembled: AssembledUnit) -> Page:
    page = Page(
        page_no=1,
        size=Size(width=100, height=100),
        assembled=assembled,
    )
    page._default_image_scale = 2
    page._image_cache = {
        2: Image.new("RGB", (200, 200), color="white")
    }
    return page


def build_text_page(*, page_no: int, text: str) -> Page:
    cluster = Cluster(
        bbox=BoundingBox(
            l=10,
            t=20,
            r=90,
            b=40,
            coord_origin=CoordOrigin.TOPLEFT,
        ),
        id=page_no,
        label=DocItemLabel.TEXT,
    )
    element = TextElement(
        cluster=cluster,
        id=page_no,
        label=DocItemLabel.TEXT,
        page_no=page_no,
        text=text,
    )
    return Page(
        assembled=AssembledUnit(
            body=[element],
            elements=[element],
        ),
        page_no=page_no,
        size=Size(width=100, height=100),
    )


if __name__ == "__main__":
    unittest.main()
