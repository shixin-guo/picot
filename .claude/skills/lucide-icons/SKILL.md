---
name: lucide-icons
description: Use when adding a new icon to Picot's toolbar/sidebar/buttons, auditing existing icons against the latest Lucide release, or updating icon SVG path data in public/icons.js.
tags: [icons, lucide, ui, audit, svg]
---

# Picot 图标助手 (Lucide)

## 用途

Picot 的所有 UI 操作图标定义在 `public/icons.js`，SVG path data 来自
[Lucide Icons](https://lucide.dev)（ISC 许可）。Picot 无打包器（vanilla JS
ES Module + import map），图标以 `[tag, { attrs }]` 数组形式内联在
`ICONS` 对象中，由 `createIcon(name)` 在运行时构造 SVG 元素。

**本 skill 负责：**

1. **新增图标**：根据需求查询 Lucide，给出候选建议，确认后添加到 `ICONS`
2. **全面审计**：对比 `public/icons.js` 全部图标与 Lucide 最新版的 path data，
   列出差异并按需更新

**本 skill 不做：**

- 引入 `lucide` npm 包或打包步骤（Picot 架构不需要；手动同步即可）
- 修改 `createIcon` / `setButtonIcon` / `replaceButtonGlyph` 的 API
- 改动图标渲染 CSS（stroke-width、viewBox、currentColor 等约定）

## 关键约定

| 项目 | 约定 |
| --- | --- |
| 图标来源 | Lucide Icons (<https://lucide.dev)，ISC> 许可 |
| 当前同步版本 | 见 `public/icons.js` 文件头注释 |
| 文件 | `public/icons.js` — `ICONS` 对象，每个图标是 `[tag, { attrs }]` 数组 |
| API | `createIcon(name, { size, document, filled })` → SVG Element 或 null |
| SVG 约定 | `viewBox="0 0 24 24"`, `stroke="currentColor"`, `stroke-width=2`, `fill=none`（filled 模式除外） |
| 命名 | Picot 内部用 kebab-case（如 `folder-plus`）；与 Lucide 图标名一致 |
| 已知差异 | `refresh`→Lucide `refresh-cw`；`sliders`→Lucide `sliders-horizontal`；`wrap`→Lucide `pilcrow`；`bar-chart`→Lucide `chart-column` |
| 自定义图标 | `text-collapse` 是 Picot 自定义图标，Lucide 无对应，保留原样 |

## 流程 A：新增图标

### Step 1: 理解需求

明确要做什么动作的图标（如"导出"、"分享"、"排序"），以及放在哪个 UI 位置
（toolbar、sidebar、message toolbar 等），因为这会影响候选选择。

### Step 2: 查询 Lucide

使用以下方法查找候选图标：

```bash
# 方法 1: 通过 npm pack 获取最新 Lucide 包，离线搜索
npm pack lucide --pack-destination /tmp 2>/dev/null
tar xzf /tmp/lucide-*.tgz -C /tmp
# 搜索关键词
ls /tmp/package/dist/esm/icons/ | grep -i "export\|share\|sort"

# 方法 2: 查看候选图标的 path data
cat /tmp/package/dist/esm/icons/<icon-name>.mjs
``` <https://lucide.dev/icons> 在浏览器中按关键词搜索预览。

### Step 3: 给出建议

向项目负责人展示 2-3 个候选，说明：

- 图标名 + Lucide 链接
- 适用场景（如 `upload` 适合"导入文件"，`share` 适合"分享链接"）
- 在 16px / 14px 小尺寸下是否清晰（toolbar 图标通常 12-16px）

**等待确认后再修改代码。**

### Step 4: 添加图标

确认图标名后，在 `public/icons.js` 的 `ICONS` 对象中添加：

```javascript
"<icon-name>": [
  ["path", { d: "<从 Lucide .mjs 文件复制的 path data>" }],
  // ... 其他 path/circle/rect/line 元素
],
```

**格式规则：**

- 从 Lucide `.mjs` 文件中完整复制 `[tag, { attrs }]` 数组
- 保持引号风格一致（字符串值用双引号）
- 数值属性不加引号（`cx: 12` 而非 `cx: "12"`），除非 Lucide 源文件用了引号
  （Lucide v1 全部用字符串引号，保持与 Lucide 一致）

### Step 5: 更新版本注释

更新 `public/icons.js` 文件头注释中的同步版本号。

### Step 6: 验证

```bash
npx biome check public/icons.js
bun run vitest run public/icons.test.js
bun run check:design
```

## 流程 B：全面审计

### Step 1: 获取最新 Lucide 包

```bash
npm pack lucide --pack-destination /tmp 2>/dev/null
tar xzf /tmp/lucide-*.tgz -C /tmp
# 记录版本号
head -3 /tmp/package/dist/esm/icons/copy.mjs  # 查看版本
```

### Step 2: 提取 Picot 当前图标清单

```bash
# 用 node 提取所有图标名（包括 kebab-case 多词名称）
node -e "
const fs = require('fs');
const content = fs.readFileSync('public/icons.js', 'utf8');
const re = /^\s{2}(['\"]?)([a-z][a-z0-9-]*)\1\s*:\s*\[/gm;
let m, names = [];
while ((m = re.exec(content)) !== null) names.push(m[2]);
console.log('count:', names.length);
console.log(names.join(', '));
"
``` 逐图标对比

对每个 Picot 图标，找到对应的 Lucide 图标文件，对比 path data：

```bash
# 注意名称映射：
# refresh      → refresh-cw
# sliders      → sliders-horizontal
# wrap         → pilcrow
# bar-chart    → chart-column
# 其他名称通常一致
```

**对比方法**：提取双方的 `[tag, { attrs }]` 数组，比较：

- 元素数量（path/circle/rect/line）
- 每个 `d` 值 / `points` 值 / 坐标值

标记为三类：

- **MATCH**：path data 完全一致
- **DIFF**：Lucide 有更新（path data 不同）— 建议更新
- **NOT_FOUND**：Lucide 无此图标（如 `text-collapse` 自定义图标）— 保留原样

### Step 4: 报告差异

向项目负责人展示差异清单，格式：

```text
需要更新（N 个）:
  pin       — 自创简化版 → Lucide 标准图钉
  folder    — 旧版缺翻盖细节 → Lucide 含 tab 斜角
  settings  — 旧版齿轮粗糙 → Lucide 精确渐开线齿轮
  ...

已一致（M 个）:
  link, maximize, minimize, ...

Lucide 无对应（K 个，保留原样）:
  text-collapse — Picot 自定义图标

Lucide 名称已变更（需要映射）:
  refresh    → refresh-cw（双向弧线标准刷新）
  bar-chart  → chart-column（v1 重命名）
```

**等待确认后再修改代码。**

### Step 5: 批量更新

确认后，用 Lucide 最新 path data 替换 `public/icons.js` 中对应的图标定义。

**注意**：

- 保持 Picot 的内部图标名不变（如仍叫 `refresh`，但 path data 用 Lucide 的 `refresh-cw`）
- 对于 Lucide 重命名的图标，Picot 侧可以保持旧名（别名），也可以添加新名

### Step 6: 更新版本注释

更新文件头注释，例如：

```javascript
// ABOUTME: Path data synced from lucide v1.31.0
```

### Step 7: 更新测试

检查 `public/icons.test.js` 和其他测试文件中是否有硬编码 path data 的断言
（搜索 `getAttribute("d")` 和 `querySelectorAll("path").length`）。
如果测试锁定了旧 path data，更新为新值。

**测试应该验证的是 SVG 契约（viewBox、stroke、aria-hidden）而非具体 path data。**
如果某个测试只为了锁定"图标没被意外替换"，改为断言图标名存在 + 元素数量合理，
而不是断言完整 path data。

### Step 8: 验证

```bash
npx biome check public/icons.js public/icons.test.js
bun run test
bun run check:design
```

## 注意事项

- **不要引入 npm 依赖**：Picot 是 vanilla JS，不需要 `lucide` npm 包，手动同步
  path data 即可。引入包需要打包步骤（esbuild），增加构建复杂度，而 55 个图标
  的手动维护成本很低。
- **不要修改 createIcon API**：`createIcon` / `setButtonIcon` / `replaceButtonGlyph`
  的签名和行为是稳定的公共接口，调用方遍布全项目。
- **filled 模式**：部分图标支持 `filled: true`（如 `eye`），此时 `fill=currentColor`、
  `stroke=none`。Lucide 的 filled 变体是单独的图标（如 `eye-off`），不是参数。
- **大小**：toolbar 图标通常 12-16px；确保候选图标在小尺寸下笔画清晰，避免过于
  复杂的图标（如 `brain` 在 12px 下较密集）。
- **license**：Lucide 是 ISC 许可，与 Picot 兼容。文件头注释已标注来源。
