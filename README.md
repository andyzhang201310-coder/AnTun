# AnTun

**GitHub**：https://github.com/andyzhang201310-coder/AnTun

**轻量 · 跨端 · 加密隧道客户端** —— 全新开发的 Cloudflare WARP 多端图形客户端。默认 Windows 安装包内置核心，约 **22.6 MB**；删除 `src-tauri/resources/` 后重新构建可得到 **1.3 MB** 的按需下载版。Web 产物约 **326 KB**（gzip 后约 97 KB）。

> 本软件开源免费，仅供学习交流使用，禁止售卖。

## 为什么这么小

安装包的体积主要由两部分构成：随包内置的隧道核心，以及界面运行环境。

| 组成 | 说明 |
|---|---|
| `mihomo.exe` | 59 MB，隧道核心，压缩后随包约 20 MB |
| `psiphon.exe` | 22 MB，Psiphon 出口组件（官方 tunnel-core，独立进程），压缩后随包约 7 MB |
| 界面运行环境 | 复用系统自带 WebView2，不额外占用安装包体积 |

AnTun 采用 **Web 技术栈一次开发、多端复用**：界面与逻辑只有一套代码（HTML/CSS/TypeScript），桌面端用 Tauri + 系统自带 WebView2 Runtime，不捆绑浏览器内核。核心二进制默认随包内置，连接时直接复制到用户数据目录，不再联网下载；如需极简安装包，删掉 `src-tauri/resources/` 后会自动回退到按需下载。

- Windows 内置版约 **22.6 MB**（含 mihomo 59 MB + Psiphon 22 MB 的压缩数据），Web 产物 **326 KB**
- 极简版 Windows 安装包仅 **1.3 MB**，首次连接时联网下载核心
- `mihomo.exe` / `psiphon.exe` 均为 GPL-3.0 独立进程，许可证随包放在 `GPL-3.0.txt`
- 老安卓 WebView / Windows / TV 浏览器 共用完全相同的界面
- 无自带浏览器运行时捆绑、无原生 GUI 工具链

## 功能

覆盖完整的连接与代理管理能力，并针对跨平台做了增强：

- **首页**：顶栏第一行是「主页 · 一键扫描最优端点并建立加密隧道」，第二行是开源免费声明。页面主体是唯一的连接圆环（点击连接/断开，会话时钟 / 动画进度）。**连接过程中圆环转为橙色可点状态，点一下即取消**（副标题会提示「点此取消」，再下一行是 100ms 刷新的「连接中已用 x.x s」——从点连接算起，连上后这行自动让位给会话时长，不用猜到底卡了多久）——取消会连同 Psiphon 子进程与核心一起收掉，通常在 1 秒内回到未连接，不会让界面卡在「正在连接」等满超时。左下侧栏是「已选节点」：自绘的出口节点下拉（WARP 自动择优 / 已实测端点 / 订阅节点，每项带国旗图标与实测延迟）+ 扫描按钮，**已连接时切换节点会自动断开并用新节点重连**（未连接时只改选择，不发起连接）。订阅模式下这个按钮变为「测速节点」：给订阅节点测延迟（走独立的测速核心，不影响正在连接的隧道），测完下拉里的订阅节点**按延迟从低到高排列**，未测与测不通的排在后面，直接在最上面选最快的即可；结果会落盘，重启后排序仍然有效。右侧是协议下拉框（盾牌图标 + 当前协议 + 可用状态，支持 WireGuard / AWG / GOOL / MASQUE H3 / MASQUE H2 / MASQUE in MASQUE）与连接选项；当订阅出口为「节点出口」且未开启 WARP 承载时，隧道完全由订阅节点自己的协议承担，该下拉框降级为只读并显示节点协议（如 VLESS），避免误以为 WARP 协议正在生效。下方依次是出口 IP / 国家 / 机房 / 延迟（国家与机房前带国旗图标；台湾省、香港、澳门一律显示中国国旗与「中国台湾 / 中国香港 / 中国澳门」表述）、出口机房（Cloudflare 就近分配，附「端点 → 机房」实测记录，点一行即锁定该端点）、带当前毫秒数的实时延迟曲线、实时速率与上下行波形图（近 90 秒）、缓存端点锁定。端点下拉里的延迟是用本机凭证真实握手测出来的，不是估算值。窄窗口下连接区自动堆叠。
- **顶栏**：主题与语言改为图标按钮，单击分别切换浅色/深色与中文/英文，保留悬停提示与 TV 焦点样式。
- **模式**：WARP 直连 / 订阅模式；支持导入 http(s) 订阅、Clash YAML 或粘贴 `ss://` / `vmess://` / `trojan://` / `vless://` / `socks5://` / `http://` 节点。订阅节点列表提供**一键测速**：延迟走一次 `/group/PROBE/delay`，由临时核心内部并发探测全部节点（`unified-delay` 口径，只含连接建立时间，和 Clash / Mihomo Party 一致），下载速度按 3 路并发、固定时长取稳态值，可按延迟/速度排序（排序记在设置里，切页不重置）。每个节点名前面带国旗图标。订阅出口可选 **WARP 出口**（节点前置，最终 IP 仍是共享 WARP）或 **节点出口**（节点直接出站，可选让 WARP 承载节点流量），后者用于访问 ChatGPT / Gemini 等对 WARP 共享 IP 风控严格的站点。
- **节点**：端点真实探测（用本机凭证对每个候选端点发一次真实 WireGuard 握手，16 路并发、2 秒超时，活端点 ≈ 一个 RTT；一个都没通时回退到「一个核心 + 一个 `PROBE` 组 + 一次 `/group/delay`」再确认一次，避免把本地网络封锁误报成端点不可用）、搜索、协议过滤（这两项同样不会被切页重置）、按延迟/丢包/地址排序、点击锁定端点。握手失败的端点标记为不可用，不会被自动择优选中。
- **收藏**：把测出速度好的节点存下来（连分享链接一起存，订阅刷新或删除都不影响收藏项）。支持单个/批量测延迟、单个/批量测速、单个与批量删除、一键选用（已连接时同样自动断开重连），以及「从订阅导入」批量收录。列表可按「收藏时间 / 延迟从低到高 / 延迟从高到低」排序（选择记在设置里，切页不重置；没测过的节点永远排在最后）。延迟与速度按「绿 / 橙 / 红」分档着色，与模式页订阅节点同一套阈值、同一份实现（`src/lib/stat.ts`）。节点名前的国旗与延迟、速度都按真实测试结果展示，测不出的项留空而不是填 0。模式页的「订阅节点」列表每行右侧有星标按钮，看到好节点可以直接收藏（同时把当前测得的延迟/速度带进去，再点一次取消收藏），点星标不会误切当前前置节点。
- **规则**：代理模式（自定义 / 绕过大陆 / 全局）、规则增删启停、直连/代理域名清单。
- **设置**：WARP 账户、内核更新（mihomo 官方 Release / Psiphon 组件包）、捕获与端口（本地混合端口 / API 端口 / 局域网共享 / 地址族 / MTU）、路由分流、启动与行为、DNS 与出口（DNS 预设 / 自定义 / 关闭 + **DNS 防泄漏**：fake-ip 与 IP 形式 DoH 经隧道解析；Psiphon 出口地区采用“自动选择 + ISO 国家码”列表，连接时写入 `EgressRegion`（已连接时改地区会提示“重新连接后生效”）；这里的 Psiphon 出口开关与首页同一行为（已连接时切换会断开重连），订阅模式下两处都禁用；选到 Psiphon 未覆盖的地区会立刻报错并列出可选地区，而不是让用户空等）、**网络诊断**（DNS 泄漏检测 + ChatGPT / Gemini / Claude 站点连通性检测），全部设置项持久化到本机。订阅模式「节点出口」且未开启 WARP 承载时，设置页的「协议」也会降级为只读（显示订阅节点自己的协议）；原来的「外层协议」从未传入后端、`render_config` 也不读，已在 1.7.1 移除。另有 **备份与同步**：把设置、订阅、节点、收藏、规则导出成一份 JSON（保存到下载目录或复制文本）；也可以在本机起一个只读的临时 HTTP 服务，把**局域网链接生成二维码**给另一台设备扫码下载 —— 二维码本身只编码 URL（整份配置 60~75 KB，超出二维码容量上限），配置由对端按需拉取，共享自带随机会话令牌、默认 10 分钟有效、可随时停止。接收端支持**扫码识别**（调用摄像头 + jsQR 本地解码，支持选图片 / Ctrl+V 贴截图兜底）、粘贴局域网链接、选择本机备份文件三种方式，导入分「合并」与「覆盖」两种口径；导入后若原选中的前置节点不存在会自动改选可用节点。连接选项里的 **TUN 全局模式**是真生效的：勾选后核心配置写入 `tun:`（`device: AnTun`、gvisor 栈、`auto-route`、`auto-detect-interface`，DNS 未关闭时再加 `dns-hijack: any:53`），整机流量经虚拟网卡进隧道，不受应用是否遵守系统代理影响。它要求管理员权限（建 wintun 适配器 + 改路由表），非提权时首页会直接给出「以管理员身份重启」按钮，并在连接前拦下；核心启动后还会**实测网卡是否真的建立**，起不来就判失败 —— 因为非提权时 mihomo 只打一行 `Access is denied` 却继续提供混合端口，光看「出口探测通过」会得出「全局已生效」的错误结论。wintun.dll 不随安装包分发（GPLv2 二进制），连接时优先复用车机已有的 Cloudflare WARP / WireGuard 副本并复制到核心目录，找不到才报错并提示安装。
- **Psiphon 出口**（首页「连接选项」）：开启后先拉起内置 `psiphon.exe`（官方 tunnel-core），等它建立隧道，再把 mihomo 的最终出站指向它的本地 SOCKS 端口 —— 出口 IP 来自 Psiphon 网络，**WARP 不再参与**（两者互斥，订阅模式下该开关禁用）。**已连接时切换这个开关会自动断开重连来应用新出口**（出口是在连接时写进核心配置的，核心跑起来后无法热改），期间提示「正在切换 Psiphon 出口（断开重连）」，圆环回到连接中；连接进行中开关暂时禁用，避免改到一半仍在跑旧配置。内置 `server_list.dat` 是 legacy 十六进制格式，启动时解析成 100 条 server entry 注入 `ServerList`，避免首次启动 `entries 0` 只能干等远程列表；同时清掉官方配置里指向 `127.0.0.1:7890` 的 `UpstreamProxyURL`（作者本机的代理，换台机器会导致完全连不上），端口动态分配。单次尝试失败会自动重启进程换一批服务器再试（实测同一网络下第一次可能 89 次 ConnectingServer 全失败，重启后 15~22 秒即通）。进程绑定 Windows Job 对象，断开或退出时一并结束。
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

`public/flags/*.svg` 是国家/地区国旗图标，取自 [flag-icons](https://github.com/lipis/flag-icons)（MIT，许可原文见 `public/flags/LICENSE.txt`）。**不能用国旗 emoji**：Windows 的 Segoe UI Emoji 不含区域指示符，`🇯🇵` 会原样渲染成 `JP` 两个字母（已用无头 Chrome 截图确认），所以图标必须是图片资源。

## 多端说明

同一份 `dist/` 可直接用于：

- **Windows**：Tauri 桌面应用（默认内置核心安装包约 22.6 MB），或任意浏览器打开。
- **老安卓**：Android 5+ WebView 加载 `dist/`；通过 `window.AnTunBridge` 注入 `scan/connect/disconnect/status` 方法即可接入 `VpnService` 真隧道。
- **TV 端**：智能电视浏览器 / TV WebView 全屏加载；已内置大屏字号与遥控器焦点样式。

`AndroidAdapter` 会在检测到 `window.AnTunBridge` 时自动改走真机桥接，否则退回 Web 演示适配器——所以**同一套代码既能演示交互，也能在真机上做真实连接**。

## Tauri 桌面应用（已打包并验证）

`src-tauri/target/release/bundle/nsis/AnTun_1.8.2_x64-setup.exe` —— 默认内置核心，安装包约 **22.8 MB**，主程序 `antun.exe` 3.3 MB。用的是系统自带的 WebView2 Runtime（Win10/11 普遍预装），不捆绑 Chromium。删除 `src-tauri/resources/` 可回到 **1.3 MB** 的按需下载版。

原生能力全部保留并实测：单实例锁（二次双击唤起已有窗口）、系统托盘左键切换/右键菜单、关闭窗口收进托盘保持隧道、托盘退出前通知前端断连还原代理、开机自启查询与设置。前端通过 `src/desktop.ts` 注入统一的 `AnTunDesktop` 桌面接口，页面代码无需区分环境；Web 环境不注入任何对象，浏览器版行为不变。

**安装与升级**：安装包一律**就地覆盖安装**。`src-tauri/nsis/installer.nsi` 是从 Tauri 上游模板派生的自定义模板，删掉了上游那个「重新安装方式」选择页（该页升级时默认预选「卸载后再安装」，会先跑旧版卸载程序删掉文件、快捷方式和卸载注册表项，再重新装一遍）。覆盖安装直接替换 `%LOCALAPPDATA%\AnTun` 下的程序文件、重建快捷方式与卸载项；`%APPDATA%\com.antun.client` 里的凭证、订阅、设置不在安装目录内，升级全程不读写。需要彻底清理时走控制面板卸载，卸载流程本身未改动。

### 真实连接（非演示）

桌面版点击"连接"会走完整真实链路，不再是模拟数据：

1. 首次连接时从安装包内置资源复制 mihomo 核心到应用数据目录（`%APPDATA%\com.antun.client\`）；内置资源缺失时才从镜像下载；
2. Rust 侧按所选协议渲染 mihomo 配置（WireGuard `peers` / MASQUE 端点与凭据 / 嵌套 `dialer-proxy`），写盘后启动核心进程。选定的出口端点会覆盖凭证注册时下发的默认端点；MASQUE 系除外（其 server/SNI 由 Cloudflare 固定下发，改了反而连不上）。自动择优会按实测延迟（纯握手 RTT）取前 3 个端点依次尝试，前一个建不起隧道就换下一个；
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

脚本会同步更新 `package.json`、`package-lock.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock` 与 README 安装包名；侧栏左下角的版本号由构建时从 `package.json` 注入，无需手动改。当前版本：**1.8.2**。

> 构建依赖 Rust（已验证 1.95 / MSVC）与 WebView2 Runtime。国内网络需在 `~/.cargo/config.toml` 配置 rsproxy 镜像，否则 crates.io 拉取会被拦截：
> ```toml
> [source.crates-io]
> replace-with = 'rsproxy-sparse'
> [source.rsproxy-sparse]
> registry = "sparse+https://rsproxy.cn/index/"
> ```

验证方式：启动 exe 前设 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222`，再运行 `node scripts/verify-tauri.cjs` 做基础交互验证，`node scripts/verify-protocols.cjs` 逐项验证六种协议的真实出口，或 `node scripts/verify-updates.cjs` 验证首页按钮、订阅导入与关于页信息（需先在本机 8899 端口提供 `scripts/fixtures/test-subscription.yaml`）；`node scripts/verify-latency-region-1_4.cjs` 验证实时延迟数值与 Psiphon 出口地区写入，`node scripts/verify-latency-1_4.cjs` 验证连接后波形图上的毫秒数，`node scripts/verify-net-1_5.cjs` 验证 DNS 防泄漏落盘配置、DNS 泄漏检测与 AI 站点连通性，`node scripts/verify-node-test-1_6.cjs` 验证订阅节点一键测速（延迟 + 速度）与被拒节点的标记；`node scripts/verify-psiphon-live-switch.cjs` 验证已连接时切换 Psiphon 开关会自动断开重连并更换出口（含 `psiphon.exe` 生命周期与出口 IP 变化）。

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
