import { useEffect, useState } from 'react'
import { AppWindow } from 'lucide-react'

/**
 * 进程图标：从 exe 里抽出来的真实应用图标。
 *
 * 连接明细每 2 秒刷一次，同一进程会出现很多行，所以这里做进程内缓存：
 * 每个进程名只向后端要一次（后端自己也有缓存），取不到就退化成通用窗口图标。
 */
const cache = new Map<string, string | null>()
const pending = new Map<string, Promise<string | null>>()

function loadIcon(name: string): Promise<string | null> {
  const key = name.toLowerCase()
  if (cache.has(key)) return Promise.resolve(cache.get(key) ?? null)
  const running = pending.get(key)
  if (running) return running
  const desk = (window as any).AnTunDesktop
  if (!desk?.appIcon) {
    cache.set(key, null)
    return Promise.resolve(null)
  }
  const task: Promise<string | null> = desk
    .appIcon(name)
    .then((url: string | null) => {
      cache.set(key, url ?? null)
      return url ?? null
    })
    .catch(() => {
      cache.set(key, null)
      return null
    })
    .finally(() => pending.delete(key))
  pending.set(key, task)
  return task
}

export function AppIcon({ name, size = 15 }: { name?: string; size?: number }) {
  const [src, setSrc] = useState<string | null>(() => (name ? cache.get(name.toLowerCase()) ?? null : null))

  useEffect(() => {
    if (!name) {
      setSrc(null)
      return
    }
    const cached = cache.get(name.toLowerCase())
    if (cached !== undefined) {
      setSrc(cached)
      return
    }
    let alive = true
    void loadIcon(name).then((url) => {
      if (alive) setSrc(url)
    })
    return () => {
      alive = false
    }
  }, [name])

  if (!src) {
    return <AppWindow size={size - 2} className="muted" style={{ flexShrink: 0 }} />
  }
  return <img className="app-icon" src={src} alt="" width={size} height={size} draggable={false} />
}
