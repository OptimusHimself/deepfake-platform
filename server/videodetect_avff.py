"""AVFF (OpenAVFF) audio-visual video deepfake detector.

Unofficial PyTorch implementation of AVFF (CVPR 2024).
Weights: OpenAVFF Stage-3 (713.5MB), research use; verify license before external use.
"""

from __future__ import annotations

import os
import sys
import tempfile
import threading
from pathlib import Path
from typing import Any, Dict, Tuple

import torch

BASE = Path(os.environ.get("DF_BASE", "/ssd/ai_security/deepfake-platform"))
VENDOR = BASE / "vendor" / "OpenAVFF"
CHECKPOINT = BASE / "models" / "avff" / "stage-3.pth"
_lock = threading.Lock()
_state: Dict[str, Any] = {"model": None, "device": None}


def status() -> Dict[str, Any]:
    return {
        "model_id": "avff-stage3",
        "display_name": "AVFF (OpenAVFF Stage-3)",
        "task": "detect.video",
        "status": "ready" if CHECKPOINT.exists() and VENDOR.exists() else "offline",
        "loaded": _state["model"] is not None,
        "license": "未明确（非官方实现，仅研究验证）",
        "year": 2024,
        "description": "音画特征融合；视频 + 音频联合判断，适合正脸说话/lip-sync。",
    }


def _load():
    with _lock:
        if _state["model"] is not None:
            return _state["model"], _state["device"]
        if not CHECKPOINT.exists():
            raise FileNotFoundError(f"AVFF checkpoint missing: {CHECKPOINT}")
        root = str(VENDOR)
        if root not in sys.path:
            sys.path.insert(0, root)
        from src.models.video_cav_mae import VideoCAVMAEFT

        device = "cuda:0" if torch.cuda.is_available() else "cpu"
        model = VideoCAVMAEFT()
        state = torch.load(str(CHECKPOINT), map_location="cpu", weights_only=True)
        if isinstance(state, dict) and "state_dict" in state:
            state = state["state_dict"]
        if any(key.startswith("module.") for key in state):
            state = {key[len("module."):]: value for key, value in state.items()}
        model.load_state_dict(state, strict=True)
        model = model.to(device).eval()
        _state.update({"model": model, "device": device})
        return model, device


def _read_video_and_audio(path: str):
    import av
    import decord
    import numpy as np
    import torchaudio
    from PIL import Image
    from torchvision import transforms

    reader = decord.VideoReader(path, ctx=decord.cpu(0))
    total = len(reader)
    if total == 0:
        raise ValueError("empty video")
    indices = np.linspace(0, total - 1, 16).astype(int)
    preprocess = transforms.Compose(
        [
            transforms.CenterCrop(224),
            transforms.ToTensor(),
            transforms.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225]),
        ]
    )
    frames = torch.stack([preprocess(Image.fromarray(reader[int(i)].asnumpy())) for i in indices])

    container = av.open(path)
    stream = next((s for s in container.streams if s.type == "audio"), None)
    if stream is None:
        raise ValueError("视频没有音轨；AVFF 需要音频")
    resampler = av.AudioResampler(format="fltp", layout="mono", rate=16000)
    chunks = []
    for frame in container.decode(stream):
        for out in resampler.resample(frame):
            chunks.append(out.to_ndarray().reshape(-1))
    container.close()
    if not chunks:
        raise ValueError("无法解码音轨")
    waveform = torch.from_numpy(np.concatenate(chunks).astype("float32")).unsqueeze(0)
    waveform = waveform - waveform.mean()
    fbank = torchaudio.compliance.kaldi.fbank(
        waveform,
        htk_compat=True,
        sample_frequency=16000,
        use_energy=False,
        window_type="hanning",
        num_mel_bins=128,
        dither=0.0,
        frame_shift=10,
    )
    fbank = torch.nn.functional.interpolate(
        fbank.unsqueeze(0).transpose(1, 2), size=(1024,), mode="linear", align_corners=False
    ).transpose(1, 2).squeeze(0)
    fbank = (fbank - (-5.081)) / 4.4849
    return fbank, frames


def detect(data: bytes, suffix: str = ".mp4") -> Tuple[Dict[str, Any], float]:
    model, device = _load()
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as handle:
        handle.write(data)
        video_path = handle.name
    try:
        fbank, frames = _read_video_and_audio(video_path)
        audio = fbank.unsqueeze(0).to(device)
        video = frames.permute(1, 0, 2, 3).unsqueeze(0).to(device)
        with torch.inference_mode():
            logits = model(audio, video)
            # OpenAVFF/Inclusion CSVs use target 0 = real, 1 = fake.
            # The first output is the real-class logit; convert to fake probability.
            real_prob = float(torch.sigmoid(logits).reshape(-1)[0].item())
            score = 1.0 - real_prob
    finally:
        Path(video_path).unlink(missing_ok=True)
    verdict = "fake" if score >= 0.5 else "real"
    report = {
        "schema_version": "1.0",
        "modality": "video",
        "verdict": verdict,
        "score": round(score, 4),
        "threshold": 0.5,
        "confidence": "high" if score >= 0.8 or score <= 0.2 else "medium",
        "model_version": "avff-stage3",
        "models": [{"model_id": "avff-stage3", "score": round(score, 4), "weight": 1.0, "calibrated": False}],
        "frames": [],
        "segments": [{"start_s": 0.0, "end_s": None, "score": round(score, 4), "verdict": verdict}],
        "explanations": [f"AVFF 音画联合 fake 分数 {score:.2%}"],
        "warnings": [
            "检测分数不是司法鉴定结论；压缩、裁剪、重编码都会影响结果",
            "OpenAVFF 是非官方实现；许可证未明确，仅用于研究验证",
            "对 Seedance 2.5 等新生成器可能漏检",
        ],
        "processing": {"frames": 16, "face_frames": 16, "audio_bins": 128, "face_size": 224},
        "artifacts": {},
    }
    return report, score, b""
