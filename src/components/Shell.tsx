import { Home, Layers, Server, ShieldCheck, Settings, ScrollText, Info, Power, Wifi, WifiOff, Monitor, Smartphone, Tv, Globe } from 'lucide-react'
import type { ReactNode } from 'react'
import type { PageId, Platform } from '../types'
import { useStore } from '../store'
import { tr } from '../i18n'

const NAV: { id: PageId; key: string; icon: typeof Home }[] = [
  { id: 'home', key: 'navHome', icon: Home },
  { id: 'modes', key: 'navModes', icon: Layers },
  { id: 'nodes', key: 'navNodes', icon: Server },
  { id: 'rules', key: 'navRules', icon: ShieldCheck },
  { id: 'settings', key: 'navSettings', icon: Settings },
  { id: 'logs', key: 'navLogs', icon: ScrollText },
  { id: 'about', key: 'navAbout', icon: Info },
]

function PlatformIcon({ p }: { p: Platform }) {
  if (p === 'android') return <Smartphone size={14} />
  if (p === 'tv') return <Tv size={14} />
  if (p === 'windows') return <Monitor size={14} />
  return <Globe size={14} />
}

export function Sidebar() {
  const { page, setPage, settings, conn, platform } = useStore()
  const t = (k: string) => tr(k, settings.lang)

  return (
    <>
      {/* 桌面侧栏 */}
      <aside className="desktop-sidebar" style={{
        width: 'var(--sidebar-w)', flex: 'none', display: 'flex', flexDirection: 'column',
        background: 'var(--surface)', borderRight: '1px solid var(--border)', padding: '22px 14px',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '0 10px 22px' }}>
          <div style={{
            width: 38, height: 38, borderRadius: 12, display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'linear-gradient(135deg, var(--brand), var(--brand-2))', color: '#fff',
            boxShadow: '0 6px 16px rgba(91,110,245,.35)',
          }}><Power size={20} strokeWidth={2.4} /></div>
          <div>
            <div style={{ fontSize: 19, fontWeight: 800, letterSpacing: '-.5px' }}>{t('appName')}</div>
            <div className="muted" style={{ fontSize: 10, marginTop: 1 }}>{t('appTagline')}</div>
          </div>
        </div>

        <nav style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1 }}>
          {NAV.map((n) => {
            const Icon = n.icon
            const active = page === n.id
            return (
              <button
                key={n.id}
                className="nav-item"
                onClick={() => setPage(n.id)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', borderRadius: 12,
                  fontSize: 14, fontWeight: 650, textAlign: 'left', transition: 'all .2s',
                  background: active ? 'var(--brand-soft)' : 'transparent',
                  color: active ? 'var(--brand)' : 'var(--text-2)',
                  boxShadow: active ? 'inset 3px 0 var(--brand)' : 'none',
                }}
              >
                <Icon size={19} strokeWidth={active ? 2.4 : 2} />
                {t(n.key)}
              </button>
            )
          })}
        </nav>

        <div style={{
          borderTop: '1px solid var(--border)', paddingTop: 14, marginTop: 8,
          display: 'flex', flexDirection: 'column', gap: 10,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 8px', fontSize: 11.5 }} className="muted">
            <PlatformIcon p={platform} />
            <span>{t('platform')}: {platform.toUpperCase()}</span>
          </div>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 9, padding: '10px 12px', borderRadius: 12,
            background: conn.connected ? 'var(--success-soft)' : 'var(--surface-2)',
            color: conn.connected ? 'var(--success)' : 'var(--text-3)', fontSize: 12, fontWeight: 700,
          }}>
            {conn.connected ? <Wifi size={15} /> : <WifiOff size={15} />}
            {t(conn.connected ? 'connected' : 'disconnected')}
            {conn.connected && <span className="dot" style={{ marginLeft: 'auto', animation: 'pulse 1.5s infinite' }} />}
          </div>
          <div className="muted" style={{ fontSize: 10, lineHeight: 1.45, padding: '2px 8px', display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }} title={t('notice')}>{t('notice')}</div>
        </div>
      </aside>

      {/* 手机底部导航 */}
      <nav className="mobile-nav" style={{
        display: 'none', position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 50,
        background: 'var(--surface)', borderTop: '1px solid var(--border)',
        padding: '8px 6px calc(8px + env(safe-area-inset-bottom))', justifyContent: 'space-around',
      }}>
        {NAV.map((n) => {
          const Icon = n.icon
          const active = page === n.id
          return (
            <button key={n.id} onClick={() => setPage(n.id)} style={{
              display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3,
              fontSize: 10.5, fontWeight: 650, color: active ? 'var(--brand)' : 'var(--text-3)', minWidth: 52,
            }}>
              <Icon size={21} strokeWidth={active ? 2.5 : 2} />
              {t(n.key)}
            </button>
          )
        })}
      </nav>
    </>
  )
}

export function TopBar({ children, title, sub }: {
  children?: ReactNode; title: string; sub?: string
}) {
  const { settings, conn } = useStore()
  const t = (k: string) => tr(k, settings.lang)
  return (
    <header style={{
      display: 'flex', alignItems: 'center', gap: 16, padding: '18px 28px 14px',
      borderBottom: '1px solid var(--border)', background: 'var(--bg)',
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <h1 className="section-title">{title}</h1>
        {sub && <p className="section-sub">{sub}</p>}
      </div>
      <span className={`badge ${conn.connected ? 'badge-green' : 'badge-gray'}`}>
        <span className="dot" />{t(conn.connected ? 'connected' : conn.connecting ? 'connecting' : 'direct')}
      </span>
      <div className="topbar-controls">{children}</div>
    </header>
  )
}
