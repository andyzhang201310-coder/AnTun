import type { EngineAdapter, ConnectOptions, ConnState, Endpoint, LatencyPoint, Protocol, Platform, ConnSnapshot } from '../types'
import { newId } from '../store'
import type { CoreResult, WarpCredential } from '../desktop'

/**
 * Cloudflare WARP 真实端点池：从 engage.cloudflareclient.com 解析出的官方 anycast 地址段。
 * 这些都是 anycast，具体落到哪个 PoP 由运营商到该地址的路由决定，
 * 因此不能像普通节点那样标注"US/SG/JP"国家，只能用实测延迟排序。
 */
const WARP_ENDPOINT_HOSTS = [
  '162.159.192.1', '162.159.192.7',
  '162.159.193.1', '162.159.193.7',
  '162.159.195.1', '162.159.195.7',
  '188.114.96.1', '188.114.96.7',
  '188.114.97.1', '188.114.98.1',
  '188.114.99.1', '188.114.99.7',
]
/** MASQUE 端点与 SNI 由 Cloudflare 固定下发，不参与择优 */
const MASQUE_ENDPOINT = { host: '162.159.198.1', port: 500 }
const WARP_PORT = 2408

function makeEndpoints(protocol: Protocol, probes?: Map<string, number>): Endpoint[] {
  if (protocol.startsWith('masque')) {
    const { host, port } = MASQUE_ENDPOINT
    return [{
      id: `${protocol}:${host}:${port}`,
      host, port,
      country: '', colo: '', city: '',
      latency: 0, loss: 0, protocol,
    }]
  }
  const list = WARP_ENDPOINT_HOSTS.map((host) => {
    const rtt = probes?.get(host)
    const latency = rtt !== undefined && rtt > 0 ? rtt : 0
    return {
      id: `${protocol}:${host}:${WARP_PORT}`,
      host,
      port: WARP_PORT,
      country: '',
      colo: '',
      city: '',
      latency,
      // 未探测 = 0（未知）；探测过但握手失败 = 1（不可用）
      loss: rtt === undefined ? 0 : rtt > 0 ? 0 : 1,
      protocol,
    }
  })
  // 已测通的按实测延迟升序，未测/失败的排后面（不丢弃，用户仍可手动锁）
  return list.sort((a, b) => (a.latency || Number.MAX_SAFE_INTEGER) - (b.latency || Number.MAX_SAFE_INTEGER))
}

/**
 * Web 适配器：纯浏览器环境仅用于 UI 演示。
 * 明确不产生"已连接"的假状态——connect 会抛错，提示需要桌面端/桥接。
 */
export class WebAdapter implements EngineAdapter {
  readonly id = 'web'
  readonly name = 'Web Preview'
  private probeTimer: ReturnType<typeof setInterval> | null = null

  async scan(opts?: { protocol?: Protocol }): Promise<Endpoint[]> {
    await new Promise((r) => setTimeout(r, 400))
    return makeEndpoints(opts?.protocol || 'awg')
  }

  async connect(_opts: ConnectOptions): Promise<ConnState> {
    throw new Error('浏览器环境无法建立真实隧道，请下载 AnTun 桌面版')
  }

  async disconnect(): Promise<void> {
    this.stopProbe()
  }

  async status(): Promise<ConnState> {
    throw new Error('not implemented in web adapter')
  }

  probe(onPoint: (p: LatencyPoint) => void): void {
    this.stopProbe()
    this.probeTimer = setInterval(() => {
      // 纯预览环境不伪造延迟数据
      void onPoint
    }, 2000)
  }

  stopProbe(): void {
    if (this.probeTimer) { clearInterval(this.probeTimer); this.probeTimer = null }
  }
}

/**
 * 桌面适配器：真实链路。
 * 连接成功与否完全由 Rust 侧的真实出口探测结果决定。
 */
export class DesktopAdapter implements EngineAdapter {
  readonly id = 'desktop'
  readonly name = 'AnTun Core'
  private probeTimer: ReturnType<typeof setInterval> | null = null
  private port: number
  private apiPort: number
  private connected = false
  private fails = 0
  private probing = false

  constructor(port: number, apiPort: number) {
    this.port = port
    this.apiPort = apiPort
  }

  private get desk() {
    const d = (window as any).AnTunDesktop
    if (!d?.isDesktop) throw new Error('桌面桥接不可用')
    return d
  }

  async scan(opts?: { protocol?: Protocol }): Promise<Endpoint[]> {
    const protocol = opts?.protocol || 'awg'
    const base = makeEndpoints(protocol)
    // MASQUE 端点固定，没有可择优的候选
    if (protocol.startsWith('masque')) return base

    let cred: WarpCredential | null = null
    try {
      cred = await this.desk.loadCredential() as WarpCredential | null
    } catch {
      return base
    }
    if (!cred?.privateKey || !cred?.peerPublicKey) return base

    // Rust 侧用真实凭证逐端点握手测速：不可达的端点会返回 rtt=-1
    try {
      const probes = await this.desk.probeEndpoints(cred, base.map((e) => e.host), WARP_PORT, 0)
      const map = new Map<string, number>()
      for (const p of probes) map.set(p.host, p.ok ? p.rtt : -1)
      if (!map.size) return base
      return makeEndpoints(protocol, map)
    } catch {
      return base
    }
  }

  async connect(opts: ConnectOptions): Promise<ConnState> {
    const cred = await this.desk.loadCredential() as WarpCredential | null
    if (!cred) {
      throw new Error('尚未配置 WARP 凭证：请先导入 WARP 账户（设置页），否则无法建立真实连接')
    }

    // 选定端点只对 WireGuard 系生效（MASQUE 的 server/SNI 固定）
    const picked = opts.endpoint && !opts.protocol.startsWith('masque')
      ? { host: opts.endpoint.host, port: opts.endpoint.port }
      : null

    const result = await this.desk.coreConnect(
      cred,
      opts.protocol,
      opts.settings.mixedPort,
      opts.settings.apiPort,
      opts.settings.mtu,
      opts.settings.timeoutSec,
      opts.settings.allowLan,
      opts.frontConfig,
      {
        dnsMode: opts.settings.dnsMode,
        dnsCustom: opts.settings.dnsCustom,
        dnsGuard: opts.settings.dnsLeak,
        ipFamily: opts.settings.ipFamily,
        subExit: opts.settings.subExit ?? 'warp',
        subViaWarp: opts.settings.subViaWarp ?? false,
        psiphon: opts.psiphon ?? false,
        psiphonRegion: opts.settings.psiphonRegion ?? '',
        captureMode: opts.settings.captureMode,
        adBlock: opts.settings.adBlock,
      },
      picked,
    ) as CoreResult

    if (!result.ok) {
      throw new Error(result.error || '连接失败')
    }

    // 当前凭证建立不了隧道、已自动回退内置共享凭证：如实告知用户
    if (result.fallback) {
      window.dispatchEvent(new CustomEvent('antun-credential', {
        detail: { kind: 'fallback', ok: true, source: result.credentialSource || 'builtin', error: result.fallbackReason || '' },
      }))
    }

    // 用核心回报的端点校正展示：配置里写的是哪个，界面就显示哪个
    const used: Endpoint | null = result.endpointHost
      ? {
        id: `warp:${result.endpointHost}:${result.endpointPort || WARP_PORT}`,
        host: result.endpointHost,
        port: result.endpointPort || WARP_PORT,
        country: '', colo: '', city: '',
        latency: result.latency,
        loss: 0,
        protocol: opts.protocol,
      }
      : opts.endpoint ?? null

    this.connected = true
    return {
      connected: true,
      connecting: false,
      protocol: opts.protocol,
      endpoint: used,
      exitIp: result.exitIp,
      country: result.country,
      colo: result.colo || 'WARP',
      city: result.city,
      latency: result.latency,
      up: 0,
      down: 0,
      upRate: 0,
      downRate: 0,
      startedAt: Date.now(),
      session: (() => {
        // Psiphon 作为最终出口时，WARP / 节点都不参与，标签必须如实反映
        if (opts.psiphon) return 'Psiphon · 出口'
        if (!opts.frontConfig) return `${opts.protocol.toUpperCase()} · WARP`
        const type = (opts.frontType || 'NODE').toUpperCase()
        // 节点直接出口时 WARP 不参与（除非开启经 WARP 承载），会话标签不能写协议名
        if (opts.settings.subExit === 'node') {
          return opts.settings.subViaWarp ? `${type} · 经 WARP 承载` : `${type} · 节点出口`
        }
        return `${opts.protocol.toUpperCase()} · 订阅前置`
      })(),
    }
  }

  async cancel(): Promise<void> {
    // 让 Rust 侧立刻掐掉 Psiphon 与核心：否则那一轮出口探测还要跑到超时，
    // 用户点了取消却要再等十几秒。cancel 之后 connect 的 Promise 会尽快 reject。
    await this.desk.coreCancelConnect()
  }

  async disconnect(): Promise<void> {
    this.stopProbe()
    this.connected = false
    await this.desk.coreStop()
  }

  async status(): Promise<ConnState> {
    const r = await this.desk.probeStatus(this.port) as CoreResult
    if (!r.ok) throw new Error(r.error)
    return {
      connected: true,
      connecting: false,
      protocol: 'awg',
      endpoint: null,
      exitIp: r.exitIp,
      country: r.country,
      colo: r.colo,
      city: r.city,
      latency: r.latency,
      up: 0, down: 0, upRate: 0, downRate: 0, startedAt: null, session: 'WARP',
    }
  }

  /** 定时健康检查：每 6 秒一次轻量 204 探测，连续 3 次失败才判定隧道失效 */
  probe(onPoint: (p: LatencyPoint) => void): void {
    this.stopProbe()
    this.probeTimer = setInterval(async () => {
      if (!this.connected || this.probing) return
      this.probing = true
      try {
        const r = await this.desk.probeStatus(this.port, true) as CoreResult
        if (r.ok) {
          this.fails = 0
          onPoint({ t: Date.now(), ms: r.latency })
        } else if (r.fatal) {
          // 核心进程已退出：没有重试价值，立即通知上层
          this.fails = 0
          window.dispatchEvent(new CustomEvent('antun-tunnel-lost', { detail: r.error }))
        } else {
          // 单次抖动（限速 / 丢包 / 系统休眠唤醒）不当作断线，
          // 连续 3 次（约 18 秒）都出不去才判定隧道失效。
          this.fails += 1
          if (this.fails >= 3) {
            this.fails = 0
            window.dispatchEvent(new CustomEvent('antun-tunnel-lost', { detail: r.error }))
          }
        }
      } catch { /* 探测异常时保留状态，下轮再试 */ }
      finally { this.probing = false }
    }, 6000)
  }

  async traffic(): Promise<{ up: number; down: number; upRate: number; downRate: number }> {
    const r = await this.desk.coreTraffic(this.apiPort)
    return {
      up: Number(r.upTotal) || 0,
      down: Number(r.downTotal) || 0,
      upRate: Number(r.up) || 0,
      downRate: Number(r.down) || 0,
    }
  }

  /** 当前经过隧道的连接：首页「连接设备」用 */
  async connections(): Promise<ConnSnapshot> {
    const r = await this.desk.coreConnections(this.apiPort) as ConnSnapshot
    return {
      connections: Array.isArray(r?.connections) ? r.connections : [],
      uploadTotal: Number(r?.uploadTotal) || 0,
      downloadTotal: Number(r?.downloadTotal) || 0,
    }
  }

  stopProbe(): void {
    if (this.probeTimer) { clearInterval(this.probeTimer); this.probeTimer = null }
    this.fails = 0
    this.probing = false
  }
}

/**
 * Android 适配器骨架：真机 WebView 通过 JS Bridge 调用 VpnService。
 */
export class AndroidAdapter implements EngineAdapter {
  readonly id = 'android'
  readonly name = 'Android VpnService'
  private bridge: any
  private probeTimer: ReturnType<typeof setInterval> | null = null
  constructor() {
    this.bridge = (window as any).AnTunBridge
  }
  get available() { return !!this.bridge }
  async scan(opts?: { protocol?: Protocol }): Promise<Endpoint[]> {
    if (!this.bridge) return new WebAdapter().scan(opts)
    return this.bridge.scan(JSON.stringify(opts || {})).then((s: string) => JSON.parse(s))
  }
  async connect(opts: ConnectOptions): Promise<ConnState> {
    if (!this.bridge) throw new Error('Android VpnService 桥接不可用')
    const s = await this.bridge.connect(JSON.stringify(opts))
    const state = typeof s === 'string' ? JSON.parse(s) : s
    return { ...state, upRate: state.upRate ?? 0, downRate: state.downRate ?? 0 }
  }
  async disconnect() { this.stopProbe(); if (this.bridge) await this.bridge.disconnect() }
  async status(): Promise<ConnState> {
    if (!this.bridge) throw new Error('no bridge')
    const s = await this.bridge.status()
    const state = typeof s === 'string' ? JSON.parse(s) : s
    return { ...state, upRate: state.upRate ?? 0, downRate: state.downRate ?? 0 }
  }
  probe(onPoint: (p: LatencyPoint) => void) {
    this.stopProbe()
    this.probeTimer = setInterval(async () => {
      try {
        const s = await this.status()
        onPoint({ t: Date.now(), ms: s.latency })
      } catch { /* ignore */ }
    }, 5000)
  }
  stopProbe() { if (this.probeTimer) { clearInterval(this.probeTimer); this.probeTimer = null } }
}

export function createAdapter(platform: Platform, apiPort: number, mixedPort = 7890): EngineAdapter {
  if (platform === 'android') return new AndroidAdapter()
  if (platform === 'windows' || platform === 'tv') {
    const desk = (window as any).AnTunDesktop
    if (desk?.isDesktop) return new DesktopAdapter(mixedPort, apiPort)
    return new CoreRestAdapter(platform, apiPort, mixedPort)
  }
  return new WebAdapter()
}

/**
 * 非 Tauri 的桌面/TV 环境：通过本地核心 REST API 对接（核心需单独部署）。
 * 不再伪造连接状态，探测失败即抛错。
 */
export class CoreRestAdapter implements EngineAdapter {
  readonly id: string
  readonly name: string
  private apiPort: number
  private mixedPort: number
  private probeTimer: ReturnType<typeof setInterval> | null = null
  constructor(platform: Platform, apiPort: number, mixedPort: number) {
    this.id = platform
    this.name = platform === 'windows' ? 'Windows Core' : 'TV Core'
    this.apiPort = apiPort
    this.mixedPort = mixedPort
  }
  private async api(path: string): Promise<any> {
    const res = await fetch(`http://127.0.0.1:${this.apiPort}${path}`)
    if (!res.ok) throw new Error(`核心 API ${res.status}`)
    return res.json()
  }
  async scan(opts?: { protocol?: Protocol }): Promise<Endpoint[]> {
    return makeEndpoints(opts?.protocol || 'awg')
  }
  async connect(_opts: ConnectOptions): Promise<ConnState> {
    // 核心需已由外部启动；这里只做真实出口探测
    const res = await fetch('https://ip-api.com/json/?fields=status,country,city,query', {
      headers: { 'X-AnTun-Proxy': `http://127.0.0.1:${this.mixedPort}` },
    }).catch(() => null)
    if (!res) throw new Error('本地核心不可达，请先启动核心服务')
    const data = await res.json()
    if (data.status !== 'success') throw new Error('出口探测失败')
    return {
      connected: true, connecting: false, protocol: 'awg', endpoint: null,
      exitIp: data.query, country: data.country, colo: 'WARP', city: data.city,
      latency: 0, up: 0, down: 0, upRate: 0, downRate: 0, startedAt: Date.now(), session: 'WARP',
    }
  }
  async disconnect() { this.stopProbe(); try { await this.api('/configs') } catch { /* noop */ } }
  async status(): Promise<ConnState> { return this.api('/status') }
  async traffic(): Promise<{ up: number; down: number; upRate: number; downRate: number }> {
    const d = await this.api('/traffic')
    return {
      up: Number(d.upTotal ?? d.up) || 0,
      down: Number(d.downTotal ?? d.down) || 0,
      upRate: Number(d.up) || 0,
      downRate: Number(d.down) || 0,
    }
  }
  probe(onPoint: (p: LatencyPoint) => void) {
    this.stopProbe()
    this.probeTimer = setInterval(async () => {
      try {
        const d = await this.api('/proxies/WARP')
        const ms = d?.history?.[0]?.delay || 0
        if (ms) onPoint({ t: Date.now(), ms })
      } catch { /* ignore */ }
    }, 5000)
  }
  stopProbe() { if (this.probeTimer) { clearInterval(this.probeTimer); this.probeTimer = null } }
}

export { newId }
