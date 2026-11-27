import { useEffect, useMemo, useState } from 'react'
import { Power, Globe2, MapPin, Gauge, Radio, Star, RefreshCw, ArrowUpRight, ArrowDownRight, Server, AlertCircle, Check } from 'lucide-react'
import { useStore, useLive } from '../store'
import type { ColoRecord } from '../store'
import { useEngine } from '../engine/useEngine'
import { tr } from '../i18n'
import { Card, Toggle, ProtocolSelect, FieldRow, Stat, LatencyChart, RateChart, formatBytes, formatRate, formatDuration } from '../components/ui'

export function HomePage() {
  const store = useStore()
  const { settings, conn, endpoints, scanning, pinnedId, subNodes, nodeStats, coloLog } = store
  // 速率与延迟曲线来自独立的实时 store：只有首页订阅，连接时不会波及其他页面
  const { up, down, upRate, downRate, latencyPoints, ratePoints } = useLive()
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

  const pinned = endpoints.find((e) => e.id === pinnedId)
  const subNode = settings.connMode === 'subscription' ? subNodes.find((n) => n.id === settings.frontNodeId) : undefined
  const subStat = subNode ? nodeStats[subNode.id] : undefined
  /**
   * 订阅模式「节点出口」：隧道完全由订阅节点自己的协议承担（例如 VLESS），
   * 此时 settings.proto 只留在配置里、不参与建链，协议下拉框必须降级为只读展示，
   * 否则界面会让人误以为 GOOL / AWG 之类被选中并生效。
   * 若开启「节点流量经 WARP 承载」或订阅出口选 WARP，则 WARP 协议仍起作用。
   */
  const nodeExit = settings.connMode === 'subscription' && settings.subExit === 'node' && !settings.subViaWarp
  const subProtoLabel = subNode ? subNode.nodeType.toUpperCase() : t('followSubNode')
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

  // 观测记录：按 host:port 归并（旧版本键里带协议前缀），命中次数多的排前面，最多展示 5 条
  const coloRecords = useMemo(() => {
    const byHost = new Map<string, ColoRecord>()
    for (const r of Object.values(coloLog)) {
      const key = `${r.host}:${r.port}`
      const prev = byHost.get(key)
      if (!prev) byHost.set(key, { ...r, id: key })
      else byHost.set(key, {
        ...(prev.ts >= r.ts ? prev : r),
        hits: Math.max(prev.hits, r.hits),
      })
    }
    return [...byHost.values()]
      .sort((a, b) => b.hits - a.hits || b.ts - a.ts)
      .slice(0, 5)
  }, [coloLog])
  const ago = (ts: number) => {
    const m = Math.floor((Date.now() - ts) / 60000)
    return m < 1 ? t('justNow') : t('minutesAgo', { n: m })
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
      {/* 连接主区：左列集中「连哪个节点」，右列是连接选项 */}
      <div className="card home-connect-card">
        <div className="home-connect-side">
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

          {/* 已选节点：原右下角那张卡搬到这里，和连接按钮放在一起 */}
          <div className="home-node-pick">
            <div className="home-node-pick-head">
              <MapPin size={14} className="muted" />
              <span className="home-node-pick-label">{t('selectNode')}</span>
              <span className={`badge ${settings.connMode === 'subscription' ? 'badge-blue' : 'badge-gray'}`}>
                {t(settings.connMode === 'subscription' ? 'modeSubscription' : 'modeWarp')}
              </span>
              <button className="btn btn-ghost btn-sm" style={{ marginLeft: 'auto' }} onClick={scan} disabled={scanning}>
                <RefreshCw size={13} className={scanning ? 'spin' : ''} />{t(scanning ? 'scanning' : 'scan')}
              </button>
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
            <div className="muted home-node-pick-hint">
              {switching ? t('switching')
                : conn.connected ? t('switchReconnect')
                  : settings.connMode === 'subscription'
                    ? (subNode ? t('subNodeActive') : t('modeSubscriptionDesc'))
                    : t('warpSelectHint')}
            </div>
            {settings.connMode === 'subscription' && !subNodes.length && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--warn)', fontSize: 11.5 }}>
                <AlertCircle size={13} />{t('subMissing')}
                <button className="btn btn-ghost btn-sm" onClick={() => store.setPage('modes')}>{t('goImportSub')}</button>
              </div>
            )}
            {subNode && (
              <div className="home-node-pick-active">
                <Star size={13} fill="var(--brand)" color="var(--brand)" />
                <span className="mono">{subNode.name}</span>
                <span className="muted">{subNode.nodeType.toUpperCase()} · {subNode.server}:{subNode.port}{subStat && subStat.delay > 0 ? ` · ${subStat.delay}ms` : ''}</span>
                <button className="btn btn-ghost btn-sm" disabled={switching} onClick={() => void pinWarp(null)}>{t('switchToWarp')}</button>
              </div>
            )}
            {!subNode && pinned && (
              <div className="home-node-pick-active">
                <Star size={13} fill="var(--brand)" color="var(--brand)" />
                <span className="mono">{pinned.host}:{pinned.port}</span>
                <span className="muted">{pinned.latency > 0 ? `${pinned.latency}ms` : t('probeUntested')} · {pinned.protocol.toUpperCase()}</span>
                <button className="btn btn-ghost btn-sm" onClick={() => store.pinEndpoint(null)}>{t('unlock')}</button>
              </div>
            )}
          </div>
        </div>

        <div className="stack home-options" style={{ gap: 16 }}>
          <ProtocolSelect
            value={settings.proto}
            onChange={(p) => store.setSetting('proto', p)}
            label={t(nodeExit ? 'protocolLocked' : 'protocol')}
            availableLabel={t('available')}
            disabled={nodeExit}
            valueText={nodeExit ? subProtoLabel : undefined}
            lockLabel={nodeExit ? t('subExitTag') : undefined}
            hint={nodeExit ? t('protoNodeExitHint') : undefined}
          />
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

      {/* 出口机房（可手动换端点） + 实时延迟 */}
      <div className="grid-2">
        <Card title={<><Globe2 size={16} />{t('exitColo')}</>} sub={t('exitColoDesc')}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
            <div className="strong mono" style={{ fontSize: 19 }}>
              {conn.country ? `${conn.country} · ${conn.colo}` : '—'}
            </div>
            <span className={`badge ${conn.connected ? 'badge-blue' : 'badge-gray'}`}>
              {t(conn.connected ? 'coloLive' : 'coloIdle')}
            </span>
            {conn.city && <span className="muted" style={{ fontSize: 11.5 }}>{conn.city}</span>}
          </div>
          <div className="muted" style={{ fontSize: 11.5, marginTop: 6, lineHeight: 1.6 }}>{t('exitColoHint')}</div>

          {coloRecords.length ? (
            <div style={{ marginTop: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', marginBottom: 4 }}>
                <span className="muted" style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.4px', textTransform: 'uppercase' }}>{t('coloLogTitle')}</span>
                <button className="btn btn-ghost btn-sm" style={{ marginLeft: 'auto' }} onClick={store.clearColoLog}>{t('clear')}</button>
              </div>
              {coloRecords.map((r) => {
                // 机房只跟端点地址有关，按 host:port 在当前协议列表里找对应端点
                const cur = endpoints.find((e) => e.host === r.host && e.port === r.port)
                const usable = !!cur
                const active = !!cur && pinnedId === cur.id && settings.connMode !== 'subscription'
                return (
                  <div
                    key={r.id}
                    className={`colo-row ${usable ? '' : 'disabled'} ${active ? 'selected' : ''}`}
                    onClick={() => { if (cur && !active) void pinWarp(cur.id) }}
                    role="button" tabIndex={usable ? 0 : -1}
                    title={usable ? t('coloPinHint') : t('coloUnavailable')}
                    onKeyDown={(ev) => { if (ev.key === 'Enter' && cur && !active) void pinWarp(cur.id) }}
                  >
                    <span className="cell mono strong">{r.host}:{r.port}</span>
                    <span className="cell" style={{ color: 'var(--brand)', fontWeight: 700 }}>{r.colo || '—'}</span>
                    <span className="cell muted">{r.country || '—'} · {ago(r.ts)}</span>
                    <span className="cell" style={{ textAlign: 'right' }}>
                      {active ? <Check size={14} color="var(--brand)" /> : usable ? <Star size={14} className="muted" /> : <span className="muted" style={{ fontSize: 10.5 }}>{t('na')}</span>}
                    </span>
                  </div>
                )
              })}
            </div>
          ) : (
            <div className="muted" style={{ fontSize: 11.5, marginTop: 12, lineHeight: 1.6 }}>{t('coloEmpty')}</div>
          )}
        </Card>
        <Card title={<><Radio size={16} />{t('liveLatency')}</>}
          sub={latestLatency ? t('latencySample', { v: latestLatency, n: latencyPoints.length }) : t('latencyEmpty')}>
          <LatencyChart points={latencyPoints} color={conn.connected ? 'var(--success)' : 'var(--brand)'} />
        </Card>
      </div>

      {/* 实时速率 + 波形 */}
      <Card title={<><Gauge size={16} />{t('throughput')}</>}
        sub={ratePoints.length ? t('rateWindow', { n: ratePoints.length }) : t('rateEmpty')}>
        <div style={{ display: 'flex', gap: 28, flexWrap: 'wrap', alignItems: 'flex-end', justifyContent: 'space-between' }}>
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
          <div className="rate-legend">
            <span><i style={{ background: 'var(--brand)' }} />{t('downRate')}</span>
            <span><i style={{ background: 'var(--warn)' }} />{t('upRate')}</span>
          </div>
        </div>
        <div style={{ marginTop: 10 }}>
          <RateChart points={ratePoints} />
        </div>
      </Card>

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
