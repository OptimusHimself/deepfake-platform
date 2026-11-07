"""Image protection: CLIP PGD perturbation + DwtDctSvd watermark + certificate."""

from __future__ import annotations

from model_loading import serialized_load

import hashlib
import hmac
import io
import json
import os
import secrets
import threading
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Tuple

import cv2
import numpy as np
import torch
import torch.nn.functional as F
from PIL import Image, ImageOps
from skimage.metrics import peak_signal_noise_ratio, structural_similarity
from transformers import CLIPModel, CLIPProcessor

BASE = Path(os.environ.get("DF_BASE", "/ssd/ai_security/deepfake-platform"))
CLIP_DIR = BASE / "models" / "clip-vit-base-patch32"
TOKEN = os.environ.get("GATEWAY_TOKEN", "")
MAX_SIDE = 1280
STRENGTHS = {
    "low": {"eps": 1 / 255, "steps": 8, "label": "低"},
    "medium": {"eps": 2 / 255, "steps": 16, "label": "中"},
    "high": {"eps": 4 / 255, "steps": 24, "label": "高"},
}
CLIP_MEAN = torch.tensor([0.48145466, 0.4578275, 0.40821073]).view(1, 3, 1, 1)
CLIP_STD = torch.tensor([0.26862954, 0.26130258, 0.27577711]).view(1, 3, 1, 1)
_lock = threading.Lock()
_state: Dict[str, Any] = {"model": None, "processor": None, "device": None}


@serialized_load
def _load():
    with _lock:
        if _state["model"] is not None:
            return _state["model"], _state["processor"], _state["device"]
        if not CLIP_DIR.exists():
            raise FileNotFoundError(f"CLIP model missing: {CLIP_DIR}")
        device = "cuda:0" if torch.cuda.is_available() else "cpu"
        processor = CLIPProcessor.from_pretrained(str(CLIP_DIR))
        model = CLIPModel.from_pretrained(str(CLIP_DIR)).to(device).eval()
        _state.update({"model": model, "processor": processor, "device": device})
        return model, processor, device


def status() -> Dict[str, Any]:
    return {
        "model_id": "clip-pgd-dwtdctsvd",
        "display_name": "CLIP PGD + DwtDctSvd",
        "task": "defend.image",
        "status": "ready" if CLIP_DIR.exists() else "offline",
        "loaded": _state["model"] is not None,
        "license": "CLIP MIT；水印算法 DwtDctSvd",
        "description": "对本人图片加不可感知扰动与水印，输出保护图和保护证书。",
    }


def _read_image(data: bytes) -> Image.Image:
    try:
        image = Image.open(io.BytesIO(data))
        image = ImageOps.exif_transpose(image).convert("RGB")
    except Exception as exc:
        raise ValueError("无法读取图片") from exc
    if max(image.size) > MAX_SIDE:
        image.thumbnail((MAX_SIDE, MAX_SIDE), Image.Resampling.LANCZOS)
    return image


def _to_bgr(image: Image.Image) -> np.ndarray:
    return cv2.cvtColor(np.asarray(image), cv2.COLOR_RGB2BGR)


def _from_tensor(tensor: torch.Tensor) -> Image.Image:
    arr = (tensor.detach().cpu() * CLIP_STD + CLIP_MEAN).clamp(0, 1)
    arr = (arr[0].permute(1, 2, 0).numpy() * 255).round().astype(np.uint8)
    return Image.fromarray(arr, mode="RGB")


def _watermark(image: Image.Image, wm_id: str) -> Tuple[Image.Image, bool, str]:
    try:
        from imwatermark import WatermarkDecoder, WatermarkEncoder

        bgr = _to_bgr(image)
        encoder = WatermarkEncoder()
        payload = wm_id.encode("utf-8")[:8].ljust(8, b"\0")
        encoder.set_watermark("bytes", payload)
        marked = encoder.encode(bgr, method="dwtDctSvd")
        decoder = WatermarkDecoder("bytes", 64)
        decoded = decoder.decode(marked, method="dwtDctSvd")
        match = decoded[:8] == payload
        rgb = cv2.cvtColor(marked, cv2.COLOR_BGR2RGB)
        return Image.fromarray(rgb, mode="RGB"), match, decoded.hex()
    except Exception:
        return image, False, ""


def protect(data: bytes, strength: str = "medium") -> Tuple[bytes, Dict[str, Any], Dict[str, Any]]:
    model, processor, device = _load()
    image = _read_image(data)
    cfg = STRENGTHS.get(strength) or STRENGTHS["medium"]
    pixel = processor(images=image, return_tensors="pt")["pixel_values"].to(device)
    eps = float(cfg["eps"])
    with torch.inference_mode():
        original = model.get_image_features(pixel_values=pixel)
    adv = pixel.clone().detach().requires_grad_(True)
    alpha = eps / 4.0
    for _ in range(int(cfg["steps"])):
        features = model.get_image_features(pixel_values=adv)
        loss = -F.cosine_similarity(features, original, dim=-1).mean()
        grad = torch.autograd.grad(loss, adv)[0]
        with torch.no_grad():
            adv = torch.clamp(adv + alpha * grad.sign(), pixel - eps, pixel + eps)
        adv.requires_grad_(True)
    # Apply the 224px perturbation to the original-resolution image instead of
    # upscaling the whole (already resampled) image. This keeps fine detail.
    orig = torch.from_numpy(np.asarray(image, dtype=np.float32) / 255.0).permute(2, 0, 1).unsqueeze(0)
    delta = (adv.detach().cpu() - pixel.detach().cpu()) * CLIP_STD
    delta = F.interpolate(delta, size=(image.height, image.width), mode="bilinear", align_corners=False)
    protected_arr = (orig + delta).clamp(0, 1)[0].permute(1, 2, 0).numpy()
    protected = Image.fromarray((protected_arr * 255).round().astype(np.uint8), mode="RGB")
    wm_id = secrets.token_hex(4)
    protected, wm_match, wm_decoded = _watermark(protected, wm_id)
    before = np.asarray(image, dtype=np.float32)
    after = np.asarray(protected, dtype=np.float32)
    psnr = float(peak_signal_noise_ratio(before, after, data_range=255))
    ssim = float(structural_similarity(before, after, channel_axis=2, data_range=255))
    metrics = {
        "psnr_db": round(psnr, 2),
        "ssim": round(ssim, 4),
        "watermark_id": wm_id,
        "watermark_match": bool(wm_match),
        "watermark_decoded": wm_decoded,
        "strength": strength,
        "eps": round(eps, 6),
        "steps": int(cfg["steps"]),
        "width": int(protected.width),
        "height": int(protected.height),
    }
    out = io.BytesIO()
    protected.save(out, format="PNG")
    payload = {
        "schema_version": "1.0",
        "certificate_id": f"cert_{secrets.token_hex(8)}",
        "created_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "file_sha256": hashlib.sha256(out.getvalue()).hexdigest(),
        "watermark_id": wm_id,
        "metrics": metrics,
        "method": "clip-pgd+dwtdctsvd",
        "notice": "保护只能降低被利用的概率，不保证阻止所有换脸/重绘/压缩攻击。",
    }
    signature = hmac.new(TOKEN.encode("utf-8"), json.dumps(payload, ensure_ascii=False, sort_keys=True).encode("utf-8"), hashlib.sha256).hexdigest()
    certificate = {**payload, "signature": signature, "signature_algorithm": "HMAC-SHA256"}
    return out.getvalue(), certificate, metrics
