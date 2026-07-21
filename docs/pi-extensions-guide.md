# Pi Extensions 机制详解

> 基于 pi-mono 仓库源码与官方文档整理。源码版本对应 `packages/coding-agent/`。

## 一、Extension 是什么

Extension 是一个 TypeScript 模块,导出一个 default factory 函数,接收 `ExtensionAPI`:

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
  // 在这里订阅事件、注册工具、注册命令、注册快捷键……
}
```

关键特征:

- **运行在你的系统权限下**,能执行任意代码、读写文件、起进程——所以只装可信来源。
- 用 [jiti](https://github.com/unjs/jiti) 加载,**TypeScript 无需编译**直接跑。
- Factory 可以是 `async`,pi 会 await 完成才继续启动。但**不要**在 factory 里起长生命周期资源(process/socket/watcher/timer)——因为 factory 也可能在无 session 的调用里跑(比如 `--list-models`)。要起后台资源,延迟到 `session_start`,并在 `session_shutdown` 里清理。
- **加载入口**: `packages/coding-agent/src/core/extensions/loader.ts` 的 `discoverAndLoadExtensions()`。

---

## 二、Extension 的加载位置与顺序

代码里写死的三步顺序(`loader.ts:651–698`):

| 顺序 | 来源 | 位置 |
|---|---|---|
| 1 | 项目级 | `cwd/.pi/extensions/` |
| 2 | 全局级 | `~/.pi/agent/extensions/`(`agentDir`,可由 `PI_CODING_AGENT_DIR` 覆盖) |
| 3 | 显式配置 | settings.json 的 `extensions: []` + CLI `-e/--extension` 参数 |

每个目录下的发现规则:
- `*.ts` / `*.js` 文件直接作为 extension
- `子目录/index.ts` 也算一个 extension
- 去重按 `path.resolve` 后的绝对路径

**项目 trust 约束**: `.pi/extensions/`(顺序 1)只在项目被 trust 之后才加载。`project_trust` 事件本身只能被全局级和 CLI `-e` extension 接收——因为项目级 extension 那时还没加载。trust 的决策结果:第一个返回 `yes`/`no` 的 extension 拿走决策权,压制内置 trust prompt;`remember: true` 持久化到 `trust.json`。

---

## 三、Extension 能做什么(ExtensionAPI 全景)

### 注册类 API

| 方法 | 作用 |
|---|---|
| `pi.on(event, handler)` | 订阅生命周期事件(下文详述) |
| `pi.registerTool(def)` | 注册 LLM 可调用的工具 |
| `pi.registerCommand(name, opts)` | 注册 `/name` slash 命令 |
| `pi.registerShortcut("ctrl+x", opts)` | 注册全局快捷键 |
| `pi.registerFlag(name, opts)` | 注册 CLI flag(如 `pi --plan`) |
| `pi.registerProvider(name, config)` | 注册/覆盖模型 provider(代理、自定义端点、OAuth) |
| `pi.registerMessageRenderer(customType, fn)` | 自定义 TUI 消息渲染(消息**进** LLM context) |
| `pi.registerEntryRenderer(customType, fn)` | 自定义 TUI entry 渲染(消息**不进** LLM context,纯 TUI 显示) |

### 运行时控制类 API

| 方法 | 作用 |
|---|---|
| `pi.sendMessage(msg, opts)` | 注入自定义消息到 session,参与 LLM context |
| `pi.sendUserMessage(text, opts)` | 注入"用户消息",必触发一轮 |
| `pi.appendEntry(customType, data)` | 持久化 extension 数据到 session 文件,跨重启 |
| `pi.exec(cmd, args, opts)` | 执行 shell 命令,返回 `{stdout, stderr, code, killed}` |
| `pi.getActiveTools() / getAllTools() / setActiveTools(names)` | 动态开关工具 |
| `pi.setModel(model)` | 切模型(无 key 返回 false) |
| `pi.getThinkingLevel() / setThinkingLevel(level)` | thinking 等级,会触发 `thinking_level_select` |
| `pi.events` | extension 之间的共享 event bus(`emit`/`on`) |

---

## 四、生命周期事件(按发生顺序)

```
pi 启动
 ├─ project_trust        (仅全局/CLI extension,决定是否信任项目)
 ├─ session_start        (reason: "startup")
 └─ resources_discover   (reason: "startup",返回 skillPaths/promptPaths/themePaths)

用户发 prompt
 ├─ (extension command 先查,/cmd 命中则直接执行,跳过后续)
 ├─ input                (可拦截/改写/吞掉用户输入)
 ├─ (skill/template 展开,如 /skill:foo、/template)
 ├─ before_agent_start   (可注入消息、改 system prompt)
 ├─ agent_start
 ├─ message_start/update/end
 │
 │  ┌─ 一轮(LLM 调工具时循环)─┐
 │  ├─ turn_start              │
 │  ├─ context                 │ (可修改发给 LLM 的 messages)
 │  ├─ before_provider_headers │ (改 HTTP headers)
 │  ├─ before_provider_request │ (可替换 provider payload)
 │  ├─ after_provider_response │ (拿到 HTTP status/headers,流消费前)
 │  │                          │
 │  │  LLM 回复,可能调工具:    │
 │  │   ├─ tool_execution_start│
 │  │   ├─ tool_call           │ ★可 block,可改 event.input
 │  │   ├─ tool_execution_update
 │  │   ├─ tool_result         │ ★可改结果(链式 middleware)
 │  │   └─ tool_execution_end  │
 │  └─ turn_end                │
 │
 ├─ agent_end
 └─ agent_settled        (无 retry/compaction/follow-up 剩余)

/new、/resume、/fork、/clone → session_shutdown → session_start{reason}
/compact → session_before_compact → session_compact
/model、Ctrl+P → thinking_level_select(若等级被夹断)→ model_select
退出(Ctrl+C/D, SIGHUP/SIGTERM)→ session_shutdown
```

最常用、最强大的几个:

- **`tool_call`** — 执行前拦截,可 `block: true` 拦掉,也可直接 mutate `event.input` 改参数(改完不重新校验)。这是做 permission gate、保护 `.env`、给 bash 命令前加 `source ~/.profile` 的地方。
- **`tool_result`** — 链式 middleware,可改 content/details/isError。
- **`before_agent_start`** — 改 system prompt,注入消息。`event.systemPromptOptions` 能拿到 pi 构造 system prompt 的全部结构化输入(custom prompt、tools、guidelines、context files、**skills**)。
- **`context`** — 发给 LLM 前改 messages(删旧消息、注入上下文)。
- **`input`** — 用户输入进 agent 前拦截,在 skill/template 展开之前。

---

## 五、两个 Context 对象

所有 handler 收到 `ctx: ExtensionContext`,命令 handler 收到它的子类 `ExtensionCommandContext`。

### ExtensionContext 的关键字段

| 字段 | 说明 |
|---|---|
| `ctx.ui` | UI 方法(select/confirm/input/editor/notify/setStatus/setWidget…) |
| `ctx.mode` | `"tui"` / `"rpc"` / `"json"` / `"print"` |
| `ctx.hasUI` | TUI 和 RPC 下 true,print/json 下 false。守卫对话框方法 |
| `ctx.cwd` | 当前工作目录 |
| `ctx.sessionManager` | 只读 session 状态(getEntries/getBranch/buildContextEntries/getLeafId) |
| `ctx.modelRegistry / ctx.model` | 模型和 API key 访问 |
| `ctx.signal` | 当前 agent 的 AbortSignal(用于 fetch 等可取消操作) |
| `ctx.isIdle() / ctx.abort() / ctx.hasPendingMessages()` | 流控辅助 |
| `ctx.shutdown()` | 请求优雅退出 |
| `ctx.getContextUsage()` | 当前上下文用量 |
| `ctx.compact(opts)` | 触发压缩 |
| `ctx.getSystemPrompt()` | 当前 system prompt 字符串 |
| `ctx.isProjectTrusted()` | 项目是否被信任(含临时决策) |

### ExtensionCommandContext 多出来的方法(只能在命令里用,在事件里用会死锁)

`ctx.waitForIdle()`、`ctx.newSession()`、`ctx.fork()`、`ctx.navigateTree()`、`ctx.switchSession()`、`ctx.reload()`、`ctx.getSystemPromptOptions()`。

---

## 六、Custom Tools(最常用的能力)

```typescript
pi.registerTool({
  name: "my_tool",
  label: "My Tool",
  description: "给 LLM 看的工具说明",
  promptSnippet: "一句话,出现在 system prompt 的 Available tools 段",
  promptGuidelines: [
    "Use my_tool when ...",  // 必须自己写出工具名,不能写 "this tool"
  ],
  parameters: Type.Object({
    action: StringEnum(["list", "add"] as const),  // 枚举必须用 StringEnum(Google 兼容)
    text: Type.Optional(Type.String()),
  }),
  prepareArguments(args) { /* 兼容旧 session 的参数形状,可选 */ return args; },

  async execute(toolCallId, params, signal, onUpdate, ctx) {
    if (signal?.aborted) return { content: [{ type: "text", text: "Cancelled" }] };
    onUpdate?.({ content: [{ type: "text", text: "Working..." }] });
    return {
      content: [{ type: "text", text: "Done" }],  // 发给 LLM
      details: { data: "..." },                    // 给渲染和 state 用
      terminate: true,  // 可选:暗示这批工具跑完不要自动 follow-up
    };
  },

  // 可选:自定义 TUI 渲染
  renderCall(args, theme, context) { ... },
  renderResult(result, opts, theme, context) { ... },
});
```

要点:

- **报错方式**: 抛 Error → `isError: true` 报给 LLM;返回值里的字段不会设错误标志。
- **枚举**: 用 `StringEnum` from `@earendil-works/pi-ai`,不能用 `Type.Union`/`Type.Literal`(Google API 不兼容)。
- **改文件的工具**: 用 `withFileMutationQueue(absolutePath, async () => {...})` 加入和内置 `edit`/`write` 同一个 per-file 队列。否则并行工具调用下两个工具读到旧内容、各自改、互相覆盖。
- **覆盖内置工具**: 注册同名 tool 即覆盖(`read`/`bash`/`edit`/`write`/`grep`/`find`/`ls`)。渲染器是 per-slot 继承的——override 没写 `renderCall` 就用内置的。必须匹配内置 tool 的 result shape(包括 `details`)。
- **完全不要内置工具**: `pi --no-builtin-tools -e ./my-ext.ts`。
- **动态注册**: `registerTool` 在 startup 后也能调,立即生效,不需要 `/reload`。

---

## 七、Custom UI(只在 TUI/RPC 下有意义)

### 对话框(ctx.ui)

```typescript
const choice = await ctx.ui.select("选一个:", ["A", "B", "C"]);
const ok = await ctx.ui.confirm("删除?", "不可撤销");
const name = await ctx.ui.input("名字:", "placeholder");
const text = await ctx.ui.editor("编辑:", "预填");
ctx.ui.notify("完成", "info");  // "info" | "warning" | "error"
```

带倒计时: `{ timeout: 5000 }`,或用 `AbortSignal` 区分超时和用户取消。

### 布局类

```typescript
ctx.ui.setStatus("my-ext", "Processing...");    // footer 状态,持久
ctx.ui.setWidget("my-widget", ["Line1", "Line2"], { placement: "belowEditor" });
ctx.ui.setWorkingMessage("深度思考中...");        // 流式时显示
ctx.ui.setWorkingIndicator({ frames: [...], intervalMs: 120 });
ctx.ui.setFooter((tui, theme) => ({ render(w) {...}, invalidate() {} }));  // 替换整个 footer
ctx.ui.setTitle("pi - my-project");
ctx.ui.setEditorText("预填");
ctx.ui.setEditorComponent((tui, theme, kb) => new VimEditor(...));  // VIM 模式编辑器
ctx.ui.addAutocompleteProvider((cur) => ({ triggerCharacters: ["#"], ... }));
```

### 持久化 + 自定义渲染(纯 TUI,不进 LLM)

```typescript
pi.registerEntryRenderer("status-card", (entry, opts, theme) => {
  return new Box(...);
});
pi.appendEntry("status-card", { title: "Indexed", count: 17 });
```

`appendEntry` 写进 session 文件,重启后 `session_start` 里读回来恢复 state。

---

## 八、状态管理

带状态的 extension 应该把状态放进 tool result 的 `details` 字段——这样 session branching(/tree、/fork)能正确工作。不要用模块级闭包变量存"当前状态",branch 切换时会错乱。

跨重启的持久状态用 `pi.appendEntry(customType, data)`,在 `session_start` 里 `ctx.sessionManager.getEntries()` 找回。

---

## 九、在 Pi TUI 里如何使用 extension(实操)

### 方式 A:放自动发现目录(推荐,支持 `/reload`)

```bash
# 全局(所有项目可用)
mkdir -p ~/.pi/agent/extensions
cp my-extension.ts ~/.pi/agent/extensions/

# 项目级(团队共享,需 trust)
mkdir -p .pi/extensions
cp my-extension.ts .pi/extensions/
```

启动 `pi` 即自动加载。项目级首次会触发 trust prompt。

### 方式 B:CLI 临时加载

```bash
pi -e ./my-extension.ts          # 本地文件
pi -e ./my-extension-dir         # 目录(找 index.ts 或 package.json)
pi --extension npm:@foo/bar      # 临时拉一个 npm package,只本次有效
pi --extension git:github.com/user/repo
```

可叠加多个 `-e`。适合调试。

### 方式 C:settings.json 配置

`~/.pi/agent/settings.json`(全局)或 `.pi/settings.json`(项目):

```json
{
  "extensions": [
    "/abs/path/to/extension.ts",
    "/abs/path/to/extension-dir"
  ],
  "packages": [
    "npm:@foo/bar@1.0.0",
    "git:github.com/user/repo@v1"
  ]
}
```

### 方式 D:`pi install`(管理 package)

```bash
pi install npm:@foo/bar@1.0.0        # 装到全局 settings
pi install git:github.com/user/repo  # git 源
pi install ./local-package           # 本地路径
pi install -l npm:@foo/bar           # 装到项目级 settings(.pi/settings.json)
pi list                              # 看已装
pi remove npm:@foo/bar
pi update --extensions               # 更新所有 package
```

### 在 TUI 里交互

启动后:
- **看是否加载成功** — 启动 header 显示已加载的 extensions;按 `Ctrl+O` 切换展开/紧凑视图。
- **用 extension 注册的 slash 命令** — 编辑器输入 `/hello`、`/stats` 等,自动补全会列出 extension commands。
- **用注册的快捷键** — 如 `Ctrl+Shift+P`。
- **extension 注册的 tool** — LLM 会自主调用(前提是 tool 在 active 列表里);你可以 `pi.setActiveTools` 或用 `/tools` 类命令控制。
- **`/reload`** — 重新加载 extensions/skills/prompts/themes/context files,不需重启 pi。自动发现目录里的 extension 改了代码,`/reload` 即热更新。

### 模式差异(Mode Behavior)

| 模式 | `ctx.mode` | `ctx.hasUI` | 备注 |
|---|---|---|---|
| Interactive | `"tui"` | true | 全功能 TUI |
| RPC(`--mode rpc`) | `"rpc"` | true | 对话框和通知走 JSON 协议,`custom()` 返回 undefined |
| JSON(`--mode json`) | `"json"` | false | 事件流到 stdout,UI 方法是 no-op |
| Print(`-p`) | `"print"` | false | extension 运行但不能 prompt |

写 extension 时: TUI-only 功能(`custom()`、组件工厂、终端输入)用 `ctx.mode === "tui"` 守卫;对话框和通知用 `ctx.hasUI` 守卫。

---

## 十、一个端到端最小例子

`~/.pi/agent/extensions/my-ext.ts`:

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
  // 启动通知
  pi.on("session_start", async (_e, ctx) => {
    ctx.ui.notify("my-ext loaded", "info");
  });

  // 拦截危险命令
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName === "bash" && event.input.command?.includes("rm -rf")) {
      const ok = await ctx.ui.confirm("危险", "允许 rm -rf?");
      if (!ok) return { block: true, reason: "用户拒绝" };
    }
  });

  // 自定义工具
  pi.registerTool({
    name: "greet",
    label: "Greet",
    description: "按名字问候",
    promptSnippet: "Greet someone by name",
    parameters: Type.Object({ name: Type.String() }),
    async execute(_id, params) {
      return { content: [{ type: "text", text: `Hello, ${params.name}!` }] };
    },
  });

  // slash 命令
  pi.registerCommand("hello", {
    description: "打个招呼",
    handler: async (args, ctx) => {
      ctx.ui.notify(`Hello ${args || "world"}`, "info");
    },
  });
}
```

启动 `pi`,在 TUI 里:
- 看到 "my-ext loaded" 通知
- 输入 `/hello lin` → 通知 "Hello lin"
- 对 LLM 说 "greet me as Dr. Lin" → LLM 调用 `greet` 工具
- LLM 要跑 `rm -rf` 时弹确认框

改完代码 `/reload` 热生效。

---

## 十一、Extension 分发:打成 Pi Package

如果要把 extension 连同 skills/prompts/themes 一起分发(npm 或 git),用 pi package 机制。

### package.json 声明

```json
{
  "name": "my-ext",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./extensions/index.ts"],
    "skills": ["./skills"],
    "prompts": ["./prompts"],
    "themes": ["./themes"]
  }
}
```

### 目录结构

```
my-ext/
├── package.json
├── extensions/
│   └── index.ts
├── skills/
│   └── foo/
│       └── SKILL.md
└── prompts/
    └── review.md
```

没有 `pi` manifest 时,pi 自动扫描约定目录:`extensions/`(.ts/.js)、`skills/`(递归找 SKILL.md + 顶层 .md)、`prompts/`(.md)、`themes/`(.json)。

### 依赖处理

- 第三方运行时依赖放 `dependencies`。
- pi 核心包(`@earendil-works/pi-ai`、`pi-agent-core`、`pi-coding-agent`、`pi-tui`、`typebox`)放 `peerDependencies`,范围 `"*"`,不要打进 tarball。
- 其他 pi package 依赖放 `dependencies` + `bundledDependencies`。

### 安装

```bash
pi install npm:@scope/my-ext@1.0.0
pi install git:github.com/user/my-ext
```

安装后 package 在 `package-manager.ts` 的 `collectAutoResources()` 里被解析,资源汇入与本地资源相同的 accumulator,走完全相同的加载/校验/去重。

### Git 源:GitHub 与 Self-hosted GitLab

pi 对 git 源没有 host 白名单,任何能被 git clone 的仓库都能装。URL 解析在 `packages/coding-agent/src/utils/git.ts:172–226`。

#### pi 如何拉取/更新 git 源

`package-manager.ts:1815–1884` 直接 spawn 原生 `git` 命令:

| 操作 | 命令 |
|---|---|
| 首次安装 | `git clone <repo> <targetDir>`,有 ref 则再 `git checkout <ref>` |
| 更新(有 ref/pinned) | `git fetch origin <ref>` → `git reset --hard <ref>^{commit}` → `git clean -fdx` |
| 更新(无 ref) | `git fetch origin HEAD`(或默认分支) → `git reset --hard` → `git clean -fdx` |
| 有 package.json | clone/reset 后自动跑 `npm install` |

安装位置:全局 `~/.pi/agent/git/<host>/<path>/`,项目级 `.pi/git/<host>/<path>/`,临时(`pi -e`)用临时目录。

> **注意**:每次更新都 `git clean -fdx`,extension 目录保持 pristine,本地改动会被清掉。

#### URL 格式(适用于任何 host,含 self-hosted GitLab)

| 格式 | 示例 |
|---|---|
| `git:` 前缀 + 简写 | `git:gitlab.mycompany.com/team/my-ext` |
| `git:` 前缀 + SCP 式 | `git:git@gitlab.mycompany.com:team/my-ext.git` |
| `git:` 前缀 + 协议 URL | `git:https://gitlab.mycompany.com/team/my-ext.git` |
| 无前缀,必须带协议 | `https://gitlab.mycompany.com/team/my-ext.git` |
| SSH 协议 | `ssh://git@gitlab.mycompany.com/team/my-ext.git` |

带 ref:`git:gitlab.mycompany.com/team/my-ext@v1.2.0`

判定流程:先试 `hosted-git-info` 库(认 github/gitlab/bitbucket 等知名 host),不中再走 `parseGenericGitUrl` 兜底——后者从 URL parse 出 hostname 和 path,只要 host 含 `.` 或为 `localhost` 即通过(`git.ts:156`)。`gitlab.mycompany.com` 含 `.`,即便 `hosted-git-info` 不认识也能解析。GitLab 的子组路径(`group/subgroup/repo`)也支持,完整 pathname 会被保留(`git.ts:145`)。

#### 安装与配置

```bash
# 安装到全局
pi install git:gitlab.mycompany.com/team/my-ext@v1.0.0
# 或完整 URL
pi install https://gitlab.mycompany.com/team/my-ext.git

# 项目级
pi install -l git:gitlab.mycompany.com/team/my-ext

# 临时试用
pi -e git:gitlab.mycompany.com/team/my-ext
```

settings.json 直接写也行:

```json
{
  "packages": [
    "git:gitlab.mycompany.com/team/my-ext@v1.0.0"
  ]
}
```

#### 认证(self-hosted 私有仓库最需要注意)

pi clone 时设了 `GIT_TERMINAL_PROMPT=0`(`package-manager.ts:1641`),**不弹交互式密码 prompt**,所以私有仓库必须在 clone 之前配好凭证。

| 方式 | 说明 |
|---|---|
| **SSH**(推荐) | 自动用 `~/.ssh/config` 的配置和 SSH key。self-hosted GitLab 私有库最省心的方式——配好 SSH key 即可,pi 不需要任何额外配置 |
| Git credential helper | `git config --global credential.helper store/osxkeychain` |
| URL 内嵌 token | `https://oauth2:<token>@gitlab.mycompany.com/...`,能但不推荐写进 settings.json |
| `.netrc` | 传统方式 |

CI 环境:

```bash
# 非交互,禁用凭证 prompt,快速失败
export GIT_TERMINAL_PROMPT=0
export GIT_SSH_COMMAND="ssh -o BatchMode=yes -o ConnectTimeout=5"
```

#### 更新行为差异

| 配置 | `pi update --extensions` / `pi update --all` 行为 |
|---|---|
| 带 `@ref`(`git:...@v1.0.0`) | **pinned**,不移动 ref,只 reconcile 到该 ref |
| 不带 ref | 拉最新默认分支 |

换 ref 用 `pi install git:...@new-ref`,会更新 settings 并移动已有 clone 到新 ref。

### Package 过滤(filtered)

`pi list` 里某个 package 后面标 `(filtered)`,表示这个 package 在 `settings.json` 里用的是**对象形式**,即对它配置了资源过滤——只加载其中一部分 extensions/skills/prompts/themes。

#### 两种配置形态

`packages` 数组里每个条目有两种写法(`settings-manager.ts:72-81`):

```json
{
  "packages": [
    "npm:simple-pkg",
    {
      "source": "npm:my-package",
      "autoload?: boolean",
      "extensions?": ["..."],
      "skills?": ["..."],
      "prompts?": ["..."],
      "themes?": ["..."]
    }
  ]
}
```

| 写法 | `pi list` 显示 | 含义 |
|---|---|---|
| 字符串 `"npm:pkg"` | `npm:pkg` | 加载全部资源 |
| 对象 `{ source: "npm:pkg", ... }` | `npm:pkg (filtered)` | 按你指定的 patterns 过滤 |

判定逻辑就是 `filtered: typeof pkg === "object"`(`package-manager.ts:976`)。`(filtered)` 纯粹是配置形态标记,不代表出错。

#### 过滤 patterns 语法(`packages.md:189-215`)

```json
{
  "source": "npm:my-package",
  "extensions": ["extensions/*.ts", "!extensions/legacy.ts"],
  "skills": [],
  "prompts": ["prompts/review.md"],
  "themes": ["+themes/legacy.json"]
}
```

| 配置 | 效果 |
|---|---|
| 省略某个 key | 加载该类型的全部资源 |
| `[]` | 该类型一个都不加载 |
| `["extensions/*.ts", "!extensions/legacy.ts"]` | glob 包含 + `!` 排除 |
| `["+themes/legacy.json"]` | `+` 强制精确包含(相对 package root) |
| `["-extensions/debug.ts"]` | `-` 强制精确排除(相对 package root) |
| `autoload: false` | 起始为空,只应用你显式列出的 patterns(作为 delta 叠加到全局条目上) |

filter 叠在 package manifest 之上,只能**收窄** manifest 已经允许的范围,不能凭空加入 manifest 没声明的资源(`applyPackageFilter` → `collectManifestFiles`)。

#### 常见场景

一个大 package 同时带 extensions + skills + prompts,你只想要它的 skills:

```json
{
  "source": "npm:big-toolkit",
  "extensions": [],
  "prompts": []
}
```

这条在 `pi list` 里显示为 `npm:big-toolkit (filtered)`。没过滤需求的包写字符串形式即可,不会带这个标记。

#### 全局 vs 项目级叠加

同一个 package 可以同时出现在全局和项目 settings 里。项目条目覆盖全局条目;但如果项目条目设了 `autoload: false`,则作为 delta 叠加在全局条目之上(`packages.md:223`)。package 身份判定:npm 看包名、git 看 repo URL(不含 ref)、local 看绝对路径。

---

## 十二、参考

- 文档: `packages/coding-agent/docs/extensions.md`(2700+ 行)
- 示例: `packages/coding-agent/examples/extensions/`(60+ 个可运行例子)
- 源码入口: `packages/coding-agent/src/core/extensions/loader.ts` 的 `discoverAndLoadExtensions()`
- TUI 组件模式: `packages/coding-agent/docs/tui.md`
- Package 机制: `packages/coding-agent/docs/packages.md`
