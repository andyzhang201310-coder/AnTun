// ============ AnTun 全局类型定义 ============

export type Lang = 'zh' | 'en'
export type Theme = 'light' | 'dark' | 'system'
export type Protocol = 'awg' | 'wg' | 'gool' | 'masque' | 'masque-h2' | 'masque-mm'
export type CaptureMode = 'proxy' | 'tun'
export type PageId = 'home' | 'modes' | 'nodes' | 'rules' | 'settings' | 'logs' | 'about'
export type ConnMode = 'warp' | 'subscription'

/** 订阅源 */
export interface Subscription {
  id: string
  name: string
  url: string
  updatedAt: number
}

/** 订阅解析出的代理节点（config 为 mihomo 出站块） */
export interface SubNode {
  id: string
  subId: string
  name: string
  nodeType: string
  server: string
  port: number
  config: string
}

/** 节点测速结果 */
export interface NodeStat {
  id: string
  /** 毫秒；-1 表示未测或失败 */
  delay: number
  /** bytes/s */
  speed: number
  /** 本次实际下载字节数 */
  bytes: number
  error: string
}

/** 扫描到的 WARP 端点 */
export interface Endpoint {
  id: string
  host: string
  port: number
  country: string
  colo: string
  city: string
  latency: number      // ms
  loss: number         // 丢包率 0-1
  protocol: Protocol
  starred?: boolean
}

/** 连接状态快照 */
export interface ConnState {
  connected: boolean
  connecting: boolean
  protocol: Protocol
  endpoint: Endpoint | null
  exitIp: string
  country: string
  colo: string
  city: string
  latency: number
  up: number           // bytes
  down: number         // bytes
  upRate: number       // bytes per second
  downRate: number     // bytes per second
  startedAt: number | null
  session: string      // 例如 "AWG" / "AWG-Psiphon"
}

/** 用户设置（对应原版 settings.json，全部功能项） */
export interface Settings {
  theme: Theme
  lang: Lang
  connMode: ConnMode
  subscriptionUrl: string
  frontNodeId: string
  proto: Protocol
  outerProto: Protocol
  innerProto: Protocol
  rescan: boolean
  psiphon: boolean
  psiphonRegion: string
  warpInWarp: boolean
  autoRepair: boolean
  captureMode: CaptureMode
  mixedPort: number
  apiPort: number
  allowLan: boolean
  ipFamily: 'v4' | 'v6' | 'dual'
  mtu: number
  endpointRank: 'ping' | 'loss' | 'colo'
  dnsMode: 'preset' | 'custom' | 'off'
  dnsCustom: string
  /** DNS 防泄漏：fake-ip + DoH 经隧道解析，避免系统 DNS 明文外泄 */
  dnsLeak: boolean
  /** 订阅模式出口：warp = 节点前置、WARP 出口；node = 节点直接出站 */
  subExit: 'warp' | 'node'
  /** 节点出口时是否让 WARP 承载节点流量（前置隧道） */
  subViaWarp: boolean
  proxyMode: 'custom' | 'bypass-mainland' | 'global'
  domainDirect: string
  domainProxy: string
  autoConnect: boolean
  autoStart: boolean
  rememberPage: boolean
  timeoutSec: number
  controlCode: string
}

/** 规则（分流） */
export interface Rule {
  id: string
  type: 'DOMAIN-SUFFIX' | 'DOMAIN-KEYWORD' | 'IP-CIDR' | 'PROCESS-NAME' | 'GEOSITE' | 'MATCH'
  value: string
  policy: 'DIRECT' | 'WARP' | 'REJECT'
  enabled: boolean
  builtin?: boolean
}

/** 日志条目 */
export interface LogEntry {
  id: string
  level: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG'
  time: number
  message: string
}

/** 连接历史步骤 */
export interface HistoryStep {
  id: string
  time: number
  text: string
  ok: boolean
}

/** 延迟采样点（实时图表） */
export interface LatencyPoint {
  t: number
  ms: number
}

/** 引擎适配器接口 —— 所有端（Web/Android/Windows/TV）统一实现 */
export interface EngineAdapter {
  readonly id: string
  readonly name: string
  scan(opts?: { protocol?: Protocol }): Promise<Endpoint[]>
  connect(opts: ConnectOptions): Promise<ConnState>
  disconnect(): Promise<void>
  status(): Promise<ConnState>
  probe(onPoint: (p: LatencyPoint) => void): void
  stopProbe(): void
  traffic?(): Promise<{ up: number; down: number; upRate?: number; downRate?: number }>
}

export interface ConnectOptions {
  protocol: Protocol
  endpoint?: Endpoint | null
  frontConfig?: string
  captureMode: CaptureMode
  psiphon: boolean
  warpInWarp: boolean
  settings: Settings
}

/** 平台信息 */
export type Platform = 'android' | 'windows' | 'tv' | 'web'
