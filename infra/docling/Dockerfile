FROM quay.io/docling-project/docling-serve-cpu:v1.27.0@sha256:a70cd391c5d9e7ad23e8d76adffa5e5f03c536b4d1ea007f512c94e0b435ba45

# Changing these OCR assets or checksums requires a DOCLING_PROTOCOL_VERSION bump.
USER 0

ARG RAPIDOCR_REVISION=2d2fd79784088d11b3b840a9e63d7b710fe7fee8
ARG RAPIDOCR_BASE_URL=https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/${RAPIDOCR_REVISION}

ADD --checksum=sha256:0f8846b1d4bba223a2a2f9d9b44022fbc22cc019051a602b41a7fda9667e4cad \
  ${RAPIDOCR_BASE_URL}/onnx/PP-OCRv5/det/ch_PP-OCRv5_server_det.onnx \
  /opt/app-root/src/citeloom-ocr-models/ch_PP-OCRv5_server_det.onnx
ADD --checksum=sha256:e09385400eaaaef34ceff54aeb7c4f0f1fe014c27fa8b9905d4709b65746562a \
  ${RAPIDOCR_BASE_URL}/onnx/PP-OCRv5/rec/ch_PP-OCRv5_rec_server_infer.onnx \
  /opt/app-root/src/citeloom-ocr-models/ch_PP-OCRv5_rec_server_infer.onnx
ADD --checksum=sha256:e47acedf663230f8863ff1ab0e64dd2d82b838fceb5957146dab185a89d6215c \
  ${RAPIDOCR_BASE_URL}/onnx/PP-OCRv4/cls/ch_ppocr_mobile_v2.0_cls_infer.onnx \
  /opt/app-root/src/citeloom-ocr-models/ch_ppocr_mobile_v2.0_cls_infer.onnx
ADD --checksum=sha256:d1979e9f794c464c0d2e0b70a7fe14dd978e9dc644c0e71f14158cdf8342af1b \
  ${RAPIDOCR_BASE_URL}/paddle/PP-OCRv5/rec/ch_PP-OCRv5_rec_server_infer/ppocrv5_dict.txt \
  /opt/app-root/src/citeloom-ocr-models/ppocrv5_dict.txt

COPY infra/docling/config.yml /opt/app-root/src/citeloom-docling-config.yml
COPY infra/docling/citeloom_docling /opt/app-root/src/citeloom_docling
COPY infra/docling/patches/api-image-text-first.patch /tmp/api-image-text-first.patch

# Docling 2.113.0 puts the image before the prompt in OpenAI-compatible
# multimodal requests. Some valid vision models, including Unlimited OCR,
# require the prompt to precede the image. Guard the vendored source before
# applying this narrow compatibility patch so an upstream change fails the
# image build instead of silently patching unexpected code.
RUN api_image_request=/opt/app-root/lib64/python3.12/site-packages/docling/utils/api_image_request.py \
  && echo "751166781343bd16607469292c3039aee70dd71e587ab78306c0121862724ab5  ${api_image_request}" | sha256sum --check --status \
  && patch --batch --forward --directory="$(dirname "${api_image_request}")" --strip=0 --input=/tmp/api-image-text-first.patch \
  && rm /tmp/api-image-text-first.patch

RUN chown -R 1001:0 \
    /opt/app-root/src/citeloom-docling-config.yml \
    /opt/app-root/src/citeloom_docling \
    /opt/app-root/src/citeloom-ocr-models \
  && chmod 0444 \
    /opt/app-root/src/citeloom-docling-config.yml \
    /opt/app-root/src/citeloom_docling/*.py \
    /opt/app-root/src/citeloom-ocr-models/*

ENV DOCLING_SERVE_CONFIG_FILE=/opt/app-root/src/citeloom-docling-config.yml \
    DOCLING_SERVE_MAX_IMAGES_SCALE=8

USER 1001

CMD ["python", "-m", "uvicorn", "citeloom_docling.app:create_app", "--factory", "--host", "0.0.0.0", "--port", "5001"]
