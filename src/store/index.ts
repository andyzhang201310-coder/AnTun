import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type { StateStorage } from 'zustand/middleware'
import type {
  Settings, ConnState, Endpoint, Rule, LogEntry, HistoryStep,
  LatencyPoint, PageId, Lang, Theme, Platform, Subscription, SubNode, NodeStat, SavedNode, ConnEntry,
} from '../types'

const DEFAULT_SETTINGS: Settings = {
  theme: 'light',
  lang: 'zh',
  connMode: 'warp',
  subscriptionUrl: '',
  frontNodeId: '',
  proto: 'awg',
  rescan: false,
  psiphon: false,
  psiphonRegion: '',
  autoRepair: true,
  captureMode: 'proxy',
  mixedPort: 7890,
  apiPort: 9090,
  allowLan: false,
  ipFamily: 'v4',
  mtu: 0,
  endpointRank: 'ping',
  dnsMode: 'preset',
  dnsCustom: '',
  dnsLeak: true,
  subExit: 'node',
  subViaWarp: false,
  subSort: 'default',
  savedSort: 'default',
  nodeProtoFilter: 'all',
  logsTab: 'runtime',
  proxyMode: 'custom',
  domainDirect: '',
  domainProxy: '',
  adBlock: true,
  autoConnect: false,
  autoStart: false,
  rememberPage: true,
  timeoutSec: 30,
  controlCode: 'ANTU-XXXX-XXXX-XXXX',
}

const DEFAULT_CONN: ConnState = {
  connected: false,
  connecting: false,
  protocol: 'awg',
  endpoint: null,
  exitIp: '',
  country: '',
  colo: '',
  city: '',
  latency: 0,
  up: 0,
  down: 0,
  upRate: 0,
  downRate: 0,
  startedAt: null,
  session: '',
}

const DEFAULT_RULES: Rule[] = [
  { id: 'b1', type: 'IP-CIDR', value: '10.0.0.0/8', policy: 'DIRECT', enabled: true, builtin: true },
  { id: 'b2', type: 'IP-CIDR', value: '192.168.0.0/16', policy: 'DIRECT', enabled: true, builtin: true },
  { id: 'b3', type: 'DOMAIN-SUFFIX', value: 'local', policy: 'DIRECT', enabled: true, builtin: true },
  { id: 'b4', type: 'GEOSITE', value: 'cn', policy: 'DIRECT', enabled: true, builtin: true },
  { id: 'b5', type: 'MATCH', value: '', policy: 'WARP', enabled: true, builtin: true },
]

let uid = 0
export const newId = () => `${Date.now().toString(36)}-${(uid++).toString(36)}`

/**
 * 端点 → 实际出口机房的观测记录。
 * Cloudflare 的 anycast 出口由就近路由决定，客户端无法指定；
 * 但不同端点段可能落到不同 PoP，所以把每次连接的真实结果记下来，
 * 用户就能按「我要 HKG」反查该锁哪个端点 —— 这是唯一可手动调整的路径。
 */
export interface ColoRecord {
  /** 端点 id（awg:1.2.3.4:2408），'default' 表示用凭证端点 */
  id: string
  host: string
  port: number
  country: string
  colo: string
  city: string
  /** 最近一次观测到该结果的毫秒时间戳 */
  ts: number
  /** 观测次数，用于排序稳定性 */
  hits: number
}

interface AppStore {
  // 持久化偏好
  settings: Settings
  page: PageId
  pinnedId: string | null
  allowedCountries: string[]
  /** 端点 → 实测出口机房（持久化，只保留最近观测） */
  coloLog: Record<string, ColoRecord>
  subscriptions: Subscription[]
  subNodes: SubNode[]
  /** 收藏节点：存完整 config，与订阅解耦 */
  savedNodes: SavedNode[]
  nodeStats: Record<string, NodeStat>
  // 运行时
  conn: ConnState
  endpoints: Endpoint[]
  scanning: boolean
  /**
   * 订阅节点延迟测试进行中。放 store 而不是组件 state：
   * 测速会在首页触发，用户切页后首页卸载，按钮的「测试中」状态不能丢；
   * 同时也是重入锁，避免连点起两次测速核心。
   */
  nodeTesting: boolean
  /**
   * 已受理「取消连接」但连接流程还没真正退出。
   * 放在 store 而不是组件里：切页时首页会卸载，这个提示不能丢。
   */
  cancelling: boolean
  /**
   * 上一次连接失败的原始原因。
   * 之前错误只写进「日志」页，用户在首页只能看到圈一直转完又回到未连接，
   * 不知道是凭证失效、端点不可达还是被网络阻断。现在留在首页提示区，并给出下一步动作。
   */
  lastError: string
  /**
   * 节点页搜索词。只在本进程内保留：切页不丢（页面是条件渲染的），
   * 但不落盘 —— 否则下次开机打开节点页，列表是被过滤过的，容易以为端点没了。
   */
  nodeQuery: string
  /** 收藏页搜索词：同 nodeQuery，切页保留、重启清空 */
  savedQuery: string
  rules: Rule[]
  logs: LogEntry[]
  history: HistoryStep[]
  platform: Platform
  // 动作
  setSetting: <K extends keyof Settings>(key: K, value: Settings[K]) => void
  setSettings: (s: Partial<Settings>) => void
  resetSettings: () => void
  setPage: (p: PageId) => void
  setPlatform: (p: Platform) => void
  setConn: (c: Partial<ConnState>) => void
  setEndpoints: (e: Endpoint[]) => void
  setScanning: (b: boolean) => void
  setNodeTesting: (b: boolean) => void
  setCancelling: (b: boolean) => void
  setLastError: (e: string) => void
  setNodeQuery: (q: string) => void
  setSavedQuery: (q: string) => void
  pinEndpoint: (id: string | null) => void
  toggleCountry: (c: string) => void
  recordColo: (r: Omit<ColoRecord, 'ts' | 'hits'>) => void
  clearColoLog: () => void
  addSubscription: (s: Subscription) => void
  removeSubscription: (id: string) => void
  setSubNodes: (nodes: SubNode[]) => void
  /** 收藏节点；按 config 去重，返回实际新增条数 */
  saveNodes: (nodes: (SubNode | SavedNode)[], source?: string) => number
  removeSaved: (ids: string[]) => void
  updateSavedStats: (stats: NodeStat[]) => void
  mergeNodeStats: (stats: NodeStat[]) => void
  clearNodeStats: () => void
  addRule: (r: Omit<Rule, 'id'>) => void
  toggleRule: (id: string) => void
  removeRule: (id: string) => void
  log: (level: LogEntry['level'], message: string) => void
  addHistory: (text: string, ok?: boolean) => void
  clearLogs: () => void
}

/**
 * 合并落盘：订阅节点每条都带完整配置（YAML 可能几 KB），
 * zustand persist 默认每次 set 都同步 JSON.stringify + 写 localStorage。
 * 节点多时，一次切换页面（page 也持久化）就会卡主线程几百毫秒，
 * 连接后的流量刷新更是每秒写一次。这里改成 500ms 合并写入。
 */
const pendingWrites = new Map<string, string>()
let flushTimer: number | null = null

export function flushPersist() {
  if (flushTimer !== null) {
    window.clearTimeout(flushTimer)
    flushTimer = null
  }
  for (const [name, value] of pendingWrites) {
    try { localStorage.setItem(name, value) } catch { /* 存储已满时忽略，避免阻塞 UI */ }
  }
  pendingWrites.clear()
}

const persistStorage: StateStorage = {
  getItem: (name) => {
    try { return localStorage.getItem(name) } catch { return null }
  },
  setItem: (name, value) => {
    pendingWrites.set(name, value)
    if (typeof window === 'undefined') return
    if (flushTimer !== null) window.clearTimeout(flushTimer)
    flushTimer = window.setTimeout(flushPersist, 500)
  },
  removeItem: (name) => {
    pendingWrites.delete(name)
    try { localStorage.removeItem(name) } catch { /* ignore */ }
  },
}

if (typeof window !== 'undefined') {
  // 关闭/刷新前把待写入内容落盘，避免丢设置
  window.addEventListener('pagehide', flushPersist)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushPersist()
  })
}

export const useStore = create<AppStore>()(
  persist(
    (set) => ({
      settings: DEFAULT_SETTINGS,
      page: 'home',
      pinnedId: null,
      allowedCountries: [],
      coloLog: {},
      subscriptions: [],
      subNodes: [],
      savedNodes: [],
      nodeStats: {},
      conn: DEFAULT_CONN,
      endpoints: [],
      scanning: false,
      nodeTesting: false,
      cancelling: false,
      lastError: '',
      nodeQuery: '',
      savedQuery: '',
      rules: DEFAULT_RULES,
      logs: [],
      history: [],
      platform: 'web',

      setSetting: (key, value) => set((s) => ({ settings: { ...s.settings, [key]: value } })),
      setSettings: (partial) => set((s) => ({ settings: { ...s.settings, ...partial } })),
      resetSettings: () => set({ settings: { ...DEFAULT_SETTINGS } }),
      setPage: (page) => set({ page }),
      setPlatform: (platform) => set({ platform }),
      setConn: (partial) => set((s) => ({ conn: { ...s.conn, ...partial } })),
      setEndpoints: (endpoints) => set({ endpoints }),
      setScanning: (scanning) => set({ scanning }),
      setNodeTesting: (nodeTesting) => set({ nodeTesting }),
      setCancelling: (cancelling) => set({ cancelling }),
      setLastError: (lastError) => set({ lastError }),
      setNodeQuery: (nodeQuery) => set({ nodeQuery }),
      setSavedQuery: (savedQuery) => set({ savedQuery }),
      pinEndpoint: (pinnedId) => set({ pinnedId }),
      toggleCountry: (c) => set((s) => ({
        allowedCountries: s.allowedCountries.includes(c)
          ? s.allowedCountries.filter((x) => x !== c)
          : [...s.allowedCountries, c],
      })),
      recordColo: (r) => set((s) => {
        // 以 host:port 为键：机房取决于端点地址，与协议无关，
        // 换协议后同一条记录仍然可用（旧版本用 `协议:host:port`，读取时按 host:port 归并）
        const key = `${r.host}:${r.port}`
        const prev = s.coloLog[key]
        const hits = (prev?.hits ?? 0) + 1
        // 只保留最近 12 条观测，避免长期使用后 localStorage 无限增长
        const rest = Object.entries(s.coloLog)
          .filter(([k]) => k !== key)
          .sort((a, b) => b[1].ts - a[1].ts)
          .slice(0, 11)
        return {
          coloLog: {
            ...Object.fromEntries(rest),
            [key]: { ...r, id: key, ts: Date.now(), hits },
          },
        }
      }),
      clearColoLog: () => set({ coloLog: {} }),
      addSubscription: (sub) => set((s) => ({
        subscriptions: [sub, ...s.subscriptions.filter((x) => x.url !== sub.url)],
      })),
      removeSubscription: (id) => set((s) => ({
        subscriptions: s.subscriptions.filter((x) => x.id !== id),
        subNodes: s.subNodes.filter((n) => n.subId !== id && n.subId !== s.subscriptions.find((x) => x.id === id)?.url),
      })),
      setSubNodes: (subNodes) => set({ subNodes }),
      saveNodes: (items, source = '') => {
        let added = 0
        set((s) => {
          const seen = new Set(s.savedNodes.map((n) => n.config))
          const next = [...s.savedNodes]
          for (const it of items) {
            const cfg = (it as SubNode).config
            if (!cfg || seen.has(cfg)) continue
            seen.add(cfg)
            added++
            next.push({
              id: newId(),
              name: it.name,
              nodeType: it.nodeType,
              server: it.server,
              port: it.port,
              config: cfg,
              source: source || ('source' in it ? String((it as SavedNode).source ?? '') : ''),
              note: 'note' in it ? (it as SavedNode).note : undefined,
              savedAt: Date.now(),
              delay: 'delay' in it ? (it as SavedNode).delay : undefined,
              speed: 'speed' in it ? (it as SavedNode).speed : undefined,
            })
          }
          return added ? { savedNodes: next } : {}
        })
        return added
      },
      removeSaved: (ids) => set((s) => ({ savedNodes: s.savedNodes.filter((n) => !ids.includes(n.id)) })),
      updateSavedStats: (stats) => set((s) => {
        const map = new Map(stats.map((st) => [st.id, st]))
        if (!map.size) return {}
        return {
          savedNodes: s.savedNodes.map((n) => {
            const st = map.get(n.id)
            if (!st) return n
            return {
              ...n,
              delay: st.delay > 0 ? st.delay : n.delay,
              speed: st.speed > 0 ? st.speed : n.speed,
              testedAt: Date.now(),
            }
          }),
        }
      }),
      mergeNodeStats: (stats) => set((s) => {
        const next = { ...s.nodeStats }
        for (const st of stats) {
          if (!st?.id) continue
          const prev = next[st.id]
          const hasDelay = st.delay > 0
          const hasSpeed = st.speed > 0
          next[st.id] = {
            id: st.id,
            // 延迟与速度分两阶段返回：只更新本阶段测到的值，另一项沿用上次结果
            delay: hasDelay ? st.delay : (hasSpeed ? (prev?.delay ?? -1) : st.delay),
            speed: hasSpeed ? st.speed : (prev?.speed ?? 0),
            bytes: st.bytes || (prev?.bytes ?? 0),
            error: st.error || (hasDelay || hasSpeed ? '' : (prev?.error ?? '')),
          }
        }
        return { nodeStats: next }
      }),
      clearNodeStats: () => set({ nodeStats: {} }),
      addRule: (r) => set((s) => ({ rules: [...s.rules, { ...r, id: newId() }] })),
      toggleRule: (id) => set((s) => ({ rules: s.rules.map((r) => r.id === id ? { ...r, enabled: !r.enabled } : r) })),
      removeRule: (id) => set((s) => ({ rules: s.rules.filter((r) => r.id !== id || r.builtin) })),
      log: (level, message) => set((s) => ({
        logs: [...s.logs.slice(-299), { id: newId(), level, time: Date.now(), message }],
      })),
      addHistory: (text, ok = true) => set((s) => ({
        history: [...s.history.slice(-99), { id: newId(), time: Date.now(), text, ok }],
      })),
      clearLogs: () => set({ logs: [], history: [] }),
    }),
    {
      name: 'antun-prefs',
      storage: createJSONStorage(() => persistStorage),
      // 老版本存档缺少新增设置项：用默认值补齐，避免新功能读到 undefined
      merge: (persisted, current) => {
        const saved = (persisted || {}) as Partial<typeof current>
        return {
          ...current,
          ...saved,
          settings: { ...current.settings, ...(saved.settings || {}) },
        }
      },
      partialize: (s) => ({
        settings: s.settings,
        page: s.page,
        pinnedId: s.pinnedId,
        allowedCountries: s.allowedCountries,
        coloLog: s.coloLog,
        subscriptions: s.subscriptions,
        subNodes: s.subNodes,
        savedNodes: s.savedNodes,
        // 延迟/速度结果要落盘：首页下拉按延迟排序，重启后丢掉就白测了
        nodeStats: s.nodeStats,
        rules: s.rules,
      }),
    },
  ),
)

/**
 * 实时数据单独一个 store（不持久化、不参与 antun-prefs）。
 * 连接期间这里每秒都会更新，如果混在主 store 里，所有 `useStore()` 的页面
 * 都会被一起重渲染（节点列表几百行时尤其明显），并触发一次大 JSON 落盘。
 */
interface LiveStore {
  up: number
  down: number
  upRate: number
  downRate: number
  latencyPoints: LatencyPoint[]
  /**
   * 每秒一帧的上下行速率，用于波形图（约 1 分钟窗口）。
   * upTotal/downTotal 是该帧当时的累计字节数：采样间隔抖动时用它算窗口均值，
   * 比直接平均每秒速率更准（漏读一拍也不会把均值算低）。
   */
  ratePoints: { t: number; up: number; down: number; upTotal: number; downTotal: number }[]
  /** 当前经过隧道的连接（首页「连接设备」），约 2 秒刷新一次 */
  conns: ConnEntry[]
  /** 每秒心跳：即使读取流量失败，首页的会话时长也能继续走字 */
  tick: number
  setTraffic: (t: { up: number; down: number; upRate: number; downRate: number }) => void
  pushLatency: (p: LatencyPoint) => void
  setConns: (c: ConnEntry[]) => void
  bumpTick: () => void
  resetLive: () => void
}

const EMPTY_LIVE = { up: 0, down: 0, upRate: 0, downRate: 0 }

export const useLive = create<LiveStore>()((set) => ({
  ...EMPTY_LIVE,
  latencyPoints: [],
  ratePoints: [],
  conns: [],
  tick: 0,
  setTraffic: (t) => set((s) => ({
    ...t,
    ratePoints: [...s.ratePoints.slice(-89), { t: Date.now(), up: t.upRate, down: t.downRate, upTotal: t.up, downTotal: t.down }],
  })),
  pushLatency: (p) => set((s) => ({ latencyPoints: [...s.latencyPoints.slice(-59), p] })),
  setConns: (conns) => set({ conns }),
  bumpTick: () => set((s) => ({ tick: s.tick + 1 })),
  resetLive: () => set({ ...EMPTY_LIVE, latencyPoints: [], ratePoints: [], conns: [], tick: 0 }),
}))

/** 把语言/主题同步到 document（供主题切换调用） */
export function applyAppearance(theme: Theme, lang: Lang, systemDark: boolean) {
  const dark = theme === 'dark' || (theme === 'system' && systemDark)
  document.documentElement.dataset.theme = dark ? 'dark' : 'light'
  document.documentElement.lang = lang
}
