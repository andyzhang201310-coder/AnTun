import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type {
  Settings, ConnState, Endpoint, Rule, LogEntry, HistoryStep,
  LatencyPoint, PageId, Lang, Theme, Platform, Subscription, SubNode,
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
  // 运行时
  conn: ConnState
  endpoints: Endpoint[]
  scanning: boolean
  rules: Rule[]
  logs: LogEntry[]
  history: HistoryStep[]
  latencyPoints: LatencyPoint[]
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
  addRule: (r: Omit<Rule, 'id'>) => void
  toggleRule: (id: string) => void
  removeRule: (id: string) => void
  log: (level: LogEntry['level'], message: string) => void
  addHistory: (text: string, ok?: boolean) => void
  pushLatency: (p: LatencyPoint) => void
  clearLogs: () => void
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
      conn: DEFAULT_CONN,
      endpoints: [],
      scanning: false,
      rules: DEFAULT_RULES,
      logs: [],
      history: [],
      latencyPoints: [],
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
      addRule: (r) => set((s) => ({ rules: [...s.rules, { ...r, id: newId() }] })),
      toggleRule: (id) => set((s) => ({ rules: s.rules.map((r) => r.id === id ? { ...r, enabled: !r.enabled } : r) })),
      removeRule: (id) => set((s) => ({ rules: s.rules.filter((r) => r.id !== id || r.builtin) })),
      log: (level, message) => set((s) => ({
        logs: [...s.logs.slice(-299), { id: newId(), level, time: Date.now(), message }],
      })),
      addHistory: (text, ok = true) => set((s) => ({
        history: [...s.history.slice(-99), { id: newId(), time: Date.now(), text, ok }],
      })),
      pushLatency: (p) => set((s) => ({ latencyPoints: [...s.latencyPoints.slice(-59), p] })),
      clearLogs: () => set({ logs: [], history: [] }),
    }),
    {
      name: 'antun-prefs',
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

/** 把语言/主题同步到 document（供主题切换调用） */
export function applyAppearance(theme: Theme, lang: Lang, systemDark: boolean) {
  const dark = theme === 'dark' || (theme === 'system' && systemDark)
  document.documentElement.dataset.theme = dark ? 'dark' : 'light'
  document.documentElement.lang = lang
}
