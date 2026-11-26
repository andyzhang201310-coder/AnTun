import { useEffect, useState } from 'react'
import { Info, ExternalLink, Copy, ShieldCheck, FolderOpen } from 'lucide-react'
import { useStore } from '../store'
import { tr } from '../i18n'
import { Card, FieldRow } from '../components/ui'
import type { AppInfo } from '../desktop'

const LINKS = [
  { key: 'projectHome', url: 'https://github.com/andyzhang201310-coder/AnTun' },
  { key: 'reference', url: 'https://github.com/hezhanleiok/xehn' },
  { key: 'coreSource', url: 'https://github.com/MetaCubeX/mihomo' },
]

export function AboutPage() {
  const store = useStore()
  const { settings: s, platform } = store
  const t = (k: string) => tr(k, s.lang)
  const [info, setInfo] = useState<AppInfo | null>(null)

  useEffect(() => {
    const desk = (window as any).AnTunDesktop
    desk?.appInfo?.().then((v: AppInfo) => setInfo(v)).catch(() => {})
  }, [])

  const paths = info ? [
    [t('aboutExePath'), info.exePath],
    [t('aboutResourceDir'), info.resourceDir],
    [t('aboutDataDir'), info.dataDir],
  ] : [
    [t('aboutExePath'), platform === 'web' ? 'Browser / WebView' : 'Current app directory'],
    [t('aboutResourceDir'), platform === 'web' ? location.href : './resources'],
    [t('aboutDataDir'), 'localStorage: antun-prefs'],
  ]

  return (
    <div className="page-wrap fade-in stack">
      <Card title={<><Info size={16} />{t('aboutTitle')}</>}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 16 }}>
          <div style={{
            width: 56, height: 56, borderRadius: 16, display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'linear-gradient(135deg, var(--brand), var(--brand-2))', color: '#fff',
            boxShadow: '0 8px 24px rgba(91,110,245,.35)',
          }}><ShieldCheck size={28} /></div>
          <div>
            <div style={{ fontSize: 22, fontWeight: 800 }}>AnTun</div>
            <div className="muted" style={{ fontSize: 12 }}>{t('appTagline')}</div>
          </div>
        </div>
        <FieldRow title={t('version')} control={<span className="badge badge-blue">{info?.version || '1.2.0'}</span>} />
        <FieldRow title={t('diagPlatform')} control={<span className="strong mono">{platform.toUpperCase()}</span>} />
        <FieldRow title={t('license')} control={<span className="strong">{t('licenseDetail')}</span>} />
        <FieldRow title={t('controlCode')} control={
          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="mono strong">{s.controlCode}</span>
            <button className="btn btn-ghost btn-sm" onClick={() => navigator.clipboard?.writeText(s.controlCode)}><Copy size={13} /></button>
          </span>
        } />
      </Card>

      <Card title={<><FolderOpen size={16} />{t('about')}</>}>
        {paths.map(([label, value]) => (
          <FieldRow key={label} title={label} control={
            <span className="mono muted" style={{ fontSize: 11, maxWidth: 380, overflowWrap: 'anywhere' }} title={value}>{value || '—'}</span>
          } />
        ))}
      </Card>

      <Card title={<><ExternalLink size={16} />{t('aboutLinks')}</>}>
        {LINKS.map((l) => (
          <a key={l.key} href={l.url} target="_blank" rel="noreferrer" className="field-row" style={{ display: 'flex' }}>
            <div className="field-label"><div className="t">{t(l.key)}</div><div className="d mono">{l.url}</div></div>
            <ExternalLink size={15} className="muted" />
          </a>
        ))}
      </Card>

      <div className="muted" style={{ textAlign: 'center', fontSize: 11, padding: 12, lineHeight: 1.7 }}>
        {t('notice')}<br />{t('openSource')} · AnTun {new Date().getFullYear()}
      </div>
    </div>
  )
}
