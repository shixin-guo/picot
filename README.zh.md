# Picot （π-cot(e)）

[English](./README.md) | **中文**

本地桌面 GUI，专为 [Pi](https://github.com/badlogic/pi-mono) 编程 Agent 打造。无需云端，无需账号，完全在本机运行。

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Latest release](https://img.shields.io/github/v/release/shixin-guo/picot?include_prereleases&label=release)](https://github.com/shixin-guo/picot/releases)
[![Platform](https://img.shields.io/badge/platform-macOS-lightgrey.svg)](#%E5%AE%89%E8%A3%85)

Picot 将 `pi` 运行时**直接打包进 .app**，无需单独安装 `pi`，无需配置 PATH，也不存在版本不一致的问题。

<p align="center">
  <img width="1200" alt="Picot 主界面" src="docs/images/hero.webp" />
</p>

---

## 安装

**无需单独安装 `pi` CLI** — Picot 内置了自己的 pi 运行时。

### 一键安装（推荐）

**macOS / Linux：**
```bash
curl -fsSL https://raw.githubusercontent.com/shixin-guo/picot/main/scripts/install.sh | bash
```

**Windows（PowerShell）：**
```powershell
irm https://raw.githubusercontent.com/shixin-guo/picot/main/scripts/install.ps1 | iex
```

脚本会自动识别系统和架构，下载对应安装包并完成安装。macOS 下还会自动清除 Gatekeeper 检疫属性，无需手动点击「仍要打开」。

安装指定版本：
```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/shixin-guo/picot/main/scripts/install.sh | bash -s -- --version v0.3.0

# Windows — 企业 MSI 部署
& ([scriptblock]::Create((irm 'https://raw.githubusercontent.com/shixin-guo/picot/main/scripts/install.ps1'))) -Version v0.3.0 -MSI
```

### 手动下载

[从 GitHub Releases 下载](https://github.com/shixin-guo/picot/releases)

| 平台 | 文件 |
|------|------|
| macOS Apple Silicon | `Picot_*_aarch64.dmg` |
| macOS Intel | `Picot_*_x64.dmg` |
| Linux x86\_64（Debian/Ubuntu） | `Picot_*_amd64.deb` |
| Linux arm64（Debian/Ubuntu） | `Picot_*_arm64.deb` |
| Linux x86\_64（RHEL/Fedora） | `Picot-*-1.x86_64.rpm` |
| Linux arm64（RHEL/Fedora） | `Picot-*-1.aarch64.rpm` |
| Windows x64 | `Picot_*_x64-setup.exe` |
| Windows arm64 | `Picot_*_arm64-setup.exe` |

### macOS 未签名提示

Picot 目前发布的 macOS 版本未经 Apple 开发者 ID 签名/公证。
使用一键安装脚本会自动处理此问题。如需手动安装：

1. 将 `Picot.app` 拖入 `/Applications`
2. 右键点击 → **打开**
3. 若仍被阻止：**系统设置 → 隐私与安全性 → 仍要打开**

<p align="center">
  <img width="420" alt="macOS Gatekeeper 未验证提示" src="docs/images/gatekeeper-warning-zh.webp" />
</p>

点击**完成**：

<p align="center">
  <img width="960" alt="在 macOS 设置中允许打开 Picot" src="docs/images/gatekeeper-allow.webp" />
</p>

---

## 它能做什么

Picot 为 Pi 提供完整的可视化界面。打开任意项目文件夹，与 Agent 对话，浏览会话和文件——无需打开终端。多个项目可以并行运行，每个项目有独立窗口和独立 Agent 进程。

---

## 功能特性

### 📸 界面预览

<p align="center">
  <img width="1200" alt="Picot 工作区与项目界面" src="docs/images/workspace.webp" />
</p>

### 💬 对话

- 完整 Markdown 渲染，代码块语法高亮
- **流式响应**，实时打字效果（基于 remend）
- 图片附件支持——粘贴、拖放或按钮上传
- 编辑工具调用的**内联 Diff 视图**（红绿行对比）
- 工具调用卡片和**思考块**实时渲染
- 一键复制任意消息
- 滚动到底部按钮，含未读消息提示
- **消息队列** — Agent 工作时可继续输入，消息以气泡形式排队，完成后自动依序发送
- **对话轮次导航条** — 聊天区旁的 Codex 风格圆点轨道，悬浮预览、点击跳转到对应轮次
- **命令面板** — 快速执行压缩上下文、展开/折叠所有工具卡片、打开设置、查看帮助
- **从任意消息分叉** — 从对话中任意一点分叉出新会话

### 🗂️ 多会话 & 多 Agent

- **多 Agent 并行** — 每个会话启动独立的 headless pi 进程，不弹新窗口，不中断已有会话
- 从侧边栏浏览并恢复任意历史会话
- 跨所有会话历史**全文搜索**，高亮匹配片段
- 会话按创建时间排序，活跃会话显示绿点
- 内联重命名、收藏、标签和筛选

### 📥 Agent Inbox <sub>（Beta）</sub>

- 接入 Telegram Bot — 收到的私信会进入一个固定置顶的 **Agent Inbox** 会话，与普通项目对话区分开
- 可将 Inbox 中的任务派发给任意已打开项目的 Agent，在可伸缩的任务面板中追踪 待处理 / 运行中 / 已完成 状态
- 任务生命周期事件（已派发、需要更多信息、完成、失败）会回传到 Inbox，并可回复给原始 Telegram 用户
- 设置中内置 Telegram Doctor 检测，快速诊断 Bot / Token / 连通性问题

### 🗃️ 项目与工作区

- **多项目** — 每个项目独立窗口、工作目录、会话历史和 Agent
- 项目头部显示**当前 Git 分支**
- **在外部编辑器中打开** — 直接从 Picot 启动 VS Code、Cursor 等
- 原生文件夹选择器，无需使用终端打开项目

### 📱 移动端 & 局域网访问

<p align="center">
  <img width="900" alt="局域网与移动端访问面板" src="docs/images/lan-mobile-panel.webp" />
</p>
<p align="center">
  <img width="360" alt="移动端上的 Picot" src="docs/images/mobile.webp" />
</p>

- **局域网二维码** — 扫码即可在同网络的任意设备上访问 Picot
- 移动端 URL 优化处理，支持 PWA 安装（iOS/Android 可添加到主屏幕）

### 📦 包管理器

<p align="center">
  <img width="1200" alt="内置包管理器界面" src="docs/images/package-manager.webp" />
</p>

- 在 UI 内浏览、安装和删除社区包
- 基于 `pi install`，无需额外命令

### 💰 费用 & 用量面板

<p align="center">
  <img width="1200" alt="费用面板总览" src="docs/images/cost-dashboard.webp" />
</p>
<p align="center">
  <img width="1200" alt="按模型与趋势拆解" src="docs/images/cost-breakdown.webp" />
</p>

- 每个会话实时 Token 用量和费用追踪
- 完整费用面板，含信息栏、趋势图和按模型分类
- **上下文窗口可视化** — 点击 Token 气泡查看已缓存 Token、新输入和可用空间

### 🎨 主题 & 外观

- 六款内置主题：**Dusk（默认）**、Dawn、Midnight、Clean、Terracotta、Sage
- 毛玻璃头部和输入栏（`backdrop-filter: blur`）
- macOS 原生标题栏 overlay 集成
- 支持从顶部**拖动窗口**，媲美原生 App 体验

### 🎤 语音输入

- 输入框中的麦克风按钮，调用 Web Speech API（本地语音识别）
- 实时转录到输入框，录音时红色脉冲动画

### 🗄️ 文件浏览器

- 右侧边栏懒加载文件树
- 浏览目录，原生方式打开文件
- 拖拽文件到输入框以插入路径

### ⚙️ 设置 & 控制

<p align="center">
  <img width="1200" alt="设置与控制面板" src="docs/images/settings.webp" />
</p>

- 模型选择器，支持搜索/筛选和键盘操作
- 思考级别切换（关闭 / 低 / 中 / 高）
- 自动和手动**上下文压缩**，含状态显示
- 推送通知开关
- **自动更新** — 设置 → 通用 → 更新，一键应用内升级

---

## 集成的 Pi 能力

Picot 不重新实现 Agent 逻辑——它内嵌 Pi 并通过原生 UI 暴露其运行时能力。

- **内嵌 `pi --mode rpc` 运行时** — 每个工作区一个独立的托管进程
- **流式 RPC 桥接** — 逐 Token 输出、工具调用事件和思考块实时渲染
- **会话生命周期 API** — 创建、切换、恢复会话，完整的按项目历史
- **WebSocket Broker** — 多个 UI 客户端可同时连接同一个 pi 进程
- **扩展兼容** — 自动加载 `~/.pi/agent/extensions/` 和 `.pi/extensions/` 中的用户扩展
- **凭证复用** — 读取 Pi 已有的 `~/.pi/agent/auth.json`，无需单独登录

---

## 工作原理

```
┌──────────────────────────────────────────────────────┐
│ Picot .app                                       │
│                                                      │
│   Tauri + native HostServer (Rust)                   │
│      ├─► 启动 pi --mode rpc --extension picot-bridge.mjs │
│      ├─► 通过 /v2/ws 桥接 stdio RPC 帧              │
│      └─► OS 窗口 ──► WebView ──► native host HTTP    │
│                                                      │
│   resources/                                         │
│      ├─ public/             (前端)                   │
│      ├─ extensions/         (picot-bridge.mjs)       │
│      └─ pi/                 (bun 编译的 pi 二进制)   │
└──────────────────────────────────────────────────────┘
                       │
                       ▼ 读取 / 写入
              ~/.pi/agent/
                 ├─ sessions/   (对话历史)
                 ├─ auth.json   (API 密钥)
                 └─ settings.json
```

Picot 启动 Rust `HostServer` 和受管的 native `pi --mode rpc` 进程。WebView 连接 host 的 `/v2/ws`，host 再通过 stdio RPC 与 Pi 通信。打包的 `picot-bridge.mjs` 只提供 Picot 专用 Pi 命令，不再负责服务应用 UI。

---

## 使用方法

1. 启动 **Picot**
2. 点击项目气泡或选择一个文件夹
3. 开始对话 — 嵌入的 pi Agent 会自动在该工作区启动

通过任意工作区内的 `pi /login` 提供模型凭证，或直接写入 `~/.pi/agent/auth.json`。Picot 本身不管理凭证。

---

## 从源码构建

```bash
git clone https://github.com/shixin-guo/picot.git
cd picot
bun install --frozen-lockfile
bun run dev      # 下载内嵌 pi 二进制 + 启动 tauri dev 热重载
```

发布构建：

```bash
bun run build    # 下载内嵌 pi 二进制，然后运行 tauri build
```

修改 `src-tauri/` 下的文件后：

```bash
bun run check:rust   # cargo check + clippy + fmt（快速，无需完整构建）
```

升级内嵌 pi 版本：编辑 `scripts/pi-version.json`，运行 `bun run fetch:pi`，冒烟测试后提交。

---

## 上游关系

Picot 是 **Tau** 的维护性 fork，专为 Pi 优先的本地开发工作流定制。主要增强：

- **Native Pi runtime manager** — 启动并监管 `pi --mode rpc` 进程
- **内嵌 pi 运行时** — 无需全局安装，Picot 自带二进制
- **Protocol v2 host bridge** — 为 runtime、data、auth 和 extension UI 帧提供路由
- **Host data plane** — Rust 直接向 native UI 提供会话和工作区数据

---

## License

MIT
