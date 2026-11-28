import { useMemo, useRef, useState } from 'react'
import {
  Star, Trash2, Timer, Gauge, Search, ArrowRight, Download, Check, X, Loader,
} from 'lucide-react'
import { useStore } from '../store'
import { useEngine } from '../engine/useEngine'
import { tr } from '../i18n'
import { Card, formatRate } from '../components/ui'
import { Flag } from '../components/Flag'
import { codeFromNode, displayNodeName } from '../lib/region'
import { delayClass, speedClass } from '../lib/stat'
import type { SavedNode, SubNode, NodeStat, Settings } from '../types'

const desk = () => (window as any).AnTunDesktop as any

/** 收藏项转成测速后端认识的节点形状（nodeTestStart 吃的是 SubNode） */
function toSubNode(n: SavedNode): SubNode {
  return {
    id: n.id,
    subId: '__saved__',
    name: n.name,
    nodeType: n.nodeType,
    server: n.server,
    port: n.port,
    config: n.config,
  }
}

export function SavedPage() {
  const store = useStore()
  const { settings, savedNodes, subNodes, conn } = store
  const { connect, disconnect } = useEngine()
  const t = (k: string, vars?: Record<string, string | number>) => tr(k, settings.lang, vars)
  // 搜索词放在 store 里：页面是条件渲染的，切页就会被卸载，组件内 state 会丢
  const query = store.savedQuery
  const setQuery = (v: string) => store.setSavedQuery(v)
  // 排序同样不能放组件 state：切页回来会重置成默认顺序
  const sortKey = settings.savedSort
  const setSortKey = (v: Settings['savedSort']) => store.setSetting('savedSort', v)

  const [testing, setTesting] = useState(false)
  const [progress, setProgress] = useState({ done: 0, total: 0 })
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [sel, setSel] = useState<string[]>([])
  const [importOpen, setImportOpen] = useState(false)
  const [importSel, setImportSel] = useState<string[]>([])
  const abortRef = useRef(false)

  const list = useMemo(() => {
    const q = query.trim().toLowerCase()
    const base = [...savedNodes].sort((a, b) => b.savedAt - a.savedAt)
    const filtered = !q ? base : base.filter((n) =>
      n.name.toLowerCase().includes(q)
      || n.server.toLowerCase().includes(q)
      || (n.note || '').toLowerCase().includes(q))
    if (sortKey === 'default') return filtered
    // 延迟排序：没测过的（delay<=0）永远沉到末尾，否则它们会被当成 0ms 排到最前
    const dir = sortKey === 'delay-asc' ? 1 : -1
    return filtered.sort((a, b) => {
      const x = a.delay && a.delay > 0 ? a.delay : 0
      const y = b.delay && b.delay > 0 ? b.delay : 0
      if (!x && !y) return b.savedAt - a.savedAt
      if (!x) return 1
      if (!y) return -1
      return dir * (x - y)
    })
  }, [savedNodes, query, sortKey])

  /** 订阅里还没收藏的节点，用于「从订阅导入」 */
  const importable = useMemo(() => {
    const saved = new Set(savedNodes.map((n) => n.config))
    return subNodes.filter((n) => n.config && !saved.has(n.config))
  }, [subNodes, savedNodes])

  const toggle = (id: string) => setSel((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id])
  const allSelected = list.length > 0 && list.every((n) => sel.includes(n.id))

  /** 测延迟 / 测速：ids 为空表示对当前筛选结果全测 */
  const runTest = async (ids: string[] | null, withSpeed: boolean) => {
    const d = desk()
    if (!d?.isDesktop) {
      setMsg({ ok: false, text: t('savedNeedDesktop') })
      return
    }
    if (testing) return
    const pool = ids ? savedNodes.filter((n) => ids.includes(n.id)) : list
    if (!pool.length) return
    abortRef.current = false
    setTesting(true)
    setMsg(null)
    setProgress({ done: 0, total: pool.length })
    try {
      await d.nodeTestStart(pool.map(toSubNode))
      const delays: NodeStat[] = await d.nodeTestDelay()
      store.updateSavedStats(delays || [])
      setProgress({ done: (delays || []).length, total: pool.length })
      if (withSpeed && !abortRef.current) {
        const reachable = (delays || []).filter((x) => x.delay > 0).map((x) => x.id)
        const targets = reachable.length ? reachable : pool.map((x) => x.id)
        // 3 路一批，避免互相抢带宽导致数值偏低
        for (let i = 0; i < targets.length; i += 3) {
          if (abortRef.current) break
          const part = targets.slice(i, i + 3)
          const res: NodeStat[] = await d.nodeTestSpeed(part, 6, part.length)
          store.updateSavedStats(res || [])
          setProgress({ done: Math.min((delays || []).length + i + part.length, pool.length), total: pool.length })
        }
      }
      const ok = (delays || []).filter((x) => x.delay > 0).length
      store.log('INFO', `saved node test: ${ok}/${pool.length} reachable`)
      setMsg({ ok: true, text: abortRef.current ? t('testStop') : t('nodeTestDone') })
    } catch (e: any) {
      const text = e?.message || String(e)
      setMsg({ ok: false, text: `${t('nodeTestFailed')}: ${text}` })
      store.log('ERROR', `saved node test failed: ${text}`)
    } finally {
      try { await d.nodeTestStop() } catch { /* 核心可能已退出 */ }
      setTesting(false)
      setProgress({ done: 0, total: 0 })
    }
  }

  const stopTest = () => {
    abortRef.current = true
    try { void desk()?.nodeTestStop?.() } catch { /* ignore */ }
  }

  const useNode = async (n: SavedNode) => {
    store.setSetting('connMode', 'subscription')
    store.setSetting('frontNodeId', n.id)
    setMsg({ ok: true, text: t('savedUsed', { name: displayNodeName(n.name) }) })
    store.log('INFO', `saved node selected: ${n.name}`)
    // 已连接时立刻切过去，和首页切换节点的行为保持一致
    if (conn.connected) {
      try {
        await disconnect()
        await connect()
      } catch (e: any) {
        setMsg({ ok: false, text: `${t('connectFailed')}: ${e?.message || e}` })
      }
    }
  }

  const removeOne = (n: SavedNode) => {
    store.removeSaved([n.id])
    setSel((prev) => prev.filter((x) => x !== n.id))
    store.log('INFO', `saved node removed: ${n.name}`)
  }

  const removeSelected = () => {
    if (!sel.length) return
    if (!window.confirm(t('savedConfirmDel', { n: sel.length }))) return
    store.removeSaved(sel)
    store.log('INFO', `saved nodes removed: ${sel.length}`)
    setSel([])
  }

  const addFromSubscription = () => {
    const picked = importable.filter((n) => importSel.includes(n.id))
    const added = store.saveNodes(picked, t('savedFromSub'))
    setMsg({ ok: true, text: t('savedAdded', { n: added }) })
    setImportSel([])
    if (!importable.length) setImportOpen(false)
  }

  const pct = progress.total ? Math.round((progress.done / progress.total) * 100) : 0

  return (
    <div className="page-wrap fade-in stack">
      <Card
        title={t('savedTitle')}
        sub={t('savedCount', { n: savedNodes.length })}
        icon={<Star size={17} />}
      >
        <div className="saved-toolbar">
          <div className="saved-search">
            <Search size={14} className="muted" />
            <input
              className="input"
              value={query}
              placeholder={t('savedSearch')}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          {testing ? (
            <button className="btn btn-ghost btn-sm" onClick={stopTest}><X size={14} />{t('testStop')}</button>
          ) : (
            <>
              <button className="btn btn-ghost btn-sm" onClick={() => void runTest(null, false)} disabled={!list.length}>
                <Timer size={14} />{t('savedAllDelay')}
              </button>
              <button className="btn btn-ghost btn-sm" onClick={() => void runTest(null, true)} disabled={!list.length}>
                <Gauge size={14} />{t('savedAllSpeed')}
              </button>
            </>
          )}
          <button className="btn btn-ghost btn-sm" onClick={() => setImportOpen((v) => !v)}>
            <Download size={14} />{t('savedImport')}
          </button>
          <select
            className="select"
            value={sortKey}
            onChange={(e) => setSortKey(e.target.value as Settings['savedSort'])}
            title={t('sortBy')}
            style={{ width: 148, flex: 'none' }}
          >
            <option value="default">{t('savedSortDefault')}</option>
            <option value="delay-asc">{t('savedSortDelayAsc')}</option>
            <option value="delay-desc">{t('savedSortDelayDesc')}</option>
          </select>
          {sel.length > 0 && (
            <button className="btn btn-ghost btn-sm saved-del" onClick={removeSelected}>
              <Trash2 size={14} />{t('savedDeleteSel')}（{sel.length}）
            </button>
          )}
        </div>

        {testing && (
          <>
            <div className="test-progress"><i style={{ width: `${pct}%` }} /></div>
            <div className="muted" style={{ fontSize: 11.5, marginBottom: 8 }}>
              {progress.done}/{progress.total} · {pct}%
            </div>
          </>
        )}
        {msg && (
          <div className={`test-msg ${msg.ok ? 'ok' : 'bad'}`}>
            {msg.ok ? <Check size={13} /> : <X size={13} />}{msg.text}
          </div>
        )}

        {importOpen && (
          <div className="saved-import">
            <div className="saved-import-head">
              <span className="strong" style={{ fontSize: 13 }}>{t('savedImportTitle')}</span>
              <span className="muted" style={{ fontSize: 11.5 }}>{importable.length}</span>
              <button className="btn btn-ghost btn-sm" style={{ marginLeft: 'auto' }} onClick={() => setImportOpen(false)}>
                <X size={13} />
              </button>
            </div>
            {importable.length === 0 ? (
              <div className="muted" style={{ fontSize: 12, padding: '10px 2px' }}>{t('savedImportNone')}</div>
            ) : (
              <>
                <div className="saved-import-list">
                  {importable.map((n) => {
                    const on = importSel.includes(n.id)
                    return (
                      <button
                        key={n.id}
                        className={`saved-import-item ${on ? 'on' : ''}`}
                        onClick={() => setImportSel((prev) => on ? prev.filter((x) => x !== n.id) : [...prev, n.id])}
                      >
                        <span className={`saved-check ${on ? 'on' : ''}`}>{on && <Check size={10} />}</span>
                        <Flag code={codeFromNode(n.name, n.server)} lang={settings.lang} size={14} />
                        <span className="mono ellipsis">{displayNodeName(n.name)}</span>
                        <span className="muted" style={{ fontSize: 11 }}>{n.nodeType.toUpperCase()}</span>
                      </button>
                    )
                  })}
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => setImportSel(importSel.length === importable.length ? [] : importable.map((n) => n.id))}
                  >
                    {t('savedSelectAll')}
                  </button>
                  <button className="btn btn-primary btn-sm" onClick={addFromSubscription} disabled={!importSel.length}>
                    <Star size={13} />{t('savedAdd')}（{importSel.length}）
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {savedNodes.length === 0 ? (
          <div className="saved-empty">
            <Star size={26} className="muted" />
            <div style={{ fontSize: 12.5, lineHeight: 1.7 }}>{t('savedEmpty')}</div>
          </div>
        ) : list.length === 0 ? (
          <div className="saved-empty"><div style={{ fontSize: 12.5 }}>{t('savedNoMatch')}</div></div>
        ) : (
          <>
            <div className="saved-head">
              <button
                className={`saved-check ${allSelected ? 'on' : ''}`}
                title={t('savedSelectAll')}
                onClick={() => setSel(allSelected ? [] : list.map((n) => n.id))}
              >
                {allSelected && <Check size={10} />}
              </button>
              <span className="cell muted">节点</span>
              <span className="cell muted">协议</span>
              <span className="cell muted">地址</span>
              <span className="cell muted">延迟</span>
              <span className="cell muted">速度</span>
              <span />
            </div>
            <div className="saved-body">
              {list.map((n) => {
                const on = sel.includes(n.id)
                const busy = testing
                return (
                  <div key={n.id} className={`saved-row ${on ? 'selected' : ''}`}>
                    <button className={`saved-check ${on ? 'on' : ''}`} onClick={() => toggle(n.id)}>
                      {on && <Check size={10} />}
                    </button>
                    <span className="cell mono strong with-flag" title={n.name}>
                      <Flag code={codeFromNode(n.name, n.server)} lang={settings.lang} size={14} />
                      <span>{displayNodeName(n.name)}</span>
                    </span>
                    <span className="cell muted">{n.nodeType.toUpperCase()}</span>
                    <span className="cell mono muted" title={`${n.server}:${n.port}`}>{n.server}:{n.port}</span>
                    <span className={`cell mono node-stat ${delayClass(n.delay || 0)}`}>
                      {n.delay && n.delay > 0 ? `${n.delay} ms` : '—'}
                    </span>
                    <span className={`cell mono node-stat ${speedClass(n.speed || 0)}`}>
                      {n.speed && n.speed > 0 ? formatRate(n.speed) : '—'}
                    </span>
                    <span className="saved-actions">
                      <button className="icon-btn" title={t('savedTestDelay')} disabled={busy} onClick={() => void runTest([n.id], false)}>
                        <Timer size={14} />
                      </button>
                      <button className="icon-btn" title={t('savedTestSpeed')} disabled={busy} onClick={() => void runTest([n.id], true)}>
                        <Gauge size={14} />
                      </button>
                      <button className="icon-btn" title={t('savedUse')} onClick={() => void useNode(n)}>
                        <ArrowRight size={14} />
                      </button>
                      <button className="icon-btn danger" title={t('savedDeleteOne')} onClick={() => removeOne(n)}>
                        <Trash2 size={14} />
                      </button>
                    </span>
                  </div>
                )
              })}
            </div>
          </>
        )}
      </Card>

      {testing && (
        <div className="muted" style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 6 }}>
          <Loader size={12} className="spin" />{t('savedSub')}
        </div>
      )}
    </div>
  )
}
