FROM python:3.12.13-slim-bookworm

ENV HF_HOME=/models/huggingface \
    HF_HUB_DISABLE_TELEMETRY=1 \
    HHEM_CACHE_DIR=/models/huggingface \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    TRANSFORMERS_NO_ADVISORY_WARNINGS=1

WORKDIR /app

COPY services/hhem/requirements-torch.txt services/hhem/requirements.txt ./
RUN pip install \
      --index-url https://download.pytorch.org/whl/cpu \
      --no-cache-dir \
      --requirement requirements-torch.txt \
    && pip install --no-cache-dir --requirement requirements.txt

COPY services/hhem/hhem_service.py ./hhem_service.py

RUN addgroup --system hhem \
    && adduser --system --ingroup hhem --home /app hhem \
    && mkdir -p /models/huggingface \
    && chown -R hhem:hhem /models /app

USER hhem
EXPOSE 8080

CMD ["python", "hhem_service.py"]
