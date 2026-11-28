import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import jsQR from 'jsqr'
import { Camera, ImagePlus, Loader, RefreshCw, X, AlertCircle } from 'lucide-react'
import { tr } from '../i18n'
import { useStore } from '../store'

/**
 * 二维码扫描弹窗。
 *
 * 桌面版没有手机那种系统扫码器，这里用 WebView2 的 getUserMedia 直接开摄像头，
 * 配合纯 JS 解码（jsQR，无原生依赖）识别对方设备「局域网同步」的二维码。
 * 没有摄像头 / 权限被拒时退回「选图片」——手机拍屏或截图后也能识别，
 * 另外支持直接 Ctrl+V 粘贴剪贴板里的截图。
 */
export function QrScanDialog({ onClose, onResult }: {
  onClose: () => void
  onResult: (text: string) => void
}) {
  const { settings } = useStore()
  const t = (k: string, vars?: Record<string, string | number>) => tr(k, settings.lang, vars)

  const videoRef = useRef<HTMLVideoElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const rafRef = useRef(0)
  const lastTick = useRef(0)
  const doneRef = useRef(false)
  const [err, setErr] = useState('')
  const [starting, setStarting] = useState(true)
  const [imgName, setImgName] = useState('')

  const stop = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    rafRef.current = 0
    streamRef.current?.getTracks().forEach((tr2) => { try { tr2.stop() } catch { /* ignore */ } })
    streamRef.current = null
    const v = videoRef.current
    if (v && v.srcObject) v.srcObject = null
  }, [])

  const hit = useCallback((text: string) => {
    if (doneRef.current) return
    const value = text.trim()
    if (!value) return
    doneRef.current = true
    stop()
    onResult(value)
  }, [onResult, stop])

  /** 视频帧 → ImageData → 解码。约 8 帧/秒，避免 jsQR 吃满 CPU 把预览拖卡 */
  const tick = useCallback((ts: number) => {
    rafRef.current = requestAnimationFrame(tick)
    if (doneRef.current) return
    if (ts - lastTick.current < 120) return
    lastTick.current = ts
    const v = videoRef.current
    const c = canvasRef.current
    if (!v || !c || v.readyState < 2 || !v.videoWidth) return
    const scale = Math.min(1, 640 / Math.max(v.videoWidth, v.videoHeight))
    const w = Math.round(v.videoWidth * scale)
    const h = Math.round(v.videoHeight * scale)
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h }
    const ctx = c.getContext('2d', { willReadFrequently: true })
    if (!ctx) return
    ctx.drawImage(v, 0, 0, w, h)
    const img = ctx.getImageData(0, 0, w, h)
    const res = jsQR(img.data, w, h, { inversionAttempts: 'attemptBoth' })
    if (res?.data) hit(res.data)
  }, [hit])

  const start = useCallback(async () => {
    stop()
    doneRef.current = false
    setErr('')
    setStarting(true)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      })
      streamRef.current = stream
      const v = videoRef.current
      if (!v) { stream.getTracks().forEach((x) => x.stop()); return }
      v.srcObject = stream
      await v.play().catch(() => { /* 自动播放被拦时仍能出帧 */ })
      setStarting(false)
      rafRef.current = requestAnimationFrame(tick)
    } catch (e: any) {
      setStarting(false)
      const name = e?.name || ''
      if (name === 'NotAllowedError' || name === 'SecurityError') setErr(t('scanDenied'))
      else if (name === 'NotFoundError' || name === 'OverconstrainedError') setErr(t('scanNoCamera'))
      else setErr(t('scanCameraFail', { msg: e?.message || String(e) }))
    }
  }, [stop, tick, t])

  /** 图片（截图 / 拍照）识别 */
  const decodeBlob = useCallback(async (blob: Blob, label: string) => {
    setImgName(label)
    try {
      const bmp = await createImageBitmap(blob)
      const c = canvasRef.current
      if (!c) return
      const scale = Math.min(1, 1400 / Math.max(bmp.width, bmp.height))
      c.width = Math.max(1, Math.round(bmp.width * scale))
      c.height = Math.max(1, Math.round(bmp.height * scale))
      const ctx = c.getContext('2d', { willReadFrequently: true })
      if (!ctx) return
      ctx.drawImage(bmp, 0, 0, c.width, c.height)
      const img = ctx.getImageData(0, 0, c.width, c.height)
      const res = jsQR(img.data, c.width, c.height, { inversionAttempts: 'attemptBoth' })
      bmp.close?.()
      if (res?.data) hit(res.data)
      else setImgName(`${label} · ${t('scanNoCode')}`)
    } catch (e: any) {
      setImgName(`${label} · ${e?.message || e}`)
    }
  }, [hit, t])

  useEffect(() => {
    void start()
    return stop
    // 只在挂载时开一次摄像头，重试走 start()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    const onPaste = (e: ClipboardEvent) => {
      const item = [...(e.clipboardData?.items || [])].find((x) => x.type.startsWith('image/'))
      const file = item?.getAsFile()
      if (file) { e.preventDefault(); void decodeBlob(file, t('scanPasted')) }
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('paste', onPaste)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('paste', onPaste)
    }
  }, [onClose, decodeBlob, t])

  // 挂到 body：`.page-wrap.fade-in` 的动画会把 transform 落成 identity matrix，
  // 从而成为 position:fixed 的包含块，弹窗会被定位到整页高度里、滚出视野
  return createPortal(
    <div className="scan-mask" onClick={onClose}>
      <div className="scan-card" onClick={(e) => e.stopPropagation()}>
        <div className="scan-head">
          <span className="scan-title"><Camera size={15} />{t('scanTitle')}</span>
          <button className="icon-btn" title={t('scanClose')} onClick={onClose}><X size={15} /></button>
        </div>
        <div className="scan-desc muted">{t('scanDesc')}</div>

        <div className="scan-view">
          <video ref={videoRef} muted playsInline />
          {/* 解码用的离屏画布：jsQR 只吃 ImageData，必须先经过 canvas */}
          <canvas ref={canvasRef} hidden />
          {!err && <span className="scan-frame" />}
          {starting && !err && (
            <span className="scan-overlay"><Loader size={16} className="spin" />{t('scanOpening')}</span>
          )}
          {err && (
            <span className="scan-overlay bad">
              <AlertCircle size={18} />
              <span>{err}</span>
            </span>
          )}
        </div>

        <div className="scan-foot">
          <label className="btn btn-outline btn-sm">
            <ImagePlus size={14} />{t('scanPickImage')}
            <input
              type="file"
              accept="image/*"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0]
                e.target.value = ''
                if (f) void decodeBlob(f, f.name)
              }}
            />
          </label>
          {err && (
            <button className="btn btn-ghost btn-sm" onClick={() => void start()}>
              <RefreshCw size={13} />{t('scanRetry')}
            </button>
          )}
          <span className="scan-hint muted">{t('scanPasteHint')}</span>
        </div>
        {imgName && <div className="scan-name muted mono">{imgName}</div>}
      </div>
    </div>,
    document.body,
  )
}
