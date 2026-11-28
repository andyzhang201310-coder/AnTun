// ============ 备份与同步：快照组装 / 校验 / 导入 ============
//
// 一份备份 = 本机持久化偏好 + 数据（订阅、节点、收藏、测速、机房记录、规则）。
//
// 有意排除的内容：
// - WARP 凭证（私钥 + license）：属于本机身份，泄露等于把账号送人，备份与二维码共享都不带；
// - controlCode：本机控制码，分享出去等于给对端一个入口；
// - autoStart：开机自启是注册表状态，导入到别的机器上也要按那台机器的实际状态来。
//
// 导入有两种语义：
// - replace（覆盖）：设置与数据整体替换，仅保留上面几项本机专属值；
// - merge（合并）：只并入数据（订阅/节点/收藏/规则/测速/机房记录），本机设置一律不动，
//   适合「把我的节点分享给同事，但不改他现在的手感」。

import { useStore } from './store'
import type { Settings, Rule, Subscription, SubNode, SavedNode, NodeStat } from './types'
import type { ColoRecord } from './store'
import { APP_VERSION } from './components/Shell'

export const BACKUP_APP = 'AnTun'
export const BACKUP_KIND = 'antun-settings-backup'
export const BACKUP_VERSION = 1

/** 备份里永远不带走的本机专属设置 */
const DEVICE_LOCAL: (keyof Settings)[] = ['autoStart', 'controlCode']

export interface BackupData {
  settings: Partial<Settings>
  rules: Rule[]
  subscriptions: Subscription[]
  subNodes: SubNode[]
  savedNodes: SavedNode[]
  nodeStats: Record<string, NodeStat>
  coloLog: Record<string, ColoRecord>
  allowedCountries: string[]
}

export interface BackupFile {
  app: string
  kind: string
  version: number
  appVersion: string
  createdAt: number
  /** 便于对端在导入前先看清里面有什么 */
  summary: {
    subscriptions: number
    subNodes: number
    savedNodes: number
    rules: number
  }
  data: BackupData
}

export type ImportMode = 'merge' | 'replace'

export interface ImportResult {
  mode: ImportMode
  subscriptions: number
  subNodes: number
  savedNodes: number
  rules: number
  settingsApplied: number
  /** 导入后前置节点被自动修正时的提示（订阅刷新/换机后原 id 可能已不存在） */
  frontNodeFixed: boolean
}

const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`

/** 组装当前配置快照。字符串是紧凑 JSON：直接用于局域网传输与二维码分享。 */
export function buildBackup(): string {
  const s = useStore.getState()
  const settings: Partial<Settings> = { ...s.settings }
  for (const k of DEVICE_LOCAL) delete settings[k]
  const file: BackupFile = {
    app: BACKUP_APP,
    kind: BACKUP_KIND,
    version: BACKUP_VERSION,
    appVersion: APP_VERSION,
    createdAt: Date.now(),
    summary: {
      subscriptions: s.subscriptions.length,
      subNodes: s.subNodes.length,
      savedNodes: s.savedNodes.length,
      rules: s.rules.filter((r) => !r.builtin).length,
    },
    data: {
      settings,
      rules: s.rules.filter((r) => !r.builtin),
      subscriptions: s.subscriptions,
      subNodes: s.subNodes,
      savedNodes: s.savedNodes,
      nodeStats: s.nodeStats,
      coloLog: s.coloLog,
      allowedCountries: s.allowedCountries,
    },
  }
  return JSON.stringify(file)
}

/** 备份体积（字节），用于界面提示与二维码共享前的体量检查。 */
export function backupBytes(text: string): number {
  return new TextEncoder().encode(text).length
}

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/** 校验并解析备份文本；错误信息直接面向用户。 */
export function parseBackup(text: string): BackupFile {
  const raw = text.trim()
  if (!raw) throw new Error('内容为空')
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    throw new Error('不是合法的 JSON —— 请确认复制的是完整备份内容')
  }
  if (!isObj(json)) throw new Error('备份格式不正确')
  if (json.app !== BACKUP_APP || json.kind !== BACKUP_KIND) {
    throw new Error('这不是 AnTun 的备份文件')
  }
  const ver = Number(json.version)
  if (!Number.isFinite(ver) || ver < 1) throw new Error('备份版本无法识别')
  if (ver > BACKUP_VERSION) throw new Error(`备份来自更新版本的 AnTun（v${ver}），请先升级`)
  if (!isObj(json.data)) throw new Error('备份缺少数据段')
  const data = json.data as Record<string, unknown>
  const arr = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : [])
  const obj = <T,>(v: unknown): Record<string, T> => (isObj(v) ? (v as Record<string, T>) : {})
  return {
    app: BACKUP_APP,
    kind: BACKUP_KIND,
    version: ver,
    appVersion: typeof json.appVersion === 'string' ? json.appVersion : '',
    createdAt: Number(json.createdAt) || 0,
    summary: {
      subscriptions: arr(data.subscriptions).length,
      subNodes: arr(data.subNodes).length,
      savedNodes: arr(data.savedNodes).length,
      rules: arr(data.rules).length,
    },
    data: {
      settings: obj<Settings[keyof Settings]>(data.settings) as Partial<Settings>,
      rules: arr<Rule>(data.rules).filter((r) => r && typeof r.value === 'string'),
      subscriptions: arr<Subscription>(data.subscriptions).filter((x) => x && typeof x.url === 'string'),
      subNodes: arr<SubNode>(data.subNodes).filter((x) => x && typeof x.config === 'string'),
      savedNodes: arr<SavedNode>(data.savedNodes).filter((x) => x && typeof x.config === 'string'),
      nodeStats: obj<NodeStat>(data.nodeStats),
      coloLog: obj<ColoRecord>(data.coloLog),
      allowedCountries: Array.isArray(data.allowedCountries)
        ? data.allowedCountries.filter((c): c is string => typeof c === 'string')
        : [],
    },
  }
}

/**
 * 按当前设置的字段与类型白名单过滤外来设置。
 * 直接 spread 外部 JSON 会带进未知键（甚至改到内部状态），因此逐键比对类型。
 */
function sanitizeSettings(input: Partial<Settings>, base: Settings): Partial<Settings> {
  const out: Partial<Settings> = {}
  const enums: Partial<Record<keyof Settings, readonly string[]>> = {
    theme: ['light', 'dark', 'system'],
    lang: ['zh', 'en'],
    connMode: ['warp', 'subscription'],
    proto: ['awg', 'wg', 'gool', 'masque', 'masque-h2', 'masque-mm'],
    captureMode: ['proxy', 'tun'],
    ipFamily: ['v4', 'v6', 'dual'],
    endpointRank: ['ping', 'loss', 'colo'],
    dnsMode: ['preset', 'custom', 'off'],
    subExit: ['warp', 'node'],
    subSort: ['default', 'delay', 'speed'],
    savedSort: ['default', 'delay-asc', 'delay-desc'],
    nodeProtoFilter: ['all', 'awg', 'wg', 'gool', 'masque', 'masque-h2', 'masque-mm'],
    logsTab: ['runtime', 'history', 'diag'],
    proxyMode: ['custom', 'bypass-mainland', 'global'],
  }
  for (const [k, v] of Object.entries(input)) {
    const key = k as keyof Settings
    if (!(key in base)) continue
    if (DEVICE_LOCAL.includes(key)) continue
    if (typeof v !== typeof base[key]) continue
    const allowed = enums[key]
    if (allowed && !allowed.includes(String(v))) continue
    ;(out as Record<string, unknown>)[k] = v
  }
  return out
}

/** 前置节点 id 可能因订阅刷新或换机而失效，导入后兜底到第一个可用节点。 */
function repairFrontNode(settings: Settings, subNodes: SubNode[], savedNodes: SavedNode[]): { settings: Settings; fixed: boolean } {
  const id = settings.frontNodeId
  if (!id) return { settings, fixed: false }
  if (subNodes.some((n) => n.id === id) || savedNodes.some((n) => n.id === id)) {
    return { settings, fixed: false }
  }
  const fallback = savedNodes[0]?.id || subNodes[0]?.id || ''
  return { settings: { ...settings, frontNodeId: fallback }, fixed: true }
}

const ruleKey = (r: Rule) => `${r.type}|${r.value}|${r.policy}`
const nodeKey = (n: { config?: string; id?: string }) => n.config || n.id || ''

/** 机房记录只留最近 11 条（与 recordColo 的裁剪口径一致）。 */
function trimColo(log: Record<string, ColoRecord>): Record<string, ColoRecord> {
  return Object.fromEntries(
    Object.entries(log)
      .sort((a, b) => (b[1]?.ts || 0) - (a[1]?.ts || 0))
      .slice(0, 11),
  )
}

/**
 * 应用一份备份。
 * 注意：这里直接 setState，不走 setSetting —— 导入是批量替换，
 * 逐项 set 会触发几十次落盘与重渲染。
 */
export function applyBackup(text: string, mode: ImportMode): ImportResult {
  const file = parseBackup(text)
  const cur = useStore.getState()
  const incoming = file.data
  const incomingSettings = sanitizeSettings(incoming.settings, cur.settings)

  if (mode === 'replace') {
    const nextSettings: Settings = {
      ...cur.settings,
      ...incomingSettings,
      // 本机专属项一律以本机为准
      autoStart: cur.settings.autoStart,
      controlCode: cur.settings.controlCode,
    }
    const repaired = repairFrontNode(nextSettings, incoming.subNodes, incoming.savedNodes)
    const state = {
      settings: repaired.settings,
      rules: [
        ...cur.rules.filter((r) => r.builtin),
        ...incoming.rules.map((r) => ({ ...r, id: uid(), builtin: false })),
      ],
      subscriptions: incoming.subscriptions.map((s) => ({ ...s, id: s.id || uid() })),
      subNodes: incoming.subNodes,
      savedNodes: incoming.savedNodes,
      nodeStats: incoming.nodeStats,
      coloLog: trimColo(incoming.coloLog),
      allowedCountries: incoming.allowedCountries,
    }
    useStore.setState(state)
    return {
      mode,
      subscriptions: state.subscriptions.length,
      subNodes: state.subNodes.length,
      savedNodes: state.savedNodes.length,
      rules: state.rules.filter((r) => !r.builtin).length,
      settingsApplied: Object.keys(incomingSettings).length,
      frontNodeFixed: repaired.fixed,
    }
  }

  // ---- 合并：只并数据，设置保持本机 ----
  const subByUrl = new Map(cur.subscriptions.map((s) => [s.url, s]))
  // 同一个订阅在本机可能已有别的 id：节点的 subId 必须跟着改，
  // 否则删除订阅时这些节点不会被一起清掉，变成看不见的孤儿
  const idRemap = new Map<string, string>()
  for (const s of incoming.subscriptions) {
    const local = subByUrl.get(s.url)
    if (local) {
      idRemap.set(s.id, local.id)
      continue
    }
    const merged = { ...s, id: s.id || uid() }
    subByUrl.set(s.url, merged)
    idRemap.set(s.id, merged.id)
  }
  const seenSub = new Set(cur.subNodes.map(nodeKey))
  const mergedSubNodes = [...cur.subNodes]
  for (const n of incoming.subNodes) {
    const key = nodeKey(n)
    if (!key || seenSub.has(key)) continue
    seenSub.add(key)
    mergedSubNodes.push({ ...n, subId: idRemap.get(n.subId) ?? n.subId })
  }
  const seenSaved = new Set(cur.savedNodes.map((n) => n.config))
  const mergedSaved = [...cur.savedNodes]
  for (const n of incoming.savedNodes) {
    if (seenSaved.has(n.config)) continue
    seenSaved.add(n.config)
    mergedSaved.push(n)
  }
  const seenRule = new Set(cur.rules.map(ruleKey))
  const mergedRules = [...cur.rules]
  for (const r of incoming.rules) {
    if (seenRule.has(ruleKey(r))) continue
    seenRule.add(ruleKey(r))
    mergedRules.push({ ...r, id: uid(), builtin: false })
  }
  const repaired = repairFrontNode(cur.settings, mergedSubNodes, mergedSaved)
  const state = {
    settings: repaired.settings,
    rules: mergedRules,
    subscriptions: [...subByUrl.values()],
    subNodes: mergedSubNodes,
    savedNodes: mergedSaved,
    nodeStats: { ...cur.nodeStats, ...incoming.nodeStats },
    coloLog: trimColo({ ...cur.coloLog, ...incoming.coloLog }),
    allowedCountries: [...new Set([...cur.allowedCountries, ...incoming.allowedCountries])],
  }
  useStore.setState(state)
  return {
    mode,
    subscriptions: state.subscriptions.length,
    subNodes: state.subNodes.length,
    savedNodes: state.savedNodes.length,
    rules: state.rules.filter((r) => !r.builtin).length,
    settingsApplied: 0,
    frontNodeFixed: repaired.fixed,
  }
}

/** 从任意文本里提取局域网链接（二维码内容就是链接，粘贴时可能带说明文字）。 */
export function extractUrl(text: string): string | null {
  const m = text.match(/https?:\/\/[^\s"'<>]+/i)
  return m ? m[0] : null
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}
