/**
 * AnTun 桌面环境桥接
 *
 * Tauri 环境下注入统一的 window.AnTunDesktop 桌面接口，
 * 让 useEngine / 设置页等现有代码无需区分运行环境。
 * Web 环境下本模块不注入任何对象，行为与纯前端版完全一致。
 */
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type { SubNode } from './types'

export interface WarpCredential {
  privateKey: string
  peerPublicKey: string
  addressV4: string
  addressV6: string
  endpointHost: string
  endpointPort: number
  /** 嵌套协议所需的内层 WARP 凭证（GOOL） */
  innerPrivateKey?: string
  innerEndpointHost?: string
  innerEndpointPort?: number
  /** MASQUE 协议的 ECDSA 密钥（base64，MASQUE H3/H2/in-MASQUE） */
  masquePrivateKey?: string
  masquePublicKey?: string
}

export interface AppInfo {
  version: string
  exePath: string
  resourceDir: string
  dataDir: string
}

export interface CoreResult {
  ok: boolean
  exitIp: string
  country: string
  city: string
  colo: string
  latency: number
  error: string
}

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown
    AnTunDesktop?: {
      isDesktop: boolean
      isTauri: boolean
      platform: string
      setAutoStart: (enabled: boolean) => Promise<boolean>
      getAutoStart: () => Promise<boolean>
      appInfo: () => Promise<AppInfo>
      subscriptionFetch: (url: string) => Promise<SubNode[]>
      subscriptionParse: (content: string) => Promise<SubNode[]>
      notifyStatus: (connected: boolean) => Promise<void>
      quit: () => Promise<void>
      onQuitRequest: (cb: () => void) => void
      // 真实连接核心
      coreConnect: (cred: WarpCredential, protocol: string, port: number, apiPort: number, mtu: number, timeoutSec: number, allowLan: boolean, frontConfig?: string) => Promise<CoreResult>
      coreStop: () => Promise<void>
      coreStatus: () => Promise<boolean>
      saveCredential: (cred: WarpCredential) => Promise<void>
      loadCredential: () => Promise<WarpCredential>
      probeStatus: (port: number) => Promise<CoreResult>
    }
    _antunSyncTray?: () => void
  }
}

export function initDesktopBridge() {
  if (typeof window === 'undefined') return
  if (!('__TAURI_INTERNALS__' in window)) return
  if (window.AnTunDesktop) return

  let quitCallback: (() => void) | null = null
  void listen('antun-quit-request', () => {
    quitCallback?.()
  })

  window.AnTunDesktop = {
    // 桌面环境标识，供 useEngine 检测
    isDesktop: true,
    isTauri: true,
    platform: 'windows',
    setAutoStart: (enabled) => invoke<boolean>('set_autostart', { enabled }),
    getAutoStart: () => invoke<boolean>('get_autostart'),
    appInfo: () => invoke<AppInfo>('app_info'),
    subscriptionFetch: (url) => invoke<SubNode[]>('subscription_fetch', { url }),
    subscriptionParse: (content) => invoke<SubNode[]>('subscription_parse', { content }),
    notifyStatus: (connected) => invoke<void>('notify_status', { connected }),
    // 前端完成断连后通知 Rust 主进程退出
    quit: () => invoke<void>('quit_ready'),
    onQuitRequest: (cb) => {
      quitCallback = cb
    },
    // 真实核心链路
    coreConnect: (cred, protocol, port, apiPort, mtu, timeoutSec, allowLan, frontConfig) =>
      invoke<CoreResult>('core_connect', { cred, protocol, port, apiPort, mtu, timeoutSec, allowLan, frontConfig }),
    coreStop: () => invoke<void>('core_stop'),
    coreStatus: () => invoke<boolean>('core_status'),
    saveCredential: (cred) => invoke<void>('save_credential', { cred }),
    loadCredential: () => invoke<WarpCredential>('load_credential'),
    probeStatus: (port) => invoke<CoreResult>('probe_status', { port }),
  }
}
