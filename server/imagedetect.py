"""Face-swap image detector: EfficientNet-B4 + Grad-CAM.

Checkpoint: honi05/deepfake-detection (MIT), trained on Celeb-DF v2.
The checkpoint is a plain torchvision EfficientNet-B4 state dict with a
256-unit binary head; see README.md for the expected layout.
"""

from __future__ import annotations

import io
import os
import threading
from pathlib import Path
from typing import Any, Dict, List, Tuple

import cv2
import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F
from PIL import Image, ImageOps
from torchvision import transforms
from torchvision.models import efficientnet_b4
from efficientnet_pytorch import EfficientNet
from insightface.utils import face_align

BASE = Path(os.environ.get("DF_BASE", "/ssd/ai_security/deepfake-platform"))
CHECKPOINT = BASE / "models" / "face-detector" / "best_model.pt"
DFB_CHECKPOINT = BASE / "models" / "face-detector" / "effnb4_best.pth"
BUFFALO_DIR = BASE / "models" / "buffalo_l"
MAX_SIDE = 4096
THRESHOLD = 0.58
_lock = threading.Lock()
_state: Dict[str, Any] = {"model": None, "dfb": None, "app": None, "device": None, "providers": []}

TRANSFORM = transforms.Compose(
    [
        transforms.Resize((224, 224)),
        transforms.ToTensor(),
        transforms.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225]),
    ]
)
DFB_TRANSFORM = transforms.Compose(
    [
        transforms.Resize((256, 256)),
        transforms.ToTensor(),
        transforms.Normalize([0.5, 0.5, 0.5], [0.5, 0.5, 0.5]),
    ]
)

# Normalized facial zones on the 224x224 crop. Coordinates are (x1, y1, x2, y2).
ZONES = {
    "forehead": (0.12, 0.05, 0.88, 0.30),
    "eyes": (0.08, 0.26, 0.92, 0.48),
    "nose": (0.30, 0.38, 0.70, 0.67),
    "mouth": (0.24, 0.60, 0.76, 0.82),
    "jaw": (0.04, 0.72, 0.96, 0.99),
}


class NoFaceError(ValueError):
    pass


def _providers() -> list[str]:
    try:
        import onnxruntime

        available = onnxruntime.get_available_providers()
    except Exception:
        return ["CPUExecutionProvider"]
    if "CUDAExecutionProvider" in available:
        return ["CUDAExecutionProvider", "CPUExecutionProvider"]
    return ["CPUExecutionProvider"]


def _build_model() -> nn.Module:
    model = efficientnet_b4(weights=None)
    model.classifier = nn.Sequential(
        nn.Dropout(0.4),
        nn.Linear(1792, 256),
        nn.ReLU(inplace=True),
        nn.Dropout(0.2),
        nn.Linear(256, 1),
    )
    state = torch.load(str(CHECKPOINT), map_location="cpu", weights_only=True)
    if isinstance(state, dict) and "model_state_dict" in state:
        state = state["model_state_dict"]
    model.load_state_dict(state, strict=True)
    return model


class _DFBModel(nn.Module):
    """DeepfakeBench EfficientNet-B4 (FF++ checkpoint), binary head."""

    def __init__(self):
        super().__init__()
        self.efficientnet = EfficientNet.from_name("efficientnet-b4")
        self.efficientnet._conv_stem = nn.Conv2d(3, 48, kernel_size=3, stride=2, bias=False)
        self.efficientnet._fc = nn.Identity()
        self.last_layer = nn.Linear(1792, 2)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        features = self.efficientnet.extract_features(x)
        pooled = F.adaptive_avg_pool2d(features, (1, 1)).flatten(1)
        return self.last_layer(pooled)


def _build_dfb() -> nn.Module:
    model = _DFBModel()
    state = torch.load(str(DFB_CHECKPOINT), map_location="cpu", weights_only=True)
    if isinstance(state, dict) and "model_state_dict" in state:
        state = state["model_state_dict"]
    model.load_state_dict({key.replace("backbone.", ""): value for key, value in state.items()}, strict=True)
    return model


def _load():
    with _lock:
        if _state["model"] is not None:
            return _state["model"], _state["dfb"], _state["app"], _state["device"]
        if not CHECKPOINT.exists():
            raise FileNotFoundError(f"face detector checkpoint missing: {CHECKPOINT}")
        from insightface.app import FaceAnalysis

        providers = _providers()
        app = FaceAnalysis(
            name="buffalo_l",
            root=str(BASE),
            allowed_modules=["detection"],
            providers=providers,
        )
        app.prepare(ctx_id=0 if "CUDAExecutionProvider" in providers else -1, det_size=(640, 640))
        device = "cuda:0" if torch.cuda.is_available() else "cpu"
        model = _build_model().to(device).eval()
        dfb = _build_dfb().to(device).eval() if DFB_CHECKPOINT.exists() else None
        _state.update({"model": model, "dfb": dfb, "app": app, "device": device, "providers": providers})
        return model, dfb, app, device


def status() -> Dict[str, Any]:
    return {
        "model_id": "effnet-b4-celebdf",
        "display_name": "EffNet-B4 ensemble · Celeb-DF + FF++",
        "task": "detect.image",
        "status": "ready" if CHECKPOINT.exists() and BUFFALO_DIR.exists() else "offline",
        "loaded": _state["model"] is not None,
        "providers": _state["providers"],
        "license": "MIT + DeepfakeBench 权重（研究用途）",
        "description": "Celeb-DF 与 FF++ 两个 EffNet-B4 检测器集成；输出整脸框、top-2 区域和热图。",
    }


def _read_image(data: bytes) -> np.ndarray:
    try:
        image = Image.open(io.BytesIO(data))
        image = ImageOps.exif_transpose(image).convert("RGB")
    except Exception as exc:
        raise ValueError("无法读取图片") from exc
    if max(image.size) > MAX_SIDE:
        image.thumbnail((MAX_SIDE, MAX_SIDE), Image.Resampling.LANCZOS)
    return cv2.cvtColor(np.asarray(image), cv2.COLOR_RGB2BGR)


def _square_crop(image: np.ndarray, bbox: np.ndarray, margin: float = 0.22) -> Tuple[np.ndarray, Tuple[int, int, int, int]]:
    x1, y1, x2, y2 = [float(v) for v in bbox[:4]]
    cx, cy = (x1 + x2) / 2, (y1 + y2) / 2
    side = max(x2 - x1, y2 - y1) * (1 + 2 * margin)
    left = int(max(0, cx - side / 2))
    top = int(max(0, cy - side / 2))
    right = int(min(image.shape[1], cx + side / 2))
    bottom = int(min(image.shape[0], cy + side / 2))
    if right - left < 8 or bottom - top < 8:
        raise NoFaceError("人脸区域太小")
    return image[top:bottom, left:right], (left, top, right, bottom)


def _gradcam(model: nn.Module, tensor: torch.Tensor, device: str) -> Tuple[float, np.ndarray]:
    activations: List[torch.Tensor] = []
    gradients: List[torch.Tensor] = []
    target = model.features[8]

    def forward_hook(_module, _inputs, output):
        activations.append(output)

    def backward_hook(_module, _grad_input, grad_output):
        gradients.append(grad_output[0])

    h1 = target.register_forward_hook(forward_hook)
    h2 = target.register_full_backward_hook(backward_hook)
    try:
        model.zero_grad(set_to_none=True)
        with torch.enable_grad():
            x = tensor.to(device).requires_grad_(True)
            logit = model(x).reshape(-1)[0]
            prob = float(torch.sigmoid(logit).detach().cpu())
            logit.backward()
        act = activations[0][0].detach()
        grad = gradients[0][0].detach()
        weights = grad.mean(dim=(1, 2), keepdim=True)
        cam = torch.relu((weights * act).sum(dim=0))
        cam = cam / (cam.max() + 1e-8)
        cam = cam.cpu().numpy()
        return prob, cam
    finally:
        h1.remove()
        h2.remove()


def _zones(cam: np.ndarray, crop_box: Tuple[int, int, int, int]) -> List[Dict[str, Any]]:
    left, top, right, bottom = crop_box
    width, height = right - left, bottom - top
    resized = cv2.resize(cam, (224, 224), interpolation=cv2.INTER_LINEAR)
    values = []
    for name, (x1, y1, x2, y2) in ZONES.items():
        region = resized[int(y1 * 224):int(y2 * 224), int(x1 * 224):int(x2 * 224)]
        values.append((name, float(region.mean()) if region.size else 0.0, x1, y1, x2, y2))
    values.sort(key=lambda item: item[1], reverse=True)
    result = []
    for name, energy, x1, y1, x2, y2 in values[:2]:
        result.append(
            {
                "zone": name,
                "energy": round(energy, 4),
                "bbox": [
                    int(left + x1 * width),
                    int(top + y1 * height),
                    int(left + x2 * width),
                    int(top + y2 * height),
                ],
            }
        )
    return result


def _draw(image: np.ndarray, faces: List[Dict[str, Any]]) -> np.ndarray:
    out = image.copy()
    for face in faces:
        x1, y1, x2, y2 = [int(v) for v in face["bbox"]]
        fake = face["verdict"] == "fake"
        color = (54, 56, 224) if fake else (110, 170, 60)
        if fake and face.get("heatmap") is not None:
            crop = out[y1:y2, x1:x2]
            if crop.size:
                heat = cv2.applyColorMap(np.uint8(face["heatmap"] * 255), cv2.COLORMAP_JET)
                heat = cv2.resize(heat, (crop.shape[1], crop.shape[0]))
                out[y1:y2, x1:x2] = cv2.addWeighted(crop, 0.58, heat, 0.42, 0)
        cv2.rectangle(out, (x1, y1), (x2, y2), color, 2)
        label = f"{'FAKE' if fake else 'REAL'} {face['score'] * 100:.0f}%"
        cv2.putText(out, label, (x1, max(18, y1 - 7)), cv2.FONT_HERSHEY_SIMPLEX, 0.55, color, 2, cv2.LINE_AA)
        if fake:
            for zone in face["zones"]:
                zx1, zy1, zx2, zy2 = [int(v) for v in zone["bbox"]]
                cv2.rectangle(out, (zx1, zy1), (zx2, zy2), (28, 28, 255), 1)
                cv2.putText(out, zone["zone"], (zx1 + 2, max(12, zy1 - 3)), cv2.FONT_HERSHEY_SIMPLEX, 0.38, (28, 28, 255), 1, cv2.LINE_AA)
    return out


def _score_dfb(model: nn.Module, aligned: np.ndarray, device: str) -> float:
    rgb = cv2.cvtColor(aligned, cv2.COLOR_BGR2RGB)
    tensor = DFB_TRANSFORM(Image.fromarray(rgb)).unsqueeze(0).to(device)
    with torch.inference_mode():
        logits = model(tensor)
        return float(torch.softmax(logits, dim=1)[0, 1].item())


def detect(data: bytes) -> Tuple[Dict[str, Any], bytes]:
    model, dfb, app, device = _load()
    image = _read_image(data)
    faces = app.get(image)
    if not faces:
        raise NoFaceError("没有检测到人脸")
    results: List[Dict[str, Any]] = []
    for face in faces:
        crop, _ = _square_crop(image, face.bbox)
        rgb = cv2.cvtColor(crop, cv2.COLOR_BGR2RGB)
        tensor = TRANSFORM(Image.fromarray(rgb)).unsqueeze(0)
        celeb_prob, cam = _gradcam(model, tensor, device)
        dfb_prob = None
        if dfb is not None:
            aligned = face_align.norm_crop(image, face.kps, image_size=256)
            dfb_prob = _score_dfb(dfb, aligned, device)
            prob = max(celeb_prob, dfb_prob)
        else:
            prob = celeb_prob
        verdict = "fake" if prob >= THRESHOLD else "real"
        results.append(
            {
                "bbox": [int(round(float(v))) for v in face.bbox[:4]],
                "det_score": round(float(face.det_score), 4),
                "score": round(prob, 4),
                "scores": {"celeb_df": round(celeb_prob, 4), "ffpp": round(dfb_prob, 4) if dfb_prob is not None else None},
                "verdict": verdict,
                "zones": _zones(cam, [int(round(float(v))) for v in face.bbox[:4]]) if verdict == "fake" else [],
                "heatmap": cam if verdict == "fake" else None,
            }
        )
    results.sort(key=lambda item: item["score"], reverse=True)
    top = results[0]
    score = max(face["score"] for face in results)
    verdict = "fake" if score >= THRESHOLD else "real"
    confidence = "high" if score >= 0.8 or score <= 0.2 else "medium"
    overlay = _draw(image, results)
    ok, encoded = cv2.imencode(".png", overlay)
    if not ok:
        raise RuntimeError("PNG 编码失败")
    top_zone = top["zones"][0]["zone"] if top["zones"] else None
    report: Dict[str, Any] = {
        "schema_version": "1.0",
        "modality": "image",
        "verdict": verdict,
        "score": round(score, 4),
        "threshold": THRESHOLD,
        "confidence": confidence,
        "model_version": "effnet-b4-celebdf+ffpp",
        "models": [
            {
                "model_id": "effnet-b4-celebdf",
                "score": round(max(face["scores"]["celeb_df"] for face in results), 4),
                "weight": 0.5,
                "calibrated": False,
                "faces": len(results),
            },
            {
                "model_id": "effnet-b4-ffpp",
                "score": round(max(face["scores"]["ffpp"] for face in results), 4) if dfb is not None else 0.0,
                "weight": 0.5 if dfb is not None else 0.0,
                "calibrated": False,
                "faces": len(results),
            },
        ],
        "regions": [face["bbox"] for face in results],
        "faces": [
            {key: value for key, value in face.items() if key != "heatmap"}
            for face in results
        ],
        "frames": [],
        "segments": [],
        "explanations": [
            f"检测到 {len(results)} 张人脸；最高 fake 分数 {score:.2%}",
            "两个 EffNet-B4 检测器取较高分；阈值在内部小样本上校准",
            f"最可疑区域：{top_zone}" if top_zone else "未发现超过阈值的面部区域",
        ],
        "warnings": [
            "检测分数不是司法鉴定结论；压缩、裁剪、重绘都会影响结果",
            "检测器在 Celeb-DF v2 / FF++ 上训练，对训练集外的新生成器可能漏检或误报",
            "阈值 58% 是在少量内部样本上校准的，尚未做正式 EER/FPR 评估",
            "区域框来自 Grad-CAM 的粗粒度归因，不代表像素级篡改定位",
        ],
        "processing": {"width": int(image.shape[1]), "height": int(image.shape[0]), "faces": len(results)},
        "artifacts": {},
    }
    return report, encoded.tobytes()
