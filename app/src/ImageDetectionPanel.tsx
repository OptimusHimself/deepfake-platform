import { useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { getJob, getJobs, submitImageDetection, toApiError } from './api'
import type { ApiError, Health, Job } from './types'

const STAGE_LABEL: Record<string, string> = {
  queued: '排队中',
  loading_detector: '加载检测模型',
  analyzing: '分析人脸',
  succeeded: '已完成',
  failed: '失败',
  canceled: '已取消',
}

const VERDICT_LABEL: Record<string, string> = {
  fake: '偏假',
  real: '偏真',
  uncertain: '不确定',
}

function done(job: Job) {
  return job.status === 'failed' || job.status === 'canceled' || (job.status === 'succeeded' && Boolean(job.report))
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

type Props = {
  health: Health | null
  refreshHealth: () => void
}

export default function ImageDetectionPanel({ health, refreshHealth }: Props) {
  const [file, setFile] = useState<File | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [consent, setConsent] = useState(false)
  const [job, setJob] = useState<Job | null>(null)
  const [history, setHistory] = useState<Job[]>([])
  const [error, setError] = useState<ApiError | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [now, setNow] = useState(Date.now())
  const inputRef = useRef<HTMLInputElement | null>(null)

  const loadHistory = useCallback(async () => {
    try {
      const data = await getJobs()
      setHistory((data.items || []).filter((item) => item.task === 'detect.image').slice(0, 6))
    } catch {
      // non-critical
    }
  }, [])

  useEffect(() => {
    void loadHistory()
  }, [loadHistory])

  useEffect(() => {
    if (!previewUrl) return
    return () => URL.revokeObjectURL(previewUrl)
  }, [previewUrl])

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
  }, [job?.id, job?.status, job?.report, job?.overlayUrl])

  useEffect(() => {
    if (job?.status === 'succeeded' || job?.status === 'failed') void loadHistory()
  }, [job?.status, loadHistory])

  const accept = (next: File | null) => {
    setError(null)
    if (!next) {
      setFile(null)
      setPreviewUrl(null)
      return
    }
    if (!next.type.startsWith('image/')) {
      setError({ code: 'UNSUPPORTED_MIME', message: '请选择图片', hint: 'JPG / PNG / WEBP', retryable: false })
      return
    }
    if (next.size > 20 * 1024 * 1024) {
      setError({ code: 'PAYLOAD_TOO_LARGE', message: '图片超过 20MB', hint: '压缩后再试', retryable: false })
      return
    }
    setFile(next)
    setPreviewUrl(URL.createObjectURL(next))
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!file || !consent || !health?.ok || submitting || busy(job)) return
    setSubmitting(true)
    setError(null)
    setJob(null)
    const form = new FormData()
    form.append('file', file, file.name)
    form.append('consent', 'true')
    try {
      const created = await submitImageDetection(form)
      setJob(created)
      setNow(Date.now())
    } catch (err) {
      setError(toApiError(err))
    } finally {
      setSubmitting(false)
    }
  }

  const reset = () => {
    setJob(null)
    setError(null)
  }

  const report = job?.report ?? null
  const isBusy = busy(job)
  const canSubmit = Boolean(file && consent && health?.ok && !submitting && !isBusy)
  const elapsed = job ? Math.max(0, Math.round(((done(job) ? new Date(job.updatedAt).getTime() : now) - new Date(job.createdAt).getTime()) / 1000)) : 0
  const progress = job ? Math.max(0.04, Math.min(1, job.progress || 0)) : 0
  const verdict = report ? (VERDICT_LABEL[report.verdict] ?? report.verdict) : ''
  const verdictClass = report?.verdict ?? 'uncertain'
  const overlay = job?.overlayUrl ? `${job.overlayUrl}&v=${encodeURIComponent(job.updatedAt)}` : null
  const showing = overlay || previewUrl

  return (
    <>
      <div className="workspace">
        <form className="card input-card" onSubmit={submit}>
          <div className="card-head">
            <div>
              <span className="kicker">STEP 01</span>
              <h2>上传待检测图片</h2>
            </div>
            <span className="tag muted">detect.image</span>
          </div>

          <div className="field">
            <div className="field-head">
              <label htmlFor="image-detect-input">图片</label>
              <span className="hint">JPG / PNG / WEBP · ≤20MB</span>
            </div>
            <div
              className={`image-drop ${dragging ? 'dragging' : ''} ${previewUrl ? 'has-image' : ''}`}
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
              onDrop={(event) => {
                event.preventDefault()
                setDragging(false)
                accept(event.dataTransfer.files?.[0] ?? null)
              }}
            >
              <input
                id="image-detect-input"
                ref={inputRef}
                type="file"
                accept="image/*,.jpg,.jpeg,.png,.webp"
                hidden
                onChange={(event) => {
                  accept(event.target.files?.[0] ?? null)
                  event.target.value = ''
                }}
              />
              {previewUrl ? (
                <>
                  <img src={previewUrl} alt="待检测图片" />
                  <button
                    type="button"
                    className="image-remove"
                    aria-label="移除图片"
                    onClick={(event) => {
                      event.stopPropagation()
                      accept(null)
                    }}
                  >
                    <XIcon />
                  </button>
                  <span className="image-name">{file?.name}</span>
                </>
              ) : (
                <div className="image-empty">
                  <span className="upload-icon"><CheckIcon size={22} /></span>
                  <strong>拖入图片或点击选择</strong>
                  <span>正脸清晰、无遮挡效果最好</span>
                </div>
              )}
            </div>
          </div>

          <div className="model-note">
            <span className="tag muted">EffNet-B4 ensemble · 2023</span>
            <p>2023 年的 Celeb-DF + FF++ 检测器集成，阈值 58% 为内部小样本校准。它只是当前可用的基线；AIDE（ICLR 2025）/ CFA 等新检测分支正在升级。</p>
          </div>

          <label className="consent" style={{ marginTop: 18 }}>
            <input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} />
            <span>我确认有权分析这张图片，并理解检测结果不是司法鉴定结论。</span>
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
            {submitting ? '正在提交…' : isBusy ? '分析中…' : '开始检测'}
          </button>
          <p className="form-note">
            {!health?.ok ? '先连接 GPU 服务器。' : '检测在远端 GPU 完成；结果和标注图会下载到本地。'}
          </p>
        </form>

        <section className="card result-card" aria-live="polite">
          <div className="card-head">
            <div>
              <span className="kicker">STEP 02</span>
              <h2>检测结果</h2>
            </div>
            <span className="tag muted">{report ? report.model_version : '换脸检测'}</span>
          </div>

          {!job && (
            <div className="result-empty">
              <div className="scan-art" aria-hidden="true">
                <i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i />
              </div>
              <strong>等待一张人脸</strong>
              <p>上传图片后，模型会检测每张脸并标出最可疑的面部区域。</p>
              <div className="empty-steps">
                <span>1. 上传图片</span>
                <span>2. 人脸分析</span>
                <span>3. 区域标注</span>
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
                  <div className="progress-meta"><span>{STAGE_LABEL[job.stage] ?? '分析中'}</span><span>{Math.round(progress * 100)}%</span></div>
                </div>
              )}

              {report && (
                <>
                  <div className={`verdict-card ${verdictClass}`}>
                    <div>
                      <span className="verdict-kicker">模型判断</span>
                      <strong>{verdict}</strong>
                      <p>置信度 {report.confidence} · 阈值 {Math.round(report.threshold * 100)}%</p>
                    </div>
                    <div className="verdict-score">
                      <strong>{Math.round(report.score * 100)}<small>%</small></strong>
                      <span>fake 概率</span>
                    </div>
                  </div>

                  <div className="score-meter">
                    <div className={`score-fill ${verdictClass}`} style={{ width: `${Math.max(2, report.score * 100)}%` }} />
                    <i style={{ left: `${report.threshold * 100}%` }} />
                  </div>

                  {showing && (
                    <div className="image-result detect-image-result">
                      <img src={showing} alt="检测标注" />
                    </div>
                  )}

                  <div className="segment-list">
                    {(report.faces || []).map((face: any, index: number) => (
                      <span key={index} className={`segment-row ${face.verdict}`}>
                        脸 {index + 1} · {face.verdict} · {Math.round(face.score * 100)}%
                        {face.zones?.[0] ? ` · ${face.zones[0].zone}` : ''}
                      </span>
                    ))}
                  </div>

                  <div className="result-meta">
                    <div><span>人脸数</span><strong>{report.faces?.length ?? report.processing.faces ?? '—'}</strong></div>
                    <div><span>图片尺寸</span><strong>{report.processing.width}×{report.processing.height}</strong></div>                    <div><span>检测模型</span><strong>{report.models[0]?.model_id ?? job.modelId}</strong></div>
                    <div><span>分析时间</span><strong>{formatTime(report.created_at)}</strong></div>
                  </div>

                  <details className="route-detail" open>
                    <summary>模型怎么说</summary>
                    <ul className="explain-list">
                      {report.explanations.map((item: string, index: number) => <li key={index}>{item}</li>)}
                    </ul>
                  </details>

                  <div className="warning-list">
                    {report.warnings.map((item: string, index: number) => (
                      <p key={index}><AlertIcon size={13} /> {item}</p>
                    ))}
                  </div>

                  <div className="actions">
                    <button type="button" className="button secondary" onClick={reset}>再检测一张</button>
                    <a className="button secondary" href={overlay ? `${overlay}&download=1` : undefined} aria-disabled={!overlay}>下载标注图</a>
                    <button type="button" className="button ghost" onClick={() => { void loadHistory(); refreshHealth() }}>
                      <RefreshIcon /> 刷新
                    </button>
                  </div>
                </>
              )}

              {job.status === 'succeeded' && !report && (
                <div className="result-empty small">
                  <div className="spinner" />
                  <strong>分析完成，正在取回报告…</strong>
                </div>
              )}

              {job.status === 'failed' && (
                <div className="result-failed">
                  <AlertIcon size={20} />
                  <div>
                    <strong>{job.error?.code ?? '检测失败'}</strong>
                    <p>{job.error?.message ?? '远端检测失败，请重试。'}</p>
                    {job.error?.hint && <span>{job.error.hint}</span>}
                  </div>
                  <button type="button" className="ghost small" onClick={reset}>重新上传</button>
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
            <h2>最近图片检测</h2>
          </div>
          <button type="button" className="ghost small" onClick={loadHistory}><RefreshIcon /> 刷新</button>
        </div>
        {history.length === 0 ? (
          <div className="empty-history">还没有图片检测记录。</div>
        ) : (
          <div className="history-list">
            {history.map((item) => (
              <button type="button" key={item.id} className="history-item" onClick={() => { setJob(item); setError(null) }}>
                <span className={`history-dot ${item.report?.verdict === 'fake' ? 'failed' : item.report?.verdict === 'real' ? 'succeeded' : 'queued'}`} />
                <div className="history-copy">
                  <strong>{item.report ? `${VERDICT_LABEL[item.report.verdict] ?? item.report.verdict} · ${Math.round(item.report.score * 100)}%` : item.modelId}</strong>
                  <span>{formatTime(item.createdAt)} · {item.modelId}</span>
                </div>
                {item.report && <CheckIcon size={13} />}
              </button>
            ))}
          </div>
        )}
      </section>
    </>
  )
}
