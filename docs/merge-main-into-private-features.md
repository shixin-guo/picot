# 合并计划：以 main 为基底，把 private/features 重写接入

> 目标：把 upstream `origin/main`（已越过 v0.3.0，HEAD `9b05faf`）的全部上游改进作为新基线，
> 将 `private/features` 的功能合并/重写进来。`private/features` 分支保持不动作为安全网。

## 1. 策略（已与 Dr. Lin 确认）

- **从 main 建新分支 + 独立 worktree**，在 main 之上把 private 的功能接入；private/features 不受影响，充分测试后可弃用。
- **只追 legacy 路径，暂不追 native**（详见 §2）。native 作为长期方向，不在本次合并范围。
- **ephemeral_registry 在 legacy 下保留 private 自己的实现**（不强行塞进 native 的 RuntimeCoordinator）。
- 理由：main 的 release 默认走 legacy，private 全在 legacy 栈且已与 main 趋同；native 是 debug-only 实验（`Host` 操作尚 `unimplemented`），追它要每功能做双份接入。

## 2. 架构现状（关键：private 与 main 在 legacy 已趋同）

main 引入了**双路径运行时**，由 `native_runtime_enabled()`（`main.rs:745` = `cfg!(debug_assertions) && PICOT_RUNTIME=native`）切换。**release 100% 走 legacy**。

```
main.rs:1086  if native_runtime_enabled() { setup_native_runtime } else { legacy }
│
├─ LEGACY (release 默认; private 也在这条路径)
│   前端 app.js → transport.js ─broker_control over WS─► BrokerWs
│                                   → install_control_handler → PiManager.spawn(HTTP port) → pi(embedded-server.mjs)
│   (Tauri IPC 仅剩 dialog/fs/shell/updater 插件 + cmd_retry_startup)
│
└─ NATIVE (debug + PICOT_RUNTIME=native, 实验, 本次不追)
    前端 native/app.js(/app/) → HostServer(axum) → HostRouter → {RuntimeCoordinator, NativePiManager(stdio), HostDataPlane, RemoteAuth↔MetadataStore(sqlite)}
```

**决定性事实（修正了早期误判）**：private **早已独立完成** Tauri IPC → broker_control 的迁移，与 main 趋同：

| 维度 | private | main | 趋同度 |
| --- | --- | --- | --- |
| 前端通信层 | `public/transport.js`（8.5KB） | `public/app/transport.js` | ✅ 同机制（broker_control over WS）；merge-tree 自动合并成功 |
| `tauri-bridge.js` | **已删除** | 已删除 | ✅ 一致 |
| Rust 控制分发 | `install_control_handler`（`main.rs:1084`） | `install_control_handler`（`main.rs:922`） | ✅ 同机制 |
| 注册命令 | open_workspace/new_session/switch_session/stop_instance/spawn_session_process/pick_folder/pick_image_files/list_installed_apps/get_pi_version/get_app_version/is_dev | 同左 + fork/open_devtools/open_external/open_in_app | 干净并集（见 §8.2） |
| Tauri invoke_handler | 仅 cmd_retry_startup 等 | 仅 cmd_retry_startup | ✅ 一致 |

→ **不存在「通信层迁移」的大工作**。legacy 合并的本质是两份趋同实现的**并集合并**。

## 3. 规模

| 方向 | 提交 | main.rs 行数 |
| --- | --- | --- |
| `v0.2.2..origin/main` | 42 | 1240（v0.2.2 为 1075） |
| `v0.2.2..private/features` | 82 | 2380 |
| 共同祖先 | tag v0.2.2（`323a53c`） | — |

## 4. main 端带来的变化（分类）

1. **前端目录大重构**：约 35 个 `public/*.js` 移进子目录（`app/`·`ui/`·`sidebar/`·`session/`·`workspace/`·`settings/`·`cost/`·`packages/`·`models/`）。git rename detection 已验证可靠。
2. **Rust host 架构（native 路径）**：9 个新模块 + axum/rusqlite/uuid/tower-http。**本次只读了解，不接入**。
3. **Super Agent / Agent Inbox / pi-chat**：独立新增（`public/super-agent/*`·`extensions/pi-chat-*`·`extensions/picot-bridge.ts`·`extensions/project-trust.ts`），与 private 无路径重叠 → **直接吸收**。
4. **Provider UI / model management**：落在 `settings/editors.js`·`models/selection.js`·embedded-server model 路由。
5. **Skill slash 命令 / Faster↔Smarter 滑块 / 成本 dashboard 重构 / design-system.css / 安装脚本 / LICENSE / README 改版 / pi→0.80.10**。

## 5. 冲突全景（`git merge-tree` 权威结果：36 个冲突文件）

- ✅ rename detection 正常，冲突都报告在**新路径**上，普通 `git merge` 能处理文件搬运。
- ✅ 已自动合并（无冲突）：`transport.js`、`AGENTS.md`、`README.md`、`biome.json`、`package.json`、`bootstrap.html`、`style-theme.css`、`workspace/actions.test.js`、`tauri.conf.json` 等。
- 冲突分三类：
  - **content（33）**：核心 `app.js`/`index.html`/`style.css`/`main.rs`/`pi_manager.rs`/`embedded-server.ts`/`sidebar/index.js`/`workspace/file-browser.js`；rename+i18n 类（`ui/markdown.js`·`ui/message-renderer.js`·`ui/tool-card.js`·`ui/dialogs.js`·`cost/infobar.js`·`session/routing.js`·`settings/editors.js`·`settings/save-status.js`·`app/updater.js`·`app/voice-input.js` 等）；配置（`.gitignore`·`sh-lint-and-format.sh`·`Cargo.lock`·`Cargo.toml`）。
  - **modify/delete（3）**：`app-settings-toggles.js`·`app-settings-editors.test.js`·`app-settings-toggles.test.js`（main 删除并迁到 `settings/`）。
  - **语义待复核**：自动合并的文件需确认两边 scripts/权限/语义互补。

## 6. 横切事实 + 通用处置原则

private 对几乎所有 rename 冲突文件的改动都是**两层叠加**：

1. **i18n 横切层**（一致、机械、可批量重应用）：`import { onLocaleChange, t }` + 硬编码串→`t()` + `onLocaleChange` 监听更新 DOM。
2. 实质功能改动（仅部分文件）。

→ **通用原则**：以 main 新路径版本为基底，重新应用 private 的 i18n 层 + 移植实质改动。

## 7. 聚焦三类高冲突（Dr. Lin 指定小心处理）

### A. `/skill` 命令 — 中低风险，不冲突

- main `ui/skill-slash-command.js`（输入 `/` 触发）vs private `composer-command-menu.js`（按钮触发通用菜单）。**机制不同、可共存**。冲突仅在 `app.js`/`index.html`/`style.css` 集成区。

### B. Provider UI — 中风险，可系统化

- main 10 个 Provider commit 最终落在 `settings/editors.js`·`models/selection.js`·embedded-server model 路由（main 全新能力，private 未涉足）。
- private 对 `app-settings-toggles.js` 改动**仅 i18n 一行**。
- 3 个 modify/delete：i18n 移植到新文件后 `git rm` 旧文件（`toggles`→`settings/toggles.js`；test 同理）。

### C. Chat 体验 — 最高风险，逐文件小心

| 子项 | private | main | 风险 | 处置 |
| --- | --- | --- | --- | --- |
| `ui/markdown.js` | 纯 i18n | `e484fe2` | 低 | i18n 重应用 |
| `ui/tool-card.js` | i18n+生命周期清理+`SVG_NS` | `b9c3dd0` | 中 | i18n+生命周期移植 |
| `ui/dialogs.js` | +111/-95 | `e484fe2` | 中高 | 逐 hunk |
| `ui/message-renderer.js` | i18n+为 navigation 暴露 user elements+滚动 handler（+240/-55） | `e484fe2`+`6b23cf5` | **高** | 语义冲突，手工融合 |
| 聊天导航 | private 已抽成 `chat-history-navigation.js` 模块（supersede） | `6e05792` 优化旧内联 turn nav | **高** | 以 private 模块为准；main 的 header-aware scrollTo 思路若值得则回填进模块 |
| thinking 强度 | private 在 ephemeral 模块内 | `dff8def` 全局滑块 | 中 | 机制不同可共存；集成于 `app.js`/`index.html`/`style.css` |
| `app/updater.js` | +127/-54 | `f2c59ca` | 中高 | 逐 hunk |

## 8. 迁移工作分解（按层）

### 8.1 前端：private 独有模块接入 main 新结构

- 把 private 的独有模块作为新文件加入 main 目录树（保持 private 的文件名/路径，或在 main 重构后位置接入）：`i18n.js`·`locales/*`·`quick-chat-dialog.js`·`side-chat-manager.js`·`ephemeral-chat-runtime.js`·`ephemeral-chat-view.js`·`file-preview-panel.js`·`file-preview-renderers.js`·`code-editor.js`·`file-language.js`·`file-pdf-preview.js`·`file-tab-state.js`·`chat-history-navigation.js`·`pinned-items.js`·`recent-sessions.js`·`sidebar-workspace-group.js`·`composer-command-menu.js`·`composer-image-attachments.js`·`image-attachments.js`·`sidebar-resizer.js`·`workspace-quick-info.js`·`workspace-projects.js`·`window-close-coordinator.js`。
- 在 main 的 `app.js`/`index.html` 里注册它们（最大单点冲突：main app.js 4439 行 vs private 4092 行，两边都在旧入口大幅扩展）。
- 这些模块内部用 `transport.*`（private 已迁移完毕）→ 与 main 的 transport 趋同，**通信层无需重写**。仅 `transport.js` API 集差异需对齐（private 用 `getEphemeralBootstrap`/`pickImageFiles`/`getCachedModels`/`openInApp`/`listInstalledApps`）。

### 8.2 Rust：`install_control_handler` 取并集

- 共有 11 命令保留其一。
- 加 private 独有：`pick_image_files`。
- 加 main 独有：`fork`·`open_devtools`·`open_external`·`open_in_app`。
- 无功能冲突，纯并集。

### 8.3 Rust：private 独有模块保留（legacy 用）

- `command_policy.rs`·`ephemeral_registry.rs`·`window_owner.rs`：作为独立 mod 加入 main 的 `main.rs`（`mod` 声明并集）。
- 接入点：legacy 的 `install_control_handler`/broker_control（private 现有方式）。**不接入 native 的 HostRouter/RuntimeCoordinator**（本次不追 native）。
- `ephemeral_registry` 保留 private 实现（Dr. Lin 已确认）；`window_owner` 比 main native 的 `session_owners` 更严，保留作独立层。
- `pi_manager.rs`：合并 private 改动（legacy 路径 spawn/端口管理仍用 PiManager）。
- `broker_ws.rs`：merge-tree 已自动合并，做语义复核确认 private 的 ephemeral/window_owner 扩展未丢。
- `Cargo.toml`：并集依赖（main: rusqlite/uuid/axum/tower-http；private: base64/rand/subtle/tempfile）。`Cargo.lock` 合并后 `cargo update` 重建。

### 8.4 extensions：embedded-server.ts 路由并集

- private 路由：`file-routes`·`workspace-info`·`command-policy`·`ephemeral-runtime-state`。
- main 路由：super-agent·pi-chat·project-trust·model management·skills。
- 取并集；注意两端对同一 base 路径的扩展方式。

### 8.5 rename 文件的 i18n + 实质改动（按 §6 通用原则、§7 风险分级处理）

## 9. 执行步骤

1. **处理 private working tree 未提交改动**：当前 12 modified + 10 untracked，先 commit/stash（这些是 private 当前工作，要保留）。
2. **建分支 + worktree**（隔离，private/features 不动）：

   ```
   git worktree add ../picot-v2 -b private/features-v2 origin/main
   cd ../picot-v2
   ```

3. **基线测试**（确认 main 起点绿）：`bun install --frozen-lockfile` → `bun run check` → `bun run check:rust` → `bun run test`。
4. **合并 private进来**：在 v2 worktree 里 `git merge private/features`（或按层 cherry-pick + 手工接入，视冲突情况）。rename detection 会处理文件搬运。
5. **分批解决冲突**（按 §8 层 + §7 风险分级）：
   - 批次 0：配置类（Cargo.toml 并集、.gitignore、sh-lint-and-format.sh）+ `bun install` 验证。
   - 批次 1：rename 文件 i18n 重应用 + 实质改动移植（§7 三类）。
   - 批次 2：modify/delete 决策（3 个 settings 旧文件）。
   - 批次 3：核心架构（`main.rs` install_control_handler 并集 + mod 声明；`app.js`/`index.html`/`style.css` 集成；`embedded-server.ts` 路由并集；`pi_manager.rs`/`broker_ws.rs`）。
6. **验证全绿**（§10）后 `git commit`（merge commit，message 说明范围与决策）。
7. v2 充分冒烟测试后，决定是否替换 private/features。

## 10. 验证清单（merge 完成前必须全绿）

```
bun install --frozen-lockfile
bun run check            # biome lint+format
bun run check:fix        # 必要时
bun run check:rust       # cargo check + clippy + fmt
bun run test             # vitest + tauri permissions
```

- private 独有测试全过：i18n·file-preview·pinned·recent·quick-chat·side-chat·ephemeral·navigation。
- 手动冒烟（`bun run dev`）：i18n 切换、文件预览、Side Chat/Quick Chat、固定侧边栏、最近会话、聊天导航；main 新功能：Super Agent、Provider 卡片、Skill slash、思考强度滑块。

## 11. 回滚

- 未提交：`git merge --abort`。
- 已提交：`git reset --hard ORIG_HEAD`。
- worktree 隔离：主工作区不受影响，可 `git worktree remove ../picot-v2` 丢弃整个尝试。

## 12. 长期方向：native 路径（本次不追，记录备查）

> 下述来自 main 的 native 子系统调研。**仅作未来迁移参考**。注意：native 是单 target/页模型，与 fork 的多 owner-scoped 并行 ephemeral 正交——追 native 时 Side/Quick Chat 是最大工作量。

**后端**：`HostServer`(axum, `127.0.0.1:0` 随机端口) 暴露 `GET /health`·`GET /v2/ws`·`GET /v2/bootstrap`·`POST /v2/auth/exchange` + 静态回退。`HostRouter` 做握手/协议校验/`ClientKind{Desktop,Remote}`/远程禁令/`is_mutation` 幂等门禁。`NativePiManager`(stdio JSONL)+`PiRpcBridge`+`RuntimeCoordinator`(状态机/序列号/临时会话绑定/幂等去重)。`HostDataPlane` 磁盘扫描 `~/.pi/agent/sessions`（list_sessions=recent / cost_dashboard / search）——未来可取代 fork 的 cookie recent-sessions 与 cost 统计（当前只服务 native，且 main 启动只注册单 workspace，多 workspace 是接入缺口）。`RemoteAuth`(pairing/device token)+`MetadataStore`(sqlite: workspace_id/device/preferences)。

**前端分层**：`bootstrap-entry.js` 按 URL 分发——`/app/*` → `native/app.js`（304 行薄编排，会话页）；否则 → `app.js`（legacy launcher，4439 行）。native 栈：`router`(纯路径解析) → `runtime-adapter`(唯一传输层，单条 WS `/v2/ws`，握手/subscribe) → `runtime-gateway`(request/response 配对+idempotencyKey) 与 `data-gateway`(复用同一 adapter，发 `data_request`，仅限 list_files/list_sessions/search_sessions/cost_dashboard 白名单) → `session-store`(reducer，按 sequence 应用 frame) → `NativeFileBrowser`/`extension-ui-host`/`slash-commands`(catalog+intent resolver，与 `ui/skill-slash-command.js` 的 DOM 菜单互补)。HostServer 即 WebView origin，URL 从 `window.location` 推导，无 env 注入。

**迁移的最大断层（ephemeral）**：native runtime 是**单 target/页**（`adapter.subscribeTarget(target)` 严格一个，序列号 reducer 只认同一 target）。fork 的 ephemeral 是**一条 broker WS 上多 owner-scoped 并行 runtime**（`ephemeral_command`/`ephemeral_event`，配额/代际/quick-replace）。两者协议正交，main native 层无任何 ephemeral 概念。追 native 时必须二选一：给 `HostRouter` 加 ephemeral 路由 + `RuntimeCoordinator` 支持多实例；或在 HostServer 旁并跑 fork broker（破坏单 HostServer 模型）。

**迁移时机**：等 native 脱离 debug 门控、`RoutedAction::Host` 落地、main 切默认、且 ephemeral 多实例方案确定后，再做一次性迁移。届时 fork 的 command_policy/ephemeral_registry/window_owner/recent-sessions/cost 都需在 HostServer 层重建（recent/cost 改接 `HostDataPlane`，ephemeral 改接扩展后的 `RuntimeCoordinator`）。
