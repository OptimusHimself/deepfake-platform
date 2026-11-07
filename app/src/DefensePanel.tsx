import { useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { getJob, getJobs, submitDefense, toApiError } from './api'
import type { ApiError, Health, Job } from './types'

const STAGE_LABEL: Record<string, string> = {
  queued: '排队中',
  protecting: '优化扰动 / 嵌入水印',
  succeeded: '已完成',
  failed: '失败',
  canceled: '已取消',
}

const STRENGTHS = [
  { id: 'low', label: '低', note: '肉眼几乎无感 · 快速' },
  { id: 'medium', label: '中', note: '推荐 · 画质与保护平衡' },
  { id: 'high', label: '高', note: '更强扰动 · 画质下降' },
]

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

export default function DefensePanel({ health, refreshHealth }: Props) {
  const [file, setFile] = useState<File | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [strength, setStrength] = useState('medium')
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
      setHistory((data.items || []).filter((item) => item.task === 'defend.image').slice(0, 6))
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
    const id = window.setInterval(tick, 1500)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [job?.id, job?.status, job?.resultUrl])

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
    form.append('strength', strength)
    form.append('consent', 'true')
    try {
      const created = await submitDefense(form)
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

  const report = job?.report
  const metrics = report?.metrics
  const isBusy = busy(job)
  const canSubmit = Boolean(file && consent && health?.ok && !submitting && !isBusy)
  const elapsed = job ? Math.max(0, Math.round(((done(job) ? new Date(job.updatedAt).getTime() : now) - new Date(job.createdAt).getTime()) / 1000)) : 0
  const progress = job ? Math.max(0.04, Math.min(1, job.progress || 0)) : 0
  const protectedSrc = job?.resultUrl ? `${job.resultUrl}?v=${encodeURIComponent(job.updatedAt)}` : null

  return (
    <>
      <div className="workspace">
        <form className="card input-card" onSubmit={submit}>
          <div className="card-head">
            <div>
              <span className="kicker">STEP 01</span>
              <h2>保护你的照片</h2>
            </div>
            <span className="tag muted">defend.image</span>
          </div>

          <div className="field">
            <div className="field-head">
              <label>原始图片</label>
              <span className="hint">本人 / 授权素材 · ≤20MB</span>
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
                  <img src={previewUrl} alt="待保护图片" />
                  <button type="button" className="image-remove" aria-label="移除图片" onClick={(event) => { event.stopPropagation(); accept(null) }}>
                    <XIcon />
                  </button>
                  <span className="image-name">{file?.name}</span>
                </>
              ) : (
                <div className="image-empty">
                  <span className="upload-icon"><CheckIcon size={22} /></span>
                  <strong>拖入图片或点击选择</strong>
                  <span>正脸清晰、光线均匀效果最好</span>
                </div>
              )}
            </div>
          </div>

          <div className="field">
            <div className="field-head">
              <label>保护强度</label>
              <span className="hint">越高越影响画质</span>
            </div>
            <div className="strength-grid">
              {STRENGTHS.map((item) => (
                <label key={item.id} className={`strength-card ${strength === item.id ? 'selected' : ''}`}>
                  <input type="radio" name="strength" value={item.id} checked={strength === item.id} onChange={() => setStrength(item.id)} />
                  <div><strong>{item.label}</strong><span>{item.note}</span></div>
                </label>
              ))}
            </div>
          </div>

          <div className="model-note">
            <span className="tag muted">CLIP PGD + DwtDctSvd · 2022/2023</span>
            <p>旧版防御基线：优化 CLIP 全局语义 + DwtDctSvd 水印，<strong>没有针对换脸身份编码器</strong>，实际防护有限。SGD-Guard（IJCAI 2026）/ NullSwap（ICCV 2025）+ TrustMark 正在替换。</p>
          </div>

          <label className="consent" style={{ marginTop: 18 }}>
            <input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} />
            <span>我确认这是本人或已授权图片，并理解保护效果有边界。</span>
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
            {submitting ? '正在提交…' : isBusy ? '保护中…' : '生成保护图'}
          </button>
          <p className="form-note">
            {!health?.ok ? '先连接 GPU 服务器。' : '扰动与水印在远端 GPU 完成；保护图和证书下载到本地。'}
          </p>
        </form>

        <section className="card result-card" aria-live="polite">
          <div className="card-head">
            <div>
              <span className="kicker">STEP 02</span>
              <h2>保护结果</h2>
            </div>
            <span className="tag muted">{metrics ? `${metrics.psnr_db}dB · SSIM ${metrics.ssim}` : '保护证书'}</span>
          </div>

          {!job && (
            <div className="result-empty">
              <div className="scan-art" aria-hidden="true">
                <i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i />
              </div>
              <strong>等待一张照片</strong>
              <p>生成保护图后，这里会显示画质指标、水印状态和证书。</p>
              <div className="empty-steps">
                <span>1. 上传照片</span>
                <span>2. 选强度</span>
                <span>3. 生成保护图</span>
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
                  <div className="progress-meta"><span>{STAGE_LABEL[job.stage] ?? '保护中'}</span><span>{Math.round(progress * 100)}%</span></div>
                </div>
              )}

              {metrics && (
                <>
                  <div className="protection-grid">
                    <div><span>PSNR</span><strong>{metrics.psnr_db}<small>dB</small></strong></div>
                    <div><span>SSIM</span><strong>{metrics.ssim}</strong></div>
                    <div><span>水印</span><strong>{metrics.watermark_match ? '解码成功' : '解码失败'}</strong></div>
                    <div><span>强度</span><strong>{metrics.strength}</strong></div>
                  </div>

                  {protectedSrc && (
                    <div className="image-result">
                      <img src={protectedSrc} alt="保护图" />
                    </div>
                  )}

                  <div className="result-meta">
                    <div><span>水印 ID</span><strong>{metrics.watermark_id}</strong></div>
                    <div><span>图片</span><strong>{metrics.width}×{metrics.height}</strong></div>
                    <div><span>证书</span><strong>{report?.certificate?.certificate_id ?? '—'}</strong></div>
                    <div><span>方法</span><strong>{report?.method ?? 'clip-pgd+dwtdctsvd'}</strong></div>
                  </div>

                  <div className="warning-list">
                    {(report?.warnings || []).map((item: string, index: number) => <p key={index}><AlertIcon size={13} /> {item}</p>)}
                  </div>

                  <div className="actions">
                    <a className="button secondary" href={`${job.resultUrl}?download=1`}>下载保护图</a>
                    <a className="button secondary" href={job.certUrl ? `${job.certUrl}&download=1` : undefined} aria-disabled={!job.certUrl}>下载证书</a>
                    <button type="button" className="button ghost" onClick={reset}>再保护一张</button>
                  </div>
                </>
              )}

              {job.status === 'succeeded' && !metrics && (
                <div className="result-empty small">
                  <div className="spinner" />
                  <strong>正在取回保护结果…</strong>
                </div>
              )}

              {job.status === 'failed' && (
                <div className="result-failed">
                  <AlertIcon size={20} />
                  <div>
                    <strong>{job.error?.code ?? '保护失败'}</strong>
                    <p>{job.error?.message ?? '远端保护失败，请重试。'}</p>
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
            <h2>最近保护</h2>
          </div>
          <button type="button" className="ghost small" onClick={loadHistory}><RefreshIcon /> 刷新</button>
        </div>
        {history.length === 0 ? (
          <div className="empty-history">还没有保护记录。</div>
        ) : (
          <div className="history-list">
            {history.map((item) => (
              <button type="button" key={item.id} className="history-item" onClick={() => { setJob(item); setError(null) }}>
                <span className={`history-dot ${item.status}`} />
                <div className="history-copy">
                  <strong>{item.report?.metrics ? `PSNR ${item.report.metrics.psnr_db}dB` : '保护图'}</strong>
                  <span>{formatTime(item.createdAt)} · {item.report?.metrics?.strength ?? '—'} · {item.modelId}</span>
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
