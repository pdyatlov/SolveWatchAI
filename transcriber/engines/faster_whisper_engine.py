"""faster-whisper engine — cross-platform STT via CTranslate2.

Default backend on Windows and Linux. Also works on macOS but slower
than MLX, so the factory does not pick it on darwin.
"""
import logging
import threading
from typing import Optional

import numpy as np

from stt_engine import STTEngine

logger = logging.getLogger(__name__)

# Default HuggingFace repo for each canonical model size.
# Distil-small.en is introduced in Task 7 via ``resolve_repo``.
MODEL_MAP = {
    "tiny":             "Systran/faster-whisper-tiny",
    "base":             "Systran/faster-whisper-base",
    "small":            "Systran/faster-whisper-small",
    "medium":           "Systran/faster-whisper-medium",
    "large":            "Systran/faster-whisper-large-v3",
    # POLISH-03 dial 3 — CT2-converted distil-large-v3 hosted by Systran.
    # NOTE: RESEARCH §Pitfall 7 originally specified `distil-whisper/distil-large-v3`,
    # but that namespace publishes only the PyTorch transformers format (no model.bin).
    # faster-whisper / CTranslate2 requires the CT2-converted variant — Systran hosts
    # the canonical conversion at `Systran/faster-distil-whisper-large-v3`. Verified
    # at runtime against the POLISH-03 fixture; the distil-whisper/ path raised
    # "Unable to open file 'model.bin'" before this correction.
    # 756M params, English-only, ~0.8 GB, within ~1% WER of large-v3.
    "distil-large-v3":  "Systran/faster-distil-whisper-large-v3",
}


def resolve_repo(model_key: str, language: Optional[str]) -> str:
    """Map (model_key, language) to a HuggingFace repo id.

    Distil auto-rule: the default size "small" + English triggers
    ``distil-small.en`` — roughly 2× faster and 3× smaller than plain
    ``small`` on CPU, at the cost of English-only support.

    The rule applies ONLY to model_key == "small": no distil-medium or
    distil-large variant of production quality exists. Users who
    explicitly pick "medium"/"large" keep the multilingual path.
    """
    if model_key == "small" and language == "en":
        return "Systran/faster-distil-whisper-small.en"
    if model_key not in MODEL_MAP:
        raise ValueError(
            f"Unknown model_key: {model_key!r}. "
            f"Expected one of: {sorted(MODEL_MAP)}"
        )
    return MODEL_MAP[model_key]


def _auto_compute_type(device: str) -> str:
    """Pick a sensible compute_type when the user leaves it unset."""
    if device == "cuda":
        return "float16"
    return "int8"  # fast on modern CPUs, minimal quality loss


class FasterWhisperEngine(STTEngine):
    def __init__(
        self,
        model_key: str,
        language: Optional[str],
        device: str = "cpu",
        compute_type: Optional[str] = None,
        cache_dir: Optional[str] = None,
    ):
        self.model_key = model_key
        self.language = language
        self.device = device
        self.compute_type = compute_type or _auto_compute_type(device)
        self._lock = threading.Lock()

        repo = resolve_repo(model_key, language)
        logger.info(
            f"Initializing faster-whisper: repo={repo} "
            f"device={self.device} compute_type={self.compute_type} "
            f"cache_dir={cache_dir}"
        )

        from faster_whisper import WhisperModel
        self._model = WhisperModel(
            repo,
            device=self.device,
            compute_type=self.compute_type,
            download_root=cache_dir,
        )
        logger.info("faster-whisper model loaded")

    def transcribe(self, audio: np.ndarray) -> str:
        with self._lock:
            # beam_size=5 is the faster-whisper default; keep explicit for clarity.
            segments, _info = self._model.transcribe(
                audio,
                language=self.language if self.language else None,
                beam_size=5,
                condition_on_previous_text=False,
                vad_filter=False,  # we already did VAD upstream
            )
            return " ".join(seg.text for seg in segments).strip()


if __name__ == "__main__":
    # Pure-function smoke tests for resolve_repo.
    # Distil auto-rule: small + en → distil-small.en
    assert resolve_repo("small", "en") == "Systran/faster-distil-whisper-small.en"
    # Any other language keeps plain multilingual small.
    assert resolve_repo("small", "ru") == "Systran/faster-whisper-small"
    assert resolve_repo("small", None) == "Systran/faster-whisper-small"
    # Other sizes never get the distil variant, even with en.
    assert resolve_repo("tiny", "en")  == "Systran/faster-whisper-tiny"
    assert resolve_repo("base", "en")  == "Systran/faster-whisper-base"
    assert resolve_repo("medium", "en")== "Systran/faster-whisper-medium"
    assert resolve_repo("large", "en") == "Systran/faster-whisper-large-v3"
    assert resolve_repo("large", None) == "Systran/faster-whisper-large-v3"
    # POLISH-03 dial 3 assertions (CT2-converted variant hosted by Systran — see MODEL_MAP comment)
    assert resolve_repo("distil-large-v3", "en")   == "Systran/faster-distil-whisper-large-v3"
    assert resolve_repo("distil-large-v3", None)   == "Systran/faster-distil-whisper-large-v3"
    try:
        resolve_repo("bogus", "en")
    except ValueError as e:
        assert "bogus" in str(e)
    else:
        raise AssertionError("expected ValueError for unknown model_key")
    print("resolve_repo smoke tests passed")
