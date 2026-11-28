import { useEffect, useMemo, useState } from 'react'
import { Power, Globe2, MapPin, Gauge, Radio, Star, RefreshCw, ArrowUpRight, ArrowDownRight, Server, AlertCircle, Check } from 'lucide-react'
import { useStore, useLive } from '../store'
import type { ColoRecord } from '../store'
import { useEngine, waitForConnectIdle } from '../engine/useEngine'
import { tr } from '../i18n'
import { Card, Toggle, ProtocolSelect, FlagSelect, FieldRow, Stat, LatencyChart, RateChart, formatBytes, formatRate, formatDuration } from '../components/ui'
import type { FlagOption } from '../components/ui'
import { Flag } from '../components/Flag'
import { regionName, codeFromNode, displayNodeName } from '../lib/region'

export function HomePage() {
  const store = useStore()
  const { settings, conn, endpoints, scanning, nodeTesting, pinnedId, subNodes, savedNodes, nodeStats, coloLog, cancelling, lastError } = store
  // 速率与延迟曲线来自独立的实时 store：只有首页订阅，连接时不会波及其他页面
  const { up, down, upRate, downRate, latencyPoints, ratePoints } = useLive()
  const { scan, probeSubNodes, connect, disconnect, cancel } = useEngine()
  const [switching, setSwitching] = useState(false)
  /** 本次断开重连的原因（空 = 换节点），用于把提示文案说清楚 */
  const [switchNote, setSwitchNote] = useState('')
  const t = (k: string, v?: Record<string, string | number>) => tr(k, settings.lang, v)

  // 首页也需要候选端点：挂载后延迟一次真实探测，避免和首屏渲染抢资源
  useEffect(() => {
    if (endpoints.length || scanning) return
    const timer = window.setTimeout(() => void scan(), 1500)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const pinned = endpoints.find((e) => e.id === pinnedId)
  // 选中的前置节点：先找当前订阅，再找收藏（收藏项与订阅解耦，刷新订阅不会让它失效）
  const subNode = settings.connMode === 'subscription'
    ? (subNodes.find((n) => n.id === settings.frontNodeId) ?? savedNodes.find((n) => n.id === settings.frontNodeId))
    : undefined
  // 收藏节点不在 nodeStats 里，用收藏时缓存的结果兜底，避免首页延迟一直显示空
  const subStat = subNode
    ? (nodeStats[subNode.id] ?? {
      id: subNode.id,
      delay: ('delay' in subNode ? subNode.delay : undefined) ?? -1,
      speed: ('speed' in subNode ? subNode.speed : undefined) ?? 0,
      bytes: 0,
      error: '',
    })
    : undefined
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
  /**
   * 下拉的订阅组。选用的节点可能来自「收藏」（不在当前订阅列表里），
   * 若只列 subNodes，触发器会因为找不到选项而显示「未选择节点」。
   *
   * 顺序按实测延迟升序：测速（首页按钮 / 模式页）之后自动生效；
   * 未测与测不通的视为最大值排在后面，且保持订阅原始顺序（sort 稳定）。
   */
  const latencyOf = (id: string) => {
    const d = nodeStats[id]?.delay ?? 0
    return d > 0 ? d : Number.MAX_SAFE_INTEGER
  }
  const subOptions: FlagOption[] = [...subNodes]
    .sort((a, b) => latencyOf(a.id) - latencyOf(b.id))
    .map((n) => ({
      value: `sub:${n.id}`,
      label: displayNodeName(n.name),
      flag: codeFromNode(n.name, n.server),
      hint: nodeStats[n.id]?.delay > 0 ? `${nodeStats[n.id].delay}ms` : '',
    }))
  if (subNode && !subNodes.some((n) => n.id === subNode.id)) {
    subOptions.unshift({
      value: `sub:${subNode.id}`,
      label: displayNodeName(subNode.name),
      flag: codeFromNode(subNode.name, subNode.server),
      hint: `${subStat && subStat.delay > 0 ? `${subStat.delay}ms · ` : ''}${t('navSaved')}`,
    })
  }
  if (!subOptions.length) {
    subOptions.push({ value: 'sub:none', label: t('noSubscription'), disabled: true })
  }

  const latestLatency = latencyPoints.length ? latencyPoints[latencyPoints.length - 1].ms : conn.latency
  const ringDeg = conn.connecting ? 220 : conn.connected ? 360 : 0
  const toggleConnect = () => {
    // 连接中点一下就是取消：以前这里直接 return，点错只能干等 Psiphon 重试跑完
    if (conn.connecting) {
      if (!cancelling) void cancel()
      return
    }
    conn.connected ? disconnect() : connect()
  }

  /**
   * 同一个按钮两种语义：
   * - 订阅模式（且有订阅节点）：给订阅节点测延迟，结果用来排序下拉
   * - WARP 模式：探测 WARP 候选端点（原行为）
   * WARP 端点扫描对订阅模式没有意义，订阅模式下测节点才是用户想要的。
   */
  const probeSub = settings.connMode === 'subscription' && subNodes.length > 0
  const probeBusy = probeSub ? nodeTesting : scanning
  const runProbe = () => {
    if (probeBusy) return
    void (probeSub ? probeSubNodes() : scan())
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
  const reconnectIfNeeded = async (note = '') => {
    if (!conn.connected) return
    setSwitchNote(note)
    setSwitching(true)
    try {
      await disconnect()
      await connect()
    } finally {
      setSwitching(false)
      setSwitchNote('')
    }
  }

  /**
   * 切换 Psiphon 出口。
   * 出口是在连接时写进核心配置的（render_config 里 PSIPHON 出站 + outbound: PSIPHON），
   * 核心跑起来之后改设置不会影响已建的隧道，所以已连接时必须断开重连才生效。
   *
   * 连接中也允许直接切：WARP 在当前网络不可达时，用户第一反应就是打开 Psiphon，
   * 以前这个开关是灰的，必须先点圈取消、再点开关、再点圈连接 —— 三步还容易点空。
   * 现在一次点击就完成「取消当前链路 → 等它收尾 → 按新设置重连」。
   */
  const togglePsiphon = async (v: boolean) => {
    if (switching) return
    store.setSetting('psiphon', v)
    store.log('INFO', `psiphon -> ${v ? 'on' : 'off'}`)
    store.addHistory(`psiphon ${v ? 'on' : 'off'}`)
    if (conn.connecting) {
      if (cancelling) return
      setSwitchNote(t('psiphonSwitching'))
      setSwitching(true)
      try {
        await cancel()
        // 取消只让 UI 复位，Rust 侧还在收尾；不等它释放会直接撞上重入锁（表现为点了没反应）
        await waitForConnectIdle()
        await connect()
      } finally {
        setSwitching(false)
        setSwitchNote('')
      }
      return
    }
    await reconnectIfNeeded(t('psiphonSwitching'))
  }

  /** 连接失败后的一键补救：改用 Psiphon 出口重连（失败原因常是本机到 Cloudflare 的 UDP 被阻断） */
  const retryWithPsiphon = async () => {
    if (switching || conn.connecting) return
    store.setSetting('psiphon', true)
    store.setLastError('')
    store.log('INFO', 'retry with psiphon')
    store.addHistory('retry with psiphon', false)
    await connect()
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
            className={`connect-ring ${conn.connected ? 'connected' : ''} ${conn.connecting ? 'pulse' : ''} ${conn.connecting ? 'cancellable' : ''} ${cancelling ? 'cancelling' : ''}`}
            style={{ ['--ring' as any]: `${ringDeg}deg` }}
            onClick={toggleConnect}
            role="button" tabIndex={0}
            title={conn.connecting ? t('cancelConnect') : undefined}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleConnect() } }}
          >
            <div className="inner">
              <div className="pwr"><Power size={34} strokeWidth={2.3} /></div>
              <div style={{ marginTop: 14, fontSize: 15, fontWeight: 800 }}>
                {conn.connected
                  ? t('connected')
                  : cancelling
                    ? t('cancelling')
                    : conn.connecting ? t('connecting') : t('connect')}
              </div>
              <div className="muted mono" style={{ fontSize: 11, marginTop: 4 }}>
                {conn.startedAt && conn.connected
                  ? t('sessionClock') + ' ' + formatDuration(Date.now() - conn.startedAt)
                  : cancelling
                    ? t('cancelPending')
                    : conn.connecting
                      ? `${settings.psiphon && settings.connMode === 'warp' ? t('psiphonStarting') + ' · ' : ''}${t('cancelHint')}`
                      : t('appTagline')}
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
              <button
                className="btn btn-ghost btn-sm" style={{ marginLeft: 'auto' }}
                onClick={runProbe} disabled={probeBusy}
                title={probeSub ? t('probeSubHint') : undefined}
              >
                <RefreshCw size={13} className={probeBusy ? 'spin' : ''} />
                {t(probeBusy ? (probeSub ? 'testing' : 'scanning') : (probeSub ? 'probeSubNodes' : 'scan'))}
              </button>
            </div>
            <FlagSelect
              lang={settings.lang}
              value={nodeValue}
              disabled={switching}
              placeholder={t('noNodeSelected')}
              empty={t('noSubscription')}
              onChange={(v) => void pickNode(v)}
              groups={[
                {
                  label: t('modeWarp'),
                  options: [
                    { value: 'warp:auto', label: t('autoSelect'), globe: false },
                    ...endpoints.map((e) => ({
                      value: `warp:${e.id}`,
                      label: `${e.host}:${e.port}`,
                      globe: false,
                      hint: e.latency > 0 ? `${e.latency}ms` : t('probeUntested'),
                    })),
                  ],
                },
                {
                  label: t('subscriptionNodes'),
                  options: subOptions,
                },
              ]}
            />
            {settings.connMode === 'subscription' && !subNode && subNodes.length > 0 && (
              <div className="muted" style={{ fontSize: 11.5, color: 'var(--warn)' }}>{t('noNodeSelected')}</div>
            )}
            <div className="muted home-node-pick-hint">
              {switching ? (switchNote || t('switching'))
                : conn.connected ? t('switchReconnect')
                  : settings.connMode === 'subscription'
                    ? (subNode ? t('subNodeActive') : t('modeSubscriptionDesc'))
                    : t('warpSelectHint')}
            </div>
            {/* 上次连接失败的原因：留在首页而不是只写日志页，用户才知道下一步该做什么 */}
            {!conn.connected && !conn.connecting && !!lastError && (
              <div className="home-last-error">
                <AlertCircle size={13} style={{ flexShrink: 0, marginTop: 2 }} />
                <div style={{ minWidth: 0 }}>
                  <div style={{ wordBreak: 'break-word' }}>{lastError}</div>
                  {settings.connMode === 'warp' && !settings.psiphon && (
                    <button
                      className="btn btn-ghost btn-sm"
                      style={{ marginTop: 4, paddingLeft: 0 }}
                      disabled={switching}
                      onClick={() => void retryWithPsiphon()}
                    >
                      {t('tryPsiphon')}
                    </button>
                  )}
                </div>
              </div>
            )}
            {settings.connMode === 'subscription' && !subNodes.length && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--warn)', fontSize: 11.5 }}>
                <AlertCircle size={13} />{t('subMissing')}
                <button className="btn btn-ghost btn-sm" onClick={() => store.setPage('modes')}>{t('goImportSub')}</button>
              </div>
            )}
            {subNode && (
              <div className="home-node-pick-active">
                <Star size={13} fill="var(--brand)" color="var(--brand)" />
                <Flag code={codeFromNode(subNode.name, subNode.server)} lang={settings.lang} size={15} />
                <span className="mono">{displayNodeName(subNode.name)}</span>
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
              <FieldRow
                title={t('psiphon')}
                desc={
                  settings.connMode === 'subscription'
                    ? t('psiphonSubOnly')
                    : switching
                      ? t('psiphonSwitching')
                      : conn.connecting
                        ? t('psiphonSwitchNow')
                        : conn.connected
                          ? t('psiphonDescConnected')
                          : t('psiphonDesc')
                }
                control={
                  <Toggle
                    checked={settings.psiphon}
                    disabled={settings.connMode === 'subscription' || switching}
                    onChange={(v) => void togglePsiphon(v)}
                  />
                }
              />
            </Card>
          </div>
        </div>
      </div>

      {/* 出口信息 */}
      <div className="grid-3">
        <Stat label={t('exitIp')} value={
          <span className="with-flag">
            <Flag code={conn.country} lang={settings.lang} globe={false} />
            <span>{conn.exitIp || '—'}</span>
          </span>
        } sub={t('sessionClock') + ': ' + (conn.session || '—')} color="var(--brand)" />
        <Stat label={t('country') + ' / ' + t('colo')} value={
          conn.country ? (
            <span className="with-flag">
              <Flag code={conn.country} lang={settings.lang} globe={false} />
              <span>{`${regionName(conn.country, settings.lang)} · ${conn.colo}`}</span>
            </span>
          ) : '—'
        } sub={conn.city} />
        <Stat label={t('latency')} value={conn.latency ? `${conn.latency} ms` : '—'} sub={conn.endpoint ? `${conn.endpoint.host}:${conn.endpoint.port}` : t('endpoint')}
          color={conn.latency < 250 ? 'var(--success)' : conn.latency < 600 ? 'var(--warn)' : 'var(--danger)'} />
      </div>

      {/* 出口机房（可手动换端点） + 实时延迟 */}
      <div className="grid-2">
        <Card title={<><Globe2 size={16} />{t('exitColo')}</>} sub={t('exitColoDesc')}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
            <div className="strong mono with-flag" style={{ fontSize: 19 }}>
              <Flag code={conn.country} lang={settings.lang} size={19} globe={false} />
              <span>{conn.country ? `${regionName(conn.country, settings.lang)} · ${conn.colo}` : '—'}</span>
            </div>
            <span className={`badge ${conn.connected ? 'badge-blue' : 'badge-gray'}`}>
              {t(conn.connected ? 'coloLive' : 'coloIdle')}
            </span>
            {conn.city && <span className="muted" style={{ fontSize: 11.5 }}>{conn.city}</span>}
          </div>
          <div className="muted" style={{ fontSize: 11.5, marginTop: 6, lineHeight: 1.6 }}>{t('exitColoHint')}</div>

          {coloRecords.length ? (
            <div style={{ marginTop: 12 }}>
              <div className="colo-head">
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
                    <span className="cell muted with-flag">
                      <Flag code={r.country} lang={settings.lang} size={14} globe={false} />
                      <span>{r.country ? `${regionName(r.country, settings.lang)} · ${ago(r.ts)}` : `— · ${ago(r.ts)}`}</span>
                    </span>
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
