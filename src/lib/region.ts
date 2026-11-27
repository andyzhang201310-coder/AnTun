/**
 * 国家 / 地区代码 → 国旗图标。
 *
 * 为什么不用国旗 emoji：Windows（含 WebView2）不实现区域指示符，
 * 「🇯🇵」会原样渲染成「JP」两个字母（已在 2026-11-27 用无头 Chrome 截图确认），
 * 所以国旗用打包在 `public/flags/` 的 SVG，按代码拼路径。
 *
 * 立场：台湾省、香港、澳门都是中国的一部分，一律显示中国国旗，
 * 文案用「中国台湾 / 中国香港 / 中国澳门」（英文 Taiwan, China / Hong Kong, China / Macao, China），
 * 绝不出现独立的地区旗帜或国名式表述。
 */

/** 打包进 public/flags 的代码（新增国旗必须同步放进该目录，否则会退化成地球图标） */
const AVAILABLE = new Set([
  'ae', 'au', 'br', 'ca', 'ch', 'cn', 'cz', 'de', 'dk', 'fi', 'fr', 'gb', 'hk', 'id', 'ie', 'il',
  'in', 'it', 'jp', 'kh', 'kr', 'mo', 'my', 'nl', 'no', 'nz', 'ph', 'pl', 'ru', 'se', 'sg', 'th',
  'tr', 'tw', 'ua', 'us', 'vn', 'za',
])

/** 属于中国的地区：显示中国国旗 + 「中国X」表述 */
const CN_REGIONS: Record<string, { zh: string; en: string }> = {
  CN: { zh: '中国', en: 'China' },
  TW: { zh: '中国台湾', en: 'Taiwan, China' },
  HK: { zh: '中国香港', en: 'Hong Kong, China' },
  MO: { zh: '中国澳门', en: 'Macao, China' },
}

/** 2 字母代码 → 国旗文件名（港澳台统一给 cn）；未知或未打包返回空串 */
export function flagCode(code: string | undefined | null): string {
  const c = (code || '').trim().toUpperCase()
  if (!/^[A-Z]{2}$/.test(c)) return ''
  const file = CN_REGIONS[c] ? 'cn' : c.toLowerCase()
  return AVAILABLE.has(file) ? file : ''
}

/** 国旗 SVG 的站点路径，未打包时返回空串 */
export function flagSrc(code: string | undefined | null): string {
  const file = flagCode(code)
  return file ? `/flags/${file}.svg` : ''
}

/** 展示用地区名：港澳台用「中国X」，其余保留 ISO 代码（如 US / JP） */
export function regionName(code: string | undefined | null, lang: 'zh' | 'en' = 'zh'): string {
  const c = (code || '').trim().toUpperCase()
  if (!c) return ''
  const cn = CN_REGIONS[c]
  if (cn) return lang === 'en' ? cn.en : cn.zh
  return c
}

/** 中文 / 英文国家地区名 → 代码（按机场节点命名习惯整理，长词优先匹配） */
const NAME_HINTS: [string, string][] = [
  ['中国台湾', 'TW'], ['台灣', 'TW'], ['台湾', 'TW'], ['台北', 'TW'], ['新北', 'TW'], ['彰化', 'TW'], ['台中', 'TW'], ['高雄', 'TW'],
  ['中国香港', 'HK'], ['香港', 'HK'], ['深港', 'HK'], ['沪港', 'HK'], ['京港', 'HK'],
  ['中国澳门', 'MO'], ['澳门', 'MO'], ['澳門', 'MO'],
  ['新加坡', 'SG'], ['狮城', 'SG'], ['singapore', 'SG'],
  ['日本', 'JP'], ['东京', 'JP'], ['東京', 'JP'], ['大阪', 'JP'], ['名古屋', 'JP'], ['japan', 'JP'], ['tokyo', 'JP'], ['osaka', 'JP'],
  ['韩国', 'KR'], ['韓國', 'KR'], ['首尔', 'KR'], ['首爾', 'KR'], ['korea', 'KR'], ['seoul', 'KR'],
  ['美国', 'US'], ['洛杉机', 'US'], ['洛杉矶', 'US'], ['圣何塞', 'US'], ['西雅图', 'US'], ['纽约', 'US'], ['达拉斯', 'US'], ['硅谷', 'US'], ['芝加哥', 'US'], ['迈阿密', 'US'],
  ['united states', 'US'], ['america', 'US'], ['los angeles', 'US'], ['san jose', 'US'], ['seattle', 'US'], ['new york', 'US'], ['dallas', 'US'], ['miami', 'US'],
  ['英国', 'GB'], ['伦敦', 'GB'], ['united kingdom', 'GB'], ['london', 'GB'],
  ['德国', 'DE'], ['法兰克福', 'DE'], ['germany', 'DE'], ['frankfurt', 'DE'],
  ['法国', 'FR'], ['巴黎', 'FR'], ['france', 'FR'], ['paris', 'FR'],
  ['荷兰', 'NL'], ['阿姆斯特丹', 'NL'], ['netherlands', 'NL'], ['amsterdam', 'NL'],
  ['俄罗斯', 'RU'], ['莫斯科', 'RU'], ['russia', 'RU'], ['moscow', 'RU'],
  ['印度尼西亚', 'ID'], ['印尼', 'ID'], ['雅加达', 'ID'], ['indonesia', 'ID'], ['jakarta', 'ID'],
  ['印度', 'IN'], ['孟买', 'IN'], ['india', 'IN'], ['mumbai', 'IN'],
  ['土耳其', 'TR'], ['伊斯坦布尔', 'TR'], ['turkey', 'TR'], ['istanbul', 'TR'],
  ['巴西', 'BR'], ['圣保罗', 'BR'], ['brazil', 'BR'], ['sao paulo', 'BR'],
  ['澳大利亚', 'AU'], ['澳洲', 'AU'], ['悉尼', 'AU'], ['australia', 'AU'], ['sydney', 'AU'],
  ['加拿大', 'CA'], ['多伦多', 'CA'], ['canada', 'CA'], ['toronto', 'CA'],
  ['越南', 'VN'], ['vietnam', 'VN'],
  ['泰国', 'TH'], ['曼谷', 'TH'], ['thailand', 'TH'], ['bangkok', 'TH'],
  ['马来西亚', 'MY'], ['吉隆坡', 'MY'], ['malaysia', 'MY'], ['kuala lumpur', 'MY'],
  ['菲律宾', 'PH'], ['马尼拉', 'PH'], ['philippines', 'PH'], ['manila', 'PH'],
  ['阿联酋', 'AE'], ['迪拜', 'AE'], ['emirates', 'AE'], ['dubai', 'AE'],
  ['以色列', 'IL'], ['israel', 'IL'],
  ['瑞士', 'CH'], ['苏黎世', 'CH'], ['switzerland', 'CH'], ['zurich', 'CH'],
  ['瑞典', 'SE'], ['sweden', 'SE'],
  ['挪威', 'NO'], ['norway', 'NO'],
  ['芬兰', 'FI'], ['赫尔辛基', 'FI'], ['finland', 'FI'], ['helsinki', 'FI'],
  ['波兰', 'PL'], ['poland', 'PL'],
  ['捷克', 'CZ'], ['布拉格', 'CZ'], ['czech', 'CZ'], ['prague', 'CZ'],
  ['丹麦', 'DK'], ['denmark', 'DK'],
  ['爱尔兰', 'IE'], ['都柏林', 'IE'], ['ireland', 'IE'], ['dublin', 'IE'],
  ['意大利', 'IT'], ['米兰', 'IT'], ['italy', 'IT'], ['milan', 'IT'],
  ['乌克兰', 'UA'], ['ukraine', 'UA'],
  ['南非', 'ZA'], ['south africa', 'ZA'],
  ['新西兰', 'NZ'], ['new zealand', 'NZ'],
  ['柬埔寨', 'KH'], ['cambodia', 'KH'],
]

/** 只在域名后缀上采信的 ccTLD（都是国家顶级域；.tv/.me/.cc/.io 这类已被通用化的不收） */
const CCTLD: Record<string, string> = {
  jp: 'JP', kr: 'KR', sg: 'SG', hk: 'HK', tw: 'TW', mo: 'MO', uk: 'GB', gb: 'GB', de: 'DE',
  fr: 'FR', nl: 'NL', ru: 'RU', in: 'IN', tr: 'TR', br: 'BR', au: 'AU', ca: 'CA', vn: 'VN',
  th: 'TH', my: 'MY', ph: 'PH', id: 'ID', ae: 'AE', il: 'IL', ch: 'CH', se: 'SE', no: 'NO',
  fi: 'FI', pl: 'PL', cz: 'CZ', dk: 'DK', ie: 'IE', it: 'IT', ua: 'UA', za: 'ZA', nz: 'NZ',
  kh: 'KH', cn: 'CN',
}

/** 名称里自带国旗 emoji（机场常用）→ 2 字母代码 */
function codeFromEmoji(name: string): string {
  const m = name.match(/[\u{1F1E6}-\u{1F1FF}]{2}/u)
  if (!m) return ''
  const base = 0x1f1e6
  const [a, b] = [...m[0]].map((ch) => String.fromCharCode(65 + (ch.codePointAt(0)! - base)))
  return `${a}${b}`
}

/** 名称里的 [HK] / (JP) / 【SG】 / US-01 / SG01 之类 2 字母标记（只认已打包的国旗代码，避免把「IP 104」当成 IP 国） */
function codeFromTag(name: string): string {
  const known = (c: string) => {
    const up = c.toUpperCase()
    return flagCode(up) ? up : ''
  }
  const bracketed = name.match(/[\[(（【]\s*([A-Za-z]{2})\s*[\])）】]/)
  if (bracketed) {
    const hit = known(bracketed[1])
    if (hit) return hit
  }
  const prefixed = name.match(/(?:^|[\s\-_])([A-Za-z]{2})[\s\-_]?\d{1,3}(?:[\s\-_]|$)/)
  if (prefixed) return known(prefixed[1])
  return ''
}

/** 从域名 / 主机名末尾的 ccTLD 取（`www.visa.co.jp` → JP） */
function codeFromHost(host: string): string {
  const h = (host || '').trim().toLowerCase()
  if (!h || /^\d+\.\d+\.\d+\.\d+$/.test(h) || h.includes(':')) return ''
  const tld = h.split('.').pop() || ''
  return CCTLD[tld] || ''
}

/**
 * 订阅节点没有真实的落地国信息（机场常用 Cloudflare 优选 IP/域名，出口由 anycast 决定）。
 * 这里按「名称里的国旗 emoji → 中文/英文地名 → 括号里的 2 字母码 → 域名的 ccTLD」
 * 逐级尽力推断，全都判不出来就返回空串（界面显示地球图标），不硬编一个假国家。
 */
export function codeFromNode(name: string, host?: string): string {
  const n = name || ''
  const fromEmoji = codeFromEmoji(n)
  if (fromEmoji) return fromEmoji
  const lower = n.toLowerCase()
  for (const [hint, code] of NAME_HINTS) {
    if (lower.includes(hint)) return code
  }
  const fromTag = codeFromTag(n)
  if (fromTag) return fromTag
  return codeFromHost(host || '')
}

/** 节点名以国旗 emoji 开头时把它去掉：Windows 会把「🇯🇵」渲染成「JP」两个字母，和国旗图标重复 */
export function displayNodeName(name: string): string {
  const raw = name || ''
  const stripped = raw.replace(/^\s*[\u{1F1E6}-\u{1F1FF}]{2}\s*/u, '')
  return stripped.trim() || raw
}
