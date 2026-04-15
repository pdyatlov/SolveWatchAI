"""
Socket.IO client for sending transcription chunks and questions.

Improvements over the original:
- Unlimited reconnection attempts (reconnection_attempts=0) with up to 30s max delay.
- Background retry thread for initial connection failures (server not yet running).
"""
import threading
import time
import socketio
import logging
from typing import Optional
from config import SOCKET_URL, SOCKET_ENDPOINT

logger = logging.getLogger(__name__)


class SocketClient:
    """Socket.IO client with automatic infinite reconnection."""

    def __init__(self, url: str = SOCKET_URL, endpoint: str = SOCKET_ENDPOINT):
        self.url = url
        self.endpoint = endpoint
        self.use_namespace = False
        self.connected = False
        self._reconnect_thread: Optional[threading.Thread] = None

        # reconnection_attempts=0 means unlimited built-in reconnection after disconnect.
        # reconnection_delay_max=30 caps the exponential backoff at 30 s.
        self.sio = socketio.Client(
            reconnection=True,
            reconnection_attempts=0,
            reconnection_delay=1,
            reconnection_delay_max=30,
        )

        self.sio.on('connect', self._on_connect, namespace=self.endpoint)
        self.sio.on('disconnect', self._on_disconnect, namespace=self.endpoint)
        self.sio.on('connect_error', self._on_connect_error, namespace=self.endpoint)

        self.sio.on('ai_processing_started', self._on_ai_processing_started, namespace=self.endpoint)
        self.sio.on('ai_processing_complete', self._on_ai_processing_complete, namespace=self.endpoint)
        self.sio.on('ai_token', self._on_ai_token, namespace=self.endpoint)
        self.sio.on('aiprocessing_error', self._on_ai_processing_error, namespace=self.endpoint)

    # ------------------------------------------------------------------
    # Event handlers
    # ------------------------------------------------------------------

    def _on_connect(self):
        self.connected = True
        logger.info(f"Connected to {self.url} on namespace {self.endpoint}")

    def _on_disconnect(self):
        self.connected = False
        logger.info(f"Disconnected from namespace {self.endpoint}")

    def _on_connect_error(self, error):
        logger.error(f"Socket.IO connection error: {error}")
        self.connected = False

    def _on_ai_processing_started(self, data):
        message = data.get('message', 'AI processing started') if isinstance(data, dict) else str(data)
        logger.info(f"🤖 AI Processing Started: {message}")
        print(f"\n🤖 AI Processing Started: {message}\n")

    def _on_ai_token(self, data):
        """Handle streaming token — print live."""
        token = data.get('token', '') if isinstance(data, dict) else str(data)
        if token:
            print(token, end='', flush=True)

    def _on_ai_processing_complete(self, data):
        if isinstance(data, dict):
            message = data.get('message', 'AI processing completed')
        else:
            message = 'AI processing completed'

        logger.info(f"✅ AI Processing Complete: {message}")
        print(f"\n{'=' * 80}")
        print(f"✅ {message}")
        print(f"{'=' * 80}\n")

    def _on_ai_processing_error(self, data):
        if isinstance(data, dict):
            error = data.get('error', 'Unknown error')
            message = data.get('message', 'AI processing error')
        else:
            error = str(data)
            message = 'AI processing error'

        logger.error(f"❌ AI Processing Error: {message} — {error}")
        print(f"\n❌ AI Processing Error: {message}\nDetails: {error}\n")

    # ------------------------------------------------------------------
    # Connection management
    # ------------------------------------------------------------------

    def connect(self):
        """Attempt immediate connection. On failure, start background retry loop."""
        if self.connected:
            return

        logger.info(f"Connecting to {self.url} on namespace {self.endpoint}")
        try:
            self.sio.connect(
                self.url,
                transports=['websocket'],
                namespaces=[self.endpoint],
            )
            self.use_namespace = True
        except Exception as e:
            logger.warning(f"Initial connection failed: {e}. Background reconnect started.")
            self._start_background_reconnect()

    def _start_background_reconnect(self):
        """Spawn a daemon thread that retries the connection with exponential backoff."""
        if self._reconnect_thread and self._reconnect_thread.is_alive():
            return
        self._reconnect_thread = threading.Thread(
            target=self._reconnect_loop,
            daemon=True,
            name="socket-reconnect",
        )
        self._reconnect_thread.start()

    def _reconnect_loop(self):
        """Keep trying to connect with exponential backoff (1 s → 2 s → … → 30 s max)."""
        delay = 1
        max_delay = 30
        attempt = 0

        while not self.connected:
            time.sleep(delay)
            delay = min(delay * 2, max_delay)

            if self.connected:
                break

            attempt += 1
            logger.info(f"Socket.IO reconnect attempt {attempt}…")
            try:
                self.sio.connect(
                    self.url,
                    transports=['websocket'],
                    namespaces=[self.endpoint],
                )
                self.use_namespace = True
                logger.info("Socket.IO reconnected successfully")
                break
            except Exception as e:
                logger.warning(f"Reconnect attempt {attempt} failed: {e}. Next in {delay}s")

    def disconnect(self):
        if not self.connected:
            return
        try:
            self.sio.disconnect()
            self.connected = False
            logger.info("Disconnected from Socket.IO server")
        except Exception as e:
            logger.error(f"Error disconnecting: {e}")

    # ------------------------------------------------------------------
    # Emitters
    # ------------------------------------------------------------------

    def send_transcription_chunk(self, text: str):
        """Send a transcription text chunk to the server (synchronous/blocking)."""
        if not self.connected:
            logger.warning("Not connected — skipping transcription chunk")
            return
        if not text or not text.strip():
            return
        try:
            self.sio.emit('transcription', {'textChunk': text.strip()}, namespace=self.endpoint)
            logger.debug(f"Sent transcription chunk: {text[:50]}…")
        except Exception as e:
            logger.error(f"Error sending transcription chunk: {e}")

    def process_transcription(self):
        """Signal the server to process all accumulated transcription chunks."""
        if not self.connected:
            logger.warning("Not connected — cannot send process_transcription")
            return
        try:
            self.sio.emit('process_transcription', namespace=self.endpoint)
            logger.info("Sent process_transcription event")
        except Exception as e:
            logger.error(f"Error sending process_transcription: {e}")

    def send_interviewer_speech(self, text: str, source: str = 'them'):
        """Send a detected utterance to the server, tagged with its source.

        source: 'them' (interviewer, loopback device) or 'me' (user, microphone).
        Defaults to 'them' for backward compatibility with older callers.
        """
        if not self.connected:
            logger.warning("Not connected — skipping interviewer speech")
            return

        if not text or not text.strip():
            return
        try:
            self.sio.emit(
                'interviewer_speech',
                {'text': text.strip(), 'timestamp': time.time(), 'source': source},
                namespace=self.endpoint,
            )
            logger.debug(f"Sent interviewer speech [{source}]: {text[:50]}…")
        except Exception as e:
            logger.error(f"Error sending interviewer speech: {e}")

    def send_listen_state(self, listening: bool):
        """Notify Node.js that the always-on listener was toggled via keyboard."""
        if not self.connected:
            return
        try:
            self.sio.emit('listen_state_update', {'listening': listening}, namespace=self.endpoint)
            logger.debug(f"Sent listen_state_update: {listening}")
        except Exception as e:
            logger.error(f"Error sending listen state: {e}")

    def is_connected(self) -> bool:
        return self.connected

    def __enter__(self):
        self.connect()
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self.disconnect()
