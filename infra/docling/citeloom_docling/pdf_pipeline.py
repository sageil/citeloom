import math
import threading
from dataclasses import dataclass

from docling.datamodel.base_models import (
    FigureElement,
    Page,
)
from docling.datamodel.document import ConversionResult, InputDocument
from docling.datamodel.pipeline_options import PdfPipelineOptions
from docling.datamodel.service.options import ConvertDocumentsOptions
from docling.document_converter import PdfFormatOption
from docling.models.stages.heading_hierarchy.heading_hierarchy_model import (
    HeadingHierarchyModel,
)
from docling.models.stages.reading_order.readingorder_model import (
    ReadingOrderModel,
    ReadingOrderOptions,
)
from docling.pipeline.standard_pdf_pipeline import (
    StandardPdfPipeline,
    ThreadedItem,
)
from docling_core.types.doc import (
    BoundingBox,
    ImageRef,
    NodeItem,
    PictureItem,
    Size,
)
from docling_jobkit.convert.manager import (
    DoclingConverterManager,
)

from citeloom_docling.range_checkpoint import (
    CheckpointedPage,
    CheckpointedPictureImage,
    encode_checkpointed_page,
)


@dataclass(frozen=True)
class _RetainedPictureImage:
    bbox: BoundingBox
    image: ImageRef
    page_no: int


class MissingRetainedPictureImageError(RuntimeError):
    def __init__(
        self,
        *,
        docling_label: str,
        page_no: int,
        source_ref: str,
    ) -> None:
        super().__init__(
            f"Missing retained picture image for Docling page {page_no}."
        )
        self.docling_label = docling_label
        self.element_kind = "image"
        self.page_no = page_no
        self.source_ref = source_ref


class CiteLoomPdfPipeline(StandardPdfPipeline):
    def __init__(self, pipeline_options: PdfPipelineOptions) -> None:
        self._generate_picture_images = (
            pipeline_options.generate_picture_images
        )
        bounded_options = pipeline_options.model_copy(
            update={"generate_picture_images": False}
        )
        super().__init__(bounded_options)
        self._retained_picture_images_by_run: dict[
            int,
            list[_RetainedPictureImage],
        ] = {}
        self._retained_picture_images_lock = threading.Lock()

    def _release_page_resources(self, item: ThreadedItem) -> None:
        try:
            page = item.payload
            if page is not None:
                retained = self._read_element_images(page)
                if retained:
                    run_key = id(item.conv_res)
                    with self._retained_picture_images_lock:
                        images = self._retained_picture_images_by_run.setdefault(
                            run_key,
                            [],
                        )
                        images.extend(retained)
        finally:
            super()._release_page_resources(item)

    def _assemble_document(
        self,
        conv_res: ConversionResult,
    ) -> ConversionResult:
        result = super()._assemble_document(conv_res)
        self._attach_element_images(result)
        return result

    def _unload(self, conv_res: ConversionResult) -> None:
        with self._retained_picture_images_lock:
            self._retained_picture_images_by_run.pop(id(conv_res), None)
        super()._unload(conv_res)

    def _read_element_images(
        self,
        page: Page,
    ) -> list[_RetainedPictureImage]:
        if page.assembled is None or page.size is None:
            return []
        if not self._generate_picture_images:
            return []

        page_image = page.image
        if page_image is None:
            raise RuntimeError(
                f"Docling page {page.page_no} has no rendered image."
            )

        scale = self.pipeline_options.images_scale
        retained: list[_RetainedPictureImage] = []
        for element in page.assembled.elements:
            if not isinstance(element, FigureElement):
                continue
            crop_bbox = (
                element.cluster.bbox
                .scaled(scale=scale)
                .to_top_left_origin(page_height=page.size.height * scale)
            )
            cropped_image = page_image.crop(crop_bbox.as_tuple())
            image = ImageRef.from_pil(
                cropped_image,
                dpi=int(72 * scale),
            )
            retained.append(
                _RetainedPictureImage(
                    bbox=element.cluster.bbox.to_bottom_left_origin(
                        page.size.height
                    ),
                    image=image,
                    page_no=page.page_no,
                )
            )
        return retained

    def _attach_element_images(
        self,
        conv_res: ConversionResult,
    ) -> None:
        with self._retained_picture_images_lock:
            retained = self._retained_picture_images_by_run.pop(
                id(conv_res),
                [],
            )
        if not retained:
            return

        page_sizes: dict[int, Size] = {}
        for page in conv_res.pages:
            if page.size is not None:
                page_sizes[page.page_no] = page.size
        for element, _level in conv_res.document.iterate_items():
            if not self._is_picture_item(element) or len(element.prov) == 0:
                continue
            provenance = element.prov[0]
            page_size = page_sizes.get(provenance.page_no)
            if page_size is None:
                raise RuntimeError(
                    "Cannot attach a retained picture image without "
                    f"the size of Docling page {provenance.page_no}."
                )
            image = _pop_retained_image(
                retained,
                bbox=provenance.bbox,
                docling_label=element.label.value,
                page_size=page_size,
                page_no=provenance.page_no,
                source_ref=element.self_ref,
            )
            element.image = image

    def _is_picture_item(
        self,
        element: NodeItem,
    ) -> bool:
        return (
            self._generate_picture_images
            and isinstance(element, PictureItem)
        )


class CiteLoomConverterManager(DoclingConverterManager):
    def get_pdf_pipeline_opts(
        self,
        request: ConvertDocumentsOptions,
    ) -> PdfFormatOption:
        pdf_format_option = super().get_pdf_pipeline_opts(request)
        if pdf_format_option.pipeline_cls is not StandardPdfPipeline:
            return pdf_format_option
        return pdf_format_option.model_copy(
            update={"pipeline_cls": CiteLoomPdfPipeline}
        )


def checkpoint_conversion_pages(
    conversion_result: ConversionResult,
) -> list[CheckpointedPage]:
    pages: list[CheckpointedPage] = []
    for page in conversion_result.pages:
        pages.append(encode_checkpointed_page(page))
    return pages


def read_checkpointed_picture_images(
    conversion_result: ConversionResult,
) -> list[CheckpointedPictureImage]:
    pictures: list[CheckpointedPictureImage] = []
    for element, _level in conversion_result.document.iterate_items():
        if not isinstance(element, PictureItem):
            continue
        if element.image is None or len(element.prov) == 0:
            continue
        provenance = element.prov[0]
        pictures.append(
            CheckpointedPictureImage(
                bbox=provenance.bbox,
                image=element.image,
                page_no=provenance.page_no,
            )
        )
    return pictures


def assemble_checkpointed_pdf_document(
    input_document: InputDocument,
    pages: list[Page],
    picture_images: list[CheckpointedPictureImage],
    pipeline_options: PdfPipelineOptions,
    pdf_outline: object | None,
) -> ConversionResult:
    _validate_checkpointed_assembly_options(pipeline_options)
    pipeline = object.__new__(CiteLoomPdfPipeline)
    pipeline._generate_picture_images = (
        pipeline_options.generate_picture_images
    )
    pipeline.pipeline_options = pipeline_options.model_copy(
        update={
            "generate_picture_images": False,
            "generate_table_images": False,
        }
    )
    pipeline.reading_order_model = ReadingOrderModel(
        options=ReadingOrderOptions()
    )
    pipeline.heading_hierarchy_model = HeadingHierarchyModel(
        options=pipeline_options.heading_hierarchy_options
    )
    pipeline._retained_picture_images_by_run = {}
    pipeline._retained_picture_images_lock = threading.Lock()

    conversion_result = ConversionResult(
        input=input_document,
        pages=pages,
    )
    conversion_result._pdf_outline = pdf_outline
    retained: list[_RetainedPictureImage] = []
    for picture in picture_images:
        retained.append(
            _RetainedPictureImage(
                bbox=picture.bbox,
                image=picture.image,
                page_no=picture.page_no,
            )
        )
    pipeline._retained_picture_images_by_run[id(conversion_result)] = retained
    return pipeline._assemble_document(conversion_result)


def _validate_checkpointed_assembly_options(
    pipeline_options: PdfPipelineOptions,
) -> None:
    if pipeline_options.generate_page_images:
        raise RuntimeError(
            "Resumable PDF conversion does not support page images."
        )
    enrichment_enabled = (
        pipeline_options.do_chart_extraction
        or pipeline_options.do_code_enrichment
        or pipeline_options.do_formula_enrichment
        or pipeline_options.do_picture_classification
        or pipeline_options.do_picture_description
    )
    if enrichment_enabled:
        raise RuntimeError(
            "Resumable PDF conversion does not support Docling enrichment."
        )


def _pop_retained_image(
    retained: list[_RetainedPictureImage],
    *,
    bbox: BoundingBox,
    docling_label: str,
    page_size: Size,
    page_no: int,
    source_ref: str,
) -> ImageRef:
    for index, candidate in enumerate(retained):
        if candidate.page_no != page_no:
            continue
        if not _same_bounding_box(candidate.bbox, bbox, page_size):
            continue
        return retained.pop(index).image
    raise MissingRetainedPictureImageError(
        docling_label=docling_label,
        page_no=page_no,
        source_ref=source_ref,
    )


def _same_bounding_box(
    left: BoundingBox,
    right: BoundingBox,
    page_size: Size,
) -> bool:
    left_values = _read_page_bounded_box(left, page_size)
    right_values = _read_page_bounded_box(right, page_size)
    for left_value, right_value in zip(
        left_values,
        right_values,
        strict=True,
    ):
        if not math.isclose(left_value, right_value, abs_tol=1e-6):
            return False
    return True


def _read_page_bounded_box(
    bbox: BoundingBox,
    page_size: Size,
) -> tuple[float, float, float, float]:
    normalized = bbox.to_bottom_left_origin(
        page_height=page_size.height
    )
    return (
        _bound_coordinate(normalized.l, page_size.width),
        _bound_coordinate(normalized.t, page_size.height),
        _bound_coordinate(normalized.r, page_size.width),
        _bound_coordinate(normalized.b, page_size.height),
    )


def _bound_coordinate(value: float, maximum: float) -> float:
    return min(max(value, 0.0), maximum)
