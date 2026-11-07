"""Video deepfake detection with RealForensics (CSN-r101, CVPR 2022).

Model source: https://github.com/ahaliassos/RealForensics (MIT).
Checkpoint: realforensics_ff.pth (FF++ trained), placed in models/realforensics.
"""

from __future__ import annotations

from model_loading import serialized_load

import os
import sys
import tempfile
import threading
from pathlib import Path
from typing import Any, Dict, List, Tuple

import cv2
import numpy as np
import torch
import torch.nn as nn
from PIL import Image
from torchvision import transforms

BASE = Path(os.environ.get("DF_BASE", "/ssd/ai_security/deepfake-platform"))
VENDOR = BASE / "vendor" / "RealForensics"
CHECKPOINT = BASE / "models" / "realforensics" / "realforensics_ff.pth"
NUM_FRAMES = 25
FACE_SIZE = 140
INPUT_SIZE = 112
_lock = threading.Lock()
_state: Dict[str, Any] = {"model": None, "app": None, "device": None}

TRANSFORM = transforms.Compose(
    [
        transforms.ToTensor(),
        transforms.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225]),
    ]
)


def _providers() -> list[str]:
    try:
        import onnxruntime

        available = onnxruntime.get_available_providers()
    except Exception:
        return ["CPUExecutionProvider"]
    return ["CUDAExecutionProvider", "CPUExecutionProvider"] if "CUDAExecutionProvider" in available else ["CPUExecutionProvider"]


class _RealForensicsModel(nn.Module):
    def __init__(self):
        super().__init__()
        from stage2.models.backbones.csn import csn_temporal_no_head
        from stage2.models.linear import MeanLinear

        self.backbone = csn_temporal_no_head(model_depth=101, input_channel=3)
        self.df_head = MeanLinear(2048, 1, norm_linear=True, scale=64)

    def forward(self, frames: torch.Tensor) -> torch.Tensor:
        return self.df_head(self.backbone(frames))


@serialized_load
def _load():
    with _lock:
        if _state["model"] is not None:
            return _state["model"], _state["app"], _state["device"]
        if not CHECKPOINT.exists():
            raise FileNotFoundError(f"RealForensics checkpoint missing: {CHECKPOINT}")
        root = str(VENDOR)
        if root not in sys.path:
            sys.path.insert(0, root)
        from insightface.app import FaceAnalysis

        providers = _providers()
        app = FaceAnalysis(name="buffalo_l", root=str(BASE), allowed_modules=["detection"], providers=providers)
        app.prepare(ctx_id=0 if "CUDAExecutionProvider" in providers else -1, det_size=(640, 640))
        device = "cuda:0" if torch.cuda.is_available() else "cpu"
        model = _RealForensicsModel()
        state = torch.load(str(CHECKPOINT), map_location="cpu", weights_only=True)
        if isinstance(state, dict) and "state_dict" in state:
            state = state["state_dict"]
        backbone = {key[len("backbone."):]: value for key, value in state.items() if key.startswith("backbone.")}
        head = {key[len("df_head."):]: value for key, value in state.items() if key.startswith("df_head.")}
        model.backbone.load_state_dict(backbone, strict=True)
        model.df_head.load_state_dict(head, strict=True)
        model = model.to(device).eval()
        _state.update({"model": model, "app": app, "device": device})
        return model, app, device


def status() -> Dict[str, Any]:
    return {
        "model_id": "realforensics-ff",
        "display_name": "RealForensics CSN-r101",
        "task": "detect.video",
        "status": "ready" if CHECKPOINT.exists() and VENDOR.exists() else "offline",
        "loaded": _state["model"] is not None,
        "license": "MIT",
        "year": 2022,
        "description": "CVPR 2022，RealForensics FF++ 预训练；视觉时序检测，25 帧 / 112px。",
    }


def _read_video(path: str) -> List[Tuple[int, List[np.ndarray]]]:
    try:
        import decord

        reader = decord.VideoReader(path, ctx=decord.cpu(0))
        total = len(reader)
        if total == 0:
            raise ValueError("empty video")
        starts = list(range(0, max(1, total - NUM_FRAMES + 1), NUM_FRAMES))
        if not starts:
            starts = [0]
        if len(starts) > 8:
            starts = [int(v) for v in np.linspace(0, max(0, total - NUM_FRAMES), 8)]
        windows = []
        for start in starts:
            frames = []
            for index in range(start, start + NUM_FRAMES):
                if index >= total:
                    index = total - 1
                frame = reader[int(index)].asnumpy()
                frames.append(cv2.cvtColor(frame, cv2.COLOR_RGB2BGR))
            windows.append((start, frames))
        return windows
    except Exception:
        cap = cv2.VideoCapture(path)
        frames = []
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            frames.append(frame)
        cap.release()
        if not frames:
            raise ValueError("无法解码视频")
        while len(frames) < NUM_FRAMES:
            frames.append(frames[-1])
        windows = []
        starts = list(range(0, len(frames) - NUM_FRAMES + 1, NUM_FRAMES)) or [0]
        for start in starts[:8]:
            windows.append((start, frames[start:start + NUM_FRAMES]))
        return windows


def _contact_sheet(app, windows, segments, scores, fps=25.0) -> Tuple[bytes, List[Dict[str, Any]]]:
    order = sorted(range(len(scores)), key=lambda i: scores[i], reverse=True)[:4]
    tiles = []
    keyframes = []
    for rank, index in enumerate(order):
        start, frames = windows[index]
        frame = frames[len(frames) // 2]
        faces = app.get(frame)
        if faces:
            face = _largest_face(faces)
            x1, y1, x2, y2 = [int(v) for v in face.bbox]
            color = (40, 40, 220) if scores[index] >= 0.5 else (60, 160, 60)
            cv2.rectangle(frame, (x1, y1), (x2, y2), color, 3)
            keyframes.append({"time_s": round(start / fps + 0.5, 2), "score": round(scores[index], 4), "bbox": [x1, y1, x2, y2]})
        else:
            keyframes.append({"time_s": round(start / fps + 0.5, 2), "score": round(scores[index], 4), "bbox": None})
        label = f"{start / fps:.1f}s · {'fake' if scores[index] >= 0.5 else 'real'} {scores[index] * 100:.0f}%"
        cv2.putText(frame, label, (16, 40), cv2.FONT_HERSHEY_SIMPLEX, 1.0, (255, 255, 255), 3, cv2.LINE_AA)
        cv2.putText(frame, label, (16, 40), cv2.FONT_HERSHEY_SIMPLEX, 1.0, (20, 20, 20), 1, cv2.LINE_AA)
        target_h = 360
        target_w = int(frame.shape[1] * target_h / frame.shape[0])
        tiles.append(cv2.resize(frame, (target_w, target_h)))
    if not tiles:
        return b"", keyframes
    width = max(tile.shape[1] for tile in tiles)
    canvas = np.full((2 * 360 + 16, 2 * width + 16, 3), 245, dtype=np.uint8)
    for i, tile in enumerate(tiles):
        row, col = divmod(i, 2)
        y = row * 360 + 8
        x = col * width + 8
        canvas[y:y + 360, x:x + tile.shape[1]] = tile
        cv2.putText(canvas, f"#{i + 1}", (x + 8, y + 28), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (90, 90, 90), 2, cv2.LINE_AA)
    ok, encoded = cv2.imencode(".png", canvas)
    if not ok:
        return b"", keyframes
    return encoded.tobytes(), keyframes


def _largest_face(faces):
    return max(faces, key=lambda face: float((face.bbox[2] - face.bbox[0]) * (face.bbox[3] - face.bbox[1])))


def detect(data: bytes, suffix: str = ".mp4") -> Tuple[Dict[str, Any], List[float], bytes]:
    model, app, device = _load()
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as handle:
        handle.write(data)
        path = handle.name
    try:
        windows = _read_video(path)
    finally:
        Path(path).unlink(missing_ok=True)
    from insightface.utils import face_align

    clip_scores: List[float] = []
    segments = []
    for window_index, (start_frame, frames) in enumerate(windows):
        crops = []
        for frame in frames:
            faces = app.get(frame)
            if not faces:
                continue
            face = _largest_face(faces)
            aligned = face_align.norm_crop(frame, face.kps, image_size=224)
            # Keep the whole aligned face; a center crop cut off forehead/chin.
            crop = cv2.resize(aligned, (FACE_SIZE, FACE_SIZE))
            crop = cv2.resize(crop, (INPUT_SIZE, INPUT_SIZE))
            rgb = cv2.cvtColor(crop, cv2.COLOR_BGR2RGB)
            crops.append(TRANSFORM(Image.fromarray(rgb)))
        if len(crops) < max(10, NUM_FRAMES // 2):
            continue
        while len(crops) < NUM_FRAMES:
            crops.append(crops[-1])
        tensor = torch.stack(crops[:NUM_FRAMES], dim=1).unsqueeze(0).to(device)
        with torch.inference_mode():
            logit = model(tensor).reshape(-1)[0]
            score = float(torch.sigmoid(logit).item())
        clip_scores.append(score)
        start_s = round(start_frame / 25.0, 2)
        segments.append({"start_s": start_s, "end_s": round(start_s + 1.0, 2), "score": round(score, 4), "verdict": "fake" if score >= 0.5 else "real"})
    if not clip_scores:
        raise ValueError("有效人脸帧太少")
    contact, keyframes = _contact_sheet(app, windows, segments, clip_scores)
    score = max(clip_scores)
    verdict = "fake" if score >= 0.5 else "real"
    confidence = "high" if score >= 0.8 or score <= 0.2 else "medium"
    report = {
        "schema_version": "1.0",
        "modality": "video",
        "verdict": verdict,
        "score": round(score, 4),
        "threshold": 0.5,
        "confidence": confidence,
        "model_version": "realforensics-ff",
        "models": [{"model_id": "realforensics-ff", "score": round(score, 4), "weight": 1.0, "calibrated": False}],
        "frames": keyframes,
        "segments": segments,
        "keyframes": keyframes,
        "explanations": [f"评估 {len(clip_scores)} 个 1s / 25 帧连续片段；最高 fake 分数 {score:.2%}"],
        "warnings": [
            "检测分数不是司法鉴定结论；压缩、裁剪、重编码都会影响结果",
            "RealForensics 在 FF++ 上训练；对 Seedance 2.5 等新生成器可能漏检",
        ],
        "processing": {"frames": NUM_FRAMES, "face_frames": NUM_FRAMES, "face_size": INPUT_SIZE, "clips": len(clip_scores), "clip_scores": [round(v, 4) for v in clip_scores]},
        "artifacts": {},
    }
    return report, [round(v, 4) for v in clip_scores], contact
