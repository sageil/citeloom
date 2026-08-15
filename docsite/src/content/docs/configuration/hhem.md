---
title: Configure HHEM
description: Configure advisory claim-support scoring and its process limits.
---

CiteLoom uses the Hughes Hallucination Evaluation Model to score how strongly cited evidence supports claims in a completed answer.
These scores are advisory review signals.
They do not add, remove, rewrite, or guarantee answer content or citations.

## Process settings

Open Settings > Hughes Hallucination Evaluation Model to configure:

- Maximum padded tokens.
- Maximum attention cells.
- Model batch size.
- Torch thread count.

These values are stored in PostgreSQL.
Restart HHEM after saving them so the service reads the new revision before loading its configured runtime.

`HHEM_PORT` remains in deployment configuration because it publishes the container's fixed internal port on the host.
Changing that host port does not change application behavior inside HHEM.

## Verify readiness

The Compose health check passes when the service reports Ready with the pinned model and model revision.

```bash
docker compose ps hhem
docker compose logs hhem
```

Treat a healthy HHEM service as evidence that the scoring dependency loaded successfully, not as evidence that any particular answer is correct.
Inspect the linked source evidence before relying on an important answer.
