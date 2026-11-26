import { useCallback, useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { createAdapter } from './adapters'
import type { EngineAdapter, ConnectOptions } from '../types'
import { tr } from '../i18n'

/** 连接引擎控制器：把适配器与全局状态桥接，页面只需调用这里的动作。 */
export function useEngine() {
  const store = useStore()
  const adapterRef = useRef<EngineAdapter | null>(null)
  const [tick, setTick] = useState(0)

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

  // 会话时钟 / 流量模拟，每秒刷新
  useEffect(() => {
    const t = setInterval(() => {
      const c = useStore.getState().conn
      if (c.connected) {
        useStore.getState().setConn({
          up: c.up + Math.floor(Math.random() * 9000),
          down: c.down + Math.floor(Math.random() * 60000),
        })
        setTick((x) => x + 1)
      }
    }, 1000)
    return () => clearInterval(t)
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
      useStore.getState().setConn({ ...state, connecting: false })
      ;(window as any)._antunSyncTray?.()
      adapter.probe((p) => useStore.getState().pushLatency(p))
      s.log('INFO', `connected: exit=${state.exitIp} colo=${state.colo} ${state.latency}ms`)
      s.addHistory(`connected ${state.session}`)
    } catch (e: any) {
      useStore.getState().setConn({ connecting: false, connected: false })
      s.log('ERROR', `connect failed: ${e.message}`)
      s.addHistory(`connect failed: ${e.message}`, false)
    }
  }, [])

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
    useStore.getState().setConn({
      connected: false, connecting: false, startedAt: null,
      exitIp: '', country: '', colo: '', city: '', latency: 0, up: 0, down: 0, session: '',
    })
    ;(window as any)._antunSyncTray?.()
    s.log('INFO', 'disconnected')
    s.addHistory('disconnected')
  }, [])

  // 真实探测发现隧道失效时，自动清空连接状态（绝不保留假的"已连接"）
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail || '隧道探测失败'
      useStore.getState().setConn({
        connected: false, connecting: false, startedAt: null,
        exitIp: '', country: '', colo: '', city: '', latency: 0, session: '',
      })
      useStore.getState().log('ERROR', `tunnel lost: ${detail}`)
      useStore.getState().addHistory('tunnel lost', false)
    }
    window.addEventListener('antun-tunnel-lost', handler)
    return () => window.removeEventListener('antun-tunnel-lost', handler)
  }, [])

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
