# 架构

本文档描述 **Picot** 的架构 —— 一款用于 Pi 编码 agent 的本地桌面 GUI。
目标读者是新增和回访的贡献者：帮助你建立仓库的心智模型 —— 各模块放在哪里、
各部分如何协作、哪些规则绝不能破坏。

如果你想理解某个特性、不知道从哪里读起、或者不知道在哪里改，本文档应该是你的第一站。

## 鸟瞰

Picot 是一个 Tauri v2 桌面应用，把一个或多个内嵌的 `pi` 进程包裹起来，
给它们一个图形外壳。用户选定一个文件夹（**workspace / 工作区**），
Picot 为该工作区派生一个 `pi --mode rpc --extension embedded-server.mjs`
子进程，打开一个原生窗口，让 WebView 指向 pi 自管的 HTTP/WS server，
再把聊天消息、工具调用、session 历史全部接入这条管道。

Rust 宿主还承担第二个角色 —— **broker WebSocket**。它坐在 WebView 和
内嵌 pi 之间，使得多个浏览器式客户端（工作区自己的 WebView、移动端、
未来的 web 入口）可以共享同一个 pi session，并在 session 切换时被正确路由。

按概念，仓库分为五层：

1. `src-tauri/` —— Rust 宿主：进程生命周期、broker、原生窗口管理。
2. `extensions/embedded-server.ts` —— 在 pi 进程**内**运行的 TypeScript server；
   暴露 HTTP REST + WebSocket + 读取静态前端。
3. `public/` —— 纯 vanilla-JS 的 WebView 前端（不使用框架）。
4. `scripts/` —— 构建、下载、lint、发布自动化。
5. `src-tauri/resources/pi/` —— 内嵌的 pi-mono binary（gitignored，
   由 `scripts/pi-version.json` 触发按需下载）。

一条聊天消息的数据流：

- 改动通常从 `public/`（UI）或 `extensions/embedded-server.ts`（server 端命令）发起。
- 消息路径：WebView → `BrokerWs`（Rust）→ `PiManager::send_rpc`（stdin）→ embedded-server.ts → pi core API。
- 响应回传：pi core → embedded-server.ts 广播 → WebSocket → `BrokerWs` → WebView。

---

## 进程模型：内嵌 server 与 pi 同进程

理解 Picot 的一个关键点是：`extensions/embedded-server.ts` **不是一个独立的
后端服务，而是被 pi 当作扩展加载进自己进程里的一个模块**。它起的 HTTP+WS
服务器，就是 pi 进程本身在监听端口。这个设计决策贯穿了“在哪写代码”的所有
判断，值得单独解释。

### pi 扩展机制（`--extension`）

`pi` 支持加载扩展：`--extension <某个 .mjs 文件>`。一个扩展就是一个 ES
模块，约定 `export default` 一个工厂函数。pi 启动时找到这个文件、执行它、
调用这个工厂函数，**把代表 pi 自身的 `pi` 对象（`ExtensionAPI`）当作
参数传进来**：

```ts
// extensions/embedded-server.ts（约 line 500）
export default function (pi: ExtensionAPI) {
  // pi 就是 pi 自己——可以直接订阅事件、调用方法
  pi.on("session_start", async (_event, ctx) => { ... });
  pi.on("turn_start",  ...);
  ...
}
```

拿到这个 `pi` 对象后，扩展就能：

- **订阅 pi 的全部生命周期事件**：`session_start` / `turn_start` /
  `message_start` / `turn_end` …（embedded-server.ts 约第 632 行起的
  `pi.on(...)` 块）。
- **直接调用 pi 的方法**：发消息、切模型、abort、设 thinking level …
  全是同一进程内的函数调用，不走网络。

### `--mode rpc` 的角色

`pi` 有多种运行模式。正常模式在终端跑 TUI；**`--mode rpc` 让 pi 无头
（headless）运行** —— 不开 TUI，全部能力通过 API 暴露出来等待调用。
Rust 宿主正是用这两个参数一起派生 pi
（`src-tauri/src/pi_manager.rs::spawn`，约第 514 行）：

```rust
let mut args = vec![
    "--extension".to_string(), extension_path,    // ← 让 pi 加载我们的 server
    "--mode".to_string(),      "rpc".to_string(), // ← 让 pi 无头运行
];
```

`--mode rpc` 让 pi 变成引擎；`--extension` 让我们的 server 成为这个引擎
的“脑袋”——由它来接收外部请求、驱动 pi。

### “跑在进程内部” 的真实含义

扩展**不是 pi 派生的子进程，而是被 pi `import` 进来的一个模块**。它和
pi 共享：

- 同一个 Node/Bun 运行时
- 同一个事件循环（event loop）
- 同一块内存、同一个文件系统句柄

因此扩展在工厂函数里调用 `Bun.serve(...)` / `http.createServer(...)`
起 HTTP+WS 服务器时，**这个服务器就是 pi 进程本身在监听那个端口**。

```
Rust spawn
   │
   ▼
┌─────────────── 一个 pi 进程（一个 pid）──────────────┐
│                                                     │
│   pi 核心引擎 (mode=rpc，无头)                        │
│        ▲                                            │
│        │ 直接调用 pi 对象（同进程，零序列化）          │
│        │                                            │
│   embedded-server.mjs ← 被 --extension import 进来   │
│        │                                            │
│        │ Bun.serve() 监听 port 47821                │
│        ▼                                            │
│   HTTP GET /index.html   ──► 返回 public/ 静态文件    │
│   HTTP GET /api/cost-... ──► 算好数据返回 JSON        │
│   WS   /ws               ──► 双向聊天流              │
└────────────────────┬────────────────────────────────┘
                     │ TCP / localhost
                     ▼
                Tauri WebView（加载 public/，渲染 UI）
```

### 为什么是 in-process，而不是独立后端

这是本设计最值得理解的地方。常规思路会写成**两个进程**：

```
WebView ──► 独立后端 server ──(pi 的 RPC 协议)──► pi 进程
```

中间的独立后端就得用 pi 的 stdin/stdout RPC 协议跟 pi 通信，每次发消息都
要序列化、转发、再反序列化。

Picot 选择把后端**直接塞进 pi 进程**：

```
WebView ──HTTP/WS──► (server 和 pi 同进程，直接拿 pi 对象调)
```

收益：

- **零跳调用** —— server 拿到的是 `pi: ExtensionAPI` 的直接引用，
  `pi.sendUserMessage()` 就是函数调用，没有跨进程序列化、没有 IPC 开销。
- **少一个进程** —— 不用维护第二个进程的生命周期、端口、崩溃恢复。
- **事件天然可达** —— pi 一产生 `message_start` 事件，扩展回调里直接
  `broadcast()` 推给浏览器，无需中转。
- **session 上下文共享** —— 扩展的 `ExtensionContext` 就是 pi 的活动
  session 上下文，`/api/sessions`、`/api/cost-dashboard` 等端点直接访问
  pi 的内存数据，不用再开一条导出通道。

### 一个推论：HTTP/WS 命令与 stdin RPC 天然分离

因为 server 在进程内，它能同时用**两种方式**跟 pi 打交道：

- **直接函数调用**（同进程）——WebSocket 命令、session 事件订阅、REST
  查询全部走这条。这是 server 的默认路径。
- **stdin RPC**（`PiManager::send_rpc`）——只有那些**必须改变 broker
  路由**的操作（`new_session` / `switch_session` / `stop_instance` /
  `spawn_session_process`）才走这条，因为它们要被 Rust 宿主立即感知。

这就是为什么下方 §RPC 架构的“三层通讯”里，路径 ③（stdin RPC）只用于路由
变更，其他一切都在进程内完成。

---

## 代码地图

### `src-tauri/` —— Rust 宿主

Rust 一侧掌管 OS 进程。三个模块分工清晰：

- `src-tauri/src/main.rs` —— Tauri app 装配、Tauri commands、窗口构造、
  启动顺序。要理解进程启动、窗口创建、IPC 表面时从这里读起。
- `src-tauri/src/pi_manager.rs` —— 派生并管理 `pi` 子进程
  （每个工作区一个，每个 session 额外的专用进程）。掌管从 `47821`
  开始的端口分配策略、向子进程注入的 `PI_STUDIO_*` 环境变量、
  以及 `kill_all` 关闭路径。要改 pi 进程的派生/杀死/路由方式时从这里读起。
- `src-tauri/src/broker_ws.rs` —— 独立的 WebSocket server，绑在
  `49xxx` 段端口。WebView 连到它；它把帧转发到 embedded-server.ts 的
  WebSocket，把上游消息包成 `broker_event` 信封，运行 `broker_control`
  命令路由（`new_session` / `switch_session` / `stop_instance` /
  `spawn_session_process` / `open_devtools`）。要改路由语义或加新
  broker 命令时从这里读起。

**架构不变量：** Rust 绝不重新实现 pi 运行时逻辑。它只做进程管理
和消息转发。

**API 边界：** 唯一稳定的 Rust ↔ WebView IPC 入口是
`cmd_retry_startup`（仅供 bootstrap 错误窗口使用）。所有其他
WebView ↔ 宿主流量都走 broker WebSocket。

### `extensions/embedded-server.ts` —— 内嵌 pi extension + HTTP/WS server

这是仓库中最大（≈116 KB）也最核心的文件。它是一个 pi-mono extension，
在首次 `session_start` 时，于 `PI_STUDIO_PORT`（默认 `47821`）启动一个
HTTP+WS server。该 server 是**进程作用域**的 —— 它在 `new_session` /
`switch_session` / `fork` 触发的 extension 重载中存活。

该 server 暴露两类表面：

- **HTTP REST** 在 `/api/*` 下 —— `/api/health`、`/api/sessions`、
  `/api/files`、`/api/files/content`（读 / 条件写）、
  `/api/files/raw`（图片 / PDF）、`/api/search`、`/api/cost-dashboard`、
  `/api/lan-qr`、`/api/instances`、`/api/open`、`/api/agent-config`、
  `/api/models-config`、`/api/git-branch`，加 `POST /api/rpc` 透传。
  `public/` 下的静态资源在 `/` 下分发。
- **WebSocket** 在 `/ws` —— 命令分发器。每个连接的客户端发 JSON 命令
  （`send_user_message`、`abort`、`set_model`、`set_thinking_level`、
  `switch_session`、`new_session`、`fork`、`list_models`、`list_auth`、
  `get_auth`、`export_html`、`git_branch`），并接收 pi session 事件的
  广播。

WebView 还有第二条 HTTP 路径：`http://localhost:47821/...`，用于直接
REST 查询。broker WebSocket 是**唯一**承载实时 session 事件和路由变更
命令的路径。

HTTP+WS server 有两条运行时路径：`Bun.serve`（生产环境，pi 通过
`bun build --compile` 编译），以及 `http.createServer` + `ws`
（`tauri dev` 模式，`.ts` 源码由 jiti 加载）。模块初始化时探测
`Bun.serve` 来决定走哪条。

**架构不变量：** 内嵌的 HTTP/WS server 是**进程作用域**的，不是 session
作用域。在 `session_shutdown` 关掉它会与下一次 `session_start` 竞态，
并丢掉 WebView 的连接。

**API 边界：** 任何新的 RPC 命令类型都放进 `handleCommand` **和**
`wrap_upstream_message` 广播路径。新的 REST 端点放进 `handleApiRoute`。

### `public/` —— vanilla-JS WebView 前端

前端刻意保持无框架。**一个文件一个职责**。最后才读 `app.js` —— 它是
编排器（≈122 KB），不是堆业务逻辑的地方。

按功能分组：

- **入口 / 状态** —— `app.js`、`state.js`、`transport.js`、
  `websocket-client.js`、`session-routing.js`。新增 transport 层的
  消息类型时碰它们。
- **聊天渲染** —— `message-renderer.js`、`tool-card.js`、`markdown.js`、
  `public/vendor/remend.js`（第三方流式 markdown 修复）。
- **侧栏 / 文件工作区** —— `session-sidebar.js`、`recent-sessions.js`、
  `file-browser.js`、`file-preview-panel.js`、`file-tab-state.js`、
  `file-preview-renderers.js`、`file-preview-markdown.js`、
  `file-pdf-preview.js`、`code-editor.js`、`file-language.js`、
  `sidebar-search-control.js`。
- **用量 / 设置 / 更新器** —— `cost-infobar.js`、`cost.html`、`cost.js`、
  `app-settings-editors.js`、`app-settings-toggles.js`、
  `settings-save-status.js`、`app-updater.js`。
- **工作区管理** —— `workspace-actions.js`、`folder-picker.js`、
  `dialogs.js`、`package-install-status.js`。
- **主题 / 视觉** —— `themes.js`、`style.css`、`style-theme.css`、
  `cost.css`、`layout-insets.js`。
- **辅助 / 导航** —— `history-scroll-anchor.js`、
  `chat-history-navigation.js`、`app-voice-input.js`、
  `app-context-viz.js`、`onboarding-state.js`、`new-session-refresh.js`、
  `bootstrap.html`（错误兜底窗口）。`chat-history-navigation.js` 是
  聊天历史导航器（左侧 tick rail + 预览卡片），详见下方
  §聊天历史导航。

测试以 `*.test.js` 形式贴在对应模块旁（jsdom + vitest）。

**架构不变量：** 不在 `app.js` 内部添加业务逻辑。如果一个特性超过
~50 行，就抽到独立文件里，从合适的入口点 import。

#### 中间栏是 Picot 自研前端 —— Pi 在这里没有 web UI

中央的聊天面板**完全由 Picot 自有的 DOM 代码渲染**，不是 Pi 自身 UI
的嵌入视图。Pi 以 `--mode rpc` 运行，stdout 被丢弃，所以它从不生成
任何 HTML 或 TUI；WebView 只通过路径 ①（broker-ws → embedded-server.ts
WebSocket）和路径 ②（HTTP REST）跟它通讯。

具体来说，一条 assistant 响应到达屏幕是这样发生的：

1. Pi 发出 `message_start` / `message_update` / `message_end`（以及
   `agent_end`）事件。生产环境这些是 pi stdout 上的 typed JSON-Lines；
   embedded server 在 extension 层拦截它们，再通过它自己的 `/ws` 广播。
2. broker（`src-tauri/src/broker_ws.rs::run_upstream`）连到那个 `/ws`，
   把每帧包成 `broker_event`（带 `sourcePort` / `sessionId`），转发给
   WebView。
3. `public/websocket-client.js` 收到 `event` 帧，在自己上派一个
   `rpcEvent` `CustomEvent`。
4. `public/app.js` 里的编排器按事件类型分发：`message_start` →
   `handleMessageStart` → `messageRenderer.renderAssistantMessage(
{ content: "" }, true)`；`message_update`（带 `text_delta` /
   `thinking_delta`）→ `updateStreamingMessage` /
   `updateStreamingThinking`；`message_end` → `finalizeStreamingMessage`
   （usage + cost）。
5. `public/message-renderer.js` 接收原始的 `message.content`（要么是
   字符串，要么是 `text` / `thinking` block 数组 —— 从来不是 HTML），
   经过 `public/markdown.js`（流式预览用 `renderStreamingMarkdown`，
   最终用 `renderMarkdown`）。`remend`（`public/vendor/remend.js`）
   用来补齐未闭合的内联 markdown，让流式预览不会暴露原始 `**` 标记。
6. 工具调用卡片（`read` / `write` / `edit` / `bash` 等）来自
   `public/tool-card.js`，是 `message-renderer.js` 的并行兄弟模块，
   负责渲染 Pi 发出的结构化工具事件。

上述每一步都在 WebView 的 JS 引擎里执行。这条管道里**没有任何**指向
Pi 的 `<iframe>`，也**没有任何**调用返回 HTML 的 Pi HTTP 页面。
`public/` 前端端到端拥有中间列。

**架构不变量：** Pi 被当作无头后端处理。刻意没有 `embed_pi_ui` 这类
桥接，embedded-server 也从不提供代表聊天的 HTML 页。新聊天功能
（markdown 扩展、新工具卡片、code-block 渲染）都放进 `public/`；
严禁通过让 WebView 指向 Pi 服务的 HTML 来引入。

**API 边界：** Pi 与聊天面板之间的契约是 session event schema
（`message_start` / `message_update` / `message_end` / `tool_call` /
`agent_end`）。`public/message-renderer.js` 里的渲染代码应当**防御式**
地容忍缺失 / 多余字段 —— Pi 可能在 renderer 尚未知晓时新增事件类型。

### `scripts/` —— 自动化

- `scripts/fetch-pi-binary.js` —— 下载 `scripts/pi-version.json` 锁定的
  平台 tarball，解压到 `src-tauri/resources/pi/`，ad-hoc 签名 binary。
  `bun run dev`、`bun run build` 都会跑，也作为 Tauri 的
  `beforeDevCommand` / `beforeBuildCommand` 钩子。
- `scripts/build-extensions.js` —— esbuild 把
  `extensions/embedded-server.ts`（以及其他 extension）打成
  `extensions/dist/*.mjs`。仅 release 构建时跑（`beforeBuildCommand`）。
- `scripts/check-rust.sh` —— `cargo check` + `clippy -D warnings` +
  建议性的 `cargo fmt --check`。`bun run check:rust` 调用。
- `scripts/check-tauri-permissions.js` —— 校验
  `src-tauri/capabilities/*.json` 与实际 `#[tauri::command]` 表面对应。
  `bun run test` 调用。
- `scripts/pi-version.json` —— 内嵌 pi 版本的唯一真理源。改一行，
  接着跑 `bun run fetch:pi`。

**架构不变量：** `src-tauri/resources/pi/` 是构建产物。它是 gitignored。
唯一提交的 pin 是 `scripts/pi-version.json`。

### 内嵌 pi binary —— `src-tauri/resources/pi/`

发布的 `.app` 永远包含一个真实的 `pi` 可执行文件。保证这条不变性的链路：

1. `tauri.conf.json` 的 `bundle.resources` 把 `./resources/pi` 映射成 `pi`，
   整个目录会被复制到 `<App>.app/Contents/Resources/pi/`。
2. `tauri.conf.json` 的 `build.beforeBuildCommand` 在打包前跑
   `bun run fetch:pi && bun run build:extensions`。
3. `package.json` 的 `prebuild` 跑同样两个命令。
4. `src-tauri/build.rs` 在 release profile 下若 binary 缺失会编译期
   panic，因此 `cargo build --release` 不会悄悄产出没有 pi 的 app。

用户 `$PATH` 上安装的 pi 与之无关 —— 内嵌版本是 Picot 唯一会派生的
那个。用户放在 `~/.pi/agent/extensions/` 和 `<workspace>/.pi/extensions/`
下的 extension 仍会被内嵌 pi 自动加载，与正常 pi session 行为一致。

---

## RPC 架构 —— 三层通讯

Picot ↔ pi 有三条不同的通讯路径。把它们混淆是本仓库最常见的架构错误来源。

```
┌──────────────────┐                                    ┌─────────────────────────────┐
│   WebView (JS)   │                                    │  pi 进程                     │
│                  │                                    │                             │
│  index.html +    │  ① ws://49xxx/ui-ws (broker)       │  embedded-server.ts         │
│  app.js 等       │◄───────────────────────────────────►│  ┌──────────────────────┐   │
│                  │   发: broker_control / ws 帧        │  │ http server :47821   │   │
│                  │   收: broker_event / ws 帧          │  │   /api/health        │   │
│                  │                                    │  │   /api/sessions      │   │
│                  │                                    │  │   /api/files 等      │   │
│                  │  ② http://47821/api/* (REST)       │  │   /ws  (WebSocket)   │   │
│                  │───────────────────────────────────►│  └──────┬─────────┬──────┘   │
│                  │   GET /api/sessions 等              │         │         │          │
└──────────────────┘                                    │    ┌────▼─────┐  ┌─▼────────┐ │
        ▲                                                │    │Broker-Ws │  │ pi core  │ │
        │                                                │    │port 49xxx│  │ CLI/     │ │
        │ ③ stdin RPC                                    │    └──────────┘  │ runtime  │ │
        │   Tauri PiManager::send_rpc                    │                  └──────────┘ │
┌───────┴─────────────────────────────────────────────────────────┐                   │
│  Picot Tauri (Rust)                                              │                   │
│  PiManager ───────── 派生 Command ──────────────────────────────►│                   │
│  BrokerWs   ───────── 重连 750ms ────────────────────────────────►│                   │
└──────────────────────────────────────────────────────────────────┘                   │
```

### 路径 ① —— WebView ↔ broker-ws ↔ embedded-server.ts WebSocket

运行时关键路径。实时 session 事件通过这条路径回到 WebView。
WebView 发来的命令（`new_session`、`switch_session`、`stop_instance`、
`spawn_session_process`、`open_devtools`）被包成 `broker_control` 帧；
broker 根据 session-id → port 路由表（从上游 `sessionId` 字段学习）解析
目标端口再转发。

### 路径 ② —— WebView → embedded-server.ts HTTP REST

只读数据路径。供 `GET /api/sessions`、`/api/cost-dashboard`、
`/api/files`、`/api/search`、`/api/git-branch`、`/api/lan-qr`、
`/api/instances`、`POST /api/open`、`POST /api/agent-config`、
`POST /api/models-config`、`POST /api/rpc` 使用。不经过 broker；
WebView 直接对 `localhost:47821` 开第二条 HTTP 连接。

### 路径 ③ —— Tauri PiManager → pi stdin（stdin 上的 RPC）

进程内命令路径。`PiManager::send_rpc(port, json)` 写一行 JSONL 到
pi 子进程的 stdin。实际使用中它专供那些**必须改变 broker 路由**的
Tauri command handler（`new_session_core`、`switch_session_core`、
`stop_instance_core` 以及专用的 `spawn_session_process_core`）。

`pi --mode rpc` 的 stdio 协议由 pi 自己消费；**embedded extension
并不通过这条路径被调用**。extension 在进程启动时由 `--extension` 触发
一次加载，之后与 pi 同进程存在，通过路径 ① 访问。

### 为什么是三条路径

- 路径 ① 让 WebView 与 `pi --mode rpc` 的机制解耦；broker 是唯一
  需要懂 RPC 的组件。
- 路径 ② 是廉价的 HTTP，避免 broker 成为只读数据查询的串行瓶颈。
- 路径 ③ 留给那些**下一帧就必须对 broker 可见**的路由变更操作。

---

## 启动顺序

`main.rs::setup()` 按以下顺序执行：

1. 从 `~/.pi/agent/sessions/` 和用户设置文件解析 resume 目标。
2. `manager.next_port()` —— 选第一个空闲的 `≥ 47821` 端口。
3. `manager.spawn(cwd, port, session)` —— `Command::new(pi)`，附带
   `PI_STUDIO_STATIC_DIR`、`PI_STUDIO_PORT`、增强过的 `PATH`、
   `PI_STUDIO_PI_VERSION`，并使用 piped stdin。
4. `broker.register_session(port, session)` —— 启动 broker 的重连循环
   （`ws://127.0.0.1:{port}/ws` 失败时每 `750 ms` 重连）。
5. `wait_for_pi_health(port, 30)` —— 轮询 `GET /api/health`，最多 30 秒。
   轮询使用 `.no_proxy()` 构建的 `reqwest::Client`，确保 loopback 请求
   绝不经由系统 HTTP 代理（见下方不变量 _loopback HTTP 必须绕过系统代理_）。
6. **成功：** `open_workspace_window(port, broker.url())` 创建 WebView；
   WebView 从 URL query string 读 `brokerWs`，然后连上 broker WebSocket。
7. **失败：** `broker.unregister_port(port)`，**不创建**窗口。
   只有当第 3 步派生 pi 本身就失败时（例如 binary 缺失），才会开
   `bootstrap` 错误窗口。

`on_window_event` 处理器在窗口销毁时杀掉该工作区的专用 session
进程以及主 pi 进程。`RunEvent::Exit` 触发 `manager.kill_all()` 走
正常关闭路径；**`SIGKILL` 不会触发它**，会留下持有端口的孤儿 pi 进程。

---

## 窗口目录

所有 Picot 窗口都由 Rust 构造（`tauri.conf.json` 的 `app.windows: []`
故意留空）。

| Label              | 构造者                  | URL                                                               | 用途                                                |
| ------------------ | ----------------------- | ----------------------------------------------------------------- | --------------------------------------------------- |
| `workspace-{port}` | `open_workspace_window` | `http://localhost:{port}/?brokerWs=ws://localhost:{broker}/ui-ws` | 主聊天 UI。每个工作区一个。                         |
| `bootstrap`        | `open_bootstrap_window` | `bootstrap.html?startupError=...`                                 | 错误兜底窗口。仅当 `manager.spawn` 派生失败时打开。 |

同一工作区下开新 session **不会**开新 OS 窗口；它派生一个无头
专用 pi 进程，再把现有 WebView 导航到新端口。之前在跑的 pi 进程
被保留，可从 running-instances 列表 / launcher / 侧栏访问。

---

## 配置布局

| 文件                          | 作用域 | 用途                                                                     |
| ----------------------------- | ------ | ------------------------------------------------------------------------ |
| `scripts/pi-version.json`     | 仓库   | 内嵌 pi 版本的唯一真理源。                                               |
| `tauri.conf.json`             | 仓库   | 打包配置、`beforeBuildCommand`、图标、CSP、updater pubkey。              |
| `package.json`                | 仓库   | JS 依赖和 dev 脚本。                                                     |
| `biome.json`                  | 仓库   | Lint 和 format 规则。                                                    |
| `~/.pi/agent/settings.json`   | 用户   | provider 配置、API key、默认端口（pi 后备值）。                          |
| `~/.pi/agent/sessions/`       | 用户   | 每个工作区的 session `.jsonl` 文件。                                     |
| `~/.pi/agent/extensions/`     | 用户   | 全局加载的 pi extension。                                                |
| `<workspace>/.pi/extensions/` | 工作区 | 工作区级 pi extension。                                                  |
| `~/.pi/pistudio-instances/`   | 用户   | 由 embedded-server 写的每进程 instance registry（pid → port）。          |
| `src-tauri/capabilities/`     | 仓库   | Tauri v2 capability 声明；由 `scripts/check-tauri-permissions.js` 校验。 |

---

## 边界与不变量

这些是支撑整个系统的结构性规则。大多数是关于**绝不能**发生的事。

- **Rust 不重新实现 pi。** Rust 只管进程和消息转发；session 逻辑归 pi。
- **内嵌 server 与 pi 同进程（in-process）。** `embedded-server.ts` 通过
  `--extension` 被 import 进 pi 进程，持有 `ExtensionAPI` 的直接引用，
  起的 HTTP/WS 服务器就是 pi 进程本身在监听端口。**绝不要**把
  embedded-server 改写成对 pi 开 stdin/stdout RPC 的独立后端进程——那
  会失去零跳调用和事件直达，并被迫重新引入 RPC 转发层。新增“驱动 pi”
  的逻辑应放进 extension 的 `handleCommand` / 事件订阅里，而不是新建
  一个外部服务去调用 pi。
- **内嵌 server 是进程作用域，不是 session 作用域。** `session_shutdown`
  不得关闭 HTTP/WS server。
- **pi 用 stdin RPC 改路由，embedded extension 负责其他一切。** 改 broker
  的新命令走 `broker_control` 路径；改 session 行为的新逻辑放进 extension
  的 `handleCommand`。
- **前端是纯 vanilla JS，不使用框架。** 每个新特性独立成文件；
  逻辑不内联到 `app.js`。
- **`src-tauri/resources/pi/` 是构建产物。** Gitignored。唯一提交的 pin
  是 `scripts/pi-version.json`。
- **`bun.lock` 是唯一提交的锁文件。** `package-lock.json` 已在 `.gitignore`；
  跑 `npm install` / `npm ci` 是 CI 风险。
- **Tauri v2 capabilities 必须与命令表面对应。** 这条不变量由
  `scripts/check-tauri-permissions.js` 在 `bun run test` 中强制。
- **Rust 进程只派生内嵌 pi binary。** 绝不调用 `$PATH` 上的 `pi`。
- **loopback HTTP 必须绕过系统代理。** Rust 宿主发往内嵌 pi
  （`localhost:47821`）的每个请求，都必须用 `.no_proxy()` 构建的
  `reqwest::Client` 发出。默认的 `reqwest::get` 会读取
  `HTTP_PROXY` / `HTTPS_PROXY` 环境变量，以及 macOS 的 System
  Configuration 代理设置（例如 Clash/ClashX 的 `127.0.0.1:7890`）。
  该代理不在 pi 的 loopback 上，于是返回 `502 Bad Gateway`（空 body、
  `connection: close`），`status < 500` 重试循环会一路追到超时 ——
  Picot 表现为永久挂起、无窗口，而同一 shell 里的 `curl` 却成功
  （curl 遵守 macOS 的 `ExceptionsList`，其中包含 `localhost` 和
  `127.*`）。修复在 `wait_for_endpoint`
  （`src-tauri/src/pi_manager.rs`）；未来任何 Rust→pi 的 HTTP 调用
  都必须以同样方式构建 client。

---

## 横切关注点

### 配置

两层。仓库级：`tauri.conf.json`、`scripts/pi-version.json`、
`biome.json`、`package.json`。用户级：`~/.pi/agent/settings.json`、
`~/.pi/agent/sessions/`、`<workspace>/.pi/extensions/`，加上
运行时写入的 `~/.pi/pistudio-instances/`。Rust 进程只读
`~/.pi/agent/settings.json` 来获取用户上次的工作区路径；它不依赖
该文件存在。

### 错误处理

- **Rust：** 派生失败以 `Result<_, String>` 返回；`setup` 闭包记录错误
  并开 `bootstrap` 窗口。`bootstrap` 窗口只有一个 Retry 按钮，
  调用 `cmd_retry_startup`。
- **embedded-server：** REST 错误返回带 `error.message` 的 JSON；
  WebSocket 错误返回 `error(id, message)` 信封，且只发给发起方。
- **前端：** 连接失败触发 `transport.js` 的重连循环；命令失败在
  聊天输入框内联显示，不用全局 modal。

### 测试

- `bun run test` 跑 vitest（`public/**/*.test.js`，jsdom）加
  `scripts/check-tauri-permissions.js`。
- 前端单元测试贴在对应模块旁。
- `embedded-server` 在与框架无关的逻辑上有单元测试（搜索、session
  列表、cost-dashboard 聚合、git-branch 解析、LAN URL 构建）。
- 没有自动化 UI 测试。仓库的规约是：每次改 Rust 后跑
  `bun run check:rust`，每次改前端 / extension 后跑 `bun run check`（biome）。

### 可观测性

- **Rust 日志** 在 macOS 上通过 `tauri-plugin-log` 写到
  `~/Library/Logs/works.earendil.picot/Picot.log`。每次启动会输出
  `startup resume target selected`、`spawning pi`、`child PATH diagnostics`
  三行 —— 调试"窗口没出现"时，看这三行。
- **embedded-server** 日志写到 stdout（Rust 宿主通过 `Stdio::null()`
  丢弃）；开发时如需看到，可以 attach debugger 到 jiti 加载的进程。
- **broker** 在每次重连 / 失败时打 `connected upstream port {N}` 和
  `unregister_port port {N}`。

### 并发

- `PiManager` 是 `Arc<Mutex<HashMap<u16, PiProcess>>>` —— 进程所有权是
  唯一被串行化的段。
- `BrokerWs` 是 `Arc<BrokerInner>`，每个字段有内部 `Mutex`
  （clients、routes、upstreams、active_port、disabled_ports）。
- embedded-server.ts 中的 HTTP/WS server 是进程作用域、单实例；
  每个 session 的状态在 `session_start` 时发布到全局，在
  `session_shutdown` 时清理。

### 跨端口状态持久化（cookie 模式）

每个 workspace 窗口加载自不同端口的 `http://localhost:<port>`，
而 `localStorage` 按 origin（端口）隔离。需要跨所有本地 workspace
窗口一致的浏览器侧状态，用 `Path=/` 的 cookie 持久化 —— `localhost`
的 cookie 跨端口共享。目前三个消费者：

| Cookie key              | 模块                 | 用途                          |
| ----------------------- | -------------------- | ----------------------------- |
| `pi-studio-theme`       | `themes.js`          | 主题选择                      |
| `picot-language`        | `i18n.js`            | 语言偏好（en / zh / system）  |
| `picot-recent-sessions` | `recent-sessions.js` | RECENT 会话 MRU 列表（≤5 条） |

RECENT 会话的完整设计见
[`docs/superpowers/specs/2026-07-11-recent-sessions-design.md`](docs/superpowers/specs/2026-07-11-recent-sessions-design.md)。
该 cookie 存百分编码的 JSON 数组（session `filePath`），同步读写，
last-write-wins 语义；并发窗口可能丢失中间 MRU 排序，下一次访问
重写完整的五条列表。`SessionSidebar.setActive()` 是唯一记录入口。

### 文件浏览、预览与编辑

文件工作区由右侧的 `FileBrowser` 和中央可调整尺寸的
`FilePreviewPanel` 组成；它是 WebView 的本地 UI，不是 OS Finder 或
编辑器的嵌入视图。

1. `FileBrowser.load()` 通过 `GET /api/files?scope=workspace` 懒加载目录。
   单击文件调用 `FilePreviewPanel.openFile()`；双击仍经 `POST /api/open`
   交给系统默认应用。
2. 文件行的拖拽不是 HTML5 DnD。WKWebView 在此场景不完整派发
   `dragover` / `drop`，所以 `FileBrowser` 用 mouse 生命周期和
   `elementFromPoint()` 检测落点，在聊天输入框的选择区插入工作区相对的
   `@path` mention。修改这段交互前必须读
   [`docs/custom-drag-interactions.md`](docs/custom-drag-interactions.md)。
3. `FilePreviewPanel` 编排标签、可折叠 / 放大面板、分隔条、脏状态、
   1.5 秒自动保存、保存冲突对话框和 renderer 生命周期；
   `FileTabState` 将**标签身份、顺序、选中标签和预览 / 编辑模式**按
   workspace root 存进该端口的 `localStorage`（最多 20 个 root）。
   未保存内容、加载态和冲突态绝不持久化。
4. `file-preview-renderers.js` 按 `file-language.js` 的分类分派：
   Markdown 经 allowlist sanitizer 后预览，普通文本用 CodeMirror，
   图片走 `<img>`，PDF 用 PDF.js canvas renderer。CodeMirror / PDF.js
   是 `scripts/build-frontend.js` 打出的同源 vendor bundle；源代码在
   Vitest 中仍直接解析 npm 包。

**文件 API 安全边界：** 浏览器传来的绝对路径一律是不可信输入。
`file-routes.ts` 先将路径 realpath 后限制在活跃 workspace，再仅以
canonical regular file descriptor 读取或写入，拒绝符号链接与路径竞态。
预览文本最大读取 2 MiB，编辑最大 1 MiB；写入以前一次读取的 `mtimeMs`
做乐观并发检查，冲突返回 `409`，由面板让用户 reload 或 overwrite。
`/api/files/raw` 只服务已分类的图片和 PDF，且带 `no-store`、`sandbox`
CSP 与 `nosniff`。不要把 `scope=picker`、`/api/open` 的宽松路径语义
复制到预览或写入端点。

完整交互、状态模型和端点契约见
[`docs/superpowers/specs/2026-07-12-file-preview-editor-design.md`](docs/superpowers/specs/2026-07-12-file-preview-editor-design.md)。

### 国际化 (i18n)

首期支持**中英双语**（Picot 的 WebView 都是同一个仓库内的 ES module）；
架构上预留扩展其他语言的能力。完整方案来源：
[`docs/superpowers/specs/2026-07-08-i18n-design.md`](docs/superpowers/specs/2026-07-08-i18n-design.md)。
本节只描述设计骨架与对工程的影响，决策理由详见 spec；code review 时的
硬性规则清单见 AGENTS.md §Localization。

**核心约束**

- **零依赖、零构建**。i18n 引擎是 `public/i18n.js` 自建的 ~250 行模块，
  与 `themes.js` 的 cookie 持久化模式完全对称。不引入 i18next 等第三方。
- **cookie 而不是 localStorage** 来持久化语言偏好（cookie key：
  `picot-language`）。每个 workspace 是不同端口的 `localhost` ——
  localStorage 按端口隔离，无法跨 workspace 窗口共享；cookie 同源共享，
  是唯一可行解。详见上方 §跨端口状态持久化（theme / language / RECENT
  共用同一模式）。
- **顶层 await**：`app.js` 启动时 `await initI18n()`，locale JSON < 15KB，
  阻塞几十毫秒可接受。`initI18n()` 内部捕获所有错误，失败 fallback
  英文，绝不阻塞 app 启动（最差情况显示英文或 key 本身）。

**初始化时序**

`app.js` 启动时按 `applyTheme()` → `await initI18n()` → 其它 UI 初始化
的顺序执行。`initI18n()` 必须在任何 `t()` 调用、任何带 `data-i18n`
属性的节点被读之前完成；放在 `applyTheme()` 之后是因为主题切换早
完成早对用户可见，把 i18n 串在后面读 cookie + fetch locale JSON 让首
屏不卡。

**引擎架构（`public/i18n.js`）**

模块导出的核心 API：

| API                                          | 行为                                                                                                                                                                           |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `await initI18n()`                           | 加载英文 fallback + 当前 locale JSON，扫描 `document` 上的 `data-i18n*`，设置 `document.documentElement.lang` 为 BCP47 tag（`en` / `zh-CN`）                                   |
| `t(key, params?)`                            | 翻译函数。`activeMessages` → 英文 `enMessages` → 缺失时 `console.warn` 并返回 key。支持 `{var}` 插值。**返回纯文本**，不可直接进入 `innerHTML` —— 详见 AGENTS.md §Localization |
| `await setLocale(preference)`                | 切换语言：`"system" \| "en" \| "zh"`。内部用 `localeLoadSequence` 防快速切换的竞态；fetch 成功才写 cookie（fetch-then-persist），失败 fallback 英文但不持久化坏偏好            |
| `getLocale()`                                | 当前生效 locale（`"en" \| "zh"`）。fallback 后返回 `"en"`                                                                                                                      |
| `getLanguagePreference()`                    | 用户偏好（含 `"system"`）。非法 cookie 值归一化为 `"system"`                                                                                                                   |
| `onLocaleChange(listener)`                   | 订阅语言变化，返回 unsubscribe。**即时切换**成立的核心                                                                                                                         |
| `LANGUAGES`                                  | 设置面板用的语言选项常量                                                                                                                                                       |
| `resolveLocale(preference, systemLanguage?)` | 纯函数（测试可注入）：根据偏好 + 系统语言解析 locale                                                                                                                           |

**`t()` 查找链**：`activeMessages` 命中即返回 → 缺则查常驻的
`enMessages` → 都没有则 `console.warn` 并返回 key 本身。`enMessages`
在初始化时加载一次，永不卸载 —— 是整个 fallback 链路的"地板"。

**`setLocale()` 竞态保护**：每次 `setLocale` 调用把 `localeLoadSequence`
加一，fetch 完成后比对当前值。晚返回的旧 fetch 会被丢弃（不会覆盖
新选择的 locale / cookie / preference），与 `FileBrowser.loadSequence`
同模式。这个保护是必须的，因为用户可以在 Settings → Language 里
快速点多个 radio。

**`onLocaleChange()` 事件总线**：内部维护一个 `Set<listener>`，
`setLocale()` 成功后逐个回调，最后派发一个 `CustomEvent("picot:locale-change")`
作为兜底。两个入口都安全；模块要么 `import` 回调函数，要么监听
`window` 的事件（后者是兜底，主要给像 `cost.html` iframe 这种
运行在独立 document 的场景用）。

**静态 HTML 标注**

| 属性                         | 替换目标      |
| ---------------------------- | ------------- |
| `data-i18n="key"`            | `textContent` |
| `data-i18n-ph="key"`         | `placeholder` |
| `data-i18n-title="key"`      | `title`       |
| `data-i18n-aria-label="key"` | `aria-label`  |
| `data-i18n-alt="key"`        | `alt`         |

HTML 上保留英文原文作为 fallback（i18n 初始化前极短窗口可见，避免
空文本闪烁）。

**Phase 1 不支持 `data-i18n-html`**。需要 HTML 结构的复杂文本（含
`<code>` / `<a>` 等内嵌元素）用"拆分 DOM 节点"方案：相邻兄弟节点
各自带 `data-i18n`，用静态 `<code>` / `<a>` 拼接。SPEC §4.5 有完整示例。

**Listener 生命周期**

两类订阅者，规则刚好相反：

- **单例组件**（`SessionSidebar`、`MessageRenderer`、`FileBrowser`、
  `DialogHandler`、`app-updater` 等整个 app 生命周期都活着的模块）：
  构造时注册一次，listener 跨整个 app 生命周期保留；回调内部 guard
  UI 是否存在。**`close()` / `hide()` 不要 unsubscribe** —— 下一次
  打开同一单例 UI 时会失去 locale-change 支持，是最难调的一类 bug。
- **临时组件**（每次打开都 new 一个实例的，如 `FolderPicker`）：
  `this.unsubscribeLocaleChange = onLocaleChange(...)`；`destroy()` /
  `close()` 中调用。

回调里读动态 UI 时要 guard（如
`if (this.container.children.length > 0) this.render();`），避免对
已销毁节点操作。语音识别这种长生命周期但无 DOM 的模块，回调里更新
**配置**（`recognition.lang = ...`），不重渲染。

**即时切换（live switch）**

`setLocale()` 后，已渲染的动态 UI 必须立即更新，无需刷新。这是
i18n 和单纯 i18next 之类库的关键区别 —— `initI18n()` 只在启动时
扫一次 DOM，运行时切换需要每个动态组件在 `onLocaleChange` 回调里
自更新（welcome、sidebar、tool-card status + copy 按钮、code block
copy 按钮、message copy 按钮、file-browser status、settings panel
labels 等）。

没有稳定 selector 的元素，渲染时**加 `data-*` 锚点**（例：
`data-status="complete"`、`data-locale-dependent`）供回调定位。
spec §4.10 有完整组件 → 切换范围矩阵。

**Key 命名**

点分嵌套，第一级为模块名：`sidebar.*`、`composer.*`、`settings.*`、
`files.*`、`status.*`、`errors.*`、`actions.*`、`messages.*`、
`tools.*`、`onboarding.*`、`bootstrap.*`、`chatNavigation.*`。`actions.*` 存按钮文本
（Save、Cancel、Remove、Retry），`status.*` 存状态文本（Saving、
Saved、Connecting、Connected 等），`errors.*` 只存错误消息（不放
按钮文本）。嵌套不超过 3 层。`en.json` 是 source of truth，
`zh.json` 必须包含所有 en 的 key（CI 强制）。

**底层错误边界**

`transport.js` 等底层模块的协议错误**不翻译**。上层展示时用 `t()`
包裹用户可见的前缀文本，原始 error message 保留英文作为 `{error}`
插值参数：

```js
const message = t("errors.failedToStart", {
  what: "session",
  error: String(e),
});
renderError(message);
```

`renderError` 内部要么用 `textContent`，要么对入参 `escapeHtml` —
裸字符串不可进入 `innerHTML`。

**独立 / 嵌入页面：**

`bootstrap.html` 是独立错误页，使用内联翻译并正确处理 `"system"` 偏好。
设置面板将 `cost.html` 嵌入为 `/cost` iframe；`cost.js` 在自己的 document
中 `await initI18n()`，从跨端口共享的 `picot-language` cookie 读取偏好。
设置页的语言按钮在 `setLocale()` 完成后调用
`refreshUsageIframeLocale()` 重载 iframe，因此嵌入的成本面板立即采用新语言。
`cost.js` 的 `onLocaleChange` 也覆盖该页面被独立打开时的本地切换；主题嵌入
同步仍由 `cost.js` 单独处理。

### 聊天历史导航 (Chat History Navigator)

聊天历史导航器是一个纯前端的 pointer-only overlay，让用户在一个长会话
里按 user turn 快速跳转。完整交互设计见
[`docs/superpowers/specs/2026-07-14-chat-history-navigation-design.md`](docs/superpowers/specs/2026-07-14-chat-history-navigation-design.md)。
本节描述它的模块边界、数据流、生命周期、安全和验证约束。

**模块边界与所有权**

- `public/chat-history-navigation.js` 拥有：turn 索引、rail 和 preview DOM、
  tick 布局与放大、active-turn 滚动追踪、点击导航、流式摘要更新和生命
  周期清理。它导出一个工厂函数（带 fallback），通过
  `addUserTurn` / `beginAssistantMessage` / `updateAssistantMessage` /
  `completeAssistantMessage` / `invalidateLayout` / `reset` / `destroy`
  七个方法暴露公共 API。
- `public/app.js` 是编排器：它创建导航器，转发现有的聊天生命周期事件
  （用户消息渲染、流式开始 / 更新 / 完成、布局失效、会话切换）。**严禁**
  在 `app.js` 内放 tick 计算、preview 渲染或 turn 索引逻辑。
- `message-renderer.js` 暴露窄回调或返回值，提供已渲染的 DOM 元素和
  可见源文本（user 渲染返回 `HTMLElement`）。它不拥有导航器 UI。
- 样式在 `public/style.css` 的 `Chat History Navigator` 段落，使用现有
  design token（`--text-ghost` / `--text-secondary` / `--border-bright` /
  `--bg-frosted` / `--blur-heavy` / `--radius-md` / `--ease` / `--duration`
  等），不引入新 token。

**数据流**

渲染管道直接供给 turn 数据。导航器**不得**通过抓取已渲染的 Markdown
恢复源内容 —— 直接数据保留了可见响应文本与隐藏 thinking / tool 内容
之间的边界。一个 turn 从一条可渲染的 user message 开始，在下一条
可渲染 user message 之前结束。该区间内每条 assistant message 的可见
文本被拼接（中间空一行）；tool call 和 tool result 可以出现在 assistant
message 之间，但永远不会拆分一个 turn。

导航器只存储 prompt 的前 2,000 个 Unicode code point 和 response 的前
4,000 个。聊天渲染器保留完整源文本；这些有界副本足够两到三行预览，
并防止导航器在内存中复制无界的会话。

**生命周期**

- 用户提交 prompt 时，导航器以 `waiting` 状态添加一个 turn。
- assistant 生成开始时，状态变为 `streaming`；可见文本 delta 更新
  `assistantText`，thinking 和 tool 事件不更新。
- 生成结束（finalization）时，状态变为 `complete`。
- 历史会话渲染从传给聊天渲染器的 session entries 构建完整的 turn 索引。
- 切换会话、新建会话、清空渲染器或加载历史失败时，先清空旧索引再显示
  新内容（`reset()`）。这会取消所有 pending animation frame、observer
  和 preview 状态。

**安全：预览文本始终惰性**

预览把 user prompt 和 assistant response 当作**不可信文本**。它创建
text node 或赋值 `textContent`，**绝不**用 `innerHTML` 插入任何一个值。
HTML-like payload 和事件处理器字符串在预览中始终是惰性文本。测试用
HTML-like 和 event-handler payload 强制这条边界。这与 i18n 的
`t()` 返回纯文本约束一致（见 AGENTS.md §Localization）。

**验证约束**

- 缺失或畸形的 message 内容产生空摘要，不抛异常。
- 一条没有可见 assistant 文本的完成 turn 保留其状态标签（本地化的
  no-visible-response 文本）。
- 缺失的目标元素在导航前移除 stale turn。
- 导航器故障不得阻塞聊天渲染或滚动。
- 少于两个 user turn 时导航器隐藏；触摸优先和移动布局（`hover: none`
  或 `pointer: coarse` 或 `max-width: 768px`）下也隐藏。
- rail 是 `aria-hidden` 的 pointer-only 增强，不在 Tab 序列中；键盘和
  辅助技术用户通过现有的可滚动聊天面板获得等价的历史浏览路径。
- `chatNavigation.*` i18n key 共四个：`imageMessage`（图片消息）、
  `waiting`（等待回复）、`generating`（生成中）、`noVisibleResponse`
  （无可见响应），en / zh 必须对等。

---

## 如何读这个仓库

- 要加一个**影响 session 路由**的新 RPC 命令，从
  `src-tauri/src/broker_ws.rs::resolve_command_port` 和
  `src-tauri/src/main.rs` 中对应的 `*_core` 开始。
- 要加一个 **WebView 可以调用的命令**，从
  `extensions/embedded-server.ts::handleCommand` 开始，并在
  `public/transport.js` 和 `public/websocket-client.js` 中加对应的
  客户端类型。
- 要加一个 **REST 端点**，从 `extensions/embedded-server.ts::handleApiRoute`
  开始。无需改 broker。
- 要改**窗口本身**，从 `src-tauri/src/main.rs::open_workspace_window` 开始。
- 要改**工作区恢复逻辑**，从 `src-tauri/src/main.rs::setup`（约 line 940
  的 `setup` 闭包）开始。
- 要改** pi 启动方式**，从 `src-tauri/src/pi_manager.rs::spawn`
  （约 line 540）开始。
- 要加一个**新的 UI 面板**，照着 `public/cost-infobar.js` /
  `public/session-sidebar.js` 的模式来：一个 `public/foo.js` 文件加
  旁边的测试，再从 `app.js` import。
- 要改**聊天历史导航器**，从 `public/chat-history-navigation.js` 开始
  （模块边界、数据流和生命周期见 §聊天历史导航）；样式在 `style.css`
  的 `Chat History Navigator` 段落，i18n key 在 `chatNavigation.*`。
- 要**升级内嵌 pi**，改 `scripts/pi-version.json`，跑 `bun run fetch:pi`，
  smoke-test `./src-tauri/resources/pi/pi --version` 和 `bun run dev`，
  只提交 version pin。

## 已知未确定项

- **多屏 macOS 上的窗口定位。** `open_workspace_window` 当前不调
  `.center()`。在多显示器设置下，若保存的 frame 落在已断开的显示器上，
  窗口可能渲染到屏幕外。`.center()` 是一个合理的防御性默认值；
  是否也是长期的正确解，取决于 Tauri 后续对多屏策略的最终选择。
