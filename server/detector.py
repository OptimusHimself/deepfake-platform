"""Audio deepfake detector registry and inference helpers.

Only models that passed a sanity check on the demo's own Qwen3-TTS output are
exposed here. Each detector returns a per-window fake probability in [0, 1].
"""

from __future__ import annotations

from model_loading import serialized_load

import importlib.util
import os
import sys
import threading
from pathlib import Path
from typing import Any, Dict, List, Tuple

import numpy as np
import soundfile as sf
import torch
import torchaudio
from transformers import AutoFeatureExtractor, AutoModelForAudioClassification

BASE = Path(os.environ.get("DF_BASE", "/ssd/ai_security/deepfake-platform"))
SR = 16000
WINDOW = 4 * SR
HOP = 1 * SR
SPECTRA_SSL = BASE / "models" / "wav2vec2-xls-r-300m"

# Registry: model_id -> metadata. Add a model only after it scores fake samples
# higher than real ones on the internal sanity set.
DETECTORS: Dict[str, Dict[str, Any]] = {
    "spectra-aasist3": {
        "model_id": "spectra-aasist3",
        "display_name": "Spectra-AASIST3 · 多语言（推荐）",
        "short_name": "Spectra",
        "kind": "spectra",
        "dir": BASE / "models" / "Spectra-AASIST3",
        "depends_on": SPECTRA_SSL,
        "description": "XLS-R + KAN-AASIST；现代 TTS 多语言基准强。演示中中文真人判 real、Qwen 克隆判 fake；英文真人样本可能需复核。",
        "languages": "多语言（中文演示已通过）",
        "speed": "约 1–2s / 4s 窗口",
        "vram_gb": 4,
        "license": "Apache-2.0",
        "priority": 100,
        "version": "spectra-aasist3",
    },
    "xlsr-asvspoof": {
        "model_id": "xlsr-asvspoof",
        "display_name": "XLS-R 300M · ASVspoof 2019",
        "short_name": "XLS-R",
        "kind": "transformers",
        "dir": BASE / "models" / "wav2vec2-large-xlsr-deepfake",
        "description": "Wav2Vec2-XLS-R 微调；英文 ASVspoof 训练，中文合成音在演示中可被识别，但英文高质量克隆可能漏检。",
        "languages": "英文为主（中文可用但未充分训练）",
        "speed": "约 0.5–1s / 4s 窗口",
        "vram_gb": 2,
        "license": "未标注（研究用途，以 HF 仓库为准）",
        "priority": 80,
        "version": "xlsr-300m",
    },
}
AUTO_ORDER = ["spectra-aasist3", "xlsr-asvspoof"]
_MODELS: Dict[str, Tuple[Any, Any, int, Dict[str, Any]]] = {}
_LOCK = threading.Lock()


def _available(info: Dict[str, Any]) -> bool:
    if not Path(info["dir"]).exists():
        return False
    depends = info.get("depends_on")
    return not depends or Path(depends).exists()


def detector_status() -> List[Dict[str, Any]]:
    result = []
    for model_id in AUTO_ORDER:
        info = DETECTORS[model_id]
        result.append(
            {
                "model_id": model_id,
                "display_name": info["display_name"],
                "short_name": info["short_name"],
                "description": info["description"],
                "languages": info["languages"],
                "speed": info["speed"],
                "vram_gb": info["vram_gb"],
                "license": info["license"],
                "priority": info["priority"],
                "version": info["version"],
                "status": "ready" if _available(info) else "offline",
                "loaded": model_id in _MODELS,
            }
        )
    return result


def list_model_ids() -> List[str]:
    return [model_id for model_id in AUTO_ORDER if _available(DETECTORS[model_id])]


def auto_model_id() -> str:
    available = list_model_ids()
    if not available:
        raise RuntimeError("no audio deepfake detector is available")
    return max(available, key=lambda model_id: DETECTORS[model_id]["priority"])


def _load_spectra(info: Dict[str, Any]):
    model_dir = Path(info["dir"])
    os.environ.setdefault("SPECTRA_SSL_DIR", str(SPECTRA_SSL))
    model_py = model_dir / "model.py"
    source = model_py.read_text(encoding="utf-8")
    if "SPECTRA_SSL_DIR" not in source:
        source = "import os\n" + source
        source = source.replace(
            'Wav2Vec2Encoder("facebook/wav2vec2-xls-r-300m",',
            'Wav2Vec2Encoder(os.environ.get("SPECTRA_SSL_DIR", "facebook/wav2vec2-xls-r-300m"),',
        )
        model_py.write_text(source, encoding="utf-8")
    spec = importlib.util.spec_from_file_location("spectra_aasist3_model", model_py)
    if spec is None or spec.loader is None:
        raise RuntimeError("cannot load Spectra model.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules["spectra_aasist3_model"] = module
    spec.loader.exec_module(module)
    model = module.SpectraAASIST3.from_pretrained(str(model_dir)).to("cuda:0").eval()
    return None, model, 0, info


@serialized_load
def load_detector(model_id: str):
    if model_id not in DETECTORS:
        raise KeyError(f"unknown detector: {model_id}")
    info = DETECTORS[model_id]
    with _LOCK:
        if model_id in _MODELS:
            return _MODELS[model_id]
        if not _available(info):
            raise FileNotFoundError(f"detector files not found: {model_id}")
        if info["kind"] == "spectra":
            loaded = _load_spectra(info)
        else:
            model_dir = Path(info["dir"])
            fe = AutoFeatureExtractor.from_pretrained(str(model_dir))
            model = AutoModelForAudioClassification.from_pretrained(str(model_dir)).to("cuda:0").eval()
            fake_idx = next(
                (int(i) for i, label in model.config.id2label.items() if str(label).lower() == "fake"),
                0,
            )
            loaded = (fe, model, fake_idx, info)
        _MODELS[model_id] = loaded
        return loaded


def load_audio(path: Path) -> Tuple[np.ndarray, float]:
    audio, sr = sf.read(str(path), dtype="float32", always_2d=False)
    if getattr(audio, "ndim", 1) > 1:
        audio = audio.mean(axis=1)
    if sr != SR:
        audio = torchaudio.functional.resample(torch.from_numpy(audio), sr, SR).numpy()
    audio = np.asarray(audio, dtype=np.float32)
    return audio, round(len(audio) / SR, 3)


def make_windows(audio: np.ndarray) -> Tuple[List[np.ndarray], List[float]]:
    if len(audio) < WINDOW:
        audio = np.pad(audio, (0, WINDOW - len(audio)))
    starts = list(range(0, max(1, len(audio) - WINDOW + 1), HOP))
    if not starts:
        starts = [0]
    chunks = [audio[start:start + WINDOW] for start in starts]
    return chunks, [round(start / SR, 3) for start in starts]


def score_windows(model_id: str, audio: np.ndarray) -> Tuple[List[float], List[float]]:
    fe, model, fake_idx, info = load_detector(model_id)
    chunks, starts = make_windows(audio)
    scores: List[float] = []
    if info["kind"] == "spectra":
        batch_size = 4
        for offset in range(0, len(chunks), batch_size):
            tensors = []
            for chunk in chunks[offset:offset + batch_size]:
                x = torch.from_numpy(np.asarray(chunk, dtype=np.float32)).unsqueeze(0)
                x = torchaudio.functional.preemphasis(x).squeeze(0)
                if len(x) < 64600:
                    repeats = int(64600 / max(1, len(x))) + 1
                    x = x.repeat(repeats)[:64600]
                else:
                    x = x[:64600]
                tensors.append(x)
            batch = torch.stack(tensors).to("cuda:0")
            with torch.inference_mode():
                logits = model(batch)
                probs = torch.softmax(logits, dim=-1).cpu().numpy()
            scores.extend(float(x) for x in probs[:, 0])
        return scores, starts

    batch_size = 8
    for offset in range(0, len(chunks), batch_size):
        batch = chunks[offset:offset + batch_size]
        inputs = fe(batch, sampling_rate=SR, return_tensors="pt", padding=True)
        inputs = {key: value.to("cuda:0") for key, value in inputs.items()}
        with torch.inference_mode():
            logits = model(**inputs).logits
            probs = torch.softmax(logits, dim=-1).cpu().numpy()
        scores.extend(float(x) for x in probs[:, fake_idx])
    return scores, starts
