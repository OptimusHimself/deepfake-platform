"""Evaluate candidate audio deepfake detectors on real/fake samples."""

from __future__ import annotations

import json
import time
from pathlib import Path

import numpy as np
import soundfile as sf
import torch
import torchaudio
from transformers import AutoFeatureExtractor, AutoModelForAudioClassification

BASE = Path("/ssd/ai_security/deepfake-platform")
MODELS = [
    ("wav2vec2-base-deepfake", BASE / "models/Deepfake-audio-detection"),
    ("wav2vec2-base-deepfake-v2", BASE / "models/Deepfake-audio-detection-V2"),
    ("wav2vec2-large-xlsr-asvspoof", BASE / "models/wav2vec2-large-xlsr-deepfake"),
]
SAMPLES = [
    ("real_clone", BASE / "cache/clone.wav", "real"),
    ("real_user_zh", BASE / "cache/user_ref.wav", "real"),
    ("fake_en", BASE / "cache/api_result.wav", "fake"),
    ("fake_zh", BASE / "cache/api_result_zh.wav", "fake"),
]
SR = 16000
WINDOW = 4 * SR
HOP = 1 * SR


def load_audio(path: Path) -> np.ndarray:
    audio, sr = sf.read(str(path), dtype="float32", always_2d=False)
    if getattr(audio, "ndim", 1) > 1:
        audio = audio.mean(axis=1)
    if sr != SR:
        audio = torchaudio.functional.resample(torch.from_numpy(audio), sr, SR).numpy()
    return np.asarray(audio, dtype=np.float32)


def windows(audio: np.ndarray):
    if len(audio) < WINDOW:
        audio = np.pad(audio, (0, WINDOW - len(audio)))
    starts = list(range(0, max(1, len(audio) - WINDOW + 1), HOP))
    if not starts:
        starts = [0]
    return [audio[s:s + WINDOW] for s in starts], starts


def main() -> None:
    device = "cuda" if torch.cuda.is_available() else "cpu"
    print("device", device, torch.cuda.get_device_name(0) if torch.cuda.is_available() else "", flush=True)
    for model_name, model_dir in MODELS:
        if not model_dir.exists():
            print(json.dumps({"model": model_name, "error": "missing"}), flush=True)
            continue
        print("loading", model_name, flush=True)
        t0 = time.time()
        fe = AutoFeatureExtractor.from_pretrained(str(model_dir))
        model = AutoModelForAudioClassification.from_pretrained(str(model_dir)).to(device).eval()
        fake_idx = next((int(i) for i, label in model.config.id2label.items() if str(label).lower() == "fake"), 0)
        print("loaded", model_name, round(time.time() - t0, 1), "s fake_idx", fake_idx, flush=True)
        for sample_name, path, truth in SAMPLES:
            audio = load_audio(path)
            chunks, starts = windows(audio)
            inputs = fe(chunks, sampling_rate=SR, return_tensors="pt", padding=True)
            inputs = {k: v.to(device) for k, v in inputs.items()}
            with torch.inference_mode():
                logits = model(**inputs).logits
                probs = torch.softmax(logits, dim=-1).cpu().numpy()
            scores = probs[:, fake_idx]
            result = {
                "model": model_name,
                "sample": sample_name,
                "truth": truth,
                "duration_s": round(len(audio) / SR, 2),
                "scores": [round(float(x), 4) for x in scores],
                "mean": round(float(np.mean(scores)), 4),
                "p90": round(float(np.percentile(scores, 90)), 4),
                "max": round(float(np.max(scores)), 4),
                "starts_s": [round(s / SR, 1) for s in starts],
            }
            print(json.dumps(result, ensure_ascii=False), flush=True)
        del model
        torch.cuda.empty_cache()


if __name__ == "__main__":
    main()
