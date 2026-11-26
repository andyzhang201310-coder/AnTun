import { ShieldCheck, ExternalLink } from 'lucide-react'
import { useStore } from '../store'
import { tr } from '../i18n'
import { Card } from '../components/ui'

const LINKS = [
  { key: 'projectHome', url: 'https://github.com/andyzhang201310-coder/AnTun' },
]

export function AboutPage() {
  const store = useStore()
  const t = (k: string) => tr(k, store.settings.lang)

  return (
    <div className="page-wrap fade-in stack">
      <Card title={<><ShieldCheck size={16} />{t('aboutTitle')}</>}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
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
