import { useEffect, useState } from 'react'
import { Sidebar, TopBar } from './components/Shell'
import { ThemeLangControls } from './components/ui'
import { BrandMark } from './components/BrandMark'
import { HomePage } from './pages/HomePage'
import { ModesPage } from './pages/ModesPage'
import { NodesPage } from './pages/NodesPage'
import { RulesPage } from './pages/RulesPage'
import { SettingsPage } from './pages/SettingsPage'
import { LogsPage } from './pages/LogsPage'
import { AboutPage } from './pages/AboutPage'
import { useStore, applyAppearance } from './store'
import { tr } from './i18n'
import type { PageId } from './types'

const PAGE_META: Record<PageId, { key: string; sub: string }> = {
  home: { key: 'homeTitle', sub: 'homeSub' },
  modes: { key: 'modesTitle', sub: 'modesSub' },
  nodes: { key: 'nodesTitle', sub: 'nodesSub' },
  rules: { key: 'rulesTitle', sub: 'rulesSub' },
  settings: { key: 'settingsTitle', sub: 'settingsSub' },
  logs: { key: 'logsTitle', sub: 'logsSub' },
  about: { key: 'aboutTitle', sub: 'openSource' },
}

function useAppearance() {
  const { settings } = useStore()
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => applyAppearance(settings.theme, settings.lang, mq.matches)
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [settings.theme, settings.lang])
}

export default function App() {
  useAppearance()
  const store = useStore()
  const { settings, page, setSetting } = store
  const t = (k: string) => tr(k, settings.lang)
  const [showNotice, setShowNotice] = useState(() => !localStorage.getItem('antun-notice-seen'))

  const dismissNotice = () => {
    localStorage.setItem('antun-notice-seen', '1')
    setShowNotice(false)
  }

  return (
    <div className="app-shell">
      <Sidebar />
      <div className="main-area">
        <TopBar title={t(PAGE_META[page].key)} sub={t(PAGE_META[page].sub)}>
          <ThemeLangControls
            theme={settings.theme} lang={settings.lang}
            onTheme={(v) => setSetting('theme', v)} onLang={(v) => setSetting('lang', v)} t={t}
          />
        </TopBar>
        <div className="content-scroll">
          {page === 'home' && <HomePage />}
          {page === 'modes' && <ModesPage />}
          {page === 'nodes' && <NodesPage />}
          {page === 'rules' && <RulesPage />}
          {page === 'settings' && <SettingsPage />}
          {page === 'logs' && <LogsPage />}
          {page === 'about' && <AboutPage />}
        </div>
      </div>

      {/* 首次启动许可提示（复刻原版启动须知） */}
      {showNotice && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 100, background: 'rgba(15,20,40,.45)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, backdropFilter: 'blur(4px)',
        }}>
          <div className="card fade-in" style={{ maxWidth: 420, width: '100%', textAlign: 'center', padding: 30 }}>
            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 12 }}>
              <BrandMark size={58} />
            </div>
            <h2 style={{ margin: '0 0 6px', fontSize: 20 }}>AnTun</h2>
            <div className="muted" style={{ fontSize: 12, marginBottom: 18 }}>{t('appTagline')}</div>
            <p style={{ fontSize: 13, lineHeight: 1.7, color: 'var(--text-2)', background: 'var(--surface-2)', padding: 14, borderRadius: 12 }}>
              {t('notice')}
            </p>
            <button className="btn btn-primary btn-block" style={{ marginTop: 18 }} onClick={dismissNotice}>{t('confirm')}</button>
          </div>
        </div>
      )}
    </div>
  )
}
