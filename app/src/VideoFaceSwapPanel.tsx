import { useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { getFaceSwapModels, getJob, getJobs, submitVideoFaceSwap, toApiError } from './api'
import type { ApiError, FaceSwapModel, Health, Job } from './types'

const STAGE_LABEL: Record<string, string> = {
  queued: '排队中',
  swapping: '逐帧换脸 / 重建视频',
  succeeded: '已完成',
  failed: '失败',
  canceled: '已取消',
}

function done(job: Job) {
  return job.status === 'failed' || job.status === 'canceled' || (job.status === 'succeeded' && Boolean(job.resultUrl))
}

function busy(job: Job | null) {
  return Boolean(job && !done(job))
}

function formatTime(iso: string) {
  try {
    return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(iso))
  } catch {
    return iso
  }
}

function AlertIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3 2.5 20h19L12 3Z" />
      <path d="M12 9v4m0 3h.01" />
    </svg>
  )
}

function XIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="m6 6 12 12M18 6 6 18" />
    </svg>
  )
}

function SwapIcon({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M7 7h10l-2-2m2 2-2 2M17 17H7l2-2m-2 2 2 2" />
    </svg>
  )
}

type Props = { health: Health | null; refreshHealth: () => void }

export default function VideoFaceSwapPanel({ health, refreshHealth }: Props) {
  const [sourceFile, setSourceFile] = useState<File | null>(null)
  const [videoFile, setVideoFile] = useState<File | null>(null)
  const [sourcePreview, setSourcePreview] = useState<string | null>(null)
  const [videoPreview, setVideoPreview] = useState<string | null>(null)
  const [models, setModels] = useState<FaceSwapModel[]>([])
  const [model, setModel] = useState('hyperswap-256')
  const [consent, setConsent] = useState(false)
  const [job, setJob] = useState<Job | null>(null)
  const [history, setHistory] = useState<Job[]>([])
  const [error, setError] = useState<ApiError | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [now, setNow] = useState(Date.now())
  const sourceRef = useRef<HTMLInputElement | null>(null)
  const videoRef = useRef<HTMLInputElement | null>(null)

  const loadHistory = useCallback(async () => {
    try {
      const data = await getJobs()
      setHistory((data.items || []).filter((item) => item.task === 'video.face_swap').slice(0, 6))
    } catch {
      // non-critical
    }
  }, [])

  useEffect(() => { void loadHistory() }, [loadHistory])

  useEffect(() => {
    getFaceSwapModels().then((data) => {
      setModels(data.models || [])
      const ready = (data.models || []).find((item) => item.status === 'ready' && item.modelId === 'hyperswap-256')
      if (!ready) {
        const first = (data.models || []).find((item) => item.status === 'ready')
        if (first) setModel(first.modelId)
      }
    }).catch(() => {})
  }, [])

  useEffect(() => () => { if (sourcePreview) URL.revokeObjectURL(sourcePreview) }, [sourcePreview])
  useEffect(() => () => { if (videoPreview) URL.revokeObjectURL(videoPreview) }, [videoPreview])

  useEffect(() => {
    if (!job || done(job)) return
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [job])

  useEffect(() => {
    if (!job || done(job)) return
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
    return () => { cancelled = true; window.clearInterval(id) }
  }, [job?.id, job?.status, job?.resultUrl])

  useEffect(() => {
    if (job?.status === 'succeeded' || job?.status === 'failed') void loadHistory()
  }, [job?.status, loadHistory])

  const pickSource = (next: File | null) => {
    setError(null)
    if (!next) { setSourceFile(null); setSourcePreview(null); return }
    if (!next.type.startsWith('image/')) {
      setError({ code: 'UNSUPPORTED_MIME', message: '源脸必须是图片', hint: 'JPG / PNG / WEBP', retryable: false })
      return
    }
    if (next.size > 20 * 1024 * 1024) {
      setError({ code: 'PAYLOAD_TOO_LARGE', message: '源脸图片超过 20MB', hint: '压缩后重试', retryable: false })
      return
    }
    setSourceFile(next)
    setSourcePreview(URL.createObjectURL(next))
  }

  const pickVideo = (next: File | null) => {
    setError(null)
    if (!next) { setVideoFile(null); setVideoPreview(null); return }
    if (!next.type.startsWith('video/')) {
      setError({ code: 'UNSUPPORTED_MIME', message: '目标必须是视频', hint: 'MP4 / MOV / WEBM', retryable: false })
      return
    }
    if (next.size > 100 * 1024 * 1024) {
      setError({ code: 'PAYLOAD_TOO_LARGE', message: '视频超过 100MB', hint: '截短后重试', retryable: false })
      return
    }
    setVideoFile(next)
    setVideoPreview(URL.createObjectURL(next))
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!sourceFile || !videoFile || !consent || !health?.ok || submitting || busy(job)) return
    setSubmitting(true)
    setError(null)
    setJob(null)
    const form = new FormData()
    form.append('source_image', sourceFile, sourceFile.name)
    form.append('video', videoFile, videoFile.name)
    form.append('model', model)
    form.append('consent', 'true')
    try {
      const created = await submitVideoFaceSwap(form)
      setJob(created)
      setNow(Date.now())
    } catch (err) {
      setError(toApiError(err))
    } finally {
      setSubmitting(false)
    }
  }

  const reset = () => { setJob(null); setError(null) }
  const report = job?.report
  const isBusy = busy(job)
  const canSubmit = Boolean(sourceFile && videoFile && consent && health?.ok && !submitting && !isBusy)
  const elapsed = job ? Math.max(0, Math.round(((done(job) ? new Date(job.updatedAt).getTime() : now) - new Date(job.createdAt).getTime()) / 1000)) : 0
  const progress = job ? Math.max(0.03, Math.min(1, job.progress || 0)) : 0

  return (
    <>
      <div className="workspace">
        <form className="card input-card" onSubmit={submit}>
          <div className="card-head">
            <div><span className="kicker">STEP 01</span><h2>源脸 + 目标视频</h2></div>
            <span className="tag muted">video.face_swap</span>
          </div>

          <div className="field">
            <div className="field-head"><label>源脸图片</label><span className="hint">JPG / PNG / WEBP · ≤20MB</span></div>
            <div className={`image-drop ${sourcePreview ? 'has-image' : ''}`} role="button" tabIndex={0} onClick={() => sourceRef.current?.click()} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') sourceRef.current?.click() }}>
              <input ref={sourceRef} type="file" accept="image/*" hidden onChange={(e) => { pickSource(e.target.files?.[0] ?? null); e.target.value = '' }} />
              {sourcePreview ? (
                <>
                  <img src={sourcePreview} alt="源脸" />
                  <button type="button" className="image-remove" onClick={(e) => { e.stopPropagation(); pickSource(null) }}><XIcon /></button>
                  <span className="image-name">{sourceFile?.name}</span>
                </>
              ) : (
                <div className="image-empty"><span className="upload-icon"><SwapIcon /></span><strong>拖入源脸或点击选择</strong><span>换到视频里的那张脸</span></div>
              )}
            </div>
          </div>

          <div className="field">
            <div className="field-head"><label>目标视频</label><span className="hint">MP4 / MOV / WEBM · ≤100MB</span></div>
            <div className={`image-drop video-drop ${videoPreview ? 'has-image' : ''}`} role="button" tabIndex={0} onClick={() => videoRef.current?.click()} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') videoRef.current?.click() }}>
              <input ref={videoRef} type="file" accept="video/*,.mp4,.mov,.webm" hidden onChange={(e) => { pickVideo(e.target.files?.[0] ?? null); e.target.value = '' }} />
              {videoPreview ? (
                <>
                  <video src={videoPreview} controls muted playsInline />
                  <button type="button" className="image-remove" onClick={(e) => { e.stopPropagation(); pickVideo(null) }}><XIcon /></button>
                  <span className="image-name">{videoFile?.name}</span>
                </>
              ) : (
                <div className="image-empty"><span className="upload-icon"><SwapIcon /></span><strong>拖入视频或点击选择</strong><span>建议 2–10 秒、正脸</span></div>
              )}
            </div>
          </div>

          <div className="field">
            <div className="field-head"><label>换脸模型</label><span className="hint">FaceFusion / InsightFace</span></div>
            <div className="model-grid">
              {models.map((item) => (
                <label key={item.modelId} className={`model-choice ${model === item.modelId ? 'selected' : ''} ${item.status !== 'ready' ? 'disabled' : ''}`}>
                  <input type="radio" name="video-swap-model" value={item.modelId} checked={model === item.modelId} disabled={item.status !== 'ready'} onChange={() => setModel(item.modelId)} />
                  <div>
                    <strong>{item.displayName}</strong>
                    <span>{[item.year ? `${item.year} 年` : null, item.resolution ? `${item.resolution}px` : null, item.license].filter(Boolean).join(' · ')}</span>
                    <span>{item.description}</span>
                  </div>
                </label>
              ))}
            </div>
          </div>

          <label className="consent" style={{ marginTop: 14 }}>
            <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
            <span>我确认源脸和视频均为本人/授权素材；换脸结果仅用于防御实验。</span>
          </label>

          {error && <div className="error-box" role="alert"><AlertIcon /><div><strong>{error.code}</strong><p>{error.message}</p>{error.hint && <span>{error.hint}</span>}</div></div>}

          <button className="primary" type="submit" disabled={!canSubmit}>
            {submitting ? '正在提交…' : isBusy ? '逐帧换脸中…' : '生成换脸视频'}
          </button>
          <p className="form-note">{!health?.ok ? '先连接 GPU 服务器。' : '逐帧处理，保留原音轨；最多 300 帧。'}</p>
        </form>

        <section className="card result-card" aria-live="polite">
          <div className="card-head"><div><span className="kicker">STEP 02</span><h2>换脸结果</h2></div><span className="tag muted">{report?.model_version ?? 'video.face_swap'}</span></div>

          {!job && (
            <div className="result-empty">
              <div className="scan-art" aria-hidden="true"><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /></div>
              <strong>等待源脸和目标视频</strong>
              <p>换脸后可以把结果放进“视频检测”验证，或用于防御对比。</p>
              <div className="empty-steps"><span>1. 源脸</span><span>2. 目标视频</span><span>3. 逐帧换脸</span></div>
            </div>
          )}

          {job && (
            <div className="result-content">
              <div className="job-head"><span className={`job-badge ${job.status}`}>{STAGE_LABEL[job.stage] ?? STAGE_LABEL[job.status] ?? job.status}</span><span className="elapsed">用时 {elapsed}s</span></div>
              {isBusy && (
                <div className="progress-block"><div className="progress-track"><div className="progress-fill" style={{ width: `${Math.round(progress * 100)}%` }} /></div><div className="progress-meta"><span>{STAGE_LABEL[job.stage] ?? '换脸中'}</span><span>{Math.round(progress * 100)}%</span></div></div>
              )}
              {report && (
                <>
                  <div className="verdict-card real"><div><span className="verdict-kicker">换脸完成</span><strong>已生成视频</strong><p>{report.metrics?.swapped_frames ?? 0}/{report.metrics?.frames ?? 0} 帧检测到人脸</p></div><div className="verdict-score"><strong>{report.metrics?.seconds ?? '—'}<small>s</small></strong><span>耗时</span></div></div>
                  {job.resultUrl && <video className="video-result" src={`${job.resultUrl}?v=${encodeURIComponent(job.updatedAt)}`} controls muted playsInline />}
                  <div className="result-meta"><div><span>模型</span><strong>{report.model_version}</strong></div><div><span>帧数</span><strong>{report.metrics?.frames ?? '—'}</strong></div><div><span>换脸帧</span><strong>{report.metrics?.swapped_frames ?? '—'}</strong></div><div><span>截断</span><strong>{report.metrics?.truncated ? '是' : '否'}</strong></div></div>
                  <div className="warning-list">{(report.warnings || []).map((w: string, i: number) => <p key={i}><AlertIcon size={13} /> {w}</p>)}</div>
                  <div className="actions">
                    {job.resultUrl && <a className="button secondary" href={`${job.resultUrl}?download=1`}>下载换脸视频</a>}
                    <button type="button" className="button ghost" onClick={reset}>再换一段</button>
                  </div>
                </>
              )}
              {job.status === 'failed' && <div className="result-failed"><AlertIcon size={20} /><div><strong>{job.error?.code ?? '换脸失败'}</strong><p>{job.error?.message ?? '远端换脸失败'}</p>{job.error?.hint && <span>{job.error.hint}</span>}</div><button type="button" className="ghost small" onClick={reset}>重试</button></div>}
            </div>
          )}
        </section>
      </div>

      <section className="history-section">
        <div className="section-head"><div><span className="kicker">RECENT</span><h2>最近视频换脸</h2></div><button type="button" className="ghost small" onClick={() => { void loadHistory(); refreshHealth() }}>刷新</button></div>
        {history.length === 0 ? <div className="empty-history">还没有视频换脸记录。</div> : (
          <div className="history-list">{history.map((item) => (
            <button type="button" key={item.id} className="history-item" onClick={() => { setJob(item); setError(null) }}>
              <span className={`history-dot ${item.status === 'succeeded' ? 'succeeded' : item.status === 'failed' ? 'failed' : 'queued'}`} />
              <div className="history-copy"><strong>{item.targetImageName || item.modelId}</strong><span>{formatTime(item.createdAt)} · {item.modelId}</span></div>
            </button>
          ))}</div>
        )}
      </section>
    </>
  )
}
