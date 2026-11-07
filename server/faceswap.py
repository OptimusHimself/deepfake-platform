"""Image face swap, with selectable legacy and current models.

Registry:
  inswapper-128  InsightFace inswapper_128 (2023, 128x128, non-commercial)
  hyperswap-256 HyperSwap 1a 256 (FaceFusion 3.3, 2025, 256x256, ResearchRAIL)
"""

from __future__ import annotations

import io
import os
import threading
from pathlib import Path
from typing import Any, Dict, List, Tuple

import cv2
import numpy as np
from PIL import Image, ImageOps

BASE = Path(os.environ.get("DF_BASE", "/ssd/ai_security/deepfake-platform"))
MODEL_ROOT = BASE
BUFFALO_DIR = BASE / "models" / "buffalo_l"
INSWAPPER_PATH = BASE / "models" / "inswapper" / "inswapper_128.onnx"
HYPERSWAP_PATH = BASE / "models" / "hyperswap" / "hyperswap_1a_256.onnx"
MAX_SIDE = 4096
HYPER_SIZE = 256

# FaceFusion arcface_128 template (normalized coordinates).
ARCFACE_128 = np.array(
    [
        [0.36167656, 0.40387734],
        [0.63696719, 0.40235469],
        [0.50019687, 0.56044219],
        [0.38710391, 0.72160547],
        [0.61507734, 0.72034453],
    ],
    dtype=np.float32,
)

SWAPPERS: Dict[str, Dict[str, Any]] = {
    "hyperswap-256": {
        "model_id": "hyperswap-256",
        "display_name": "HyperSwap 256",
        "vendor": "FaceFusion",
        "year": 2025,
        "resolution": 256,
        "license": "ResearchRAIL（非商业研究）",
        "speed": "约 0.12s/张（A800，预热后；首张约 10s 加载）",
        "quality": "推荐：256px，身份和细节明显好于 inswapper 128",
        "path": HYPERSWAP_PATH,
        "min_size": 300 * 1024 * 1024,
        "legacy": False,
        "priority": 200,
    },
    "inswapper-128": {
        "model_id": "inswapper-128",
        "display_name": "InsightFace inswapper_128",
        "vendor": "InsightFace",
        "year": 2023,
        "resolution": 128,
        "license": "非商业研究（InsightFace 模型权重）",
        "speed": "约 0.15s/张（A800，预热后）",
        "quality": "旧版基线：128px，侧脸/遮挡较弱",
        "path": INSWAPPER_PATH,
        "min_size": 500 * 1024 * 1024,
        "legacy": True,
        "priority": 100,
    },
}
AUTO_ORDER = ["hyperswap-256", "inswapper-128"]

_lock = threading.Lock()
_state: Dict[str, Any] = {"app": None, "providers": [], "swappers": {}}


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


def _available(model_id: str) -> bool:
    info = SWAPPERS.get(model_id)
    if not info or not Path(info["path"]).exists() or not (BUFFALO_DIR / "w600k_r50.onnx").exists():
        return False
    return Path(info["path"]).stat().st_size >= int(info.get("min_size", 0))


def list_models() -> List[Dict[str, Any]]:
    result = []
    for model_id in AUTO_ORDER:
        info = SWAPPERS[model_id]
        result.append(
            {
                key: value
                for key, value in info.items()
                if key not in {"path"}
            }
            | {
                "available": _available(model_id),
                "loaded": model_id in _state["swappers"],
                "task": "image.face_swap",
            }
        )
    return result


def status() -> List[Dict[str, Any]]:
    return list_models()


def auto_model_id() -> str:
    available = [model_id for model_id in AUTO_ORDER if _available(model_id)]
    if not available:
        raise RuntimeError("no face swapper is available")
    return max(available, key=lambda model_id: SWAPPERS[model_id]["priority"])


def _get_app():
    with _lock:
        if _state["app"] is not None:
            return _state["app"], _state["providers"]
        from insightface.app import FaceAnalysis

        providers = _providers()
        app = FaceAnalysis(
            name="buffalo_l",
            root=str(MODEL_ROOT),
            allowed_modules=["detection", "recognition"],
            providers=providers,
        )
        app.prepare(ctx_id=0 if "CUDAExecutionProvider" in providers else -1, det_size=(640, 640))
        _state.update({"app": app, "providers": providers})
        return app, providers


def _load_swapper(model_id: str):
    if model_id not in SWAPPERS:
        raise KeyError(f"unknown swapper: {model_id}")
    with _lock:
        if model_id in _state["swappers"]:
            return _state["swappers"][model_id]
        info = SWAPPERS[model_id]
        path = Path(info["path"])
        if not path.exists():
            raise FileNotFoundError(f"face swapper missing: {path}")
        providers = _state["providers"] or _providers()
        if model_id == "inswapper-128":
            from insightface.model_zoo import get_model

            swapper = get_model(str(path), providers=providers)
        else:
            import onnxruntime

            swapper = onnxruntime.InferenceSession(str(path), providers=providers)
        _state["swappers"][model_id] = swapper
        return swapper


def _read_image(data: bytes) -> np.ndarray:
    try:
        image = Image.open(io.BytesIO(data))
        image = ImageOps.exif_transpose(image).convert("RGB")
    except Exception as exc:
        raise ValueError("无法读取图片") from exc
    if max(image.size) > MAX_SIDE:
        image.thumbnail((MAX_SIDE, MAX_SIDE), Image.Resampling.LANCZOS)
    return cv2.cvtColor(np.asarray(image), cv2.COLOR_RGB2BGR)


def _largest_face(faces):
    if not faces:
        raise NoFaceError("没有检测到人脸")
    return max(faces, key=lambda face: float((face.bbox[2] - face.bbox[0]) * (face.bbox[3] - face.bbox[1])))


def _warp_face(image: np.ndarray, kps: np.ndarray) -> Tuple[np.ndarray, np.ndarray]:
    template = ARCFACE_128 * HYPER_SIZE
    matrix = cv2.estimateAffinePartial2D(kps.astype(np.float32), template, method=cv2.RANSAC, ransacReprojThreshold=100)[0]
    crop = cv2.warpAffine(image, matrix, (HYPER_SIZE, HYPER_SIZE), borderMode=cv2.BORDER_REPLICATE, flags=cv2.INTER_AREA)
    return crop, matrix


def _paste_face(target: np.ndarray, crop: np.ndarray, matrix: np.ndarray) -> np.ndarray:
    height, width = target.shape[:2]
    inverse = cv2.invertAffineTransform(matrix)
    warped = cv2.warpAffine(crop, inverse, (width, height), borderMode=cv2.BORDER_REPLICATE)
    mask = np.zeros((HYPER_SIZE, HYPER_SIZE), dtype=np.uint8)
    cv2.ellipse(mask, (HYPER_SIZE // 2, int(HYPER_SIZE * 0.55)), (int(HYPER_SIZE * 0.37), int(HYPER_SIZE * 0.46)), 0, 0, 360, 255, -1)
    mask = cv2.GaussianBlur(mask, (31, 31), 0).astype(np.float32) / 255.0
    mask_back = cv2.warpAffine(mask, inverse, (width, height))[:, :, None]
    return (target.astype(np.float32) * (1 - mask_back) + warped.astype(np.float32) * mask_back).clip(0, 255).astype(np.uint8)


def _swap_hyperswap(model_id: str, app, source_img: np.ndarray, target_img: np.ndarray, source_face, target_face) -> np.ndarray:
    swapper = _load_swapper(model_id)
    crop, matrix = _warp_face(target_img, target_face.kps)
    target = crop[:, :, ::-1].astype(np.float32) / 255.0
    target = (target - 0.5) / 0.5
    target = np.expand_dims(target.transpose(2, 0, 1), axis=0)
    source = np.asarray(source_face.normed_embedding, dtype=np.float32).reshape(1, -1)
    input_names = {item.name for item in swapper.get_inputs()}
    feed = {}
    if "source" in input_names:
        feed["source"] = source
    if "target" in input_names:
        feed["target"] = target
    if not feed:
        raise RuntimeError(f"unsupported HyperSwap inputs: {sorted(input_names)}")
    output = swapper.run(None, feed)[0][0]
    output = output.transpose(1, 2, 0) * 0.5 + 0.5
    output = (output.clip(0, 1)[:, :, ::-1] * 255).astype(np.uint8)
    return _paste_face(target_img, output, matrix)


def swap(source_bytes: bytes, target_bytes: bytes, model_id: str = "auto") -> Tuple[bytes, Dict[str, Any]]:
    if model_id in {"", "auto", None}:
        model_id = auto_model_id()
    if model_id not in SWAPPERS:
        raise KeyError(f"unknown swapper: {model_id}")
    app, _ = _get_app()
    source_img = _read_image(source_bytes)
    target_img = _read_image(target_bytes)
    source_faces = app.get(source_img)
    target_faces = app.get(target_img)
    source_face = _largest_face(source_faces)
    target_face = _largest_face(target_faces)
    if model_id == "inswapper-128":
        swapper = _load_swapper(model_id)
        with _lock:
            output = swapper.get(target_img, target_face, source_face, paste_back=True)
    elif model_id == "hyperswap-256":
        output = _swap_hyperswap(model_id, app, source_img, target_img, source_face, target_face)
    else:
        raise KeyError(f"unsupported swapper: {model_id}")
    ok, encoded = cv2.imencode(".png", output)
    if not ok:
        raise RuntimeError("PNG 编码失败")
    info = {
        "model_id": model_id,
        "model_year": SWAPPERS[model_id]["year"],
        "model_resolution": SWAPPERS[model_id]["resolution"],
        "source_faces": len(source_faces),
        "target_faces": len(target_faces),
        "source_face_box": [round(float(v), 2) for v in source_face.bbox],
        "target_face_box": [round(float(v), 2) for v in target_face.bbox],
        "input_size": [int(target_img.shape[1]), int(target_img.shape[0])],
        "output_size": [int(output.shape[1]), int(output.shape[0])],
    }
    return encoded.tobytes(), info
