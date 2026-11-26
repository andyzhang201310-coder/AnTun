import { useState, useEffect } from 'react'
import { Cpu, Route, Rocket, Database, RotateCcw, KeyRound, Check, AlertCircle, Download, RefreshCw } from 'lucide-react'
import { useStore } from '../store'
import { tr } from '../i18n'
import { Card, Toggle, FieldRow, Segment, ProtocolPicker } from '../components/ui'
import { parseWarpCredential } from '../engine/credential'
import type { CoreComponentStatus, CoreUpdateStatus } from '../desktop'

export function SettingsPage() {
  const store = useStore()
  const { settings: s } = store
  const t = (k: string, vars?: Record<string, string | number>) => tr(k, s.lang, vars)
  const [warpText, setWarpText] = useState('')
  const [warpMsg, setWarpMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [hasCred, setHasCred] = useState(false)
  const [coreStatus, setCoreStatus] = useState<CoreUpdateStatus | null>(null)
  const [coreBusy, setCoreBusy] = useState<'mihomo' | 'psiphon' | null>(null)
  const [coreMsg, setCoreMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const isDesk = !!(window as any).AnTunDesktop?.isDesktop

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
    desk.loadCredential?.().then((c: any) => setHasCred(!!c)).catch(() => setHasCred(true))
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
      }
      setWarpMsg({ ok: true, text: isDesk ? t('accountSaved') : t('accountWebOnly') })
      store.log('INFO', 'warp credential imported')
    } catch (e: any) {
      setWarpMsg({ ok: false, text: `${t('accountInvalid')}: ${e.message}` })
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
        <FieldRow title={t('protocol')} control={
          <ProtocolPicker value={s.proto} onChange={(p) => store.setSetting('proto', p)} />
        } />
        <FieldRow title={t('outerProto')} control={
          <ProtocolPicker value={s.outerProto} onChange={(p) => store.setSetting('outerProto', p)} />
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
        <FieldRow title={t('dnsLeak')} desc={t('dnsLeak')} control={
          <Toggle checked={s.dnsLeak} onChange={(v) => store.setSetting('dnsLeak', v)} />
        } />
        <FieldRow title={t('psiphon')} desc={t('psiphonDesc')} control={
          <Toggle checked={s.psiphon} onChange={(v) => store.setSetting('psiphon', v)} />
        } />
        {s.psiphon && (
          <FieldRow title={t('regionExit')} control={
            <select className="select" value={s.psiphonRegion} onChange={(e) => store.setSetting('psiphonRegion', e.target.value)}>
              <option value="">{t('autoSelect')}</option>
              {['US', 'DE', 'GB', 'JP', 'SG', 'CA', 'NL'].map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          } />
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
