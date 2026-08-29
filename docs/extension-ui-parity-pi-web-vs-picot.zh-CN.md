# Extension Command / Custom UI 对等性分析：pi-web vs Picot

对比两个 Web 端 host 如何对接同一套协议（`pi --mode rpc`，定义在
`pi-mono/packages/coding-agent/src/modes/rpc/`），以及为什么 Picot 目前会
丢失一整类 pi-web 支持的 extension 功能。

## 1. 两端如何接入 RPC 协议

| | **pi-web** | **Picot** |
|---|---|---|
| 运行方式 | 通过 SDK 将 `@earendil-works/pi-coding-agent` **内嵌在同一进程**中（`createAgentSessionFromServices`、`lib/rpc-manager.ts` 中的 `AgentSessionWrapper`） | 把真实的 `pi` 二进制作为**子进程**启动，带 `--mode rpc`（`src-tauri/src/native_pi_manager.rs:44` 的 `--mode rpc`），通过 stdin/stdout JSONL 通信（`pi_rpc_bridge.rs`） |
| Extension 绑定方式 | 直接调用 `session.bindExtensions({ uiContext, mode: "rpc", commandContextActions, ... })`，`uiContext` 是一个 **JS 对象**实现——无需任何序列化 | Extension 运行在子进程 `pi` 内部，与*它自己的* RPC 层（`rpc-mode.ts`）通信，后者会把 `ExtensionUIContext` 的调用序列化为 stdout 上的 `extension_ui_request` JSON 帧 |
| 到浏览器的传输 | 同进程内的事件发射器（`AgentEvent`）→ SSE/WebSocket → React 客户端 | 子进程的 JSON 帧 → Rust `PiRpcBridge` → 原样转发到 Tauri WebSocket/host origin → 前端 JS |

两端最终暴露的是**同一套协议**（`extension_ui_request` / `extension_ui_response`、
`get_commands` 等，定义在 `rpc-types.ts`）。区别不在协议本身，而在于每个
前端**实际实现了协议的多少**。

## 2. Command 执行（`get_commands`、slash command）

两端都会调用 `{ type: "get_commands" }`，拿到
`{ commands: RpcSlashCommand[] }`（extension 注册的命令 + prompt 模板 + skill），
并据此构建 slash 命令面板：

- pi-web：`components/ChatInput.tsx`（`buildSlashCommandLayout`，按来源分组：
  builtin/extension/prompt/skill）。
- Picot：`public/native/composer/slash-commands.js`（`buildCommandCatalog`）+
  `public/native/composer/composer-slash-menu.js`，数据来自
  `app.js:640-645`（`loadCommands()` → `runtime.request({ type: "get_commands" }, target)`；
  调用点已从旧版的 `app.js:611` 挪过来，行为不变）。

**这部分两端是对等的。** 执行一个命令在两边都只是发送一个 `prompt`/`steer`
RPC 命令；命令的*副作用*（工具调用、消息历史）在任何地方都能正常渲染，
因为它们走的是正常的消息流，而不是 `ExtensionUIContext`。

真正的差距完全出现在**命令/extension 运行期间**，当它想要渲染或读取一些
超出常规聊天记录范围的东西时。

## 3. Extension UI 方法——实现情况对照表

`ExtensionUIContext`（`pi-mono/.../core/extensions/types.ts:124`）大约有 20
个方法。每一个都会变成带 `method` 字段的 `extension_ui_request` 帧。以下是
每个前端对每个方法的处理情况：

| 方法 | RPC 帧类型 | pi-web（`lib/rpc-manager.ts`、`hooks/useAgentSession.ts`、`components/ChatWindow.tsx`） | Picot（`extension-ui-host.js`、`app.js`、`dialog.js`） |
|---|---|---|---|
| `select` / `confirm` / `input` / `editor` | 阻塞式，需要 `extension_ui_response` | ✅ 渲染为一个模态框（`ExtensionDialog`，用 React 构建） | ✅ 渲染为模态框（`showNativeDialog`）或内联卡片（`showInlineExtensionPrompt`），按 session 排队 |
| `notify` | 发后不理 | ✅ `addNotice` → toast/系统消息 | ✅ `messageRenderer.renderSystemMessage` |
| `setStatus` | 发后不理 | ✅ `ExtensionStatusBar` 渲染 `{key,text}` 的 pill 标签 | ✅ 只显示成一个通用的 "Connected" 文本（`setStatus(request.statusText || "Connected")`）——status 的 **key** 被丢弃了，导致多个并发的状态全部塌缩成一个字符串 |
| `setWidget`（仅 string[] 内容） | 发后不理 | ✅ `ExtensionWidgets` 把 `lines[]` 渲染在编辑器上方/下方，按 `widgetKey` 建索引，维护一个活跃的 `Map<key, widget>` | ⚠️ **只对一个 extension 特殊处理**（`rpiv-todo-mirror.js` 只匹配 `widgetKey === "rpiv-todos"`）；其他所有 extension 的 widget 都命中同一个 hook 后被静默丢弃（`widget: (request) => { if (isRpivTodoWidgetRequest(request)) return; }`——没有 `else` 分支） |
| `setWidget`（组件工厂函数写法） | **在 RPC 层面根本无法表达** | 不支持（RPC 模式会去掉工厂函数，见 `rpc-mode.ts` 中的注释：*"Only support string arrays in RPC mode — factory functions are ignored"*） | 同样的限制——这是协议层面的缺口，与具体 host 无关 |
| `setTitle` | 发后不理 | ✅ 设置 `document.title` | ✅ 设置 `document.title` |
| `set_editor_text` / `pasteToEditor` | 发后不理 | ✅ 通过 `chatInputRef` 插入到输入框 | ✅ 直接设置 `input.value` |
| `custom(factory, …)`（任意交互式 TUI 组件） | 需要 `extension_ui_request(method:"custom")` 渲染帧 + `extension_ui_input` 键盘输入帧 + 关闭时的 `extension_ui_response` | ✅ **完整支持**——见第 4 节 | ❌ **明确拒绝**：`extension-ui-host.js` 里没有 `case "custom"`，会落入 `default:` 分支，立即回复 `{ cancelled: true, error: "unsupported" }` |
| `setWorkingMessage` / `setWorkingVisible` / `setWorkingIndicator` / `setHiddenThinkingLabel` | RPC 模式压根不会发出这些（`rpc-mode.ts` 中都是空实现，注释写着：*"not supported in RPC mode - requires TUI loader access"*） | 不适用（永远不会发出） | 不适用（永远不会发出） |
| `setFooter` / `setHeader` | RPC 模式压根不会发出（空实现） | 不适用 | 不适用 |
| `getEditorText` | 同步方法，无法在 RPC 上做往返 | 永远返回 `""` | 客户端也没有实现 |
| `addAutocompleteProvider` / `setEditorComponent` | RPC 不支持 | 空操作 | 未暴露 |
| 主题相关方法（`getAllThemes`、`setTheme` 等） | RPC 返回空结果/失败 | 打了桩 | 未暴露 |

**核心发现：** `setStatus`/`setWidget` 帧确实被 Picot 的 bridge 收到了，
但前端除了一个 hardcode 的 extension 之外，把这些负载全部丢弃了；而
`custom` 在 JS 层被直接拒绝——即便 Rust bridge（`pi_rpc_bridge.rs`）和
运行时帧分类逻辑（`BridgeFrame::ExtensionUi`）早已正确转发了这些帧。
**这个缺口 100% 出在浏览器端 JS（`extension-ui-host.js`），不在 Rust，
不在 RPC 协议本身，也不在 `pi` 二进制里。**

> **2026-08-02 复核**：以上结论对照当前代码全部成立。文件位置有变动：
> `extension-ui-host.js` 现在在 `public/native/extensions/extension-ui-host.js`，
> `rpiv-todo-mirror.js` 在 `public/native/features/rpiv-todo-mirror.js`。
> dispatch switch（`extension-ui-host.js:143-169`）依然没有 `case "custom"`，
> 也没有 `pasteToEditor` 分支——两者都落到 `default:`，回复
> `{ cancelled: true, error: "unsupported" }`。`app.js:265-299` 里的
> `hooks.status`/`hooks.widget` 也没变：`status` 丢弃 `statusKey`
> （`setStatus(request.statusText || "Connected")`，第 284 行），`widget`
> 除了 `rpiv-todos` 特判外没有 `else` 分支（第 293-297 行）。
> `pi_rpc_bridge.rs` 的 `read_frames()`（第 279-319 行）依然只按 `type`
> 字段前缀（`extension_ui*`）分类成 `BridgeFrame::ExtensionUi`，从不检查
> `method`——再次确认瓶颈不在 bridge。

## 4. 为什么 pi-web 能做到 `custom()`，Picot 做不到

`ExtensionUIContext.custom()` 允许 extension 挂载一个用 `pi-tui` 原语
（`Component`、`TUI`、`Theme`、`KeybindingsManager`）构建的任意交互式组件，
并获得原始按键输入，直到它调用 `done()`。

### pi-web 的做法：同一进程内的 headless TUI 模拟层

因为 pi-web 是把 SDK 内嵌在同一进程中，它根本不需要为 `custom()` 做 RPC
序列化——可以直接用一个**headless 的 `TUI` 实现**去调用 extension 的
factory 函数：

- `lib/custom-ui-terminal.ts` —— `createHeadlessCustomUiTui()` 返回一个假的
  `{ terminal: { columns, rows, kittyProtocolActive: false }, requestRender() }`，
  这个对象足以满足 `TUI` 接口，让 `pi-tui` 的 `Component` 把自己渲染成一个
  带 ANSI 样式的字符串数组。
- `lib/rpc-manager.ts`（`requestExtensionCustomUi`）会调用
  `factory(tui, PLAIN_TEXT_THEME, CUSTOM_UI_KEYBINDINGS, done)`，拿到一个
  带有 `.render(width): string[]` 方法的 `Component`，每次 `requestRender()`
  触发时重新调用 `.render()`，并把渲染出的行以
  `extension_ui_request { method: "custom", lines }` 的形式发出。
- 因为 pi-web *本身就是* RPC 端点（它是 SDK 本体，不是某个 RPC 服务的客户端），
  整个流程**完全不需要离开这个模块**——没有子进程，组件对象本身也不需要
  额外的 IPC 帧，只有渲染出的文本行会跨越到浏览器。
- 按键会以 `extension_ui_input { id, data }` 的形式回传（见
  `lib/rpc-manager.ts:610`，由 `hooks/useAgentSession.ts:753` 触发），
  传给 `component.handleInput(data)`——这正是一个真实终端会喂给 `pi-tui`
  组件的东西（原始 ANSI/键盘转义序列，由浏览器端的 `lib/terminal-input.ts`
  产生——`toTerminalKeyData()` / `asBracketedPaste()`）。
- 浏览器端是 `components/ChatWindow.tsx` 里的 `ExtensionCustomPanel`：一个
  带隐藏 `<textarea>` 的模态框，捕获 keydown/组合输入/粘贴事件，转换成终端
  转义序列，还有一个 `<pre>` 用 `parseAnsiLine()`（`lib/ansi.ts`）渲染带
  ANSI 样式的行。

所以 pi-web 实际上重新实现了"一个渲染成 HTML 的终端字符网格，由真实按键
驱动"——一个为 `pi-tui` 组件量身定制的、极简的类 xterm 桥接层。它不需要
`pi-tui` 真正的终端渲染器，只需要 `Component.render(width): string[]` +
`Component.handleInput(data)`，这正是 `pi-tui` 组件对外公开的完整接口契约。

### Picot 要做到同样的事情，缺了什么

Picot 的架构其实已经具备做这件事的正确形态——可以说它比 pi-web 的处境
*更好*，因为：

1. Rust bridge 已经把 `method: "custom"` 的帧分类为 `BridgeFrame::ExtensionUi`
   并转发出去了——这部分不需要改动。
2. `pi_rpc_bridge.rs` 的 `request()`/`send_frame()` 已经能双向传输任意 JSON，
   所以 `extension_ui_input`（按键）帧只是 bridge 无需关心内容的又一种 JSON
   负载而已。
3. Picot 已经为其他功能（对话框、工具卡片）建好了 ANSI 感知的渲染基础设施，
   这些可以直接复用/扩展。

但确实缺了两个关键部分：

1. **RPC 子进程本身根本不会发出 `method: "custom"` 帧**，因为 `rpc-mode.ts`
   里的 `custom()` 实现是一个硬编码的桩函数：
   ```ts
   async custom() {
     // Custom UI not supported in RPC mode
     return undefined as never;
   }
   ```
   （截至 2026-08-02 复核，`rpc-mode.ts:227-230` 代码原封不动；同时确认
   `setFooter`/`setHeader`/`setWorkingMessage`/`setWorkingVisible`/
   `setWorkingIndicator`/`setHiddenThinkingLabel` 在 `rpc-mode.ts:178-192,209-215`
   仍是纯空操作，`rpc-types.ts` 里的 `RpcExtensionUIRequest` 联合类型
   （第 213-248 行）依然没有 `"custom"` 变体，`RpcCommand` 也没有
   `extension_ui_input` 形状的按键回传命令——pi-web 对 `custom()` 的支持
   完全建立在它自己的 `lib/types.ts` 词汇表上，比共享的 `rpc-types.ts`
   协议更丰富。）
   这是在上游 `pi-mono/packages/coding-agent` 里，不在 Picot 里。**Picot
   在这个功能被 `rpc-mode.ts` 实现之前，永远不可能从一个真实子进程收到
   `custom` 帧**——pi-web 能拿到只是因为它完全绕开了 `rpc-mode.ts`，
   在进程内自己实现了一套 `ExtensionUIContext`（见第 1 节）。这是造成
   这个差距的最根本的结构性原因：**pi-web 的"RPC 模式"是同进程内对 UI
   context 的重新实现；Picot 的 RPC 模式是字面意义上的上游 RPC 模式，
   而这个模式目前功能上就是更受限的。**

2. **`extension-ui-host.js` 里根本没有针对 `custom` 的浏览器端处理逻辑**——
   它被路由到通用的 `default:` 分支，立即回复
   `{ cancelled: true, error: "unsupported" }`（见 `extension-ui-host.js`
   及其自带的测试："reports TUI-only operations as unsupported"）。
   即便上游未来真的开始发出 `custom` 帧，Picot 的 host JS 仍然需要：
   - 一个渲染循环，在 `requestRender()` 时重新请求组件渲染出的文本行
     （目前没有这样的触发机制，因为根本没有发射器会触发它——一旦
     `rpc-mode.ts` 像 pi-web 的 `emitCustomUiRender` 那样发出 `method: "custom"`
     渲染帧，这部分就能顺理成章地补上），
   - 一个输入通路，把 DOM 的 keydown/粘贴事件转换成终端转义序列，再以
     `extension_ui_input` 的形式发回去（pi-web 的 `lib/terminal-input.ts`
     可以直接拿来用——同一套转义序列表适用于任何"说 xterm 语言"的后端），
   - 一个用来承载 ANSI 渲染文本行的模态框/面板（Picot 在别处已经解析过
     带样式的文本，所以这大部分是接线工作，不是全新的能力）。

## 5. `setStatus` / `setWidget`——更小的、纯浏览器端的差距

与 `custom()` 不同，这两个方法**在 Picot 今天的实现里已经端到端可以工作**
——`rpc-mode.ts` 会从真实子进程发出它们，Rust bridge 会转发它们，
`extension-ui-host.js` 也已经把它们路由到了 `hooks.status` / `hooks.widget`。
唯一缺的是**通用渲染逻辑**：

- `setStatus`：Picot 的 `hooks.status` 丢弃了 `statusKey`，始终只显示一个
  硬编码的 "Connected" 字符串
  （`status: (request) => setStatus(request.statusText || "Connected")`）。
  pi-web 维护一个按 `statusKey` 索引的活跃 `Map`/数组
  （`extensionStatuses`），并通过 `ExtensionStatusBar` 把它们全部渲染出来。
  **修复纯粹在前端**：维护一个 `Map<statusKey, statusText>`
  （对照 `useAgentSession.ts` 里的 `setExtensionStatuses` reducer），
  渲染这个 map 而不是单个字符串。
- `setWidget`：Picot 的 `hooks.widget` 除了一个针对特定 extension 的
  `widgetKey` 判断之外什么都不做。pi-web 维护一个
  `Map<widgetKey, {lines, placement}>`（`extensionWidgets`），通过
  `ExtensionWidgets` 把它们全部渲染在输入框上方/下方。**修复纯粹在前端**：
  把 `rpiv-todo-mirror.js` 里的特殊逻辑泛化成一个通用的
  `Map<widgetKey, {lines, placement}>` 渲染器（例如新增一个
  `above-editor-widgets` / `below-editor-widgets` 的 DOM 容器），对于
  任何还没有原生镜像实现的 `widgetKey`，都回退到这个通用渲染器（保留
  `rpiv-todos` 的特殊处理作为一种*覆盖*，而不是唯一的路径）。

这两处都是低风险、不涉及 Rust 改动、不依赖上游改动的修复——纯浏览器
JS 改动，遵循 pi-web 已经验证过的模式即可。

## 6. 总结：Picot 目前真正被卡住的地方

| 差距 | 所在层级 | 需要上游（`pi-mono`）改动？ | 需要 Rust（`src-tauri`）改动？ | 修复范围 |
|---|---|---|---|---|
| `setStatus` 的通用渲染（支持多个 key） | `public/native/app.js` 的 hook | 否 | 否 | 小，纯前端 |
| `setWidget` 的通用渲染（支持任意 extension，不只是 rpiv-todo） | `public/native/app.js` 的 hook + 新的 widget 容器 | 否 | 否 | 小，纯前端 |
| `custom()` TUI 组件（例如 extension 用 `pi-tui` 构建的交互式选择器/表单） | 需要 `rpc-mode.ts` 真正发出 `method: "custom"` 的渲染/输入帧（目前是个返回 `undefined` 的桩函数） | **是** —— `pi-mono/packages/coding-agent/src/modes/rpc/rpc-mode.ts` 的 `custom()` | 否（bridge 已经能转发任意 `extension_ui_*` 帧） | 中：需要上游 RPC 支持 + 一套仿照 pi-web 的 `ExtensionCustomPanel` + `terminal-input.ts` 的浏览器端渲染/输入循环 |
| `setWorkingMessage`/`setWorkingIndicator`/`setFooter`/`setHeader`/自定义编辑器组件 | RPC 模式对**两端**都不会发出这些（`rpc-mode.ts` 里都是空操作） | 如果以后想要的话，是 | 否 | 超出范围——pi-web 和 Picot 都不支持这些；不是 Picot 特有的回退 |

**回到用户最初的假设：** 问题**不是**"extension 没有把状态汇报给 Picot 的
RPC"——RPC 层（子进程 → Rust bridge → WebSocket）本身已经在正确地承载
`setStatus`/`setWidget`/`custom` 这些帧，只要上游 `pi` 二进制发出它们就行。
真正的缺口是：

1. Picot 的**浏览器 JS**（`extension-ui-host.js` / `app.js`）只对一个
   extension 的 widget 做了特殊处理，其他所有 extension 的
   `setStatus`/`setWidget` 负载都被丢弃——这一点完全可以在 Picot 内部修复，
   不依赖上游。
2. `custom()`（任意交互式 extension UI）**在真实的 `pi --mode rpc` 二进制
   本身里就没有实现**（`rpc-mode.ts`），所以任何使用这个真实二进制的客户端
   ——包括一个假想中从零重写的 Picot——目前都不可能收到这些帧。pi-web
   看起来"支持"这个功能，只是因为它压根没有走这个二进制，而是把 SDK
   内嵌进来，自己手写了一套 `ExtensionUIContext`——这和 Picot"启动真实
   CLI 的 RPC 模式"的集成策略,是根本不同的两条路线。

## 7. Picot 的建议路径

1. **先做低风险的收益**（第 5 节）：把 `public/native/app.js` /
   `extension-ui-host.js` 里的 `setStatus` 和 `setWidget` 处理泛化成按
   `statusKey`/`widgetKey` 建索引、能渲染 N 项而不是 1 项。仅这一项就能
   在零上游/零 Rust 改动的前提下，收回"extension 功能在 Picot 里不可见"
   这个问题里相当一部分的份额。
2. **向上游提出 `custom()` 的 RPC 缺口**，针对
   `pi-mono/packages/coding-agent/src/modes/rpc/rpc-mode.ts`——提议一套
   与 pi-web 的 `custom-ui-terminal.ts` 方案一致的协议：
   `extension_ui_request { method: "custom", lines }` /
   `extension_ui_input { id, data }`，因为 pi-web 已经证明了这个设计可行，
   而且 RPC 的类型定义（`rpc-types.ts`）可以扩展成与 `lib/types.ts` 里
   `ExtensionUiRequest` 联合类型一致的形态（它已经有了 pi-web 发明的
   `method: "custom"` / `closed` 结构——复用它能让两个 host 的协议保持
   收敛，而不是继续分裂）。
3. **一旦上游开始发出 `custom` 帧**，把 pi-web 的 `lib/terminal-input.ts`
   （转义序列映射表）以及 `ExtensionCustomPanel` 的渲染/模态框模式移植到
   Picot 的 JS 里——这套逻辑与 host 无关（DOM keydown → ANSI 字节，
   带 ANSI 样式的 `string[]` → 带样式的 DOM），并不依赖 pi-web 那种
   同进程内嵌的架构。

## 8. 具体设计方案（对照当前代码复核后新增）

### 阶段一 —— `setStatus`/`setWidget` 通用化（纯前端，不依赖上游/Rust）

直接照抄 pi-web 的 keyed 状态模型。注意 pi-web 自己用的其实是"数组 +
按 `statusKey`/`widgetKey` filter-then-append 去重"（`hooks/useAgentSession.ts:791-810`），
并不是真正的 `Map`——照搬这个已经跑通的形状，别自己发明新结构：

- `app.js` 的 `hooks.status`/`hooks.widget` 改成维护
  `statusItems: {key, text}[]` / `widgetItems: {key, lines, placement}[]`，
  按 `key` 去重，`statusText === undefined` 时移除该条目。
- 新增通用的 `above-editor-widgets` / `below-editor-widgets` DOM 容器和状态栏，
  遍历渲染*所有* key，而不是只认 `rpiv-todos`。
- 保留 `rpiv-todo-mirror.js` 作为**覆盖（override）**而非唯一路径：某个
  `widgetKey` 如果有原生镜像组件就优先用它，否则回退到通用渲染器。

风险低、收益立即可见，不依赖阶段二/三。

### 阶段二 —— upstream 协议扩展（`pi-mono`：`rpc-mode.ts` + `rpc-types.ts`）

这才是真正的阻塞点，两个 host 都受益：

1. 给 `rpc-types.ts` 的 `RpcExtensionUIRequest` 联合类型加一个 `custom` 变体，
   形状照抄 pi-web 自己的 `ExtensionUiRequest`
   （`{method: "custom", id, lines: string[], closed?: boolean}`）——复用
   pi-web 已验证过的形状能让两个 host 的协议保持收敛。
2. 给 `RpcCommand` 加 `extension_ui_input {id, data: string}`，作为按键回传
   通道（区别于 select/confirm 用的一次性 `extension_ui_response`）。
3. 按 pi-web `requestExtensionCustomUi` 的设计实现 `rpc-mode.ts` 的
   `custom()`：造一个 headless `TUI`
   （`{terminal: {columns, rows, kittyProtocolActive: false}, requestRender()}`），
   调用 extension 的 factory 拿到 `Component`，把
   `render(width): string[]` 的结果发成
   `extension_ui_request{method:"custom",lines}`；收到 `extension_ui_input`
   时调 `component.handleInput(data)` 再重渲染；`done()`/dispose 时发出
   `{lines: [], closed: true}`。这套逻辑与 host 无关——pi-web 已经验证过
   设计可行，只需要把目标从进程内事件发射器换成 stdout JSONL 帧。

### 阶段三 —— Picot 浏览器端渲染/输入循环

一旦上游真的发出 `custom` 帧，需要三块，都是"同款逻辑，换宿主"：

1. **按键编码**：`lib/terminal-input.ts` 的 `toTerminalKeyData()` /
   `asBracketedPaste()` 是纯函数，不依赖任何 React/pi-web 特有状态——可以
   逐字节移植。映射表（方向键、Home/End、Ctrl 组合走 `code & 0x1f`、Alt
   前缀走 `\x1b`+字符、Enter/Tab 的 Shift 变体）是标准终端转义序列知识，
   与 host 无关。
2. **ANSI 渲染**：`lib/ansi.ts` 的 `parseAnsiLine()`（仅处理 SGR——8色/
   亮色/256色/truecolor）加上 `normalizeCustomPanelLines()`（剥掉 TUI 的
   box-drawing 边框和光标标记）可以整体移植，或者接到 Picot 已有的 ANSI
   渲染基建（对话框、工具卡片）上。
3. **输入捕获 + 队列整合**——这是 Picot 相比 pi-web 多出来的复杂度，
   需要认真设计：pi-web 是单会话网页，`ExtensionCustomPanel` 直接挂一个
   隐藏 `<textarea>` 捕获 keydown/组合输入/粘贴。Picot 已经有一套针对
   阻塞式对话框的前台/后台会话队列（`extension-ui-host.js` 的
   `#queues`/`#inFlight`、`flushForegroundQueue()`）——`custom` UI 面板
   必须接入**同一套**机制：只有前台会话的 `custom` 面板才应该挂载键盘
   捕获、驱动 `requestRender()` 循环；后台会话的 `custom` 帧应该只缓存
   最新的 `lines`，等该会话切到前台时才挂载渲染/输入循环。否则多个会话
   的 custom 面板会互相抢键盘焦点，或者在后台空转渲染。

### 一个值得留意的尺寸细节

pi-web 的 headless 终端尺寸是按请求固定的（默认 92×40，通过
`options.overlayOptions().width` 限幅 40-140）——不会随浏览器窗口自适应。
Picot 可以先照抄这个简单的固定/限幅宽度模型；让面板宽度跟随真实 DOM
尺寸（把面板实际可用列数传进 `custom` 请求）是后续的锦上添花，不是
第一版的阻塞项。

**优先级**：阶段一今天就能独立上线，零风险。阶段二必须先在 `pi-mono`
落地（协议设计可以直接照抄 pi-web 已经跑通的实现，不需要重新设计）。
阶段三基本是机械式移植——唯一真正需要新设计的是和 Picot 已有的前台/
后台会话队列做整合。
