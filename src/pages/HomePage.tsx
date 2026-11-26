import { Power, Globe2, MapPin, Gauge, Radio, ChevronRight, Star, RefreshCw, ArrowUpRight, ArrowDownRight, Server } from 'lucide-react'
import { useStore } from '../store'
import { useEngine } from '../engine/useEngine'
import { tr } from '../i18n'
import { Card, Toggle, ProtocolPicker, FieldRow, Stat, LatencyChart, formatBytes, formatDuration } from '../components/ui'

export function HomePage() {
  const store = useStore()
  const { settings, conn, endpoints, scanning, latencyPoints, pinnedId } = store
  const { scan, connect, disconnect } = useEngine()
  const t = (k: string, v?: Record<string, string | number>) => tr(k, settings.lang, v)

  const countries = Array.from(new Set(endpoints.map((e) => e.country)))
  const pinned = endpoints.find((e) => e.id === pinnedId)
  const ringDeg = conn.connecting ? 220 : conn.connected ? 360 : 0
  const toggleConnect = () => {
    if (conn.connecting) return
    conn.connected ? disconnect() : connect()
  }

  return (
    <div className="page-wrap fade-in stack">
      {/* 连接主区 */}
      <div className="card" style={{ display: 'grid', gridTemplateColumns: 'minmax(280px, 1fr) 1.1fr', gap: 28, alignItems: 'center', padding: 28 }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}>
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

        <div className="stack" style={{ gap: 16 }}>
          <ProtocolPicker value={settings.proto} onChange={(p) => store.setSetting('proto', p)} label={t('protocol')} />
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
                  <ProtocolPicker value={settings.innerProto} onChange={(p) => store.setSetting('innerProto', p)} />
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
          ) : <div className="muted" style={{ fontSize: 12 }}>{t('noData')}</div>}
        </Card>
        <Card title={<><Radio size={16} />{t('liveLatency')}</>} sub={`${latencyPoints.length} samples`}>
          <LatencyChart points={latencyPoints} color={conn.connected ? 'var(--success)' : 'var(--brand)'} />
        </Card>
      </div>

      <div className="grid-2">
        <Card title={<><Gauge size={16} />{t('throughput')}</>}>
          <div style={{ display: 'flex', gap: 32 }}>
            <div>
              <div className="muted" style={{ fontSize: 11 }}><ArrowUpRight size={12} style={{ verticalAlign: 'middle' }} /> {t('up')}</div>
              <div className="strong mono" style={{ fontSize: 20, marginTop: 4 }}>{formatBytes(conn.up)}</div>
            </div>
            <div>
              <div className="muted" style={{ fontSize: 11 }}><ArrowDownRight size={12} style={{ verticalAlign: 'middle' }} /> {t('down')}</div>
              <div className="strong mono" style={{ fontSize: 20, marginTop: 4, color: 'var(--brand)' }}>{formatBytes(conn.down)}</div>
            </div>
          </div>
        </Card>
        <Card title={<><MapPin size={16} />{t('selectNode')}</>} sub={t('clickToPin')}>
          {pinned ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <Star size={18} fill="var(--brand)" color="var(--brand)" />
              <div style={{ flex: 1 }}>
                <div className="strong mono">{pinned.host}:{pinned.port}</div>
                <div className="muted" style={{ fontSize: 11, marginTop: 3 }}>{pinned.country} · {pinned.colo} · {pinned.latency}ms · {pinned.protocol.toUpperCase()}</div>
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
      <Card title={<><Server size={16} />{t('cacheEndpoints')}</>} sub={t('totalNodes', { n: endpoints.length })}>
        {endpoints.length ? (
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <div className="table-head"><span>{t('nodeHost')}</span><span>{t('nodeCountry')}</span><span className="hide-sm">{t('nodeColo')}</span><span>{t('nodePing')}</span><span /></div>
            {endpoints.slice(0, 8).map((e) => (
              <div key={e.id} className={`node-row ${pinnedId === e.id ? 'selected' : ''}`} onClick={() => store.pinEndpoint(pinnedId === e.id ? null : e.id)} tabIndex={0}>
                <span className="cell mono strong">{e.host}:{e.port}</span>
                <span className="cell">{e.country}</span>
                <span className="cell hide-sm">{e.colo}</span>
                <span className="cell" style={{ color: e.latency < 250 ? 'var(--success)' : 'var(--warn)', fontWeight: 700 }}>{e.latency}ms</span>
                <span className="cell">{pinnedId === e.id ? <Star size={15} fill="var(--brand)" color="var(--brand)" /> : <Star size={15} className="muted" />}</span>
              </div>
            ))}
          </div>
        ) : <div className="muted" style={{ fontSize: 12, padding: 20, textAlign: 'center' }}>{t('noData')} — {t('scan')}</div>}
      </Card>
    </div>
  )
}
