import { useCallback, useEffect, useRef, useState } from 'react'
import type { DragEvent, FormEvent } from 'react'
import {
  cancelJob,
  getConfig,
  getHealth,
  getJob,
  getJobs,
  saveJob,
  submitJob,
  toApiError,
} from './api'
import type { ApiError, Config, Health, Job } from './types'
import DetectionPanel from './DetectionPanel'
import FaceSwapPanel from './FaceSwapPanel'
import ImageDetectionPanel from './ImageDetectionPanel'
import VideoDetectionPanel from './VideoDetectionPanel'
import VideoDefensePanel from './VideoDefensePanel'
import VideoFaceSwapPanel from './VideoFaceSwapPanel'
import DefensePanel from './DefensePanel'

const DEFAULT_LANGUAGES = ['Chinese', 'English', 'Japanese', 'Korean', 'German', 'French', 'Russian', 'Portuguese', 'Spanish', 'Italian']
const LANGUAGE_LABELS: Record<string, string> = {
  Chinese: '中文',
  English: '英语',
  Japanese: '日语',
  Korean: '韩语',
  German: '德语',
  French: '法语',
  Russian: '俄语',
  Portuguese: '葡萄牙语',
  Spanish: '西班牙语',
  Italian: '意大利语',
}
const STAGE_LABELS: Record<string, string> = {
  queued: '排队中',
  prepared: '准备中',
  running: '生成中',
  loading_model: '加载模型',
  generating: '合成语音',
  postprocessing: '整理音频',
  succeeded: '已完成',
  failed: '失败',
  canceled: '已取消',
}
const STATUS_LABELS: Record<string, string> = {
  queued: '排队中',
  prepared: '准备中',
  running: '生成中',
  postprocessing: '整理中',
  succeeded: '已完成',
  failed: '失败',
  canceled: '已取消',
}

function isDone(job: Job) {
  return job.status === 'failed' || job.status === 'canceled' || (job.status === 'succeeded' && !!job.resultUrl)
}

function isBusy(job: Job | null) {
  return !!job && !isDone(job) && job.status !== 'succeeded'
}

function formatBytes(value: number | null) {
  if (!value) return '—'
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}

function formatDuration(value: number | null) {
  if (value === null || Number.isNaN(value)) return '—'
  return `${value.toFixed(1)}s`
}

function formatTime(iso: string) {
  try {
    return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(iso))
  } catch {
    return iso
  }
}

function formatElapsed(job: Job, now: number) {
  const start = new Date(job.createdAt).getTime()
  const end = isDone(job) ? new Date(job.updatedAt).getTime() : now
  return Math.max(0, Math.round((end - start) / 1000))
}

function truncate(text: string, max = 44) {
  if (!text) return '（无目标文本）'
  return text.length > max ? `${text.slice(0, max)}…` : text
}

type IconProps = { size?: number; className?: string }

function WaveIcon({ size = 18, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" className={className} aria-hidden="true">
      <path d="M3 12h2M7 8v8M11 5v14M15 8v8M19 11h2" />
    </svg>
  )
}

function UploadIcon({ size = 18, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M12 16V4m0 0 4 4m-4-4L8 8" />
      <path d="M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
    </svg>
  )
}

function PlayIcon({ size = 18, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M8 5.5v13a1 1 0 0 0 1.5.86l10-6.5a1 1 0 0 0 0-1.72l-10-6.5A1 1 0 0 0 8 5.5Z" />
    </svg>
  )
}

function DownloadIcon({ size = 18, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M12 4v11m0 0 4-4m-4 4-4-4" />
      <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
    </svg>
  )
}

function SaveIcon({ size = 18, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M5 4h11l3 3v13H5V4Z" />
      <path d="M8 4v5h8V4M8 20v-6h8v6" />
    </svg>
  )
}

function XIcon({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className={className} aria-hidden="true">
      <path d="m6 6 12 12M18 6 6 18" />
    </svg>
  )
}

function AlertIcon({ size = 18, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M12 3 2.5 20h19L12 3Z" />
      <path d="M12 9v4m0 3h.01" />
    </svg>
  )
}

function CheckIcon({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="m5 12 4 4L19 6" />
    </svg>
  )
}

function ClockIcon({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <circle cx="12" cy="12" r="8" />
      <path d="M12 7v5l3 2" />
    </svg>
  )
}

function RefreshIcon({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M20 11a8 8 0 1 0-2.3 6.3" />
      <path d="M20 5v6h-6" />
    </svg>
  )
}

function SparkIcon({ size = 18, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M12 3 13.8 9l5.2 1.8-5.2 1.8L12 19l-1.8-6.4L5 10.8 10.2 9 12 3Z" />
      <path d="M19 17.5 19.7 20l2.3.7-2.3.7L19 24l-.7-2.6-2.3-.7 2.3-.7.7-2.5Z" />
    </svg>
  )
}

function App() {
  const [health, setHealth] = useState<Health | null>(null)
  const [healthLoading, setHealthLoading] = useState(true)
  const [view, setView] = useState<'clone' | 'faceswap' | 'video-faceswap' | 'detect' | 'detect-image' | 'detect-video' | 'defense' | 'defense-video'>('clone')
  const [config, setConfig] = useState<Config>({
    languages: DEFAULT_LANGUAGES,
    maxUploadMb: 50,
    maxTargetChars: 2000,
    model: { id: 'qwen3-tts-1.7b-base', name: 'Qwen3-TTS 1.7B Base' },
  })
  const [file, setFile] = useState<File | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [audioDuration, setAudioDuration] = useState<number | null>(null)
  const [referenceText, setReferenceText] = useState('')
  const [targetText, setTargetText] = useState('')
  const [language, setLanguage] = useState('Chinese')
  const [consent, setConsent] = useState(false)
  const [job, setJob] = useState<Job | null>(null)
  const [history, setHistory] = useState<Job[]>([])
  const [error, setError] = useState<ApiError | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [savedPath, setSavedPath] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const [now, setNow] = useState(Date.now())
  const inputRef = useRef<HTMLInputElement | null>(null)

  const refreshHealth = useCallback(async () => {
    setHealthLoading(true)
    try {
      const next = await getHealth()
      setHealth(next)
    } catch (err) {
      setHealth({ ok: false, baseUrl: '', error: toApiError(err) })
    } finally {
      setHealthLoading(false)
    }
  }, [])

  const refreshHistory = useCallback(async () => {
    try {
      const data = await getJobs()
      setHistory(data.items)
    } catch {
      // history is non-critical
    }
  }, [])

  useEffect(() => {
    void refreshHealth()
    const id = window.setInterval(refreshHealth, 15000)
    return () => window.clearInterval(id)
  }, [refreshHealth])

  useEffect(() => {
    getConfig()
      .then((next) => {
        setConfig(next)
        if (!next.languages.includes(language)) setLanguage(next.languages[0] ?? 'Chinese')
      })
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    void refreshHistory()
  }, [refreshHistory])

  useEffect(() => {
    if (!previewUrl) return
    return () => URL.revokeObjectURL(previewUrl)
  }, [previewUrl])

  useEffect(() => {
    if (!job || isDone(job)) return
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [job])

  useEffect(() => {
    if (!job || isDone(job)) return
    let cancelled = false
    const tick = async () => {
      try {
        const next = await getJob(job.id)
        if (cancelled) return
        setJob(next)
        if (next.status === 'failed' && next.error) setError(next.error)
      } catch (err) {
        if (!cancelled) setError(toApiError(err))
      }
    }
    void tick()
    const id = window.setInterval(tick, 1500)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [job?.id, job?.status, job?.resultUrl])

  useEffect(() => {
    if (!job) return
    if (job.status === 'succeeded' || job.status === 'failed' || job.status === 'canceled') {
      void refreshHistory()
    }
  }, [job?.status, refreshHistory])

  useEffect(() => {
    if (!notice) return
    const id = window.setTimeout(() => setNotice(null), 4500)
    return () => window.clearTimeout(id)
  }, [notice])

  const languages = config.languages.length ? config.languages : DEFAULT_LANGUAGES
  const maxTarget = config.maxTargetChars || 2000
  const busy = isBusy(job)
  const canSubmit = Boolean(
    file &&
      referenceText.trim() &&
      targetText.trim() &&
      consent &&
      health?.ok &&
      !busy &&
      !submitting,
  )
  const elapsed = job ? formatElapsed(job, now) : 0
  const progress = job ? Math.max(0, Math.min(1, job.progress || 0)) : 0
  const stageLabel = job ? (STAGE_LABELS[job.stage] ?? STAGE_LABELS[job.status] ?? job.stage) : ''
  const resultSrc = job?.resultUrl ? `${job.resultUrl}?v=${encodeURIComponent(job.updatedAt)}` : null
  const cloneHistory = history.filter((item) => (item.task ?? 'audio.clone') === 'audio.clone')

  const acceptFile = (next: File | null) => {
    setError(null)
    if (!next) {
      setFile(null)
      setPreviewUrl(null)
      setAudioDuration(null)
      return
    }
    if (!next.type.startsWith('audio/') && !/\.(wav|mp3|m4a|flac|ogg|aac|opus)$/i.test(next.name)) {
      setError({ code: 'UNSUPPORTED_MIME', message: '请选择音频文件', hint: '支持 wav / mp3 / m4a / flac / ogg', retryable: false })
      return
    }
    if (next.size > config.maxUploadMb * 1024 * 1024) {
      setError({ code: 'PAYLOAD_TOO_LARGE', message: `文件超过 ${config.maxUploadMb}MB`, hint: '裁剪参考音频后再试', retryable: false })
      return
    }
    const url = URL.createObjectURL(next)
    setFile(next)
    setPreviewUrl(url)
    setAudioDuration(null)
    const audio = new Audio()
    audio.preload = 'metadata'
    audio.onloadedmetadata = () => {
      if (Number.isFinite(audio.duration)) setAudioDuration(audio.duration)
    }
    audio.src = url
  }

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setDragging(false)
    const next = event.dataTransfer.files?.[0]
    if (next) acceptFile(next)
  }

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault()
    if (!canSubmit || !file) return
    setSubmitting(true)
    setError(null)
    setSavedPath(null)
    setJob(null)
    const form = new FormData()
    form.append('reference_audio', file, file.name)
    form.append('reference_text', referenceText.trim())
    form.append('target_text', targetText.trim())
    form.append('language', language)
    form.append('consent', 'true')
    try {
      const created = await submitJob(form)
      setJob(created)
      setNow(Date.now())
    } catch (err) {
      setError(toApiError(err))
    } finally {
      setSubmitting(false)
    }
  }

  const handleCancel = async () => {
    if (!job) return
    try {
      const next = await cancelJob(job.id)
      setJob(next)
    } catch (err) {
      setError(toApiError(err))
    }
  }

  const handleSave = async () => {
    if (!job) return
    setSaving(true)
    try {
      const saved = await saveJob(job.id)
      setSavedPath(saved.path)
      setNotice(`已保存到 ${saved.path}`)
    } catch (err) {
      setError(toApiError(err))
    } finally {
      setSaving(false)
    }
  }

  const openHistory = async (item: Job) => {
    setError(null)
    setSavedPath(null)
    setReferenceText(item.referenceText || '')
    setTargetText(item.targetText || '')
    setLanguage(item.language || 'Chinese')
    setJob(item)
    if (!isDone(item)) {
      try {
        const fresh = await getJob(item.id)
        setJob(fresh)
        setNow(Date.now())
      } catch (err) {
        setError(toApiError(err))
      }
    }
  }

  const resetAll = () => {
    setJob(null)
    setError(null)
    setSavedPath(null)
    setFile(null)
    setPreviewUrl(null)
    setAudioDuration(null)
    setReferenceText('')
    setTargetText('')
    setConsent(false)
  }

  const connectionText = healthLoading
    ? '检测连接中…'
    : health?.ok
      ? health.model?.loaded
        ? 'GPU 已连接 · 模型已加载'
        : 'GPU 已连接 · 模型待加载'
      : 'GPU 未连接'
  const connectionClass = healthLoading ? 'checking' : health?.ok ? 'ok' : 'bad'
  const durationWarning = audioDuration !== null && (audioDuration < 3 || audioDuration > 30)

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark"><WaveIcon size={18} /></span>
          <div>
            <strong>Deepfake Studio</strong>
            <span>克隆 / 换脸 / 检测</span>
          </div>
        </div>
        <div className="topbar-right">
          <span className={`status-pill ${connectionClass}`}>
            <i />
            {connectionText}
          </span>
          <span className="policy-pill">仅本人 / 授权素材</span>
        </div>
      </header>

      <main className="shell">
        <section className="hero">
          {view === 'clone' ? (
            <>
              <div className="eyebrow">VOICE CLONE / LOCAL DEMO</div>
              <h1>用你的声音，<span>说任何话。</span></h1>
              <p className="hero-copy">
                上传 3–30 秒参考录音，填写逐字稿和想说的新内容。音频只发送到你的 GPU 服务器，生成结果自动回到本地。
              </p>
              <div className="hero-meta">
                <span><CheckIcon size={14} /> 上传即生成</span>
                <span><CheckIcon size={14} /> 结果可播放 / 下载</span>
                <span><CheckIcon size={14} /> 支持 m4a / mp3 自动转码</span>
              </div>
            </>
          ) : view === 'faceswap' ? (
            <>
              <div className="eyebrow">FACE SWAP / LOCAL DEMO</div>
              <h1>一张脸，<span>换到另一张画面。</span></h1>
              <p className="hero-copy">
                上传源脸图和目标图，远端可选 HyperSwap 256（2025，256px）或 inswapper 128（2023，legacy）。目标多人脸默认处理最大脸，结果 PNG 自动回到本地。
              </p>
              <div className="hero-meta">
                <span><CheckIcon size={14} /> 新旧模型可选</span>
                <span><CheckIcon size={14} /> 结果可下载 / 保存</span>
                <span><CheckIcon size={14} /> 仅本人 / 授权素材</span>
              </div>
            </>
          ) : view === 'video-faceswap' ? (
            <>
              <div className="eyebrow">VIDEO FACE SWAP / LOCAL DEMO</div>
              <h1>一张脸，<span>换到整段视频。</span></h1>
              <p className="hero-copy">
                源脸图 + 目标视频，逐帧 HyperSwap 256（FaceFusion 2025）或 inswapper 128（2023），保留原音轨。用于防御实验和检测演示。
              </p>
              <div className="hero-meta">
                <span><CheckIcon size={14} /> 两个换脸模型</span>
                <span><CheckIcon size={14} /> 保留音轨</span>
                <span><CheckIcon size={14} /> 最多 300 帧</span>
              </div>
            </>
          ) : view === 'detect-image' ? (
            <>
              <div className="eyebrow">IMAGE FORENSICS / LOCAL DEMO</div>
              <h1>这张脸，<span>哪里不自然？</span></h1>
              <p className="hero-copy">
                上传一张图片，检测每张脸是否像换脸结果，并用整脸框、top-2 面部区域和热图标出可疑位置。
              </p>
              <div className="hero-meta">
                <span><CheckIcon size={14} /> 人脸级检测</span>
                <span><CheckIcon size={14} /> 区域框 + 热图</span>
                <span><CheckIcon size={14} /> 结果不是司法鉴定</span>
              </div>
            </>
          ) : view === 'detect-video' ? (
            <>
              <div className="eyebrow">VIDEO FORENSICS / LOCAL DEMO</div>
              <h1>这段说话视频，<span>哪里不对劲？</span></h1>
              <p className="hero-copy">
                上传正脸说话视频，可选 RealForensics（视觉时序）或 AVFF（音画联合），输出视频级 fake 概率。模型和年代在下方标注。
              </p>
              <div className="hero-meta">
                <span><CheckIcon size={14} /> 视频级检测</span>
                <span><CheckIcon size={14} /> 视觉 / 音画可选</span>
                <span><CheckIcon size={14} /> 结果不是司法鉴定</span>
              </div>
            </>
          ) : view === 'defense' ? (
            <>
              <div className="eyebrow">PROACTIVE DEFENSE / LOCAL DEMO</div>
              <h1>先保护，<span>再发出去。</span></h1>
              <p className="hero-copy">
                给自己的照片加不可感知扰动和水印，降低被换脸利用的概率；同时生成可验证的保护证书。
              </p>
              <div className="hero-meta">
                <span><CheckIcon size={14} /> 扰动 + 水印</span>
                <span><CheckIcon size={14} /> PSNR / SSIM</span>
                <span><CheckIcon size={14} /> 保护有边界</span>
              </div>
            </>
          ) : view === 'defense-video' ? (
            <>
              <div className="eyebrow">VIDEO DEFENSE / LOCAL DEMO</div>
              <h1>让视频，<span>更难被换掉。</span></h1>
              <p className="hero-copy">
                逐帧加不可感知扰动和水印，重建带音轨的保护视频；再用 RealForensics 做保护前后对比，直接看分数和片段变化。
              </p>
              <div className="hero-meta">
                <span><CheckIcon size={14} /> 逐帧扰动</span>
                <span><CheckIcon size={14} /> 保护前后对比</span>
                <span><CheckIcon size={14} /> 实验性，不保证绝对防御</span>
              </div>
            </>
          ) : (
            <>
              <div className="eyebrow">AUDIO FORENSICS / LOCAL DEMO</div>
              <h1>这段声音，<span>是真人还是合成？</span></h1>
              <p className="hero-copy">
                上传一段音频，选择检测模型。远端按 4 秒窗口分析，给出 fake 概率、可疑时间段和模型警告。
              </p>
              <div className="hero-meta">
                <span><CheckIcon size={14} /> 模型可选</span>
                <span><CheckIcon size={14} /> 时间线定位</span>
                <span><CheckIcon size={14} /> 结果不是司法鉴定</span>
              </div>
            </>
          )}
        </section>

        <div className="mode-tabs" role="tablist" aria-label="功能">
          <button
            type="button"
            role="tab"
            aria-selected={view === 'clone'}
            className={`mode-tab ${view === 'clone' ? 'active' : ''}`}
            onClick={() => setView('clone')}
          >
            音频克隆
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === 'faceswap'}
            className={`mode-tab ${view === 'faceswap' ? 'active' : ''}`}
            onClick={() => setView('faceswap')}
          >
            图片换脸
            <span className="mode-new">NEW</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === 'video-faceswap'}
            className={`mode-tab ${view === 'video-faceswap' ? 'active' : ''}`}
            onClick={() => setView('video-faceswap')}
          >
            视频换脸
            <span className="mode-new">NEW</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === 'detect'}
            className={`mode-tab ${view === 'detect' ? 'active' : ''}`}
            onClick={() => setView('detect')}
          >
            音频检测
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === 'detect-image'}
            className={`mode-tab ${view === 'detect-image' ? 'active' : ''}`}
            onClick={() => setView('detect-image')}
          >
            图片检测
            <span className="mode-new">NEW</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === 'detect-video'}
            className={`mode-tab ${view === 'detect-video' ? 'active' : ''}`}
            onClick={() => setView('detect-video')}
          >
            视频检测
            <span className="mode-new">NEW</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === 'defense'}
            className={`mode-tab ${view === 'defense' ? 'active' : ''}`}
            onClick={() => setView('defense')}
          >
            主动防御
            <span className="mode-new">NEW</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === 'defense-video'}
            className={`mode-tab ${view === 'defense-video' ? 'active' : ''}`}
            onClick={() => setView('defense-video')}
          >
            视频防御
            <span className="mode-new">NEW</span>
          </button>
        </div>

        {health && !health.ok && (
          <div className="banner bad" role="alert">
            <AlertIcon />
            <div>
              <strong>连不上 GPU 服务器</strong>
              <p>{health.error?.hint ?? '确认本地 SSH 隧道已启动，并且远端服务正在运行。'}</p>
            </div>
            <button type="button" className="ghost small" onClick={refreshHealth}>
              <RefreshIcon /> 重试
            </button>
          </div>
        )}

        {view === 'clone' ? (
          <>
            <div className="workspace">
          <form className="card input-card" onSubmit={handleSubmit}>
            <div className="card-head">
              <div>
                <span className="kicker">STEP 01</span>
                <h2>准备素材</h2>
              </div>
              <span className="tag">audio.clone</span>
            </div>

            <div className="field">
              <div className="field-head">
                <label htmlFor="audio-input">参考音频</label>
                <span className="hint">3–30s · 单人 · 尽量清晰</span>
              </div>
              <div
                className={`dropzone ${dragging ? 'dragging' : ''} ${file ? 'has-file' : ''}`}
                role="button"
                tabIndex={0}
                onClick={() => inputRef.current?.click()}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') inputRef.current?.click()
                }}
                onDragOver={(event) => {
                  event.preventDefault()
                  setDragging(true)
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={handleDrop}
              >
                <input
                  id="audio-input"
                  ref={inputRef}
                  type="file"
                  accept="audio/*,.wav,.mp3,.m4a,.flac,.ogg"
                  hidden
                  onChange={(event) => {
                    acceptFile(event.target.files?.[0] ?? null)
                    event.target.value = ''
                  }}
                />
                {file ? (
                  <div className="file-row">
                    <span className="file-icon"><WaveIcon size={20} /></span>
                    <div className="file-meta">
                      <strong>{file.name}</strong>
                      <span>
                        {audioDuration !== null ? formatDuration(audioDuration) : '读取时长…'}
                        {' · '}
                        {formatBytes(file.size)}
                        {durationWarning ? ' · 建议 3–30s' : ''}
                      </span>
                    </div>
                    <button
                      type="button"
                      className="icon-button"
                      aria-label="移除参考音频"
                      onClick={(event) => {
                        event.stopPropagation()
                        acceptFile(null)
                      }}
                    >
                      <XIcon />
                    </button>
                  </div>
                ) : (
                  <div className="dropzone-empty">
                    <span className="upload-icon"><UploadIcon size={22} /></span>
                    <strong>拖入参考音频，或点击选择</strong>
                    <span>wav / mp3 / m4a / flac · 最大 {config.maxUploadMb}MB</span>
                  </div>
                )}
              </div>
              {previewUrl && <audio className="reference-audio" src={previewUrl} controls preload="metadata" />}
            </div>

            <div className="field">
              <div className="field-head">
                <label htmlFor="reference-text">参考文本 <span className="required">*</span></label>
                <span className="hint">参考音频的逐字稿</span>
              </div>
              <textarea
                id="reference-text"
                value={referenceText}
                onChange={(event) => setReferenceText(event.target.value)}
                placeholder="把参考音频里的内容逐字写下来。例如：今天天气不错，我录一段话作为参考。"
                maxLength={maxTarget}
                rows={3}
              />
              <div className="char-row">
                <span>不是要生成的内容，而是参考音频说了什么</span>
                <span>{referenceText.length}/{maxTarget}</span>
              </div>
            </div>

            <div className="field">
              <div className="field-head">
                <label htmlFor="target-text">目标文本 <span className="required">*</span></label>
                <span className="hint">想让克隆声音说的话</span>
              </div>
              <textarea
                id="target-text"
                value={targetText}
                onChange={(event) => setTargetText(event.target.value)}
                placeholder="输入想让克隆声音说的新内容。例如：欢迎使用本地 Deepfake 演示平台，这是一段克隆生成的语音。"
                maxLength={maxTarget}
                rows={3}
              />
              <div className="char-row">
                <span>支持中文、英文等 10 种语言</span>
                <span>{targetText.length}/{maxTarget}</span>
              </div>
            </div>

            <div className="form-row">
              <div className="field compact">
                <label htmlFor="language">语言</label>
                <select id="language" value={language} onChange={(event) => setLanguage(event.target.value)}>
                  {languages.map((item) => (
                    <option key={item} value={item}>{LANGUAGE_LABELS[item] ?? item}</option>
                  ))}
                </select>
              </div>
              <label className="consent">
                <input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} />
                <span>我确认这是本人或已获授权的音频，仅用于本地演示。</span>
              </label>
            </div>

            {error && (
              <div className="error-box" role="alert">
                <AlertIcon />
                <div>
                  <strong>{error.code}</strong>
                  <p>{error.message}</p>
                  {error.hint && <span>{error.hint}</span>}
                </div>
                <button type="button" className="icon-button" onClick={() => setError(null)} aria-label="关闭错误">
                  <XIcon />
                </button>
              </div>
            )}

            <button className="primary" type="submit" disabled={!canSubmit}>
              {submitting ? '正在提交…' : busy ? '生成中…' : '开始生成'}
            </button>
            <p className="form-note">
              {health?.ok ? '提交后会占用 GPU 队列；生成结果自动下载到本地。' : '连接 GPU 服务器后才能开始生成。'}
            </p>
          </form>

          <section className="card result-card" aria-live="polite">
            <div className="card-head">
              <div>
                <span className="kicker">STEP 02</span>
                <h2>生成结果</h2>
              </div>
              <span className="tag muted">{config.model.name}</span>
            </div>

            {!job && (
              <div className="result-empty">
                <div className="wave-art" aria-hidden="true">
                  {[14, 28, 42, 22, 54, 34, 62, 26, 48, 18, 38, 24, 52, 30, 44].map((height, index) => (
                    <i key={index} style={{ height: `${height}px`, animationDelay: `${index * 0.08}s` }} />
                  ))}
                </div>
                <strong>结果会在这里出现</strong>
                <p>上传参考音频、填写两段文本，点击“开始生成”。</p>
                <div className="empty-steps">
                  <span>1. 参考音频</span>
                  <span>2. 参考文本</span>
                  <span>3. 目标文本</span>
                </div>
              </div>
            )}

            {job && (
              <div className="result-content">
                <div className="job-head">
                  <span className={`job-badge ${job.status}`}>{STATUS_LABELS[job.status] ?? job.status}</span>
                  <span className="elapsed"><ClockIcon size={14} /> {elapsed}s</span>
                  {busy && (
                    <button type="button" className="ghost small" onClick={handleCancel}>
                      取消
                    </button>
                  )}
                </div>

                {busy && (
                  <div className="progress-block">
                    <div className="progress-track">
                      <div className="progress-fill" style={{ width: `${Math.max(4, progress * 100)}%` }} />
                    </div>
                    <div className="progress-meta">
                      <span>{stageLabel}</span>
                      <span>{Math.round(progress * 100)}%</span>
                    </div>
                  </div>
                )}

                {job.warning && (
                  <div className="warning-box">
                    <AlertIcon size={16} />
                    <div>
                      <strong>{job.warning.code}</strong>
                      <p>{job.warning.hint ?? job.warning.message}</p>
                    </div>
                  </div>
                )}

                {job.status === 'succeeded' && resultSrc && (
                  <>
                    <div className="player-card">
                      <div className="player-head">
                        <span className="player-icon"><PlayIcon size={18} /></span>
                        <div>
                          <strong>克隆音频已就绪</strong>
                          <span>{formatElapsed(job, now)}s 生成 · {formatBytes(job.sizeBytes)}</span>
                        </div>
                      </div>
                      <audio src={resultSrc} controls preload="metadata" />
                    </div>

                    <div className="result-meta">
                      <div><span>模型</span><strong>{job.modelId}</strong></div>
                      <div><span>语言</span><strong>{LANGUAGE_LABELS[job.language] ?? job.language}</strong></div>
                      <div><span>参考时长</span><strong>{formatDuration(job.durationS)}</strong></div>
                      <div><span>创建时间</span><strong>{formatTime(job.createdAt)}</strong></div>
                    </div>

                    {job.routeReason && (
                      <details className="route-detail">
                        <summary>为什么选这个模型？</summary>
                        <p>{job.routeReason}</p>
                      </details>
                    )}

                    <div className="actions">
                      <a className="button secondary" href={`${job.resultUrl}?download=1`} download>
                        <DownloadIcon /> 下载 WAV
                      </a>
                      <button type="button" className="button secondary" onClick={handleSave} disabled={saving}>
                        <SaveIcon /> {saving ? '保存中…' : '保存到下载文件夹'}
                      </button>
                      <button type="button" className="button ghost" onClick={() => { setJob(null); setSavedPath(null); }}>
                        再生成一段
                      </button>
                    </div>
                    {savedPath && <p className="saved-path">已保存：{savedPath}</p>}
                  </>
                )}

                {job.status === 'succeeded' && !resultSrc && (
                  <div className="result-empty small">
                    <div className="spinner" />
                    <strong>生成完成，正在取回音频…</strong>
                    <p>本地服务会从 GPU 服务器下载产物，请稍等。</p>
                    <button
                      type="button"
                      className="ghost small"
                      onClick={async () => {
                        try {
                          const fresh = await getJob(job.id)
                          setJob(fresh)
                        } catch (err) {
                          setError(toApiError(err))
                        }
                      }}
                    >
                      <RefreshIcon /> 刷新
                    </button>
                  </div>
                )}

                {job.status === 'failed' && (
                  <div className="result-failed">
                    <AlertIcon size={20} />
                    <div>
                      <strong>{job.error?.code ?? '生成失败'}</strong>
                      <p>{job.error?.message ?? '远端任务失败，请重试。'}</p>
                      {job.error?.hint && <span>{job.error.hint}</span>}
                    </div>
                    <button type="button" className="ghost small" onClick={() => { setJob(null); setError(null); }}>
                      重新填写
                    </button>
                  </div>
                )}

                {job.status === 'canceled' && (
                  <div className="result-empty small">
                    <strong>任务已取消</strong>
                    <p>可以修改输入后重新提交。</p>
                    <button type="button" className="ghost small" onClick={() => setJob(null)}>
                      返回
                    </button>
                  </div>
                )}
              </div>
            )}
          </section>
        </div>

        <section className="history-section">
          <div className="section-head">
            <div>
              <span className="kicker">RECENT</span>
              <h2>最近生成</h2>
            </div>
            <div className="section-actions">
              <button type="button" className="ghost small" onClick={refreshHistory}>
                <RefreshIcon /> 刷新
              </button>
              <button type="button" className="ghost small" onClick={resetAll}>清空当前</button>
            </div>
          </div>
          {cloneHistory.length === 0 ? (
            <div className="empty-history">还没有生成记录。第一次生成后会出现在这里。</div>
          ) : (
            <div className="history-list">
              {cloneHistory.map((item) => (
                <button type="button" key={item.id} className="history-item" onClick={() => void openHistory(item)}>
                  <span className={`history-dot ${item.status}`} />
                  <div className="history-copy">
                    <strong>{truncate(item.targetText)}</strong>
                    <span>{formatTime(item.createdAt)} · {STATUS_LABELS[item.status] ?? item.status} · {LANGUAGE_LABELS[item.language] ?? item.language}</span>
                  </div>
                  {item.resultUrl && <span className="history-play"><PlayIcon size={13} /></span>}
                </button>
              ))}
            </div>
          )}
        </section>
          </>
        ) : view === 'faceswap' ? (
          <FaceSwapPanel health={health} refreshHealth={refreshHealth} />
        ) : view === 'video-faceswap' ? (
          <VideoFaceSwapPanel health={health} refreshHealth={refreshHealth} />
        ) : view === 'detect-image' ? (
          <ImageDetectionPanel health={health} refreshHealth={refreshHealth} />
        ) : view === 'detect-video' ? (
          <VideoDetectionPanel health={health} refreshHealth={refreshHealth} />
        ) : view === 'defense' ? (
          <DefensePanel health={health} refreshHealth={refreshHealth} />
        ) : view === 'defense-video' ? (
          <VideoDefensePanel health={health} refreshHealth={refreshHealth} />
        ) : (
          <DetectionPanel health={health} refreshHealth={refreshHealth} />
        )}

        <footer className="footer">
          <span><SparkIcon size={14} /> 本地演示 · {view === 'clone' ? '克隆结果自动保存到 app/data/results' : view === 'faceswap' ? '换脸结果保存到 app/data/results' : view === 'defense' ? '保护图与证书保存到 app/data/results' : view === 'defense-video' ? '保护视频与证书保存到 app/data/results' : view === 'detect-video' ? '视频检测报告保存在本地历史' : '检测报告保存在本地历史'}</span>
          <span>素材只发送到你的 GPU 服务器 · 视频检测支持时间轴/关键帧</span>
        </footer>
      </main>

      {notice && <div className="toast">{notice}</div>}
    </div>
  )
}

export default App
