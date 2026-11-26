import { useState } from 'react'
import { Layers, Link2, RefreshCw, Trash2, Check, AlertCircle, ArrowRight } from 'lucide-react'
import { useStore, newId } from '../store'
import { tr } from '../i18n'
import { Card, Segment, Toggle, FieldRow } from '../components/ui'
import type { Subscription } from '../types'

export function ModesPage() {
  const store = useStore()
  const { settings: s, subscriptions, subNodes } = store
  const t = (k: string, v?: Record<string, string | number>) => tr(k, s.lang, v)
  const [source, setSource] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

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

          <Card title={<><ArrowRight size={16} />{t('subscriptionNodes')}</>} sub={t('selectFrontNode')}>
            {subNodes.length ? subNodes.map((node) => {
              const selected = s.frontNodeId === node.id
              return (
                <div key={node.id} className={`node-row ${selected ? 'selected' : ''}`}
                  onClick={() => store.setSetting('frontNodeId', node.id)} tabIndex={0}
                  onKeyDown={(e) => { if (e.key === 'Enter') store.setSetting('frontNodeId', node.id) }}>
                  <span className="cell mono strong" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{node.name}</span>
                  <span className="cell">{node.nodeType.toUpperCase()}</span>
                  <span className="cell mono">{node.server}:{node.port}</span>
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
