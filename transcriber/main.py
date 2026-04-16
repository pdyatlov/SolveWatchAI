"""
FastAPI server for real-time speech-to-text transcription
"""
import asyncio
import json
import logging
import os
import threading
import time
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
import numpy as np

from audio_recorder import AudioRecorder
from transcriber import Transcriber
from socket_client import SocketClient
from keyboard_handler import KeyboardHandler
from always_on_listener import AlwaysOnListener
from audio_sources import resolve_audio_sources
import log_writer
from config import SAMPLE_RATE, API_HOST, API_PORT, LOG_LEVEL, TRANSCRIPTIONS_JSON_FILE, KEYBOARD_ENABLED, ALWAYS_ON_ENABLED

# Configure logging
logging.basicConfig(
    level=getattr(logging, LOG_LEVEL),
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# NDJSON async writer (O(1) appends — no full-file reads)
# ---------------------------------------------------------------------------
_transcription_queue: deque = deque()
_json_writer_thread: Optional[threading.Thread] = None
_json_writer_running: bool = False
_json_writer_lock = threading.Lock()


def json_writer_worker():
    """Background thread that appends transcriptions to an NDJSON file.

    Each line in the file is a self-contained JSON object (newline-delimited
    JSON). This avoids reading + rewriting the whole file on every flush,
    keeping write cost O(1) regardless of history size.
    """
    global _transcription_queue, _json_writer_running

    while _json_writer_running:
        try:
            if not _transcription_queue:
                threading.Event().wait(0.1)
                continue

            batch = []
            while _transcription_queue:
                batch.append(_transcription_queue.popleft())

            if not batch:
                continue

            with _json_writer_lock:
                with open(TRANSCRIPTIONS_JSON_FILE, 'a', encoding='utf-8') as f:
                    for entry in batch:
                        f.write(json.dumps(entry, ensure_ascii=False) + '\n')

            logger.debug(f"Appended {len(batch)} transcription(s) to {TRANSCRIPTIONS_JSON_FILE}")

        except Exception as e:
            logger.error(f"Error in JSON writer worker: {e}")


def append_transcription_to_json(text: str):
    """Queue a transcription entry for async NDJSON file writing (non-blocking)."""
    if not text or not text.strip():
        return
    _transcription_queue.append({
        "text": text.strip(),
        "timestamp": datetime.now().isoformat(),
        "unix_timestamp": datetime.now().timestamp(),
    })


# ---------------------------------------------------------------------------
# Lifespan
# ---------------------------------------------------------------------------
@asynccontextmanager
async def lifespan(app: FastAPI):
    global transcriber, socket_client, keyboard_handler
    global always_on_listener_them, always_on_listener_me
    global _json_writer_thread, _json_writer_running, _transcription_executor

    logger.info("Initializing STT system components...")

    # Start the shared JSON log writer (writes to logs/app.jsonl)
    log_writer.start()

    try:
        # POLISH-03 dial 3: per-channel STT model override.
        # Them-channel (interviewer loopback) may use a heavier model (e.g. distil-large-v3)
        # while the me-channel stays on the lighter global default. Env override is the
        # minimal change — no UI surface, no config migration. Unset → falls back to WHISPER_MODEL.
        them_model = os.environ.get('STT_MODEL_THEM') or None
        if them_model:
            transcriber = Transcriber(model_size=them_model)
            logger.info(f"Transcriber initialized (them-channel override: model={them_model})")
        else:
            transcriber = Transcriber()
            logger.info("Transcriber initialized (them-channel: default model)")
        log_writer.log('transcriber_initialized', model=transcriber.model_size, use_api=transcriber.use_api)

        # MLX is protected by an internal lock in transcriber.py — one worker
        # handles preprocessing concurrently while the other waits for the GPU.
        _transcription_executor = ThreadPoolExecutor(
            max_workers=2,
            thread_name_prefix="transcribe",
        )
        logger.info("Transcription thread pool initialized (max_workers=2)")

        socket_client = SocketClient()
        try:
            socket_client.connect()
            logger.info("Socket.IO client connecting (background retry enabled)")
        except Exception as e:
            logger.warning(f"Could not connect to Socket.IO server: {e}")
            logger.warning("Background reconnect is active")

        _json_writer_running = True
        _json_writer_thread = threading.Thread(target=json_writer_worker, daemon=True)
        _json_writer_thread.start()
        logger.info("JSON writer thread started (NDJSON mode)")

        try:
            sources = resolve_audio_sources()
            them_idx, them_name, them_mode = sources['loopback']
            me_idx, me_name = sources['mic']

            # Second Transcriber instance so the mic and loopback streams
            # can transcribe in parallel without serializing on one model.
            try:
                transcriber_me = Transcriber()
                logger.info("Second Transcriber (for 'me' channel) initialized")
            except Exception as e:
                logger.warning(f"Could not initialize second Transcriber: {e}")
                transcriber_me = None

            if them_idx is not None:
                always_on_listener_them = AlwaysOnListener(
                    transcriber, socket_client,
                    device_index=them_idx, source_label='them',
                    wasapi_loopback=(them_mode == 'wasapi_output'),
                )
                logger.info(
                    f"Always-on listener (them) ready on device {them_idx}: {them_name} "
                    f"[mode={them_mode}]"
                )
            else:
                logger.warning("No loopback device resolved — 'them' channel disabled")
                always_on_listener_them = None

            if me_idx is not None and transcriber_me is not None:
                always_on_listener_me = AlwaysOnListener(
                    transcriber_me, socket_client,
                    device_index=me_idx, source_label='me',
                )
                logger.info(f"Always-on listener (me) ready on device {me_idx}: {me_name}")
            else:
                logger.warning("No mic device resolved or second Transcriber unavailable — 'me' channel disabled")
                always_on_listener_me = None
        except Exception as e:
            logger.warning(f"Could not initialize always-on listeners: {e}")
            always_on_listener_them = None
            always_on_listener_me = None

        if KEYBOARD_ENABLED:
            try:
                def toggle_always_on_keyboard():
                    listeners = [l for l in (always_on_listener_them, always_on_listener_me) if l is not None]
                    if not listeners:
                        return
                    # Determine current state from whichever listener exists.
                    any_running = any(l._running for l in listeners)
                    if any_running:
                        for l in listeners:
                            if l._running:
                                l.stop()
                        log_writer.log('listen_stopped', source='keyboard')
                        if socket_client and socket_client.is_connected():
                            socket_client.send_listen_state(False)
                    else:
                        for l in listeners:
                            l.start()
                        log_writer.log('listen_started', source='keyboard')
                        if socket_client and socket_client.is_connected():
                            socket_client.send_listen_state(True)

                keyboard_handler = KeyboardHandler(
                    on_key_press=toggle_always_on_keyboard,
                    on_key_release=lambda: None,
                )
                keyboard_handler.start()
                logger.info("Keyboard handler started (toggle always-on mode)")
            except Exception as e:
                logger.warning(f"Could not start keyboard handler: {e}")
                keyboard_handler = None
        else:
            logger.info("Keyboard handler disabled in configuration")

        logger.info("STT system ready")

    except Exception as e:
        logger.error(f"Failed to initialize STT system: {e}")
        raise

    yield

    # Shutdown
    global recorder, is_recording, _audio_buffer

    logger.info("Shutting down STT system...")

    for l in (always_on_listener_them, always_on_listener_me):
        if l:
            l.stop()

    if keyboard_handler:
        keyboard_handler.stop()

    if is_recording:
        stop_recording_internal_sync()

    if _transcription_executor:
        logger.info("Shutting down transcription thread pool...")
        _transcription_executor.shutdown(wait=True)
        _transcription_executor = None

    _json_writer_running = False
    if _json_writer_thread and _json_writer_thread.is_alive():
        _json_writer_thread.join(timeout=2.0)

    if socket_client:
        socket_client.disconnect()

    log_writer.log('transcriber_shutdown')
    log_writer.stop()
    logger.info("STT system shut down")


# ---------------------------------------------------------------------------
# App & global state
# ---------------------------------------------------------------------------
app = FastAPI(title="Real-time Speech-to-Text Transcription", lifespan=lifespan)

recorder: Optional[AudioRecorder] = None
transcriber: Optional[Transcriber] = None
socket_client: Optional[SocketClient] = None
recording_thread: Optional[threading.Thread] = None
keyboard_handler: Optional[KeyboardHandler] = None
always_on_listener_them: Optional[AlwaysOnListener] = None
always_on_listener_me: Optional[AlwaysOnListener] = None
_transcription_executor: Optional[ThreadPoolExecutor] = None

is_recording: bool = False
_send_realtime_chunks: bool = True

# Guards concurrent rebuilds of the always-on listeners (e.g. POST /audio-devices
# racing with a keyboard toggle).
_listeners_lock = threading.Lock()

# Minimum accumulated audio before attempting transcription.
# 0.5 s is the minimum Whisper supports and halves first-chunk latency.
_min_audio_duration: float = 0.5

# Thread-safe audio accumulation buffer
_audio_buffer: list = []
_audio_buffer_lock = threading.Lock()


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------
class StartRecordingResponse(BaseModel):
    status: str
    message: str


class StopRecordingResponse(BaseModel):
    status: str
    message: str


class AudioDeviceInfo(BaseModel):
    index: int
    name: str
    hostapi_name: str
    max_input_channels: int
    max_output_channels: int


class AudioDevicesResponse(BaseModel):
    devices: List[AudioDeviceInfo]
    current: Dict[str, Any]
    platform: str


class AudioDevicesRequest(BaseModel):
    mic_device_index: Optional[int] = None
    loopback_mode: Optional[str] = None  # 'input_device' | 'wasapi_output'
    loopback_device_index: Optional[int] = None


# ---------------------------------------------------------------------------
# Audio processing
# ---------------------------------------------------------------------------
def process_audio_chunk(audio_chunk: np.ndarray):
    """Accumulate an audio chunk and transcribe when enough audio is buffered.

    All reads/writes to ``_audio_buffer`` are protected by ``_audio_buffer_lock``
    so that concurrent worker threads cannot corrupt the buffer or produce
    duplicate transcriptions for the same audio window.
    """
    global transcriber, socket_client, _audio_buffer, _send_realtime_chunks

    try:
        if audio_chunk is None or audio_chunk.size == 0:
            return

        if audio_chunk.ndim > 1:
            audio_chunk = np.mean(audio_chunk, axis=1)

        accumulated_audio: Optional[np.ndarray] = None

        with _audio_buffer_lock:
            _audio_buffer.append(audio_chunk)

            if _send_realtime_chunks:
                total_samples = sum(len(c) for c in _audio_buffer)
                total_duration = total_samples / SAMPLE_RATE

                if total_duration >= _min_audio_duration:
                    # Snapshot and reset buffer atomically
                    accumulated_audio = np.concatenate(_audio_buffer)

                    # Keep 0.5 s of overlap for context continuity
                    overlap_samples = int(SAMPLE_RATE * 0.5)
                    last_chunk = _audio_buffer[-1]
                    if len(last_chunk) > overlap_samples:
                        _audio_buffer = [last_chunk[-overlap_samples:]]
                    else:
                        _audio_buffer = [last_chunk]

        # Transcribe outside the lock (MLX is slow — ~200–500 ms)
        if accumulated_audio is not None and transcriber:
            text = transcriber.transcribe_chunk(accumulated_audio, SAMPLE_RATE)

            if text and text.strip():
                logger.info(f"🎤 Transcription: {text}")
                print(f"🎤 Transcription: {text}")

                if socket_client and socket_client.is_connected():
                    socket_client.send_transcription_chunk(text)

                append_transcription_to_json(text)

    except Exception as e:
        logger.error(f"Error processing audio chunk: {e}")
        with _audio_buffer_lock:
            _audio_buffer = []


def recording_worker():
    """Continuously pull audio chunks and dispatch them to the thread pool."""
    global recorder, is_recording, _transcription_executor

    logger.info("Recording worker started")

    while is_recording and recorder:
        try:
            audio_chunk = recorder.get_audio_chunk(timeout=0.5)
            if audio_chunk is not None:
                if _transcription_executor:
                    _transcription_executor.submit(process_audio_chunk, audio_chunk)
                else:
                    threading.Thread(
                        target=process_audio_chunk,
                        args=(audio_chunk,),
                        daemon=True,
                    ).start()
        except Exception as e:
            logger.error(f"Error in recording worker: {e}")
            if not is_recording:
                break

    logger.info("Recording worker stopped")


def start_recording_internal(enable_realtime_chunks: bool = False):
    """Start recording. Called from both keyboard handler and API endpoint."""
    global recorder, recording_thread, is_recording, _audio_buffer, _send_realtime_chunks

    if is_recording:
        logger.warning("Recording is already in progress")
        return

    try:
        with _audio_buffer_lock:
            _audio_buffer = []
        _send_realtime_chunks = enable_realtime_chunks

        recorder = AudioRecorder(callback=None)
        recorder.start_recording()

        is_recording = True
        recording_thread = threading.Thread(target=recording_worker, daemon=True)
        recording_thread.start()

        mode = "real-time" if enable_realtime_chunks else "push-to-talk"
        logger.info(f"Recording started ({mode} mode)")
    except Exception as e:
        logger.error(f"Failed to start recording: {e}")
        is_recording = False
        raise


def stop_recording_internal_sync():
    """Stop recording, transcribe remaining audio, and signal the server.

    Execution order that guarantees no chunks are lost:
    1. Set is_recording=False and stop audio input.
    2. Join the recording worker (loop exits, no more jobs submitted).
    3. Drain the transcription executor (wait for in-flight Whisper jobs to
       finish and send their chunks) — this is the key step that prevents the
       race where the final chunk arrives after process_transcription.
    4. Transcribe any audio still in the buffer after the executor drains.
    5. Only then emit process_transcription.
    """
    global recorder, recording_thread, is_recording, _audio_buffer, _transcription_executor

    if not is_recording:
        return

    is_recording = False

    if recorder:
        recorder.stop_recording()

    if recording_thread and recording_thread.is_alive():
        recording_thread.join(timeout=2.0)

    # Drain executor: wait for every in-flight transcription job to complete
    # (and send its chunk) before we proceed.  Then recreate for next session.
    if _transcription_executor:
        _transcription_executor.shutdown(wait=True)
        _transcription_executor = ThreadPoolExecutor(
            max_workers=2,
            thread_name_prefix="transcribe",
        )

    # Safely grab remaining buffer
    buffer_copy = []
    with _audio_buffer_lock:
        if _audio_buffer:
            buffer_copy = list(_audio_buffer)
        _audio_buffer = []

    # Transcribe any audio that hadn't reached the min-duration threshold
    if buffer_copy and transcriber:
        try:
            accumulated_audio = np.concatenate(buffer_copy)
            min_samples = int(SAMPLE_RATE * 0.5)
            if len(accumulated_audio) >= min_samples:
                text = transcriber.transcribe_chunk(accumulated_audio, SAMPLE_RATE)
                if text and text.strip():
                    logger.info(f"🎤 Final Transcription: {text}")
                    print(f"🎤 Final Transcription: {text}")

                    if socket_client and socket_client.is_connected():
                        # send_transcription_chunk is synchronous — no sleep needed
                        socket_client.send_transcription_chunk(text)

                    append_transcription_to_json(text)
        except Exception as e:
            logger.error(f"Error processing final accumulated audio: {e}")

    # Trigger server-side AI processing
    if socket_client and socket_client.is_connected():
        socket_client.process_transcription()
        logger.info("Sent process_transcription event")

    logger.info("Recording stopped")



# ---------------------------------------------------------------------------
# API endpoints
# ---------------------------------------------------------------------------
@app.post("/start-recording", response_model=StartRecordingResponse)
async def start_recording():
    if is_recording:
        raise HTTPException(status_code=400, detail="Recording is already in progress")
    try:
        start_recording_internal(enable_realtime_chunks=True)
        return StartRecordingResponse(status="success", message="Recording started successfully")
    except Exception as e:
        logger.error(f"Failed to start recording: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to start recording: {str(e)}")


@app.post("/stop-recording", response_model=StopRecordingResponse)
async def stop_recording():
    """Return immediately so the Node server can unblock the HUD state instantly.
    The heavy work (executor drain, final Whisper call, process_transcription)
    runs in a thread so it never blocks the event loop."""
    if not is_recording:
        return StopRecordingResponse(status="success", message="Not recording")
    try:
        # Run the blocking sync work in a thread — don't block the event loop.
        # The total time to AI answer is unchanged; only listen_state_changed
        # fires immediately instead of after all Whisper processing finishes.
        loop = asyncio.get_event_loop()
        loop.run_in_executor(None, stop_recording_internal_sync)
        return StopRecordingResponse(status="success", message="Recording stopped successfully")
    except Exception as e:
        logger.error(f"Failed to stop recording: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to stop recording: {str(e)}")


@app.get("/health")
async def health_check():
    return {
        "status": "healthy",
        "recording": is_recording,
        "socket_connected": socket_client.is_connected() if socket_client else False,
        "always_on_active": (always_on_listener_them is not None
                             and always_on_listener_them._running
                             and not always_on_listener_them._paused),
    }


def _rebuild_listeners_from_config():
    """Stop both listeners (if running), re-resolve audio sources, rebuild.
    Returns (bool was_running, list[str] started_labels)."""
    global always_on_listener_them, always_on_listener_me, transcriber

    with _listeners_lock:
        was_running = any(
            l is not None and l._running
            for l in (always_on_listener_them, always_on_listener_me)
        )
        for l in (always_on_listener_them, always_on_listener_me):
            if l is not None and l._running:
                try:
                    l.stop()
                except Exception as e:
                    logger.warning(f"Error stopping listener: {e}")

        time.sleep(0.2)  # let OS release device handles

        sources = resolve_audio_sources()
        them_idx, them_name, them_mode = sources['loopback']
        me_idx, me_name = sources['mic']

        always_on_listener_them = None
        always_on_listener_me = None

        if them_idx is not None:
            try:
                always_on_listener_them = AlwaysOnListener(
                    transcriber, socket_client,
                    device_index=them_idx, source_label='them',
                    wasapi_loopback=(them_mode == 'wasapi_output'),
                )
                logger.info(
                    f"Rebuilt 'them' listener on device {them_idx}: {them_name} "
                    f"[mode={them_mode}]"
                )
            except Exception as e:
                logger.error(f"Failed to rebuild 'them' listener: {e}")

        if me_idx is not None:
            try:
                t_me = Transcriber()
                always_on_listener_me = AlwaysOnListener(
                    t_me, socket_client,
                    device_index=me_idx, source_label='me',
                )
                logger.info(f"Rebuilt 'me' listener on device {me_idx}: {me_name}")
            except Exception as e:
                logger.error(f"Failed to rebuild 'me' listener: {e}")

        started = []
        if was_running:
            for l in (always_on_listener_them, always_on_listener_me):
                if l is not None:
                    try:
                        l.start()
                        started.append(l._source_label)
                    except Exception as e:
                        logger.error(f"Failed to restart listener[{l._source_label}]: {e}")

        return was_running, started


@app.post("/always-on-mode")
async def set_always_on_mode(body: dict):
    global always_on_listener_them, always_on_listener_me
    global transcriber, socket_client
    enabled = bool(body.get('enabled', True))

    if enabled:
        listeners = [l for l in (always_on_listener_them, always_on_listener_me) if l is not None]
        if not listeners:
            # Retry device resolution — the audio subsystem may have come online
            # after lifespan init (e.g. VB-Cable installed while server was running).
            try:
                sources = resolve_audio_sources()
                them_idx, them_name, them_mode = sources['loopback']
                me_idx, me_name = sources['mic']
                if them_idx is not None and transcriber is not None:
                    always_on_listener_them = AlwaysOnListener(
                        transcriber, socket_client,
                        device_index=them_idx, source_label='them',
                        wasapi_loopback=(them_mode == 'wasapi_output'),
                    )
                    logger.info(
                        f"Always-on listener (them) created on retry: device {them_idx} "
                        f"({them_name}) [mode={them_mode}]"
                    )
                if me_idx is not None:
                    # Build a second Transcriber for the 'me' channel so the
                    # two streams can run in parallel. Fall back to the shared
                    # transcriber if construction fails.
                    try:
                        t_me = Transcriber()
                    except Exception as e:
                        logger.warning(f"Could not init 'me' Transcriber on retry: {e}")
                        t_me = transcriber
                    if t_me is not None:
                        always_on_listener_me = AlwaysOnListener(
                            t_me, socket_client,
                            device_index=me_idx, source_label='me',
                        )
                        logger.info(f"Always-on listener (me) created on retry: device {me_idx} ({me_name})")
            except Exception as e:
                logger.error(f"Re-resolve failed: {e}")

            listeners = [l for l in (always_on_listener_them, always_on_listener_me) if l is not None]

        if not listeners:
            return {"status": "error", "message": "no listeners available"}

        for l in listeners:
            if not l._running:
                try:
                    l.start()
                except Exception as e:
                    logger.error(f"Failed to start listener[{l._source_label}]: {e}")
        return {"status": "ok", "running": [l._source_label for l in listeners if l._running]}
    else:
        listeners = [l for l in (always_on_listener_them, always_on_listener_me) if l is not None]
        if not listeners:
            return {"status": "ok", "running": []}
        for l in listeners:
            if l._running:
                try:
                    l.stop()
                except Exception as e:
                    logger.error(f"Failed to stop listener[{l._source_label}]: {e}")
        return {"status": "ok", "running": []}


@app.get("/audio-devices", response_model=AudioDevicesResponse)
async def get_audio_devices():
    import sys
    import sounddevice as sd

    try:
        raw_devices = sd.query_devices()
        hostapis = sd.query_hostapis()
    except Exception as e:
        logger.error(f"Failed to query audio devices: {e}")
        raise HTTPException(status_code=500, detail=f"Device query failed: {e}")

    devices = []
    for idx, dev in enumerate(raw_devices):
        api_idx = dev.get('hostapi')
        api_name = ''
        if isinstance(api_idx, int) and 0 <= api_idx < len(hostapis):
            api_name = str(hostapis[api_idx].get('name', ''))
        devices.append(AudioDeviceInfo(
            index=idx,
            name=str(dev.get('name', f'device_{idx}')),
            hostapi_name=api_name,
            max_input_channels=int(dev.get('max_input_channels', 0) or 0),
            max_output_channels=int(dev.get('max_output_channels', 0) or 0),
        ))

    # Current selection: read from config/audio.json directly so the UI
    # reflects exactly what's persisted, not whatever auto-detect resolved.
    repo_root = Path(__file__).resolve().parent.parent
    audio_cfg_path = repo_root / 'config' / 'audio.json'
    current: Dict[str, Any] = {}
    if audio_cfg_path.exists():
        try:
            with open(audio_cfg_path, 'r', encoding='utf-8') as f:
                loaded = json.load(f)
                if isinstance(loaded, dict):
                    current = loaded
        except Exception as e:
            logger.warning(f"Could not read {audio_cfg_path}: {e}")

    return AudioDevicesResponse(
        devices=devices,
        current=current,
        platform=sys.platform,
    )


@app.post("/audio-devices")
async def set_audio_devices(body: AudioDevicesRequest):
    import sounddevice as sd

    try:
        devices = sd.query_devices()
        hostapis = sd.query_hostapis()
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Device query failed: {e}")

    # Build new config dict. Start from existing on-disk config so we preserve
    # any legacy substring fields the user may have added.
    repo_root = Path(__file__).resolve().parent.parent
    audio_cfg_path = repo_root / 'config' / 'audio.json'
    new_cfg: Dict[str, Any] = {}
    if audio_cfg_path.exists():
        try:
            with open(audio_cfg_path, 'r', encoding='utf-8') as f:
                existing = json.load(f)
                if isinstance(existing, dict):
                    new_cfg = existing
        except Exception:
            pass

    # -- validate and fill mic ------------------------------------------------
    if body.mic_device_index is not None:
        if body.mic_device_index < 0 or body.mic_device_index >= len(devices):
            raise HTTPException(status_code=400, detail="mic_device_index out of range")
        dev = devices[body.mic_device_index]
        if int(dev.get('max_input_channels', 0) or 0) <= 0:
            raise HTTPException(status_code=400, detail="mic device has no input channels")
        new_cfg['mic_device_index'] = body.mic_device_index
        new_cfg['mic_device_name'] = str(dev.get('name', ''))
    else:
        # Clearing override: remove both numeric fields
        new_cfg.pop('mic_device_index', None)
        new_cfg.pop('mic_device_name', None)

    # -- validate and fill loopback ------------------------------------------
    if body.loopback_device_index is not None:
        if body.loopback_device_index < 0 or body.loopback_device_index >= len(devices):
            raise HTTPException(status_code=400, detail="loopback_device_index out of range")
        dev = devices[body.loopback_device_index]
        mode = body.loopback_mode or 'input_device'
        if mode not in ('input_device', 'wasapi_output'):
            raise HTTPException(status_code=400, detail=f"invalid loopback_mode: {mode}")
        api_idx = dev.get('hostapi')
        api_name = str(hostapis[api_idx].get('name', '')) if (
            isinstance(api_idx, int) and 0 <= api_idx < len(hostapis)
        ) else ''
        if mode == 'input_device':
            if int(dev.get('max_input_channels', 0) or 0) <= 0:
                raise HTTPException(status_code=400, detail="loopback device has no input channels")
        else:  # wasapi_output
            if int(dev.get('max_output_channels', 0) or 0) <= 0:
                raise HTTPException(status_code=400, detail="wasapi_output requires an output device")
            if 'wasapi' not in api_name.lower():
                raise HTTPException(status_code=400, detail=f"wasapi_output requires a WASAPI device (got {api_name})")
        new_cfg['loopback_device_index'] = body.loopback_device_index
        new_cfg['loopback_device_name'] = str(dev.get('name', ''))
        new_cfg['loopback_mode'] = mode
    else:
        new_cfg.pop('loopback_device_index', None)
        new_cfg.pop('loopback_device_name', None)
        new_cfg.pop('loopback_mode', None)

    # -- write config --------------------------------------------------------
    audio_cfg_path.parent.mkdir(parents=True, exist_ok=True)
    with open(audio_cfg_path, 'w', encoding='utf-8') as f:
        json.dump(new_cfg, f, indent=2)
    logger.info(f"Wrote audio config: {new_cfg}")

    # -- rebuild listeners ---------------------------------------------------
    was_running, started = _rebuild_listeners_from_config()
    return {
        'status': 'ok',
        'was_running': was_running,
        'started': started,
        'config': new_cfg,
    }


@app.post("/set-stt-model")
async def set_stt_model(body: dict):
    global transcriber, always_on_listener_them, always_on_listener_me
    model = body.get("model", "small")

    valid_models = {"tiny", "base", "small", "medium", "large", "whisper-1"}
    if model not in valid_models:
        raise HTTPException(status_code=400, detail=f"Invalid model. Must be one of: {', '.join(sorted(valid_models))}")

    logger.info(f"Switching STT model to: {model}")

    # Pause always-on listeners while we swap the transcriber
    listeners = [l for l in (always_on_listener_them, always_on_listener_me) if l is not None]
    paused_listeners = []
    for l in listeners:
        if l._running and not l._paused:
            l.pause()
            paused_listeners.append(l)

    try:
        transcriber = Transcriber(model_size=model)
        # Build a second Transcriber for the 'me' channel so the post-switch
        # state mirrors post-lifespan state (two independent instances,
        # allowing parallel transcription of mic + loopback).
        transcriber_me = None
        try:
            transcriber_me = Transcriber(model_size=model)
        except Exception as e:
            logger.warning(f"Could not initialize second Transcriber for 'me' channel: {e}")
        logger.info(f"STT model switched to: {model}")
        log_writer.log('stt_model_switched', model=model)
    except Exception as e:
        logger.error(f"Failed to switch STT model: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to load model: {str(e)}")

    # Rebind the 'them' listener to the primary transcriber, and the 'me'
    # listener to its own second instance (falling back to the primary if
    # the second instance could not be constructed).
    if always_on_listener_them:
        always_on_listener_them._transcriber = transcriber
    if always_on_listener_me:
        always_on_listener_me._transcriber = transcriber_me if transcriber_me is not None else transcriber
    for l in paused_listeners:
        l.resume()

    return {"status": "ok", "model": model}


@app.post("/set-vad-config")
async def set_vad_config(body: dict):
    global always_on_listener_them, always_on_listener_me, transcriber
    if not body:
        raise HTTPException(status_code=400, detail="Empty config body")

    listeners = [l for l in (always_on_listener_them, always_on_listener_me) if l is not None]

    # Handle engine switch
    new_engine = body.get('engine')
    if new_engine and transcriber and transcriber.vad.engine_name != new_engine:
        from vad import create_vad
        old_engine = transcriber.vad.engine_name
        # Pause listeners during swap
        for l in listeners:
            l.pause()
        transcriber.vad = create_vad(new_engine, body)
        for l in listeners:
            l.resume()
        logger.info(f"VAD engine switched: {old_engine} -> {new_engine}")
        log_writer.log('vad_engine_switched', from_engine=old_engine, to_engine=new_engine, config=body)

    # Update each always-on listener (which also updates its transcriber's VAD params)
    if listeners:
        for l in listeners:
            l.update_config(body)
    elif transcriber:
        # If no listeners are set up, still update the transcriber's VAD params directly
        transcriber.vad.update_config(body)

    logger.info(f"VAD config updated: {body}")
    log_writer.log('vad_config_updated', config=body)
    return {"status": "ok", "engine": transcriber.vad.engine_name if transcriber else None, "config": body}


@app.get("/vad-metrics")
async def get_vad_metrics():
    """Return rolling VAD metrics summary (5-minute window).

    Uses the 'them' listener as representative since both listeners share
    the same VAD engine type and config.
    """
    if always_on_listener_them:
        return always_on_listener_them.metrics.get_summary()
    if always_on_listener_me:
        return always_on_listener_me.metrics.get_summary()
    return {"error": "Always-on listener not running"}


@app.get("/settings")
async def get_settings():
    return {
        "stt_model": transcriber.model_size if transcriber else "small",
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host=API_HOST, port=API_PORT)
