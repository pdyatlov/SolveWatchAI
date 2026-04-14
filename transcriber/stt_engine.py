"""Abstract contract for local speech-to-text engines.

Concrete implementations live in ``transcriber/engines/``.
Selection happens in ``engines.create_local_engine`` based on ``sys.platform``.

The API-based OpenAI Whisper path is NOT an STTEngine — it stays inline
in ``Transcriber`` because its contract (network, key loading, WAV encoding)
is heterogeneous and forcing it under this interface adds no value.
"""
from abc import ABC, abstractmethod
from typing import Optional
import numpy as np


class STTEngine(ABC):
    """Local STT engine.

    Receives pre-validated audio (16 kHz mono float32, VAD-gated, normalized).
    Returns the recognized text, or an empty string if nothing useful was heard.
    """

    model_key: str  # canonical size: "tiny" | "base" | "small" | "medium" | "large"
    language: Optional[str]  # ISO language code ("en", "ru", ...) or None for auto

    @abstractmethod
    def transcribe(self, audio: np.ndarray) -> str:
        """Transcribe a 16 kHz mono float32 numpy array to text."""
        raise NotImplementedError
