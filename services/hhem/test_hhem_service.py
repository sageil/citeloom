from http.client import HTTPConnection
import json
from pathlib import Path
import threading
import unittest
from unittest.mock import MagicMock, patch

from huggingface_hub.errors import LocalEntryNotFoundError
import torch

from hhem_service import (
    HHEM_MODEL_ID,
    HHEM_MODEL_REVISION,
    MODEL_MAX_INPUT_TOKENS,
    HhemHttpServer,
    ModelOutputError,
    ModelScorer,
    RequestValidationError,
    ScoreItem,
    ScoreRequest,
    ServiceState,
    read_hhem_model,
    read_model_scores,
    read_or_download_snapshot,
    read_score_request,
)


class FakeModel:
    def __init__(self) -> None:
        self.batches: list[tuple[tuple[str, str], ...]] = []

    def count_tokens(self, evidence: str, claim: str) -> int:
        return len(evidence) + len(claim)

    def predict(self, pairs: list[tuple[str, str]]) -> object:
        self.batches.append(tuple(pairs))
        scores = []
        for evidence, claim in pairs:
            scores.append(0.9 if claim in evidence else 0.1)
        return torch.tensor(scores, dtype=torch.float32)


class CharacterTokenizer:
    def __call__(self, text: str, *, add_special_tokens: bool) -> object:
        token_count = len(text) + (1 if add_special_tokens else 0)
        return {"input_ids": list(range(token_count))}


class RawFakeHhemModel:
    def __init__(self) -> None:
        self.prompt = "Premise: {text1}\nHypothesis: {text2}"
        self.tokenzier = CharacterTokenizer()
        self.received_pairs: tuple[tuple[str, str], ...] = ()

    def predict(self, pairs: list[tuple[str, str]]) -> object:
        self.received_pairs = tuple(pairs)
        return torch.tensor([0.5 for _pair in pairs], dtype=torch.float32)


class HhemServiceTest(unittest.TestCase):
    def test_reads_strict_typed_request(self) -> None:
        request = read_score_request(json.dumps({
            "items": [{
                "id": "claim-7",
                "evidence": "Evidence supports the claim.",
                "claim": "the claim",
            }],
        }).encode())

        self.assertEqual(request.items[0].item_id, "claim-7")

    def test_rejects_user_question_field(self) -> None:
        body = json.dumps({
            "items": [{
                "id": "claim-7",
                "evidence": "Evidence supports the claim.",
                "claim": "the claim",
            }],
            "question": "This must never reach HHEM.",
        }).encode()

        with self.assertRaisesRegex(RequestValidationError, "only items"):
            read_score_request(body)

    def test_rejects_duplicate_item_ids(self) -> None:
        body = json.dumps({
            "items": [
                {"id": "same", "evidence": "One", "claim": "Claim one"},
                {"id": "same", "evidence": "Two", "claim": "Claim two"},
            ],
        }).encode()

        with self.assertRaisesRegex(RequestValidationError, "Duplicate item ID"):
            read_score_request(body)

    def test_plans_bounded_model_batches_and_restores_request_order(self) -> None:
        model = FakeModel()
        scorer = ModelScorer(model, model_batch_size=2, max_padded_tokens=100)
        request = ScoreRequest(items=(
            ScoreItem("third", "Gamma claim", "Gamma claim"),
            ScoreItem("first", "Alpha claim", "Alpha claim"),
            ScoreItem("second", "No support", "Beta claim"),
        ))

        response = scorer.score(request)

        self.assertEqual(len(model.batches), 2)
        self.assertEqual(
            [result.item_id for result in response.results],
            ["third", "first", "second"],
        )
        self.assertAlmostEqual(response.results[0].support_probability, 0.9)
        self.assertAlmostEqual(response.results[2].support_probability, 0.1)

    def test_bounds_quadratic_attention_memory(self) -> None:
        model = FakeModel()
        scorer = ModelScorer(
            model,
            model_batch_size=20,
            max_padded_tokens=20_000,
            max_attention_cells=1_000,
        )
        request = ScoreRequest(items=(
            ScoreItem("first", "A" * 20, "A" * 10),
            ScoreItem("second", "B" * 20, "B" * 10),
        ))

        scorer.score(request)

        self.assertEqual(len(model.batches), 2)

    def test_validates_model_output_once(self) -> None:
        with self.assertRaises(ModelOutputError):
            read_model_scores([0.5], 1)
        with self.assertRaises(ModelOutputError):
            read_model_scores(torch.tensor([[0.5]]), 1)
        with self.assertRaises(ModelOutputError):
            read_model_scores(torch.tensor([float("nan")]), 1)

    def test_rejects_model_context_overflow_without_truncating_evidence(self) -> None:
        raw_model = RawFakeHhemModel()
        model = read_hhem_model(raw_model)
        evidence = "E" * 10_000
        claim = "The required claim"

        token_count = model.count_tokens(evidence, claim)
        self.assertGreater(token_count, MODEL_MAX_INPUT_TOKENS)
        scorer = ModelScorer(model, model_batch_size=20, max_padded_tokens=20_000)
        response = scorer.score(ScoreRequest(items=(
            ScoreItem("oversized", evidence, claim),
        )))
        self.assertEqual(response.results[0].failure, "model-context-capacity")
        self.assertIsNone(response.results[0].support_probability)
        self.assertEqual(raw_model.received_pairs, ())

    @patch("hhem_service.snapshot_download")
    def test_prefers_cached_pinned_snapshot_before_downloading(
        self,
        download_snapshot: MagicMock,
    ) -> None:
        download_snapshot.side_effect = [
            LocalEntryNotFoundError("not cached"),
            "/models/snapshot",
        ]

        snapshot = read_or_download_snapshot(
            cache_directory=Path("/models"),
            repo_id="model-id",
            revision="pinned-revision",
            allow_patterns=("config.json",),
        )

        self.assertEqual(snapshot, "/models/snapshot")
        self.assertEqual(download_snapshot.call_count, 2)
        first_call = download_snapshot.call_args_list[0]
        second_call = download_snapshot.call_args_list[1]
        self.assertTrue(first_call.kwargs["local_files_only"])
        self.assertNotIn("local_files_only", second_call.kwargs)

    def test_http_startup_readiness_invalid_request_and_scoring(self) -> None:
        state = ServiceState()
        server = HhemHttpServer(("127.0.0.1", 0), state)
        server_thread = threading.Thread(target=server.serve_forever, daemon=True)
        server_thread.start()
        port = server.server_address[1]
        try:
            status, body = request_json(port, "GET", "/health/live")
            self.assertEqual(status, 200)
            self.assertEqual(body["status"], "ok")

            status, body = request_json(port, "GET", "/ready")
            self.assertEqual(status, 503)
            self.assertEqual(body["status"], "loading")

            status, body = request_json(
                port,
                "POST",
                "/score",
                {"items": [{"id": "a", "evidence": "A", "claim": "A"}]},
            )
            self.assertEqual(status, 503)
            self.assertIn("not ready", body["error"])

            state.mark_failed()
            status, body = request_json(port, "GET", "/ready")
            self.assertEqual(status, 503)
            self.assertEqual(body["status"], "failed")

            state.mark_ready(ModelScorer(FakeModel(), 20, 20_000))
            status, body = request_json(port, "GET", "/ready")
            self.assertEqual(status, 200)
            self.assertEqual(body, {
                "model": HHEM_MODEL_ID,
                "revision": HHEM_MODEL_REVISION,
                "status": "ready",
            })

            status, body = request_json(
                port,
                "POST",
                "/score",
                {"items": [{
                    "id": "a",
                    "evidence": "A supported claim",
                    "claim": "supported claim",
                }]},
            )
            self.assertEqual(status, 200)
            self.assertEqual(body["results"][0]["id"], "a")
            self.assertAlmostEqual(
                body["results"][0]["supportProbability"],
                0.9,
                places=6,
            )

            status, body = request_json(
                port,
                "POST",
                "/score",
                {"items": "invalid"},
            )
            self.assertEqual(status, 400)
            self.assertIn("array", body["error"])

            status, body = request_json(
                port,
                "POST",
                "/score",
                {"items": [{"id": "a", "evidence": "A", "claim": "A"}]},
                content_type="text/plain",
            )
            self.assertEqual(status, 400)
            self.assertIn("application/json", body["error"])
        finally:
            server.shutdown()
            server.server_close()
            server_thread.join(timeout=5)


def request_json(
    port: int,
    method: str,
    path: str,
    body: object | None = None,
    content_type: str = "application/json",
) -> tuple[int, dict[str, object]]:
    encoded_body = None
    headers: dict[str, str] = {}
    if body is not None:
        encoded_body = json.dumps(body).encode()
        headers["content-type"] = content_type
    connection = HTTPConnection("127.0.0.1", port, timeout=5)
    try:
        connection.request(method, path, body=encoded_body, headers=headers)
        response = connection.getresponse()
        decoded = json.loads(response.read())
        if not isinstance(decoded, dict):
            raise AssertionError("Expected an object response.")
        return response.status, decoded
    finally:
        connection.close()


if __name__ == "__main__":
    unittest.main()
