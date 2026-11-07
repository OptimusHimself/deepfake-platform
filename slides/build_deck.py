# -*- coding: utf-8 -*-
"""Build the 3-slide Deepfake Platform design deck."""

from pathlib import Path

from lxml import etree
from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.dml import MSO_LINE
from pptx.enum.shapes import MSO_CONNECTOR, MSO_SHAPE
from pptx.enum.text import MSO_ANCHOR, PP_ALIGN
from pptx.oxml.ns import qn
from pptx.util import Inches, Pt

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "Deepfake平台设计说明_3页.pptx"

# ---------- design tokens ----------
SW, SH = 13.333, 7.5
L, R = 0.72, 12.61

PAPER = "F6F1E7"
CREAM = "FBF7EF"
INK = "141414"
INK_SOFT = "3E3A34"
MUTED = "746D62"
LINE = "D8CFBE"
DARK = "11161C"
DARK_2 = "1C242E"
DARK_3 = "252D37"
VERMILION = "D94A2B"
COBALT = "2248C8"
TEAL = "0E6B5C"
GOLD = "A67422"
WHITE = "FCFAF4"
WHITE_MUTED = "A9A296"

SERIF = "Noto Serif SC"
SANS = "Noto Sans SC"
MONO = "Consolas"


def rgb(value):
    return RGBColor.from_string(value)


def set_ea(run, font):
    rPr = run._r.get_or_add_rPr()
    for tag in ("a:ea", "a:cs"):
        el = rPr.find(qn(tag))
        if el is None:
            el = etree.SubElement(rPr, qn(tag))
        el.set("typeface", font)


def style_run(run, text, size, color=INK, font=SANS, bold=False,
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
                opts.get("color", spec.get("color", INK)),
                opts.get("font", spec.get("font", SANS)),
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


def add_rule(slide, x1, y1, x2, y2, color=LINE, width=0.8, dash=None):
    conn = slide.shapes.add_connector(
        MSO_CONNECTOR.STRAIGHT, Inches(x1), Inches(y1), Inches(x2), Inches(y2)
    )
    conn.line.color.rgb = rgb(color)
    conn.line.width = Pt(width)
    if dash is not None:
        conn.line.dash_style = dash
    return conn


def add_arrow(slide, x1, y1, x2, y2, color=INK, width=1.0, dash=None):
    conn = add_rule(slide, x1, y1, x2, y2, color, width, dash)
    ln = conn.line._get_or_add_ln()
    tail = etree.SubElement(ln, qn("a:tailEnd"))
    tail.set("type", "triangle")
    tail.set("w", "med")
    tail.set("len", "med")
    return conn


def header(slide, section, right_text):
    add_rect(slide, L, 0.46, 0.09, 0.09, fill=VERMILION)
    add_text(slide, 0.9, 0.38, 4.2, 0.24,
             [{"runs": [("DEEPFAKE PLATFORM", {"size": 7.8, "color": INK,
                                               "font": MONO, "bold": True,
                                               "spc": 1.8})]}])
    add_text(slide, 7.7, 0.38, 4.9, 0.24,
             [{"runs": [(right_text, {"size": 7.3, "color": MUTED,
                                      "font": MONO, "spc": 1.2})],
               "align": PP_ALIGN.RIGHT}])
    add_rule(slide, L, 0.72, R, 0.72, LINE, 0.8)
    add_text(slide, L, 0.86, 5.5, 0.22,
             [{"runs": [(section, {"size": 8.2, "color": VERMILION,
                                   "font": MONO, "bold": True, "spc": 1.1})]}])


def footer(slide, page):
    add_rule(slide, L, 7.08, R, 7.08, LINE, 0.8)
    add_text(slide, L, 7.15, 7.0, 0.18,
             [{"runs": [("SOURCE: README + DOCS 00–08   /   P0 DESIGN BLUEPRINT",
                         {"size": 6.2, "color": MUTED, "font": MONO, "spc": 0.7})]}])
    add_text(slide, 10.0, 7.15, 2.61, 0.18,
             [{"runs": [(page, {"size": 6.8, "color": INK, "font": MONO,
                                "bold": True, "spc": 1.0})],
               "align": PP_ALIGN.RIGHT}])


def note(slide, text):
    slide.notes_slide.notes_text_frame.text = text


# ---------- deck ----------
prs = Presentation()
prs.slide_width = Inches(SW)
prs.slide_height = Inches(SH)
blank = prs.slide_layouts[6]

# ============================================================
# SLIDE 1 — positioning + three capabilities
# ============================================================
s = prs.slides.add_slide(blank)
s.background.fill.solid()
s.background.fill.fore_color.rgb = rgb(PAPER)
header(s, "01 / 项目定位", "P0 · DESIGN BLUEPRINT / 2026.10")

# Eyebrow
add_text(s, L, 1.03, 7.0, 0.24,
         [{"runs": [("一个平台，三条能力，一条端到端链路", {"size": 9.6,
                                                          "color": MUTED,
                                                          "bold": True,
                                                          "spc": 0.4})]}])

# Main statement
add_text(s, L, 1.34, 7.0, 2.42, [
    {"runs": [("生成它。", {"size": 47, "font": SERIF, "bold": True})],
     "line": 1.0, "after": 0},
    {"runs": [("识破它。", {"size": 47, "font": SERIF, "bold": True,
                           "color": COBALT})], "line": 1.0},
    {"runs": [("保护自己。", {"size": 47, "font": SERIF, "bold": True,
                             "color": VERMILION})], "line": 1.0},
], name="Cover statement")

# Intro
add_text(s, L, 4.02, 6.65, 1.02, [
    {"runs": [
        ("一个本地优先的 Deepfake 实验平台。素材、任务与资产留在本机，推理交给 AutoDL GPU；"
         "用同一套任务契约，把生成、检测与主动防御连成一条可施工的链路。",
         {"size": 13.2, "color": INK_SOFT})
    ], "line": 1.48}
])

# Design note
add_rule(s, L, 5.36, L + 6.7, 5.36, INK, 0.9)
add_text(s, L, 5.49, 6.7, 0.32,
         [{"runs": [("设计对象不是单个模型，而是整条链路。", {"size": 12.4,
                                                            "font": SERIF,
                                                            "bold": True})]}])
add_text(s, L, 5.84, 6.7, 0.25,
         [{"runs": [("上传  →  路由  →  推理  →  回传；所有能力共享同一套资产、任务与进度语义。",
                     {"size": 8.8, "color": MUTED})]}])

# Capability panel
PX, PY, PW, PH = 8.0, 1.06, 4.62, 5.42
add_rect(s, PX, PY, PW, PH, fill=DARK, name="Capability panel")
add_text(s, PX + 0.24, PY + 0.24, PW - 0.48, 0.2,
         [{"runs": [("ONE PLATFORM / 三类能力", {"size": 7.1, "color": WHITE_MUTED,
                                                  "font": MONO, "bold": True,
                                                  "spc": 1.4})]}])
add_rect(s, PX + 0.24, PY + 0.55, PW - 0.48, 0.008, fill="4A443A")

rows = [
    ("01", "生成", "GENERATE", VERMILION,
     "克隆配音、说话视频、换脸与改口型。\n首个真模型：Qwen3-TTS 1.7B。"),
    ("02", "检测", "DETECT", COBALT,
     "图片概率 + 红框，视频 / 音频时间轴。\n给出证据与警告，而不只是一句真假。"),
    ("03", "主动防御", "DEFEND", TEAL,
     "对本人素材叠加对抗扰动与水印。\n输出可验证的保护证书与指标。"),
]
row_top = PY + 0.76
row_h = 1.34
for i, (num, title, eng, accent, desc) in enumerate(rows):
    y = row_top + i * row_h
    add_text(s, PX + 0.24, y + 0.05, 0.42, 0.24,
             [{"runs": [(num, {"size": 8.0, "color": accent, "font": MONO,
                               "bold": True})]}])
    add_text(s, PX + 0.72, y, 2.1, 0.34,
             [{"runs": [(title, {"size": 18.2, "color": WHITE, "bold": True})]}])
    add_text(s, PX + 2.84, y + 0.065, 1.5, 0.22,
             [{"runs": [(eng, {"size": 6.8, "color": WHITE_MUTED, "font": MONO,
                               "spc": 1.2})], "align": PP_ALIGN.RIGHT}])
    add_text(s, PX + 0.72, y + 0.36, PW - 0.98, 0.66,
             [{"runs": [(desc, {"size": 8.7, "color": "C9C2B6"})], "line": 1.26}])
    if i < 2:
        add_rect(s, PX + 0.24, y + row_h - 0.09, PW - 0.48, 0.006, fill="343A43")

add_text(s, PX + 0.24, PY + 4.84, PW - 0.48, 0.24,
         [{"runs": [("上传  →  路由  →  推理  →  回传",
                     {"size": 8.9, "color": WHITE, "font": MONO, "bold": True,
                      "spc": 0.5})]}])
add_text(s, PX + 0.24, PY + 5.11, PW - 0.48, 0.2,
         [{"runs": [("本机保存资产 · 远端只做推理", {"size": 7.2,
                                                    "color": WHITE_MUTED})]}])

# Principle strip
add_text(s, L, 6.52, 6.9, 0.2,
         [{"runs": [("DESIGN PRINCIPLES", {"size": 6.4, "color": MUTED,
                                            "font": MONO, "bold": True,
                                            "spc": 1.0})]}])
principles = ["本地优先", "模型无关", "结论可解释", "失败可诊断"]
x = L
for p in principles:
    add_text(s, x, 6.74, 1.7, 0.24,
             [{"runs": [(p, {"size": 9.2, "color": INK, "bold": True})]}])
    x += 1.66
footer(s, "01 / 03")
note(s, "开场：这不是单点模型 Demo，而是一套端到端平台设计。生成、检测、主动防御共用"
        "“上传→路由→推理→回传”一条链路；本地保留素材、任务和资产，远端只负责 GPU 推理。"
        "首个落地的真模型是 Qwen3-TTS 1.7B，其余模型按能力清单持续接入。")

# ============================================================
# SLIDE 2 — architecture, routing, job lifecycle
# ============================================================
s = prs.slides.add_slide(blank)
s.background.fill.solid()
s.background.fill.fore_color.rgb = rgb(PAPER)
header(s, "02 / 系统架构", "LOCAL CONTROL / REMOTE COMPUTE")

add_text(s, L, 1.06, 11.8, 0.5,
         [{"runs": [("把重推理放到远端，把控制权留在本地",
                     {"size": 28.5, "font": SERIF, "bold": True})]}])
add_text(s, L, 1.58, 11.8, 0.28,
         [{"runs": [("浏览器只信任本地 BFF；BFF 持有 Token，经 SSH 隧道把任务交给远端网关，产物再回传资产库。",
                     {"size": 10.6, "color": MUTED})]}])

# ----- diagram containers -----
DY, DH = 2.02, 3.19
add_rect(s, L, DY, 5.55, DH, fill="EFE8DB", line="DED4C3", lw=0.8,
         name="Local boundary")
add_rect(s, 7.62, DY, 5.0, DH, fill=DARK, name="Remote boundary")

add_text(s, 0.94, 2.15, 4.9, 0.2,
         [{"runs": [("本机 / LOCAL", {"size": 7.2, "color": MUTED,
                                      "font": MONO, "bold": True, "spc": 1.3})]}])
add_text(s, 7.86, 2.15, 4.5, 0.2,
         [{"runs": [("AUTODL GPU / REMOTE", {"size": 7.2, "color": WHITE_MUTED,
                                              "font": MONO, "bold": True,
                                              "spc": 1.3})]}])

# browser
add_rect(s, 0.94, 2.53, 1.55, 1.46, fill=CREAM, line="D5CBBB", lw=0.9,
         name="Browser SPA")
add_text(s, 1.10, 2.68, 1.26, 0.26,
         [{"runs": [("浏览器 SPA", {"size": 12.4, "bold": True})]}])
add_text(s, 1.10, 3.03, 1.25, 0.72,
         [{"runs": [("React + Vite\n同源 HTTP / SSE", {"size": 7.8, "color": MUTED})],
           "line": 1.32}])

# BFF
add_rect(s, 3.03, 2.53, 2.95, 1.46, fill=INK, name="Local BFF")
add_text(s, 3.22, 2.68, 2.3, 0.26,
         [{"runs": [("本地 BFF", {"size": 12.4, "color": WHITE, "bold": True})]}])
add_text(s, 3.22, 3.03, 2.58, 0.76,
         [{"runs": [("Fastify + SQLite\n校验 · 同意 · 转发 · 资产库",
                     {"size": 7.8, "color": "C9C2B6"})], "line": 1.3}])
add_text(s, 5.16, 2.65, 0.65, 0.18,
         [{"runs": [("TOKEN", {"size": 5.7, "color": VERMILION, "font": MONO,
                               "bold": True, "spc": 0.7})], "align": PP_ALIGN.RIGHT}])

# local library
add_rect(s, 3.03, 4.28, 2.95, 0.7, fill=CREAM, line="D5CBBB", lw=0.9,
         name="Local asset library")
add_text(s, 3.22, 4.38, 1.5, 0.2,
         [{"runs": [("本地资产库", {"size": 9.2, "bold": True})]}])
add_text(s, 3.22, 4.63, 2.55, 0.2,
         [{"runs": [("data/assets · jobs.db · 清单", {"size": 7.0, "color": MUTED,
                                                       "font": MONO})]}])

# arrows local
add_arrow(s, 2.49, 3.26, 3.03, 3.26, color=INK, width=1.1)
add_arrow(s, 4.50, 3.99, 4.50, 4.28, color=INK, width=1.1)
add_text(s, 0.96, 4.42, 1.7, 0.52,
         [{"runs": [("只访问\n相对路径 /api/*", {"size": 6.7, "color": MUTED})],
           "line": 1.25}])

# tunnel
add_rect(s, 6.36, 2.91, 1.12, 0.9, fill=PAPER, line=VERMILION, lw=1.2,
         shape=MSO_SHAPE.ROUNDED_RECTANGLE, radius=0.12, name="SSH tunnel")
add_text(s, 6.36, 3.04, 1.12, 0.3,
         [{"runs": [("SSH 隧道", {"size": 8.8, "bold": True,
                                  "color": VERMILION})], "align": PP_ALIGN.CENTER}])
add_text(s, 6.36, 3.35, 1.12, 0.2,
         [{"runs": [("默认接入方式", {"size": 6.2, "color": MUTED})],
           "align": PP_ALIGN.CENTER}])
add_text(s, 6.22, 2.61, 1.4, 0.2,
         [{"runs": [("HTTP + BEARER", {"size": 6.1, "color": MUTED,
                                       "font": MONO, "spc": 0.8})],
           "align": PP_ALIGN.CENTER}])
add_arrow(s, 5.98, 3.34, 6.36, 3.34, color=VERMILION, width=1.3)
add_arrow(s, 7.48, 3.34, 7.86, 3.34, color=VERMILION, width=1.3)

# gateway
add_rect(s, 7.86, 2.53, 1.8, 1.46, fill=DARK_2, line="3B4653", lw=0.9,
         name="Remote gateway")
add_text(s, 8.02, 2.67, 1.5, 0.24,
         [{"runs": [("远端网关", {"size": 10.8, "color": WHITE, "bold": True})]}])
add_text(s, 8.02, 2.95, 1.5, 0.18,
         [{"runs": [(":18000", {"size": 7.8, "color": VERMILION, "font": MONO,
                                "bold": True})]}])
add_text(s, 8.02, 3.22, 1.5, 0.6,
         [{"runs": [("鉴权 · 能力路由\n队列 · SSE", {"size": 7.2, "color": "C9C2B6"})],
           "line": 1.25}])

# services
add_rect(s, 10.04, 2.31, 2.34, 0.94, fill=DARK_2, line="3B4653", lw=0.9,
         name="TTS service")
add_rect(s, 10.04, 2.31, 0.075, 0.94, fill=VERMILION)
add_text(s, 10.26, 2.42, 1.95, 0.22,
         [{"runs": [("TTS 服务 :18001", {"size": 9.8, "color": WHITE, "bold": True})]}])
add_text(s, 10.26, 2.73, 1.98, 0.34,
         [{"runs": [("Qwen3-TTS 0.6B / 1.7B", {"size": 6.9, "color": "B9B2A6",
                                                "font": MONO})]}])

add_rect(s, 10.04, 3.38, 2.34, 1.15, fill=DARK_2, line="3B4653", lw=0.9,
         name="Vision service")
add_rect(s, 10.04, 3.38, 0.075, 1.15, fill=COBALT)
add_text(s, 10.26, 3.49, 2.0, 0.22,
         [{"runs": [("视觉服务 :18002", {"size": 9.8, "color": WHITE, "bold": True})]}])
add_text(s, 10.26, 3.80, 1.98, 0.28,
         [{"runs": [("换脸 · 唇形 · 检测 · 防御", {"size": 6.9, "color": "B9B2A6"})]}])
add_text(s, 10.26, 4.13, 1.98, 0.22,
         [{"runs": [("按需加载 / LRU 卸载", {"size": 6.4, "color": "8F897E",
                                            "font": MONO})]}])

add_arrow(s, 9.66, 2.88, 10.04, 2.80, color="8B95A1", width=0.9)
add_arrow(s, 9.66, 3.34, 10.04, 3.65, color="8B95A1", width=0.9)
add_text(s, 7.86, 4.73, 4.55, 0.24,
         [{"runs": [("模型进程隔离 · 能力上报 · 心跳 10s",
                     {"size": 6.7, "color": WHITE_MUTED, "font": MONO})]}])

# ----- bottom design notes -----
add_text(s, L, 5.43, 5.7, 0.2,
         [{"runs": [("能力路由 / ROUTING", {"size": 6.8, "color": VERMILION,
                                            "font": MONO, "bold": True,
                                            "spc": 1.1})]}])
add_text(s, L, 5.63, 5.65, 0.3,
         [{"runs": [("模型不写死，按能力选路", {"size": 14.6, "font": SERIF,
                                              "bold": True})]}])
add_text(s, L, 5.98, 5.65, 0.46,
         [{"runs": [("task + 角色 + 限制 + 健康状态 → 模型；每次选路记录 route_reason，"
                     "前端可解释选择。", {"size": 8.7, "color": MUTED})],
           "line": 1.28}])
add_text(s, L, 6.49, 5.65, 0.2,
         [{"runs": [("task + roles + limits + health  →  model",
                     {"size": 7.0, "color": COBALT, "font": MONO, "bold": True})]}])

add_text(s, 6.72, 5.43, 5.9, 0.2,
         [{"runs": [("任务生命周期 / JOB", {"size": 6.8, "color": VERMILION,
                                            "font": MONO, "bold": True,
                                            "spc": 1.1})]}])
add_text(s, 6.72, 5.63, 5.9, 0.3,
         [{"runs": [("所有能力共用一条异步状态机", {"size": 14.6, "font": SERIF,
                                                  "bold": True})]}])
add_text(s, 6.72, 5.98, 5.85, 0.42,
         [{"runs": [("提交幂等、进度走 SSE、运行中可取消；断线后按 jobs.db 对账，"
                     "不把用户卡在转圈里。", {"size": 8.7, "color": MUTED})],
           "line": 1.28}])

pills = [
    ("queued", 0.65, "DDD4C4", INK),
    ("prepared", 0.80, "DDD4C4", INK),
    ("running", 0.67, "DDD4C4", INK),
    ("postprocessing", 1.00, "DDD4C4", INK),
    ("succeeded / failed / canceled", 1.48, INK, WHITE),
]
px = 6.72
py = 6.45
for i, (label, pw, fill, color) in enumerate(pills):
    add_rect(s, px, py, pw, 0.28, fill=fill, line=(None if fill == INK else "C8BEAC"),
             lw=0.7, shape=MSO_SHAPE.ROUNDED_RECTANGLE, radius=0.28)
    add_text(s, px, py + 0.045, pw, 0.2,
             [{"runs": [(label, {"size": (5.8 if i == 4 else 6.1),
                                 "color": color, "font": MONO})],
               "align": PP_ALIGN.CENTER}])
    px += pw
    if i < len(pills) - 1:
        add_text(s, px - 0.01, py + 0.025, 0.2, 0.22,
                 [{"runs": [("›", {"size": 11, "color": MUTED, "bold": True})],
                   "align": PP_ALIGN.CENTER}])
        px += 0.2

footer(s, "02 / 03")
note(s, "架构重点：浏览器不直连远端，Token 只在本机 BFF；默认通过 SSH 隧道访问 AutoDL。"
        "网关保持轻量、不加载模型，按能力清单路由并记录 route_reason。所有任务共用一条"
        "异步状态机，支持进度、取消、幂等和断线对账；模型服务只监听 127.0.0.1，按需加载、LRU 卸载。")

# ============================================================
# SLIDE 3 — trust, boundaries, delivery
# ============================================================
s = prs.slides.add_slide(blank)
s.background.fill.solid()
s.background.fill.fore_color.rgb = rgb(PAPER)
header(s, "03 / 可信与交付", "EXPLAIN · VERIFY · SHIP")

add_text(s, L, 1.06, 11.9, 0.48,
         [{"runs": [("让结论可解释，让风险有边界，让设计能落地",
                     {"size": 28.5, "font": SERIF, "bold": True})]}])
add_text(s, L, 1.57, 11.7, 0.28,
         [{"runs": [("三组设计取舍，决定这个平台能不能被信任、被演示、被继续实现。",
                     {"size": 10.6, "color": MUTED})]}])

cols = [
    {
        "x": L, "accent": COBALT, "num": "01 / DETECT", "title": "检测：给出证据，不只分数",
        "body": "人脸检测 → 多分类器投票 → Grad-CAM 热区 → 连通域红框。输出 verdict、score、regions 与叠加图；低置信返回 uncertain。",
        "metric": "≥ 0.90", "metric_label": "演示集 AUC · 60 张（30 真 / 30 假）",
        "boundary": "边界：非司法鉴定；跨生成器可能漏检",
    },
    {
        "x": 4.77, "accent": TEAL, "num": "02 / DEFEND", "title": "防御：降低被伪造的价值",
        "body": "对抗扰动 + 水印 + 保护证书。中档目标 PSNR ≥40 dB、SSIM ≥0.98，并让平台自身换脸链路的身份相似度下降 ≥0.15。",
        "metric": "−0.15", "metric_label": "换脸身份相似度下降 · PSNR ≥40 dB",
        "boundary": "边界：不保证免疫；仅本人或授权素材",
    },
    {
        "x": 8.82, "accent": VERMILION, "num": "03 / DELIVER", "title": "交付：先闭环，再接真模型",
        "body": "P1 用 mock 远端跑通 UI 与契约；P2 接 Qwen3-TTS；P3 检测；P4 视频；P5 防御；P6 加固与评估。每阶段都有量化退出标准。",
        "metric": "P0 → P6", "metric_label": "7 个阶段 · 首个真模型 Qwen3-TTS 1.7B",
        "boundary": "目标：10s 克隆端到端 <30s（warm）",
    },
]

for col in cols:
    x = col["x"]
    add_rect(s, x, 2.02, 3.85, 0.037, fill=col["accent"])
    add_text(s, x, 2.15, 3.7, 0.2,
             [{"runs": [(col["num"], {"size": 6.9, "color": col["accent"],
                                      "font": MONO, "bold": True, "spc": 1.0})]}])
    add_text(s, x, 2.40, 3.82, 0.34,
             [{"runs": [(col["title"], {"size": 16.7, "font": SERIF, "bold": True})]}])
    add_text(s, x, 2.83, 3.78, 1.36,
             [{"runs": [(col["body"], {"size": 8.9, "color": INK_SOFT})], "line": 1.4}])
    add_rect(s, x, 3.94, 3.78, 0.009, fill=LINE)
    add_text(s, x, 4.06, 2.0, 0.42,
             [{"runs": [(col["metric"], {"size": 21.5, "color": col["accent"],
                                          "font": SERIF, "bold": True})]}])
    add_text(s, x, 4.53, 3.75, 0.28,
             [{"runs": [(col["metric_label"], {"size": 7.4, "color": MUTED})]}])
    add_rect(s, x, 4.92, 0.075, 0.075, fill=col["accent"])
    add_text(s, x + 0.15, 4.87, 3.66, 0.28,
             [{"runs": [(col["boundary"], {"size": 7.2, "color": INK_SOFT,
                                            "bold": True})]}])

# safety band
add_rect(s, L, 5.79, 11.9, 0.9, fill=INK, name="Safety defaults band")
add_text(s, 0.94, 5.94, 2.25, 0.24,
         [{"runs": [("负责任的默认值", {"size": 11.4, "color": WHITE, "bold": True})]}])
add_text(s, 0.94, 6.27, 2.25, 0.18,
         [{"runs": [("SAFE BY DEFAULT", {"size": 6.4, "color": WHITE_MUTED,
                                         "font": MONO, "bold": True, "spc": 1.0})]}])

chips = [
    ("仅本机回环", 1.43), ("同意门", 0.94), ("Token 不进前端", 1.52),
    ("SHA-256 清单", 1.42), ("7 天 / 24h TTL", 1.42), ("不保证免疫", 1.27),
]
cx = 3.35
for text, cw in chips:
    add_rect(s, cx, 6.08, cw, 0.32, fill="1E252D", line="4A443A", lw=0.7,
             shape=MSO_SHAPE.ROUNDED_RECTANGLE, radius=0.28)
    add_text(s, cx, 6.145, cw, 0.2,
             [{"runs": [(text, {"size": 7.1, "color": "E7E0D3"})],
               "align": PP_ALIGN.CENTER}])
    cx += cw + 0.10

footer(s, "03 / 03")
note(s, "第三页讲取舍。检测必须给证据和边界：红框不是像素级伪造定位，结论不是司法鉴定；"
        "防御用扰动 + 水印 + 证书，只承诺降低风险，不承诺免疫；交付按 P0–P6 推进，"
        "P1 用 mock 先把 UI 与契约跑通，再接真模型。安全默认值包括本机回环、同意门、"
        "Token 不进前端、哈希清单、本地 7 天 / 远端 24h TTL，以及“不保证免疫”的明确提示。")

# document properties
prs.core_properties.title = "Deepfake 平台设计说明"
prs.core_properties.subject = "生成 / 检测 / 主动防御：P0 设计蓝图"
prs.core_properties.author = "Deepfake Platform"
prs.core_properties.keywords = "deepfake, 平台设计, 生成, 检测, 主动防御, AutoDL"
prs.core_properties.comments = "3 页项目设计介绍；内容依据 README 与 docs/00–08。"

prs.save(OUT)
print(f"saved: {OUT}")
print(f"slides: {len(prs.slides)}")
