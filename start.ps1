# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  SolveWatch AI — Windows start script (PowerShell)
#  Installs deps, sets up Ollama, then starts Node + Python + Electron.
#
#  Usage:
#    powershell -ExecutionPolicy Bypass -File start.ps1              # default: run services
#    powershell -ExecutionPolicy Bypass -File start.ps1 -NewLogs     # clear logs first
#    powershell -ExecutionPolicy Bypass -File start.ps1 -Setup       # first-time setup + run
#    powershell -ExecutionPolicy Bypass -File start.ps1 -SetupOnly   # install deps, don't run
#    powershell -ExecutionPolicy Bypass -File start.ps1 -Setup -Gpu  # also install CUDA wheels
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

param(
    [switch]$Setup,
    [switch]$SetupOnly,
    [switch]$NewLogs,
    [switch]$Gpu,
    [switch]$NoHide      # 04-02 D-11: debug escape hatch — skip console hide
)

# ── Encoding ──────────────────────────────────────────────────────────────────
# Force UTF-8 so box-drawing characters and non-ASCII output render correctly
# regardless of the user's system codepage (cp1252, cp866, cp932, ...).
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

# ── Strict error behaviour ────────────────────────────────────────────────────
$ErrorActionPreference = 'Stop'
# Suppress the progress stream from cmdlets like Test-NetConnection — in PS 7
# `-InformationLevel Quiet` stops the return value noise but does NOT hide the
# progress bar, which leaks into the console between our own status lines.
$ProgressPreference = 'SilentlyContinue'

# ── Paths ─────────────────────────────────────────────────────────────────────
$ScriptDir      = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ScriptDir
$TranscriberDir = Join-Path $ScriptDir 'transcriber'
$VenvPython     = Join-Path $TranscriberDir 'venv\Scripts\python.exe'
$VenvPip        = Join-Path $TranscriberDir 'venv\Scripts\pip.exe'
$ElectronBin    = Join-Path $ScriptDir     'node_modules\.bin\electron.cmd'
$ConfigPath     = Join-Path $ScriptDir     'config\api-keys.json'
$LogsDir        = Join-Path $ScriptDir     'logs'
$PythonLog      = Join-Path $LogsDir       'transcriber.log'
$AppJsonLog     = Join-Path $LogsDir       'app.jsonl'

# ── Helper functions ──────────────────────────────────────────────────────────
function Log     ($msg) { Write-Host "[start] $msg"   -ForegroundColor Cyan   }
function Ok      ($msg) { Write-Host "[  ok ] $msg"   -ForegroundColor Green  }
function Warn    ($msg) { Write-Host "[ warn] $msg"   -ForegroundColor Yellow }
function Info    ($msg) { Write-Host "[ info] $msg"   -ForegroundColor Blue   }
function Die     ($msg) { Write-Host "[error] $msg"   -ForegroundColor Red ; exit 1 }
function Section ($msg) { Write-Host "`n  $msg"       -ForegroundColor White  }

function Get-ConfigValue {
    param($Key, $Default)
    if (-not (Test-Path $ConfigPath)) { return $Default }
    try {
        $cfg = Get-Content $ConfigPath -Raw | ConvertFrom-Json
        $v = $cfg.$Key
        if ($null -eq $v -or $v -eq '') { return $Default }
        return $v
    } catch {
        return $Default
    }
}

function Refresh-Path {
    # winget install writes PATH to the registry but does NOT push it into the
    # current shell. Reload Machine+User PATH so subsequent Get-Command lookups
    # see freshly-installed binaries.
    $machine = [System.Environment]::GetEnvironmentVariable('Path','Machine')
    $user    = [System.Environment]::GetEnvironmentVariable('Path','User')
    $env:Path = $machine + ';' + $user
}

function Stop-StaleServices {
    # Kill any process from a previous run that would block startup:
    #   - whatever is listening on the Node backend port
    #   - whatever is listening on the Python transcriber port (8000)
    #   - orphaned Electron / Python / Node children whose command line
    #     points at this repo (matched by script arg path, not process name)
    # Leaves Ollama alone — that's user-managed and the script already
    # detects a running instance elsewhere.
    param([int]$NodePort = 4000, [int]$TranscriberPort = 8000)

    $killed = @()

    # Port-based kills
    foreach ($port in @($NodePort, $TranscriberPort)) {
        try {
            $conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
            foreach ($conn in $conns) {
                $procId = $conn.OwningProcess
                if ($null -eq $procId -or $procId -eq 0) { continue }
                try {
                    $proc = Get-Process -Id $procId -ErrorAction Stop
                    Stop-Process -Id $procId -Force -ErrorAction Stop
                    $killed += "$($proc.ProcessName)(PID $procId) on :$port"
                } catch {
                    # Process may have died between query and kill — ignore
                }
            }
        } catch {
            # Get-NetTCPConnection not available or failed — skip silently
        }
    }

    # Command-line matched kills: any node/electron/python process whose
    # command line contains our repo's script paths. Catches zombies that
    # no longer hold a port but still exist.
    $patterns = @(
        [regex]::Escape('src\server.js'),
        [regex]::Escape('electron\main.js'),
        [regex]::Escape('transcriber\main.py')
    )
    try {
        $allProcs = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue
        foreach ($p in $allProcs) {
            if (-not $p.CommandLine) { continue }
            $match = $false
            foreach ($pat in $patterns) {
                if ($p.CommandLine -match $pat) { $match = $true; break }
            }
            if (-not $match) { continue }
            try {
                Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop
                $killed += "$($p.Name)(PID $($p.ProcessId)) cmdline-matched"
            } catch {
                # already gone
            }
        }
    } catch {}

    if ($killed.Count -gt 0) {
        Warn "Killed stale processes:"
        foreach ($k in $killed) { Warn "  - $k" }
        # Give the OS a moment to release sockets
        Start-Sleep -Milliseconds 500
    } else {
        Info "No stale services to clean up."
    }
}

function Wait-ForPort {
    param($Port, $Label, $LogHint)
    $max = 30
    $elapsed = 0
    Log "Waiting for $Label on port $Port..."
    while (-not (Test-NetConnection -ComputerName 127.0.0.1 -Port $Port -InformationLevel Quiet -WarningAction SilentlyContinue)) {
        Start-Sleep -Seconds 1
        $elapsed++
        if ($elapsed -ge $max) { Die "$Label did not start within ${max}s. Check logs: $LogHint" }
    }
    Ok "$Label is up."
}

# ── Win32 P/Invoke for console hide (04-02, D-08) ─────────────────────────────
# Hide the PowerShell console window after all three services are ready (D-09),
# restore it on mid-run failure (D-10) so the user can read error messages.
#
# CRITICAL: this only works under classic conhost.exe. Under Windows Terminal's
# ConPTY, GetConsoleWindow returns a message-only HWND and SW_HIDE is a no-op.
# start.bat MUST spawn us as `conhost.exe powershell -File ...` — see
# .planning/phases/04-tray-startup-ux/04-RESEARCH.md §Q2 + Pitfall 1.
$Win32ShowWindow = @'
using System;
using System.Runtime.InteropServices;
public static class Win32ShowWindow {
    [DllImport("kernel32.dll")]
    public static extern IntPtr GetConsoleWindow();
    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
'@
try {
    Add-Type -TypeDefinition $Win32ShowWindow -Language CSharp -ErrorAction Stop
} catch {
    # Type already loaded from a previous invocation in the same session — benign.
}
$SW_HIDE    = 0
$SW_RESTORE = 9   # Use for D-10 re-show — restores from minimized OR hidden state

function Hide-ConsoleWindow {
    if ($NoHide.IsPresent) {
        Info "-NoHide set; console will remain visible."
        return
    }
    $h = [Win32ShowWindow]::GetConsoleWindow()
    if ($h -eq [IntPtr]::Zero) {
        Warn "GetConsoleWindow returned NULL (pseudoconsole?) — console hide skipped."
        return
    }
    [Win32ShowWindow]::ShowWindow($h, $SW_HIDE) | Out-Null
}

function Show-ConsoleWindow {
    $h = [Win32ShowWindow]::GetConsoleWindow()
    if ($h -eq [IntPtr]::Zero) { return }
    [Win32ShowWindow]::ShowWindow($h, $SW_RESTORE) | Out-Null
}

# ── Electron readiness sentinel poll (04-02, D-09 step 3) ─────────────────────
# Electron's app.whenReady handler writes logs/.electron-ready after tray init.
# We poll at 200ms intervals up to 15s. Timeout → Die (leaves console visible).
function Wait-ForElectronReady {
    param([int]$TimeoutSec = 15)
    $readyPath = Join-Path $LogsDir '.electron-ready'
    $elapsed = 0.0
    Log "Waiting for Electron HUD ready signal..."
    while (-not (Test-Path -LiteralPath $readyPath)) {
        Start-Sleep -Milliseconds 200
        $elapsed += 0.2
        if ($elapsed -ge $TimeoutSec) {
            Die "Electron HUD did not write ready sentinel within ${TimeoutSec}s. Check logs\node-stderr.log and try running with -NoHide for diagnostics."
        }
    }
    Ok "Electron HUD is ready."
}

# ── Pidfile atomic write (04-03, D-12) ────────────────────────────────────────
# Writes logs/pids.json after all services are spawned. Electron reads it at
# app.whenReady and uses managedPids to drive tray Stop all / Restart.
#
# Atomic via temp + Move-Item -Force (MoveFileEx on NTFS same-volume). Electron
# readers either see the old content, the new content, or ENOENT — never a
# partial write. Reference: 04-RESEARCH.md §Q6 + §Pitfall 8 (BOM-free UTF-8).
function Write-PidFile {
    param([string]$Path, [hashtable]$Data)
    $tmp = "$Path.tmp"
    $json = $Data | ConvertTo-Json -Compress -Depth 4
    # [System.IO.File]::WriteAllText with UTF8Encoding($false) emits BOM-free
    # UTF-8 — Node's JSON.parse tolerates BOM but the file is ugly in diffs.
    # Don't use Set-Content / Out-File: PS 5.1 defaults to UTF-16-LE with BOM
    # or UTF-8-with-BOM (cmdlet-dependent).
    [System.IO.File]::WriteAllText($tmp, $json, [System.Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $tmp -Destination $Path -Force
}

# ── State ─────────────────────────────────────────────────────────────────────
$Pids          = @()        # tracked child PIDs for cleanup
$Jobs          = @()        # tracked PS job IDs (log tail)
$OllamaStarted = $false     # true only when this script launched ollama

# ── Cleanup wrapper ───────────────────────────────────────────────────────────
# Everything meaningful happens inside this try/finally. Ctrl+C, Die, uncaught
# exception, or normal exit — the finally always fires.
# Style: 4-space indent inside try/finally, +4 per nested if/foreach/function.
try {

    # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    #  SETUP SECTION
    # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    $doSetup = $Setup.IsPresent -or $SetupOnly.IsPresent

    if ($doSetup) {

        Write-Host ""
        Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        Write-Host "  SolveWatch AI — First-Time Setup (Windows)"
        Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

        # ── 1/6  winget ──────────────────────────────────────────────────────────
        Section "1/6  winget"
        if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
            Die "winget is required but not found. Install 'App Installer' from the Microsoft Store, or see: https://learn.microsoft.com/windows/package-manager/winget/"
        }
        Ok "winget available ($(winget --version))"

        # ── 2/6  Node.js ─────────────────────────────────────────────────────────
        Section "2/6  Node.js"
        if (Get-Command node -ErrorAction SilentlyContinue) {
            Ok "Node.js $(node --version) already installed."
        } else {
            Log "Installing Node.js LTS via winget..."
            winget install -e --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
            Refresh-Path
            if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
                Die "Node.js install appeared to succeed but 'node' is not on PATH. Restart PowerShell and re-run -Setup."
            }
            Ok "Node.js installed."
        }

        # ── 3/6  Python 3.11 ─────────────────────────────────────────────────────
        Section "3/6  Python 3.11"
        $pythonVersion = $null
        foreach ($cmd in @('py','python3.11','python3','python')) {
            $gc = Get-Command $cmd -ErrorAction SilentlyContinue
            if ($null -ne $gc) {
                $v = & $cmd --version 2>&1
                if ($v -match 'Python 3\.(11|12)\.') { $pythonVersion = $v; break }
            }
        }
        if ($null -ne $pythonVersion) {
            Ok "$pythonVersion already installed."
        } else {
            Log "Installing Python 3.11 via winget..."
            winget install -e --id Python.Python.3.11 --accept-package-agreements --accept-source-agreements
            Refresh-Path
            $found = $false
            foreach ($cmd in @('py','python3.11','python')) {
                if (Get-Command $cmd -ErrorAction SilentlyContinue) { $found = $true; break }
            }
            if (-not $found) {
                Die "Python 3.11 install appeared to succeed but not on PATH. Restart PowerShell and re-run -Setup."
            }
            Ok "Python 3.11 installed."
        }

        # ── 4/6  Ollama (local LLM) ──────────────────────────────────────────────
        Section "4/6  Ollama (local LLM)"
        if (Get-Command ollama -ErrorAction SilentlyContinue) {
            Ok "Ollama already installed."
        } else {
            Log "Installing Ollama via winget..."
            winget install -e --id Ollama.Ollama --accept-package-agreements --accept-source-agreements
            Refresh-Path
            if (-not (Get-Command ollama -ErrorAction SilentlyContinue)) {
                Die "Ollama install appeared to succeed but 'ollama' is not on PATH. Restart PowerShell and re-run -Setup."
            }
            Ok "Ollama installed."
        }

        # Start ollama serve temporarily to pull the model, then stop.
        Log "Starting Ollama server (temporary — will restart during runtime)..."
        $ollamaSetupProc = Start-Process -FilePath ollama -ArgumentList 'serve' -PassThru -WindowStyle Hidden
        Start-Sleep -Seconds 3

        $OllamaModel = Get-ConfigValue 'ollama_model' 'llama3.2:1b'
        Log "Pulling Ollama model: $OllamaModel (first run: may take several minutes)"
        & ollama pull $OllamaModel
        if ($LASTEXITCODE -eq 0) {
            Ok "Model $OllamaModel ready."
        } else {
            Warn "Could not pull $OllamaModel. Classifier will fall back to remote providers."
        }

        if ($OllamaModel -eq 'llama3.2:1b') {
            Info "Tip: run 'ollama pull llama3.2:3b' for a more accurate (but slower) classifier."
        }

        # Stop the temporary Ollama; runtime section will restart it properly.
        try { Stop-Process -Id $ollamaSetupProc.Id -ErrorAction SilentlyContinue } catch {}
        Start-Sleep -Seconds 1

        # ── 5/6  Node.js dependencies ────────────────────────────────────────────
        Section "5/6  Node.js dependencies"
        Log "Running npm install..."
        & npm install --silent
        if ($LASTEXITCODE -ne 0) { Die "npm install failed. Check output above." }
        Ok "Node.js packages installed."

        # ── 6/6  Python transcriber dependencies ─────────────────────────────────
        Section "6/6  Python transcriber dependencies"
        if (-not (Test-Path "$TranscriberDir\venv")) {
            Log "Creating Python virtual environment..."
            # Prefer the py launcher with explicit -3.11 so we land on 3.11 even
            # if a newer Python is also installed on the machine.
            $pyOk = $false
            if (Get-Command py -ErrorAction SilentlyContinue) {
                & py -3.11 -m venv "$TranscriberDir\venv" 2>$null
                if ($LASTEXITCODE -eq 0) { $pyOk = $true }
            }
            if (-not $pyOk) {
                & python -m venv "$TranscriberDir\venv"
                if ($LASTEXITCODE -ne 0) { Die "venv creation failed." }
            }
        }

        Log "Installing/updating Python dependencies..."
        & $VenvPip install -q --upgrade pip
        & $VenvPip install -q -r "$TranscriberDir\requirements.txt"
        if ($LASTEXITCODE -ne 0) { Die "pip install (base) failed." }

        if ($Gpu) {
            Log "Installing GPU (CUDA) wheels..."
            & $VenvPip install -q -r "$TranscriberDir\requirements-gpu.txt"
            if ($LASTEXITCODE -ne 0) { Die "pip install (gpu) failed." }
            Ok "CUDA wheels installed."
        }

        Ok "Python venv ready."

        # ── Setup-complete banner ────────────────────────────────────────────────
        $NodePortBanner = Get-ConfigValue 'port' 4000
        Write-Host ""
        Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        Write-Host "  Setup complete!"
        Write-Host ""
        Write-Host "  Next steps:"
        Write-Host ""
        Write-Host "  1. Add your API keys:"
        Write-Host "     Open config\api-keys.json (copy from api-keys.json.example)"
        Write-Host "     Or open http://localhost:$NodePortBanner/settings after starting."
        Write-Host ""
        Write-Host "  2. Keys you may need (need at least one):"
        Write-Host "     OpenAI   -> https://platform.openai.com/api-keys"
        Write-Host "     Groq     -> https://console.groq.com/keys"
        Write-Host "     Gemini   -> https://aistudio.google.com/app/apikey"
        Write-Host "     Claude   -> https://console.anthropic.com/settings/api-keys"
        Write-Host ""
        Write-Host "  3. Ollama (free, local - already installed)"
        Write-Host "     Default classifier model: $OllamaModel"
        Write-Host "     More models:"
        Write-Host "       ollama pull llama3.2:1b   # fast, 1.3 GB"
        Write-Host "       ollama pull llama3.2:3b   # accurate, 2 GB"
        Write-Host "       ollama pull llama3.1:8b   # best quality, 5 GB"
        Write-Host ""
        Write-Host "  4. Start the app:"
        Write-Host "     powershell -ExecutionPolicy Bypass -File start.ps1"
        Write-Host ""
        Write-Host "  5. Open settings in browser:"
        Write-Host "     http://localhost:$NodePortBanner/settings"
        Write-Host ""
        Write-Host "  6. Toggle HUD overlay: Ctrl+Shift+H"
        Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        Write-Host ""

        if ($SetupOnly) {
            # Exit cleanly — finally block still runs to tidy up if anything was started.
            return
        }
    }

    # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    #  RUNTIME SECTION
    # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    # ── Preflight ─────────────────────────────────────────────────────────────
    foreach ($cmd in @('node','npm')) {
        if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
            Die "$cmd not found. Run: powershell -ExecutionPolicy Bypass -File start.ps1 -Setup"
        }
    }
    if (-not (Test-Path $VenvPython)) {
        Die "Python venv not found at $TranscriberDir\venv. Run: powershell -ExecutionPolicy Bypass -File start.ps1 -Setup"
    }
    if (-not (Test-Path $ElectronBin)) {
        Warn "node_modules missing or Electron shim absent. Running npm install..."
        & npm install --silent
        if (-not (Test-Path $ElectronBin)) { Die "Electron still not found after npm install. Re-run -Setup." }
    }

    # ── Ollama background start ───────────────────────────────────────────────
    if (Get-Command ollama -ErrorAction SilentlyContinue) {
        $running = Get-Process -Name ollama -ErrorAction SilentlyContinue
        if ($null -eq $running) {
            Log "Starting Ollama server in background..."
            $ollamaProc = Start-Process -FilePath ollama -ArgumentList 'serve' -PassThru -WindowStyle Hidden
            $Pids += $ollamaProc.Id
            $OllamaStarted = $true
            Start-Sleep -Seconds 2
            Ok "Ollama server started (PID $($ollamaProc.Id))."
        } else {
            Ok "Ollama server already running (not managed by this script)."
        }
    } else {
        Warn "Ollama not installed - local LLM classifier unavailable. Run: -Setup"
    }

    # ── Log directory setup ───────────────────────────────────────────────────
    New-Item -ItemType Directory -Path $LogsDir -Force | Out-Null
    if ($NewLogs) {
        Log "Clearing all logs (-NewLogs)..."
        Get-ChildItem "$LogsDir\*" -Include *.log,*.jsonl,*.json,*.ndjson -File -Force -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
        Ok "Logs cleared."
    }

    Write-Host ""
    Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    Write-Host "  SolveWatch AI — starting services"
    Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    Write-Host ""

    # ── Read runtime config ───────────────────────────────────────────────────
    $NodePort     = Get-ConfigValue 'port' 4000
    $WhisperModel = Get-ConfigValue 'stt_model' 'small'
    $AudioDevice  = Get-ConfigValue 'audio_input_device' ''

    # ── Clean up any stale processes from a previous run ──────────────────────
    Log "Checking for stale services from a previous run..."
    Stop-StaleServices -NodePort $NodePort -TranscriberPort 8000

    # ── 1. Node.js backend ────────────────────────────────────────────────────
    Log "Starting Node.js backend (port $NodePort)..."
    $nodeProc = Start-Process -FilePath node -ArgumentList 'src\server.js' -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $LogsDir 'node-stdout.log') -RedirectStandardError (Join-Path $LogsDir 'node-stderr.log')
    $Pids += $nodeProc.Id
    Wait-ForPort -Port $NodePort -Label 'Node.js backend' -LogHint $AppJsonLog

    # ── 2. Python transcriber ─────────────────────────────────────────────────
    # POLISH-03 dial 3: them-channel uses heavier distil-large-v3 by default for
    # better interviewer-side recovery. Me-channel stays on $WhisperModel (lighter,
    # mic input is cleaner so smaller model suffices). User can override via
    # `$env:STT_MODEL_THEM = "..."` before invoking start.bat to change this.
    if (-not $env:STT_MODEL_THEM) { $env:STT_MODEL_THEM = 'distil-large-v3' }
    Log "Starting Python transcriber (me=$WhisperModel, them=$env:STT_MODEL_THEM)..."
    # Pass WHISPER_MODEL and AUDIO_INPUT_DEVICE via env, matching start.sh.
    $env:WHISPER_MODEL      = $WhisperModel
    $env:AUDIO_INPUT_DEVICE = $AudioDevice
    # Start-Process rejects identical stdout+stderr paths, so split them: stdout
    # goes to transcriber.log (the one the tail job reads), stderr to a sibling
    # file for post-mortem inspection.
    $PythonErrLog = Join-Path $LogsDir 'transcriber-err.log'
    $pyProc = Start-Process -FilePath $VenvPython -ArgumentList (Join-Path $TranscriberDir 'main.py') -PassThru -WindowStyle Hidden -RedirectStandardOutput $PythonLog -RedirectStandardError $PythonErrLog
    $Pids += $pyProc.Id
    Ok "Python transcriber started (PID $($pyProc.Id))."

    # ── 3. Electron HUD ───────────────────────────────────────────────────────
    Log "Starting Electron HUD..."
    $electronProc = Start-Process -FilePath $ElectronBin -ArgumentList 'electron\main.js' -PassThru -WindowStyle Hidden
    $Pids += $electronProc.Id
    Ok "Electron HUD started (PID $($electronProc.Id))."

    # ── 04-02 D-09 step 2: wait for Python transcriber on :8000 ───────────────
    # Transcriber first-run may be slower than Node because faster-whisper has
    # to load its model weights. 30s default in Wait-ForPort is adequate for
    # subsequent runs; if the model cache is cold, set -NoHide and let the
    # user watch the output.
    Wait-ForPort -Port 8000 -Label 'Python transcriber' -LogHint $PythonLog

    # ── 04-03 D-12: write pidfile BEFORE sentinel wait so Electron's readPidfile
    # sees a ready file at app.whenReady time (Q6 revised ordering).
    # ollamaPid / ollamaStartedByScript come from the earlier Ollama-launch block;
    # $ollamaProc is only defined when $OllamaStarted===true.
    $pidData = @{
        nodePid               = $nodeProc.Id
        pyPid                 = $pyProc.Id
        ollamaPid             = if ($OllamaStarted) { $ollamaProc.Id } else { $null }
        scriptPid             = $PID
        ollamaStartedByScript = $OllamaStarted
        timestamp             = (Get-Date).ToString('o')   # ISO 8601 for cross-platform parse
    }
    Write-PidFile -Path (Join-Path $LogsDir 'pids.json') -Data $pidData
    Ok "Wrote pidfile: $(Join-Path $LogsDir 'pids.json')"

    # ── 04-02 D-09 step 3: wait for Electron ready sentinel ────────────────────
    Wait-ForElectronReady

    # ── 04-02 D-08: all three services confirmed up → hide the console ────────
    # -NoHide short-circuits this inside Hide-ConsoleWindow. On mid-run failure,
    # the watch loop's break path calls Show-ConsoleWindow before falling into
    # finally so the user sees the error + Read-Host pause.
    Hide-ConsoleWindow

    # ── Status summary ────────────────────────────────────────────────────────
    Write-Host ""
    Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    Write-Host "  All services running" -ForegroundColor Green
    Write-Host ""
    Write-Host "  Services:"
    Write-Host "  Node.js      -> PID $($nodeProc.Id)"
    Write-Host "  Transcriber  -> PID $($pyProc.Id)"
    Write-Host "  Electron HUD -> PID $($electronProc.Id)"
    Write-Host ""
    Write-Host "  Log files:"
    Write-Host "  Structured JSON  -> logs\app.jsonl"
    Write-Host "  Transcriber text -> logs\transcriber.log"
    Write-Host ""
    # Resolve the actual HUD-toggle binding from config/hotkeys.json (if saved),
    # otherwise fall back to the factory default. Keeps the console reference line
    # accurate after the user rebinds in Settings.
    $hudAccelDisplay = 'Ctrl+Shift+H'
    $hotkeysPath = Join-Path (Get-Location) 'config\hotkeys.json'
    if (Test-Path -LiteralPath $hotkeysPath) {
        try {
            $hotkeysCfg = Get-Content -LiteralPath $hotkeysPath -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
            if ($hotkeysCfg -and $hotkeysCfg.hud_toggle) {
                $hudAccelDisplay = ($hotkeysCfg.hud_toggle -replace 'CommandOrControl', 'Ctrl') -replace 'CmdOrCtrl', 'Ctrl'
            }
        } catch {
            # Corrupt or unreadable file — leave default display.
        }
    }
    Write-Host "  Quick links:"
    Write-Host "  Settings page   -> http://localhost:$NodePort/settings"
    Write-Host "  Toggle HUD      -> $hudAccelDisplay"
    Write-Host "  Stop everything -> Ctrl+C"
    Write-Host ""
    Write-Host "  STT model: $WhisperModel"
    Write-Host "  Behaviour: Questions are classified and answered automatically"
    Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    Write-Host ""

    # ── Tail Python log in a background job ───────────────────────────────────
    Log "Tailing Python transcriber log (Ctrl+C to stop everything)..."
    $tailJob = Start-Job -ScriptBlock {
        param($Path)
        # Block until the file exists (Python may be slower than this job to create it).
        while (-not (Test-Path $Path)) { Start-Sleep -Milliseconds 200 }
        Get-Content -Wait -Tail 0 -Path $Path
    } -ArgumentList $PythonLog
    $Jobs += $tailJob.Id

    # ── Block until Node or Python exits ──────────────────────────────────────
    # Electron is NOT polled here: its .cmd shim spawns the real electron.exe and
    # exits, so $electronProc.Id dies almost immediately even though the HUD is
    # alive. The finally block's Stop-Process -Name electron handles HUD cleanup.
    # Give services a couple seconds to settle before we start checking liveness.
    Start-Sleep -Seconds 2

    while ($true) {
        Receive-Job -Id $tailJob.Id | ForEach-Object {
            Write-Host "[transcriber] $_" -ForegroundColor Yellow
        }
        $aliveNode = Get-Process -Id $nodeProc.Id -ErrorAction SilentlyContinue
        $alivePy   = Get-Process -Id $pyProc.Id   -ErrorAction SilentlyContinue
        if ($null -eq $aliveNode) {
            Show-ConsoleWindow   # 04-02 D-10: re-show before falling into finally so user sees the error
            Log "Node.js backend (PID $($nodeProc.Id)) exited. Shutting down the rest..."
            Warn "Check logs\node-stderr.log for details."
            break
        }
        if ($null -eq $alivePy) {
            Show-ConsoleWindow   # 04-02 D-10: re-show before falling into finally so user sees the error
            Log "Python transcriber (PID $($pyProc.Id)) exited. Shutting down the rest..."
            Warn "Check logs\transcriber-err.log for details."
            break
        }
        Start-Sleep -Milliseconds 500
    }

} finally {
    # 04-02 D-10: Ensure console is visible for cleanup output AND the Read-Host prompt
    # below. Idempotent — if console was already visible (e.g., -NoHide, or SW_HIDE never
    # fired because we Die'd before the readiness gate), this is a no-op.
    Show-ConsoleWindow

    Write-Host ""
    Log "Shutting down all services..."
    foreach ($procId in $Pids) {
        try { Stop-Process -Id $procId -ErrorAction SilentlyContinue } catch {}
    }
    # Belt-and-suspenders: Electron via the .cmd shim may leave the child .exe alive.
    try { Stop-Process -Name electron -ErrorAction SilentlyContinue } catch {}
    if ($OllamaStarted) {
        try { Stop-Process -Name ollama -ErrorAction SilentlyContinue } catch {}
    }
    foreach ($jobId in $Jobs) {
        try { Stop-Job -Id $jobId -ErrorAction SilentlyContinue; Remove-Job -Id $jobId -Force -ErrorAction SilentlyContinue } catch {}
    }

    # 04-02: remove the readiness sentinel so the next run doesn't see a stale file.
    try { Remove-Item -LiteralPath (Join-Path $LogsDir '.electron-ready') -ErrorAction SilentlyContinue } catch {}

    # 04-03: pidfile cleanup — alongside the sentinel so both ephemeral state
    # files are gone by the time the next start.bat runs.
    try { Remove-Item -LiteralPath (Join-Path $LogsDir 'pids.json')        -ErrorAction SilentlyContinue } catch {}

    Ok "All services stopped."

    # 04-02 D-10: pause so the user can read error messages before the console vanishes.
    # Only prompt when console was hidden at some point (i.e., not -NoHide). With
    # -NoHide, the user is already watching a live console and Ctrl+C-triggered shutdowns
    # shouldn't pause.
    if (-not $NoHide.IsPresent) {
        Read-Host 'Press Enter to close'
    }
}
