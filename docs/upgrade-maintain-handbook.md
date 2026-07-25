# Picot 升级与维护手册

面向本机（Windows 为主）与源码工作区的运维说明：安装布局、官方升级、开发构建、**安装目录外科补丁**、嵌入式 pi 版本、回滚与排障。

相关文档：

- 双语 UI：[`docs/i18n-handbook.md`](./i18n-handbook.md)
- 产品/架构约束：根目录 `AGENTS.md`
- 用户安装说明：`README.md` / `README.zh.md`
- 自动更新签名（若上游已提供）：`docs/AUTO_UPDATER.md`（可能尚未同步到本 fork 工作区）

---

## 1. 两套树：源码 ≠ 已安装

| 角色 | 典型路径 | 何时使用 |
|------|----------|----------|
| **源码 / 开发** | `…/PICOT/src/picot` | `bun run dev`、改代码、跑 vitest、commit |
| **已安装发布版** | `%LOCALAPPDATA%\Picot\` | 日常双击 `picot.exe` 使用 |

本机安装树（实测）：

```
%LOCALAPPDATA%\Picot\
  picot.exe
  uninstall.exe
  public\          ← 静态前端（WebView 实际加载这里）
  extensions\      ← 嵌入扩展（如 embedded-server）
  pi\              ← 捆绑的 pi 运行时
```

源码侧对应：

```
src/picot/
  public\
  extensions\
  scripts\         ← fetch-pi、install、release、check-*
  src-tauri\       ← Rust / Tauri
  scripts/pi-version.json   ← 嵌入 pi 版本钉
```

**铁律：** 改 `src/picot/public` **不会**自动出现在已安装 Picot 里。要么：

1. `bun run dev`（debug 优先 workspace `public`），或  
2. 完整 `bun run build` / 官方安装包升级，或  
3. 对安装树做 **外科同步**（见 §5）。

---

## 2. `static_dir` 如何解析

Rust：`src-tauri/src/main.rs` → `resolve_static_dir` / `find_static_dir`。

| 构建 | 优先顺序 |
|------|----------|
| **debug**（`tauri dev`） | 1) workspace `public`（相对 `CARGO_MANIFEST_DIR/../public`） 2) cwd `public` |
| **release**（安装包 / `tauri build`） | 1) resource dir 下 `public` 2) 回退 `resource/public` 或字面 `public` |

运行日志里可看到类似：

```text
static_dir=C:\Users\…\AppData\Local\Picot\public
```

spawn pi 时还会设 `PI_STUDIO_STATIC_DIR`，扩展与静态资源与该目录兄弟关系相关（`pi/`、`extensions/` 与 `public/` 同级）。

**维护含义：** 验证 UI 前先确认当前进程的 `static_dir`，避免“源码已改、安装版仍旧”的假阴性。

---

## 3. 官方安装与版本升级（终端用户）

### 3.1 一键安装 / 重装（推荐）

**Windows（PowerShell）：**

```powershell
irm https://raw.githubusercontent.com/shixin-guo/picot/main/scripts/install.ps1 | iex
```

固定版本：

```powershell
& ([scriptblock]::Create((irm 'https://raw.githubusercontent.com/shixin-guo/picot/main/scripts/install.ps1'))) -Version v0.3.0
```

企业 MSI：

```powershell
& ([scriptblock]::Create((irm '…/install.ps1'))) -MSI -Version v0.3.0
```

脚本会拉 GitHub Release 的 NSIS `Picot_<ver>_<arch>-setup.exe`（或 MSI），静默安装。

**macOS / Linux：** 用 `scripts/install.sh`（见 README）。

### 3.2 应用内自动更新

- UI：Settings → General → Updates（`public/app/updater.js` + Tauri updater plugin）
- 依赖发布侧签名密钥与 `latest.json` 流水线（见上游 `docs/AUTO_UPDATER.md` / CI secrets）
- 仅 **Tauri 桌面壳** 有效；纯浏览器打开 `public` 不会走该路径

### 3.3 升级后建议

1. **完全退出** Picot（托盘/后台进程一并结束）再启动。  
2. 确认版本：关于页 / 包版本 / 日志。  
3. 打开一工作区，确认会话列表能加载（排除 ES module 断裂）。  
4. 若刚做过手工 `public` 补丁：官方安装包可能 **覆盖** 你的补丁；需要的话从源码再同步一次，或把补丁合入正式 release。

---

## 4. 开发者：从源码构建与日常维护

### 4.1 环境

- **包管理只用 Bun**（`AGENTS.md`）：`bun install --frozen-lockfile`  
  不要用 `npm install` 以免生成 `package-lock.json` 与 `bun.lock` 漂移。  
- Rust / cargo 在 PATH（`~/.cargo/bin` 或 Windows 等价路径）。  
- 嵌入 pi：由 `bun run fetch:pi` 按 `scripts/pi-version.json` 下载，**不**依赖用户 PATH 上的全局 `pi`。

### 4.2 常用命令

```bash
cd src/picot   # 本工作区布局

bun install --frozen-lockfile
bun run dev              # fetch pi + tauri dev（热更，static_dir 偏 workspace public）
bun run build            # prebuild: fetch pi + build extensions → tauri build
bun run fetch:pi         # 仅刷新嵌入 pi
bun run test             # vitest + tauri permissions check
bun run check            # biome + design CSS
bun run check:rust       # cargo check / clippy / fmt（改 src-tauri 后）
bun run check:permissions
```

i18n 字典：

```bash
node scripts/check-i18n-parity.mjs
```

### 4.3 嵌入式 pi 版本升级

1. 编辑 `scripts/pi-version.json` 的 `version`（可加 per-asset `sha256`）。  
2. `bun run fetch:pi`  
3. `bun run smoke:pi-rpc`（及/或 `scripts/smoke-extensions.js`）  
4. `bun run dev` 手测核心会话  
5. Commit `pi-version.json` + 若脚本有锁文件变更则一并审查  

UI 显示的 pi 版本来自 spawn 时的 `PI_STUDIO_PI_VERSION`，与用户全局 `pi` **无关**。

### 4.4 发版（维护者）

- `bash scripts/release.sh <version>`：校验干净工作区、改 `package.json` / `tauri.conf.json` / `Cargo.toml` 版本、打 tag 等（以脚本为准）。  
- GitHub Actions 构建多平台产物；Windows 用户再走 `install.ps1` 或应用内 updater。  
- 本 fork 工作区路径是 `PICOT/src/picot`，发版前确认 remote/branch 策略，避免把本地实验分支当 upstream main。

### 4.5 与「系统 pi / pi-node」的边界

| 组件 | 用途 | 升级方式 |
|------|------|----------|
| **Picot 捆绑 pi** | 应用内 agent | `pi-version.json` + `fetch:pi` / 安装包 |
| **本机 pi-node**（`%LOCALAPPDATA%\pi-node\current`） | 终端 `pi` CLI / 扩展生态 | 见 KB：`pi update` 在 pi-node 布局上常失败，应对该树 `npm install @earendil-works/pi-coding-agent@…` 并必要时恢复 bundled `npm` |

两者 **不要混为一谈**。改 Picot 不要求升级系统 pi；升级系统 pi 也不会自动改 Picot 内嵌二进制。

---

## 5. 安装目录外科补丁（热修 UI）

适用：release 已装好，只需热修 `public/**`（i18n、文案、小前端 bug），暂不重打安装包。

### 5.1 禁止事项

| 禁止 | 原因 |
|------|------|
| 无校验地用源码 **整文件覆盖** 安装版 `app.js` | 源码 `app.js` 可能 `import` 安装树没有的模块（例：`./super-agent/dispatch.js`）→ ES module 加载失败 → 侧栏卡在 “Loading sessions…” |
| 只改源码不碰安装树却期望双击 `picot.exe` 生效 | release `static_dir` 指向安装 `public` |
| 只刷新 WebView 不杀进程 | 部分资源/扩展路径在进程生命周期内缓存 |

### 5.2 推荐流程

1. **完全退出** Picot。  
2. **备份**（时间戳目录）：

```powershell
$dst  = "$env:LOCALAPPDATA\Picot\public"
$bak  = Join-Path $dst ("_backup_{0}" -f (Get-Date -Format "yyyyMMdd_HHmmss"))
New-Item -ItemType Directory -Path $bak | Out-Null
# 只备份即将覆盖的文件，或整棵 public（体积更大）
```

3. **按文件列表复制**（示例：Packet 4 一类 UI 补丁）：

```text
app.js
i18n/index.js, en.js, zh.js
components/sa-chat-header.js
components/super-agent-entry.js
components/super-agent-runtime.js
packages/install-status.js
session/onboarding.js
sidebar/index.js
ui/dialogs.js
# 按实际 diff 增减；相关 CSS/HTML 一并纳入
```

源根：`…/PICOT/src/picot/public`  
目标：`%LOCALAPPDATA%\Picot\public`

4. **校验安装版 `app.js` 的相对 import 在安装树内都存在**（概念脚本）：

```js
// node --input-type=module
import fs from "fs";
import path from "path";
const install = process.env.LOCALAPPDATA + "/Picot/public";
const app = fs.readFileSync(path.join(install, "app.js"), "utf8");
const re = /from\s+['"](\.\/?[^'"]+)['"]/g;
let m, missing = [];
while ((m = re.exec(app))) {
  const abs = path.normalize(path.join(install, m[1]));
  if (!fs.existsSync(abs)) missing.push(m[1]);
}
console.log(missing.length ? "IMPORTS_MISSING " + missing : "ALL_IMPORTS_OK");
```

若 `IMPORTS_MISSING`：要么把缺失模块一并拷入安装树，要么 **撤回** 对 `app.js` 的整文件覆盖，改为对安装版 `app.js` 做最小 diff 补丁。

5. 若改了 i18n 字典：确认 en/zh key 数量一致（可对安装树跑 `check-i18n-parity.mjs` 或对比 key 集合）。  
6. **完整启动** Picot，手测关键路径。  
7. 记录备份目录名与同步文件列表（便于 handbook / KB）。

### 5.3 本机已有备份（参考）

| 备份目录 | 含义 |
|----------|------|
| `public/_backup_packet1_*` | 早期 Packet 1 补丁前 |
| `public/_backup_packet123_*` | Packet 1–3 同步前 |
| `public/_backup_packet4_20260725_122440` | Packet 4 同步前 |

回滚示例：

```powershell
$src = "$env:LOCALAPPDATA\Picot\public\_backup_packet4_20260725_122440"
$dst = "$env:LOCALAPPDATA\Picot\public"
Copy-Item -Recurse -Force "$src\*" $dst
# 然后完整重启 Picot
```

### 5.4 何时必须重打安装包 / 走官方升级

- 改了 `src-tauri`（Rust）、捆绑 `pi` 二进制、extensions 构建产物、权限/capabilities  
- `app.js` 与安装树模块图差异过大，外科补丁成本高于重装  
- 需要签名自动更新通道触达其他机器  

---

## 6. 验证清单

### 6.1 安装版冒烟

- [ ] 进程能启动，窗口非白屏  
- [ ] 日志 / 行为显示 `static_dir` 为安装 `public`（release）  
- [ ] Open Folder → 会话列表加载（非永久 “Loading sessions…”）  
- [ ] 发一条消息，agent 有响应（嵌入 pi 可用）  
- [ ] Settings 可打开；若做了 i18n：Appearance 语言切换有效  
- [ ] Super Agent / packages 等改动面按需点验  

### 6.2 源码改动后

- [ ] `bun run test` 或至少相关 vitest 文件  
- [ ] 前端：`node scripts/check-i18n-parity.mjs`（若动字典）  
- [ ] Rust：`bun run check:rust`（若动 `src-tauri`）  
- [ ] 需要给安装版用时：走 §5 同步 + 重启，**不要**假设 dev 路径等于 release 路径  

### 6.3 升级嵌入 pi 后

- [ ] `fetch:pi` 成功，二进制落在资源期望路径  
- [ ] smoke RPC / 扩展脚本  
- [ ] UI 中 pi 版本字符串与 `pi-version.json` 一致  

---

## 7. 常见故障

| 现象 | 可能原因 | 处理 |
|------|----------|------|
| 侧栏一直 Loading sessions… | `app.js` import 指向安装树不存在的模块 | 恢复备份；补齐模块或最小补丁；`ALL_IMPORTS_OK` |
| 源码改了 UI，安装版无变化 | release 读安装 `public` | 同步或 `tauri dev` |
| 语言切换无按钮 / 仍全英文 | 安装 `index.html`/`app.js` 未同步 i18n | 见 `i18n-handbook.md` + §5 |
| 升级安装包后手工补丁消失 | 安装程序覆盖 `public` | 从源码再同步或合入正式版 |
| `pi update` 对系统 CLI 失败 | pi-node 布局不支持 self-update | 更新 `%LOCALAPPDATA%\pi-node\current`，与 Picot 捆绑 pi 分开 |
| WebView 仍像旧资源 | 未杀尽进程 / 强缓存 | 完全退出后启动；必要时清 WebView 缓存（少见） |
| bun / npm 混用锁文件 | 违反 AGENTS | 只用 bun；删掉误生成的 `package-lock.json` |

---

## 8. 维护节奏建议

| 频率 | 动作 |
|------|------|
| 每次 UI 热修上安装版 | 备份 → 外科复制 → import 校验 → 全量重启 → 记备份名 |
| 每次合并前端 i18n | parity 脚本 + 相关 vitest；更新 `i18n-handbook` 状态表如需要 |
| 嵌入 pi 安全/功能升级 | 改 `pi-version.json` → fetch → smoke → 发版或本地 build |
| 跟上游 picot release | 读 release notes；官方 install 或 in-app updater；再评估是否重做本地 public 补丁 |
| 季度 | 清理过旧 `_backup_*`（保留最近 1–2 个可回滚点） |

---

## 9. 本工作区速查

| 项 | 值 |
|----|-----|
| 源码根 | `D:/Program_and_website_development/PI-AGENT/PICOT/src/picot` |
| 安装根 | `C:\Users\Administrator\AppData\Local\Picot` |
| 当前 i18n 分支（示例） | `feature/i18n-bilingual` |
| i18n 手册 | `docs/i18n-handbook.md` |
| 包管理 | Bun only |
| 嵌入 pi 钉 | `scripts/pi-version.json` |

---

## 10. 变更记录

| 日期 | 说明 |
|------|------|
| 2026-07-25 | 初版：安装布局、static_dir、官方升级、外科同步、pi 边界、故障与清单；吸收 Packet 1–4 安装踩坑 |
