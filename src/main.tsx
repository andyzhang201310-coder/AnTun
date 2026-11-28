import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { initDesktopBridge } from './desktop'
import { useStore } from './store'

// 必须在 React 挂载前注入：useEngine 在首次 effect 中检测桌面环境
initDesktopBridge()

// 仅开发态：把 store 挂到 window，方便在浏览器/CDP 里摆出连接中、失败等状态做界面验证
if (import.meta.env.DEV) {
  ;(window as any).__antunStore = useStore
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
