"""
Speech-to-text transcriber using MLX Whisper (optimized for Apple Silicon)
or OpenAI Whisper API as an alternative backend.
"""
import io
import logging
import numpy as np
import wave
from typing import Optional
from config import (
    WHISPER_MODEL, LANGUAGE, SAMPLE_RATE,
    VAD_ENGINE, VAD_ENERGY_GATE_THRESHOLD, VAD_SPEECH_FRAME_RATIO,
    STT_DEVICE, STT_COMPUTE_TYPE, STT_MODEL_CACHE_DIR,
)
from vad import create_vad
from engines import create_local_engine

logger = logging.getLogger(__name__)


VALID_LOCAL_MODELS = {"tiny", "base", "small", "medium", "large"}
API_MODEL = "whisper-1"


class Transcriber:
    """Real-time speech-to-text transcriber.

    Supports two backends:
    - Local MLX Whisper (default) — runs on Apple Silicon GPU, zero cost
    - OpenAI Whisper API          — cloud-based, requires OPENAI_API_KEY
    """

    def __init__(self,
                 model_size: str = WHISPER_MODEL,
                 language: Optional[str] = LANGUAGE):
        self.model_size = model_size
        self.language = language
        self.use_api = (model_size == API_MODEL)

        if not self.use_api:
            self.engine = create_local_engine(
                model_key=model_size,
                language=language,
                device=STT_DEVICE,
                compute_type=STT_COMPUTE_TYPE,
                cache_dir=STT_MODEL_CACHE_DIR,
            )
            self.model_path = None  # kept for backward compat with anything that reads it
        else:
            self.model_path = None
            self.engine = None
            logger.info("Using OpenAI Whisper API (whisper-1)")
            try:
                import openai as _openai_check  # noqa: F401
            except ImportError:
                logger.error("openai package not installed. Install with: pip install openai")
                raise

        # Pluggable VAD engine
        vad_config = {
            'energy_gate_threshold': VAD_ENERGY_GATE_THRESHOLD,
            'speech_frame_ratio': VAD_SPEECH_FRAME_RATIO,
        }
        self.vad = create_vad(VAD_ENGINE, vad_config)
        logger.info(f"VAD engine: {self.vad.engine_name}")

    # ------------------------------------------------------------------
    # VAD helpers
    # ------------------------------------------------------------------

    def _validate_audio(self, audio: np.ndarray, sample_rate: int) -> Optional[np.ndarray]:
        if audio is None or audio.size == 0:
            return None
        if audio.ndim > 1:
            audio = np.mean(audio, axis=1)
        min_samples = int(sample_rate * 0.5)
        if len(audio) < min_samples:
            return None
        audio = audio.astype(np.float32)
        audio_max = np.abs(audio).max()
        if audio_max < 1e-6:
            return None
        if audio_max > 0:
            audio = audio / audio_max
        if sample_rate != 16000:
            try:
                import librosa
                audio = librosa.resample(audio, orig_sr=sample_rate, target_sr=16000)
            except Exception as e:
                logger.error(f"Resampling error: {e}")
                return None
        if not self.vad.is_speech(audio, 16000):
            return None
        return audio

    # ------------------------------------------------------------------
    # OpenAI Whisper API transcription
    # ------------------------------------------------------------------

    @staticmethod
    def _audio_to_wav_bytes(audio: np.ndarray, sample_rate: int) -> bytes:
        """Convert a float32 numpy array to in-memory WAV bytes."""
        pcm = (audio * 32767).astype(np.int16)
        buf = io.BytesIO()
        with wave.open(buf, 'wb') as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(sample_rate)
            wf.writeframes(pcm.tobytes())
        buf.seek(0)
        return buf.read()

    @staticmethod
    def _load_openai_key() -> str:
        """Return the OpenAI API key from env var or config/api-keys.json."""
        import os, json as _json, pathlib
        key = os.getenv("OPENAI_API_KEY", "")
        if key:
            return key
        # Fall back to project config file (two levels up from transcriber/)
        try:
            cfg_path = pathlib.Path(__file__).parent.parent / "config" / "api-keys.json"
            with open(cfg_path) as f:
                cfg = _json.load(f)
            return cfg.get("keys", {}).get("openai", "")
        except Exception:
            return ""

    def _transcribe_api(self, audio: np.ndarray, sample_rate: int) -> str:
        from openai import OpenAI
        api_key = self._load_openai_key()
        if not api_key:
            logger.error("OpenAI API key not found. Set OPENAI_API_KEY env var or add 'openai' key in config/api-keys.json")
            return ""
        client = OpenAI(api_key=api_key)
        wav_bytes = self._audio_to_wav_bytes(audio, sample_rate)
        audio_file = io.BytesIO(wav_bytes)
        audio_file.name = "audio.wav"
        response = client.audio.transcriptions.create(
            model="whisper-1",
            file=audio_file,
            language=self.language if self.language else None,
        )
        return (response.text or "").strip()

    # ------------------------------------------------------------------
    # Public interface
    # ------------------------------------------------------------------

    def transcribe_audio(self, audio: np.ndarray, sample_rate: int = SAMPLE_RATE) -> str:
        try:
            validated = self._validate_audio(audio, sample_rate)
            if validated is None:
                return ""
            if self.use_api:
                return self._transcribe_api(validated, 16000)
            return self.engine.transcribe(validated)
        except Exception as e:
            logger.error(f"Transcription error: {e}")
            return ""

    def transcribe_chunk(self, audio_chunk: np.ndarray, sample_rate: int = SAMPLE_RATE) -> str:
        return self.transcribe_audio(audio_chunk, sample_rate)
