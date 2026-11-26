import { useCallback, useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { createAdapter } from './adapters'
import type { EngineAdapter, ConnectOptions } from '../types'
import { tr } from '../i18n'

/** 连接引擎控制器：把适配器与全局状态桥接，页面只需调用这里的动作。 */
export function useEngine() {
  const store = useStore()
  const adapterRef = useRef<EngineAdapter | null>(null)
  const trafficRef = useRef({ up: 0, down: 0, t: Date.now(), initialized: false })
  const rateRef = useRef({ up: 0, down: 0 })
  const trafficBusyRef = useRef(false)
  const [tick, setTick] = useState(0)

  const resetTraffic = useCallback(() => {
    trafficRef.current = { up: 0, down: 0, t: Date.now(), initialized: false }
    rateRef.current = { up: 0, down: 0 }
  }, [])

  // 平台检测 & 适配器创建
  useEffect(() => {
    const ua = navigator.userAgent
    let platform: 'android' | 'windows' | 'tv' | 'web' = 'web'
    if (/Android/i.test(ua)) platform = /TV|Android TV|SMART-TV/i.test(ua) ? 'tv' : 'android'
    else if (/Windows/i.test(ua)) platform = 'windows'
    else if (/TV|SmartTV|HbbTV/i.test(ua)) platform = 'tv'
    // 桌面壳环境（Tauri）：平台固定为 windows，并暴露原生能力
    const desk = (window as any).AnTunDesktop
    if (desk?.isDesktop) platform = 'windows'
    store.setPlatform(platform)
    adapterRef.current = createAdapter(platform, store.settings.apiPort, store.settings.mixedPort)
    store.log('INFO', `${tr('diagPlatform', store.settings.lang)}: ${platform} · ${adapterRef.current.name}`)
    // 托盘状态同步
    ;(window as any)._antunSyncTray = () => desk?.notifyStatus?.(useStore.getState().conn.connected)
    // 仅在挂载时检测一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 会话时钟 / 实时速率：桌面端读核心累计流量并计算每秒增量
  useEffect(() => {
    const timer = setInterval(async () => {
      const s = useStore.getState()
      if (!s.conn.connected) return
      if (trafficBusyRef.current) {
        setTick((x) => x + 1)
        return
      }
      trafficBusyRef.current = true
      const now = Date.now()
      try {
        const adapter = adapterRef.current
        let up = trafficRef.current.up
        let down = trafficRef.current.down
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
        const prev = trafficRef.current
        let smoothUp = rateRef.current.up
        let smoothDown = rateRef.current.down
        if (directUpRate !== undefined && directDownRate !== undefined) {
          // mihomo /traffic 直接给出每秒速率，这里只做轻微平滑
          smoothUp = smoothUp * 0.35 + directUpRate * 0.65
          smoothDown = smoothDown * 0.35 + directDownRate * 0.65
        } else if (!prev.initialized) {
          trafficRef.current = { up, down, t: now, initialized: true }
          rateRef.current = { up: 0, down: 0 }
          s.setConn({ up, down, upRate: 0, downRate: 0 })
          setTick((x) => x + 1)
          return
        } else {
          const elapsed = Math.min(5, Math.max(0.5, (now - prev.t) / 1000))
          const instantUp = Math.max(0, up - prev.up) / elapsed
          const instantDown = Math.max(0, down - prev.down) / elapsed
          smoothUp = smoothUp * 0.5 + instantUp * 0.5
          smoothDown = smoothDown * 0.5 + instantDown * 0.5
        }
        rateRef.current = { up: smoothUp, down: smoothDown }
        trafficRef.current = { up, down, t: now, initialized: true }
        s.setConn({
          up, down,
          upRate: Math.round(smoothUp),
          downRate: Math.round(smoothDown),
        })
        setTick((x) => x + 1)
      } catch {
        setTick((x) => x + 1)
      } finally {
        trafficBusyRef.current = false
      }
    }, 1000)
    return () => clearInterval(timer)
  }, [])

  const scan = useCallback(async () => {
    const s = useStore.getState()
    s.setScanning(true)
    s.log('INFO', tr('scanning', s.settings.lang))
    s.addHistory(tr('scanning', s.settings.lang))
    try {
      const adapter = adapterRef.current || createAdapter(s.platform, s.settings.apiPort, s.settings.mixedPort)
      let endpoints = await adapter.scan({ protocol: s.settings.proto })
      // 排序偏好
      if (s.settings.endpointRank === 'loss') endpoints = [...endpoints].sort((a, b) => a.loss - b.loss || a.latency - b.latency)
      if (s.settings.endpointRank === 'colo') endpoints = [...endpoints].sort((a, b) => a.colo.localeCompare(b.colo))
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

  const connect = useCallback(async (optsOverride?: Partial<ConnectOptions>) => {
    const s = useStore.getState()
    if (s.conn.connecting || s.conn.connected) return
    s.setConn({ connecting: true, session: '' })
    s.log('INFO', `connect -> protocol=${s.settings.proto}`)
    s.addHistory(`connect ${s.settings.proto}`)
    try {
      const adapter = adapterRef.current || createAdapter(s.platform, s.settings.apiPort, s.settings.mixedPort)
      const pinned = s.endpoints.find((e) => e.id === s.pinnedId) || null
      const frontNode = s.settings.connMode === 'subscription'
        ? s.subNodes.find((n) => n.id === s.settings.frontNodeId)
        : undefined
      if (s.settings.connMode === 'subscription' && !frontNode) {
        throw new Error('订阅模式尚未选择前置节点：请到「模式」页导入订阅并选一个节点')
      }
      const opts: ConnectOptions = {
        protocol: s.settings.proto,
        endpoint: pinned,
        frontConfig: frontNode?.config,
        captureMode: s.settings.captureMode,
        psiphon: s.settings.psiphon,
        warpInWarp: s.settings.warpInWarp,
        settings: s.settings,
        ...optsOverride,
      }
      s.addHistory('render config -> start core')
      s.addHistory('probe endpoint -> verify exit')
      const state = await adapter.connect(opts)
      resetTraffic()
      useStore.getState().setConn({ ...state, connecting: false, upRate: 0, downRate: 0 })
      ;(window as any)._antunSyncTray?.()
      adapter.probe((p) => useStore.getState().pushLatency(p))
      s.log('INFO', `connected: exit=${state.exitIp} colo=${state.colo} ${state.latency}ms`)
      s.addHistory(`connected ${state.session}`)
    } catch (e: any) {
      useStore.getState().setConn({ connecting: false, connected: false })
      s.log('ERROR', `connect failed: ${e.message}`)
      s.addHistory(`connect failed: ${e.message}`, false)
    }
  }, [resetTraffic])

  // 启动即连接：等适配器与平台状态就绪后再触发，避免首帧竞态
  useEffect(() => {
    const s = useStore.getState()
    if (!s.settings.autoConnect || s.conn.connected || s.conn.connecting) return
    const timer = window.setTimeout(() => { void connect() }, 800)
    return () => window.clearTimeout(timer)
  }, [connect])

  const disconnect = useCallback(async () => {
    const s = useStore.getState()
    s.log('INFO', 'disconnect -> restore proxy snapshot')
    const adapter = adapterRef.current
    if (adapter) await adapter.disconnect()
    resetTraffic()
    useStore.getState().setConn({
      connected: false, connecting: false, startedAt: null,
      exitIp: '', country: '', colo: '', city: '', latency: 0,
      up: 0, down: 0, upRate: 0, downRate: 0, session: '',
    })
    ;(window as any)._antunSyncTray?.()
    s.log('INFO', 'disconnected')
    s.addHistory('disconnected')
  }, [resetTraffic])

  // 真实探测发现隧道失效时，自动清空连接状态（绝不保留假的"已连接"）
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail || '隧道探测失败'
      resetTraffic()
      useStore.getState().setConn({
        connected: false, connecting: false, startedAt: null,
        exitIp: '', country: '', colo: '', city: '', latency: 0,
        up: 0, down: 0, upRate: 0, downRate: 0, session: '',
      })
      useStore.getState().log('ERROR', `tunnel lost: ${detail}`)
      useStore.getState().addHistory('tunnel lost', false)
    }
    window.addEventListener('antun-tunnel-lost', handler)
    return () => window.removeEventListener('antun-tunnel-lost', handler)
  }, [resetTraffic])

  // 桌面壳退出：断开连接、还原代理后再通知主进程退出
  useEffect(() => {
    const desk = (window as any).AnTunDesktop
    if (!desk?.isDesktop) return
    const handler = async () => {
      if (useStore.getState().conn.connected) await disconnect()
      desk.quit?.()
    }
    desk.onQuitRequest?.(handler)
  }, [disconnect])

  return { scan, connect, disconnect, tick }
}
