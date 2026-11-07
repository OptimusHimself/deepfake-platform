# -*- coding: utf-8 -*-
"""Build the 3-page DeepFake demo deck in the BIT review template style."""

from pathlib import Path

from lxml import etree
from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_CONNECTOR, MSO_SHAPE
from pptx.enum.text import MSO_ANCHOR, PP_ALIGN
from pptx.oxml.ns import qn
from pptx.util import Inches, Pt

ROOT = Path(__file__).resolve().parents[1]
SRC = Path(r"C:\Users\Matrix\Downloads\综述汇报deepfake主动防御.pptx")
OUT = ROOT / "DeepFake技术Demo_设计说明_3页.pptx"

# ---------- exact BIT template tokens ----------
SW, SH = 13.333, 7.5
GREEN = "006C39"
GREEN_DARK = "00522B"
BROWN = "A13F0B"
BLUE = "214F8D"
NAVY = "17283D"
GRAY = "617083"
LIGHT_GRAY = "A2A2A2"
RED = "C00000"
PALE_GREEN = "F1F8F4"
PALE_BLUE = "E7F0F9"
PALE_PINK = "FAEEE8"
WHITE = "FFFFFF"

YAHEI = "微软雅黑"
CENTURY = "Century Gothic"


def rgb(value):
    return RGBColor.from_string(value)


def set_ea(run, font):
    rPr = run._r.get_or_add_rPr()
    for tag in ("a:ea", "a:cs"):
        el = rPr.find(qn(tag))
        if el is None:
            el = etree.SubElement(rPr, qn(tag))
        el.set("typeface", font)


def style_run(run, text, size, color=NAVY, font=YAHEI, bold=False,
              italic=False, spc=None):
    run.text = text
    f = run.font
    f.name = font
    f.size = Pt(size)
    f.bold = bold
    f.italic = italic
    f.color.rgb = rgb(color)
    set_ea(run, font)
    if spc is not None:
        run._r.get_or_add_rPr().set("spc", str(int(spc * 100)))


def add_text(slide, x, y, w, h, paragraphs, anchor=MSO_ANCHOR.TOP,
             margins=(0, 0, 0, 0), name=None):
    box = slide.shapes.add_textbox(Inches(x), Inches(y), Inches(w), Inches(h))
    if name:
        box.name = name
    tf = box.text_frame
    tf.clear()
    tf.word_wrap = True
    tf.auto_size = None
    tf.vertical_anchor = anchor
    tf.margin_left, tf.margin_right, tf.margin_top, tf.margin_bottom = [
        Inches(v) for v in margins
    ]
    for idx, spec in enumerate(paragraphs):
        p = tf.paragraphs[0] if idx == 0 else tf.add_paragraph()
        p.alignment = spec.get("align", PP_ALIGN.LEFT)
        p.line_spacing = spec.get("line", 1.0)
        p.space_before = Pt(spec.get("before", 0))
        p.space_after = Pt(spec.get("after", 0))
        for text, opts in spec["runs"]:
            run = p.add_run()
            style_run(
                run,
                text,
                opts.get("size", spec.get("size", 12)),
                opts.get("color", spec.get("color", NAVY)),
                opts.get("font", spec.get("font", YAHEI)),
                opts.get("bold", spec.get("bold", False)),
                opts.get("italic", spec.get("italic", False)),
                opts.get("spc", spec.get("spc")),
            )
    return box


def add_rect(slide, x, y, w, h, fill=None, line=None, lw=1.0,
             shape=MSO_SHAPE.RECTANGLE, dash=None, name=None, radius=None):
    shp = slide.shapes.add_shape(shape, Inches(x), Inches(y), Inches(w), Inches(h))
    if name:
        shp.name = name
    if fill:
        shp.fill.solid()
        shp.fill.fore_color.rgb = rgb(fill)
    else:
        shp.fill.background()
    if line:
        shp.line.color.rgb = rgb(line)
        shp.line.width = Pt(lw)
        if dash is not None:
            shp.line.dash_style = dash
    else:
        shp.line.fill.background()
    shp.shadow.inherit = False
    if radius is not None and len(shp.adjustments) > 0:
        shp.adjustments[0] = radius
    return shp


def add_rule(slide, x1, y1, x2, y2, color=GREEN, width=1.0, dash=None):
    conn = slide.shapes.add_connector(
        MSO_CONNECTOR.STRAIGHT, Inches(x1), Inches(y1), Inches(x2), Inches(y2)
    )
    conn.line.color.rgb = rgb(color)
    conn.line.width = Pt(width)
    if dash is not None:
        conn.line.dash_style = dash
    conn.shadow.inherit = False
    return conn


def add_arrow(slide, x1, y1, x2, y2, color=GREEN, width=1.4, dash=None):
    conn = add_rule(slide, x1, y1, x2, y2, color, width, dash)
    ln = conn.line._get_or_add_ln()
    tail = etree.SubElement(ln, qn("a:tailEnd"))
    tail.set("type", "triangle")
    tail.set("w", "med")
    tail.set("len", "med")
    return conn


def add_circle_number(slide, x, y, d, number, color=BROWN, text_color=WHITE,
                      size=10.2):
    add_rect(slide, x, y, d, d, fill=color, line=None,
             shape=MSO_SHAPE.OVAL, name=f"Number {number}")
    add_text(slide, x, y, d, d,
             [{"runs": [(number, {"size": size, "color": text_color,
                                  "font": CENTURY, "bold": True})],
               "align": PP_ALIGN.CENTER}], anchor=MSO_ANCHOR.MIDDLE)


def add_page_number(slide, number):
    add_text(slide, 0.37, 0.20, 1.12, 0.58,
             [{"runs": [(number, {"size": 30, "color": WHITE,
                                  "font": CENTURY, "bold": True})],
               "align": PP_ALIGN.CENTER}], anchor=MSO_ANCHOR.MIDDLE)


def set_title(slide, text):
    title = slide.shapes.title
    title.left, title.top = Inches(1.76), Inches(0.37)
    title.width, title.height = Inches(8.92), Inches(0.54)
    tf = title.text_frame
    tf.clear()
    tf.word_wrap = True
    tf.auto_size = None
    tf.vertical_anchor = MSO_ANCHOR.MIDDLE
    tf.margin_left = tf.margin_right = Inches(0)
    tf.margin_top = tf.margin_bottom = Inches(0)
    p = tf.paragraphs[0]
    p.alignment = PP_ALIGN.LEFT
    p.line_spacing = 1.0
    r = p.add_run()
    style_run(r, text, 26, NAVY, YAHEI, True)
    return title


def note(slide, text):
    slide.notes_slide.notes_text_frame.text = text


# ---------- open template, keep its content-slide chrome ----------
prs = Presentation(SRC)
layout = prs.slides[3].slide_layout
sldIdLst = prs.slides._sldIdLst
for sldId in list(sldIdLst):
    prs.part.drop_rel(sldId.rId)
    sldIdLst.remove(sldId)

# ============================================================
# SLIDE 1 — positioning + three capabilities
# ============================================================
s = prs.slides.add_slide(layout)
set_title(s, "DeepFake 技术 Demo")
add_page_number(s, "3.1")

add_text(s, 0.58, 1.17, 8.0, 0.25,
         [{"runs": [("第三部分  /  PART 03  ·  平台设计",
                     {"size": 9.2, "color": GREEN, "bold": True, "spc": 0.5})]}])

add_text(s, 0.55, 1.50, 7.4, 0.72, [
    {"runs": [
        ("生成它。", {"size": 31, "color": NAVY, "bold": True}),
        ("识破它。", {"size": 31, "color": GREEN, "bold": True}),
        ("保护自己。", {"size": 31, "color": BROWN, "bold": True}),
    ]}
])

add_text(s, 7.85, 1.49, 4.88, 1.06, [
    {"runs": [
        ("本地优先的 DeepFake 实验平台。素材、任务与资产留在本机，推理交给 AutoDL GPU；"
         "同一套任务契约串联三项能力。",
         {"size": 10.8, "color": GRAY})
    ], "line": 1.45}
])

add_rule(s, 0.55, 2.83, 12.70, 2.83, GREEN, 0.9)

cards = [
    {
        "x": 0.55, "fill": PALE_GREEN, "accent": GREEN, "num": "01",
        "title": "生成", "en": "GENERATE",
        "desc": "克隆配音、说话视频、换脸与改口型。",
        "footer": "首个真模型：Qwen3-TTS 1.7B",
    },
    {
        "x": 4.70, "fill": PALE_BLUE, "accent": BLUE, "num": "02",
        "title": "检测", "en": "DETECT",
        "desc": "图片概率 + 红框；视频 / 音频时间轴。给出证据与警告。",
        "footer": "结论可解释 · 非司法鉴定",
    },
    {
        "x": 8.85, "fill": PALE_PINK, "accent": BROWN, "num": "03",
        "title": "主动防御", "en": "DEFEND",
        "desc": "对抗扰动 + 水印 + 保护证书。只处理本人或授权素材。",
        "footer": "降低风险 · 不保证免疫",
    },
]

for c in cards:
    add_rect(s, c["x"], 3.03, 3.85, 2.44, fill=c["fill"], line=None,
             name=f"Capability {c['num']}")
    add_rect(s, c["x"], 3.03, 3.85, 0.055, fill=c["accent"])
    add_circle_number(s, c["x"] + 0.24, 3.22, 0.52, c["num"])
    add_text(s, c["x"] + 0.91, 3.20, 2.5, 0.31,
             [{"runs": [(c["title"], {"size": 17.5, "color": c["accent"],
                                      "bold": True})]}])
    add_text(s, c["x"] + 0.92, 3.55, 2.5, 0.2,
             [{"runs": [(c["en"], {"size": 7.4, "color": GRAY,
                                   "font": CENTURY, "spc": 1.1})]}])
    add_text(s, c["x"] + 0.25, 3.93, 3.35, 0.76,
             [{"runs": [(c["desc"], {"size": 10.7, "color": NAVY})], "line": 1.38}])
    add_text(s, c["x"] + 0.25, 5.02, 3.36, 0.25,
             [{"runs": [(c["footer"], {"size": 8.1, "color": c["accent"],
                                       "bold": True})]}])

add_rect(s, 0.55, 5.75, 12.15, 0.54, fill=GREEN, name="Process bar")
add_text(s, 0.82, 5.86, 6.4, 0.3,
         [{"runs": [("上传   →   路由   →   推理   →   回传",
                     {"size": 11.6, "color": WHITE, "bold": True, "spc": 0.3})]}])
add_text(s, 8.75, 5.89, 3.75, 0.25,
         [{"runs": [("本机保存资产 · 远端只做推理", {"size": 8.6, "color": "D9EDE2"})],
           "align": PP_ALIGN.RIGHT}])

add_text(s, 0.55, 6.40, 12.1, 0.2,
         [{"runs": [("设计原则：本地优先  ·  模型无关  ·  结论可解释  ·  失败可诊断",
                     {"size": 8.3, "color": GRAY})]}])

note(s, "这是第三部分，先用一页说明平台定位：不是单点模型演示，而是生成、检测、主动防御"
        "共用一条“上传→路由→推理→回传”链路。素材、任务和资产留在本机，远端只做 GPU 推理；"
        "首个真正落地的模型是 Qwen3-TTS 1.7B。")

# ============================================================
# SLIDE 2 — architecture, routing, job lifecycle
# ============================================================
s = prs.slides.add_slide(layout)
set_title(s, "系统架构：本地控制，远端推理")
add_page_number(s, "3.2")

add_text(s, 0.55, 1.16, 11.95, 0.28,
         [{"runs": [("浏览器只信任本地 BFF，Token 不出本机；经 SSH 隧道连接 AutoDL，产物自动回传资产库。",
                     {"size": 10.8, "color": GRAY})]}])

# boundaries
add_rect(s, 0.55, 1.70, 5.75, 3.18, fill=PALE_GREEN, line=GREEN, lw=1.0,
         name="Local boundary")
add_rect(s, 7.55, 1.70, 5.00, 3.18, fill=PALE_BLUE, line=BLUE, lw=1.0,
         name="Remote boundary")
add_text(s, 0.75, 1.82, 4.7, 0.2,
         [{"runs": [("本机 / LOCAL", {"size": 8.2, "color": GREEN,
                                      "font": CENTURY, "bold": True, "spc": 1.0})]}])
add_text(s, 7.75, 1.82, 4.3, 0.2,
         [{"runs": [("AUTODL GPU / REMOTE", {"size": 8.2, "color": BLUE,
                                              "font": CENTURY, "bold": True,
                                              "spc": 1.0})]}])

# browser
add_rect(s, 0.78, 2.16, 1.63, 1.48, fill=WHITE, line=GREEN, lw=1.1,
         name="Browser SPA")
add_text(s, 0.95, 2.30, 1.28, 0.28,
         [{"runs": [("浏览器 SPA", {"size": 11.5, "color": NAVY, "bold": True})]}])
add_text(s, 0.95, 2.66, 1.25, 0.72,
         [{"runs": [("React + Vite\n同源 HTTP / SSE", {"size": 7.6, "color": GRAY})],
           "line": 1.35}])
add_text(s, 0.80, 3.92, 1.55, 0.45,
         [{"runs": [("只访问相对路径\n/api/*", {"size": 7.2, "color": GRAY})],
           "line": 1.28}])

# BFF
add_rect(s, 2.74, 2.16, 3.30, 1.48, fill=GREEN, name="Local BFF")
add_text(s, 2.95, 2.30, 2.35, 0.28,
         [{"runs": [("本地 BFF", {"size": 11.5, "color": WHITE, "bold": True})]}])
add_text(s, 2.95, 2.64, 2.75, 0.72,
         [{"runs": [("Fastify + SQLite\n校验 · 同意 · 转发 · 资产库",
                     {"size": 7.6, "color": "D9EDE2"})], "line": 1.35}])
add_text(s, 5.02, 2.26, 0.8, 0.18,
         [{"runs": [("TOKEN 留在本机", {"size": 5.6, "color": "E7F3EC",
                                         "font": CENTURY, "bold": True})],
           "align": PP_ALIGN.RIGHT}])

# local library
add_rect(s, 2.74, 4.04, 3.30, 0.63, fill=WHITE, line=GREEN, lw=1.0,
         name="Local asset library")
add_text(s, 2.94, 4.12, 1.6, 0.2,
         [{"runs": [("本地资产库", {"size": 9.0, "color": GREEN, "bold": True})]}])
add_text(s, 2.94, 4.36, 2.85, 0.18,
         [{"runs": [("data/assets · jobs.db · 清单", {"size": 6.9, "color": GRAY,
                                                       "font": CENTURY})]}])

add_arrow(s, 2.41, 2.90, 2.74, 2.90, GREEN, 1.5)
add_arrow(s, 4.39, 3.64, 4.39, 4.04, GREEN, 1.4)

# tunnel
add_rect(s, 6.36, 2.48, 1.05, 0.86, fill=WHITE, line=BROWN, lw=1.5,
         shape=MSO_SHAPE.ROUNDED_RECTANGLE, radius=0.12, name="SSH tunnel")
add_text(s, 6.36, 2.59, 1.05, 0.24,
         [{"runs": [("SSH 隧道", {"size": 9.0, "color": BROWN, "bold": True})],
           "align": PP_ALIGN.CENTER}])
add_text(s, 6.36, 2.87, 1.05, 0.2,
         [{"runs": [("默认接入", {"size": 6.8, "color": GRAY})], "align": PP_ALIGN.CENTER}])
add_text(s, 6.18, 2.24, 1.4, 0.18,
         [{"runs": [("HTTP + BEARER", {"size": 5.8, "color": GRAY,
                                       "font": CENTURY, "spc": 0.8})],
           "align": PP_ALIGN.CENTER}])
add_arrow(s, 6.04, 2.90, 6.36, 2.90, BROWN, 1.4)
add_arrow(s, 7.41, 2.90, 7.78, 2.90, BROWN, 1.4)

# gateway
add_rect(s, 7.78, 2.16, 1.73, 1.48, fill=WHITE, line=BLUE, lw=1.1,
         name="Remote gateway")
add_text(s, 7.94, 2.29, 1.48, 0.24,
         [{"runs": [("远端网关", {"size": 10.4, "color": NAVY, "bold": True})]}])
add_text(s, 7.94, 2.56, 1.45, 0.18,
         [{"runs": [(":18000", {"size": 7.5, "color": BLUE,
                                "font": CENTURY, "bold": True})]}])
add_text(s, 7.94, 2.84, 1.42, 0.54,
         [{"runs": [("鉴权 · 能力路由\n队列 · SSE", {"size": 7.0, "color": GRAY})],
           "line": 1.28}])

# services
add_rect(s, 9.86, 1.97, 2.43, 0.94, fill=WHITE, line=BLUE, lw=1.0,
         name="TTS service")
add_rect(s, 9.86, 1.97, 0.065, 0.94, fill=BROWN)
add_text(s, 10.04, 2.08, 2.08, 0.22,
         [{"runs": [("TTS 服务 :18001", {"size": 9.2, "color": NAVY, "bold": True})]}])
add_text(s, 10.04, 2.37, 2.05, 0.3,
         [{"runs": [("Qwen3-TTS 0.6B / 1.7B", {"size": 6.8, "color": GRAY,
                                                "font": CENTURY})]}])

add_rect(s, 9.86, 3.16, 2.43, 1.12, fill=WHITE, line=BLUE, lw=1.0,
         name="Vision service")
add_rect(s, 9.86, 3.16, 0.065, 1.12, fill=GREEN)
add_text(s, 10.04, 3.27, 2.08, 0.22,
         [{"runs": [("视觉服务 :18002", {"size": 9.2, "color": NAVY, "bold": True})]}])
add_text(s, 10.04, 3.56, 2.06, 0.25,
         [{"runs": [("换脸 · 唇形 · 检测 · 防御", {"size": 6.9, "color": GRAY})]}])
add_text(s, 10.04, 3.90, 2.05, 0.2,
         [{"runs": [("按需加载 / LRU 卸载", {"size": 6.2, "color": GRAY,
                                              "font": CENTURY})]}])

add_arrow(s, 9.52, 2.62, 9.86, 2.50, GRAY, 1.0)
add_arrow(s, 9.52, 3.33, 9.86, 3.60, GRAY, 1.0)
add_text(s, 7.78, 4.48, 4.45, 0.2,
         [{"runs": [("模型进程隔离 · 能力上报 · 心跳 10s",
                     {"size": 6.8, "color": GRAY, "font": CENTURY})]}])

# bottom notes
add_rule(s, 0.55, 5.12, 6.30, 5.12, GREEN, 0.8)
add_rule(s, 6.70, 5.12, 12.70, 5.12, GREEN, 0.8)
add_text(s, 0.55, 5.21, 5.6, 0.2,
         [{"runs": [("能力路由 / ROUTING", {"size": 7.5, "color": GREEN,
                                            "font": CENTURY, "bold": True,
                                            "spc": 1.0})]}])
add_text(s, 0.55, 5.37, 5.65, 0.28,
         [{"runs": [("模型不写死，按能力选路", {"size": 15.8, "color": NAVY,
                                              "bold": True})]}])
add_text(s, 0.55, 5.71, 5.65, 0.4,
         [{"runs": [("task + 角色 + 限制 + 健康状态 → 模型；选路结果写入 route_reason。",
                     {"size": 8.9, "color": GRAY})], "line": 1.3}])
add_text(s, 0.55, 6.18, 5.65, 0.2,
         [{"runs": [("task + roles + limits + health  →  model",
                     {"size": 7.2, "color": BLUE, "font": CENTURY, "bold": True})]}])

add_text(s, 6.70, 5.21, 5.8, 0.2,
         [{"runs": [("任务生命周期 / JOB", {"size": 7.5, "color": GREEN,
                                            "font": CENTURY, "bold": True,
                                            "spc": 1.0})]}])
add_text(s, 6.70, 5.37, 5.8, 0.28,
         [{"runs": [("所有能力共用一条异步状态机", {"size": 15.8, "color": NAVY,
                                                  "bold": True})]}])
add_text(s, 6.70, 5.71, 5.8, 0.4,
         [{"runs": [("提交幂等、进度走 SSE、运行中可取消；断线后按 jobs.db 对账。",
                     {"size": 8.9, "color": GRAY})], "line": 1.3}])

pills = [
    ("queued", 0.62, WHITE, GREEN),
    ("prepared", 0.74, WHITE, GREEN),
    ("running", 0.68, WHITE, GREEN),
    ("postprocessing", 0.98, WHITE, GREEN),
    ("succeeded / failed / canceled", 1.53, GREEN, WHITE),
]
px = 6.70
py = 6.19
for i, (label, pw, fill, color) in enumerate(pills):
    add_rect(s, px, py, pw, 0.28, fill=fill, line=GREEN, lw=0.8,
             shape=MSO_SHAPE.ROUNDED_RECTANGLE, radius=0.25)
    add_text(s, px, py + 0.045, pw, 0.2,
             [{"runs": [(label, {"size": (5.7 if i == 4 else 6.0),
                                 "color": color, "font": CENTURY})],
               "align": PP_ALIGN.CENTER}])
    px += pw
    if i < len(pills) - 1:
        add_text(s, px - 0.005, py + 0.02, 0.17, 0.22,
                 [{"runs": [("›", {"size": 10.5, "color": GRAY, "bold": True})],
                   "align": PP_ALIGN.CENTER}])
        px += 0.17

note(s, "架构重点：浏览器不直连远端，Token 只在本机 BFF；默认通过 SSH 隧道访问 AutoDL。"
        "远端网关保持轻量，不加载模型，按能力清单路由并记录 route_reason。所有任务共用一条"
        "异步状态机，支持进度、取消、幂等和断线对账；模型服务独立进程，按需加载、LRU 卸载。")

# ============================================================
# SLIDE 3 — trust, boundaries, delivery
# ============================================================
s = prs.slides.add_slide(layout)
set_title(s, "可信与交付：让结论有边界，让设计能落地")
add_page_number(s, "3.3")

add_text(s, 0.55, 1.16, 11.95, 0.28,
         [{"runs": [("检测给证据，防御给边界，交付给可验收的阶段目标。",
                     {"size": 10.8, "color": GRAY})]}])

cols = [
    {
        "x": 0.55, "fill": PALE_BLUE, "accent": BLUE, "num": "01",
        "title": "检测", "sub": "给出证据，不只分数",
        "body": "人脸检测 → 多分类器投票 → Grad-CAM 热区 → 连通域红框；输出 verdict、score、regions 与叠加图。",
        "metric": "AUC ≥ 0.90", "label": "60 张演示集 · 单图 <3s（GPU）",
        "boundary": "边界：非司法鉴定；跨生成器可能漏检",
    },
    {
        "x": 4.70, "fill": PALE_PINK, "accent": BROWN, "num": "02",
        "title": "防御", "sub": "降低被伪造的价值",
        "body": "对抗扰动 + 水印 + 保护证书；中档 PSNR ≥40 dB、SSIM ≥0.98，并验证换脸相似度下降。",
        "metric": "PSNR ≥ 40 dB", "label": "身份相似度 −0.15 · 水印可验证",
        "boundary": "边界：不保证免疫；仅本人 / 授权素材",
    },
    {
        "x": 8.85, "fill": PALE_GREEN, "accent": GREEN, "num": "03",
        "title": "交付", "sub": "先闭环，再接真模型",
        "body": "P1 用 mock 跑通 UI 与契约；P2 接 Qwen3-TTS；P3 检测；P4 视频；P5 防御；P6 加固。",
        "metric": "P0 → P6", "label": "7 个阶段 · 每阶段有量化退出标准",
        "boundary": "首个真模型：Qwen3-TTS 1.7B",
    },
]

for c in cols:
    add_rect(s, c["x"], 1.70, 3.85, 3.48, fill=c["fill"], line=None)
    add_rect(s, c["x"], 1.70, 3.85, 0.055, fill=c["accent"])
    add_circle_number(s, c["x"] + 0.22, 1.86, 0.45, c["num"], size=8.7)
    add_text(s, c["x"] + 0.78, 1.83, 2.85, 0.26,
             [{"runs": [(c["title"] + "：" + c["sub"],
                         {"size": 15.2, "color": c["accent"], "bold": True})]}])
    add_text(s, c["x"] + 0.22, 2.47, 3.43, 1.07,
             [{"runs": [(c["body"], {"size": 9.3, "color": NAVY})], "line": 1.38}])
    add_rule(s, c["x"] + 0.22, 3.67, c["x"] + 3.63, 3.67, c["accent"], 0.7)
    add_text(s, c["x"] + 0.22, 3.78, 3.45, 0.38,
             [{"runs": [(c["metric"], {"size": 19.5, "color": c["accent"],
                                        "font": CENTURY, "bold": True})]}])
    add_text(s, c["x"] + 0.22, 4.22, 3.45, 0.22,
             [{"runs": [(c["label"], {"size": 7.6, "color": GRAY})]}])
    add_rect(s, c["x"] + 0.22, 4.63, 0.06, 0.06, fill=c["accent"])
    add_text(s, c["x"] + 0.36, 4.58, 3.30, 0.38,
             [{"runs": [(c["boundary"], {"size": 7.4, "color": RED if c["num"] != "03" else GRAY,
                                          "bold": True})], "line": 1.15}])

# safe defaults panel
add_rect(s, 0.55, 5.38, 12.15, 1.18, fill=PALE_GREEN, line=GREEN, lw=0.9,
         name="Safe defaults")
add_text(s, 0.75, 5.52, 2.55, 0.28,
         [{"runs": [("负责任的默认值", {"size": 13.2, "color": GREEN, "bold": True})]}])
add_text(s, 0.75, 5.84, 2.55, 0.2,
         [{"runs": [("SAFE BY DEFAULT", {"size": 6.9, "color": GRAY,
                                          "font": CENTURY, "bold": True,
                                          "spc": 1.0})]}])

chips = [
    ("仅本机回环", 1.40), ("同意门", 0.88), ("Token 不进前端", 1.42),
    ("SHA-256 清单", 1.30), ("7 天 / 24h TTL", 1.32), ("不保证免疫", 1.16),
]
cx = 3.28
for text, cw in chips:
    add_rect(s, cx, 5.61, cw, 0.36, fill=WHITE, line=GREEN, lw=0.8,
             shape=MSO_SHAPE.ROUNDED_RECTANGLE, radius=0.28)
    add_text(s, cx, 5.695, cw, 0.2,
             [{"runs": [(text, {"size": 7.7, "color": NAVY})],
               "align": PP_ALIGN.CENTER}])
    cx += cw + 0.09
add_text(s, 0.76, 6.20, 11.55, 0.2,
         [{"runs": [("默认只监听 127.0.0.1  ·  未勾选同意无法提交  ·  删除资产后本地与远端均不可再取",
                     {"size": 7.8, "color": GRAY})]}])

note(s, "第三部分收束到“可信与交付”：检测必须给证据和边界，红框不是像素级伪造定位，"
        "结论不是司法鉴定；防御用扰动、水印和证书，只承诺降低风险；交付按 P0–P6 推进，"
        "P1 先用 mock 跑通 UI 与契约。最后一排是本项目的安全默认值。")

# document properties
prs.core_properties.title = "DeepFake 技术 Demo · 平台设计说明"
prs.core_properties.subject = "第三部分：生成 / 检测 / 主动防御的 P0 设计蓝图"
prs.core_properties.author = "DeepFake Platform"
prs.core_properties.keywords = "DeepFake, 技术Demo, 平台设计, 生成, 检测, 主动防御"
prs.core_properties.comments = "3 页设计介绍，采用北京理工大学汇报模板配色与版式。"

prs.save(OUT)
print(f"saved: {OUT}")
print(f"slides: {len(prs.slides)}, size: {OUT.stat().st_size}")
