# AnTun

**GitHub**：https://github.com/andyzhang201310-coder/AnTun

**轻量 · 跨端 · 加密隧道客户端** —— 全新开发的 Cloudflare WARP 多端图形客户端，复刻开源项目 [XEHN](https://github.com/hezhanleiok/xehn) 的全部功能界面与交互。默认 Windows 安装包内置核心，约 **22.6 MB**（原版 115 MB）；删除 `src-tauri/resources/` 后重新构建可得到 **1.3 MB** 的按需下载版。Web 产物约 **326 KB**（gzip 后约 97 KB）。

> 本软件开源免费，仅供学习交流使用，禁止售卖。

## 为什么这么小

XEHN 的 115 MB 几乎全部来自随包捆绑的三个二进制和 GeoIP 数据库：

| 原版文件 | 体积 |
|---|---|
| `core/mihomo.exe` | 59 MB |
| `xehn.exe` | 23 MB |
| `core/psiphon.exe` | 22 MB |
| `geosite.dat` + `geoip.metadb` | 12 MB |

AnTun 采用 **Web 技术栈一次开发、多端复用**：界面与逻辑只有一套代码（HTML/CSS/TypeScript），桌面端用 Tauri + 系统自带 WebView2 Runtime，不捆绑浏览器内核。核心二进制默认随包内置，连接时直接复制到用户数据目录，不再联网下载；如需极简安装包，删掉 `src-tauri/resources/` 后会自动回退到按需下载。

- Windows 内置版约 **22.6 MB**（含 mihomo 59 MB + Psiphon 22 MB 的压缩数据），Web 产物 **326 KB**
- 极简版 Windows 安装包仅 **1.3 MB**，首次连接时联网下载核心
- `mihomo.exe` / `psiphon.exe` 均为 GPL-3.0 独立进程，许可证随包放在 `GPL-3.0.txt`
- 老安卓 WebView / Windows / TV 浏览器 共用完全相同的界面
- 无自带浏览器运行时捆绑、无原生 GUI 工具链

## 功能

完整复刻原版交互，并做了跨平台增强：

- **首页**：唯一的连接圆环（点击连接/断开，会话时钟 / 动画进度）、扫描端点、协议下拉框（盾牌图标 + 当前协议 + 可用状态，支持 WireGuard / AWG / GOOL / MASQUE H3 / MASQUE H2 / MASQUE in MASQUE）、连接选项、出口 IP/国家/机房/延迟、实时延迟曲线、真实上下行速率与累计流量、国家/Colo 过滤、缓存端点锁定。重复的“连接”按钮已移除，窄窗口下连接区自动堆叠。
- **顶栏**：主题与语言改为图标按钮，单击分别切换浅色/深色与中文/英文，保留悬停提示与 TV 焦点样式。
- **模式**：WARP 直连 / 订阅模式；支持导入 http(s) 订阅、Clash YAML 或粘贴 `ss://` / `vmess://` / `trojan://` / `vless://` / `socks5://` / `http://` 节点，选中的订阅节点作为 WARP 隧道的前置代理（`dialer-proxy`）。
- **节点**：端点扫描（2 阶段探测）、搜索、协议过滤、按延迟/丢包/机房排序、点击锁定端点。
- **规则**：代理模式（自定义 / 绕过大陆 / 全局）、规则增删启停、直连/代理域名清单。
- **设置**：WARP 账户、捕获与端口（本地混合端口 / API 端口 / 局域网共享 / 地址族 / MTU）、路由分流、启动与行为（开机自启 / 启动即连接已接原生行为）、DNS 与出口（出口地区、Psiphon），全部设置项持久化到本机。
- **日志**：运行日志、连接历史、可复制的诊断信息。
- **关于**：AnTun 真实版本、程序/资源/数据路径、控制码、MIT 代码许可证与内置核心 GPL-3.0 说明、参考项目与核心源码链接。
- 浅色 / 深色 / 跟随系统主题，中文 / English 双语，手机 / 桌面 / TV 三档响应式布局，TV 遥控器焦点态。

## 工程结构（快速开发）

```
src/
├── types/           全部类型定义（加功能先加类型）
├── i18n/            中英文案表（缺失 key 自动回退中文）
├── store/           Zustand 状态 + 持久化
├── engine/          引擎适配层
│   ├── adapters.ts     Web / Desktop / Android / TV 四类适配器
│   ├── credential.ts   WARP 账户凭证解析（多格式兼容）
│   ├── configRenderer.ts  mihomo 配置渲染（Web 端参考实现）
│   └── useEngine.ts    连接动作封装
├── desktop.ts       Tauri 桌面桥接（注入 AnTunDesktop，页面代码零改动）
├── components/      通用 UI 原子组件 + 应用外壳
└── pages/           六个功能页面
src-tauri/           Tauri 桌面壳
└── src/core.rs      真实隧道核心（按需下载 mihomo / 配置渲染 / 启动 / 真实出口探测）
└── src/lib.rs       托盘 / 单实例 / 自启 / 退出断连 + 命令注册
```

**加一个功能 = 加一个页面组件 + 一个 i18n key + 在 App.tsx 挂路由**。状态放 store，真实隧道逻辑放 engine 适配器。

## 多端说明

同一份 `dist/` 可直接用于：

- **Windows**：Tauri 桌面应用（默认内置核心安装包约 22.6 MB），或任意浏览器打开。
- **老安卓**：Android 5+ WebView 加载 `dist/`；通过 `window.AnTunBridge` 注入 `scan/connect/disconnect/status` 方法即可接入 `VpnService` 真隧道。
- **TV 端**：智能电视浏览器 / TV WebView 全屏加载；已内置大屏字号与遥控器焦点样式。

`AndroidAdapter` 会在检测到 `window.AnTunBridge` 时自动改走真机桥接，否则退回 Web 演示适配器——所以**同一套代码既能演示交互，也能在真机上做真实连接**。

## Tauri 桌面应用（已打包并验证）

`src-tauri/target/release/bundle/nsis/AnTun_1.2.0_x64-setup.exe` —— 默认内置核心，安装包约 **22.6 MB**，主程序 `antun.exe` 3.3 MB。用的是系统自带的 WebView2 Runtime（Win10/11 普遍预装），不捆绑 Chromium；相比原版 115 MB 仍缩小约 **80%**。删除 `src-tauri/resources/` 可回到 **1.3 MB** 的按需下载版。

原生能力全部保留并实测：单实例锁（二次双击唤起已有窗口）、系统托盘左键切换/右键菜单、关闭窗口收进托盘保持隧道、托盘退出前通知前端断连还原代理、开机自启查询与设置。前端通过 `src/desktop.ts` 注入统一的 `AnTunDesktop` 桌面接口，页面代码无需区分环境；Web 环境不注入任何对象，浏览器版行为不变。

### 真实连接（非演示）

桌面版点击"连接"会走完整真实链路，不再是模拟数据：

1. 首次连接时从安装包内置资源复制 mihomo 核心到应用数据目录（`%APPDATA%\com.antun.client\`）；内置资源缺失时才从镜像下载；
2. Rust 侧按所选协议渲染 mihomo 配置（WireGuard `peers` / MASQUE 端点与凭据 / 嵌套 `dialer-proxy`），写盘后启动核心进程；
3. **"已连接"状态完全由真实出口探测决定**：经隧道请求 Cloudflare trace 拿到 `ip=` / `warp=on`，再用 gstatic `generate_204` 二次确认外网可达，两者都通过才算连上；
4. 成功后自动把 Windows 系统代理指向 `127.0.0.1:7890`（保存原始设置快照并通知浏览器刷新），浏览器才会真正走 WARP；本地地址自动绕过；
5. 断开、退出或核心意外终止时自动还原连接前的系统代理，避免浏览器指向死端口；
6. 探测失败或超时，核心进程会被停止，界面如实显示失败——不会伪造出口 IP；
7. 每 5 秒真实复探一次，隧道失效自动断开；所有子进程（mihomo / curl / powershell）均隐藏控制台窗口，不再闪 cmd 黑框。

**WARP 凭证**：内置一份经实测可用的免费凭证，开箱即可连接；也可在"设置 → WARP 账户"粘贴自己的账户 JSON 覆盖。凭证格式参考 `src/engine/credential.ts`（兼容 `private_key` / `public_key` / `endpoint` / `address` 等多种命名）。

实测结果（本机 Windows + Tauri exe）：点击连接后建立真实隧道，出口 `104.28.243.42`、`warp=on`；系统代理写入 `127.0.0.1:7890`，使用系统代理的 **`youtube.com` 返回 HTTP 200**、gstatic `generate_204` 返回 204；断开后 `ProxyEnable` 自动恢复为 0。核心进程无可见控制台窗口。

六种协议已通过 `scripts/verify-protocols.cjs` 逐项真实连接验证：**WireGuard、AWG、GOOL、MASQUE H3、MASQUE in MASQUE** 均拿到 `warp=on` 的真实出口 IP；**MASQUE H2** 在当前网络下不可用——用 XEHN 自身执行 `connect -p masque-h2` 同样返回 `no working endpoint found`（14 个端点全部失败），AnTun 如实显示连接失败，不会用 H3 冒充 H2。连接等待下限已提高到 30 秒，避免 gvisor 握手被误判超时。

```bash
npm run tauri:dev       # 开发模式
npm run tauri:build     # 构建安装包（输出到 src-tauri/target/release/bundle/nsis/）
```

### 版本管理

**每次修改功能、界面或修复问题，必须先升版，再构建。** 不要只改某一个文件里的版本号。

```bash
npm run version:patch          # 修复更新：1.1.0 -> 1.1.1
npm run version:minor          # 功能更新：1.1.0 -> 1.2.0
npm run version:major          # 重大调整：1.1.0 -> 2.0.0
npm run version:set -- 1.3.0   # 指定版本
```

脚本会同步更新 `package.json`、`package-lock.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock`、README 安装包名，以及关于页的兜底版本。当前版本：**1.2.0**。

> 构建依赖 Rust（已验证 1.95 / MSVC）与 WebView2 Runtime。国内网络需在 `~/.cargo/config.toml` 配置 rsproxy 镜像，否则 crates.io 拉取会被拦截：
> ```toml
> [source.crates-io]
> replace-with = 'rsproxy-sparse'
> [source.rsproxy-sparse]
> registry = "sparse+https://rsproxy.cn/index/"
> ```

验证方式：启动 exe 前设 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222`，再运行 `node scripts/verify-tauri.cjs` 做基础交互验证，`node scripts/verify-protocols.cjs` 逐项验证六种协议的真实出口，或 `node scripts/verify-updates.cjs` 验证首页按钮、订阅导入与关于页信息（需先在本机 8899 端口提供 `scripts/fixtures/test-subscription.yaml`）。

## 开发命令

```bash
npm install
npm run dev       # 本地开发
npm run build     # 生产构建，输出到 dist/
npm run preview   # 预览构建产物
```

## 与原版的差异（设计取舍）

- 原版是 Go + Win32 原生窗口，只能跑 Windows；AnTun 用 Web 技术栈覆盖三端。
- 原版 GUI 与 CLI 共用命令；AnTun 把能力抽象成 `EngineAdapter` 接口，演示适配器可跑通全部交互，真机适配器对接实际隧道。
- AnTun 自身代码采用 MIT（见项目根目录 `LICENSE`）；mihomo / Psiphon 是 GPL-3.0 独立进程，随包提供 `GPL-3.0.txt`，通过"独立进程 + 本地端点"集成，不并入 AnTun 代码。
