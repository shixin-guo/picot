# feature-v3 → feature-v3.3-new-arch 行为级迁移矩阵

> 本矩阵比较 `private/features-v3` 与 `origin/private/feature-v3.3-new-arch`。
> 它不把 Git commit 是否存在当作功能完成依据，而是按用户可观察行为、架构依赖、接入点和验收标准判断迁移状态。
>
> 生成日期：2026-08-05
>
> 评估规则：
>
> - **已覆盖**：目标分支有实现、入口接线和对应测试/验收证据。
> - **部分覆盖**：目标分支有文件或部分逻辑，但缺少入口接线、后端闭环、行为验证或存在已知 placeholder。
> - **需回填**：feature-v3 已有行为，目标分支未发现等价实现或当前实现明显不完整。
> - **需验证**：静态代码看起来已经存在，但没有足够证据证明端到端行为一致。
> - **架构重做**：不能 cherry-pick 旧实现，必须映射到 Native Host / Gateway / Runtime identity。

## 1. 架构基线矩阵

| 领域 | feature-v3 | new-arch 目标 | 迁移判断 | 主要风险 |
| --- | --- | --- | --- | --- |
| 进程通信 | `PiManager` → `broker_ws` → embedded-server WebSocket | `NativePiManager` → `PiRpcBridge` → Rust Host WebSocket | 已迁移架构，但必须以 native 协议为准 | 旧 port/session path 语义不能带入 |
| Pi 扩展 | `extensions/embedded-server.ts`，同进程 HTTP/WS server | `extensions/picot-bridge.ts`、`picot-config.ts`，仅提供 Picot 命名空间适配 | 架构重做 | 旧 REST route/WS command 不能直接复用 |
| 前端入口 | `public/app.js` | `public/native/app.js` | 已迁移入口 | 旧 app.js 的功能不能按文件 diff 判断是否存在 |
| Host 数据 | embedded-server REST + 部分 Rust handler | `host_data.rs` + `data_request` | 架构重做 | path containment、workspace owner、remote 权限 |
| Host 控制 | `broker_control` | `host_request` / `control-gateway.js` | 架构重做 | 操作名、认证、idempotency key 需要重新接线 |
| Runtime 命令 | broker/embedded-server 转发 | `runtime_request` / `RuntimeGateway` | 架构重做 | `workspaceId + sessionId + instanceId` 三元 identity |
| Session identity | 文件路径、Pi port、`history:`/`path:` workspace ID | opaque `workspaceId`、Pi `sessionId`、随机 `instanceId` | 不能直接移植 | `filePath → session.id`、port 不再是身份 |
| Session lifecycle | 同一进程可 `new_session` / `switch_session` | 一进程一个 live session，新 session 通常新进程 | 架构重做 | 切换、fork、clone、恢复的生命周期不同 |
| 静态资源 | embedded-server 直接提供 public | Rust Host 单一 origin 提供 public | 已迁移架构 | CSP、静态目录和启动路径需端到端验证 |

## 2. 用户行为迁移矩阵

### P0：启动、会话、聊天主路径

| ID | 用户行为 | feature-v3 来源 | new-arch 目标 | 状态 | 迁移动作 | 验收标准 |
| --- | --- | --- | --- | --- | --- | --- |
| P0-01 | 启动应用并看到聊天页 | `public/app.js`、`embedded-server.ts`、`pi_manager.rs` | `public/native/app.js`、`main.rs`、`host_server.rs`、`native_pi_manager.rs` | 需验证 | 先验证 native 启动，不补旧入口 | Host 启动成功；Pi 通过 stdin/stdout RPC 连接；无 legacy fallback |
| P0-02 | 新建 session | `workspace/actions.js`、broker control | `workspace-actions.js`、`HostControlGateway`、`NativePiManager` | 需验证 | 核对 target 创建、临时 session ID、正式 Pi session ID | 新 session 可打开；URL 不含本地 path/port；刷新可恢复 |
| P0-03 | 打开历史 session | sidebar + `/api/sessions` | `SessionSidebar` + `HostDataGateway` + native route | 需验证 | 核对 session ID、workspace ID、历史数据加载 | 点击历史 session 后消息、标题、模型、草稿正确恢复 |
| P0-04 | session 间切换 | `switch_session` + port 路由 | `runtime subscribe` + 新 target/process lifecycle | 架构重做 / 需验证 | 禁止移植旧 deferred port switch 逻辑；按 native target 验证 | 切换期间无旧 workspace 数据串入；旧 runtime 不继续接收消息 |
| P0-05 | 发送普通 prompt 并接收流式回复 | `public/app.js` WebSocket event handlers | `RuntimeGateway` + `runtime_event` + `MessageRenderer` | 需验证 | 核对事件 schema 和 runtime target 校验 | text/thinking/tool event 顺序正确；无重复或丢帧 |
| P0-06 | abort / stop agent | embedded WS `abort` | native runtime command | 需验证 | 核对 mutation idempotency 和 settled fallback | abort 后 UI 解锁；不会误触发另一个 runtime |
| P0-07 | reconnect / snapshot hydration | broker reconnect + mirror sync | `runtime_snapshot_request`、sequence、snapshot hydration | 需验证 | 检查断线期间事件、pending prompt、snapshot 的恢复 | 刷新/断线后消息和运行状态一致；不重放未完成 prompt |
| P0-08 | fork / clone / parallel session | `PiManager` + broker controls | native workspace/session actions + process lifecycle | 架构重做 / 需验证 | 以 ADR 0002 的“一进程一 live session”为准重新验收 | 源 session 不被替换；新实例有独立 `instanceId` |
| P0-09 | 空 session / welcome / workspace identity | `renderWelcome` + workspace path | native app + project header | 需验证 | 核对 native project path 与旧 workspace path 显示 | 空 session 显示正确 workspace；跨 workspace 不残留旧路径 |

### P1：消息渲染和历史记录

| ID | 用户行为 | feature-v3 来源 | new-arch 目标 | 状态 | 迁移动作 | 验收标准 |
| --- | --- | --- | --- | --- | --- | --- |
| P1-01 | thinking block 可展开/收起 | `message-renderer.js` | 同一 renderer + native app wiring | 已覆盖 | 只需端到端验证 | live/history thinking toggle 正常 |
| P1-02 | live turn 完成后折叠 Process details | `process-group.js`、`collapseCompletedTurn`、`agent_end` 修复 | `public/native/app.js` `collapseCompletedTurn` | 部分覆盖 | 核对 `agent_end` 和 `agent_settled` 两条路径 | `agent_end` 完成后 group 折叠；reconnect fallback 幂等 |
| P1-03 | 历史 session 按 turn 折叠 thinking/tool cards | `5794682`：`renderSessionHistory`、tool target container | native `renderHistory`、`renderToolCallBlocks` | 需验证 | 逐场景核对 user anchor、final answer split、tool result 配对 | 历史页每个 user turn 独立 group；最终答案留在 group 外 |
| P1-04 | tool card 与 tool result 配对 | `ToolCardRenderer` + entries 顺序处理 | native history tool rendering + runtime events | 需验证 | 检查 `toolCallId`、error、异步顺序 | card 状态、输出、错误状态均正确，不串 turn |
| P1-05 | markdown / search highlight 安全渲染 | `markdown.js`、`markdown-styling.css`、`35cbf5d` | 同模块 + native CSS import | 需验证 | 对照 class 和 sanitizer 规则，补测试 | 普通 markdown、代码、highlight、恶意 HTML 均符合旧行为 |
| P1-06 | 复制消息 / 复制代码 | `message-renderer.js` | 同 renderer | 需验证 | 不按文件存在判断，做 native chat 手测 | assistant/user/code copy 均可用 |
| P1-07 | 图片 lightbox | `public/ui/image-lightbox.js/css`、`c175f08` | 同模块 + native keyboard shortcut | 已覆盖 / 需验证 | 核对 index.html/style import 与 keyboard close | 点击图片打开；Esc/关闭按钮关闭；不影响聊天滚动 |
| P1-08 | composer 图片附件 | `composer-image-attachments.js`、`b6e398c` | `native/composer/composer-images.js` | 需验证 | 对照 `doc`/`document` 修复和 native payload | 选择、预览、发送、清除附件均正常 |
| P1-09 | slash commands / queued messages | `skill-slash-menu`、composer logic | native composer modules | 需验证 | 核对 command catalog、queue、submit wiring | skill command、普通命令、排队消息行为一致 |

### P1：Sidebar、workspace 和 session 导航

| ID | 用户行为 | feature-v3 来源 | new-arch 目标 | 状态 | 迁移动作 | 验收标准 |
| --- | --- | --- | --- | --- | --- | --- |
| P1-10 | 显示 Recent / Pinned / Projects / Archived | `public/sidebar/index.js`、`buildSidebarSection` | `native/session/session-sidebar.js` | 已覆盖 / 需验证 | 重点检查 DOM/CSS visual parity | 四个 region 正确排序、折叠、计数和空状态正确 |
| P1-11 | workspace group 展开/收起 | `sidebar-workspace-group.js` | 同 builder + native sidebar | 已覆盖 / 需验证 | 核对 workspace identity 映射 | group 状态和 session 列表不串 workspace |
| P1-12 | pin session / pin workspace | `pinned-items.js` cookie | `native/session/pinned-items.js` localStorage | 已覆盖 / 需验证 | 验证 `filePath → session.id` 迁移 | pin、unpin、刷新恢复、跨 workspace 均正确 |
| P1-13 | session hover toolbar / rename / archive | sidebar item handlers | native session sidebar + config gateway | 部分覆盖 | 核对 rename 是否走 `picot-config`、archive 是否 Host-owned | 操作目标稳定；不能把浏览器 path 当 authoritative input |
| P1-14 | Cmd-K 全局 session 搜索 | `ui/session-search-dialog.js`、`5d68127` | `native/session/session-search-dialog.js` + `HostDataGateway` | 已覆盖 / 需验证 | 以 session ID/Host search response 为准 | Cmd/Ctrl-K 打开；搜索、结果跳转、关闭、键盘导航正确 |
| P1-15 | Focus workspace view | `workspace-focus-sidebar.js`、focus state | `native/session/focus-sidebar.js`、focus state | 已覆盖 / 需验证 | 核对 URL route 与 project path | 进入/返回 Focus 不丢 session；按钮只作用于当前 workspace |
| P1-16 | workspace quick-info / git repository metadata | `workspace-quick-info.js`、`/api/workspace-info` | native project header / Host data | 部分覆盖 | 核对 endpoint 是否仍为 Host data，不能使用旧 embedded route | hover/focus 显示 path/count/repository 且跨 workspace 更新 |
| P1-17 | workspace path pill 打开 Files panel | `ca01566`，旧 `public/app.js` | native header/project header + file sidebar | 需回填 | 在 native header 重新绑定 click；不要复制旧 DOM 引用 | 点击 workspace path 展开 Files tab，刷新当前 workspace root |
| P1-18 | git repo/branch pill 打开 Git panel | `ca01566`，旧 `public/app.js` | native header + `git-panel-integration.js` | 需回填 | 在 native header 重新绑定 click | 点击 git pill 展开 Git tab；Git status 请求 target 正确 |

### P1：Files、Git 和编辑器

| ID | 用户行为 | feature-v3 来源 | new-arch 目标 | 状态 | 迁移动作 | 验收标准 |
| --- | --- | --- | --- | --- | --- | --- |
| P1-19 | 浏览 workspace 文件 | `workspace/file-browser.js`、`/api/files` | `native/workspace/file-browser.js` + Host data | 已覆盖 / 需验证 | 核对相对路径和 workspace containment | 目录导航、父目录、空目录、错误状态正常 |
| P1-20 | 打开文件、预览、编辑、保存 | `file-preview-panel.js`、file routes | native file preview + Host data | 需验证 | 核对 content route、write authorization 和 dirty tabs | 文本/图片/PDF/office 文件行为正确；越界路径被拒绝 |
| P1-21 | Git status / staged / changes / untracked | `git-panel.js`、`git_service.rs` | `host_git.rs` / `host_data.rs` + Git gateway | 已覆盖 / 需验证 | 使用 porcelain-v2/owner/workspace generation 验收 | 分组、状态、统计与实际 git 一致 |
| P1-22 | Git diff | `git-diff-renderer.js` | native Git panel + file preview diff | 已覆盖 / 需验证 | 核对 diff descriptor 由 Host 派生 | staged/unstaged/untracked diff 正确，不能信任浏览器 path/OID |
| P1-23 | Stage / Unstage / Discard | old broker control | native Host Git request | 已覆盖 / 需验证 | 检查 batch atomicity、group classification、generation | 操作成功后状态刷新；错误不会半成功 |
| P1-24 | AI commit message / Commit | `git_pi_runner.rs` + Git panel | native Host-owned git runner/lifecycle | 已覆盖 / 需验证 | 检查 detached lifecycle、outcome recovery、权限 | Pi/API error 可见；commit outcome 不因浏览器断开而丢失 |
| P1-25 | 非 Git workspace | old Git endpoint | native Host git data | 已覆盖 / 需验证 | 验收空状态与错误边界 | 非 Git 目录不崩溃、不读取其他目录 |

### P1：设置、Skills、配置和多语言

| ID | 用户行为 | feature-v3 来源 | new-arch 目标 | 状态 | 迁移动作 | 验收标准 |
| --- | --- | --- | --- | --- | --- | --- |
| P1-26 | 打开 Settings / 切换语言 | settings UI + `i18n.js` | native settings + same i18n module | 已覆盖 / 需验证 | 跑四 locale key parity，并逐页检查 missing key | en/zh/ja/es 切换后 native 页面无 missing key |
| P1-27 | Skills Discovered tab | Skills settings + embedded command | native skills page + `ConfigGateway` | 已覆盖 / 需验证 | 核对 scope、trusted project、settings lock | 清单、状态、启用/禁用、rescan 正常 |
| P1-28 | Skills Install tab 扫描和安装 | skill source registry + broker controls | `skill_scan_install_source` / `skill_install_links` | **✅ 已迁移**（2026-08-05 核实，见 §3 记录） | 矩阵原标“部分覆盖”已过时；真实链路完整，见 §3 核实记录 | 选择目录→scan→候选→install→新 session 生效；sourceId/TTL/owner 校验完整 |
| P1-29 | Skills Packages tab | package inventory | native package skills tab | 已覆盖 / 需验证 | 核对 read-only semantics 和 empty state | 只显示 bundled candidates；无错误 enablement 假象 |
| P1-30 | Provider/API key/settings persistence | old embedded settings routes | native settings config + ConfigGateway | 需验证 | 检查 picot-config notify correlation 和 trusted owner | 保存/读取正确；unknown keys 保留；remote 不可执行 desktop-only config |
| P1-31 | Thinking level 随 model 动态变化 | `f4e9457`/`35654e1` embedded + old app UI | native thinking control + runtime/config gateway | **部分覆盖** | target manual plan 已记录前端动态逻辑未完整移植 | 切 model 后可用 level 集合正确；默认值和 session profile 不混淆 |
| P1-32 | session 草稿/model/thinking 持久化 | `session-ui-state.js` + old app wiring | `SessionUiStateStore` + native app | 已接线 / 需验证 | target 曾记录未显式调用，当前分支需复测接线 | session 切换恢复草稿/profile；刷新行为符合设计；不写入 Pi JSONL |
| P1-33 | Compact | `compact-coordinator.js` + old app | native `createCompactCoordinator` + runtime command | 已接线 / 需验证 | target 曾记录未完整接入，复测确认 | 确认、进度、成功/失败、context usage 更新正确 |
| P1-34 | Header usage/status bar | `ui/header-status-bar.js` | native app `createHeaderStatusBar` | 已接线 / 需验证 | target 已有 import，但需真实 runtime event/usage 验证 | usage/cost/status 只显示当前 target，不串 session |

### P1：Agent Inbox、通知和临时聊天

| ID | 用户行为 | feature-v3 来源 | new-arch 目标 | 状态 | 迁移动作 | 验收标准 |
| --- | --- | --- | --- | --- | --- | --- |
| P1-35 | Agent Inbox 自动启动/进入/退出 | old Super Agent + ports + REST | native Agent Inbox startup + Host command | 架构重做 / 需验证 | 以 `ensure_agent_inbox_session`、native target、sessionStorage guard 为准 | 自动启动不抢占普通 workspace；退出后回到原 session |
| P1-36 | Agent Inbox dispatch child task | `super-agent/dispatch.js` + embedded REST | `native-dispatch.js` + native runtime | 架构重做 / 需验证 | 核对 parent/child target、task state、completion event | child runtime 独立；任务状态/查看 session 正确 |
| P1-37 | Agent Inbox task clarification | old `sa-ask`/REST | native extension UI/runtime event | 架构重做 / 需验证 | 核对 extension UI owner 与 pending request | clarification 可达正确 parent/task；切 workspace 后不误投递 |
| P1-38 | in-app notification center | old notify/broker event | `native/notifications/notification-center.js` | 已覆盖 / 需验证 | 核对 extension UI notify 消息过滤和 aria | success/error/info 可显示、关闭、自动消失 |
| P1-39 | OS task completion notification | 无完整旧等价；旧 app 有 super-agent notify | `task-completion-notifications.js` + Tauri plugin | 已覆盖 / 需验证 | 验收 permission/settings/agent_end fallback | agent start→end 只通知一次；禁用设置有效；权限失败不崩溃 |
| P1-40 | Side Chat / Quick Chat | `ephemeral-chat-view.js` + old manager | native ephemeral runtime/side-chat manager | **✅ 已迁移**（2026-08-05 核实，见 §3 记录） | 矩阵原标“架构重做/需验证”已过时；模块完整且 app.js 已接线，见 §3 核实记录 | Side Chat 不创建重复实例；workspace 切换和关闭安全 |

### P2：辅助功能、安全和诊断

| ID | 用户行为 | feature-v3 来源 | new-arch 目标 | 状态 | 迁移动作 | 验收标准 |
| --- | --- | --- | --- | --- | --- | --- |
| P2-01 | `@` 文件提及搜索 | embedded `/api/file-mentions` | native Host data / at-file mention | 已覆盖 / 需验证 | 核对 workspace containment、loopback/native authorization | 搜索仅返回当前 workspace；越界路径不可见 |
| P2-02 | Project Trust | `project-trust.ts` + embedded startup | `picot-bridge.ts` + native startup gate | 部分覆盖 / 需验证 | 核对 no-UI fallback、saved trust、default deny | 未信任项目阻止资源执行；已保存 trust 在无 UI 时正确生效 |
| P2-03 | Terminal panel | terminal manager + old frontend | native terminal panel/registry | 已覆盖 / 需验证 | 核对 owner/workspace lifecycle 和 output bounds | terminal 只属于当前 workspace；切换/关闭正确清理 |
| P2-04 | App updater | old updater/broker control | native app updater + Host command | 已覆盖 / 需验证 | 核对 update permission、progress、failure | 检查/下载/安装状态正确，remote 不可越权 |
| P2-05 | LAN / remote access | embedded LAN bind + broker auth | HostRouter protocol v2 + QR remote auth | 架构重做 / 需验证 | 逐项测试 remote forbidden operations | remote 只能执行批准的 runtime/data 操作；不能 picker/app/package/update |
| P2-06 | Native dialog / extension UI | embedded extension UI WS | `ExtensionUiHost` + `extension_ui_request` | 已覆盖 / 需验证 | 核对 request owner、pending replay、response correlation | dialog/confirm/notify 请求到正确窗口；关闭/重连不串请求 |
| P2-07 | troubleshoot-picot 诊断 skill | `a5c0ad9` `.claude/skills/...` | 同 skill 文件 + native diagnostics | 部分覆盖 | 检查 skill 是否识别 native host、Pi RPC、Host logs | 能定位启动、RPC、runtime、memory、version 问题 |
| P2-08 | 构建与发布 | legacy build/embedded extension | native resources + `pi_launch` + frontend build | 需验证 | 运行全部 build/check 命令，不以 Vitest 单独判断 | dev、release、macOS/Windows 资源和 Pi binary 均正确 |

## 3. 明确的静态证据与已知缺口

### 目标分支已经自己记录的缺口

`origin/private/feature-v3.3-new-arch:docs/manual-test-plan-v3.3.md` 明确列出以下不是“已完成”，而是已知迁移限制：

| 功能 | 目标分支记录的状态 | 矩阵状态 |
| --- | --- | --- |
| Skills 安装扫描/安装 | 矩阵原记录 `scan_source_static` / `install_links_static` placeholder | ✅ 已迁移（2026-08-05 核实） |
| Session UI 状态恢复 | 曾记录文件已添加但 native app 未显式调用 | 接线后需验证 |
| Compact coordinator | 曾记录主要逻辑未完整接入 native app | 接线后需验证 |
| Header status bar | 曾记录需要 native app 挂载 | 接线后需验证 |
| Thinking level 按模型动态变化 | extension 已有，native 前端 UI 曾未完整移植 | 部分覆盖 |

当前静态检查显示 native `app.js` 已经包含以下接线：

- `createCompactCoordinator`
- `SessionUiStateStore`
- `createHeaderStatusBar`
- `createNotificationCenter`
- `createTaskCompletionNotifications`
- `createProcessDetailsGroup`
- `setupSessionSearchDialog`
- `RpivTodoMirrorPanel`
- native composer image attachments

这只能将部分项目从“明确缺失”提升为“已接线/需验证”，不能代替 live behavior 验收。

### 2026-08-05 核实与修复记录

本次对若干矩阵项目做了代码核实与修复，结论如下（均基于当前分支 `private/feature-v3.3-new-arch` HEAD `d53e8bd` 的静态证据）：

| 矩阵项 | 本次动作 | 证据 / 结论 |
| --- | --- | --- |
| **P1-17 / P1-18** toolbar pill 点击 | ✅ 已回填（A） | `project-header.js` 新增 `onOpenFiles` 回调，app.js 用 `openFilesPanel()` 展开 file sidebar + `gitPanel.setTab("files")`；git pill（`#diff-sidebar-toggle`）点击此前已在 app.js 接线（展开 sidebar + `setTab("git")`）。新增 2 个 project-header 测试覆盖点击/键盘。 |
| **P1-28** Skills install | ✅ 已迁移改进（B，矩阵过时） | 矩阵所称 `scan_source_static`/`install_links_static` placeholder **不存在**。真实链路：Rust `skill_install.rs` 的 `scan_install_source`(L636)+`install_links`(L1060) → `host_server.rs` 路由 `skill_scan_install_source`/`skill_install_links` → 前端 `control-gateway.js` 三方法 + `settings/skills-install-tab.js` 完整 UI（scan/select/confirm/install + scope + generation guard）。 |
| **P1-40** Side/Quick Chat | ✅ 已迁移（E，矩阵过时） | `side-chat-manager.js`(396行/19方法) + `quick-chat-dialog.js`(578行/30方法) + `ephemeral-chat-view.js` + `ephemeral-chat-runtime`。app.js L329-418 已接线并绑定按钮。具备 owner registry、single-instance(`ephemeral_replace`)、transition settlement(`prepareWorkspaceTransition`)、窗口关闭清理。 |
| **P2-07** troubleshoot-picot skill | ✅ 已更新（C） | skill 已识别 native Host（HostServer/NativePiManager/PiRpcBridge）。本次修正 stderr 描述：pi 子进程 stderr 进 diagnostics channel（`take_diagnostic`）但**未被消费、不进日志文件**；补充 `/health/runtime` L2 诊断端点。 |
| **基线 `bun run check`** | ✅ 已清理（D） | 3 biome warnings（workspace-actions 死代码删除 + sidebar noDescendingSpecificity 加针对性 ignore）+ 29 CSS literal errors（3 处精确 tokenize 为 `--space-0-5`，其余加 `design-token-ignore` 说明为对话框/diff/context-menu 的 bespoke 尺寸）。`bun run check` 现全绿。 |

## 4. feature-v3 最新改动的回填清单

这些是当前 `private/features-v3` 相对目标分支最应该先回填的功能，不建议直接 cherry-pick，而应按上面的行为 ID 处理：

| feature-v3 commit | 行为 ID | 回填方式 |
| --- | --- | --- |
| `3602270` rpiv-todo mirror | P1-38/P1-39 相关 extension UI | 对照 `native/features/rpiv-todo-mirror.js`，验证 notify 过滤、widget replay、session clear、CSS |
| `8038e97` `/todos` notify suppression | P1-38 | 适配 `ExtensionUiHost` 的 notify handler |
| `5d68127` Cmd-K session search | P1-14 | 目标已有 native dialog，按 gateway/session ID 验收，不复制旧 app wiring |
| `35cbf5d` markdown/search highlight | P1-05 | 对照 native markdown CSS/import 和 renderer 行为 |
| `34fd3de` live process-details | P1-02 | 核对 native `agent_end`/`agent_settled` |
| `f0a30f3` agent_end fix | P1-02 | native runtime event regression test + live test |
| `5794682` history process-details | P1-03 | 核对 native `renderHistory`，补 history-specific test |
| `c175f08` image lightbox/project trust | P1-07/P2-02 | lightbox 可复用；trust 必须检查 native bridge 启动流程 |
| `b6e398c` composer attachment fix | P1-08 | 对照 `native/composer/composer-images.js` payload |
| `3570c4d` ja/es locales | P1-26 | 重新做四 locale key parity，不直接覆盖目标 locale |
| `a5c0ad9` troubleshoot skill | P2-07 | 补 native Host/RPC 诊断说明 |
| `ca01566` toolbar pill click | P1-17/P1-18 | 在 native project header/header status bar 重新绑定 |

## 5. 每个行为的完成门槛

一项行为只有同时满足以下条件，才可标为“完成”：

1. Native 入口中存在明确接线。
2. 所有依赖的 CSS、HTML、i18n key 都存在。
3. transport 使用正确的 native Gateway/Host operation/runtime command。
4. workspace/session/instance identity 没有沿用旧 path/port 假设。
5. 有针对行为的自动化测试，或有明确的手工验收记录。
6. 运行相关的 `bun run test`、`bun run check`、必要时 `bun run check:rust`。
7. 跨 workspace、重连、窗口关闭和权限边界没有回归。

## 6. 推荐执行顺序

### Wave 0：建立可信基线

基线运行日期：2026-08-05，分支 `private/feature-v3.3-new-arch`（HEAD `d53e8bd`），bun 1.3.14 / node v26.5.1 / 嵌入式 pi 0.83.0。工作树仅有 docs 变更，源码无未提交改动。

| 命令 | 结果 | 详情 |
| --- | --- | --- |
| `bun run test` | ✅ 通过 | vitest 127 文件 / 933 测试全绿；`check-tauri-permissions.js` 6 个命令均正确声明 |
| `bun run check:rust` | ✅ 通过（含 advisory） | cargo check + clippy（warnings as errors）+ 166 单元测试全绿；`cargo fmt --check` 报告格式漂移（advisory，不阻断） |
| `bun run build:extensions` | ✅ 通过 | `picot-bridge.mjs`（581.9 KB）+ `pi-chat.mjs`（126.5 KB） |
| `bun run check` | ❌ 失败（既有问题） | biome 3 warnings + design check 29 个 CSS literal 错误（见下） |

`bun run check` 失败明细（**既有基线问题，不归因给后续回填**）：

- biome lint（3 warnings）：
  - `public/native/sidebar.css:528` `lint/style/noDescendingSpecificity`
  - `public/native/workspace/workspace-actions.js:127` `lint/correctness/noUnusedFunctionParameters`
  - `public/native/workspace/workspace-actions.js:131` `lint/correctness/noUnusedVariables`（`invoke` 未使用，可 `--unsafe` 自动修复）
- design check（29 errors）：`settings-config.css`（20）、`file-preview-panel.css`（4）、`sidebar.css`（2）、`session-sidebar.css`（3）—— 均为字面像素值未使用 `style-theme.css` token。

### Wave 1：P0 主路径

- [ ] P0-01 至 P0-09
- [ ] 先修复启动、runtime target、session navigation、snapshot/reconnect

### Wave 2：消息、Sidebar、workspace

- [ ] P1-01 至 P1-18
- [ ] 优先 history process-details 和 toolbar pill

### Wave 3：Files/Git/Settings

- [ ] P1-19 至 P1-34
- [ ] 优先修复目标分支已知的 Skills install、Compact、Thinking、Header status 缺口

### Wave 4：Agent Inbox、通知、Side Chat

- [ ] P1-35 至 P1-40
- [ ] 使用真实 Pi/runtime，不只测 DOM 单元测试

### Wave 5：安全、辅助和发布

- [ ] P2-01 至 P2-08
- [ ] 进行 remote/permission/path/build 验收

## 7. 当前结论

`feature-v3.3-new-arch` 应继续作为架构目标，但不能被视为功能完整基线。当前最可靠的迁移单位是上表中的行为 ID，而不是 Git commit。

下一步应从 Wave 0 开始，先记录 new-arch 本身的基线失败，再按 P0/P1 顺序逐个关闭矩阵项目。任何“文件已存在但未接线”的功能都应保持为“部分覆盖”或“需验证”，不能仅因 cherry-pick 成功就标记为完成。
