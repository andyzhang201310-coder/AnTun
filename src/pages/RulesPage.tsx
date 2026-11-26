import { useState } from 'react'
import { ShieldCheck, Plus, Trash2 } from 'lucide-react'
import { useStore } from '../store'
import { tr } from '../i18n'
import { Card, Segment, Toggle } from '../components/ui'
import type { Rule } from '../types'

const TYPES: Rule['type'][] = ['DOMAIN-SUFFIX', 'DOMAIN-KEYWORD', 'IP-CIDR', 'PROCESS-NAME', 'GEOSITE', 'MATCH']
const POLICIES: Rule['policy'][] = ['DIRECT', 'WARP', 'REJECT']

export function RulesPage() {
  const store = useStore()
  const { settings, rules } = store
  const t = (k: string) => tr(k, settings.lang)
  const [type, setType] = useState<Rule['type']>('DOMAIN-SUFFIX')
  const [value, setValue] = useState('')
  const [policy, setPolicy] = useState<Rule['policy']>('WARP')

  const custom = rules.filter((r) => !r.builtin)

  return (
    <div className="page-wrap fade-in stack">
      <Card title={<><ShieldCheck size={16} />{t('proxyMode')}</>}>
        <Segment
          value={settings.proxyMode}
          onChange={(v) => store.setSetting('proxyMode', v)}
          options={[
            { value: 'custom', label: t('proxyModeCustom') },
            { value: 'bypass-mainland', label: t('proxyModeBypass') },
            { value: 'global', label: t('proxyModeGlobal') },
          ]}
        />
      </Card>

      {settings.proxyMode === 'custom' && (
        <>
          <Card title={<><Plus size={16} />{t('addRule')}</>}>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
              <select className="select" value={type} onChange={(e) => setType(e.target.value as Rule['type'])}>
                {TYPES.map((x) => <option key={x} value={x}>{x}</option>)}
              </select>
              <input className="input" value={value} onChange={(e) => setValue(e.target.value)}
                placeholder={t('ruleValue')} style={{ flex: 1, minWidth: 160 }} />
              <select className="select" value={policy} onChange={(e) => setPolicy(e.target.value as Rule['policy'])}>
                {POLICIES.map((x) => <option key={x} value={x}>{x}</option>)}
              </select>
              <button className="btn btn-primary" disabled={!value.trim() && type !== 'MATCH'}
                onClick={() => {
                  store.addRule({ type, value: value.trim(), policy, enabled: true })
                  setValue('')
                  store.log('INFO', `rule added: ${type},${value},${policy}`)
                }}>
                <Plus size={15} />{t('addRule')}
              </button>
            </div>
          </Card>

          <Card title={t('ruleList')} sub={`${rules.length} rules`}>
            <div className="stack" style={{ gap: 0 }}>
              {rules.map((r) => (
                <div key={r.id} className="field-row" style={{ opacity: r.enabled ? 1 : .5 }}>
                  <Toggle checked={r.enabled} onChange={() => store.toggleRule(r.id)} disabled={r.builtin && r.type === 'MATCH'} />
                  <div className="field-label">
                    <div className="t mono" style={{ fontSize: 12.5 }}>
                      <span className="badge badge-gray" style={{ marginRight: 8, fontSize: 10 }}>{r.type}</span>
                      {r.value || '—'}
                      {r.builtin && <span className="badge badge-blue" style={{ marginLeft: 8, fontSize: 10 }}>{t('builtin')}</span>}
                    </div>
                  </div>
                  <span className={`badge ${r.policy === 'WARP' ? 'badge-blue' : r.policy === 'DIRECT' ? 'badge-green' : 'badge-red'}`}>{r.policy}</span>
                  {!r.builtin && <button className="btn btn-danger btn-sm" onClick={() => store.removeRule(r.id)}><Trash2 size={13} /></button>}
                </div>
              ))}
              {!custom.length && <div className="muted" style={{ fontSize: 12, padding: '14px 0' }}>{t('noRules')}</div>}
            </div>
          </Card>

          <Card title={t('domainDirect')}>
            <textarea className="input" rows={4} value={settings.domainDirect}
              onChange={(e) => store.setSetting('domainDirect', e.target.value)}
              placeholder={'example.com\n*.local'} style={{ width: '100%', resize: 'vertical' }} />
          </Card>
          <Card title={t('domainProxy')}>
            <textarea className="input" rows={4} value={settings.domainProxy}
              onChange={(e) => store.setSetting('domainProxy', e.target.value)}
              placeholder={'google.com\nyoutube.com'} style={{ width: '100%', resize: 'vertical' }} />
          </Card>
        </>
      )}
    </div>
  )
}
