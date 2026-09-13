# ADR 0003: 全局显示偏好的存储边界与用量缓存契约

- 状态：Accepted
- 日期：2026-09-12
- 关联：features-v3 `778625b`（Appearance）、`49211f6`（Usage perf）、`bbd52f3`（scoped models）；实现 `src-tauri/src/metadata_store.rs`、`src-tauri/src/host_server.rs`、`src-tauri/src/host_data.rs`、`public/native/transport/preference-gateway.js`、`public/native/settings/appearance-*.js`、`public/native/composer/model-selection.js`、`extensions/picot-config.ts`

## 背景

各 workspace 窗口运行在不同端口上，per-origin 的 localStorage 偏好互不同步；v3 在 Appearance 页引入了"cookie 首屏缓存 + 持久真相"双轨制。new-arch 分支的持久层是 host 侧 MetadataStore（SQLite），WebView 与 host 之间没有偏好读写通道。同时，Usage 面板每次打开都全量重解析全部 session JSONL；Composer 的常用模型没有持久化分组。

## 决策

1. **偏好传输边界**：MetadataStore 的 `preferences` 表（key/value_json）是全局显示偏好的唯一持久真相。WebView 只能通过已认证的 `host_request` 帧（`get_preference` / `set_preference` / `remove_preference`）访问，**键前缀白名单限定 `ui.*`**；非法键返回结构化错误。tests/无 metadata 的构造保持 `None`，操作降级为 host 错误，构造函数保持 infallible。
2. **双轨同步契约**：`picot-appearance` cookie 是同步首屏缓存（inline bootstrap 在样式表加载前写 CSS 变量，防首帧闪烁）；host DB 是真相。Appearance 页激活时 reconcile——已有 DB 值覆盖 cookie，缺失的 DB 键从 cookie 播种。偏好写失败只降级本地应用，绝不阻塞 UI。
3. **终端偏好的应用边界**：Appearance 模块不触碰终端 DOM；全部通过注入的 `terminal.applyPreferences(patch)` 应用到现有与未来的 xterm tab。旧 per-origin `picot.terminal.preferences` 载荷一次性迁移进 cookie 后删除。
4. **用量缓存失效键**：session 文件 append-only，解析结果以 `(canonical path, mtime, byte length)` 为失效键缓存于 `HostDataPlane`。锁只在候选切分与回填时持有，绝不跨 worker 线程；miss 按体积降序分块并行解析（≤8 workers）。v2 `cost_dashboard` 载荷形状不变。host 启动时在后台线程预热（`!cfg!(test)` 守卫，避免测试套件被全量扫描拖慢）。
5. **Composer 常用模型所有权**：星标分组的数据源是 Pi 全局 `settings.json` 的 `enabledModels`（`list_scoped_models` / `set_scoped_model`，provider/model 身份匹配，持久化的 thinking-level 后缀保留）。Models 页的可见性过滤仍然先行——隐藏/不可用的星标永不渲染。桥接不可用时下拉框降级为无分组列表。
6. **macOS 输入行为**：原生菜单栏是按键连发修复的承重面（WKWebView responder chain）；`ApplePressAndHoldEnabled=false` 写入 Picot 自己的 defaults 域（不触碰系统全局），在首个 WebView 创建 NSTextInputContext 之前执行，仅 macOS 编译。

## 后果

- WebView 侧持久状态写入口径收窄为 `ui.*` 前缀；未来新增偏好命名空间需显式扩展白名单并评审边界。
- 偏好改动即时本地生效、DB 异步收敛——跨窗口一致性依赖下一次 reconcile（打开 Appearance 页）。
- 用量缓存的正确性依赖 session 文件 append-only 假设；外部工具截断/重写 session 文件时以 `(mtime, len)` 失效兜底。
- `enabledModels` 同时服务 Pi 运行时与 Composer 收藏分组；语义为"身份引用列表"，UI 不得向其中写入运行时才有的后缀。
