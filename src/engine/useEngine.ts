import { useCallback, useEffect } from 'react'
import { useStore, useLive, flushPersist } from '../store'
import { createAdapter } from './adapters'
import { initDesktopBridge } from '../desktop'
import type { EngineAdapter, ConnectOptions, ConnState, Endpoint, Settings, NodeStat } from '../types'
import { tr } from '../i18n'

// ============ 全局单例引擎 ============
// 适配器与连接动作放在模块级：任何页面发起的连接、健康检查、断线重连
// 都操作同一个适配器实例，避免多个 useEngine 实例各自持有一份状态而互相打架。
let engineAdapter: EngineAdapter | null = null

// 连接流程的互斥与取消：
// 取消后 UI 会立刻回到「未连接」，但 Rust 侧那条连接还要几百毫秒才收尾。
// 若此时允许再点一次，就会出现两个 core_connect 并发抢同一个核心与 Psiphon。
// 所以用模块级的 in-flight 标记挡住重入，等真正的 Promise 结束才放开。
let connectInFlight = false
let cancelRequested = false

function ensureAdapter(): EngineAdapter {
  const s = useStore.getState()
  if (!engineAdapter) {
    // 桌面壳里平台一定是 windows；浏览器预览保持原判断
    const platform = s.platform === 'web' ? 'windows' : s.platform
    engineAdapter = createAdapter(platform, s.settings.apiPort, s.settings.mixedPort)
    s.log('INFO', `${tr('diagPlatform', s.settings.lang)}: ${platform} · ${engineAdapter.name}`)
  }
  return engineAdapter
}

// ============ 隧道失效处理（全局单例） ============
// 之前每个 useEngine 实例各绑一份监听，页面切换后监听被回收，
// 而适配器里的健康检查定时器还在跑，失效事件无人处理。
// 现在只在模块级绑定一次，多个实例共享，且离开首页后仍能自动重连。
const repairLog: number[] = []

const CLEARED_CONN: Partial<ConnState> = {
  connected: false, connecting: false, startedAt: null,
  exitIp: '', country: '', colo: '', city: '', latency: 0,
  up: 0, down: 0, upRate: 0, downRate: 0, session: '',
}

async function engineDisconnect(): Promise<void> {
  const s = useStore.getState()
  s.log('INFO', 'disconnect -> restore proxy snapshot')
  const adapter = engineAdapter
  if (adapter) {
    try { await adapter.disconnect() } catch { /* 核心可能已退出 */ }
  }
  useStore.getState().setConn(CLEARED_CONN)
  useLive.getState().resetLive()
  ;(window as any)._antunSyncTray?.()
  s.log('INFO', 'disconnected')
  s.addHistory('disconnected')
}

/**
 * 按设置里的排序偏好排列候选端点。
 * WARP 端点是 anycast，"colo 优先"没有意义，退化为按地址排序便于人工核对。
 */
function rankEndpoints(list: Endpoint[], rank: Settings['endpointRank']): Endpoint[] {
  const arr = [...list]
  if (rank === 'loss') {
    return arr.sort((a, b) => a.loss - b.loss || (a.latency || Number.MAX_SAFE_INTEGER) - (b.latency || Number.MAX_SAFE_INTEGER))
  }
  if (rank === 'colo') return arr.sort((a, b) => a.host.localeCompare(b.host))
  return arr.sort((a, b) => (a.latency || Number.MAX_SAFE_INTEGER) - (b.latency || Number.MAX_SAFE_INTEGER))
}

/**
 * 自动择优候选：优先用「实测可用」的端点（latency>0 且无丢包），
 * 取排名前 3 个依次尝试；一个都没测过时退回全部列表（连接时仍会带默认端点）。
 */
function autoCandidates(list: Endpoint[], rank: Settings['endpointRank']): Endpoint[] {
  const tested = list.filter((e) => e.latency > 0 && e.loss === 0)
  const pool = tested.length ? tested : list
  return rankEndpoints(pool, rank).slice(0, 3)
}

async function engineConnect(optsOverride?: Partial<ConnectOptions>): Promise<boolean> {
  const s = useStore.getState()
  if (connectInFlight) {
    // 上一次连接刚被取消、Rust 还在收尾：明确告诉用户而不是静默无反应
    s.log('WARN', 'connect ignored: 上一次连接仍在收尾，请稍候再试')
    return false
  }
  if (s.conn.connected) return false
  connectInFlight = true
  cancelRequested = false
  s.setCancelling(false)
  s.setConn({ connecting: true, session: '' })
  s.log('INFO', `connect -> protocol=${s.settings.proto}`)
  s.addHistory(`connect ${s.settings.proto}`)
  try {
    const adapter = ensureAdapter()
    const pinned = s.endpoints.find((e) => e.id === s.pinnedId) || null
    // 收藏节点也能作为前置：订阅刷新后 subNodes 会整体替换，收藏项必须独立兜底
    const frontNode = s.settings.connMode === 'subscription'
      ? (s.subNodes.find((n) => n.id === s.settings.frontNodeId)
        ?? s.savedNodes.find((n) => n.id === s.settings.frontNodeId))
      : undefined
    if (s.settings.connMode === 'subscription' && !frontNode) {
      throw new Error('订阅模式尚未选择前置节点：请到「模式」页导入订阅并选一个节点')
    }
    // 锁定端点只试一个；自动择优按实测排名试前 3 个（失败自动换下一个）
    const plan: (Endpoint | null)[] = pinned
      ? [pinned]
      : (() => {
        const list = autoCandidates(s.endpoints, s.settings.endpointRank)
        return list.length ? list : [null]
      })()
    s.addHistory('render config -> start core')
    s.addHistory('probe endpoint -> verify exit')

    let lastErr = '连接失败'
    for (let i = 0; i < plan.length; i++) {
      // 已取消：不要换下一个端点继续试（那会重新起一次完整连接）
      if (cancelRequested) break
      const ep = plan[i]
      // 前几次给较短超时，保证失败能快速换端点；最后一次用用户设置的完整超时
      const timeoutSec = i === plan.length - 1 ? s.settings.timeoutSec : Math.min(15, s.settings.timeoutSec)
      const opts: ConnectOptions = {
        protocol: s.settings.proto,
        endpoint: ep,
        frontConfig: frontNode?.config,
        frontType: frontNode?.nodeType,
        captureMode: s.settings.captureMode,
        psiphon: s.settings.psiphon && s.settings.connMode === 'warp',
        settings: { ...s.settings, timeoutSec },
        ...optsOverride,
      }
      try {
        const state = await adapter.connect(opts)
        useStore.getState().setConn({ ...state, connecting: false, upRate: 0, downRate: 0 })
        // 记下「这个端点实际落到了哪个机房」：anycast 出口无法指定，
        // 唯一能手动干预的办法就是换端点，所以要把实测结果沉淀下来。
        if (state.endpoint && (state.country || state.colo)) {
          useStore.getState().recordColo({
            id: `${state.endpoint.host}:${state.endpoint.port}`,
            host: state.endpoint.host,
            port: state.endpoint.port,
            country: state.country,
            colo: state.colo,
            city: state.city,
          })
        }
        useLive.getState().resetLive()
        ;(window as any)._antunSyncTray?.()
        adapter.probe((p) => useLive.getState().pushLatency(p))
        if (ep) {
          s.log('INFO', `${pinned ? 'pinned' : 'auto select'} endpoint -> ${ep.host}:${ep.port}${ep.latency ? ` (${ep.latency}ms)` : ''}`)
        }
        s.log('INFO', `connected: exit=${state.exitIp} colo=${state.colo} ${state.latency}ms`)
        s.addHistory(`connected ${state.session}`)
        return true
      } catch (e: any) {
        lastErr = e.message
        // 取消引起的 reject 不算「这个端点失败」，不要刷成 WARN 让用户以为节点有问题
        if (cancelRequested) break
        s.log('WARN', `endpoint ${ep ? `${ep.host}:${ep.port}` : 'default'} failed: ${e.message}`)
        if (i < plan.length - 1) {
          s.addHistory(`switch endpoint: ${ep?.host ?? '—'} -> ${plan[i + 1]?.host ?? '—'}`, false)
        }
      }
    }
    throw new Error(lastErr)
  } catch (e: any) {
    const wasCancelled = cancelRequested
    useStore.getState().setConn({ connecting: false, connected: false })
    useLive.getState().resetLive()
    ;(window as any)._antunSyncTray?.()
    if (wasCancelled) {
      s.log('INFO', 'connect cancelled by user')
      s.addHistory('connect cancelled', false)
    } else {
      s.log('ERROR', `connect failed: ${e.message}`)
      s.addHistory(`connect failed: ${e.message}`, false)
    }
    return false
  } finally {
    connectInFlight = false
    cancelRequested = false
    useStore.getState().setCancelling(false)
  }
}

/**
 * 取消正在进行的连接。
 *
 * 只置标记是不够的：Rust 侧可能正卡在「等 Psiphon 隧道」或「出口探测」里，
 * 所以要它把 Psiphon 进程和核心一起掐掉，那条链路才会在几百毫秒内退出来。
 * 真正的状态复位由 engineConnect 的 catch/finally 完成，这里只负责「已受理」。
 */
async function engineCancel(): Promise<void> {
  const s = useStore.getState()
  if (!connectInFlight || cancelRequested) return
  cancelRequested = true
  s.setCancelling(true)
  s.log('INFO', 'cancel connect -> 用户取消')
  s.addHistory('cancel connect', false)
  try {
    await engineAdapter?.cancel?.()
  } catch (e: any) {
    s.log('WARN', `cancel failed: ${e.message}`)
  }
}

async function handleTunnelLost(detail: string) {  const s = useStore.getState()
  s.log('WARN', `tunnel lost: ${detail}`)
  s.addHistory('tunnel lost', false)
  s.setConn(CLEARED_CONN)
  useLive.getState().resetLive()
  ;(window as any)._antunSyncTray?.()

  if (!s.settings.autoRepair) {
    s.log('WARN', 'auto repair disabled, stay disconnected')
    return
  }
  // 10 分钟内最多自动重连 3 次，避免节点本身不可用时无限重试
  const now = Date.now()
  const recent = repairLog.filter((t) => now - t < 10 * 60_000)
  repairLog.length = 0
  repairLog.push(...recent)
  if (recent.length >= 3) {
    s.log('ERROR', 'auto repair: 10 分钟内已重连 3 次，停止自动修复')
    return
  }
  repairLog.push(now)
  s.log('INFO', 'auto repair: 隧道失效，按当前节点自动重连')
  s.addHistory('auto repair: reconnect')
  // 先确保核心与系统代理被清理，再按当前设置重连
  await engineDisconnect()
  const ok = await engineConnect()
  if (!ok) useStore.getState().log('ERROR', 'auto repair failed')
}

function bindTunnelWatcher() {
  if (typeof window === 'undefined') return
  if ((window as any).__antunTunnelWatcher) return
  ;(window as any).__antunTunnelWatcher = true
  window.addEventListener('antun-tunnel-lost', (e) => {
    const detail = (e as CustomEvent).detail || '隧道探测失败'
    void handleTunnelLost(String(detail))
  })
  // 凭证事件：首次启动注册独享身份 / 连接时因凭证失效回退内置凭证
  window.addEventListener('antun-credential', (e) => {
    const d = ((e as CustomEvent).detail || {}) as { kind?: string; ok?: boolean; source?: string; error?: string }
    const s = useStore.getState()
    if (d.kind === 'fallback') {
      s.log('WARN', `credential fallback: 当前凭证不可用，已回退内置共享凭证（${d.error || '未知原因'}）`)
      s.addHistory('credential fallback -> builtin')
    } else if (d.kind === 'registered') {
      if (d.ok) s.log('INFO', `credential: 已为本机注册独享 WARP 身份（${d.source || 'auto'}）`)
      else s.log('WARN', `credential: 独享身份注册失败，继续使用内置凭证（${d.error || '未知原因'}）`)
    }
  })
}

// 模块加载即注册：即使从「设置」页启动（首页未挂载）也能自动重连
bindTunnelWatcher()

// ============ 实时速率（全局单例） ============
// 原来这段在 useEngine 内部：每个页面挂载都起一份 1s 定时器，
// 连接后每个页面都在轮询核心 /traffic 并 setState（还会触发持久化写盘），
// 切菜单时主线程被占住，表现为明显卡顿。
// 现在模块级只跑一份，结果写进独立的 useLive store，其他页面不订阅就不重渲染。
const trafficRef = { up: 0, down: 0, t: Date.now(), initialized: false }
const rateRef = { up: 0, down: 0 }
let trafficBusy = false
let trafficTimer: number | null = null

function resetTraffic() {
  trafficRef.up = 0
  trafficRef.down = 0
  trafficRef.t = Date.now()
  trafficRef.initialized = false
  rateRef.up = 0
  rateRef.down = 0
  useLive.getState().resetLive()
}

async function pollTraffic() {
  if (trafficBusy) return
  const s = useStore.getState()
  if (!s.conn.connected) return
  trafficBusy = true
  const now = Date.now()
  try {
    const adapter = engineAdapter
    let up = trafficRef.up
    let down = trafficRef.down
    let directUpRate: number | undefined
    let directDownRate: number | undefined
    if (adapter?.traffic) {
      const r = await adapter.traffic()
      up = r.up
      down = r.down
      if (typeof r.upRate === 'number' && typeof r.downRate === 'number') {
        directUpRate = r.upRate
        directDownRate = r.downRate
      }
    } else {
      // 纯前端演示环境保留轻量模拟，仅用于界面预览
      up += Math.floor(Math.random() * 9000)
      down += Math.floor(Math.random() * 60000)
    }
    const prev = trafficRef
    let smoothUp = rateRef.up
    let smoothDown = rateRef.down
    if (directUpRate !== undefined && directDownRate !== undefined) {
      // mihomo /traffic 直接给出每秒速率，这里只做轻微平滑
      smoothUp = smoothUp * 0.35 + directUpRate * 0.65
      smoothDown = smoothDown * 0.35 + directDownRate * 0.65
    } else if (!prev.initialized) {
      trafficRef.up = up
      trafficRef.down = down
      trafficRef.t = now
      trafficRef.initialized = true
      rateRef.up = 0
      rateRef.down = 0
      useLive.getState().setTraffic({ up, down, upRate: 0, downRate: 0 })
      return
    } else {
      const elapsed = Math.min(5, Math.max(0.5, (now - prev.t) / 1000))
      const instantUp = Math.max(0, up - prev.up) / elapsed
      const instantDown = Math.max(0, down - prev.down) / elapsed
      smoothUp = smoothUp * 0.5 + instantUp * 0.5
      smoothDown = smoothDown * 0.5 + instantDown * 0.5
    }
    rateRef.up = smoothUp
    rateRef.down = smoothDown
    trafficRef.up = up
    trafficRef.down = down
    trafficRef.t = now
    trafficRef.initialized = true
    useLive.getState().setTraffic({
      up, down,
      upRate: Math.round(smoothUp),
      downRate: Math.round(smoothDown),
    })
  } catch {
    /* 单次读取失败保持上一次数值，下一轮再试 */
  } finally {
    trafficBusy = false
    useLive.getState().bumpTick()
  }
}

function startTrafficLoop() {
  if (typeof window === 'undefined' || trafficTimer !== null) return
  trafficTimer = window.setInterval(() => { void pollTraffic() }, 1000)
}

/** 连接引擎控制器：把适配器与全局状态桥接，页面只需调用这里的动作。 */
export function useEngine() {
  // 平台检测 & 适配器创建
  useEffect(() => {
    let cancelled = false
    let timer: number | undefined
    let tries = 0

    const boot = () => {
      if (cancelled) return
      // Tauri 的 IPC 注入可能晚于首帧，重新尝试注入桥接，避免误判为纯 Web 环境
      if (!(window as any).AnTunDesktop) initDesktopBridge()
      const ua = navigator.userAgent
      let platform: 'android' | 'windows' | 'tv' | 'web' = 'web'
      if (/Android/i.test(ua)) platform = /TV|Android TV|SMART-TV/i.test(ua) ? 'tv' : 'android'
      else if (/Windows/i.test(ua)) platform = 'windows'
      else if (/TV|SmartTV|HbbTV/i.test(ua)) platform = 'tv'
      // 桌面壳环境（Tauri）：平台固定为 windows，并暴露原生能力
      const desk = (window as any).AnTunDesktop
      if (desk?.isDesktop) platform = 'windows'
      if (platform === 'web' && tries < 6) {
        tries++
        timer = window.setTimeout(boot, 250)
        return
      }
      const s = useStore.getState()
      s.setPlatform(platform)
      ensureAdapter()
      startTrafficLoop()
      // 托盘状态同步
      ;(window as any)._antunSyncTray = () => desk?.notifyStatus?.(useStore.getState().conn.connected)
    }

    boot()
    return () => {
      cancelled = true
      if (timer) window.clearTimeout(timer)
    }
    // 仅在挂载时检测一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const scan = useCallback(async () => {
    const s = useStore.getState()
    s.setScanning(true)
    s.log('INFO', tr('scanning', s.settings.lang))
    s.addHistory(tr('scanning', s.settings.lang))
    try {
      const adapter = ensureAdapter()
      let endpoints = await adapter.scan({ protocol: s.settings.proto })
      // 排序偏好：未探测的端点一律排在已测通的后面
      endpoints = rankEndpoints(endpoints, s.settings.endpointRank)
      // 国家过滤
      const allowed = s.allowedCountries
      const filtered = allowed.length ? endpoints.filter((e) => allowed.includes(e.country)) : endpoints
      const finalList = filtered.length ? filtered : endpoints
      s.setEndpoints(finalList)
      s.log('INFO', `probe group ok: ${finalList.length}/${endpoints.length}`)
      s.addHistory(`scan ok: ${finalList.length} endpoints`)
      return finalList
    } catch (e: any) {
      s.log('ERROR', `scan failed: ${e.message}`)
      s.addHistory(`scan failed: ${e.message}`, false)
      return []
    } finally {
      useStore.getState().setScanning(false)
    }
  }, [])

  /**
   * 订阅节点延迟测试。
   *
   * 走的是独立的测速核心（node_test_start / node_test_delay），
   * 它的监听端口与 API 端口都是现分配的，和正在连接的核心互不干扰，
   * 所以「已连接状态下点扫描」也不会把现有隧道踢掉。
   * 结果写进 nodeStats，首页下拉据此把订阅节点按延迟升序排列。
   * 返回测通数量。
   */
  const probeSubNodes = useCallback(async (): Promise<number> => {
    const s = useStore.getState()
    const desk = (window as any).AnTunDesktop
    if (!desk?.isDesktop) {
      s.log('WARN', 'node probe skipped: 需要桌面客户端')
      return 0
    }
    if (s.nodeTesting) return 0
    if (!s.subNodes.length) {
      s.log('WARN', 'node probe skipped: 没有订阅节点')
      return 0
    }
    s.setNodeTesting(true)
    s.log('INFO', `probe subscription nodes: ${s.subNodes.length}`)
    s.addHistory(`node probe: ${s.subNodes.length} nodes`)
    try {
      const start = await desk.nodeTestStart(s.subNodes)
      if (start?.skipped?.length) {
        s.mergeNodeStats(start.skipped.map((id: string) => ({
          id, delay: -1, speed: 0, bytes: 0, error: tr('nodeCfgRejected', s.settings.lang),
        })))
      }
      const delays: NodeStat[] = await desk.nodeTestDelay()
      useStore.getState().mergeNodeStats(delays || [])
      const ok = (delays || []).filter((d) => d.delay > 0).length
      const total = (delays || []).length
      s.log('INFO', `node probe ok: ${ok}/${total} reachable`)
      s.addHistory(`node probe ok: ${ok}/${total}`)
      return ok
    } catch (e: any) {
      s.log('ERROR', `node probe failed: ${e?.message || e}`)
      s.addHistory('node probe failed', false)
      return 0
    } finally {
      try { await desk.nodeTestStop() } catch { /* 核心可能已退出 */ }
      useStore.getState().setNodeTesting(false)
    }
  }, [])

  const connect = useCallback(async (optsOverride?: Partial<ConnectOptions>) => {
    resetTraffic()
    await engineConnect(optsOverride)
  }, [])

  // 启动即连接：等适配器与平台状态就绪后再触发，避免首帧竞态
  useEffect(() => {
    const s = useStore.getState()
    if (!s.settings.autoConnect || s.conn.connected || s.conn.connecting) return
    const timer = window.setTimeout(() => { void connect() }, 800)
    return () => window.clearTimeout(timer)
  }, [connect])

  const disconnect = useCallback(async () => {
    await engineDisconnect()
    resetTraffic()
  }, [])

  // 桌面壳退出：断开连接、还原代理后再通知主进程退出
  useEffect(() => {
    const desk = (window as any).AnTunDesktop
    if (!desk?.isDesktop) return
    const handler = async () => {
      if (useStore.getState().conn.connected) await disconnect()
      flushPersist()
      desk.quit?.()
    }
    desk.onQuitRequest?.(handler)
  }, [disconnect])

  const cancel = useCallback(async () => {
    await engineCancel()
  }, [])

  return { scan, probeSubNodes, connect, disconnect, cancel }
}
