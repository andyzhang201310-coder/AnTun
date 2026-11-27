import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type { StateStorage } from 'zustand/middleware'
import type {
  Settings, ConnState, Endpoint, Rule, LogEntry, HistoryStep,
  LatencyPoint, PageId, Lang, Theme, Platform, Subscription, SubNode, NodeStat,
} from '../types'

const DEFAULT_SETTINGS: Settings = {
  theme: 'light',
  lang: 'zh',
  connMode: 'warp',
  subscriptionUrl: '',
  frontNodeId: '',
  proto: 'awg',
  outerProto: 'wg',
  innerProto: 'wg',
  rescan: false,
  psiphon: false,
  psiphonRegion: '',
  warpInWarp: false,
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
  proxyMode: 'custom',
  domainDirect: '',
  domainProxy: '',
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

interface AppStore {
  // 持久化偏好
  settings: Settings
  page: PageId
  pinnedId: string | null
  allowedCountries: string[]
  subscriptions: Subscription[]
  subNodes: SubNode[]
  nodeStats: Record<string, NodeStat>
  // 运行时
  conn: ConnState
  endpoints: Endpoint[]
  scanning: boolean
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
  pinEndpoint: (id: string | null) => void
  toggleCountry: (c: string) => void
  addSubscription: (s: Subscription) => void
  removeSubscription: (id: string) => void
  setSubNodes: (nodes: SubNode[]) => void
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
      subscriptions: [],
      subNodes: [],
      nodeStats: {},
      conn: DEFAULT_CONN,
      endpoints: [],
      scanning: false,
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
      pinEndpoint: (pinnedId) => set({ pinnedId }),
      toggleCountry: (c) => set((s) => ({
        allowedCountries: s.allowedCountries.includes(c)
          ? s.allowedCountries.filter((x) => x !== c)
          : [...s.allowedCountries, c],
      })),
      addSubscription: (sub) => set((s) => ({
        subscriptions: [sub, ...s.subscriptions.filter((x) => x.url !== sub.url)],
      })),
      removeSubscription: (id) => set((s) => ({
        subscriptions: s.subscriptions.filter((x) => x.id !== id),
        subNodes: s.subNodes.filter((n) => n.subId !== id && n.subId !== s.subscriptions.find((x) => x.id === id)?.url),
      })),
      setSubNodes: (subNodes) => set({ subNodes }),
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
        subscriptions: s.subscriptions,
        subNodes: s.subNodes,
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
  /** 每秒心跳：即使读取流量失败，首页的会话时长也能继续走字 */
  tick: number
  setTraffic: (t: { up: number; down: number; upRate: number; downRate: number }) => void
  pushLatency: (p: LatencyPoint) => void
  bumpTick: () => void
  resetLive: () => void
}

const EMPTY_LIVE = { up: 0, down: 0, upRate: 0, downRate: 0 }

export const useLive = create<LiveStore>()((set) => ({
  ...EMPTY_LIVE,
  latencyPoints: [],
  tick: 0,
  setTraffic: (t) => set(t),
  pushLatency: (p) => set((s) => ({ latencyPoints: [...s.latencyPoints.slice(-59), p] })),
  bumpTick: () => set((s) => ({ tick: s.tick + 1 })),
  resetLive: () => set({ ...EMPTY_LIVE, latencyPoints: [], tick: 0 }),
}))

/** 把语言/主题同步到 document（供主题切换调用） */
export function applyAppearance(theme: Theme, lang: Lang, systemDark: boolean) {
  const dark = theme === 'dark' || (theme === 'system' && systemDark)
  document.documentElement.dataset.theme = dark ? 'dark' : 'light'
  document.documentElement.lang = lang
}
