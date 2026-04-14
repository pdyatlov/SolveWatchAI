# SolveWatch AI

A real-time interview assistant that listens to your interviewer, transcribes their questions, and streams AI answers directly into a stealth overlay — invisible to your interviewer even when you're screen-sharing.

> **Open source · MIT license · macOS (Apple Silicon)**

---

## What it does

| Feature | How it works |
|---------|-------------|
| **Live audio transcription** | Captures microphone input, runs Whisper on-device via Apple MLX (no API key needed), streams transcriptions in real time |
| **AI answer overlay (HUD)** | An Electron window floats over your screen, showing streamed AI answers as bullet points — designed for quick scanning during an interview |
| **Screenshot analysis** | Monitors a folder for new screenshots; when one appears, runs OCR + AI to analyse the content and display insights in the HUD |
| **Invisible in screenshare** | The HUD window uses macOS content protection (`setContentProtection`) — it is completely invisible in Zoom, Meet, and any screenshare tool |
| **Conversation memory** | The AI remembers the last 3–5 Q&A pairs so follow-up questions ("what are its features?") work correctly |
| **Multi-provider fallback** | If your primary AI provider fails or rate-limits, requests automatically retry down your configured fallback chain |
| **Interview role context** | Tell the app your interview role (e.g. "Frontend Engineer") and prompts are automatically tailored to your domain |

---

## Prerequisites

- **macOS** (Apple Silicon recommended; Intel may work but is untested)
- **Homebrew**, **Node.js 18+**, **Python 3.10+**, **Ollama** — all installed automatically by `./start.sh --setup` if missing
- At least **one API key**: OpenAI, Groq, Gemini, or Claude

> **Don't have Node or Python?** Just run `./start.sh --setup` — it installs everything via Homebrew.
> If you skip `--setup` and run `./start.sh` directly without Node or Python, the script exits immediately with a clear error message telling you to run `--setup`. Nothing breaks silently.

---

## Quick start

### First-time setup (one command)

```bash
git clone https://github.com/your-username/solveWatchAi.git
cd solveWatchAi
./start.sh --setup
```

This will:
1. Install Homebrew, Node.js, Python, Ollama (if missing)
2. Pull the Ollama model (`llama3.2:1b` by default)
3. Install Node.js and Python dependencies
4. Print setup instructions

Then open the settings page and add your API keys:

```
http://localhost:4000/settings
```

### Starting the app (after setup)

```bash
./start.sh
```

This starts three services simultaneously:
- **Node.js backend** — API, WebSocket, screenshot monitor
- **Python transcriber** — Whisper STT + Silero VAD
- **Electron HUD** — the floating overlay window

Press `Ctrl+C` to stop everything.

---

## Settings page

Open `http://localhost:4000/settings` in your browser after starting the app. The page has two sections — AI Providers at the top, and everything else below when you scroll down.

---

### AI Providers

![AI Providers settings](docs/images/settings-providers.png)

The first thing you see when you open settings.

- Keys are stored locally in `config/api-keys.json` on your machine — nothing is sent anywhere
- Leave a key field blank to keep the existing saved value
- At least one provider must be enabled

The **fallback chain** is shown at the top (e.g. `Groq → OpenAI → Gemini`) — if the first provider fails or rate-limits, the next one is tried automatically.

| Provider | Where to get a key |
|----------|--------------------|
| OpenAI   | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) |
| Groq     | [console.groq.com/keys](https://console.groq.com/keys) |
| Gemini   | [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey) |
| Claude   | [console.anthropic.com/settings/api-keys](https://console.anthropic.com/settings/api-keys) |

Each provider card has:
- **Toggle** — enable or disable the provider
- **Key field** — masked; shows `🔑 key saved` when a key exists. Leave blank to keep the existing key.
- **Show** — reveal the saved key
- **Test** — verify the key works before your interview
- **Model dropdown** — lists available models for that provider
- **↻ button** — refresh the model list (useful after adding a new key)
- **Drag handle** (`⠿`) — drag cards to reorder the fallback chain

---

### Interview Role

![Settings details](docs/images/settings-details.png)

Scroll down past the providers to reach this section.

Enter your role (e.g. `Frontend Engineer`, `Android Developer`, `Platform Engineer`). Every AI answer is automatically tailored to use relevant frameworks, tools, and terminology for that domain. Leave blank for generic technical answers.

Click **View Active Prompts** to expand a preview of the exact prompt being sent to the AI, so you can see how your role is applied.

---

### Screenshots

Set the folder SolveWatch watches for new screenshots. When a new file appears, the app runs OCR + AI analysis and shows the result in the HUD.

On macOS, `Cmd+Shift+3` saves to `~/Desktop` by default. To point it at a dedicated folder:
1. `System Settings → Screenshots → Save to` → choose your folder
2. Enter that same path in the Screenshots Folder field here
3. `System Settings → Screenshots → uncheck "Show Floating Thumbnail"` to avoid distraction

---

### Speech-to-Text

Two modes, switchable via tabs:

- **Local Whisper (MLX)** — runs fully on-device using Apple MLX, no API key required. Choose a model from the dropdown (`tiny` → `large`; `medium` is a good balance of speed and accuracy). Changing the model restarts the transcriber automatically.
- **OpenAI Whisper API** — sends audio to OpenAI for transcription. Requires an OpenAI key configured in the AI Providers section above.

---

### HUD Appearance

**Window Opacity** slider: drag from **Opaque (0%)** to **Transparent (90%)**. Changes apply live to the open HUD window — no save needed.

> The HUD is invisible in screen sharing by default — only you can see it.
> Shortcut keys: `Ctrl+Shift+H` (`Cmd+Shift+H` on macOS) toggle HUD · `Ctrl+Shift+X` (`Cmd+Shift+X` on macOS) toggle listening

---

## Shortcut keys

| Shortcut | Action |
|----------|--------|
| `Ctrl+Shift+H` (`Cmd+Shift+H` on macOS) | Toggle HUD overlay on/off |
| `Ctrl+Shift+X` (`Cmd+Shift+X` on macOS) | Toggle listening on/off — same as clicking the Listen button in the HUD |

---

## How the HUD is invisible in screenshare

The Electron overlay window uses macOS `setContentProtection(true)`. This is the same API used by banking apps and video players to prevent screen capture. The window appears normally on your display but is excluded from all screenshare, recording, and screenshot capture. Your interviewer cannot see it.

---

## System Audio Capture (Windows)

Windows does not expose a system-audio loopback device by default. To let the transcriber hear the interviewer's voice from a meeting app (Zoom, Meet, Teams…), install a virtual audio cable:

1. Install [**VB-Audio Virtual Cable**](https://vb-audio.com/Cable/) (free for personal use). The installer exposes two devices: `CABLE Input` (playback) and `CABLE Output` (recording).
2. In the **meeting app's output settings**, pick `CABLE Input (VB-Audio Virtual Cable)` as the speaker. This routes the interviewer's audio into the virtual cable instead of your physical speakers.
3. In `config/api-keys.json`, set `"audio_input_device": "CABLE Output (VB-Audio Virtual Cable)"`. The Python transcriber listens to this device.
4. To hear the meeting yourself in parallel, open the legacy Sound Control Panel (Win+R → `mmsys.cpl` → Recording → select `CABLE Output` → Properties → Listen → check "Listen to this device" → pick your headphones as playback).

The exact device string must match what `sounddevice.query_devices()` reports on your machine. If the transcriber cannot find the device, list devices with:

```
transcriber/venv/Scripts/python.exe -c "import sounddevice; print(sounddevice.query_devices())"
```

and copy the exact name from the output.

## Ollama (local LLM)

Ollama runs locally and is used for:
- **Conversation memory** — summarizing Q&A pairs to keep context compact
- No API key or internet required for this

Default model: `llama3.2:1b` (1.3 GB, fast)

To use a better model, pull it and update `ollama_model` in `config/api-keys.json`:

```bash
ollama pull llama3.2:3b   # more accurate, 2 GB
ollama pull llama3.1:8b   # best quality, 5 GB
```

---

## Configuration file

Settings are stored in `config/api-keys.json` (gitignored). You can also edit this file directly — copy from `config/api-keys.json.example` to get started.

**Advanced VAD tuning** — the VAD section is not exposed in the UI (Silero VAD is always used). Edit the `vad` block directly:

```json
"vad": {
  "silero_threshold": 0.5,
  "silero_min_speech_duration_ms": 100,
  "silero_min_silence_duration_ms": 300,
  "min_speech_duration": 0.5,
  "silence_threshold": 0.5,
  "max_utterance_duration": 30,
  "min_word_count": 5
}
```

---

## Logs

Logs are cleared automatically on every server start. They're written to:

- `logs/app.jsonl` — structured JSON log of all server events
- `logs/transcriber.log` — Python transcriber output (live-tailed in the terminal)
- `logs/memory.jsonl` — conversation memory events

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  macOS                                                          │
│                                                                 │
│  ┌──────────────┐    WebSocket    ┌──────────────────────────┐  │
│  │  Electron    │◄────────────────│  Node.js Backend         │  │
│  │  HUD Overlay │                 │  (Express + Socket.IO)   │  │
│  └──────────────┘                 │                          │  │
│                                   │  ┌────────────────────┐  │  │
│  ┌──────────────┐    WebSocket    │  │  AI Service        │  │  │
│  │  Python STT  │────────────────►│  │  OpenAI / Grok /   │  │  │
│  │  (Whisper +  │                 │  │  Gemini / Claude / │  │  │
│  │   Silero VAD)│                 │  │  Ollama (local)    │  │  │
│  └──────────────┘                 │  └────────────────────┘  │  │
│       ▲                           │                          │  │
│       │ microphone                │  ┌────────────────────┐  │  │
│                                   │  │ Screenshot Monitor │  │  │
│  ┌──────────────┐                 │  │ (fs.watch + OCR)   │  │  │
│  │  Screenshots │────────────────►│  └────────────────────┘  │  │
│  │  folder      │                 └──────────────────────────┘  │
│  └──────────────┘                                               │
└─────────────────────────────────────────────────────────────────┘
```

---

## Troubleshooting

**HUD doesn't appear**
Run `./start.sh` and check the terminal — Electron should start within a few seconds. Try `Ctrl+Shift+H` (`Cmd+Shift+H` on macOS).

**No transcription**
- Check that your microphone is enabled for Terminal in `System Settings → Privacy & Security → Microphone`
- Try a different STT model (start with `small`)

**AI not responding**
- Open `http://localhost:4000/settings` and check that at least one provider is enabled with a valid key
- Use the "Test" button next to each provider to verify connectivity

**Screenshot analysis not working**
- Make sure the screenshots path is set in Settings and the folder exists
- Take a screenshot and check `logs/transcriber.log` for activity

**Ollama not found**
Run `./start.sh --setup` to install it.

---

## License

MIT — see [LICENSE](./LICENSE)
