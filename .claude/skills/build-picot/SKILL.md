---
name: build-picot
description: 'Picot 本地构建助手 - 在本地 macOS 上构建 macOS DMG（含 universal）或 Windows exe+zip，不涉及版本、tag、push'
tags: [build, local, tauri, cross-compile]
---

# Picot 本地构建助手

## 用途

执行 `scripts/build.sh` 在本地 macOS 上构造 Picot 产物，供内部 QA 使用。

**职责边界（重要）：**
- **本 skill 负责**：本地构造 macOS DMG（arm64 / x86_64 / universal）/ Windows exe+zip
- **本 skill 不做**：修改版本号、生成 CHANGELOG、git commit / tag / push、发布到 GitHub Release
- **公开发布仍由 `scripts/release.sh` + GitHub Actions (`.github/workflows/release.yml`) 完成**

## 输入参数

| 参数      | 类型   | 必需 | 默认值     | 说明                                                                  |
| --------- | ------ | ---- | ---------- | --------------------------------------------------------------------- |
| platform  | string | 否   | current    | `mac-arm` / `mac-intel` / `mac-universal` / `windows` / `current`     |

## 触发示例

- "本地构建 Picot for Apple Silicon"
- "build picot windows"
- "构造一个 universal 的 Mac 版本，分发测试"
- "用 build-picot 跑一下"

## 执行步骤

### Step 1: 验证前置条件

1. **Git 仓库检查**：确认当前在 Picot 仓库根目录
2. **工具链检查**：
   - `bun` (项目使用 Bun，**不能用 npm/pnpm**，参见 AGENTS.md)
   - `cargo` + `rustup` (必须通过 rustup 安装，**不能用 Homebrew 的 rust**——会破坏 MinGW 交叉编译)
   - 如果 `platform=windows`，额外检查 `x86_64-w64-mingw32-gcc` (缺失时提示 `brew install mingw-w64`)
   - 如果 `platform=mac-universal`，确认 `aarch64-apple-darwin` 和 `x86_64-apple-darwin` 两个 rustup target 都已安装（脚本会自动 `rustup target add`）
3. **环境变量检查**：
   - 若检测到 `CI=1`（一些本地 shell 会带），`scripts/build.sh` 内部会 `unset CI`。这是必要的：Tauri CLI v2 把 `$CI` 转发为 `--ci`，但只接受 `true`/`false`，不接受 `1`。
4. **工作树状态**：若有未提交变更，**SHOULD 警告但不阻断**（开发者可能故意在 dirty tree 上做构造验证）。

### Step 2: 执行 build.sh

按 `platform` 派发到 `scripts/build.sh`，无其它参数：

```bash
./scripts/build.sh <platform>
```

`scripts/build.sh` 内部自动完成：
- `bun install --frozen-lockfile`
- `bun run fetch:pi` (下载/校验内嵌 pi 二进制)
- `bun run build:extensions` (编译 `extensions/embedded-server.ts` → `dist/embedded-server.mjs`)
- `rustup target add <target>` (universal 会同时 add 两个 arch)
- `tauri build` 配合对应 `--target` / `--bundles` / `--no-bundle`
- Windows 路径额外做 `zip` 打包
- **构建完成后**，每个 builder 都会把产物 **复制到 repo 根目录**（`./Picot_<version>_<arch>.dmg` / `./Picot_<version>_windows_x64.zip`），并打印 sha256，方便直接分发给同事

### Step 3: 输出构建结果

按 `platform` 展示产物路径与大小：

**mac-arm / mac-intel / mac-universal:**
- DMG (in repo root): `./Picot_<version>_<arch>.dmg`（`<arch>` 为 `aarch64` / `x86_64` / `universal`）
- DMG (in target/): `src-tauri/target/<triple>/release/bundle/dmg/Picot_*.dmg`
- 内含: `Picot.app` (Tauri bundling 时已把 `.app` 一起打入 DMG，bundle/macos/ 目录在 build 完成后会被清空)
- universal: `Picot.app/Contents/MacOS/picot` 是 fat binary（arm64 + x86_64 lipo'd）
- **签名**: ad-hoc 签名 (`signingIdentity: "-"`)
- **Gatekeeper**: 首次启动会被拦截，**右键打开**绕过

**windows:**
- Zip (in repo root): `./Picot_<version>_windows_x64.zip`
- 内容: `Picot.exe` + 任何随附 DLL + embedded pi tree + extensions
- **签名**: 无 (MinGW 交叉编译不签名)
- **MSI**: 不生成 (需要 Windows 宿主工具)

## 后续步骤

1. 把 repo 根目录下的 DMG / zip 发给内部测试者
2. 收集反馈，修复 bug
3. 一切就绪后用 `scripts/release.sh` 走正式发布流程（创建 tag + 触发 GitHub Actions）

## 注意事项

- **不要** 在 skill 中修改 `package.json` / `Cargo.toml` / `tauri.conf.json` 的版本号——本 skill 是 build-only
- **不要** 运行 `git commit` / `git tag` / `git push`——GH Actions 拥有 release 流程
- **必须** 遵守 Bun-only 约束（参见 AGENTS.md）
- 如果 `tauri` 找不到：通常是 `node_modules/.bin` 不在 PATH。`scripts/build.sh` 已自动处理，但若通过其它方式调用会失败
- **Windows 交叉构建存在 `src-tauri/build.rs` 的已知 bug**：build.rs 用 `cfg!(target_os = "windows")` 决定查找 `pi.exe` 还是 `pi`，但 `cfg!` 在 build.rs 里始终反映 host OS。脚本通过 `PI_STUDIO_SKIP_BIN_CHECK=1` 绕过这个 guard（脚本已显式 fetch Windows pi），同时用 `PI_TARGET_PLATFORM=windows-x64` 让子进程 fetch 拉到正确平台。**不要轻易删除这两行**
