import { useEffect, useMemo, useRef, useState } from 'react'
import { Layers, Link2, RefreshCw, Trash2, Check, AlertCircle, ArrowRight, Zap, Timer, Square, Gauge } from 'lucide-react'
import { useStore, newId } from '../store'
import { tr } from '../i18n'
import { Card, Segment, Toggle, FieldRow, formatRate } from '../components/ui'
import type { Subscription, SubNode, NodeStat } from '../types'

export function ModesPage() {
  const store = useStore()
  const { settings: s, subscriptions, subNodes, nodeStats } = store
  const t = (k: string, v?: Record<string, string | number>) => tr(k, s.lang, v)
  const [source, setSource] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [testing, setTesting] = useState(false)
  const [progress, setProgress] = useState({ done: 0, total: 0 })
  const [testMsg, setTestMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [sortKey, setSortKey] = useState<'default' | 'delay' | 'speed'>('default')
  const abortRef = useRef(false)

  const desk = (window as any).AnTunDesktop

  const importSource = async () => {
    const text = source.trim()
    if (!text || busy) return
    setBusy(true)
    setMsg(null)
    try {
      if (!desk?.isDesktop) throw new Error(t('desktopOnly'))
      const isUrl = /^https?:\/\//i.test(text)
      const nodes = isUrl ? await desk.subscriptionFetch(text) : await desk.subscriptionParse(text)
      if (!nodes?.length) throw new Error(t('subscriptionEmpty'))
      const id = newId()
      const name = isUrl ? new URL(text).hostname : t('pastedSource')
      const sub: Subscription = { id, name, url: text, updatedAt: Date.now() }
      const scoped = nodes.map((n: any) => ({ ...n, subId: id }))
      store.addSubscription(sub)
      store.setSubNodes([...store.subNodes.filter((n) => n.subId !== id && n.subId !== text), ...scoped])
      store.setSetting('connMode', 'subscription')
      if (!store.settings.frontNodeId) store.setSetting('frontNodeId', scoped[0].id)
      store.log('INFO', `subscription imported: ${name} (${scoped.length} nodes)`)
      store.addHistory(`subscription ${name}: ${scoped.length} nodes`)
      setMsg({ ok: true, text: t('subscriptionImported', { n: scoped.length }) })
      setSource('')
    } catch (e: any) {
      setMsg({ ok: false, text: `${t('subscriptionFailed')}: ${e.message}` })
      store.log('ERROR', `subscription import failed: ${e.message}`)
    } finally {
      setBusy(false)
    }
  }

  const refresh = async (sub: Subscription) => {
    setBusy(true)
    setMsg(null)
    try {
      if (!desk?.isDesktop) throw new Error(t('desktopOnly'))
      const nodes = await desk.subscriptionFetch(sub.url)
      if (!nodes?.length) throw new Error(t('subscriptionEmpty'))
      const scoped = nodes.map((n: any) => ({ ...n, subId: sub.id }))
      store.setSubNodes([...store.subNodes.filter((n) => n.subId !== sub.id), ...scoped])
      store.addSubscription({ ...sub, updatedAt: Date.now() })
      setMsg({ ok: true, text: t('subscriptionImported', { n: scoped.length }) })
    } catch (e: any) {
      setMsg({ ok: false, text: `${t('subscriptionFailed')}: ${e.message}` })
    } finally {
      setBusy(false)
    }
  }

  // 离开页面时确保测速核心被杀掉，避免孤儿进程
  useEffect(() => () => { void desk?.nodeTestStop?.().catch(() => {}) }, [desk])

  const stopTest = () => {
    abortRef.current = true
    void desk?.nodeTestStop?.().catch(() => {})
  }

  /** 一键测速：先并发测延迟，再按批并发测下载速度（每批 3 个，避免互相抢带宽） */
  const runTest = async (withSpeed: boolean) => {
    if (!desk?.isDesktop) {
      setTestMsg({ ok: false, text: t('desktopOnly') })
      return
    }
    if (testing) return
    if (!subNodes.length) {
      setTestMsg({ ok: false, text: t('nodeTestEmpty') })
      return
    }
    abortRef.current = false
    setTesting(true)
    setTestMsg(null)
    setProgress({ done: 0, total: subNodes.length })
    try {
      const start = await desk.nodeTestStart(subNodes)
      if (start?.skipped?.length) {
        store.mergeNodeStats(start.skipped.map((id: string) => ({ id, delay: -1, speed: 0, bytes: 0, error: t('nodeCfgRejected') })))
      }
      const delays: NodeStat[] = await desk.nodeTestDelay()
      store.mergeNodeStats(delays || [])
      setProgress({ done: (delays || []).length, total: subNodes.length })
      const reachable = (delays || []).filter((d) => d.delay > 0)
      store.log('INFO', `node test delay: ${reachable.length}/${(delays || []).length} reachable`)
      if (withSpeed && !abortRef.current) {
        const list = (reachable.length ? reachable : delays || []).map((d) => d.id)
        const batch = 3
        for (let i = 0; i < list.length; i += batch) {
          if (abortRef.current) break
          const part = list.slice(i, i + batch)
          const res: NodeStat[] = await desk.nodeTestSpeed(part, 6, part.length)
          store.mergeNodeStats(res || [])
          setProgress({ done: Math.min((delays || []).length + i + part.length, subNodes.length), total: subNodes.length })
        }
      }
      if (abortRef.current) {
        setTestMsg({ ok: true, text: t('testStop') })
      } else {
        setTestMsg({ ok: true, text: t('nodeTestDone') })
        store.addHistory(`node test: ${reachable.length}/${subNodes.length} reachable`)
      }
    } catch (e: any) {
      const text = e?.message || String(e)
      setTestMsg({ ok: false, text: `${t('nodeTestFailed')}: ${text}` })
      store.log('ERROR', `node test failed: ${text}`)
    } finally {
      try { await desk?.nodeTestStop?.() } catch { /* ignore */ }
      setTesting(false)
      setProgress({ done: 0, total: 0 })
    }
  }

  const nodeList = useMemo<SubNode[]>(() => {
    if (sortKey === 'default') return subNodes
    const weight = (n: SubNode) => {
      const st = nodeStats[n.id]
      if (sortKey === 'delay') return st && st.delay > 0 ? st.delay : Number.MAX_SAFE_INTEGER
      return st && st.speed > 0 ? -st.speed : Number.MAX_SAFE_INTEGER
    }
    return [...subNodes].sort((a, b) => weight(a) - weight(b))
  }, [subNodes, nodeStats, sortKey])

  // 协议缩写：完整名（wireguard）在窄列里会被截断
  const shortType = (t2: string) => {
    const map: Record<string, string> = {
      wireguard: 'WG', ss: 'SS', shadowsocks: 'SS', vmess: 'VMess', vless: 'VLESS', trojan: 'Trojan', socks5: 'SOCKS5', http: 'HTTP',
    }
    return map[t2.toLowerCase()] || t2.toUpperCase()
  }

  const delayClass = (v: number) => (v > 0 ? (v < 300 ? 'stat-good' : v < 800 ? 'stat-mid' : 'stat-bad') : 'stat-idle')
  const speedClass = (v: number) => (v > 0 ? (v > 5 * 1024 * 1024 ? 'stat-good' : v > 1024 * 1024 ? 'stat-mid' : 'stat-bad') : 'stat-idle')

  const countFor = (id: string) => subNodes.filter((n) => n.subId === id).length

  return (
    <div className="page-wrap fade-in stack">
      <Card title={<><Layers size={16} />{t('connMode')}</>}>
        <Segment
          value={s.connMode}
          onChange={(v) => store.setSetting('connMode', v)}
          options={[
            { value: 'warp', label: t('modeWarp') },
            { value: 'subscription', label: t('modeSubscription') },
          ]}
        />
        <div className="muted" style={{ fontSize: 12, marginTop: 12, lineHeight: 1.7 }}>
          {s.connMode === 'warp' ? t('modeWarpDesc') : t('modeSubscriptionDesc')}
        </div>
      </Card>

      {s.connMode === 'subscription' && (
        <>
          <Card title={<><Link2 size={16} />{t('subscriptionImport')}</>} sub={t('subscriptionHint')}>
            <textarea
              className="input"
              value={source}
              onChange={(e) => setSource(e.target.value)}
              placeholder={t('subscriptionPlaceholder')}
              rows={3}
              style={{ width: '100%', fontFamily: 'monospace', fontSize: 11, resize: 'vertical' }}
            />
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 10 }}>
              <button className="btn btn-primary" onClick={importSource} disabled={!source.trim() || busy}>
                <Link2 size={14} />{busy ? t('scanning') : t('subscriptionImport')}
              </button>
              {msg && (
                <span style={{ fontSize: 12, color: msg.ok ? 'var(--success)' : 'var(--danger)', display: 'flex', alignItems: 'center', gap: 6 }}>
                  {msg.ok ? <Check size={13} /> : <AlertCircle size={13} />}{msg.text}
                </span>
              )}
            </div>
          </Card>

          <Card
            title={<><ArrowRight size={16} />{t('subExitTitle')}</>}
            sub={s.subExit === 'node' ? t('subExitDescNode') : t('subExitDescWarp')}
          >
            <Segment
              value={s.subExit}
              onChange={(v) => store.setSetting('subExit', v)}
              options={[
                { value: 'node', label: t('subExitNode') },
                { value: 'warp', label: t('subExitWarp') },
              ]}
            />
            {s.subExit === 'node' && (
              <FieldRow title={t('subViaWarp')} desc={t('subViaWarpDesc')} control={
                <Toggle checked={s.subViaWarp} onChange={(v) => store.setSetting('subViaWarp', v)} />
              } />
            )}
            <div className="muted" style={{ fontSize: 11.5, marginTop: 10 }}>{t('subExitApply')}</div>
          </Card>

          <Card title={<><RefreshCw size={16} />{t('subscriptionList')}</>} sub={t('totalNodes', { n: subNodes.length })}>
            {subscriptions.length ? subscriptions.map((sub) => (
              <div key={sub.id} className="node-row" style={{ cursor: 'default' }}>
                <span className="cell mono strong" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{sub.name}</span>
                <span className="cell muted" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{sub.url}</span>
                <span className="cell">{countFor(sub.id)} {t('nodes')}</span>
                <span className="cell" style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                  <button className="btn btn-ghost btn-sm" onClick={() => refresh(sub)} disabled={busy} title={t('refreshSub')}>
                    <RefreshCw size={14} className={busy ? 'spin' : ''} />
                  </button>
                  <button className="btn btn-ghost btn-sm" onClick={() => store.removeSubscription(sub.id)} title={t('deleteSub')}>
                    <Trash2 size={14} />
                  </button>
                </span>
              </div>
            )) : (
              <div className="muted" style={{ padding: 24, textAlign: 'center', fontSize: 12 }}>{t('noSubscription')}</div>
            )}
          </Card>

          <Card
            title={<><Gauge size={16} />{t('subscriptionNodes')}</>}
            sub={testing ? `${t('testing')} ${progress.done}/${progress.total}` : t('selectFrontNode')}
          >
            <div className="node-toolbar">
              <button className="btn btn-primary btn-sm" onClick={() => runTest(true)} disabled={testing || !subNodes.length}>
                <Zap size={14} />{testing ? `${t('testing')} ${progress.done}/${progress.total}` : t('testAll')}
              </button>
              <button className="btn btn-ghost btn-sm" onClick={() => runTest(false)} disabled={testing || !subNodes.length}>
                <Timer size={14} />{t('testDelayOnly')}
              </button>
              {testing && (
                <button className="btn btn-ghost btn-sm" onClick={stopTest}>
                  <Square size={12} />{t('testStop')}
                </button>
              )}
              <span className="muted node-hint">{t('nodeTestHint')}</span>
              <select
                className="select"
                value={sortKey}
                onChange={(e) => setSortKey(e.target.value as 'default' | 'delay' | 'speed')}
                title={t('sortBy')}
                style={{ width: 132, flex: 'none' }}
              >
                <option value="default">{t('sortDefault')}</option>
                <option value="delay">{t('sortDelay')}</option>
                <option value="speed">{t('sortSpeed')}</option>
              </select>
            </div>
            {testing && progress.total > 0 && (
              <div className="test-progress"><i style={{ width: `${Math.round((progress.done / progress.total) * 100)}%` }} /></div>
            )}
            {testMsg && (
              <div className="test-msg" style={{ color: testMsg.ok ? 'var(--success)' : 'var(--danger)' }}>
                {testMsg.ok ? <Check size={13} /> : <AlertCircle size={13} />}{testMsg.text}
              </div>
            )}
            <div className="table-head t">
              <span>{t('nodes')}</span>
              <span className="hide-sm">{t('nodeType')}</span>
              <span className="hide-sm">{t('nodeAddress')}</span>
              <span>{t('nodeDelay')}</span>
              <span>{t('nodeSpeed')}</span>
              <span style={{ textAlign: 'right' }}>{t('nodeAction')}</span>
            </div>
            {nodeList.length ? nodeList.map((node) => {
              const selected = s.frontNodeId === node.id
              const st = nodeStats[node.id]
              const delay = st?.delay ?? -1
              const speed = st?.speed ?? 0
              const failed = !!(st?.error && delay <= 0 && speed <= 0)
              return (
                <div key={node.id} className={`node-row t ${selected ? 'selected' : ''}`}
                  onClick={() => store.setSetting('frontNodeId', node.id)} tabIndex={0}
                  onKeyDown={(e) => { if (e.key === 'Enter') store.setSetting('frontNodeId', node.id) }}>
                  <span className="cell mono strong" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{node.name}</span>
                  <span className="cell hide-sm">{shortType(node.nodeType)}</span>
                  <span className="cell mono hide-sm" title={`${node.server}:${node.port}`}>{node.server}:{node.port}</span>
                  <span className={`cell node-stat ${delayClass(delay)}`} title={failed ? st?.error : undefined}>
                    {delay > 0 ? `${delay} ms` : (failed ? '—' : '· · ·')}
                  </span>
                  <span className={`cell node-stat ${speedClass(speed)}`}>
                    {speed > 0 ? formatRate(speed) : (failed ? '—' : '· · ·')}
                  </span>
                  <span className="cell" style={{ textAlign: 'right', color: selected ? 'var(--success)' : 'var(--text-3)' }}>
                    {selected ? <><Check size={14} /> {t('frontSelected')}</> : t('select')}
                  </span>
                </div>
              )
            }) : (
              <div className="muted" style={{ padding: 24, textAlign: 'center', fontSize: 12 }}>{t('noSubscription')}</div>
            )}
          </Card>
        </>
      )}
    </div>
  )
}
