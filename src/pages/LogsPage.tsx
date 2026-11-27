import { ScrollText, Copy, Trash2, FileText } from 'lucide-react'
import { useStore } from '../store'
import { tr } from '../i18n'
import { Card } from '../components/ui'
import { renderDiagnostics } from '../engine/configRenderer'

const LEVEL_COLOR: Record<string, string> = {
  INFO: 'var(--info)', WARN: 'var(--warn)', ERROR: 'var(--danger)', DEBUG: 'var(--text-3)',
}

export function LogsPage() {
  const store = useStore()
  const { settings: s, logs, history, conn, platform } = store
  const t = (k: string) => tr(k, s.lang)
  // 分栏存进设置：日志页同样是条件渲染，放组件内 state 一切页就被重置回「运行日志」
  const tab = s.logsTab
  const setTab = (v: 'runtime' | 'history' | 'diag') => store.setSetting('logsTab', v)

  const diagnostics = renderDiagnostics(s, platform, { connected: conn.connected, exitIp: conn.exitIp, protocol: conn.protocol })
  const copy = (text: string) => {
    navigator.clipboard?.writeText(text).then(() => store.log('INFO', t('copied'))).catch(() => {})
  }

  return (
    <div className="page-wrap fade-in stack">
      <Card>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <div className="segment">
            {([
              { v: 'runtime', k: 'tabRuntime' },
              { v: 'history', k: 'tabHistory' },
              { v: 'diag', k: 'tabDiagnostics' },
            ] as const).map((x) => (
              <button key={x.v} className={tab === x.v ? 'active' : ''} onClick={() => setTab(x.v)}>{t(x.k)}</button>
            ))}
          </div>
          <div style={{ flex: 1 }} />
          <button className="btn btn-ghost btn-sm" onClick={() => copy(tab === 'diag' ? diagnostics : tab === 'runtime' ? logs.map((l) => l.message).join('\n') : history.map((h) => h.text).join('\n'))}>
            <Copy size={14} />{t('copy')}
          </button>
          <button className="btn btn-danger btn-sm" onClick={() => store.clearLogs()}><Trash2 size={14} />{t('clear')}</button>
        </div>
      </Card>

      <Card title={<><ScrollText size={16} />{t(tab === 'runtime' ? 'tabRuntime' : tab === 'history' ? 'tabHistory' : 'tabDiagnostics')}</>}
        sub={`${tab === 'runtime' ? logs.length : tab === 'history' ? history.length : ''}`}>
        {tab === 'runtime' && (
          <div style={{ maxHeight: 520, overflowY: 'auto' }}>
            {logs.length ? logs.map((l) => (
              <div key={l.id} className="log-line">
                <span className="log-time">{new Date(l.time).toLocaleTimeString(s.lang === 'zh' ? 'zh-CN' : 'en-US', { hour12: false })}</span>
                <span className="log-tag" style={{ color: LEVEL_COLOR[l.level] }}>{l.level}</span>
                <span>{l.message}</span>
              </div>
            )) : <div className="muted" style={{ padding: 30, textAlign: 'center', fontSize: 12 }}>{t('noLogs')}</div>}
          </div>
        )}
        {tab === 'history' && (
          <div style={{ maxHeight: 520, overflowY: 'auto' }}>
            {history.length ? history.map((h) => (
              <div key={h.id} className="log-line">
                <span className="log-time">{new Date(h.time).toLocaleTimeString(s.lang === 'zh' ? 'zh-CN' : 'en-US', { hour12: false })}</span>
                <span className="log-tag" style={{ color: h.ok ? 'var(--success)' : 'var(--danger)' }}>{h.ok ? '✓' : '✕'}</span>
                <span>{h.text}</span>
              </div>
            )) : <div className="muted" style={{ padding: 30, textAlign: 'center', fontSize: 12 }}>{t('noHistory')}</div>}
          </div>
        )}
        {tab === 'diag' && (
          <div>
            <pre className="mono" style={{
              background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 12,
              padding: 16, fontSize: 12, lineHeight: 1.7, whiteSpace: 'pre-wrap', overflowX: 'auto', margin: 0,
            }}>{diagnostics}</pre>
            <button className="btn btn-outline btn-sm" style={{ marginTop: 12 }} onClick={() => copy(diagnostics)}>
              <FileText size={14} />{t('copyDiagnostics')}
            </button>
          </div>
        )}
      </Card>
    </div>
  )
}
