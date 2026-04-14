#!/usr/bin/env python
"""Validation tool for Phase 1 STT migration.

Usage:
    python scripts/compare_engines.py <audio.wav>

Runs one audio file through every STT backend currently available on
this machine and prints the transcripts side by side for eyeball
comparison. Backends that cannot run on this platform (e.g. MLX on
Windows, CUDA without GPU) are skipped with a short note.
"""
import os
import sys
import wave
from pathlib import Path
from typing import Optional

import numpy as np

# Make the transcriber package importable.
REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "transcriber"))


def load_wav_float32(path: Path) -> tuple[np.ndarray, int]:
    with wave.open(str(path), "rb") as wf:
        sr = wf.getframerate()
        n_channels = wf.getnchannels()
        n_frames = wf.getnframes()
        pcm = wf.readframes(n_frames)
    audio = np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0
    # Stereo / multichannel WAVs store samples interleaved (L,R,L,R,...).
    # Reshape so the downstream mean-down-to-mono works correctly; without this
    # the audio is interpreted as mono at 2× speed and transcripts are garbage.
    if n_channels > 1:
        audio = audio.reshape(-1, n_channels)
    return audio, sr


def resample_to_16k(audio: np.ndarray, sr: int) -> np.ndarray:
    if sr == 16000:
        return audio
    import librosa
    return librosa.resample(audio, orig_sr=sr, target_sr=16000)


def infer_language(path: Path) -> Optional[str]:
    """Derive ISO language hint from the filename prefix.

    Fixtures follow ``<lang>-<tag>.wav`` (e.g. en-short.wav, ru-short.wav).
    Passing the right language to the engine activates the distil auto-rule
    for en and keeps multilingual small for non-en.
    """
    stem = path.stem.lower()
    if stem.startswith("ru"):
        return "ru"
    if stem.startswith("en"):
        return "en"
    return None


def try_mlx(audio: np.ndarray, language: Optional[str]) -> Optional[str]:
    if sys.platform != "darwin":
        return None
    try:
        from engines.mlx_whisper_engine import MLXWhisperEngine
        engine = MLXWhisperEngine("small", language)
        return engine.transcribe(audio)
    except Exception as e:
        return f"<mlx error: {e}>"


def try_faster_whisper(
    audio: np.ndarray, device: str, language: Optional[str]
) -> Optional[str]:
    try:
        from engines.faster_whisper_engine import FasterWhisperEngine
        engine = FasterWhisperEngine(
            "small", language,
            device=device,
            cache_dir=str(REPO / "transcriber" / "models"),
        )
        return engine.transcribe(audio)
    except Exception as e:
        return f"<faster-whisper-{device} error: {e}>"


def try_openai_api(audio: np.ndarray, language: Optional[str]) -> Optional[str]:
    if not (os.getenv("OPENAI_API_KEY") or _has_openai_key_in_config()):
        return None
    try:
        # Reuse Transcriber's API path so we don't duplicate wav-encoding.
        from transcriber import Transcriber
        t = Transcriber(model_size="whisper-1", language=language)
        return t._transcribe_api(audio, 16000)
    except Exception as e:
        return f"<openai error: {e}>"


def _has_openai_key_in_config() -> bool:
    import json
    try:
        with open(REPO / "config" / "api-keys.json") as f:
            cfg = json.load(f)
        return bool(cfg.get("keys", {}).get("openai"))
    except Exception:
        return False


def main() -> int:
    # Windows consoles often default to a non-UTF-8 codepage (cp1252, cp932, ...),
    # which crashes on the em-dash in our log strings and on any non-ASCII transcript
    # (Russian, accented characters, etc.). Force UTF-8 on both streams.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, OSError):
            pass

    if len(sys.argv) != 2:
        print("Usage: python scripts/compare_engines.py <audio.wav>", file=sys.stderr)
        return 2
    path = Path(sys.argv[1])
    if not path.exists():
        print(f"no such file: {path}", file=sys.stderr)
        return 2

    audio, sr = load_wav_float32(path)
    if audio.ndim > 1:
        audio = np.mean(audio, axis=1)
    audio = resample_to_16k(audio, sr)
    language = infer_language(path)

    print(f"\n=== {path.name} ({len(audio)/16000:.1f}s, language={language}) ===")

    for label, runner in [
        ("mlx",                   lambda: try_mlx(audio, language)),
        ("faster-whisper-cpu",    lambda: try_faster_whisper(audio, "cpu", language)),
        ("faster-whisper-cuda",   lambda: try_faster_whisper(audio, "cuda", language)),
        ("openai-api",            lambda: try_openai_api(audio, language)),
    ]:
        out = runner()
        if out is None:
            print(f"[{label}] (skipped — not available on this machine)")
        else:
            print(f"[{label}] {out}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
