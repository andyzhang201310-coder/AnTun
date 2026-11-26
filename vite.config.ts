import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// AnTun 使用相对路径打包，产物可直接放进任意 WebView / TV 浏览器 / 本地目录运行。
// target 设为 es2015 以兼容老旧安卓 WebView（Android 5+）。
export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
  build: {
    target: 'es2015',
    cssCodeSplit: false,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (id.includes('recharts') || id.includes('d3-')) return 'charts'
            if (id.includes('react')) return 'react'
          }
        },
      },
    },
  },
})
