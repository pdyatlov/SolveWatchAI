"""MLX Whisper engine — darwin / Apple Silicon only.

Extracted from the original ``Transcriber._transcribe_local``. Behavior
must be preserved exactly so macOS users see no regression.
"""
import logging
import threading
from typing import Optional

import numpy as np

from stt_engine import STTEngine

logger = logging.getLogger(__name__)

# MLX is not fully thread-safe — serialize transcription calls.
_mlx_lock = threading.Lock()

_MODEL_PATHS = {
    "tiny":   "mlx-community/whisper-tiny",
    "base":   "mlx-community/whisper-base-mlx",
    "small":  "mlx-community/whisper-small-mlx",
    "medium": "mlx-community/whisper-medium-mlx",
    "large":  "mlx-community/whisper-large-v3-mlx",
}


class MLXWhisperEngine(STTEngine):
    def __init__(self, model_key: str, language: Optional[str]):
        self.model_key = model_key
        self.language = language
        self.model_path = _MODEL_PATHS.get(
            model_key, f"mlx-community/whisper-{model_key}-mlx"
        )
        logger.info(f"Initializing MLX Whisper with model: {model_key}")
        logger.info(f"Using model path: {self.model_path}")
        logger.info("Using MLX (optimized for Apple Silicon GPU)")
        try:
            import mlx_whisper  # noqa: F401
            logger.info("MLX Whisper imported successfully")
        except ImportError:
            logger.error(
                "mlx-whisper not installed. "
                "Install with: pip install -r transcriber/requirements-mac.txt"
            )
            raise

    def transcribe(self, audio: np.ndarray) -> str:
        from mlx_whisper import transcribe
        with _mlx_lock:
            result = transcribe(
                audio,
                path_or_hf_repo=self.model_path,
                language=self.language if self.language else None,
                verbose=False,
                condition_on_previous_text=False,
            )
        if isinstance(result, dict):
            return result.get("text", "").strip()
        if isinstance(result, str):
            return result.strip()
        return " ".join(
            seg.get("text", "") if isinstance(seg, dict) else str(seg)
            for seg in result
        ).strip()
