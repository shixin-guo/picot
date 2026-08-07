---
name: troubleshoot-picot
description: 'Picot 故障排查助手 - 查看 error log、内存占用、Picot / 内嵌 pi 版本等诊断信息，定位启动失败、卡死、崩溃等问题'
tags: [troubleshoot, diagnostics, logs, memory, version]
---

# Picot 故障排查助手

## 用途

当用户报告 Picot 无法启动、白屏、卡死、崩溃、占用内存过高，或只是想确认自己用的版本时，
按本 skill 收集诊断信息（不是修 bug 本身，是"先看清楚发生了什么"）。

**职责边界：**

- **本 skill 负责**：定位并展示日志、内存/进程状态、版本号，给出初步诊断方向
- **本 skill 不做**：自动修复代码、发布新版本；如需修 bug，诊断完成后转 `diagnosing-bugs` skill 或直接改代码

## 触发示例

- "Picot 崩溃了，帮我看看日志"
- "Picot 好像卡死了，占了很多内存"
- "我现在用的是什么版本的 Picot / pi？"
- "picot 打不开，看看有没有报错"

## Step 1: 确认版本信息

Picot 有两个独立的版本号，都要报：

1. **Picot app 版本**（Tauri 外壳）：
   - 源头：`src-tauri/tauri.conf.json` → `version`，与 `package.json`、`src-tauri/Cargo.toml` 保持一致
   - 运行中的 app：Settings 面板里 `#setting-app-version-value`（前端用 `window.__TAURI__.app.getVersion()` 读取），或直接问用户「设置 → 关于」里看到的号码
   - 命令行核对源码里的号码：

     ```bash
     grep '"version"' package.json src-tauri/tauri.conf.json
     grep '^version' src-tauri/Cargo.toml
     ```

2. **内嵌 pi runtime 版本**（Picot 打包进去的 pi 二进制，与用户 `$PATH` 上装的 pi 无关）：
   - 源头：`scripts/pi-version.json`
   - 运行中的 app 通过 HTTP 探测（Picot 原生窗口跑着本地 HostServer）：

     ```bash
     curl -s http://127.0.0.1:<port>/health | jq
     # => { "status": "ok", "protocolVersion": 2, "piVersion": "...", "lanUrl": "...", "runtimeCount": N }
     # L2：列出 coordinator 视角下每个 runtime 的 live 状态，排查 RPC 死锁/无响应
     curl -s http://127.0.0.1:<port>/health/runtime | jq
     ```

     `<port>` 从窗口地址栏 / `PI_STUDIO` 相关环境变量或 `lsof -iTCP -sTCP:LISTEN | grep picot` 里找
   - 也可以直接读取已解压的二进制：`./src-tauri/resources/pi/pi --version`（仅在本地开发目录下有效，打包后的 `.app` 里路径是 `Picot.app/Contents/Resources/pi/pi`）

## Step 2: 找到 error log

Picot 用 `tauri-plugin-log`（见 `src-tauri/src/main.rs`），默认双路输出：**stdout** + **LogDir 文件**，日志等级 `Info`（`tokio_util`/`hyper` 降到 `Warn`）。

- **打包后的 .app（生产环境）** — 日志文件在系统日志目录（bundle id `works.earendil.picot`）：
  - macOS: `~/Library/Logs/works.earendil.picot/Picot.log`
  - Windows: `%LOCALAPPDATA%\works.earendil.picot\logs\Picot.log`
  - Linux: `$XDG_DATA_HOME/works.earendil.picot/logs/Picot.log`（一般是 `~/.local/share/...`）

  快速查看最近报错：

  ```bash
  tail -n 200 ~/Library/Logs/works.earendil.picot/Picot.log
  grep -i "error\|panic\|failed" ~/Library/Logs/works.earendil.picot/Picot.log | tail -n 50
  ```

- **`bun run dev` 本地开发** — 日志直接打印到运行 `bun run dev` 的终端 stdout/stderr，不用去找文件；往上翻终端 scrollback 即可。关键前缀：
  - `[picot-native]` — Rust 侧原生运行时启动/关闭
  - `[picot-host]` — HostServer (`/v2/ws`) 相关
  - `[picot]` — 顶层 main.rs 早期错误（比如 PATH 同步失败）

- **内嵌 pi 子进程崩溃/RPC 错误** — 由 `NativePiManager`（`src-tauri/src/native_pi_manager.rs`）管理的 `pi --mode rpc` 子进程通过 `PiRpcBridge`（`src-tauri/src/pi_rpc_bridge.rs`）用 stdio JSON-RPC 通信。子进程的 stderr 被 `picot-pi-rpc-stderr` 线程读入一个 diagnostics channel（`PiRpcBridge::take_diagnostic`），**目前不会自动写入 Picot 日志文件**，所以生产日志里搜不到 pi 子进程的 stderr 输出。排查 pi RPC 死/无响应时，优先看：
  - HostServer 的 `/health` 和 `/health/runtime`（L2，报告 coordinator 视角下每个 runtime 的 live 状态）
  - `[picot-native] started workspace_id=… session_id=… instance_id=…` / `[picot-native] startup failed: …` 日志行（`main.rs`），判断子进程是否成功拉起
  - `[picot-host] server stopped unexpectedly`（`host_server.rs`）判断 HostServer 是否中断

- **前端 JS 报错** — 打包后的 WebView 不带开发者工具；本地开发可在 Tauri 窗口右键「检查元素」看浏览器 Console，或让用户提供 `bun run dev` 终端里 `[picot-native]` 之后的堆栈。

- **启动失败弹窗**：`main.rs` 的 `setup_native_runtime` 出错时会弹原生对话框「Picot could not start the embedded pi runtime」——出现这个说明内嵌 pi 二进制缺失/损坏，先查 `bun run fetch:pi` 是否成功、`src-tauri/resources/pi/` 是否存在对应平台二进制。

## Step 3: 查看内存 / 进程状态

Picot 是一个父进程（Tauri/Rust `picot`）+ 一个或多个内嵌 `pi --mode rpc` 子进程。两者都要看：

```bash
# macOS / Linux：找到所有相关进程及内存占用（RSS，单位 KB）
ps aux | grep -E "picot|pi --mode rpc" | grep -v grep

# 更直观的常驻内存/CPU 排序
ps -eo pid,ppid,rss,pcpu,comm | grep -iE "picot|^.*pi$" | sort -k3 -n -r

# macOS 图形化：Activity Monitor 搜 "Picot" 和 "pi"
# Windows：Task Manager / Get-Process 按名字过滤
```

```powershell
Get-Process | Where-Object { $_.ProcessName -match "picot|pi" } | Select-Object Id,ProcessName,WorkingSet64
```

排查要点：

- **多个 `pi --mode rpc` 常驻不退出** → 可能是窗口关闭后子进程未清理，看 `NativePiManager::stop_all` 有没有被触发（对照 `[picot-native] started ...` / 关闭日志）
- **单个 `pi` 进程 RSS 持续增长** → 长会话上下文/内存泄漏，记录 PID + RSS 随时间变化，转 `diagnosing-bugs` 深挖
- **`picot` 主进程本身内存高但子进程正常** → 多半是 WebView（前端渲染大量消息/图片）问题，看 `public/native/` 里 message-renderer / image-lightbox 相关代码

## Step 4: 汇总输出

给用户/后续排查一份简短汇总，至少包含：

1. Picot app 版本 + 内嵌 pi 版本（Step 1）
2. 最近 50~200 行 error 相关日志片段（Step 2），标注来源文件/终端
3. 相关进程列表 + RSS 内存（Step 3）
4. 初步判断：属于「内嵌 pi 缺失/启动失败」「RPC 通信错误」「前端渲染卡死」「内存持续增长疑似泄漏」中的哪一类，并给出下一步（若需要代码修复，交给 `diagnosing-bugs` skill 或直接定位相关模块）

## 注意事项

- 不要把用户 `$PATH` 上全局安装的 `pi`（若存在）误当成 Picot 在用的 pi —— Picot **只**用 `src-tauri/resources/pi/` 里锁定版本的内嵌二进制，全局 pi 完全无关（见 AGENTS.md）
- 日志路径依赖 Tauri 的 `identifier`（`works.earendil.picot`），如果该值以后变了要同步更新本 skill
- 生产环境日志文件会持续追加，体积大时优先 `tail -n` 而不是整份 `cat`
