# Picot 公司专属 Extension 门禁设计

> **日期**: 2026-07-12
> **状态**: 设计草案，待评审
> **范围**: 通过 GitLab + Pi extension 机制，向公司内部员工分发/使用公司专属的
> skills / prompts / extensions（知识产权），并在员工离职后阻断其继续获取。

---

## 1. 目标

把公司 self-host GitLab 上托管的 Pi extension（含 skills / prompts / themes）
集成进 Picot 的 Extension 管理界面；同时建立一套基于 GitLab 账户的门禁，使得：

- **在职员工**：配置一次 GitLab PAT 即可浏览并一键安装公司专属 extension。
- **离职员工**：IT 封禁其 GitLab 账户后，下次启动 Picot 即被锁定，无法再安装
  或更新公司 extension。

整套方案复用公司已有的 GitLab 作为身份与权限后端，**不引入额外的鉴权服务**。

## 2. 已确认的产品决策

经 brainstorming 确认的五项核心决策：

1. **威胁模型 = 档1（"断正常流程即可"）**。门禁目标是阻断离职员工的**正常使用
   流程**（打不开 Picot、装不了公司 extension）。**会** patch JS、直接跑内嵌 pi
   二进制、或搬运 `~/.pi/` 目录的技术型离职员工**不在威胁模型内**。
2. **作用域 = B（全应用锁定）**。账户失效时锁定**整个 Picot**，而非仅锁定公司
   extension 的安装。Picot 在公司内为统一配发的专属工具，不承载个人/社区用途。
3. **账户钥匙 = GitLab PAT**，一个 PAT 同时承担两项职责：启动验活（调
   `/api/v4/user`）与安装 extension 时的 git clone 凭证。员工只配置一次。
4. **目录来源 = GitLab manifest 仓库**。建一个仓库（如
   `picot/company-extension-manifest`）存放 `manifest.json`，Picot 用 PAT 拉取
   并渲染浏览 UI。新增/下架 extension 只需编辑该仓库，不必重发 Picot。
5. **离线策略 = 每次启动验活 + 7 天宽限**。在线时每次启动都验活（封号次日生效）；
   断网时回退"上次成功验活"的时间戳，7 天内放行，超过 7 天锁定。

## 3. 威胁模型与已接受的边界

本设计**不**承诺对抗一个有技术能力、且物理上持有二进制和源码的离职员工。明确
接受的边界：

| 威胁 | 是否防范 | 说明 |
|---|---|---|
| 离职后**新装**公司 extension | ✅ | PAT 失效，clone 与验活都 401 |
| 离职后**更新**已装 extension | ✅ | `pi update` 的 `git fetch` 同样 401 |
| 离职后**打开 Picot** | ✅（对正常员工）| 启动验活 401 → 全应用锁定 |
| **已装到** `~/.pi/agent/git/...` 的副本 | ❌ | clone 后永远在磁盘上，pi 每次启动照常加载 |
| 在职期间**早已拿到**的源码 | ❌ | extension 是明文 TypeScript，装即获得 |
| **patch Picot 的 JS** 绕过登录 | ❌ | `public/*.js` 是磁盘明文资源（见下） |
| **直接跑内嵌 pi** 二进制 | ❌ | `<App>/Contents/Resources/pi/pi` 可脱离 Picot 运行 |

> **技术前提澄清**：Picot 的前端 `public/` 同时作为**磁盘资源**打包
> （`tauri.conf.json` 的 `bundle.resources: { "../public": "public" }`），
> 落在 `Contents/Resources/public/*.js`（macOS）与 `<exe>.resources/public/*.js`
>（Windows）。embedded-server 从该磁盘副本 serve。因此**两个平台**都可用记事本
> 改 `app.js`、删登录检查。所谓"Windows .exe 难 patch"对本设计不成立。档1 仍
> 成立，因为档1 本就接受技术绕过——只是不能把信心建立在"打包=保护"上。

## 4. 硬性前提

下列三项是方案成立的运营/配置前提，必须在部署前落实，并写进公司 IT 离职 SOP：

1. **离职流程必须用 GitLab Block（封禁），不能用 Deactivate（停用）。**
   - **Block** → PAT 立即自动吊销，下次 API 调用返回 401。
   - **Deactivate** → PAT **不**吊销，Picot 门禁完全失效（停用是软状态，重新登录
     还会复活）。
   - 来源：GitLab 官方文档 `personal_access_tokens` + `moderate_users`。
2. **manifest 仓库**（`picot/company-extension-manifest`）必须对全体员工 PAT 只读
   可见；**各公司 extension 仓库**的可见性由仓库级权限各自管控。
3. **PAT 必须带 `read_api` + `read_repository` 两个 scope**（前者用于验活和拉
   manifest，后者用于 clone extension 仓库）。

## 5. 架构

### 5.1 构建/分发模型：公司专属构建（feature flag）

引入一个**构建配置**（环境变量 `PICOT_INTERNAL=1` + 一份 `company-config.json`
资源文件），把公司信息烤进包并启用门禁相关代码：

```json
// company-config.json（打进 resources/，不入公开构建）
{
  "gitlab_url": "https://gitlab.company.com",
  "manifest_project": "picot/company-extension-manifest",
  "manifest_file": "manifest.json",
  "manifest_ref": "main",
  "grace_days": 7
}
```

- **公司构建**：含门禁、公司 tab、Company Account 设置项；`company-config.json`
  打进资源；启动时走 §5.4 的门禁流程。
- **公开构建**：**不含**门禁与公司相关代码；行为与现状完全一致。公开 Picot 不
  知道公司 GitLab 地址，也不带锁定逻辑。

代码上用编译期条件（Rust `#[cfg(feature="internal")]` + 前端构建时 tree-shake
掉公司模块）隔离，避免公开包里出现门禁入口。`bun run build` 增加一个
`build:internal` 变体。

### 5.2 秘密边界：PAT 只在 Rust 层

**核心不变量：PAT 是秘密，只有 Rust 层接触其明文；前端永远只看到"账户状态"。**

- PAT 存储：OS keychain（macOS Keychain / Windows Credential Manager），key 用
  Picot 的 app 标识。不写明文文件。（实现前需确认 Picot 现有可复用的 secret 存储
  插件；优先 `tauri-plugin-stronghold` 或系统 keyring；见 §10 开放问题。）
- 账户状态文件 `~/.pi/agent/picot-account-state.json`，**只存** `{ last_valid_at,
  gitlab_username, gitlab_user_id }`，**不含 PAT**。
- 前端通过 broker_control 命令间接操作（`get_account_status` /
  `set_company_pat` / `validate_company_account` / `install_company_extension` /
  `fetch_company_manifest`），返回值不含 PAT 明文。

这与 ARCHITECTURE.md 的现有不变量一致（"Rust 不重新实现 pi；Rust 管进程与秘密"），
并把秘密约束在受信任的编译层。即使前端明文 JS 被 patch，也拿不到 PAT。

### 5.3 组件分工

| 组件 | 职责 | 位置 |
|---|---|---|
| PAT 存储 | keychain 读写 | Rust 新增 `company-account` 模块 |
| 启动验活 | PAT 调 `<gitlab>/api/v4/user`，reqwest + `.no_proxy()` | Rust `validate_company_account()` |
| 账户状态文件 | `last_valid_at` 等读写 | Rust |
| 安装公司 extension | 注入 git 凭证后调 `run_pi_command(["install", src])` | Rust 扩展现有 `install_package_source` |
| 拉 manifest | PAT 调 GitLab raw API 取 `manifest.json` | Rust `fetch_company_manifest()` |
| 前端：Company Account 设置 | 显示状态、触发验活、重输 PAT | `public/company-account.js` |
| 前端：Company Extensions tab | 由 manifest 渲染浏览列表 | `public/company-extensions-tab.js` |
| 前端：锁定/设置窗口 | 账户未配或失效时的兜底窗口 | `public/locked-window.js`（复用 bootstrap 模式） |

### 5.4 启动门禁流程（流 A）

现有启动序列（`main.rs::setup`）：解析 resume → `next_port` → `spawn pi` →
`register_session` → `wait_for_health` → `open_workspace_window`。
门禁插在最前面，**仅在 internal 构建启用**：

```
setup()
  └─ internal 构建且门禁启用？
       ├─ 否 → 走原有启动序列（公开 Picot 行为不变）
       └─ 是 → validate_company_account()
              ├─ PAT 未配置           → 开「账户设置/锁定」窗口（不开 workspace）
              ├─ 在线 /api/v4/user 200 → 更新 last_valid_at → 正常启动
              ├─ 在线 401/403          → 开锁定窗口
              └─ 断网
                  ├─ last_valid_at ≤ grace_days → 正常启动 + 后台择机重试验活
                  └─ last_valid_at > grace_days  → 开锁定窗口
```

锁定/设置窗口复用现有 `bootstrap` 窗口模式（`open_bootstrap_window`，原本用于
spawn 失败兜底）。锁定窗口内容为："公司账户已失效或令牌过期。重新输入 PAT；
若已离职请联系 IT。" 并提供一个 PAT 输入框 + "验证" 按钮（用于令牌轮换场景）。

### 5.5 账户状态机

| 状态 | 触发 | 表现 |
|---|---|---|
| `unconfigured` | 首次运行，无 PAT | 显示设置窗口，引导输入 PAT |
| `valid` | 最近一次 `/api/v4/user` 返回 200 | 正常启动 |
| `offline_grace` | 当前断网，但 `last_valid_at` ≤ grace_days | 正常启动；后台周期重试验活 |
| `expired_grace` | 当前断网，`last_valid_at` > grace_days | 锁定窗口 |
| `revoked` | `/api/v4/user` 返回 401/403 | 锁定窗口 |

注意：`revoked` 与 PAT **过期**（GitLab PAT 有有效期）在 API 层面都返回 401，
无法可靠区分。锁定窗口文案必须同时覆盖两种情况："账户已失效**或**令牌过期"，
让用户重输 PAT（若是离职则重输也会失败，自然停在锁定窗口）。

### 5.6 安装公司 extension（流 B）

```
前端「Company」tab（经 Rust 拉 manifest 渲染）
  └─ 点「安装」→ transport.control("install_company_extension", { source })
       └─ Rust broker_control handler
            ├─ 校验账户当前有效（last_valid_at 在宽限窗口内）
            ├─ 设置 git 凭证环境（见 §5.8）
            └─ run_pi_command(["install", source])   ← 复用现有逻辑
                 └─ pi 内部 git clone → 拿到 PAT → 成功
```

`source` 形如 `git:gitlab.company.com/team/my-ext` 或带 ref 的
`git:gitlab.company.com/team/my-ext@v1.2.0`。manifest 可为每个 extension 声明是否
pinned 到某个 ref；不 pin 则跟踪默认分支（`pi update --extensions` 拉最新）。

安装作用域：**全局**（`~/.pi/agent/git/<host>/<path>/`），使公司 extension 在所有
workspace 可用。这通过 `pi install`（不带 `-l`）默认即全局达成，无需额外处理。

### 5.7 manifest 仓库格式与拉取

manifest 仓库（`picot/company-extension-manifest`）根目录的 `manifest.json`：

```json
{
  "version": 1,
  "extensions": [
    {
      "source": "git:gitlab.company.com/skills/code-reviewer@v1.2.0",
      "name": "Code Reviewer",
      "description": "公司代码评审 skill，对接内部 lint 规范",
      "type": "skill",
      "pinned_ref": "v1.2.0"
    },
    {
      "source": "git:gitlab.company.com/prompts/release-notes",
      "name": "Release Notes",
      "description": "按公司模板生成发版说明",
      "type": "prompt"
    }
  ]
}
```

Picot **不 clone 整个 manifest 仓库**，而是用 PAT 调 GitLab raw API 取单个文件：

```
GET <gitlab>/api/v4/projects/<manifest_project URL-encoded>/repository/files/manifest.json/raw?ref=main
Authorization: Bearer <PAT>
```

单次 GET，返回 JSON 直接解析。`type` 字段（`extension`/`skill`/`prompt`/`theme`）
复用社区 tab 的过滤 pill UI。manifest 本身在 PAT 保护下——离职员工连目录都看不到，
IP 保护逻辑自洽。

### 5.8 git 凭证注入：用 `GIT_ASKPASS`，不把 PAT 塞进 URL

`pi install` 内部 spawn 原生 `git clone`，且设了 `GIT_TERMINAL_PROMPT=0`（不弹交互
prompt）。要让 clone 拿到 PAT，有几种方式；**选 `GIT_ASKPASS`**：

| 方式 | 是否落盘 | 选择 |
|---|---|---|
| URL 内嵌 token（`https://oauth2:<PAT>@host/...`）| ❌ PAT 写进 clone 的 `.git/config`，永久明文 | 不选 |
| 临时 git credential helper | 不落盘（helper 进程内存）| 备选 |
| **`GIT_ASKPASS=<helper script>`** | **不落盘** | **选** |
| 全局 credential helper（store/osxkeychain）| 视 helper 而定 | 不选（污染全局 git 配置）|

实现：Rust 在调 `run_pi_command(["install", src])` 前，写一个**一次性临时脚本**
（`ASKPASS` 程序），该脚本被 git 调用时对 `<company gitlab host>` 的用户名/密码
请求输出 `oauth2` / `<PAT>`；把 `GIT_ASKPASS` 与 `GIT_TERMINAL_PROMPT=0` 作为子进程
环境变量传入 `Command`。脚本在命令结束后删除。PAT 只在该短生命周期进程的内存中，
不进 git 仓库的 `.git/config`。

> 这是对 §3 威胁模型的额外卫生：档1 接受"已装副本防不住"，但没必要让 PAT 在每个
> extension clone 的 `.git/config` 里留 N 份明文。

### 5.9 PAT 存储细节

- macOS：Keychain（service=`works.earendil.picot`，account=`company-pat`）。
- Windows：Credential Manager（同 key）。
- 通过 Tauri 插件或 Rust keyring crate 访问；首次写入需在主线程/keychain 授权下进行。
- 绝不回显：前端"Company Account"页只显示 PAT 的存在性（`configured: true`）与
  `last_valid_at`，不回显 PAT 内容；重置走"清除并重新输入"。

## 6. UI 面（3 处新增）

全部新文本走 `t()`（AGENTS.md i18n 硬性要求），新 key 加进 `public/locales/en.json`
与 `zh.json`。每个新模块一个文件、一个职责，不内联进 `app.js`。

### 6.1 Settings → 新增导航项「Company Account」

- GitLab URL（公司构建里只读预填）。
- PAT 输入框（type=password，写入后不回显，只显示"已配置"）。
- 「Test & validate」按钮：触发 `validate_company_account`，显示结果徽章
  （valid / revoked / offline_grace(剩余天数) / expired_grace）。
- 上次验活时间。

### 6.2 Settings → Extensions 面板 → 新增「Company」页签

与现有「Browse Community Packages」并列。由 `fetch_company_manifest`（经 Rust）
返回的列表渲染，复用社区 tab 的卡片/过滤/分页样式。装/卸载走流 B；卸载复用现有
`remove_pi_package`（无需凭证）。

### 6.3 锁定/设置窗口

复用 `bootstrap` 窗口模式。账户 `unconfigured` / `revoked` / `expired_grace` 时
显示，拦在 workspace 窗口之前。内容：状态说明 + PAT 输入 + 验证按钮 + "联系 IT"
提示。仅 internal 构建存在。

## 7. 错误处理与边界场景

- **PAT 过期**（GitLab PAT 有 expiry）：`/api/v4/user` 返回 401，与被封禁不可区分。
  锁定窗口文案覆盖两种情况；用户重输新 PAT 即恢复。
- **首次运行无 PAT**：状态 `unconfigured` → 显示设置窗口，引导输入。不锁定（因为
  还没配过），但也不放行 workspace。
- **GitLab 短暂不可达**：算作"断网"，走 `offline_grace`（7 天内放行）。
- **PAT 权限不足**（缺 scope）：`/api/v4/user` 可能 200 但 clone 失败。安装时报错
  提示"令牌缺少 read_repository scope"。
- **manifest 解析失败**：公司 tab 显示错误 + 重试按钮（复用社区 tab 的错误态模式）。
- **宽限期内后台重试**：`offline_grace` 状态下，后台定时（如每 10 分钟）重试验活；
  一旦成功更新 `last_valid_at`，一旦 401 转 `revoked`。

## 8. 测试策略

- **Rust 单元测试**：
  - `validate_company_account` 的状态机：mock reqwest（`mockito` 或内嵌 HTTP）返回
    200/401/网络错误，验证状态迁移与 `last_valid_at` 更新。
  - 宽限窗口边界：`last_valid_at` 恰好 7 天 vs 7 天 + 1 秒。
  - manifest 解析：纯函数，覆盖 `version`、空列表、缺字段、非法 `source`。
  - 凭证注入：验证 `run_pi_command` 子进程环境含 `GIT_ASKPASS` 且 ASKPASS 脚本对
    目标 host 输出正确凭证（用本地 git 仓 + 假 PAT 做集成断言）。
- **前端单元测试**（vitest + jsdom）：
  - 锁定窗口按账户状态正确渲染。
  - Company tab 由 manifest 数据正确渲染卡片/过滤。
  - i18n：所有新文本经 `t()`，无硬编码字符串（跑 i18n 安全 grep）。
- **端到端手测清单**（写进 spec 附录，不自动化）：
  1. 全新员工配置 PAT → 启动正常 → 公司 tab 可见可装。
  2. 装/卸载一个公司 extension → `pi list` 出现/消失。
  3. GitLab Block 该用户 → 重启 Picot → 锁定窗口。
  4. 断网启动（宽限内）→ 正常；改系统时间越过 7 天 → 锁定。
  5. PAT 轮换 → 重输 → 恢复。

## 9. 关键设计决策（判断点记录）

1. **PAT 全程由 Rust 持有，前端只见状态**——秘密不下发到不可信（明文 JS）层。
2. **PAT 存 keychain**——不写明文文件。需在实现期确认可复用的 Tauri secret 插件。
3. **git 凭证走 `GIT_ASKPASS`，不塞 URL**——避免 PAT 在每个 clone 的 `.git/config`
   落 N 份明文。
4. **公司专属构建 feature flag**——公开 Picot 不含门禁与公司 GitLab 地址。
5. **manifest 走 raw API 单次 GET，不 clone 仓库**——轻量，且 manifest 本身受 PAT
   保护。
6. **一份 PAT 兼做验活 + clone 凭证**——员工只配一次。

## 10. 不在本设计范围

- 已装到 `~/.pi/agent/git/...` 的副本（档1 接受防不住）。
- patch Picot JS / 直接跑内嵌 pi 二进制等技术绕过（档1 接受）。
- 公司 extension 的源码级保护（混淆/编译/服务端托管）——若未来需要"离职即连已装
  副本都失效"，需升级到 C/S 架构（档3），是独立的大改动。
- 公司 extension 本身的开发规范、CI、发版流程——归各 extension 仓库自治。
- OAuth 登录流（目前用 PAT；若公司要求 SSO/OAuth，是后续增强）。

## 11. 开放问题（实现计划阶段需先确认）

1. **PAT 存储基建**：Picot 现在有没有可复用的 secret 存储？需查 `Cargo.toml` 与
   现有 Tauri 插件；若无，选 `tauri-plugin-stronghold` 还是 `keyring` crate。
2. **构建变体机制**：`PICOT_INTERNAL=1` 在 Tauri/Rust 侧用 Cargo feature 还是
   `cfg` + 构建脚本；前端公司模块如何 tree-shake 出公开构建。
3. **公司构建的分发渠道**：公司构建的 Picot 从哪更新？是否复用现有 updater
  （`latest.json`）但指向公司私有 release 源？
4. **PAT scope 最小化**：`read_api` + `read_repository` 是否够；某些 GitLab 实例
   对 raw API 的权限模型是否需要额外 scope。
