import { useEffect } from 'react'
import { Search, RefreshCw, Star, Lock, Unlock, Zap } from 'lucide-react'
import { useStore } from '../store'
import { useEngine } from '../engine/useEngine'
import { tr } from '../i18n'
import { Card, PROTOCOL_LABELS } from '../components/ui'
import type { Protocol } from '../types'

export function NodesPage() {
  const store = useStore()
  const { settings, endpoints, scanning, pinnedId } = store
  const { scan } = useEngine()
  const t = (k: string, v?: Record<string, string | number>) => tr(k, settings.lang, v)
  // 搜索词与协议过滤都不能放组件内 state：页面是条件渲染的（App.tsx），切走即卸载、回来就重置
  const query = store.nodeQuery
  const protoFilter = settings.nodeProtoFilter
  const setQuery = store.setNodeQuery
  const setProtoFilter = (p: Protocol | 'all') => store.setSetting('nodeProtoFilter', p)

  useEffect(() => { if (!endpoints.length && !scanning) scan() }, [])

  const list = endpoints.filter((e) => {
    const matchQ = !query || `${e.host} ${e.protocol}`.toLowerCase().includes(query.toLowerCase())
    const matchP = protoFilter === 'all' || e.protocol === protoFilter
    return matchQ && matchP
  })

  return (
    <div className="page-wrap fade-in stack">
      <Card>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8, background: 'var(--surface-2)',
            border: '1px solid var(--border)', borderRadius: 10, padding: '0 12px', flex: 1, minWidth: 180,
          }}>
            <Search size={16} className="muted" />
            <input
              value={query} onChange={(e) => setQuery(e.target.value)}
              placeholder={`${t('nodeHost')} / ${t('nodeProto')}`}
              style={{ background: 'none', border: 'none', outline: 'none', padding: '10px 0', flex: 1, fontSize: 13, color: 'var(--text)' }}
            />
          </div>
          <div className="segment">
            {(['all', 'wg', 'awg', 'gool', 'masque', 'masque-h2', 'masque-mm'] as const).map((p) => (
              <button key={p} className={protoFilter === p ? 'active' : ''} onClick={() => setProtoFilter(p)}>
                {p === 'all' ? t('all') : PROTOCOL_LABELS[p]}
              </button>
            ))}
          </div>
          <button className="btn btn-primary" onClick={scan} disabled={scanning}>
            <RefreshCw size={15} className={scanning ? 'spin' : ''} />{t(scanning ? 'scanning' : 'scanBest')}
          </button>
        </div>
      </Card>

      <Card title={<><Zap size={16} />{t('cacheEndpoints')}</>} sub={`${t('totalNodes', { n: list.length })} · ${t('probeHint')}`}>
        <div className="table-head">
          <span>{t('nodeHost')}</span><span>{t('nodeProto')}</span>
          <span className="hide-sm">{t('endpointState')}</span><span>{t('nodePing')}</span><span>{t('nodeAction')}</span>
        </div>
        {list.length ? list.map((e) => (
          <div key={e.id} className={`node-row ${pinnedId === e.id ? 'selected' : ''}`}
            onClick={() => store.pinEndpoint(pinnedId === e.id ? null : e.id)} tabIndex={0}
            onKeyDown={(ev) => { if (ev.key === 'Enter') store.pinEndpoint(pinnedId === e.id ? null : e.id) }}>
            <span className="cell mono strong">{e.host}:{e.port}</span>
            <span className="cell">{e.protocol.toUpperCase()}</span>
            <span className="cell hide-sm" style={{ color: e.loss > 0 ? 'var(--danger)' : e.latency > 0 ? 'var(--success)' : 'var(--text-3)' }}>
              {e.loss > 0 ? t('probeFailed') : e.latency > 0 ? t('probeOk') : t('probeUntested')}
            </span>
            <span className="cell" style={{ color: e.latency > 0 ? (e.latency < 250 ? 'var(--success)' : e.latency < 600 ? 'var(--warn)' : 'var(--danger)') : 'var(--text-3)', fontWeight: 700 }}>
              {e.latency > 0 ? `${e.latency}ms` : '—'}
            </span>
            <span className="cell">
              {pinnedId === e.id ? <Unlock size={16} color="var(--brand)" /> : <Lock size={16} className="muted" />}
            </span>
          </div>
        )) : (
          <div className="muted" style={{ padding: 36, textAlign: 'center', fontSize: 13 }}>
            {scanning ? t('scanning') : t('noData')}
          </div>
        )}
        {pinnedId && <div style={{ marginTop: 12, padding: '10px 14px', background: 'var(--brand-soft)', borderRadius: 10, fontSize: 12, display: 'flex', alignItems: 'center', gap: 8, color: 'var(--brand)', fontWeight: 600 }}>
          <Star size={14} fill="var(--brand)" />{t('pinned')}: {endpoints.find((e) => e.id === pinnedId)?.host || '—'} · {t('clickToPin')}
        </div>}
      </Card>
    </div>
  )
}
