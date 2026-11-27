# AnTun

**GitHub**：https://github.com/andyzhang201310-coder/AnTun

**轻量 · 跨端 · 加密隧道客户端** —— 全新开发的 Cloudflare WARP 多端图形客户端。默认 Windows 安装包内置核心，约 **22.6 MB**；删除 `src-tauri/resources/` 后重新构建可得到 **1.3 MB** 的按需下载版。Web 产物约 **326 KB**（gzip 后约 97 KB）。

> 本软件开源免费，仅供学习交流使用，禁止售卖。

## 为什么这么小

安装包的体积主要由两部分构成：随包内置的隧道核心，以及界面运行环境。

| 组成 | 说明 |
|---|---|
| `mihomo.exe` | 59 MB，隧道核心，压缩后随包约 20 MB |
| `psiphon.exe` | 22 MB，可选出口组件，压缩后随包约 7 MB |
| 界面运行环境 | 复用系统自带 WebView2，不额外占用安装包体积 |

AnTun 采用 **Web 技术栈一次开发、多端复用**：界面与逻辑只有一套代码（HTML/CSS/TypeScript），桌面端用 Tauri + 系统自带 WebView2 Runtime，不捆绑浏览器内核。核心二进制默认随包内置，连接时直接复制到用户数据目录，不再联网下载；如需极简安装包，删掉 `src-tauri/resources/` 后会自动回退到按需下载。

- Windows 内置版约 **22.6 MB**（含 mihomo 59 MB + Psiphon 22 MB 的压缩数据），Web 产物 **326 KB**
- 极简版 Windows 安装包仅 **1.3 MB**，首次连接时联网下载核心
- `mihomo.exe` / `psiphon.exe` 均为 GPL-3.0 独立进程，许可证随包放在 `GPL-3.0.txt`
- 老安卓 WebView / Windows / TV 浏览器 共用完全相同的界面
- 无自带浏览器运行时捆绑、无原生 GUI 工具链

## 功能

覆盖完整的连接与代理管理能力，并针对跨平台做了增强：

- **首页**：顶栏第一行是「主页 · 一键扫描最优端点并建立加密隧道」，第二行是开源免费声明。页面主体是唯一的连接圆环（点击连接/断开，会话时钟 / 动画进度）。左下侧栏是「已选节点」：出口节点下拉（WARP 自动择优 / 已实测端点 / 订阅节点）+ 扫描按钮，切换节点时自动断开重连。右侧是协议下拉框（盾牌图标 + 当前协议 + 可用状态，支持 WireGuard / AWG / GOOL / MASQUE H3 / MASQUE H2 / MASQUE in MASQUE）与连接选项；当订阅出口为「节点出口」且未开启 WARP 承载时，隧道完全由订阅节点自己的协议承担，该下拉框降级为只读并显示节点协议（如 VLESS），避免误以为 WARP 协议正在生效。下方依次是出口 IP / 国家 / 机房 / 延迟、出口机房（Cloudflare 就近分配，附本机实测的「端点 → 机房」记录，点一行即锁定该端点）、带当前毫秒数的实时延迟曲线、实时速率与上下行波形图（近 90 秒）、缓存端点锁定。端点下拉里的延迟是用本机凭证真实握手测出来的，不是估算值。窄窗口下连接区自动堆叠。
- **顶栏**：主题与语言改为图标按钮，单击分别切换浅色/深色与中文/英文，保留悬停提示与 TV 焦点样式。
- **模式**：WARP 直连 / 订阅模式；支持导入 http(s) 订阅、Clash YAML 或粘贴 `ss://` / `vmess://` / `trojan://` / `vless://` / `socks5://` / `http://` 节点。订阅节点列表提供**一键测速**：独立核心为每个节点开本地入口，8 路并发测延迟、3 路并发测下载速度，可按延迟/速度排序。订阅出口可选 **WARP 出口**（节点前置，最终 IP 仍是共享 WARP）或 **节点出口**（节点直接出站，可选让 WARP 承载节点流量），后者用于访问 ChatGPT / Gemini 等对 WARP 共享 IP 风控严格的站点。
- **节点**：端点真实探测（用本机凭证对每个候选端点做完整 WireGuard 握手并测往返耗时，`listeners[].proxy` 把每个端点钉在独立本地入口，8 路并发）、搜索、协议过滤、按延迟/丢包/地址排序、点击锁定端点。握手失败的端点标记为不可用，不会被自动择优选中。
- **规则**：代理模式（自定义 / 绕过大陆 / 全局）、规则增删启停、直连/代理域名清单。
- **设置**：WARP 账户、内核更新（mihomo 官方 Release / Psiphon 组件包）、捕获与端口（本地混合端口 / API 端口 / 局域网共享 / 地址族 / MTU）、路由分流、启动与行为、DNS 与出口（DNS 预设 / 自定义 / 关闭 + **DNS 防泄漏**：fake-ip 与 IP 形式 DoH 经隧道解析；Psiphon 出口地区采用“自动选择 + ISO 国家码”列表，选择后写入 `EgressRegion`）、**网络诊断**（DNS 泄漏检测 + ChatGPT / Gemini / Claude 站点连通性检测），全部设置项持久化到本机。
- **关于**：仅保留品牌、简介与项目主页。
- **日志**：运行日志、连接历史、可复制的诊断信息。
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

`src-tauri/target/release/bundle/nsis/AnTun_1.6.9_x64-setup.exe` —— 默认内置核心，安装包约 **22.6 MB**，主程序 `antun.exe` 3.3 MB。用的是系统自带的 WebView2 Runtime（Win10/11 普遍预装），不捆绑 Chromium。删除 `src-tauri/resources/` 可回到 **1.3 MB** 的按需下载版。

原生能力全部保留并实测：单实例锁（二次双击唤起已有窗口）、系统托盘左键切换/右键菜单、关闭窗口收进托盘保持隧道、托盘退出前通知前端断连还原代理、开机自启查询与设置。前端通过 `src/desktop.ts` 注入统一的 `AnTunDesktop` 桌面接口，页面代码无需区分环境；Web 环境不注入任何对象，浏览器版行为不变。

**安装与升级**：安装包一律**就地覆盖安装**。`src-tauri/nsis/installer.nsi` 是从 Tauri 上游模板派生的自定义模板，删掉了上游那个「重新安装方式」选择页（该页升级时默认预选「卸载后再安装」，会先跑旧版卸载程序删掉文件、快捷方式和卸载注册表项，再重新装一遍）。覆盖安装直接替换 `%LOCALAPPDATA%\AnTun` 下的程序文件、重建快捷方式与卸载项；`%APPDATA%\com.antun.client` 里的凭证、订阅、设置不在安装目录内，升级全程不读写。需要彻底清理时走控制面板卸载，卸载流程本身未改动。

### 真实连接（非演示）

桌面版点击"连接"会走完整真实链路，不再是模拟数据：

1. 首次连接时从安装包内置资源复制 mihomo 核心到应用数据目录（`%APPDATA%\com.antun.client\`）；内置资源缺失时才从镜像下载；
2. Rust 侧按所选协议渲染 mihomo 配置（WireGuard `peers` / MASQUE 端点与凭据 / 嵌套 `dialer-proxy`），写盘后启动核心进程。选定的出口端点会覆盖凭证注册时下发的默认端点；MASQUE 系除外（其 server/SNI 由 Cloudflare 固定下发，改了反而连不上）。自动择优会按实测延迟取前 3 个端点依次尝试，前一个建不起隧道就换下一个；
3. **"已连接"状态完全由真实出口探测决定**：经隧道请求 Cloudflare trace 拿到 `ip=` / `warp=on`，再用 gstatic `generate_204` 二次确认外网可达，两者都通过才算连上；
4. 成功后自动把 Windows 系统代理指向 `127.0.0.1:7890`（保存原始设置快照并通知浏览器刷新），浏览器才会真正走 WARP；本地地址自动绕过；
5. 断开、退出或核心意外终止时自动还原连接前的系统代理，避免浏览器指向死端口；
6. 探测失败或超时，核心进程会被停止，界面如实显示失败——不会伪造出口 IP；
7. 每 5 秒真实复探一次，隧道失效自动断开；所有子进程（mihomo / curl / powershell）均隐藏控制台窗口，不再闪 cmd 黑框。

**WARP 凭证**：首次启动会通过 Cloudflare 匿名注册接口为本机生成一份**独享**设备密钥（X25519 密钥对本地生成，私钥不出本机），之后每次连接都用这把身份；注册失败（无网络、接口变动）自动回退内置共享凭证，不会阻断连接。连接时若当前凭证建不起隧道，会自动用内置凭证重试一次，并在日志里写明降级原因。也可在"设置 → WARP 账户"粘贴自己的账户 JSON 覆盖（标记为 `user`，不会被自动注册替换），设置页会显示当前身份是「本机独享」还是「内置共享」。凭证格式参考 `src/engine/credential.ts`（兼容 `private_key` / `public_key` / `endpoint` / `address` 等多种命名）。

> 内置凭证是硬编码在安装包里的共享密钥，任何人都能从二进制或公开仓库中取出；它只代表一个免费 WARP 身份，不含个人账号信息，也无法解密历史流量。MASQUE 系列协议使用独立的 ECDSA 注册流程，目前仍沿用内置密钥。

实测结果（本机 Windows + Tauri exe）：点击连接后建立真实隧道，出口 `104.28.243.42`、`warp=on`；系统代理写入 `127.0.0.1:7890`，使用系统代理的 **`youtube.com` 返回 HTTP 200**、gstatic `generate_204` 返回 204；断开后 `ProxyEnable` 自动恢复为 0。核心进程无可见控制台窗口。

六种协议已通过 `scripts/verify-protocols.cjs` 逐项真实连接验证：**WireGuard、AWG、GOOL、MASQUE H3、MASQUE in MASQUE** 均拿到 `warp=on` 的真实出口 IP；**MASQUE H2** 在当前网络下不可用（14 个端点全部 `no working endpoint found`），AnTun 如实显示连接失败，不会用 H3 冒充 H2。连接等待下限已提高到 30 秒，避免 gvisor 握手被误判超时。

### 访问 ChatGPT / Gemini

OpenAI 与 Google 对**机房/VPN 共享 IP** 有独立风控，能否访问取决于「最终出口 IP」，而不是隧道是否通：

1. **纯 WARP 模式**：Cloudflare WARP 的共享出口常被判为不支持地区，ChatGPT 多为 403、Gemini 可能可用。可在「设置 → 网络诊断 → AI 站点连通性」一键确认当前出口的实际结果。
2. **订阅模式 → 节点出口（推荐）**：在「模式」页把**订阅出口**切成「节点出口」，导入一个位于美国 / 日本 / 新加坡的节点并选中，节点即成为最终出口；WARP 共享 IP 不再参与，ChatGPT / Gemini 通常可直接打开。若该节点本身被墙，可再打开「节点流量经 WARP 承载」，先入 WARP 再连节点。
3. **DNS 必须不泄漏**：设置页保持「DNS 防泄漏」开启（默认开启），核心会使用 fake-ip + IP 形式的 DoH 并在隧道内解析；此时解析器位于 Cloudflare / Google 侧，本地运营商看不到访问域名。用「DNS 泄漏检测」可直接看到解析器 IP 与归属地。

实测（WARP 出口，`scripts/verify-net-1_5.cjs`）：DNS 解析器为 `172.70.141.36 · Singapore - Cloudflare`，无泄漏；ChatGPT 网页与 Gemini 网页在该出口下 HTTP 403/200，OpenAI API 返回地区拦截——这正是需要切「节点出口」的典型场景。

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

脚本会同步更新 `package.json`、`package-lock.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock` 与 README 安装包名；侧栏左下角的版本号由构建时从 `package.json` 注入，无需手动改。当前版本：**1.6.9**。

> 构建依赖 Rust（已验证 1.95 / MSVC）与 WebView2 Runtime。国内网络需在 `~/.cargo/config.toml` 配置 rsproxy 镜像，否则 crates.io 拉取会被拦截：
> ```toml
> [source.crates-io]
> replace-with = 'rsproxy-sparse'
> [source.rsproxy-sparse]
> registry = "sparse+https://rsproxy.cn/index/"
> ```

验证方式：启动 exe 前设 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222`，再运行 `node scripts/verify-tauri.cjs` 做基础交互验证，`node scripts/verify-protocols.cjs` 逐项验证六种协议的真实出口，或 `node scripts/verify-updates.cjs` 验证首页按钮、订阅导入与关于页信息（需先在本机 8899 端口提供 `scripts/fixtures/test-subscription.yaml`）；`node scripts/verify-latency-region-1_4.cjs` 验证实时延迟数值与 Psiphon 出口地区写入，`node scripts/verify-latency-1_4.cjs` 验证连接后波形图上的毫秒数，`node scripts/verify-net-1_5.cjs` 验证 DNS 防泄漏落盘配置、DNS 泄漏检测与 AI 站点连通性，`node scripts/verify-node-test-1_6.cjs` 验证订阅节点一键测速（延迟 + 速度）与被拒节点的标记。

## 开发命令

```bash
npm install
npm run dev       # 本地开发
npm run build     # 生产构建，输出到 dist/
npm run preview   # 预览构建产物
```

## 设计取舍

- 用 Web 技术栈一次覆盖三端：桌面（Tauri）、老安卓 WebView、TV 浏览器，界面与逻辑只有一份。
- 能力抽象成 `EngineAdapter` 接口：演示适配器可跑通全部交互，真机适配器对接实际隧道，页面代码不需要区分平台。
- AnTun 自身代码采用 MIT（见项目根目录 `LICENSE`）；mihomo / Psiphon 是 GPL-3.0 独立进程，随包提供 `GPL-3.0.txt`，通过"独立进程 + 本地端点"集成，不并入 AnTun 代码。
