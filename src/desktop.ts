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
  /** 凭证来源：user / auto / 空（内置共享） */
  source?: string
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
  /** 致命错误（核心进程已退出），前端应立即断开而不是继续重试 */
  fatal?: boolean
  /** 本次连接实际使用的凭证来源：user / auto / builtin */
  credentialSource?: string
  /** 是否发生了"凭证失败 → 回退内置凭证"的降级 */
  fallback?: boolean
  /** 降级前那次失败的原因 */
  fallbackReason?: string
}

/** 当前凭证身份（设置页展示"独享 / 共享"） */
export interface CredentialInfo {
  source: 'user' | 'auto' | 'builtin' | string
  unique: boolean
  addressV4: string
  addressV6: string
  endpoint: string
}

export interface CoreComponentStatus {
  installed: boolean
  version: string
  updatedAt: number | null
  source: 'bundled' | 'updated'
  size: number
}

export interface CoreUpdateStatus {
  mihomo: CoreComponentStatus
  psiphon: CoreComponentStatus
}

export interface NodeStat {
  id: string
  /** 毫秒；-1 表示未测或失败 */
  delay: number
  /** bytes/s */
  speed: number
  bytes: number
  error: string
}

export interface NodeTestStart {
  tested: number
  skipped: string[]
}

export interface CoreUpdateResult {
  ok: boolean
  component: string
  version: string
  message: string
  needsRestart: boolean
}

export interface RegionOption {
  code: string
  nameZh: string
  nameEn: string
  live: boolean
}

/** 连接时的网络策略（DNS / 出口 / 地址族） */
export interface NetOptions {
  dnsMode: 'preset' | 'custom' | 'off'
  dnsCustom: string
  dnsGuard: boolean
  ipFamily: 'v4' | 'v6' | 'dual'
  subExit: 'warp' | 'node'
  subViaWarp: boolean
}

export interface DiagItem {
  name: string
  ok: boolean
  status: number
  detail: string
}

export interface DiagReport {
  ok: boolean
  kind: 'dns' | 'ai' | string
  summary: string
  exitIp: string
  exitCountry: string
  resolverIp: string
  resolverGeo: string
  leak: boolean
  items: DiagItem[]
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
      coreConnect: (cred: WarpCredential, protocol: string, port: number, apiPort: number, mtu: number, timeoutSec: number, allowLan: boolean, frontConfig?: string, net?: NetOptions) => Promise<CoreResult>
      coreStop: () => Promise<void>
      coreStatus: () => Promise<boolean>
      coreTraffic: (apiPort: number) => Promise<{ up: number; down: number; upTotal: number; downTotal: number }>
      saveCredential: (cred: WarpCredential) => Promise<void>
      loadCredential: () => Promise<WarpCredential>
      credentialInfo: () => Promise<CredentialInfo>
      probeStatus: (port: number, lite?: boolean) => Promise<CoreResult>
      coreUpdateStatus: () => Promise<CoreUpdateStatus>
      coreUpdate: (kind: 'mihomo' | 'psiphon') => Promise<CoreUpdateResult>
      psiphonRegions: () => Promise<RegionOption[]>
      setPsiphonRegion: (code: string) => Promise<void>
      netDiagnose: (port: number, kind: 'dns' | 'ai') => Promise<DiagReport>
      nodeTestStart: (nodes: SubNode[]) => Promise<NodeTestStart>
      nodeTestDelay: () => Promise<NodeStat[]>
      nodeTestSpeed: (ids: string[], seconds?: number, concurrency?: number) => Promise<NodeStat[]>
      nodeTestStop: () => Promise<void>
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

  // 凭证相关事件（首次启动注册独享身份、连接失败回退内置凭证）
  // 统一转成 window 事件，前端各处沿用同一个监听入口
  void listen('antun-credential', (e) => {
    window.dispatchEvent(new CustomEvent('antun-credential', { detail: e.payload }))
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
    coreConnect: (cred, protocol, port, apiPort, mtu, timeoutSec, allowLan, frontConfig, net) =>
      invoke<CoreResult>('core_connect', {
        cred, protocol, port, apiPort, mtu, timeoutSec, allowLan, frontConfig,
        dnsMode: net?.dnsMode ?? 'preset',
        dnsCustom: net?.dnsCustom ?? '',
        dnsGuard: net?.dnsGuard ?? true,
        ipFamily: net?.ipFamily ?? 'v4',
        subExit: net?.subExit ?? 'warp',
        subViaWarp: net?.subViaWarp ?? false,
      }),
    coreStop: () => invoke<void>('core_stop'),
    coreStatus: () => invoke<boolean>('core_status'),
    coreTraffic: (apiPort) => invoke<{ up: number; down: number; upTotal: number; downTotal: number }>('core_traffic', { apiPort }),
    saveCredential: (cred) => invoke<void>('save_credential', { cred }),
    loadCredential: () => invoke<WarpCredential>('load_credential'),
    credentialInfo: () => invoke<CredentialInfo>('credential_info'),
    probeStatus: (port, lite) => invoke<CoreResult>('probe_status', { port, lite: !!lite }),
    coreUpdateStatus: () => invoke<CoreUpdateStatus>('core_update_status'),
    coreUpdate: (kind) => invoke<CoreUpdateResult>('core_update', { kind }),
    psiphonRegions: () => invoke<RegionOption[]>('psiphon_regions'),
    setPsiphonRegion: (code) => invoke<void>('set_psiphon_region', { region: code }),
    netDiagnose: (port, kind) => invoke<DiagReport>('net_diagnose', { port, kind }),
    nodeTestStart: (nodes) => invoke<NodeTestStart>('node_test_start', { nodes }),
    nodeTestDelay: () => invoke<NodeStat[]>('node_test_delay'),
    nodeTestSpeed: (ids, seconds, concurrency) =>
      invoke<NodeStat[]>('node_test_speed', { ids, seconds, concurrency }),
    nodeTestStop: () => invoke<void>('node_test_stop'),
  }
}
