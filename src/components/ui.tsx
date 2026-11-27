import { useEffect, useRef, useState } from 'react'
import type { ReactNode, CSSProperties } from 'react'
import { ChevronDown, Languages, Lock, Moon, ShieldCheck, Sun } from 'lucide-react'
import type { Protocol, Theme, Lang } from '../types'

export function Card({ title, sub, icon, children, className = '', style }: {
  title?: ReactNode; sub?: string; icon?: ReactNode; children: ReactNode; className?: string; style?: CSSProperties
}) {
  return (
    <section className={`card ${className}`} style={style}>
      {title && <h3 className="card-title">{icon}{title}{sub && <span className="sub">{sub}</span>}</h3>}
      {children}
    </section>
  )
}

export function Toggle({ checked, onChange, disabled }: {
  checked: boolean; onChange: (v: boolean) => void; disabled?: boolean
}) {
  return (
    <button
      type="button"
      className={`switch ${checked ? 'on' : ''}`}
      onClick={() => onChange(!checked)}
      disabled={disabled}
      aria-pressed={checked}
      role="switch"
    />
  )
}

export function FieldRow({ title, desc, control }: {
  title: string; desc?: string; control: ReactNode
}) {
  return (
    <div className="field-row">
      <div className="field-label">
        <div className="t">{title}</div>
        {desc && <div className="d">{desc}</div>}
      </div>
      {control}
    </div>
  )
}

export function Segment<T extends string>({ value, options, onChange }: {
  value: T; options: { value: T; label: string }[]; onChange: (v: T) => void
}) {
  return (
    <div className="segment" role="tablist">
      {options.map((o) => (
        <button
          key={o.value}
          className={value === o.value ? 'active' : ''}
          onClick={() => onChange(o.value)}
          role="tab"
          aria-selected={value === o.value}
        >{o.label}</button>
      ))}
    </div>
  )
}

export const PROTOCOLS: Protocol[] = ['wg', 'awg', 'gool', 'masque', 'masque-h2', 'masque-mm']

export const PROTOCOL_LABELS: Record<Protocol, string> = {
  wg: 'WireGuard',
  awg: 'AWG',
  gool: 'GOOL',
  masque: 'MASQUE H3',
  'masque-h2': 'MASQUE H2',
  'masque-mm': 'MASQUE in MASQUE',
}

export function ProtocolPicker({ value, onChange, label }: {
  value: Protocol; onChange: (p: Protocol) => void; label?: string
}) {
  return (
    <div>
      {label && <div className="muted" style={{ fontSize: 12, marginBottom: 8, fontWeight: 600 }}>{label}</div>}
      <div className="segment" role="tablist">
        {PROTOCOLS.map((p) => (
          <button key={p} className={value === p ? 'active' : ''} onClick={() => onChange(p)} role="tab" aria-selected={value === p}>
            {PROTOCOL_LABELS[p]}
          </button>
        ))}
      </div>
    </div>
  )
}

/** 首页协议下拉框：盾牌图标 + 当前协议 + 展开箭头 */
export function ProtocolSelect({ value, onChange, label, availableLabel = '可用', compact = false, disabled = false, valueText, hint, lockLabel }: {
  value: Protocol
  onChange: (p: Protocol) => void
  label?: string
  availableLabel?: string
  compact?: boolean
  /** 只读：当前连接模式下 WARP 协议不参与（如订阅节点直接出口） */
  disabled?: boolean
  /** 只读时显示的文案（例如订阅节点自己的 VLESS） */
  valueText?: string
  hint?: string
  lockLabel?: string
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  // 进入只读状态时收起菜单，避免残留在已禁用的触发器下面
  useEffect(() => {
    if (disabled) setOpen(false)
  }, [disabled])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div ref={rootRef} className={`proto-select ${compact ? 'compact' : ''} ${disabled ? 'disabled' : ''}`}>
      {label && <div className="muted proto-label">{label}</div>}
      <button
        type="button"
        className={`proto-trigger ${open ? 'open' : ''}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-disabled={disabled}
        disabled={disabled}
        title={disabled ? hint : undefined}
        onClick={() => { if (!disabled) setOpen((v) => !v) }}
      >
        <ShieldCheck size={compact ? 15 : 18} className="proto-shield" />
        <span className="proto-value">{valueText ?? PROTOCOL_LABELS[value]}</span>
        {disabled
          ? <span className="proto-lock"><Lock size={compact ? 11 : 12} />{lockLabel ?? ''}</span>
          : <ChevronDown size={compact ? 14 : 16} className={`proto-chevron ${open ? 'open' : ''}`} />}
      </button>
      {hint && <div className="proto-hint">{hint}</div>}
      {open && !disabled && (
        <div className="proto-menu" role="listbox">
          {PROTOCOLS.map((p) => (
            <button
              key={p}
              type="button"
              role="option"
              aria-selected={p === value}
              className={`proto-option ${p === value ? 'selected' : ''}`}
              onClick={() => { onChange(p); setOpen(false) }}
            >
              <span className="proto-name">{PROTOCOL_LABELS[p]}</span>
              <span className="proto-available"><span className="dot" />{availableLabel}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export function Stat({ label, value, sub, color }: {
  label: string; value: ReactNode; sub?: string; color?: string
}) {
  return (
    <div className="card" style={{ padding: '14px 18px' }}>
      <div className="muted" style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.4px', textTransform: 'uppercase' }}>{label}</div>
      <div className="strong mono" style={{ fontSize: 18, marginTop: 6, color: color || 'var(--text)' }}>{value}</div>
      {sub && <div className="muted" style={{ fontSize: 11, marginTop: 3 }}>{sub}</div>}
    </div>
  )
}

/** 轻量 SVG 折线图 —— 不依赖 recharts，减少包体 */
export function LatencyChart({ points, color = 'var(--brand)' }: {
  points: { t: number; ms: number }[]; color?: string
}) {
  const w = 600, h = 150, pad = 12
  const latest = points[points.length - 1]
  if (points.length < 2) {
    return (
      <div className="muted" style={{ fontSize: 12, padding: '38px 0', textAlign: 'center' }}>
        {latest ? <span className="strong mono" style={{ fontSize: 20, color }}>{latest.ms} ms</span> : '—'}
      </div>
    )
  }
  const max = Math.max(...points.map((p) => p.ms)) * 1.2 || 100
  const min = Math.min(...points.map((p) => p.ms)) * 0.8
  const span = Math.max(1, max - min)
  const coords = points.map((p, i) => {
    const x = pad + (i / (points.length - 1)) * (w - pad * 2)
    const y = pad + (1 - (p.ms - min) / span) * (h - pad * 2)
    return `${x.toFixed(1)},${y.toFixed(1)}`
  })
  const area = `${pad},${h - pad} ${coords.join(' ')} ${w - pad},${h - pad}`
  const gid = 'grad-' + color.replace(/[^a-z0-9]/gi, '')
  return (
    <div style={{ position: 'relative' }}>
      <div style={{
        position: 'absolute', right: 8, top: 6, zIndex: 1,
        padding: '4px 9px', borderRadius: 10, fontSize: 13, fontWeight: 800,
        background: 'var(--card)', border: `1px solid ${color}`, color,
      }}>
        {latest.ms} ms
      </div>
      <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} preserveAspectRatio="none" role="img" aria-label={`latency chart, latest ${latest.ms} ms`}>
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={color} stopOpacity="0.28" />
            <stop offset="1" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0.25, 0.5, 0.75].map((r) => (
          <line key={r} x1={pad} x2={w - pad} y1={pad + r * (h - pad * 2)} y2={pad + r * (h - pad * 2)} stroke="var(--border)" strokeDasharray="3 5" />
        ))}
        <polygon points={area} fill={`url(#${gid})`} />
        <polyline points={coords.join(' ')} fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
        <circle cx={coords[coords.length - 1].split(',')[0]} cy={coords[coords.length - 1].split(',')[1]} r="4" fill={color} />
      </svg>
    </div>
  )
}

/**
 * 上下行速率波形：两条曲线共用一个纵轴刻度，面积填充在下方。
 * 纵轴下限固定为 8 KB/s，避免空载时的几十字节抖动把曲线放大成"满屏尖峰"。
 */
export function RateChart({ points, upColor = 'var(--warn)', downColor = 'var(--brand)', height = 132 }: {
  points: { t: number; up: number; down: number }[]
  upColor?: string; downColor?: string; height?: number
}) {
  const w = 600, h = height, pad = 10
  if (points.length < 2) {
    return (
      <div className="muted" style={{ fontSize: 12, height: h, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        —
      </div>
    )
  }
  const peak = Math.max(...points.map((p) => Math.max(p.up, p.down)), 8 * 1024)
  const max = peak * 1.15
  const xAt = (i: number) => pad + (i / (points.length - 1)) * (w - pad * 2)
  const yAt = (v: number) => pad + (1 - Math.max(0, v) / max) * (h - pad * 2)
  const line = (key: 'up' | 'down') =>
    points.map((p, i) => `${xAt(i).toFixed(1)},${yAt(p[key]).toFixed(1)}`).join(' ')
  const areaOf = (key: 'up' | 'down') => `${pad},${h - pad} ${line(key)} ${w - pad},${h - pad}`
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} preserveAspectRatio="none" role="img"
      aria-label={`rate chart, latest up ${points[points.length - 1].up} B/s down ${points[points.length - 1].down} B/s`}>
      <defs>
        <linearGradient id="rate-grad-down" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={downColor} stopOpacity="0.3" />
          <stop offset="1" stopColor={downColor} stopOpacity="0" />
        </linearGradient>
        <linearGradient id="rate-grad-up" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={upColor} stopOpacity="0.22" />
          <stop offset="1" stopColor={upColor} stopOpacity="0" />
        </linearGradient>
      </defs>
      {[0.25, 0.5, 0.75].map((r) => (
        <line key={r} x1={pad} x2={w - pad} y1={pad + r * (h - pad * 2)} y2={pad + r * (h - pad * 2)}
          stroke="var(--border)" strokeDasharray="3 5" />
      ))}
      <polygon points={areaOf('down')} fill="url(#rate-grad-down)" />
      <polygon points={areaOf('up')} fill="url(#rate-grad-up)" />
      <polyline points={line('up')} fill="none" stroke={upColor} strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" opacity="0.9" />
      <polyline points={line('down')} fill="none" stroke={downColor} strokeWidth="2.2" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )
}

export function ThemeLangControls({ theme, lang, onTheme, onLang, t }: {
  theme: Theme; lang: Lang; onTheme: (t: Theme) => void; onLang: (l: Lang) => void;
  t: (k: string) => string
}) {
  const nextTheme: Theme = theme === 'dark' ? 'light' : 'dark'
  const nextLang: Lang = lang === 'zh' ? 'en' : 'zh'
  const themeTitle = t(nextTheme === 'dark' ? 'themeSwitchToDark' : 'themeSwitchToLight')
  const langTitle = t(nextLang === 'en' ? 'langSwitchToEn' : 'langSwitchToZh')
  return (
    <div className="icon-controls">
      <button className="icon-btn" type="button" title={themeTitle} aria-label={themeTitle} onClick={() => onTheme(nextTheme)}>
        {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
      </button>
      <button className="icon-btn" type="button" title={langTitle} aria-label={langTitle} onClick={() => onLang(nextLang)}>
        <Languages size={18} />
        <span className="icon-lang-badge">{lang === 'zh' ? '中' : 'EN'}</span>
      </button>
    </div>
  )
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

export function formatRate(bytesPerSec: number): string {
  const n = Math.max(0, bytesPerSec)
  if (n < 1024) return `${Math.round(n)} B/s`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB/s`
  return `${(n / 1024 / 1024).toFixed(2)} MB/s`
}

export function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
}
