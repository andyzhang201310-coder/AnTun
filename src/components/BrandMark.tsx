import { useId } from 'react'

/**
 * AnTun 品牌标识：与应用图标同源（assets/logo.svg）。
 * 内联渲染，随主题缩放不失真；渐变 id 用 useId 保证多实例不冲突。
 */
export function BrandMark({ size = 38, radius = 0.226, shadow = true }: { size?: number; radius?: number; shadow?: boolean }) {
  const uid = useId().replace(/[:]/g, '')
  const bgId = `antun-bg-${uid}`
  const glowId = `antun-glow-${uid}`
  const markId = `antun-mark-${uid}`
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 1024 1024"
      role="img"
      aria-label="AnTun"
      style={{
        flex: 'none',
        display: 'block',
        borderRadius: size * radius,
        boxShadow: shadow ? '0 6px 16px rgba(66,87,255,.32)' : 'none',
      }}
    >
      <defs>
        <linearGradient id={bgId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#4257FF" />
          <stop offset="0.52" stopColor="#6C5CFF" />
          <stop offset="1" stopColor="#12C6D8" />
        </linearGradient>
        <radialGradient id={glowId} cx="0.26" cy="0.18" r="0.85">
          <stop offset="0" stopColor="#FFFFFF" stopOpacity="0.34" />
          <stop offset="0.6" stopColor="#FFFFFF" stopOpacity="0.05" />
          <stop offset="1" stopColor="#FFFFFF" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={markId} x1="0.15" y1="0" x2="0.9" y2="1">
          <stop offset="0" stopColor="#FFFFFF" />
          <stop offset="1" stopColor="#E8F4FF" />
        </linearGradient>
      </defs>
      <rect width="1024" height="1024" rx="232" fill={`url(#${bgId})`} />
      <rect width="1024" height="1024" rx="232" fill={`url(#${glowId})`} />
      <g fill="none" stroke="#FFFFFF" strokeLinecap="round">
        <path d="M512 168a344 344 0 0 1 326 234" strokeWidth="22" strokeOpacity="0.55" />
        <path d="M838 610a344 344 0 0 1-262 240" strokeWidth="22" strokeOpacity="0.35" />
        <path d="M238 398a344 344 0 0 1 96-142" strokeWidth="22" strokeOpacity="0.3" />
      </g>
      <circle cx="818" cy="344" r="26" fill="#B8FFF4" fillOpacity="0.95" />
      <circle cx="206" cy="642" r="18" fill="#FFFFFF" fillOpacity="0.6" />
      <g fill="none" stroke={`url(#${markId})`} strokeLinecap="round" strokeLinejoin="round">
        <path d="M512 300 350 726" strokeWidth="94" />
        <path d="M512 300 674 726" strokeWidth="94" />
        <path d="M424 590h176" strokeWidth="78" />
      </g>
    </svg>
  )
}
