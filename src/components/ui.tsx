import type { ReactNode, CSSProperties } from 'react'
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
  if (points.length < 2) {
    return <div className="muted" style={{ fontSize: 12, padding: '38px 0', textAlign: 'center' }}>—</div>
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
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} preserveAspectRatio="none" role="img" aria-label="latency chart">
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
  )
}

export function ThemeLangControls({ theme, lang, onTheme, onLang, t }: {
  theme: Theme; lang: Lang; onTheme: (t: Theme) => void; onLang: (l: Lang) => void;
  t: (k: string) => string
}) {
  return (
    <div style={{ display: 'flex', gap: 8 }}>
      <div className="segment">
        {(['light', 'dark'] as Theme[]).map((th) => (
          <button key={th} className={theme === th ? 'active' : ''} onClick={() => onTheme(th)} title={th}>
            {t(th === 'light' ? 'themeLight' : 'themeDark')}
          </button>
        ))}
      </div>
      <div className="segment">
        {(['zh', 'en'] as Lang[]).map((lg) => (
          <button key={lg} className={lang === lg ? 'active' : ''} onClick={() => onLang(lg)}>{t(lg === 'zh' ? 'langZh' : 'langEn')}</button>
        ))}
      </div>
    </div>
  )
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

export function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
}
