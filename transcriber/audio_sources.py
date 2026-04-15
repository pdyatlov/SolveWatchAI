"""Resolve audio device indices for 'mic' and 'loopback' sources.

Priority for each source:
  1. Numeric index override in config/audio.json:
       {"mic_device_index": 2, "loopback_device_index": 27,
        "loopback_mode": "wasapi_output" | "input_device"}
  2. Substring override in config/audio.json (legacy):
       {"mic_device": "<substring>", "loopback_device": "<substring>"}
  3. Auto-detection:
       - mic:       sd.default.device[0] (system default input)
       - loopback:  first device whose name matches CABLE/BlackHole/etc.

Returns:
    {
      'mic':      (index, name) or (None, None),
      'loopback': (index, name, mode) or (None, None, None),
    }

mode is 'input_device' for traditional input-device loopback (VB-Cable etc.)
or 'wasapi_output' for native WASAPI loopback on an output device.

Auto-detect always yields mode='input_device'. 'wasapi_output' only ever
comes from an explicit config override.
"""
import json
import logging
import os
from pathlib import Path
from typing import Optional, Tuple

import sounddevice as sd

logger = logging.getLogger(__name__)

LOOPBACK_KEYWORDS = ('cable', 'blackhole', 'voicemeeter', 'loopback', 'vb-audio')


def _load_overrides() -> dict:
    """Read config/audio.json from repo root. Returns {} if missing/invalid."""
    # audio_sources.py lives in transcriber/; repo root is one level up.
    repo_root = Path(__file__).resolve().parent.parent
    path = repo_root / 'config' / 'audio.json'
    try:
        with open(path, 'r', encoding='utf-8') as f:
            data = json.load(f)
            if isinstance(data, dict):
                return data
    except FileNotFoundError:
        pass
    except Exception as e:
        logger.warning(f"Could not parse {path}: {e}")
    return {}


def _find_device_by_substring(devices, needle: str, input_only: bool) -> Optional[int]:
    """Case-insensitive substring match against device names.

    If input_only, require max_input_channels > 0 (skip output-only devices).
    Returns the device index or None.
    """
    if not needle:
        return None
    lo = needle.lower()
    for idx, dev in enumerate(devices):
        name = str(dev.get('name', ''))
        if lo in name.lower():
            if input_only and dev.get('max_input_channels', 0) <= 0:
                continue
            return idx
    return None


def _auto_detect_mic(devices) -> Optional[int]:
    """System default input, if it has input channels."""
    default = sd.default.device
    # default is either a single index or (input, output)
    if isinstance(default, (list, tuple)) and len(default) >= 1:
        idx = default[0]
    else:
        idx = default
    try:
        idx = int(idx)
    except (TypeError, ValueError):
        return None
    if idx < 0 or idx >= len(devices):
        return None
    if devices[idx].get('max_input_channels', 0) <= 0:
        return None
    return idx


def _auto_detect_loopback(devices) -> Optional[int]:
    """First input-capable device whose name matches a known loopback keyword."""
    for idx, dev in enumerate(devices):
        if dev.get('max_input_channels', 0) <= 0:
            continue
        name = str(dev.get('name', '')).lower()
        if any(k in name for k in LOOPBACK_KEYWORDS):
            return idx
    return None


def _query_hostapis_safe():
    try:
        return sd.query_hostapis()
    except Exception as e:
        logger.warning(f"sd.query_hostapis() failed: {e}")
        return []


def _hostapi_name(hostapis, hostapi_idx):
    if hostapi_idx is None:
        return ''
    try:
        idx = int(hostapi_idx)
    except (TypeError, ValueError):
        return ''
    if idx < 0 or idx >= len(hostapis):
        return ''
    return str(hostapis[idx].get('name', ''))


def resolve_audio_sources() -> dict:
    """Resolve devices for 'mic' and 'them' sources.

    Returns:
        {
          'mic':      (index, name) or (None, None),
          'loopback': (index, name, mode) or (None, None, None),
        }

    Never raises: any unexpected failure in override loading, auto-detection,
    or result assembly collapses to a safe empty result.
    """
    try:
        try:
            devices = sd.query_devices()
        except Exception as e:
            logger.error(f"sd.query_devices() failed: {e}")
            return {'mic': (None, None), 'loopback': (None, None, None)}

        overrides = _load_overrides()
        hostapis = _query_hostapis_safe()

        # -- mic -----------------------------------------------------------
        mic_idx = None
        idx_override = overrides.get('mic_device_index')
        if isinstance(idx_override, int) and 0 <= idx_override < len(devices):
            if devices[idx_override].get('max_input_channels', 0) > 0:
                mic_idx = idx_override
            else:
                logger.warning(
                    f"Ignoring mic_device_index={idx_override}: device has no input channels"
                )
        if mic_idx is None:
            mic_idx = _find_device_by_substring(
                devices, overrides.get('mic_device', ''), input_only=True
            )
        if mic_idx is None:
            mic_idx = _auto_detect_mic(devices)

        # -- loopback ------------------------------------------------------
        lb_idx = None
        lb_mode = 'input_device'
        idx_override = overrides.get('loopback_device_index')
        if isinstance(idx_override, int) and 0 <= idx_override < len(devices):
            requested_mode = overrides.get('loopback_mode', 'input_device')
            if requested_mode == 'wasapi_output':
                dev = devices[idx_override]
                api_name = _hostapi_name(hostapis, dev.get('hostapi'))
                if dev.get('max_output_channels', 0) > 0 and 'wasapi' in api_name.lower():
                    lb_idx = idx_override
                    lb_mode = 'wasapi_output'
                else:
                    logger.warning(
                        f"Ignoring loopback_device_index={idx_override} in wasapi_output mode: "
                        f"not a WASAPI output device (hostapi={api_name}, "
                        f"output_channels={dev.get('max_output_channels', 0)})"
                    )
            else:  # input_device
                if devices[idx_override].get('max_input_channels', 0) > 0:
                    lb_idx = idx_override
                    lb_mode = 'input_device'
                else:
                    logger.warning(
                        f"Ignoring loopback_device_index={idx_override}: device has no input channels"
                    )
        if lb_idx is None:
            sub = _find_device_by_substring(
                devices, overrides.get('loopback_device', ''), input_only=True
            )
            if sub is not None:
                lb_idx = sub
                lb_mode = 'input_device'
        if lb_idx is None:
            auto = _auto_detect_loopback(devices)
            if auto is not None:
                lb_idx = auto
                lb_mode = 'input_device'

        def _pair(idx):
            if idx is None:
                return (None, None)
            return (idx, str(devices[idx].get('name', f'device_{idx}')))

        def _triple(idx, mode):
            if idx is None:
                return (None, None, None)
            return (idx, str(devices[idx].get('name', f'device_{idx}')), mode)

        result = {'mic': _pair(mic_idx), 'loopback': _triple(lb_idx, lb_mode)}

        logger.info(
            "Audio sources resolved: mic=%s, loopback=%s",
            result['mic'], result['loopback'],
        )
        return result
    except Exception as e:
        logger.error(f"resolve_audio_sources() failed unexpectedly: {e}")
        return {'mic': (None, None), 'loopback': (None, None, None)}
