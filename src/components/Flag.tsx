import { Globe2 } from 'lucide-react'
import { flagSrc, regionName } from '../lib/region'

/**
 * 国旗图标。用打包的 SVG 而不是 emoji：Windows 的 Segoe UI Emoji 不含区域指示符，
 * 「🇯🇵」会渲染成「JP」两个字母（已截图确认），所以这里直接引用 /flags/*.svg。
 * 代码判不出来时退化成中性的地球图标，不猜。
 */
export function Flag({ code, lang = 'zh', size = 16, globe = true, title, eager = false }: {
  code?: string | null
  lang?: 'zh' | 'en'
  size?: number
  /** 未知地区是否显示地球图标（列表里用 true 保持对齐，标题行可用 false） */
  globe?: boolean
  title?: string
  /** 展开后才插入 DOM 的场景（下拉菜单）用 true，避免懒加载判定为屏外而不加载 */
  eager?: boolean
}) {
  const src = flagSrc(code)
  const label = regionName(code, lang)
  if (!src) {
    return globe
      ? <Globe2 size={Math.max(11, size - 3)} className="flag-none" aria-label={title || label || undefined} />
      : null
  }
  return (
    <img
      className="flag"
      src={src}
      width={size}
      height={Math.round(size * 0.75)}
      alt={label}
      title={title || label}
      loading={eager ? 'eager' : 'lazy'}
      decoding="async"
    />
  )
}
