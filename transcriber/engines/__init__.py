"""Engine implementations and platform-aware factory."""
import sys
from typing import Optional

from stt_engine import STTEngine
from .faster_whisper_engine import FasterWhisperEngine


def create_local_engine(
    model_key: str,
    language: Optional[str],
    device: str = "cpu",
    compute_type: Optional[str] = None,
    cache_dir: Optional[str] = None,
) -> STTEngine:
    """Build the right local STT engine for the current platform.

    - darwin   → MLXWhisperEngine (ignores device/compute_type/cache_dir)
    - anything → FasterWhisperEngine (CPU by default, CUDA on opt-in)

    The MLX engine is imported lazily so non-darwin platforms never touch
    ``mlx_whisper``.
    """
    if sys.platform == "darwin":
        from .mlx_whisper_engine import MLXWhisperEngine
        return MLXWhisperEngine(model_key=model_key, language=language)
    return FasterWhisperEngine(
        model_key=model_key,
        language=language,
        device=device,
        compute_type=compute_type,
        cache_dir=cache_dir,
    )


__all__ = ["create_local_engine"]
