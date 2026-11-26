import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { initDesktopBridge } from './desktop'

// 必须在 React 挂载前注入：useEngine 在首次 effect 中检测桌面环境
initDesktopBridge()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
