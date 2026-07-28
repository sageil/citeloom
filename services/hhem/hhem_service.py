from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from enum import Enum
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import logging
import math
import os
from pathlib import Path
import signal
import threading
from typing import Protocol, cast
from urllib.parse import urlsplit

from huggingface_hub import snapshot_download
from huggingface_hub.errors import LocalEntryNotFoundError
from safetensors.torch import load_file
import torch
from transformers import AutoConfig, AutoTokenizer, T5ForTokenClassification


HHEM_MODEL_ID = "vectara/hallucination_evaluation_model"
HHEM_MODEL_REVISION = "8e4a2e6e96c708cc76c2344f7e4757df2515292c"
HHEM_FOUNDATION_ID = "google/flan-t5-base"
HHEM_FOUNDATION_REVISION = "7bcac572ce56db69c1ea7c8af255c5d7c9672fc2"
HHEM_DISPLAY_MODEL = f"{HHEM_MODEL_ID}@{HHEM_MODEL_REVISION}"
HHEM_PROMPT = (
    "<pad> Determine if the hypothesis is true given the premise?\n\n"
    "Premise: {text1}\n\n"
    "Hypothesis: {text2}"
)
HHEM_MODEL_WEIGHT_PREFIX = "t5."
HHEM_SHARED_EMBEDDING_KEY = "transformer.shared.weight"
HHEM_ENCODER_EMBEDDING_KEY = "transformer.encoder.embed_tokens.weight"

DEFAULT_HOST = "0.0.0.0"
DEFAULT_PORT = 8080
DEFAULT_MODEL_BATCH_SIZE = 20
DEFAULT_MAX_PADDED_TOKENS = 20_000
DEFAULT_MAX_ATTENTION_CELLS = 20_000_000
MAX_REQUEST_BYTES = 2_000_000
MAX_REQUEST_ITEMS = 64
MAX_ITEM_ID_CHARACTERS = 128
MAX_CLAIM_CHARACTERS = 2_000
MAX_EVIDENCE_CHARACTERS = 800_000
MAX_TOTAL_TEXT_CHARACTERS = 1_000_000
MODEL_MAX_INPUT_TOKENS = 4_096

LOGGER = logging.getLogger("citeloom.hhem")


@dataclass(frozen=True)
class ScoreItem:
    item_id: str
    evidence: str
    claim: str


@dataclass(frozen=True)
class ScoreRequest:
    items: tuple[ScoreItem, ...]


@dataclass(frozen=True)
class ScoreResult:
    item_id: str
    support_probability: float | None
    failure: str | None = None


@dataclass(frozen=True)
class ScoreResponse:
    model: str
    revision: str
    results: tuple[ScoreResult, ...]


class RequestValidationError(ValueError):
    pass


class ModelOutputError(RuntimeError):
    pass


class ServiceUnavailableError(RuntimeError):
    pass


class ServiceStatus(str, Enum):
    FAILED = "failed"
    LOADING = "loading"
    READY = "ready"


class HhemModel(Protocol):
    def count_tokens(self, evidence: str, claim: str) -> int:
        ...

    def predict(self, pairs: Sequence[tuple[str, str]]) -> object:
        ...


class HhemModelAdapter:
    def __init__(
        self,
        predict: Callable[[Sequence[tuple[str, str]]], object],
        count_tokens: Callable[[str, str], int],
    ) -> None:
        self._predict = predict
        self._count_tokens = count_tokens

    def count_tokens(self, evidence: str, claim: str) -> int:
        return self._count_tokens(evidence, claim)

    def predict(self, pairs: Sequence[tuple[str, str]]) -> object:
        return self._predict(pairs)


class ModelScorer:
    def __init__(
        self,
        model: HhemModel,
        model_batch_size: int,
        max_padded_tokens: int,
        max_attention_cells: int = DEFAULT_MAX_ATTENTION_CELLS,
    ) -> None:
        if model_batch_size < 1:
            raise ValueError("Model batch size must be positive.")
        if max_padded_tokens < 1:
            raise ValueError("Maximum padded tokens must be positive.")
        if max_attention_cells < 1:
            raise ValueError("Maximum attention cells must be positive.")
        self._model = model
        self._model_batch_size = model_batch_size
        self._max_padded_tokens = max_padded_tokens
        self._max_attention_cells = max_attention_cells
        self._model_lock = threading.Lock()

    def score(self, request: ScoreRequest) -> ScoreResponse:
        scorable_items: list[ScoreItem] = []
        capacity_failure_ids: set[str] = set()
        for item in request.items:
            token_count = self._model.count_tokens(item.evidence, item.claim)
            if token_count > MODEL_MAX_INPUT_TOKENS:
                capacity_failure_ids.add(item.item_id)
                continue
            scorable_items.append(item)
        planned_batches = self._plan_batches(scorable_items)
        probability_by_id: dict[str, float] = {}
        with self._model_lock:
            for batch in planned_batches:
                pairs: list[tuple[str, str]] = []
                for item in batch:
                    pairs.append((item.evidence, item.claim))
                raw_scores = self._model.predict(pairs)
                scores = read_model_scores(raw_scores, len(batch))
                for item, score in zip(batch, scores, strict=True):
                    probability_by_id[item.item_id] = score

        results: list[ScoreResult] = []
        for item in request.items:
            if item.item_id in capacity_failure_ids:
                results.append(ScoreResult(
                    item_id=item.item_id,
                    support_probability=None,
                    failure="model-context-capacity",
                ))
                continue
            support_probability = probability_by_id[item.item_id]
            results.append(ScoreResult(
                item_id=item.item_id,
                support_probability=support_probability,
            ))
        return ScoreResponse(
            model=HHEM_MODEL_ID,
            revision=HHEM_MODEL_REVISION,
            results=tuple(results),
        )

    def _plan_batches(
        self,
        items: Sequence[ScoreItem],
    ) -> tuple[tuple[ScoreItem, ...], ...]:
        measured_items: list[tuple[ScoreItem, int]] = []
        for item in items:
            token_count = self._model.count_tokens(item.evidence, item.claim)
            if token_count < 1 or token_count > MODEL_MAX_INPUT_TOKENS:
                raise RequestValidationError(
                    f"Item {item.item_id!r} has {token_count} model input tokens; "
                    f"the supported range is 1 to {MODEL_MAX_INPUT_TOKENS}."
                )
            measured_items.append((item, token_count))

        if measured_items:
            LOGGER.info(
                "Planning HHEM request with %d items and %d to %d input tokens.",
                len(measured_items),
                min(token_count for _item, token_count in measured_items),
                max(token_count for _item, token_count in measured_items),
            )
        measured_items.sort(key=lambda value: (value[1], value[0].item_id))
        batches: list[tuple[ScoreItem, ...]] = []
        current_items: list[ScoreItem] = []
        current_max_tokens = 0
        for item, token_count in measured_items:
            candidate_size = len(current_items) + 1
            candidate_max_tokens = max(current_max_tokens, token_count)
            candidate_padded_tokens = candidate_size * candidate_max_tokens
            candidate_attention_cells = (
                candidate_size * candidate_max_tokens * candidate_max_tokens
            )
            exceeds_item_limit = candidate_size > self._model_batch_size
            exceeds_token_limit = candidate_padded_tokens > self._max_padded_tokens
            exceeds_attention_limit = (
                candidate_attention_cells > self._max_attention_cells
            )
            if not current_items and (
                exceeds_token_limit or exceeds_attention_limit
            ):
                raise RequestValidationError(
                    f"Item {item.item_id!r} exceeds the configured model memory budget."
                )
            if current_items and (
                exceeds_item_limit
                or exceeds_token_limit
                or exceeds_attention_limit
            ):
                batches.append(tuple(current_items))
                current_items = []
                current_max_tokens = 0
            current_items.append(item)
            current_max_tokens = max(current_max_tokens, token_count)
        if current_items:
            batches.append(tuple(current_items))
        return tuple(batches)


class ServiceState:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._scorer: ModelScorer | None = None
        self._status = ServiceStatus.LOADING

    def mark_failed(self) -> None:
        with self._lock:
            self._scorer = None
            self._status = ServiceStatus.FAILED

    def mark_ready(self, scorer: ModelScorer) -> None:
        with self._lock:
            self._scorer = scorer
            self._status = ServiceStatus.READY

    def read_status(self) -> ServiceStatus:
        with self._lock:
            return self._status

    def require_scorer(self) -> ModelScorer:
        with self._lock:
            if self._status is not ServiceStatus.READY or self._scorer is None:
                raise ServiceUnavailableError(
                    f"HHEM is not ready; current status is {self._status.value}."
                )
            return self._scorer


class HhemHttpServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(
        self,
        server_address: tuple[str, int],
        state: ServiceState,
    ) -> None:
        self.state = state
        super().__init__(server_address, HhemRequestHandler)


class HhemRequestHandler(BaseHTTPRequestHandler):
    server: HhemHttpServer

    def do_GET(self) -> None:
        path = urlsplit(self.path).path
        if path == "/health/live":
            self._write_json(200, encode_status_response("ok"))
            return
        if path == "/ready":
            status = self.server.state.read_status()
            status_code = 200 if status is ServiceStatus.READY else 503
            self._write_json(status_code, encode_status_response(status.value))
            return
        self._write_json(404, encode_error_response("Not found."))

    def do_POST(self) -> None:
        path = urlsplit(self.path).path
        if path != "/score":
            self._write_json(404, encode_error_response("Not found."))
            return
        try:
            request = self._read_score_request()
            scorer = self.server.state.require_scorer()
            response = scorer.score(request)
            self._write_json(200, encode_score_response(response))
        except RequestValidationError as error:
            self._write_json(400, encode_error_response(str(error)))
        except ServiceUnavailableError as error:
            self._write_json(503, encode_error_response(str(error)))
        except ModelOutputError:
            LOGGER.exception("HHEM returned an invalid model output.")
            self._write_json(500, encode_error_response("HHEM scoring failed."))
        except Exception:
            LOGGER.exception("Unexpected HHEM scoring failure.")
            self._write_json(500, encode_error_response("HHEM scoring failed."))

    def log_message(self, message_format: str, *args: object) -> None:
        LOGGER.info(
            "%s - %s",
            self.client_address[0],
            message_format % args,
        )

    def _read_score_request(self) -> ScoreRequest:
        read_content_type(self.headers.get("content-type"))
        content_length = read_content_length(self.headers.get("content-length"))
        body = self.rfile.read(content_length)
        if len(body) != content_length:
            raise RequestValidationError("The HTTP request body was incomplete.")
        return read_score_request(body)

    def _write_json(self, status_code: int, body: bytes) -> None:
        self.send_response(status_code)
        self.send_header("content-length", str(len(body)))
        self.send_header("content-type", "application/json; charset=utf-8")
        self.end_headers()
        self.wfile.write(body)


def read_content_length(value: str | None) -> int:
    if value is None:
        raise RequestValidationError("Content-Length is required.")
    try:
        content_length = int(value)
    except ValueError as error:
        raise RequestValidationError("Content-Length must be an integer.") from error
    if content_length < 1 or content_length > MAX_REQUEST_BYTES:
        raise RequestValidationError(
            f"Content-Length must be between 1 and {MAX_REQUEST_BYTES} bytes."
        )
    return content_length


def read_content_type(value: str | None) -> None:
    if value is None:
        raise RequestValidationError("Content-Type is required.")
    media_type = value.split(";", maxsplit=1)[0].strip().lower()
    if media_type != "application/json":
        raise RequestValidationError("Content-Type must be application/json.")


def read_score_request(body: bytes) -> ScoreRequest:
    try:
        raw_request: object = json.loads(body)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise RequestValidationError("The request body must be valid JSON.") from error
    if not isinstance(raw_request, dict):
        raise RequestValidationError("The request body must be an object.")
    if set(raw_request) != {"items"}:
        raise RequestValidationError("The request body must contain only items.")
    raw_items = raw_request["items"]
    if not isinstance(raw_items, list):
        raise RequestValidationError("items must be an array.")
    if len(raw_items) < 1 or len(raw_items) > MAX_REQUEST_ITEMS:
        raise RequestValidationError(
            f"items must contain between 1 and {MAX_REQUEST_ITEMS} entries."
        )

    seen_ids: set[str] = set()
    total_text_characters = 0
    items: list[ScoreItem] = []
    for index, raw_item in enumerate(raw_items):
        item = read_score_item(raw_item, index)
        if item.item_id in seen_ids:
            raise RequestValidationError(f"Duplicate item ID: {item.item_id!r}.")
        seen_ids.add(item.item_id)
        total_text_characters += len(item.evidence) + len(item.claim)
        if total_text_characters > MAX_TOTAL_TEXT_CHARACTERS:
            raise RequestValidationError(
                "The total evidence and claim text exceeds the request limit."
            )
        items.append(item)
    return ScoreRequest(items=tuple(items))


def read_score_item(raw_item: object, index: int) -> ScoreItem:
    if not isinstance(raw_item, dict):
        raise RequestValidationError(f"items[{index}] must be an object.")
    if set(raw_item) != {"id", "evidence", "claim"}:
        raise RequestValidationError(
            f"items[{index}] must contain only id, evidence, and claim."
        )
    item_id = read_required_string(
        raw_item["id"],
        f"items[{index}].id",
        MAX_ITEM_ID_CHARACTERS,
    )
    evidence = read_required_string(
        raw_item["evidence"],
        f"items[{index}].evidence",
        MAX_EVIDENCE_CHARACTERS,
    )
    claim = read_required_string(
        raw_item["claim"],
        f"items[{index}].claim",
        MAX_CLAIM_CHARACTERS,
    )
    return ScoreItem(item_id=item_id, evidence=evidence, claim=claim)


def read_required_string(value: object, name: str, maximum_length: int) -> str:
    if not isinstance(value, str):
        raise RequestValidationError(f"{name} must be a string.")
    if not value.strip():
        raise RequestValidationError(f"{name} must not be blank.")
    if len(value) > maximum_length:
        raise RequestValidationError(
            f"{name} must not exceed {maximum_length} characters."
        )
    return value


def read_model_scores(raw_scores: object, expected_count: int) -> tuple[float, ...]:
    if not isinstance(raw_scores, torch.Tensor):
        raise ModelOutputError("HHEM predict must return a tensor.")
    if raw_scores.ndim != 1 or raw_scores.shape[0] != expected_count:
        raise ModelOutputError(
            f"HHEM returned shape {tuple(raw_scores.shape)} for {expected_count} items."
        )
    score_values = raw_scores.detach().to(device="cpu", dtype=torch.float32).tolist()
    scores: list[float] = []
    for index, value in enumerate(score_values):
        if not isinstance(value, float) or not math.isfinite(value):
            raise ModelOutputError(f"HHEM score {index} is not finite.")
        if value < 0 or value > 1:
            raise ModelOutputError(f"HHEM score {index} is outside [0, 1].")
        scores.append(value)
    return tuple(scores)


def encode_score_response(response: ScoreResponse) -> bytes:
    results: list[dict[str, object]] = []
    for result in response.results:
        if result.failure is not None:
            results.append({
                "id": result.item_id,
                "outcome": result.failure,
            })
            continue
        results.append({
            "id": result.item_id,
            "outcome": "scored",
            "supportProbability": result.support_probability,
        })
    body = {
        "model": response.model,
        "revision": response.revision,
        "results": results,
    }
    return encode_json(body)


def encode_status_response(status: str) -> bytes:
    return encode_json({
        "model": HHEM_MODEL_ID,
        "revision": HHEM_MODEL_REVISION,
        "status": status,
    })


def encode_error_response(message: str) -> bytes:
    return encode_json({"error": message})


def encode_json(value: object) -> bytes:
    return json.dumps(value, separators=(",", ":")).encode("utf-8")


def read_positive_integer_environment(
    name: str,
    default_value: int,
    maximum_value: int,
) -> int:
    raw_value = os.environ.get(name)
    if raw_value is None:
        return default_value
    try:
        value = int(raw_value)
    except ValueError as error:
        raise ValueError(f"{name} must be an integer.") from error
    if value < 1 or value > maximum_value:
        raise ValueError(f"{name} must be between 1 and {maximum_value}.")
    return value


def read_hhem_model(raw_model: object) -> HhemModelAdapter:
    predict = getattr(raw_model, "predict", None)
    tokenizer = getattr(raw_model, "tokenzier", None)
    prompt = getattr(raw_model, "prompt", None)
    if not callable(predict):
        raise RuntimeError("The pinned HHEM model does not expose predict().")
    if not callable(tokenizer):
        raise RuntimeError("The pinned HHEM model does not expose its tokenizer.")
    if not isinstance(prompt, str) or not prompt:
        raise RuntimeError("The pinned HHEM model does not expose its prompt.")

    return create_hhem_model_adapter(
        predict=cast(Callable[[Sequence[tuple[str, str]]], object], predict),
        tokenizer=tokenizer,
        prompt=prompt,
    )


def create_hhem_model_adapter(
    predict: Callable[[Sequence[tuple[str, str]]], object],
    tokenizer: Callable[..., object],
    prompt: str,
) -> HhemModelAdapter:
    def count_tokens(evidence: str, claim: str) -> int:
        return count_model_input_tokens(tokenizer, prompt, evidence, claim)

    def predict_bounded_pairs(
        pairs: Sequence[tuple[str, str]],
    ) -> object:
        validated_pairs: list[tuple[str, str]] = []
        for evidence, claim in pairs:
            token_count = count_model_input_tokens(
                tokenizer,
                prompt,
                evidence,
                claim,
            )
            if token_count > MODEL_MAX_INPUT_TOKENS:
                raise RequestValidationError(
                    f"HHEM input has {token_count} model input tokens; "
                    f"the supported maximum is {MODEL_MAX_INPUT_TOKENS}."
                )
            validated_pairs.append((evidence, claim))
        return predict(validated_pairs)

    return HhemModelAdapter(
        predict=predict_bounded_pairs,
        count_tokens=count_tokens,
    )


def count_model_input_tokens(
    tokenizer: Callable[..., object],
    prompt: str,
    evidence: str,
    claim: str,
) -> int:
    full_text = prompt.format(text1=evidence, text2=claim)
    return read_model_input_token_count(
        tokenizer(full_text, add_special_tokens=True)
    )


def read_model_input_token_count(tokenized: object) -> int:
    if not isinstance(tokenized, Mapping):
        raise RuntimeError("The HHEM tokenizer returned an invalid result.")
    input_ids = tokenized.get("input_ids")
    if isinstance(input_ids, (str, bytes)) or not isinstance(input_ids, Sequence):
        raise RuntimeError("The HHEM tokenizer omitted input_ids.")
    return len(input_ids)


def load_hhem_model(cache_directory: Path) -> HhemModelAdapter:
    cache_directory.mkdir(parents=True, exist_ok=True)
    model_snapshot = read_or_download_snapshot(
        cache_directory,
        repo_id=HHEM_MODEL_ID,
        revision=HHEM_MODEL_REVISION,
        allow_patterns=("model.safetensors",),
    )
    foundation_snapshot = read_or_download_snapshot(
        cache_directory,
        repo_id=HHEM_FOUNDATION_ID,
        revision=HHEM_FOUNDATION_REVISION,
        allow_patterns=(
            "config.json",
            "special_tokens_map.json",
            "spiece.model",
            "tokenizer.json",
            "tokenizer_config.json",
        ),
    )
    foundation_config = AutoConfig.from_pretrained(
        foundation_snapshot,
        local_files_only=True,
    )
    raw_model = T5ForTokenClassification(foundation_config)
    state = read_hhem_model_state(
        Path(model_snapshot) / "model.safetensors",
    )
    raw_model.load_state_dict(state, strict=True)
    raw_model.eval()
    tokenizer = AutoTokenizer.from_pretrained(
        foundation_snapshot,
        local_files_only=True,
    )

    def predict(pairs: Sequence[tuple[str, str]]) -> object:
        prompts: list[str] = []
        for evidence, claim in pairs:
            prompts.append(HHEM_PROMPT.format(text1=evidence, text2=claim))
        raw_inputs = tokenizer(prompts, return_tensors="pt", padding=True)
        model_inputs = read_model_inputs(raw_inputs, raw_model.device)
        with torch.no_grad():
            outputs = raw_model(**model_inputs)
        logits = outputs.logits[:, 0, :]
        return torch.softmax(logits, dim=-1)[:, 1]

    return create_hhem_model_adapter(
        predict=predict,
        tokenizer=tokenizer,
        prompt=HHEM_PROMPT,
    )


def read_hhem_model_state(model_path: Path) -> dict[str, torch.Tensor]:
    raw_state = load_file(model_path, device="cpu")
    state: dict[str, torch.Tensor] = {}
    for raw_key, value in raw_state.items():
        if not raw_key.startswith(HHEM_MODEL_WEIGHT_PREFIX):
            raise RuntimeError(
                f"The pinned HHEM checkpoint has an unexpected key: {raw_key}."
            )
        key = raw_key.removeprefix(HHEM_MODEL_WEIGHT_PREFIX)
        if not key or key in state:
            raise RuntimeError(
                f"The pinned HHEM checkpoint has an invalid key: {raw_key}."
            )
        if not isinstance(value, torch.Tensor):
            raise RuntimeError(
                f"The pinned HHEM checkpoint has invalid weights for {raw_key}."
            )
        state[key] = value

    shared_embedding = state.get(HHEM_SHARED_EMBEDDING_KEY)
    if not isinstance(shared_embedding, torch.Tensor):
        raise RuntimeError(
            "The pinned HHEM checkpoint omits its shared embedding weights."
        )
    state[HHEM_ENCODER_EMBEDDING_KEY] = shared_embedding
    return state


def read_model_inputs(
    raw_inputs: object,
    device: torch.device,
) -> dict[str, torch.Tensor]:
    if not isinstance(raw_inputs, Mapping):
        raise RuntimeError("The HHEM tokenizer returned invalid model inputs.")
    model_inputs: dict[str, torch.Tensor] = {}
    for raw_key, raw_value in raw_inputs.items():
        if not isinstance(raw_key, str) or not isinstance(raw_value, torch.Tensor):
            raise RuntimeError("The HHEM tokenizer returned invalid model inputs.")
        model_inputs[raw_key] = raw_value.to(device)
    if "input_ids" not in model_inputs:
        raise RuntimeError("The HHEM tokenizer omitted input_ids.")
    return model_inputs


def read_or_download_snapshot(
    cache_directory: Path,
    repo_id: str,
    revision: str,
    allow_patterns: tuple[str, ...],
) -> str:
    try:
        return snapshot_download(
            allow_patterns=allow_patterns,
            cache_dir=cache_directory,
            local_files_only=True,
            repo_id=repo_id,
            revision=revision,
        )
    except LocalEntryNotFoundError:
        return snapshot_download(
            allow_patterns=allow_patterns,
            cache_dir=cache_directory,
            repo_id=repo_id,
            revision=revision,
        )


def load_scorer(state: ServiceState, cache_directory: Path) -> None:
    try:
        model_batch_size = read_positive_integer_environment(
            "HHEM_MODEL_BATCH_SIZE",
            DEFAULT_MODEL_BATCH_SIZE,
            MAX_REQUEST_ITEMS,
        )
        max_padded_tokens = read_positive_integer_environment(
            "HHEM_MAX_PADDED_TOKENS",
            DEFAULT_MAX_PADDED_TOKENS,
            1_000_000,
        )
        max_attention_cells = read_positive_integer_environment(
            "HHEM_MAX_ATTENTION_CELLS",
            DEFAULT_MAX_ATTENTION_CELLS,
            100_000_000,
        )
        model = load_hhem_model(cache_directory)
        scorer = ModelScorer(
            model,
            model_batch_size,
            max_padded_tokens,
            max_attention_cells,
        )
        state.mark_ready(scorer)
        LOGGER.info("Loaded %s on CPU.", HHEM_DISPLAY_MODEL)
    except Exception:
        state.mark_failed()
        LOGGER.exception("Failed to load %s.", HHEM_DISPLAY_MODEL)


def start_model_loader(state: ServiceState, cache_directory: Path) -> threading.Thread:
    loader = threading.Thread(
        name="hhem-model-loader",
        target=load_scorer,
        args=(state, cache_directory),
        daemon=True,
    )
    loader.start()
    return loader


def main() -> None:
    logging.basicConfig(
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
        level=logging.INFO,
    )
    host = os.environ.get("HHEM_HOST", DEFAULT_HOST)
    port = read_positive_integer_environment("HHEM_PORT", DEFAULT_PORT, 65_535)
    cache_directory = Path(os.environ.get("HHEM_CACHE_DIR", "/models/huggingface"))
    torch_threads = read_positive_integer_environment(
        "HHEM_TORCH_THREADS",
        max(1, min(4, os.cpu_count() or 1)),
        256,
    )
    torch.set_num_threads(torch_threads)

    state = ServiceState()
    server = HhemHttpServer((host, port), state)
    start_model_loader(state, cache_directory)

    def stop_server(_signal_number: int, _frame: object) -> None:
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGINT, stop_server)
    signal.signal(signal.SIGTERM, stop_server)
    LOGGER.info("HHEM HTTP service listening on %s:%d.", host, port)
    try:
        server.serve_forever(poll_interval=0.5)
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
