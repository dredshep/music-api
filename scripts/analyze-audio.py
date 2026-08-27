#!/usr/bin/env python3
"""Extract lightweight DJ sequencing features from one audio file.

Uses Debian-packaged aubio + numpy so the production container is self-contained
on amd64 and arm64. Output is a single JSON object on stdout.
"""

from __future__ import annotations

import json
import math
import sys
from collections import deque

import aubio
import numpy as np

SAMPLE_RATE = 22050
HOP_SIZE = 512
WINDOW_SIZE = 2048
KEY_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
MAJOR_PROFILE = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88], dtype=float)
MINOR_PROFILE = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17], dtype=float)


def key_from_chroma(chroma: np.ndarray) -> tuple[str | None, str | None, float]:
    total = float(chroma.sum())
    if total <= 1e-9:
        return None, None, 0.0
    observed = chroma / total
    best_key = None
    best_mode = None
    best_score = -1.0
    for root in range(12):
        for mode, profile in (("major", MAJOR_PROFILE), ("minor", MINOR_PROFILE)):
            template = np.roll(profile / profile.sum(), root)
            score = float(np.dot(observed, template) / (np.linalg.norm(observed) * np.linalg.norm(template) + 1e-12))
            if score > best_score:
                best_score = score
                best_key = KEY_NAMES[root]
                best_mode = mode
    return best_key, best_mode, best_score


def frame_features(samples: np.ndarray, sr: int) -> tuple[float, float, float, np.ndarray]:
    if not np.any(samples):
        return 0.0, 0.0, 0.0, np.zeros(12, dtype=float)
    rms = float(np.sqrt(np.mean(np.square(samples, dtype=np.float64))))
    zcr = float(np.mean(np.abs(np.diff(np.signbit(samples))).astype(float))) if len(samples) > 1 else 0.0
    window = np.hanning(len(samples))
    spectrum = np.abs(np.fft.rfft(samples * window))
    freqs = np.fft.rfftfreq(len(samples), d=1.0 / sr)
    magnitude = float(spectrum.sum())
    centroid = float(np.dot(freqs, spectrum) / magnitude) if magnitude > 1e-9 else 0.0

    chroma = np.zeros(12, dtype=float)
    valid = (freqs >= 55.0) & (freqs <= 5000.0) & (spectrum > 0)
    if np.any(valid):
        midi = 69.0 + 12.0 * np.log2(freqs[valid] / 440.0)
        pcs = np.mod(np.rint(midi).astype(int), 12)
        for pc, mag in zip(pcs, spectrum[valid], strict=False):
            chroma[int(pc)] += float(mag)
    return rms, centroid, zcr, chroma


def summarize_levels(levels: list[float]) -> dict[str, float]:
    if not levels:
        return {"rms": 0.0, "dbfs": -120.0}
    rms = float(np.mean(levels))
    return {"rms": rms, "dbfs": 20.0 * math.log10(max(rms, 1e-6))}


def analyze(filename: str) -> dict[str, object]:
    source = aubio.source(filename, SAMPLE_RATE, HOP_SIZE)
    sr = int(source.samplerate)
    tempo = aubio.tempo("default", WINDOW_SIZE, HOP_SIZE, sr)

    rms_values: list[float] = []
    centroids: list[float] = []
    zcr_values: list[float] = []
    bpm_values: list[float] = []
    chroma = np.zeros(12, dtype=float)
    intro_levels: list[float] = []
    outro_levels: deque[float] = deque(maxlen=max(1, int(10 * sr / HOP_SIZE)))
    frame_index = 0
    intro_frame_limit = max(1, int(10 * sr / HOP_SIZE))

    while True:
        samples, read = source()
        if read <= 0:
            break
        values = np.asarray(samples[:read], dtype=np.float64)
        rms, centroid, zcr, frame_chroma = frame_features(values, sr)
        rms_values.append(rms)
        centroids.append(centroid)
        zcr_values.append(zcr)
        chroma += frame_chroma
        if frame_index < intro_frame_limit:
            intro_levels.append(rms)
        outro_levels.append(rms)

        tempo(samples)
        if tempo.get_last() > 0:
            bpm = float(tempo.get_bpm())
            if 40.0 <= bpm <= 240.0:
                bpm_values.append(bpm)
        frame_index += 1
        if read < HOP_SIZE:
            break

    if not rms_values:
        raise RuntimeError("audio decoder returned no samples")

    rms_mean = float(np.mean(rms_values))
    loudness = 20.0 * math.log10(max(rms_mean, 1e-6))
    # A bounded, monotonic energy proxy. It is deliberately not advertised as a
    # Spotify-compatible energy score; it is only used for relative DJ ordering.
    energy = float(np.clip(rms_mean * 5.0 + np.std(rms_values) * 2.0, 0.0, 1.0))
    bpm = float(np.median(bpm_values)) if bpm_values else None
    key, mode, key_confidence = key_from_chroma(chroma)

    return {
        "bpm": bpm,
        "key": key,
        "mode": mode,
        "loudness": loudness,
        "energy": energy,
        "timbre": {
            "spectral_centroid_mean": float(np.mean(centroids)),
            "spectral_centroid_std": float(np.std(centroids)),
            "zero_crossing_rate_mean": float(np.mean(zcr_values)),
        },
        "rhythm": {
            "bpm": bpm,
            "beat_observations": len(bpm_values),
            "key_confidence": key_confidence,
        },
        "intro": summarize_levels(intro_levels),
        "outro": summarize_levels(list(outro_levels)),
        "analysis": {
            "sample_rate": sr,
            "hop_size": HOP_SIZE,
            "frames": frame_index,
            "engine": "aubio+numpy",
        },
    }


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: analyze-audio.py AUDIO_FILE", file=sys.stderr)
        return 2
    try:
        print(json.dumps(analyze(sys.argv[1]), separators=(",", ":"), allow_nan=False))
        return 0
    except Exception as exc:  # noqa: BLE001 - command boundary
        print(str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
