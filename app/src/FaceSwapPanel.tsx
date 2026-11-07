import { useCallback, useEffect, useRef, useState } from 'react'
import type { DragEvent, FormEvent } from 'react'
import { getFaceSwapModels, getJob, getJobs, saveJob, submitFaceSwap, toApiError } from './api'
import type { ApiError, FaceSwapModel, Health, Job } from './types'

const STAGE_LABEL: Record<string, string> = {
  queued: '排队中',
  loading_model: '加载换脸模型',
  swapping: '换脸中',
  postprocessing: '整理结果',
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

function formatBytes(value: number | null | undefined) {
  if (!value) return '—'
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}

function UploadIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 16V4m0 0 4 4m-4-4L8 8" />
      <path d="M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
    </svg>
  )
}

function AlertIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3 2.5 20h19L12 3Z" />
      <path d="M12 9v4m0 3h.01" />
    </svg>
  )
}

function CheckIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m5 12 4 4L19 6" />
    </svg>
  )
}

function RefreshIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 11a8 8 0 1 0-2.3 6.3" />
      <path d="M20 5v6h-6" />
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

type ImageInputProps = {
  label: string
  hint: string
  file: File | null
  url: string | null
  onChange: (file: File | null) => void
}

function ImageInput({ label, hint, file, url, onChange }: ImageInputProps) {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [dragging, setDragging] = useState(false)
  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setDragging(false)
    const next = event.dataTransfer.files?.[0]
    if (next?.type.startsWith('image/')) onChange(next)
  }
  return (
    <div className="field">
      <div className="field-head">
        <label>{label}</label>
        <span className="hint">{hint}</span>
      </div>
      <div
        className={`image-drop ${dragging ? 'dragging' : ''} ${url ? 'has-image' : ''}`}
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
          ref={inputRef}
          type="file"
          accept="image/*,.jpg,.jpeg,.png,.webp"
          hidden
          onChange={(event) => {
            onChange(event.target.files?.[0] ?? null)
            event.target.value = ''
          }}
        />
        {url ? (
          <>
            <img src={url} alt={label} />
            <button
              type="button"
              className="image-remove"
              aria-label={`移除${label}`}
              onClick={(event) => {
                event.stopPropagation()
                onChange(null)
              }}
            >
              <XIcon />
            </button>
            <span className="image-name">{file?.name}</span>
          </>
        ) : (
          <div className="image-empty">
            <span className="upload-icon"><UploadIcon /></span>
            <strong>拖入图片或点击选择</strong>
            <span>JPG / PNG / WEBP · ≤20MB</span>
          </div>
        )}
      </div>
    </div>
  )
}

type Props = {
  health: Health | null
  refreshHealth: () => void
}

export default function FaceSwapPanel({ health, refreshHealth }: Props) {
  const [source, setSource] = useState<File | null>(null)
  const [target, setTarget] = useState<File | null>(null)
  const [models, setModels] = useState<FaceSwapModel[]>([])
  const [model, setModel] = useState('auto')
  const [modelsError, setModelsError] = useState<ApiError | null>(null)
  const [sourceUrl, setSourceUrl] = useState<string | null>(null)
  const [targetUrl, setTargetUrl] = useState<string | null>(null)
  const [consent, setConsent] = useState(false)
  const [job, setJob] = useState<Job | null>(null)
  const [history, setHistory] = useState<Job[]>([])
  const [error, setError] = useState<ApiError | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [now, setNow] = useState(Date.now())
  const [saving, setSaving] = useState(false)
  const [savedPath, setSavedPath] = useState<string | null>(null)

  const loadHistory = useCallback(async () => {
    try {
      const data = await getJobs()
      setHistory((data.items || []).filter((item) => item.task === 'image.face_swap').slice(0, 6))
    } catch {
      // non-critical
    }
  }, [])

  const loadModels = useCallback(async () => {
    try {
      const data = await getFaceSwapModels()
      setModels(data.models || [])
      setModelsError(data.error ?? null)
      if (data.models?.length && model !== 'auto' && !data.models.some((item) => item.modelId === model)) {
        setModel('auto')
      }
    } catch (err) {
      setModels([])
      setModelsError(toApiError(err))
    }
  }, [model])

  useEffect(() => {
    void loadModels()
    void loadHistory()
  }, [loadModels, loadHistory])

  useEffect(() => {
    if (!sourceUrl) return
    return () => URL.revokeObjectURL(sourceUrl)
  }, [sourceUrl])
  useEffect(() => {
    if (!targetUrl) return
    return () => URL.revokeObjectURL(targetUrl)
  }, [targetUrl])

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
    const id = window.setInterval(tick, 1200)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [job?.id, job?.status, job?.resultUrl])

  useEffect(() => {
    if (job?.status === 'succeeded' || job?.status === 'failed') {
      void loadHistory()
    }
  }, [job?.status, loadHistory])

  const setImage = (which: 'source' | 'target', next: File | null) => {
    setError(null)
    if (which === 'source') {
      setSource(next)
      setSourceUrl(next ? URL.createObjectURL(next) : null)
    } else {
      setTarget(next)
      setTargetUrl(next ? URL.createObjectURL(next) : null)
    }
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!source || !target || !consent || !health?.ok || submitting || busy(job)) return
    setSubmitting(true)
    setError(null)
    setJob(null)
    setSavedPath(null)
    const form = new FormData()
    form.append('source_image', source, source.name)
    form.append('target_image', target, target.name)
    form.append('model', model)
    form.append('consent', 'true')
    try {
      const created = await submitFaceSwap(form)
      setJob(created)
      setNow(Date.now())
    } catch (err) {
      setError(toApiError(err))
    } finally {
      setSubmitting(false)
    }
  }

  const save = async () => {
    if (!job?.resultUrl) return
    setSaving(true)
    try {
      const result = await saveJob(job.id)
      setSavedPath(result.path)
    } catch (err) {
      setError(toApiError(err))
    } finally {
      setSaving(false)
    }
  }

  const reset = () => {
    setJob(null)
    setError(null)
  }

  const isBusy = busy(job)
  const canSubmit = Boolean(source && target && consent && health?.ok && !submitting && !isBusy)
  const elapsed = job ? Math.max(0, Math.round(((done(job) ? new Date(job.updatedAt).getTime() : now) - new Date(job.createdAt).getTime()) / 1000)) : 0
  const progress = job ? Math.max(0.04, Math.min(1, job.progress || 0)) : 0
  const resultSrc = job?.resultUrl ? `${job.resultUrl}?v=${encodeURIComponent(job.updatedAt)}` : null
  const activeModel = models.find((item) => item.modelId === job?.modelId)

  return (
    <>
      <div className="workspace">
        <form className="card input-card" onSubmit={submit}>
          <div className="card-head">
            <div>
              <span className="kicker">STEP 01</span>
              <h2>准备两张图</h2>
            </div>
            <span className="tag">image.face_swap</span>
          </div>

          <div className="pair-grid">
            <ImageInput label="源脸图" hint="要换上去的脸" file={source} url={sourceUrl} onChange={(next) => setImage('source', next)} />
            <ImageInput label="目标图" hint="被换脸的画面" file={target} url={targetUrl} onChange={(next) => setImage('target', next)} />
          </div>

          <div className="field">
            <div className="field-head">
              <label>换脸模型</label>
              <span className="hint">可自己选；旧模型保留作对照</span>
            </div>
            <div className="model-grid">
              <label className={`model-choice ${model === 'auto' ? 'selected' : ''}`}>
                <input type="radio" name="swap-model" value="auto" checked={model === 'auto'} onChange={() => setModel('auto')} />
                <div>
                  <strong>自动选择</strong>
                  <span>优先使用可用的最新模型（当前为 HyperSwap 256）</span>
                </div>
              </label>
              {models.map((item) => (
                <label key={item.modelId} className={`model-choice ${model === item.modelId ? 'selected' : ''} ${item.status !== 'ready' ? 'disabled' : ''}`}>
                  <input
                    type="radio"
                    name="swap-model"
                    value={item.modelId}
                    checked={model === item.modelId}
                    disabled={item.status !== 'ready'}
                    onChange={() => setModel(item.modelId)}
                  />
                  <div>
                    <strong>
                      {item.displayName}
                      {item.legacy && <span className="legacy-badge">旧版</span>}
                    </strong>
                    <span>{[item.vendor, item.year ? `${item.year} 年` : null, item.resolution ? `${item.resolution}px` : null].filter(Boolean).join(' · ')}</span>
                    <em>{[item.speed, item.license].filter(Boolean).join(' · ')}</em>
                    <span>{item.description}</span>
                  </div>
                </label>
              ))}
            </div>
            {modelsError && (
              <div className="warning-box" style={{ marginTop: 10 }}>
                <AlertIcon size={15} />
                <div><strong>{modelsError.code}</strong><p>{modelsError.hint ?? modelsError.message}</p></div>
              </div>
            )}
            {!models.length && !modelsError && <p className="form-note">正在读取换脸模型…</p>}
          </div>

          <div className="model-note">
            <span className="tag muted">模型说明</span>
            <p>HyperSwap 256：FaceFusion 3.3（2025），256px，ResearchRAIL 非商业研究。inswapper_128：InsightFace（2023），128px，旧版基线。目标多人脸默认选最大脸。</p>
          </div>

          <label className="consent" style={{ marginTop: 18 }}>
            <input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} />
            <span>我确认拥有这两张图片的使用权，且只用于本人/授权素材的演示。</span>
          </label>

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
            {submitting ? '正在提交…' : isBusy ? '换脸中…' : '开始换脸'}
          </button>
          <p className="form-note">
            {!health?.ok ? '先连接 GPU 服务器。' : '换脸在远端 GPU 完成；结果会下载到本地。'}
          </p>
        </form>

        <section className="card result-card" aria-live="polite">
          <div className="card-head">
            <div>
              <span className="kicker">STEP 02</span>
              <h2>换脸结果</h2>
            </div>
            <span className="tag muted">PNG</span>
          </div>

          {!job && (
            <div className="result-empty">
              <div className="scan-art" aria-hidden="true">
                <i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i />
              </div>
              <strong>等待两张图</strong>
              <p>左侧放要换上去的脸，右侧放被换脸的画面。多人脸默认处理最大脸。</p>
              <div className="empty-steps">
                <span>1. 源脸图</span>
                <span>2. 目标图</span>
                <span>3. 生成</span>
              </div>
            </div>
          )}

          {job && (
            <div className="result-content">
              <div className="job-head">
                <span className={`job-badge ${job.status}`}>{STAGE_LABEL[job.stage] ?? STAGE_LABEL[job.status] ?? job.status}</span>
                <span className="elapsed">用时 {elapsed}s</span>
              </div>

              {isBusy && (
                <div className="progress-block">
                  <div className="progress-track"><div className="progress-fill" style={{ width: `${Math.round(progress * 100)}%` }} /></div>
                  <div className="progress-meta"><span>{STAGE_LABEL[job.stage] ?? '处理中'}</span><span>{Math.round(progress * 100)}%</span></div>
                </div>
              )}

              {job.warning && (
                <div className="warning-box">
                  <AlertIcon size={16} />
                  <div><strong>{job.warning.code}</strong><p>{job.warning.hint ?? job.warning.message}</p></div>
                </div>
              )}

              {resultSrc && (
                <>
                  <div className="image-result">
                    <img src={resultSrc} alt="换脸结果" />
                  </div>
                  <div className="result-meta">
                    <div><span>模型</span><strong>{activeModel ? `${activeModel.displayName} · ${activeModel.year}` : job.modelId}</strong></div>
                    <div><span>大小</span><strong>{formatBytes(job.sizeBytes)}</strong></div>
                    <div><span>源图</span><strong>{job.sourceImageName ?? '—'}</strong></div>
                    <div><span>目标图</span><strong>{job.targetImageName ?? '—'}</strong></div>
                  </div>
                  <div className="actions">
                    <a className="button secondary" href={`${job.resultUrl}?download=1`}>下载 PNG</a>
                    <button type="button" className="button secondary" onClick={save} disabled={saving}>
                      {saving ? '保存中…' : '保存到下载文件夹'}
                    </button>
                    <button type="button" className="button ghost" onClick={reset}>再换一张</button>
                  </div>
                  {savedPath && <p className="form-note">已保存：{savedPath}</p>}
                </>
              )}

              {job.status === 'succeeded' && !resultSrc && (
                <div className="result-empty small">
                  <div className="spinner" />
                  <strong>正在取回结果…</strong>
                </div>
              )}

              {job.status === 'failed' && (
                <div className="result-failed">
                  <AlertIcon size={20} />
                  <div>
                    <strong>{job.error?.code ?? '换脸失败'}</strong>
                    <p>{job.error?.message ?? '远端换脸失败，请重试。'}</p>
                    {job.error?.hint && <span>{job.error.hint}</span>}
                  </div>
                  <button type="button" className="ghost small" onClick={reset}>重新上传</button>
                </div>
              )}

              {job.status === 'canceled' && (
                <div className="result-empty small">
                  <strong>任务已取消</strong>
                  <button type="button" className="ghost small" onClick={reset}>返回</button>
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
            <h2>最近换脸</h2>
          </div>
          <div className="section-actions">
            <button type="button" className="ghost small" onClick={loadHistory}><RefreshIcon /> 刷新</button>
          </div>
        </div>
        {history.length === 0 ? (
          <div className="empty-history">还没有换脸记录。</div>
        ) : (
          <div className="history-list">
            {history.map((item) => (
              <button type="button" key={item.id} className="history-item" onClick={() => { setJob(item); setError(null) }}>
                <span className={`history-dot ${item.status}`} />
                <div className="history-copy">
                  <strong>{item.sourceImageName ?? '换脸'} → {item.targetImageName ?? '目标图'}</strong>
                  <span>{formatTime(item.createdAt)} · {STAGE_LABEL[item.status] ?? item.status} · {item.modelId}</span>
                </div>
                {item.resultUrl && <CheckIcon size={13} />}
              </button>
            ))}
          </div>
        )}
      </section>
    </>
  )
}
