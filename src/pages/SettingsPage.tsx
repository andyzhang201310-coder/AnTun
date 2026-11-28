import { useState, useEffect } from 'react'
import { Cpu, Route, Rocket, Database, RotateCcw, KeyRound, Check, AlertCircle, Download, RefreshCw, Activity, ShieldCheck } from 'lucide-react'
import { useStore } from '../store'
import { tr } from '../i18n'
import { Card, Toggle, FieldRow, Segment, ProtocolPicker } from '../components/ui'
import { useEngine, waitForConnectIdle } from '../engine/useEngine'
import { parseWarpCredential } from '../engine/credential'
import type { CoreComponentStatus, CoreUpdateStatus, RegionOption, DiagReport, CredentialInfo } from '../desktop'

export function SettingsPage() {
  const store = useStore()
  const { settings: s } = store
  const { connect, disconnect, cancel } = useEngine()
  const [psiphonBusy, setPsiphonBusy] = useState(false)
  const t = (k: string, vars?: Record<string, string | number>) => tr(k, s.lang, vars)
  const [warpText, setWarpText] = useState('')
  const [warpMsg, setWarpMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [hasCred, setHasCred] = useState(false)
  const [credInfo, setCredInfo] = useState<CredentialInfo | null>(null)
  const [coreStatus, setCoreStatus] = useState<CoreUpdateStatus | null>(null)
  const [coreBusy, setCoreBusy] = useState<'mihomo' | 'psiphon' | null>(null)
  const [coreMsg, setCoreMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [regions, setRegions] = useState<RegionOption[]>([])
  const [regionMsg, setRegionMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [diag, setDiag] = useState<DiagReport | null>(null)
  const [diagBusy, setDiagBusy] = useState<'dns' | 'ai' | null>(null)
  const isDesk = !!(window as any).AnTunDesktop?.isDesktop
  /**
   * WARP 协议是否参与建链。订阅模式「节点出口」且未开启「经 WARP 承载」时，
   * 隧道完全由订阅节点自己的协议（如 VLESS）承担，render_config 里那条 WARP
   * 出站不会被任何组引用，协议项选了也不生效 —— 与首页协议下拉框同一判定。
   */
  const warpInPlay = !(s.connMode === 'subscription' && s.subExit === 'node' && !s.subViaWarp)
  const subNode = store.subNodes.find((n) => n.id === s.frontNodeId)

  const loadCoreStatus = async () => {
    const desk = (window as any).AnTunDesktop
    if (!isDesk || !desk?.coreUpdateStatus) return
    try {
      setCoreStatus(await desk.coreUpdateStatus())
    } catch {
      // 状态查询失败时保留上一次结果，不打断其他设置操作
    }
  }

  useEffect(() => {
    if (!isDesk) return
    const desk = (window as any).AnTunDesktop
    void loadCoreStatus()
    desk.psiphonRegions?.().then((list: RegionOption[]) => setRegions(list)).catch(() => setRegions([]))
    desk.loadCredential?.().then((c: any) => setHasCred(!!c)).catch(() => setHasCred(true))
    desk.credentialInfo?.().then(setCredInfo).catch(() => setCredInfo(null))
    // 开机自启以系统实际状态为准，避免界面与注册表不一致
    desk.getAutoStart?.().then((v: boolean) => {
      if (v !== useStore.getState().settings.autoStart) store.setSetting('autoStart', v)
    }).catch(() => {})
  }, [isDesk])

  const setAutoStart = async (enabled: boolean) => {
    store.setSetting('autoStart', enabled)
    if (!isDesk) return
    try {
      const ok = await (window as any).AnTunDesktop.setAutoStart?.(enabled)
      if (ok === false) store.setSetting('autoStart', !enabled)
    } catch {
      store.setSetting('autoStart', !enabled)
    }
  }

  const importWarp = async () => {
    try {
      const cred = parseWarpCredential(warpText)
      if (isDesk) {
        await (window as any).AnTunDesktop.saveCredential(cred)
        setHasCred(true)
        void (window as any).AnTunDesktop.credentialInfo?.().then(setCredInfo).catch(() => {})
      }
      setWarpMsg({ ok: true, text: isDesk ? t('accountSaved') : t('accountWebOnly') })
      store.log('INFO', 'warp credential imported')
    } catch (e: any) {
      setWarpMsg({ ok: false, text: `${t('accountInvalid')}: ${e.message}` })
    }
  }

  /**
   * 切换 Psiphon 出口：出口是在连接时写进核心配置的，已连接时必须断开重连才生效
   * （与首页同一个判定，订阅模式下不可用——订阅节点自己出站）
   */
  const togglePsiphon = async (v: boolean) => {
    if (psiphonBusy || s.connMode === 'subscription') return
    store.setSetting('psiphon', v)
    store.log('INFO', `psiphon -> ${v ? 'on' : 'off'}`)
    // 连接中也允许切：先取消当前链路并等它收尾，再按新出口重连（与首页开关同一行为）
    const conn = store.conn
    if (!conn.connected && !conn.connecting) return
    setPsiphonBusy(true)
    try {
      if (conn.connecting) {
        await cancel()
        await waitForConnectIdle()
      } else {
        await disconnect()
      }
      await connect()
    } finally {
      setPsiphonBusy(false)
    }
  }

  const changeRegion = async (code: string) => {
    store.setSetting('psiphonRegion', code)
    setRegionMsg(null)
    const desk = (window as any).AnTunDesktop
    if (!isDesk || !desk?.setPsiphonRegion) return
    try {
      await desk.setPsiphonRegion(code)
      // 地区同样是在连接时写进核心配置的，已连接时提示需要重连才生效
      const live = store.conn.connected
      setRegionMsg({ ok: true, text: t(live ? 'regionSavedNeedReconnect' : 'regionSaved') })
      store.log('INFO', `psiphon egress region -> ${code || 'auto'}`)
    } catch (e: any) {
      setRegionMsg({ ok: false, text: t('regionSaveFail', { msg: e?.message || String(e) }) })
    }
  }

  const runDiag = async (kind: 'dns' | 'ai') => {
    const desk = (window as any).AnTunDesktop
    if (!desk?.netDiagnose) return
    setDiagBusy(kind)
    setDiag(null)
    try {
      const report = await desk.netDiagnose(store.settings.mixedPort, kind) as DiagReport
      setDiag(report)
      store.log(report.ok ? 'INFO' : 'WARN', `diagnose ${kind}: ${report.summary}`)
    } catch (e: any) {
      setDiag({ ok: false, kind, summary: t('diagFail', { msg: e?.message || String(e) }), exitIp: '', exitCountry: '', resolverIp: '', resolverGeo: '', leak: false, items: [] })
    } finally {
      setDiagBusy(null)
    }
  }

  const updateCore = async (kind: 'mihomo' | 'psiphon') => {
    const desk = (window as any).AnTunDesktop
    if (!desk?.coreUpdate) return
    setCoreBusy(kind)
    setCoreMsg(null)
    try {
      const result = await desk.coreUpdate(kind)
      setCoreMsg({ ok: true, text: t('coreUpdateOk', { v: result.version }) })
      store.log('INFO', `core update ${kind} -> ${result.version}`)
    } catch (e: any) {
      const message = e?.message || String(e)
      setCoreMsg({ ok: false, text: t('coreUpdateFail', { msg: message }) })
      store.log('ERROR', `core update ${kind} failed: ${message}`)
    } finally {
      setCoreBusy(null)
      await loadCoreStatus()
    }
  }

  const regionChainDisabled = s.connMode === 'subscription'
  const regionOptions = regions.some((r) => r.code === s.psiphonRegion)
    ? regions
    : [{ code: s.psiphonRegion, nameZh: s.psiphonRegion || t('regionAuto'), nameEn: s.psiphonRegion || 'Automatic', live: false }, ...regions]

  const num = (k: 'mixedPort' | 'apiPort' | 'mtu' | 'timeoutSec', v: string) => {
    const n = Number(v)
    if (!Number.isNaN(n) && n >= 0 && n <= 65535) store.setSetting(k, n)
  }

  return (
    <div className="page-wrap fade-in stack">
      {/* WARP 账户 */}
      <Card title={<><KeyRound size={16} />{t('cardAccount')}</>}>
        <div className="muted" style={{ fontSize: 12, lineHeight: 1.6, marginBottom: 12 }}>{t('cardAccountDesc')}</div>
        <FieldRow title={t('accountStatus')} control={
          <span className={`badge ${hasCred ? 'badge-green' : 'badge-orange'}`}>
            {hasCred ? <><Check size={12} />{t('accountReady')}</> : <><AlertCircle size={12} />{t('accountMissing')}</>}
          </span>
        } />
        <FieldRow
          title={t('credIdentity')}
          desc={credInfo ? `${credInfo.endpoint} · ${credInfo.addressV4}` : undefined}
          control={
            credInfo?.unique ? (
              <span className="badge badge-green"><ShieldCheck size={12} />{t('credUnique')}</span>
            ) : (
              <span className="badge badge-orange"><AlertCircle size={12} />{t('credShared')}</span>
            )
          }
        />
        <div style={{ marginTop: 10 }}>
          <textarea
            className="input"
            value={warpText}
            onChange={(e) => setWarpText(e.target.value)}
            placeholder={t('warpKeyPlaceholder')}
            rows={5}
            style={{ width: '100%', fontFamily: 'monospace', fontSize: 11, resize: 'vertical' }}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 10 }}>
            <button className="btn btn-primary" onClick={importWarp} disabled={!warpText.trim()}>
              <KeyRound size={14} />{t('importAccount')}
            </button>
            {warpMsg && (
              <span style={{ fontSize: 12, color: warpMsg.ok ? 'var(--success)' : 'var(--danger)' }}>
                {warpMsg.text}
              </span>
            )}
          </div>
        </div>
      </Card>

      {/* 内核更新 */}
      <Card title={<><Download size={16} />{t('cardCoreUpdate')}</>}>
        <div className="muted" style={{ fontSize: 12, lineHeight: 1.6, marginBottom: 12 }}>
          {isDesk ? t('cardCoreUpdateDesc') : t('coreUpdateDesktopOnly')}
        </div>
        {(['mihomo', 'psiphon'] as const).map((kind) => {
          const component: CoreComponentStatus | undefined = coreStatus?.[kind]
          const updated = component?.updatedAt
            ? `${t('coreUpdatedAt')}: ${new Date(component.updatedAt * 1000).toLocaleString()}`
            : ''
          const source = component ? (component.source === 'updated' ? t('coreUpdated') : t('coreBundled')) : ''
          return (
            <FieldRow
              key={kind}
              title={kind === 'mihomo' ? t('coreMihomo') : t('corePsiphon')}
              desc={[source, updated].filter(Boolean).join(' · ')}
              control={
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                  <span className={`badge ${component?.installed ? 'badge-green' : 'badge-orange'}`}>
                    {component?.installed ? component.version : t('coreNotInstalled')}
                  </span>
                  <button
                    className="btn btn-outline btn-sm"
                    disabled={!isDesk || coreBusy !== null || store.conn.connected || store.conn.connecting}
                    onClick={() => updateCore(kind)}
                  >
                    <RefreshCw size={14} />{coreBusy === kind ? t('coreUpdating') : t('coreUpdateNow')}
                  </button>
                </div>
              }
            />
          )
        })}
        {coreMsg && (
          <div style={{ fontSize: 12, marginTop: 10, color: coreMsg.ok ? 'var(--success)' : 'var(--danger)' }}>
            {coreMsg.text}
          </div>
        )}
      </Card>

      {/* 捕获与端口 */}
      <Card title={<><Cpu size={16} />{t('cardCapture')}</>}>
        <FieldRow title={t('captureMode')} control={
          <Segment value={s.captureMode} onChange={(v) => store.setSetting('captureMode', v)}
            options={[{ value: 'proxy', label: t('captureProxy') }, { value: 'tun', label: t('captureTun') }]} />
        } />
        <FieldRow title={t('mixedPort')} control={
          <input className="input" type="number" value={s.mixedPort} onChange={(e) => num('mixedPort', e.target.value)} style={{ width: 100 }} />
        } />
        <FieldRow title={t('apiPort')} control={
          <input className="input" type="number" value={s.apiPort} onChange={(e) => num('apiPort', e.target.value)} style={{ width: 100 }} />
        } />
        <FieldRow title={t('allowLan')} desc={t('allowLanDesc')} control={
          <Toggle checked={s.allowLan} onChange={(v) => store.setSetting('allowLan', v)} />
        } />
        <FieldRow title={t('ipFamily')} control={
          <Segment value={s.ipFamily} onChange={(v) => store.setSetting('ipFamily', v)}
            options={[{ value: 'v4', label: 'IPv4' }, { value: 'v6', label: 'IPv6' }, { value: 'dual', label: 'Dual' }]} />
        } />
        <FieldRow title={t('mtu')} control={
          <input className="input" type="number" value={s.mtu} onChange={(e) => num('mtu', e.target.value)} style={{ width: 100 }} />
        } />
      </Card>

      {/* 路由与分流 */}
      <Card title={<><Route size={16} />{t('cardRouting')}</>}>
        <FieldRow title={t('proxyMode')} control={
          <Segment value={s.proxyMode} onChange={(v) => store.setSetting('proxyMode', v)}
            options={[
              { value: 'custom', label: t('proxyModeCustom') },
              { value: 'bypass-mainland', label: t('proxyModeBypass') },
              { value: 'global', label: t('proxyModeGlobal') },
            ]} />
        } />
        <FieldRow title={t('endpointRank')} control={
          <Segment value={s.endpointRank} onChange={(v) => store.setSetting('endpointRank', v)}
            options={[
              { value: 'ping', label: t('rankPing') },
              { value: 'loss', label: t('rankLoss') },
              { value: 'colo', label: t('rankColo') },
            ]} />
        } />
        <FieldRow title={t(warpInPlay ? 'protocol' : 'protocolLocked')} desc={warpInPlay ? undefined : t('protoNodeExitHint')} control={
          <ProtocolPicker
            value={s.proto}
            onChange={(p) => store.setSetting('proto', p)}
            disabled={!warpInPlay}
            valueText={subNode ? subNode.nodeType.toUpperCase() : undefined}
            lockLabel={t('subExitTag')}
          />
        } />
        <FieldRow title={t('rescan')} desc={t('rescanDesc')} control={
          <Toggle checked={s.rescan} onChange={(v) => store.setSetting('rescan', v)} />
        } />
      </Card>

      {/* 启动与行为 */}
      <Card title={<><Rocket size={16} />{t('cardStartup')}</>}>
        <FieldRow title={t('autostart')} desc={t('autostartDesc')} control={
          <Toggle checked={s.autoStart} onChange={setAutoStart} />
        } />
        <FieldRow title={t('autoConnect')} desc={t('autoConnectDesc')} control={
          <Toggle checked={s.autoConnect} onChange={(v) => store.setSetting('autoConnect', v)} />
        } />
        <FieldRow title={t('autoRepair')} desc={t('autoRepairDesc')} control={
          <Toggle checked={s.autoRepair} onChange={(v) => store.setSetting('autoRepair', v)} />
        } />
        <FieldRow title={t('rememberPage')} control={
          <Toggle checked={s.rememberPage} onChange={(v) => store.setSetting('rememberPage', v)} />
        } />
        <FieldRow title={t('timeout')} control={
          <input className="input" type="number" value={s.timeoutSec} onChange={(e) => num('timeoutSec', e.target.value)} style={{ width: 80 }} />
        } />
      </Card>

      {/* DNS 与出口 */}
      <Card title={<><Database size={16} />{t('cardDns')}</>}>
        <FieldRow title={t('dnsMode')} control={
          <Segment value={s.dnsMode} onChange={(v) => store.setSetting('dnsMode', v)}
            options={[
              { value: 'preset', label: t('dnsPreset') },
              { value: 'custom', label: t('dnsCustom') },
              { value: 'off', label: t('dnsOff') },
            ]} />
        } />
        {s.dnsMode === 'custom' && (
          <FieldRow title={t('dnsCustom')} control={
            <input className="input" value={s.dnsCustom} onChange={(e) => store.setSetting('dnsCustom', e.target.value)}
              placeholder="8.8.8.8, 1.1.1.1" style={{ width: 200 }} />
          } />
        )}
        <FieldRow title={t('dnsLeak')} desc={t('dnsLeakDesc')} control={
          <Toggle checked={s.dnsLeak} onChange={(v) => store.setSetting('dnsLeak', v)} />
        } />
        <FieldRow
          title={t('psiphon')}
          desc={
            s.connMode === 'subscription' ? t('psiphonSubOnly')
              : psiphonBusy ? t('psiphonSwitching')
                : store.conn.connected ? t('psiphonDescConnected')
                  : store.conn.connecting ? t('psiphonSwitchNow')
                    : t('psiphonDesc')
          }
          control={
            <Toggle
              checked={s.psiphon}
              disabled={s.connMode === 'subscription' || psiphonBusy}
              onChange={(v) => void togglePsiphon(v)}
            />
          }
        />
        {s.psiphon && (
          <>
            <FieldRow
              title={t('regionExit')}
              desc={regionChainDisabled ? t('regionChainDisabled') : undefined}
              control={
                <select
                  className="select"
                  disabled={regionChainDisabled}
                  value={s.psiphonRegion}
                  onChange={(e) => changeRegion(e.target.value.toUpperCase())}
                >
                  {regionOptions.map((r) => {
                    const name = s.lang === 'zh' ? r.nameZh : r.nameEn
                    return <option key={r.code || 'auto'} value={r.code}>{r.code ? `${name} · ${r.code}${r.live ? ' ●' : ''}` : name}</option>
                  })}
                </select>
              }
            />
            {regionMsg && (
              <div style={{ fontSize: 12, marginTop: 4, color: regionMsg.ok ? 'var(--success)' : 'var(--danger)' }}>
                {regionMsg.text}
              </div>
            )}
          </>
        )}
      </Card>

      {/* 网络诊断 */}
      <Card title={<><Activity size={16} />{t('diagTitle')}</>} sub={t('diagDesc')}>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <button
            className="btn btn-outline btn-sm"
            disabled={!isDesk || !store.conn.connected || diagBusy !== null}
            onClick={() => runDiag('dns')}
          >
            <ShieldCheck size={14} />{diagBusy === 'dns' ? t('diagRunning') : t('diagDns')}
          </button>
          <button
            className="btn btn-outline btn-sm"
            disabled={!isDesk || !store.conn.connected || diagBusy !== null}
            onClick={() => runDiag('ai')}
          >
            <Activity size={14} />{diagBusy === 'ai' ? t('diagRunning') : t('diagAi')}
          </button>
          {!store.conn.connected && (
            <span className="muted" style={{ fontSize: 12, alignSelf: 'center' }}>{t('diagNeedConn')}</span>
          )}
        </div>

        {diag && (
          <div style={{ marginTop: 14, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 12.5, lineHeight: 1.6, color: diag.ok ? 'var(--success)' : 'var(--danger)' }}>
              {diag.ok ? <Check size={15} style={{ flex: 'none', marginTop: 2 }} /> : <AlertCircle size={15} style={{ flex: 'none', marginTop: 2 }} />}
              <span>{diag.summary}</span>
            </div>
            {(diag.exitIp || diag.resolverIp) && (
              <div className="muted" style={{ fontSize: 11.5, marginTop: 8, display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                {diag.exitIp && <span>{t('diagExit')}: <span className="mono">{diag.exitIp}</span> {diag.exitCountry}</span>}
                {diag.resolverIp && <span>{t('diagResolver')}: <span className="mono">{diag.resolverIp}</span> {diag.resolverGeo}</span>}
              </div>
            )}
            {diag.items.length > 0 && (
              <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
                {diag.items.map((it) => (
                  <div key={it.name} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                    <span style={{
                      width: 7, height: 7, borderRadius: 99, flex: 'none',
                      background: it.ok ? 'var(--success)' : 'var(--danger)',
                    }} />
                    <span style={{ fontWeight: 600, minWidth: 96 }}>{it.name}</span>
                    <span className="muted" style={{ fontSize: 11.5 }}>{it.detail}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </Card>

      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button className="btn btn-outline" onClick={() => { store.resetSettings(); store.log('INFO', 'settings reset') }}>
          <RotateCcw size={15} />{t('reset')}
        </button>
      </div>
    </div>
  )
}
