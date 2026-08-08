#!/usr/bin/env python3
"""Local transcription wrapper for OpenClaw audio notes.

Usage: transcribe.py <audio-path>

Uses faster-whisper (PyAV-bundled FFmpeg) on CPU with the small model in
int8 quantized mode. Prints the plain transcript to stdout and exits 0 on
success, matching the OpenClaw local-CLI contract in docs/nodes/audio.md.
"""
import os
import sys

# Prefer the persistent HF cache inside the container (survives container
# recreate); fall back to the default per-user cache otherwise.
os.environ.setdefault(
    "HF_HOME",
    "/home/node/.openclaw/local-tools/hf-cache",
)

from faster_whisper import WhisperModel

MODEL = "small"
DEVICE = "cpu"
COMPUTE_TYPE = "int8"


def main() -> int:
    if len(sys.argv) != 2 or not sys.argv[1]:
        print("usage: transcribe.py <audio-path>", file=sys.stderr)
        return 2
    audio_path = sys.argv[1]
    try:
        model = WhisperModel(MODEL, device=DEVICE, compute_type=COMPUTE_TYPE)
        segments, _info = model.transcribe(audio_path, beam_size=5)
        parts = [segment.text.strip() for segment in segments if segment.text and segment.text.strip()]
        if parts:
            print(" ".join(parts))
        return 0
    except Exception as exc:  # surface a short error; OpenClaw treats non-zero as failure
        print(f"transcription failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
