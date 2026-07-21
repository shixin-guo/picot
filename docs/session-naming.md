<!-- ABOUTME: Pi session 命名机制，以及 Picot 显示/改名 session 名字的现状、限制与修复建议 -->
<!-- ABOUTME: 调研结论归档——限制较多、收益有限，暂缓实现，留待以后再说 -->

# Session 命名：Pi 机制与 Picot 集成限制

> **状态：暂缓（Deferred）**
> 调研日期：2026-07-21
> 结论：在 Picot sidebar 中「显示用户自定义 session 名字」与「支持 rename 操作」受到多处限制，修复点分散且收益有限，**暂不实现**。本文记录调研结论与将来实现时的建议方向，避免重复调研。

## 背景

Dr. Lin 希望在 Picot 左侧 workspace/session list 中：

1. 显示 session 的名字（包括在 Pi 的 `/resume` 里改名后的名字）；
2. 在 sidebar 上支持对 session 进行 rename 操作。

调研覆盖 Pi（`~/tmp/PI/pi`，即 pi-mono）与 Picot 两端。下文按「Pi 机制 → Picot 显示限制 → Picot 改名缺口 → 修复建议 → 暂缓理由」展开。

---

## 一、Pi 侧的 session 命名机制

### 1.1 存储模型：`session_info` entry（append-only）

session 的名字**不存在 sqlite**，而是作为一条 `session_info` entry **追加进 `.jsonl` 文件**：

- 数据结构（`packages/coding-agent/src/core/session-manager.ts`）：

  ```ts
  /** Session metadata entry (e.g., user-defined display name). */
  export interface SessionInfoEntry extends SessionEntryBase {
    type: "session_info";
    name?: string;
  }
  ```

- 写入：`SessionManager.appendSessionInfo(name)` → `_appendEntry` → `appendFileSync(this.sessionFile, ...)`，即**写到 jsonl 文件尾部**。空字符串表示清除名字。
- 读取：`getSessionName()` 反向遍历 entries，取**最新一条** `session_info`。
- 一个 session 可以有多条 `session_info`，**最新的一条生效**（rename = 再 append 一条新的）。

### 1.2 `/resume` 改名

在 TUI 的 session 选择器中，`Ctrl+R` 进入 rename 模式，提交后调用 `renameSession(sessionPath, newName)`，最终落到 `appendSessionInfo`。参见 `packages/coding-agent/test/session-selector-rename.test.ts` 与 `src/modes/interactive/components/session-selector.ts`。

### 1.3 列表接口已带 `name`

`SessionManager.list(cwd)` 返回的 `SessionInfo` 已包含 `name` 字段：

```ts
export interface SessionInfo {
  path: string;
  id: string;
  cwd: string;
  /** User-defined display name from session_info entries. */
  name?: string;
  // ...
}
```

`buildSessionInfo(filePath)` 在扫描 jsonl 时**完整遍历整个文件**，提取最新的 `session_info.name`（`session-manager.ts` 内 `buildSessionInfo`：遇到 `entry.type === "session_info"` 即更新 `name`，最后取到的是文件末尾的最新值）。**所以 Pi 自己总能正确读到 rename 后的名字。**

### 1.4 关键限制：实例级 API，无「按路径改名」

- `setSessionName` / `getSessionName` / `appendSessionInfo` 都是**实例方法**，作用于「当前活跃 session」（见 `src/core/extensions/types.ts` 的 ExtensionAPI：`setSessionName(name)` / `getSessionName()`）。
- `SessionManager` 的**静态方法只有只读的 `list` / `listAll`**，没有「给任意 session 文件改名」的静态 API。

这条限制直接影响了 Picot 的改名方案（见第三节）。

---

## 二、Picot 显示 session name 的现状与限制

### 2.1 显示链路本身已经打通

| 环节 | 位置 | 状态 |
| --- | --- | --- |
| 后端解析 | `extensions/embedded-server.ts` 的 `parseSessionFile()` 已提取 `session_info.name` → 返回 `{ name, firstMessage, ... }` | ✅ |
| 列表响应 | `/api/sessions`（`serveSessionsList`）每个 session 对象已带 `name` | ✅ |
| 前端提取 | `public/workspace-projects.js` 已把 `s.name` 取出 | ✅ |
| 前端渲染 | `public/sidebar/index.js` 的 `buildSessionItem`：`session.name \|\| session.firstMessage \|\| t("sidebar.emptySession")`，**优先用 name** | ✅ |

此外，Picot 自己还会为活跃 session 自动生成标题（`generateSessionTitle` + `a.setSessionName`，见 `embedded-server.ts`）。

**结论：显示链路本身没问题——只要 `name` 能被解析到，前端就会优先显示它。**

### 2.2 关键限制：`parseSessionFile` 的 50 行早退，读不到尾部 `session_info`

`parseSessionFile` 为了快速列出几百个 session，做了一个早退优化：

```ts
for await (const line of rl) {
  // ...
  if (entry.type === "session") header = entry;
  else if (entry.type === "session_info" && entry.name) sessionName = entry.name;
  else if (entry.type === "message" && entry.message?.role === "user") {
    if (!firstMessage) { /* 取首条 user message */ }
  }
  if (lineCount > 50 && firstMessage) break;   // ← 早退
}
```

而 rename 写入的 `session_info` 是 `appendFileSync` 到**文件尾部**（见 1.1）。一个已经聊过的 session 远超 50 行，`session_info` 落在文件尾部 → **第 51 行就 break，永远扫不到它** → 返回 `name: null` → 前端回退到 `firstMessage`。

### 2.3 实证

扫描本机 `~/.pi/agent/sessions` 下含 `session_info` 的文件：

```
total=274  session_info_at=264   (picot-v3 项目的一个 session)
total=54   session_info_at=54
total=112  session_info_at=58
```

三份文件的 `session_info` 全部落在第 50 行之后，`parseSessionFile` 一个都读不到。

### 2.4 为什么「refresh 按钮刷新」也看不到新名字

refresh 是**有效的**：文件 mtime 变了 → `parseSessionFileCached` 的 mtime+size 缓存失效 → 确实重新解析了。但重新解析时**仍然在第 51 行 break**。问题不在缓存/刷新，而在 `parseSessionFile` 的早退逻辑本身。

> 对比：Pi 自己的 `buildSessionInfo` 是完整遍历的，所以 Pi 里能看到新名字，Picot 看不到。

---

## 三、在 Picot 中 rename session 的现状与缺口

### 3.1 后端：`set_session_name` RPC 已通，但只能改「当前活跃 session」

`embedded-server.ts` 处理 WebSocket 的 `set_session_name`：

```ts
case "set_session_name": {
  const name = command.name?.trim();
  if (!name) { sendTo(ws, error("set_session_name", "Name cannot be empty")); break; }
  const a = requireApi("set_session_name");
  if (!a) break;
  a.setSessionName(name);          // 实例方法，作用于当前进程的活跃 session
  sendTo(ws, success("set_session_name"));
  break;
}
```

`requireApi()` 返回的是**当前 embedded-server 所在 pi 进程的活跃 session** 的 ExtensionAPI。由于 Pi 没有「按路径改名」的静态 API（见 1.4），这个 RPC **只能改当前 WebView 附着进程的活跃 session**。

### 3.2 前端：`startRename` 是死代码

`public/sidebar/index.js` 已经写好了一半改名逻辑，但**没有任何 UI 触发它**：

- `startRename(itemEl)`（约 675 行）：内联 `<input>` 改名、Enter 提交、Esc 取消，逻辑完整——但**全文无任何调用点**。
- `exportSession(_session)`（约 720 行）：同样**只定义、从未被调用**。
- session-item 上目前只有 pin 按钮 + archive 按钮，**没有 rename 按钮**。
- 全局 `contextmenu` 监听器只认 `.workspace-header`，**没有为 session-item 绑右键菜单**（对比 workspace 已有完整的 `showWorkspaceContextMenu`）。

### 3.3 架构矛盾（很可能是 rename 未接线的根因）

`startRename(itemEl)` 设计上**对任意 session item 都能触发**（itemEl 对应任意 session）；而后端 `set_session_name` **只能改当前活跃 session**。Picot 的 sidebar 列的是**所有** session（含历史未运行的、其他 pi 进程的）。**「前端能点任意项」与「后端只能改当前活跃项」不匹配**——即使接通了入口，对绝大多数非活跃 session rename 也会静默无效。判断这正是该功能被搁置的原因。

---

## 四、若将来实现的建议

### 4.1 正确显示名字（修复 `parseSessionFile`）

| 方案 | 做法 | 取舍 |
| --- | --- | --- |
| **A. 尾部采样（推荐）** | 正向读保留 50 行早退（拿 header + firstMessage），再单独从文件**末尾读一段**（如最后 8KB）解析最新的 `session_info`。 | 性能不变；rename 总在尾部，采样可靠。 |
| B. 去掉 break 完整读 | 删掉早退，完整遍历。 | 最简单，但几百个 session 全量读，冷缓存下列表变慢。 |
| C. 改用 `SessionManager.list()` | embedded-server 已 `import SessionManager`，其 `buildSessionInfo` 完整扫描且已正确提取 `name`。 | 最干净，但要适配 Picot 的多项目遍历 + 缓存结构，改动最大。 |

### 4.2 支持改名

**前端（接通入口）：**

- 新增 `showSessionContextMenu(event, session, itemEl)`，菜单项含 Rename / Export / Pin / Archive（顺带把 `exportSession` 死代码接上），与 workspace 右键菜单风格一致。
- 在 `buildSessionItem` 里给 item 绑 `contextmenu`，或加 ⋯ 按钮触发菜单。
- 修复 `startRename` 的一个 bug：提交后只更新了 DOM，未更新 `this.projects` 里的 `session.name`，re-render 会回退到旧值——需做**乐观更新**。

**后端（新增「按路径改名」能力，解决 3.3 的矛盾）：**

- B1：Pi 侧加静态方法 `SessionManager.appendSessionInfoToPath(filePath, name)`，embedded-server 调用它。最干净，符合「always via embedded pi」约束，但要改 pi。
- B2：在 embedded-server（仍运行在 pi 进程内的扩展）里直接 `fs.appendFile` 写一行合法的 `session_info` entry（`{type:"session_info", name, id, parentId, timestamp}`）。不改 pi；实测 `buildSessionInfo` 只认 `type`+`name`、不校验 `parentId`，可行。属于「扩展直接读写 session 文件」，需确认是否接受。

### 4.3 同步

改名写入 `session_info` 后，`/api/sessions` 下次拉取即带新 `name`。是否需要 WS 广播给其他已打开的 Picot 窗口以实时刷新，视体验要求而定。

---

## 五、暂缓理由

综合以上：

1. **显示侧**：要修 `parseSessionFile` 才能让 rename 的名字真正显示（当前因 50 行早退全部失效）。
2. **改名侧**：要同时做前端入口接线 + 后端新增「按路径改名」能力（否则只能改当前活跃 session，对 sidebar 多数项无效）。
3. 涉及 Picot 前端、embedded-server、可能还涉及 pi 本身三处改动，点分散。
4. 当前 session 列表用 `firstMessage` 作为标题，基本可用；用户自定义命名的需求强度有限。

故**暂缓实现**，留待日后 session 管理体验整体优化时一并处理。
