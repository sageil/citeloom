---
title: Configure Docling
description: Configure document conversion, PDF processing, capacity, additional services, and restart behavior.
---

Docling converts source files into structured content that CiteLoom can index and cite.
The included Docling service stages recoverable PDF checkpoints in its own persistent directory; it does not mount CiteLoom's active source-content store.

## Configure in Settings > Docling

| Panel | Controls |
| --- | --- |
| Connection | Service URL, optional API key, and default-service conversion capacity. |
| PDF processing | Standard or VLM mode, OCR, tables, image extraction, and VLM provider details. |
| Performance and limits | Conversion time allowances and request limits. |
| Diagnostics | Conversion metrics and retention. |

The same page owns the process settings for additional service instances, pipeline profiling, thread count, page batch size, queue size, local engine workers, and model sharing.
Restart each Docling service after changing those process settings.

## Standard and VLM modes

Use Standard mode for Docling layout, OCR, and table extraction.
Eligible PDFs can resume from completed page ranges with the included service.

Use VLM mode for PDFs that need visual interpretation by an image-capable OpenAI-compatible endpoint.
VLM processing renders one page at a time in memory and sends it with the configured instructions.
The page content and selected provider credential reach that endpoint, so VLM remains local only when the endpoint is local and trusted.

## Add a named replica

The optional `docling-scale` profile starts one named replica at `http://docling-replica:5001`.

```bash
docker compose --profile docling-scale up -d --wait
```

Add the replica under Additional Docling services with a unique ID, its stable URL, and an independent capacity.

:::caution[Use named replicas]
Do not use anonymous `docker compose --scale docling=N` replicas behind one round-robin URL because only the instance that accepted a remote task can resume it.
:::

The [complete configuration reference](../../reference/configuration/#document-conversion) covers file-type behavior, VLM defaults, time limits, recovery, and multi-instance coordination.
