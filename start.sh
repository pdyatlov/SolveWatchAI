#!/usr/bin/env bash
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  SolveWatch AI — start script
#  Installs deps, sets up Ollama, then starts Node + Python + Electron.
#
#  Usage:
#    ./start.sh              # uses whisper model from config, default: small
#    ./start.sh --newlogs    # clear all logs and start fresh
#    ./start.sh --setup      # first-time setup (installs everything, then starts)
#    ./start.sh --setup-only # install deps only, don't start services
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ── Platform check ────────────────────────────────────────────────────────────
# start.sh targets macOS only. The runtime calls python3, brew, nc, pgrep, pkill
# and friends — none of which are reliably available on Windows or Linux.
if [[ "$OSTYPE" != "darwin"* ]]; then
  echo "start.sh targets macOS only." >&2
  echo "On Windows: use start.ps1 (added in Phase 3 of the Windows port)." >&2
  echo "On Linux:   not yet supported." >&2
  exit 1
fi

NODE_PORT=$(python3 -c "
import json
try:
  c = json.load(open('$SCRIPT_DIR/config/api-keys.json'))
  print(c.get('port', 4000))
except: print(4000)
" 2>/dev/null)
NODE_PORT="${NODE_PORT:-4000}"
PIDS=()
OLLAMA_STARTED=false   # true only when this script launched ollama

# ── Parse args ────────────────────────────────────────────────────────────────
DO_SETUP=false
SETUP_ONLY=false
NEW_LOGS=false
for arg in "$@"; do
  case "$arg" in
    --setup)      DO_SETUP=true ;;
    --setup-only) DO_SETUP=true; SETUP_ONLY=true ;;
    --newlogs|-newlogs) NEW_LOGS=true ;;
  esac
done

# ── Colours ───────────────────────────────────────────────────────────────────
RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[1;33m'
CYAN=$'\033[0;36m'; BLUE=$'\033[0;34m'; BOLD=$'\033[1m'; RESET=$'\033[0m'
DIM=$'\033[2m'

log()     { echo -e "${CYAN}[start]${RESET} $*"; }
ok()      { echo -e "${GREEN}[  ok ]${RESET} $*"; }
warn()    { echo -e "${YELLOW}[ warn]${RESET} $*"; }
info()    { echo -e "${BLUE}[ info]${RESET} $*"; }
die()     { echo -e "${RED}[error]${RESET} $*" >&2; exit 1; }
section() { echo -e "\n${BOLD}  $*${RESET}"; }

# ── Cleanup on exit ───────────────────────────────────────────────────────────
cleanup() {
  echo ""
  log "Shutting down all services..."
  for pid in "${PIDS[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  # Stop Ollama server if this script started it
  if $OLLAMA_STARTED; then
    log "Stopping Ollama server..."
    pkill -x ollama 2>/dev/null || true
  fi
  sleep 1
  for pid in "${PIDS[@]}"; do
    kill -9 "$pid" 2>/dev/null || true
  done
  if $OLLAMA_STARTED; then
    pkill -9 -x ollama 2>/dev/null || true
  fi
  ok "All services stopped."
}
trap cleanup EXIT INT TERM

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  SETUP SECTION
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
if $DO_SETUP; then

  echo ""
  echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
  echo -e "${BOLD}  SolveWatch AI — First-Time Setup${RESET}"
  echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"

  # ── Homebrew ─────────────────────────────────────────────────────────────────
  section "1/6  Homebrew"
  if command -v brew >/dev/null 2>&1; then
    ok "Homebrew already installed."
  else
    log "Installing Homebrew..."
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    # Add brew to PATH for the rest of the script
    if [[ -f /opt/homebrew/bin/brew ]]; then
      eval "$(/opt/homebrew/bin/brew shellenv)"
    fi
    ok "Homebrew installed."
  fi

  # ── Node.js ──────────────────────────────────────────────────────────────────
  section "2/6  Node.js"
  if command -v node >/dev/null 2>&1; then
    ok "Node.js $(node --version) already installed."
  else
    log "Installing Node.js via Homebrew..."
    brew install node
    ok "Node.js installed."
  fi

  # ── Python 3 ─────────────────────────────────────────────────────────────────
  section "3/6  Python 3"
  if command -v python3 >/dev/null 2>&1; then
    ok "Python $(python3 --version) already installed."
  else
    log "Installing Python 3 via Homebrew..."
    brew install python3
    ok "Python 3 installed."
  fi

  # ── Ollama ───────────────────────────────────────────────────────────────────
  section "4/6  Ollama (local LLM)"
  if command -v ollama >/dev/null 2>&1; then
    ok "Ollama already installed ($(ollama --version 2>/dev/null || echo 'version unknown'))."
  else
    log "Installing Ollama via Homebrew..."
    brew install ollama
    ok "Ollama installed."
  fi

  # Start ollama serve in background (idempotent — already running is fine)
  log "Starting Ollama server..."
  ollama serve >/dev/null 2>&1 &
  OLLAMA_SERVE_PID=$!
  # Give it a few seconds to start up
  sleep 3

  # Determine which ollama model to pull from config (default: llama3.2:1b)
  OLLAMA_MODEL="llama3.2:1b"
  if [[ -f "$SCRIPT_DIR/config/api-keys.json" ]]; then
    _MODEL=$(python3 -c "
import json, sys
try:
  c = json.load(open('$SCRIPT_DIR/config/api-keys.json'))
  m = c.get('ollama_model') or c.get('keys',{}).get('ollama_model','')
  print(m if m else '')
except: pass
" 2>/dev/null)
    [[ -n "$_MODEL" ]] && OLLAMA_MODEL="$_MODEL"
  fi

  log "Pulling Ollama model: ${BOLD}$OLLAMA_MODEL${RESET} (this may take a few minutes on first run)..."
  if ollama pull "$OLLAMA_MODEL"; then
    ok "Model $OLLAMA_MODEL ready."
  else
    warn "Could not pull $OLLAMA_MODEL. Classifier will fall back to remote providers."
  fi

  # Also pull llama3.2:3b if 1b is the default (optional, skip if already pulled)
  if [[ "$OLLAMA_MODEL" == "llama3.2:1b" ]]; then
    info "Tip: run ${BOLD}ollama pull llama3.2:3b${RESET} for a more accurate (but slower) classifier."
  fi

  # Kill the background ollama serve we started — services section will restart it properly
  kill "$OLLAMA_SERVE_PID" 2>/dev/null || true
  sleep 1

  # ── npm install ───────────────────────────────────────────────────────────────
  section "5/6  Node.js dependencies"
  log "Running npm install..."
  npm install --silent
  ok "Node.js packages installed."

  # ── Python venv + requirements ────────────────────────────────────────────────
  section "6/6  Python transcriber dependencies"
  TRANSCRIBER_DIR="$SCRIPT_DIR/transcriber"
  if [ ! -d "$TRANSCRIBER_DIR/venv" ]; then
    log "Creating Python virtual environment..."
    python3 -m venv "$TRANSCRIBER_DIR/venv"
  fi
  log "Installing/updating Python dependencies..."
  "$TRANSCRIBER_DIR/venv/bin/pip" install -q --upgrade pip
  "$TRANSCRIBER_DIR/venv/bin/pip" install -q -r "$TRANSCRIBER_DIR/requirements.txt"
  if [[ "$OSTYPE" == "darwin"* ]]; then
    log "Installing macOS-only STT backend (MLX)..."
    "$TRANSCRIBER_DIR/venv/bin/pip" install -q -r "$TRANSCRIBER_DIR/requirements-mac.txt"
  fi
  ok "Python venv ready."

  # ── Config reminder ───────────────────────────────────────────────────────────
  echo ""
  echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
  echo -e "${BOLD}  Setup complete!${RESET}"
  echo ""
  echo -e "  ${BOLD}Next steps:${RESET}"
  echo ""
  echo -e "  1. Add your API keys:"
  echo -e "     ${DIM}Open ${BOLD}config/api-keys.json${RESET}${DIM} (copy from api-keys.json.example)${RESET}"
  echo -e "     ${DIM}Or open the settings page at ${BOLD}http://localhost:$NODE_PORT/settings${RESET}${DIM} after starting${RESET}"
  echo ""
  echo -e "  2. Keys you may need (need at least one):"
  echo -e "     ${YELLOW}OpenAI${RESET}   → https://platform.openai.com/api-keys"
  echo -e "     ${YELLOW}Grok${RESET}     → https://console.groq.com/keys"
  echo -e "     ${YELLOW}Gemini${RESET}   → https://aistudio.google.com/app/apikey"
  echo -e "     ${YELLOW}Claude${RESET}   → https://console.anthropic.com/settings/api-keys"
  echo ""
  echo -e "  3. Ollama (free, local — ${GREEN}already installed${RESET})"
  echo -e "     Default classifier model: ${BOLD}$OLLAMA_MODEL${RESET}"
  echo -e "     To install additional models:"
  echo -e "       ${DIM}ollama pull llama3.2:1b   # fast, 1.3 GB${RESET}"
  echo -e "       ${DIM}ollama pull llama3.2:3b   # accurate, 2 GB${RESET}"
  echo -e "       ${DIM}ollama pull llama3.1:8b   # best quality, 5 GB${RESET}"
  echo ""
  echo -e "  4. Start the app:"
  echo -e "     ${BOLD}./start.sh${RESET}"
  echo -e ""
  echo -e "  5. Open settings in browser:"
  echo -e "     ${BOLD}http://localhost:$NODE_PORT/settings${RESET}"
  echo -e ""
  echo -e "  6. Toggle HUD overlay: ${BOLD}Cmd+Shift+H${RESET}"
  echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
  echo ""

  $SETUP_ONLY && exit 0
fi

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  RUNTIME SECTION
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

# ── Read audio device from config ─────────────────────────────────────────────
AUDIO_INPUT_DEVICE=$(python3 -c "
import json
try:
  c = json.load(open('$SCRIPT_DIR/config/api-keys.json'))
  print(c.get('audio_input_device', ''))
except: print('')
" 2>/dev/null)

# ── Preflight ─────────────────────────────────────────────────────────────────
command -v node    >/dev/null 2>&1 || die "node not found. Run: ./start.sh --setup"
command -v npm     >/dev/null 2>&1 || die "npm not found.  Run: ./start.sh --setup"
command -v python3 >/dev/null 2>&1 || die "python3 not found. Run: ./start.sh --setup"

if [ ! -f "$SCRIPT_DIR/node_modules/.bin/electron" ]; then
  warn "node_modules missing. Running npm install..."
  npm install --silent
fi

# ── Ollama ────────────────────────────────────────────────────────────────────
if command -v ollama >/dev/null 2>&1; then
  if ! pgrep -x ollama >/dev/null 2>&1; then
    log "Starting Ollama server in background..."
    ollama serve >/dev/null 2>&1 &
    OLLAMA_PID=$!
    PIDS+=("$OLLAMA_PID")
    OLLAMA_STARTED=true
    sleep 2
    ok "Ollama server started (PID $OLLAMA_PID)."
  else
    ok "Ollama server already running (not managed by this script)."
  fi
else
  warn "Ollama not installed — local LLM classifier unavailable. Run: ./start.sh --setup"
fi

# ── Read whisper model from config ────────────────────────────────────────────
WHISPER_MODEL="small"
if [[ -f "$SCRIPT_DIR/config/api-keys.json" ]]; then
  _WM=$(python3 -c "
import json
try:
  c = json.load(open('$SCRIPT_DIR/config/api-keys.json'))
  print(c.get('stt_model','small'))
except: print('small')
" 2>/dev/null)
  [[ -n "$_WM" ]] && WHISPER_MODEL="$_WM"
fi

# ── Log file setup ────────────────────────────────────────────────────────────
# Two log files:
#   logs/app.jsonl        — structured NDJSON (all Node actions, settings, VAD, models)
#   logs/transcriber.log  — Python transcriber text log
mkdir -p "$SCRIPT_DIR/logs"
APP_JSON_LOG="$SCRIPT_DIR/logs/app.jsonl"
PYTHON_LOG="$SCRIPT_DIR/logs/transcriber.log"

if $NEW_LOGS; then
  log "Clearing all logs (--newlogs)..."
  rm -f "$SCRIPT_DIR/logs/"*.json "$SCRIPT_DIR/logs/"*.jsonl "$SCRIPT_DIR/logs/"*.log "$SCRIPT_DIR/logs/"*.ndjson
  ok "Logs cleared."
fi

echo ""
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo -e "${BOLD}  SolveWatch AI — starting services${RESET}"
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo ""

# ── Wait-for-port helper ──────────────────────────────────────────────────────
wait_for_port() {
  local port=$1 label=$2 max_wait=30 elapsed=0
  log "Waiting for $label on port $port..."
  while ! nc -z 127.0.0.1 "$port" 2>/dev/null; do
    sleep 1; elapsed=$((elapsed + 1))
    if [ "$elapsed" -ge "$max_wait" ]; then
      die "$label did not start within ${max_wait}s. Check logs: $3"
    fi
  done
  ok "$label is up."
}

# ── 1. Node.js backend ────────────────────────────────────────────────────────
# Node logs go to logs/app.jsonl (structured). Console output goes to /dev/null.
log "Starting Node.js backend (port $NODE_PORT)..."
node src/server.js >/dev/null 2>&1 &
NODE_PID=$!
PIDS+=("$NODE_PID")
wait_for_port "$NODE_PORT" "Node.js backend" "$APP_JSON_LOG"

# ── 2. Python transcriber ─────────────────────────────────────────────────────
TRANSCRIBER_DIR="$SCRIPT_DIR/transcriber"
[ -d "$TRANSCRIBER_DIR" ] || die "transcriber/ directory not found."

if [ ! -d "$TRANSCRIBER_DIR/venv" ]; then
  log "Creating Python virtual environment (first time)..."
  python3 -m venv "$TRANSCRIBER_DIR/venv"
  "$TRANSCRIBER_DIR/venv/bin/pip" install -q --upgrade pip
  "$TRANSCRIBER_DIR/venv/bin/pip" install -q -r "$TRANSCRIBER_DIR/requirements.txt"
  if [[ "$OSTYPE" == "darwin"* ]]; then
    "$TRANSCRIBER_DIR/venv/bin/pip" install -q -r "$TRANSCRIBER_DIR/requirements-mac.txt"
  fi
  ok "Python venv ready."
else
  # Sync any newly added packages (fast no-op when nothing changed)
  "$TRANSCRIBER_DIR/venv/bin/pip" install -q -r "$TRANSCRIBER_DIR/requirements.txt"
  if [[ "$OSTYPE" == "darwin"* ]]; then
    "$TRANSCRIBER_DIR/venv/bin/pip" install -q -r "$TRANSCRIBER_DIR/requirements-mac.txt"
  fi
fi

log "Starting Python transcriber (STT model: $WHISPER_MODEL)..."
WHISPER_MODEL="$WHISPER_MODEL" AUDIO_INPUT_DEVICE="${AUDIO_INPUT_DEVICE:-}" "$TRANSCRIBER_DIR/venv/bin/python" "$TRANSCRIBER_DIR/main.py" \
  >"$PYTHON_LOG" 2>&1 &
PYTHON_PID=$!
PIDS+=("$PYTHON_PID")
ok "Python transcriber started (PID $PYTHON_PID)."

# ── 3. Electron HUD ───────────────────────────────────────────────────────────
log "Starting Electron HUD..."
"$SCRIPT_DIR/node_modules/.bin/electron" electron/main.js >/dev/null 2>&1 &
ELECTRON_PID=$!
PIDS+=("$ELECTRON_PID")
ok "Electron HUD started (PID $ELECTRON_PID)."

# ── Status summary ────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo -e "  ${GREEN}All services running${RESET}"
echo -e ""
echo -e "  ${BOLD}Services:${RESET}"
echo -e "  Node.js      → PID $NODE_PID"
echo -e "  Transcriber  → PID $PYTHON_PID"
echo -e "  Electron HUD → PID $ELECTRON_PID"
echo -e ""
echo -e "  ${BOLD}Log files:${RESET}"
echo -e "  Structured JSON  → ${DIM}logs/app.jsonl${RESET}"
echo -e "  Transcriber text → ${DIM}logs/transcriber.log${RESET}"
echo -e ""
echo -e "  ${BOLD}Quick links:${RESET}"
echo -e "  Settings page   → ${CYAN}http://localhost:$NODE_PORT/settings${RESET}"
echo -e "  Toggle HUD      → ${BOLD}Cmd+Shift+H${RESET}"
echo -e "  Stop everything → ${BOLD}Ctrl+C${RESET}"
echo -e ""
echo -e "  ${BOLD}STT model:${RESET} $WHISPER_MODEL"
echo -e "  ${BOLD}Behaviour:${RESET} Questions are classified and answered automatically"
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo ""

# ── Tail logs live ────────────────────────────────────────────────────────────
tail -f "$PYTHON_LOG" | sed "s/^/${YELLOW}[transcriber]${RESET} /" &
PIDS+=("$!")

wait "$NODE_PID" "$PYTHON_PID" "$ELECTRON_PID"
