/**
 * 延迟 / 速度的着色档位。
 *
 * 阈值集中在这里，订阅节点页（模式页）和收藏页共用同一套，
 * 避免同一个数值在两个页面显示成不同颜色。
 * 配套样式：index.css 里的 .stat-good / .stat-mid / .stat-bad / .stat-idle
 */

/** 延迟：<300ms 绿、<800ms 橙、其余红；未测（<=0）灰 */
export const delayClass = (v: number) => (v > 0 ? (v < 300 ? 'stat-good' : v < 800 ? 'stat-mid' : 'stat-bad') : 'stat-idle')

/** 速度：>5MB/s 绿、>1MB/s 橙、其余红；未测（<=0）灰 */
export const speedClass = (v: number) => (v > 0 ? (v > 5 * 1024 * 1024 ? 'stat-good' : v > 1024 * 1024 ? 'stat-mid' : 'stat-bad') : 'stat-idle')
