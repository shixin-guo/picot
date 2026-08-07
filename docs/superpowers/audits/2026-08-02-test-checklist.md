# 测试清单 — 集成 UI 现代化（2026-08-02）

逐项核对。每项含：断什么、怎么跑、预期结果。

## 一、自动化单测（13 个文件，184 条）

```bash
# 一次性跑全部相关测试
bun run vitest run \
  public/ui/header-status-bar.test.js \
  public/file-type-icons.test.js \
  public/themes.test.js \
  extensions/embedded-server-session-stats.test.ts \
  public/icons.test.js \
  public/ui/resizable-panel.test.js \
  public/git-panel.test.js \
  public/file-preview-panel.test.js \
  public/file-browser.test.js \
  public/terminal-panel.test.js \
  public/ui/context-viz.test.js \
  public/compact-coordinator.test.js \
  public/app-startup.test.js
# 预期：184 passed
```

### 1.1 新增模块测试

- [ ] **`public/ui/header-status-bar.test.js`**（9 条）
  - 启动时空，暴露 `{applyLiveUsage, hydrateSessionStats, reset, sync}`
  - hydrate 同会话不累加（防双计）
  - live usage 仅在 hydrate 后累加
  - reset 清空聚合 + 当前上下文
  - 无确认身份的 live usage 被丢弃
  - `tokens:null` 归零（无 assistant 用量的会话）
  - 跨会话 live usage 被丢弃
  - 当前上下文阈值 60%/80%（warning/critical）可独立清除
  - 未知 contextWindow 不加阈值类

- [ ] **`public/file-type-icons.test.js`**（9 条）
  - 目录 open/closed + `.git`/`.github` 变体
  - 特殊文件名优先于扩展名（package.json/.gitignore/bun.lock/Dockerfile）
  - 源码扩展名映射（ts/js/py/rs/yaml/toml）
  - 未知名兜底 `file`
  - 三处消费者（browser/git/preview）结果一致
  - SVG 是 `aria-hidden` + `viewBox 0 0 20 20`
  - Material fill 保留（不强制 currentColor）
  - size 默认 16，可自定义
  - 无 Unicode emoji

- [ ] **`public/themes.test.js`**（7 条）
  - `applyTheme` 写 `data-theme`
  - 未知 id 回退 `night`
  - 无 API 时 origin 不报错
  - 无 `startViewTransition` → 同步调用
  - reduced-motion → 同步调用
  - 有 API → 写 CSS origin 变量 + 走 transition
  - 无 origin → 50%/50% 中心回退

- [ ] **`extensions/embedded-server-session-stats.test.ts`**（5 条）
  - 无 assistant usage → `hasAggregate:false`
  - 多 assistant 消息累加 input/output/cacheRead/cacheWrite/cost
  - user/assistant/toolResult 角色分别计数
  - 非 message 条目和无 usage 消息被忽略
  - toolResult/compaction 嵌套 usage 也累加（与 Pi 官方一致）

### 1.2 扩展的既有测试

- [ ] **`public/icons.test.js`**（5 条，新增 3 条）
  - [新] maximize/minimize/text-collapse 三个图标互异
  - [新] refresh-cw 静态无 spin/spinning 类
  - [新] 所有动作图标符合 24×24/currentColor/round cap/aria-hidden 契约

- [ ] **`public/ui/resizable-panel.test.js`**（8 条，新增 6 条）
  - 左 seam + 拖动 persist
  - stored width clamp
  - [新] storage 单次写（拖动中不写）
  - [新] pointercancel/lostpointercapture/blur/hidden teardown
  - [新] right seam 增长方向 + handle 定位
  - [新] invalid side 报错
  - [新] 键盘 Arrow/Shift+Arrow/Home/End + aria-valuenow
  - [新] 源码无 `setPointerCapture`/`releasePointerCapture`

- [ ] **`public/git-panel.test.js`**
  - 目录行渲染 SVG（不再是 `📂` emoji）

- [ ] **`public/file-preview-panel.test.js`**（51 条，回归）
  - 文件 tab 图标改 SVG，行为不变

- [ ] **`public/file-browser.test.js`**（37 条，回归）
  - 文件树行图标改 SVG，渲染不变

- [ ] **`public/terminal-panel.test.js`**（22 条，回归）
  - enlarge 按钮 maximize→minimize 切换，tab bar 不丢

- [ ] **`public/ui/context-viz.test.js`**（回归，Compact 不变量）
  - Compact 成功才清当前上下文

- [ ] **`public/compact-coordinator.test.js`**（回归）
  - ack≠完成，仅 success 完成

- [ ] **`public/app-startup.test.js`**（5 条，回归 + i18n 完整性）
  - 新增的 `usage.sessionUsageTitle`/`usage.summary` 在 en/zh 都有

## 二、关键不变量核对（5 条，逐条确认）

- [ ] **Compact 不破坏**：只有 `compaction_end(success:true)` 清当前上下文
  - 看 `public/app.js` `handleCompactionEnd`：`lastUsage=null` + `sync({currentUsage:null})`
  - 失败路径 early return，不清

- [ ] **无双计**：mirror sync 顺序 = reset → 渲染历史(只更 lastUsage) → hydrate(generation 校验)
  - 看 `public/app.js` `handleMirrorSync`：先 `resetHeaderStatusBar()`，末尾 `hydrateHeaderSessionStats()`
  - `renderSessionHistory` 不再累加聚合

- [ ] **聚合与 Pi 官方一致**：toolResult/compaction/branch_summary 各自累加
  - 对照 `pi/packages/coding-agent/src/core/usage-totals.ts:46`（Pi 官方同样累加这些）

- [ ] **图标语义隔离**：动作图标(`icons.js`) ≠ 对象图标(`file-type-icons.js`)
  - `grep createIcon public/file-type-icons.js` → 无
  - `grep createFileTypeIcon public/icons.js` → 无

- [ ] **resizer 无 pointer capture**
  - `grep -n "setPointerCapture\|releasePointerCapture" public/ui/resizable-panel.js` → 无

## 三、构建 / 静态检查（5 条）

- [ ] `bun run test` → **1488 passed, 5 skipped**
- [ ] `bun run check:rust` → **221 passed, 0 failed**
- [ ] `bun run check:design` → passed
- [ ] `bun run build:extensions` → 3 个 dist 产物生成
- [ ] `bunx biome check public/app.js extensions/embedded-server.ts --diagnostic-level=error` → clean

## 四、手动行为验证（建议，非阻塞）

- [ ] 切会话：聚合行 IN/OUT/CACHE 跟随更新，不残留上一会话
- [ ] Compact 成功：当前上下文 pill 清空，聚合行不变
- [ ] Compact 失败：当前上下文保留
- [ ] 主题切换：圆形 reveal 动画；系统开 reduced-motion 时无动画
- [ ] File sidebar / Super Agent 拖拽调宽：松手才 persist，pointercancel 不卡死
- [ ] Terminal enlarge：图标变 minimize，label 变「Restore panel」
- [ ] File Preview enlarge/restore：maximize/minimize 状态对
- [ ] Sidebar refresh：静态图标，pending 时 disabled + aria-busy，不旋转
- [ ] Git 面板：folder/file 行显示彩色 SVG，不再是 emoji
- [ ] 窄屏（<1100px）：聚合行隐藏，context/cost 保留
