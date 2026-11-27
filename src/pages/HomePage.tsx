import { useEffect, useState } from 'react'
import { Power, Globe2, MapPin, Gauge, Radio, ChevronRight, Star, RefreshCw, ArrowUpRight, ArrowDownRight, Server, AlertCircle } from 'lucide-react'
import { useStore, useLive } from '../store'
import { useEngine } from '../engine/useEngine'
import { tr } from '../i18n'
import { Card, Toggle, ProtocolSelect, FieldRow, Stat, LatencyChart, formatBytes, formatRate, formatDuration } from '../components/ui'

export function HomePage() {
  const store = useStore()
  const { settings, conn, endpoints, scanning, pinnedId, subNodes, nodeStats } = store
  // 速率与延迟曲线来自独立的实时 store：只有首页订阅，连接时不会波及其他页面
  const { up, down, upRate, downRate, latencyPoints } = useLive()
  const { scan, connect, disconnect } = useEngine()
  const [switching, setSwitching] = useState(false)
  const t = (k: string, v?: Record<string, string | number>) => tr(k, settings.lang, v)

  // 首页也需要候选端点：挂载后延迟一次真实探测，避免和首屏渲染抢资源
  useEffect(() => {
    if (endpoints.length || scanning) return
    const timer = window.setTimeout(() => void scan(), 1500)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const countries = Array.from(new Set(endpoints.map((e) => e.country).filter(Boolean)))
  const pinned = endpoints.find((e) => e.id === pinnedId)
  const subNode = settings.connMode === 'subscription' ? subNodes.find((n) => n.id === settings.frontNodeId) : undefined
  const subStat = subNode ? nodeStats[subNode.id] : undefined
  // 下拉框当前值：订阅模式指向节点，WARP 模式指向锁定端点或自动择优
  const nodeValue = settings.connMode === 'subscription'
    ? (subNode ? `sub:${subNode.id}` : 'sub:none')
    : `warp:${pinnedId ?? 'auto'}`
  const latestLatency = latencyPoints.length ? latencyPoints[latencyPoints.length - 1].ms : conn.latency
  const ringDeg = conn.connecting ? 220 : conn.connected ? 360 : 0
  const toggleConnect = () => {
    if (conn.connecting) return
    conn.connected ? disconnect() : connect()
  }

  /** 写入节点选择：WARP 端点会同时退出订阅模式，订阅节点则切到订阅模式 */
  const applyNode = (kind: 'warp' | 'sub', id: string | null) => {
    if (kind === 'warp') {
      store.setSetting('connMode', 'warp')
      store.pinEndpoint(id)
    } else if (id) {
      store.setSetting('connMode', 'subscription')
      store.setSetting('frontNodeId', id)
    }
  }

  /** 已连接时切换节点：先断开（还原系统代理）再用新节点重连 */
  const reconnectIfNeeded = async () => {
    if (!conn.connected) return
    setSwitching(true)
    try {
      await disconnect()
      await connect()
    } finally {
      setSwitching(false)
    }
  }

  const pickNode = async (value: string) => {
    if (switching) return
    // 端点 id 形如 awg:162.159.192.1:2408，不能按 ':' 全拆，只切第一段
    const sep = value.indexOf(':')
    const kind = value.slice(0, sep)
    const id = value.slice(sep + 1)
    if (kind === 'warp') {
      applyNode('warp', id === 'auto' ? null : id)
      store.log('INFO', `node switch -> warp ${id === 'auto' ? 'auto' : id}`)
    } else if (kind === 'sub' && id && id !== 'none') {
      applyNode('sub', id)
      store.log('INFO', `node switch -> subscription ${subNodes.find((n) => n.id === id)?.name ?? id}`)
    } else {
      return
    }
    await reconnectIfNeeded()
  }

  const pinWarp = async (id: string | null) => {
    if (switching) return
    applyNode('warp', id)
    await reconnectIfNeeded()
  }

  return (
    <div className="page-wrap fade-in stack">
      {/* 连接主区 */}
      <div className="card home-connect-card">
        <div className="home-connect-side" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}>
          <div
            className={`connect-ring ${conn.connected ? 'connected' : ''} ${conn.connecting ? 'pulse' : ''}`}
            style={{ ['--ring' as any]: `${ringDeg}deg` }}
            onClick={toggleConnect}
            role="button" tabIndex={0} aria-disabled={conn.connecting}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleConnect() } }}
          >
            <div className="inner">
              <div className="pwr"><Power size={34} strokeWidth={2.3} /></div>
              <div style={{ marginTop: 14, fontSize: 15, fontWeight: 800 }}>{t(conn.connected ? 'connected' : conn.connecting ? 'connecting' : 'connect')}</div>
              <div className="muted mono" style={{ fontSize: 11, marginTop: 4 }}>
                {conn.startedAt && conn.connected ? t('sessionClock') + ' ' + formatDuration(Date.now() - conn.startedAt) : t('appTagline')}
              </div>
            </div>
          </div>
          <button className="btn btn-outline" onClick={scan} disabled={scanning}>
            <RefreshCw size={15} className={scanning ? 'spin' : ''} />{t(scanning ? 'scanning' : 'scan')}
          </button>
        </div>

        <div className="stack home-options" style={{ gap: 16 }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <span style={{ fontSize: 13, fontWeight: 700 }}>{t('exitNode')}</span>
              <span className={`badge ${settings.connMode === 'subscription' ? 'badge-blue' : 'badge-gray'}`}>
                {t(settings.connMode === 'subscription' ? 'modeSubscription' : 'modeWarp')}
              </span>
            </div>
            <select
              className="select"
              style={{ width: '100%' }}
              value={nodeValue}
              disabled={switching}
              onChange={(e) => void pickNode(e.target.value)}
            >
              <optgroup label={t('modeWarp')}>
                <option value="warp:auto">{t('autoSelect')}</option>
                {endpoints.map((e) => (
                  <option key={e.id} value={`warp:${e.id}`}>
                    {e.host}:{e.port} · {e.latency > 0 ? `${e.latency}ms` : t('probeUntested')}
                  </option>
                ))}
              </optgroup>
              <optgroup label={t('subscriptionNodes')}>
                {settings.connMode === 'subscription' && !subNode && (
                  <option value="sub:none" disabled>{t('noNodeSelected')}</option>
                )}
                {subNodes.length ? subNodes.map((n) => {
                  const st = nodeStats[n.id]
                  return (
                    <option key={n.id} value={`sub:${n.id}`}>
                      {n.name}{st && st.delay > 0 ? ` · ${st.delay}ms` : ''}
                    </option>
                  )
                }) : <option value="" disabled>{t('noSubscription')}</option>}
              </optgroup>
            </select>
            <div className="muted" style={{ fontSize: 11, marginTop: 6, lineHeight: 1.5 }}>
              {switching ? t('switching')
                : conn.connected ? t('switchReconnect')
                  : settings.connMode === 'subscription'
                    ? (subNode ? t('subNodeActive') : t('modeSubscriptionDesc'))
                    : t('warpSelectHint')}
            </div>
            {settings.connMode === 'subscription' && !subNodes.length && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, color: 'var(--warn)', fontSize: 11.5 }}>
                <AlertCircle size={13} />{t('subMissing')}
                <button className="btn btn-ghost btn-sm" onClick={() => store.setPage('modes')}>{t('goImportSub')}</button>
              </div>
            )}
          </div>
          <ProtocolSelect value={settings.proto} onChange={(p) => store.setSetting('proto', p)} label={t('protocol')} availableLabel={t('available')} />
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>{t('connectOptions')}</div>
            <Card style={{ padding: '6px 16px' }}>
              <FieldRow title={t('tunMode')} desc={t('tunModeDesc')}
                control={<Toggle checked={settings.captureMode === 'tun'} onChange={(v) => store.setSetting('captureMode', v ? 'tun' : 'proxy')} />} />
              <FieldRow title={t('rescan')} desc={t('rescanDesc')}
                control={<Toggle checked={settings.rescan} onChange={(v) => store.setSetting('rescan', v)} />} />
              <FieldRow title={t('warpInWarp')} desc={t('warpInWarpDesc')}
                control={<Toggle checked={settings.warpInWarp} onChange={(v) => store.setSetting('warpInWarp', v)} />} />
              {settings.warpInWarp && (
                <FieldRow title={t('innerProto')} control={
                  <ProtocolSelect compact value={settings.innerProto} onChange={(p) => store.setSetting('innerProto', p)} availableLabel={t('available')} />
                } />
              )}
              <FieldRow title={t('psiphon')} desc={t('psiphonDesc')}
                control={<Toggle checked={settings.psiphon} onChange={(v) => store.setSetting('psiphon', v)} />} />
            </Card>
          </div>
        </div>
      </div>

      {/* 出口信息 */}
      <div className="grid-3">
        <Stat label={t('exitIp')} value={conn.exitIp || '—'} sub={t('sessionClock') + ': ' + (conn.session || '—')} color="var(--brand)" />
        <Stat label={t('country') + ' / ' + t('colo')} value={conn.country ? `${conn.country} · ${conn.colo}` : '—'} sub={conn.city} />
        <Stat label={t('latency')} value={conn.latency ? `${conn.latency} ms` : '—'} sub={conn.endpoint ? `${conn.endpoint.host}:${conn.endpoint.port}` : t('endpoint')}
          color={conn.latency < 250 ? 'var(--success)' : conn.latency < 600 ? 'var(--warn)' : 'var(--danger)'} />
      </div>

      {/* 国家过滤 + 实时图表 + 吞吐 */}
      <div className="grid-2">
        <Card title={<><Globe2 size={16} />{t('countryFilter')}</>} sub={t('countryFilterDesc')}>
          {countries.length ? (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {countries.map((c) => {
                const on = store.allowedCountries.includes(c)
                return (
                  <button key={c} className={`badge ${on ? 'badge-blue' : 'badge-gray'}`}
                    onClick={() => store.toggleCountry(c)} style={{ cursor: 'pointer', padding: '6px 12px', fontSize: 12 }}>
                    {on && <span className="dot" />}{c}
                  </button>
                )
              })}
            </div>
          ) : (
            <div>
              <div className="strong mono" style={{ fontSize: 13 }}>
                {conn.country ? `${conn.country} · ${conn.colo}` : '—'}
              </div>
              <div className="muted" style={{ fontSize: 11.5, marginTop: 6, lineHeight: 1.6 }}>{t('endpointGeoHint')}</div>
            </div>
          )}
        </Card>
        <Card title={<><Radio size={16} />{t('liveLatency')}</>}
          sub={latestLatency ? t('latencySample', { v: latestLatency, n: latencyPoints.length }) : t('latencyEmpty')}>
          <LatencyChart points={latencyPoints} color={conn.connected ? 'var(--success)' : 'var(--brand)'} />
        </Card>
      </div>

      <div className="grid-2">
        <Card title={<><Gauge size={16} />{t('throughput')}</>}>
          <div style={{ display: 'flex', gap: 32, flexWrap: 'wrap' }}>
            <div>
              <div className="muted" style={{ fontSize: 11 }}><ArrowUpRight size={12} style={{ verticalAlign: 'middle' }} /> {t('upRate')}</div>
              <div className="strong mono" style={{ fontSize: 20, marginTop: 4 }}>{formatRate(upRate)}</div>
              <div className="muted mono" style={{ fontSize: 10, marginTop: 2 }}>{t('cumulative')} {formatBytes(up)}</div>
            </div>
            <div>
              <div className="muted" style={{ fontSize: 11 }}><ArrowDownRight size={12} style={{ verticalAlign: 'middle' }} /> {t('downRate')}</div>
              <div className="strong mono" style={{ fontSize: 20, marginTop: 4, color: 'var(--brand)' }}>{formatRate(downRate)}</div>
              <div className="muted mono" style={{ fontSize: 10, marginTop: 2 }}>{t('cumulative')} {formatBytes(down)}</div>
            </div>
          </div>
        </Card>
        <Card title={<><MapPin size={16} />{t('selectNode')}</>} sub={subNode ? t('modeSubscription') : t('clickToPin')}>
          {subNode ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <Star size={18} fill="var(--brand)" color="var(--brand)" />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="strong mono" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{subNode.name}</div>
                <div className="muted" style={{ fontSize: 11, marginTop: 3 }}>
                  {subNode.nodeType.toUpperCase()} · {subNode.server}:{subNode.port}{subStat && subStat.delay > 0 ? ` · ${subStat.delay}ms` : ''}
                </div>
              </div>
              <button className="btn btn-ghost btn-sm" disabled={switching} onClick={() => void pinWarp(null)}>{t('switchToWarp')}</button>
            </div>
          ) : pinned ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <Star size={18} fill="var(--brand)" color="var(--brand)" />
              <div style={{ flex: 1 }}>
                <div className="strong mono">{pinned.host}:{pinned.port}</div>
                <div className="muted" style={{ fontSize: 11, marginTop: 3 }}>
                  {pinned.latency > 0 ? `${pinned.latency}ms · ` : ''}{pinned.protocol.toUpperCase()}
                </div>
              </div>
              <button className="btn btn-ghost btn-sm" onClick={() => store.pinEndpoint(null)}>{t('unlock')}</button>
            </div>
          ) : (
            <div className="muted" style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
              {t('autoSelect')} <ChevronRight size={14} />
            </div>
          )}
        </Card>
      </div>

      {/* 缓存端点 */}
      <Card title={<><Server size={16} />{t('cacheEndpoints')}</>} sub={`${t('totalNodes', { n: endpoints.length })} · ${t('cacheHint')}`}>
        {endpoints.length ? (
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <div className="table-head"><span>{t('nodeHost')}</span><span>{t('nodeProto')}</span><span className="hide-sm">{t('endpointState')}</span><span>{t('nodePing')}</span><span /></div>
            {endpoints.slice(0, 8).map((e) => (
              <div key={e.id} className={`node-row ${pinnedId === e.id && settings.connMode !== 'subscription' ? 'selected' : ''}`} onClick={() => void pinWarp(pinnedId === e.id ? null : e.id)} tabIndex={0}>
                <span className="cell mono strong">{e.host}:{e.port}</span>
                <span className="cell">{e.protocol.toUpperCase()}</span>
                <span className="cell hide-sm">{e.loss > 0 ? t('probeFailed') : e.latency > 0 ? t('probeOk') : t('probeUntested')}</span>
                <span className="cell" style={{ color: e.latency > 0 ? (e.latency < 250 ? 'var(--success)' : 'var(--warn)') : 'var(--text-3)', fontWeight: 700 }}>
                  {e.latency > 0 ? `${e.latency}ms` : '—'}
                </span>
                <span className="cell">{pinnedId === e.id && settings.connMode !== 'subscription' ? <Star size={15} fill="var(--brand)" color="var(--brand)" /> : <Star size={15} className="muted" />}</span>
              </div>
            ))}
          </div>
        ) : <div className="muted" style={{ fontSize: 12, padding: 20, textAlign: 'center' }}>{t('noData')} — {t('scan')}</div>}
      </Card>
    </div>
  )
}
