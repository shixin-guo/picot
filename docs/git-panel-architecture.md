<!-- ABOUTME: Codux Git Panel 及 Git Diff Window 的详细实现分析 -->
<!-- ABOUTME: 涵盖从 git2 引擎层到 GPUI 桌面 UI 层的完整架构 -->

# Git Panel & Git Diff Window 实现分析

## 目录

- [架构概览](#架构概览)
- [Git 引擎层 (`crates/codux-git/`)](#git-引擎层-cratescodux-git)
  - [核心数据结构](#核心数据结构)
  - [仓库操作与状态采集](#仓库操作与状态采集)
  - [Diff 计算引擎](#diff-计算引擎)
  - [文件系统监听器](#文件系统监听器)
- [桌面 Git Actions 层](#桌面-git-actions-层)
  - [操作生命周期管理](#操作生命周期管理)
  - [Commit 工作流](#commit-工作流)
- [桌面 Git Sidebar UI 层](#桌面-git-sidebar-ui-层)
  - [GitFilesPanelView 主面板](#gitfilespanelview-主面板)
  - [GitHistoryPanelView 历史面板](#githistorypanelview-历史面板)
  - [状态树虚拟列表](#状态树虚拟列表)
  - [Diff Window 双栏对齐视图](#diff-window-双栏对齐视图)
  - [Review 对齐行构建器](#review-对齐行构建器)

---

## 架构概览

Git 面板的实现分为三个层次：

```
┌─────────────────────────────────────────────────────┐
│  桌面 UI 层 (apps/desktop/src/app/sidebars/git/)     │
│  GitFilesPanelView · GitHistoryPanelView             │
│  diff_window.rs · status_tree.rs · status_rows.rs   │
│  review.rs · panels.rs · history.rs · labels.rs      │
├─────────────────────────────────────────────────────┤
│  Git Action 层 (apps/desktop/src/app/git_actions/)  │
│  runner.rs · commit.rs · review.rs · branches.rs    │
│  clone.rs · network.rs · stash_tags.rs              │
├─────────────────────────────────────────────────────┤
│  Git 引擎层 (crates/codux-git/)                      │
│  repository.rs · commands.rs · diff.rs · service/    │
│  watch.rs · wire.rs · worktree.rs · types.rs        │
│  底层依赖: git2 (libgit2)                            │
└─────────────────────────────────────────────────────┘
```

- **引擎层**：基于 `git2`（libgit2 的 Rust 绑定）实现所有 Git 原语操作，包含文件监听和远程协议路由
- **Action 层**：管理 Git 操作的异步生命周期（start → blocking → apply result）
- **UI 层**：使用 GPUI 框架渲染 Git 面板的所有视图组件

---

## Git 引擎层 (`crates/codux-git/`)

### 核心数据结构

所有 Git 数据通过清晰的 DTO 结构在层次间传递，定义在 `types.rs` 中：

```rust
// crates/codux-git/src/types.rs

/// 顶级 Git 状态摘要 — 面板渲染的主要数据源
pub struct GitSummary {
    pub branch: String,
    pub upstream: Option<String>,
    pub ahead: i64,          // 领先上游的 commit 数
    pub behind: i64,         // 落后上游的 commit 数
    pub head_pushed: bool,
    pub staged: usize,       // 暂存区文件数
    pub unstaged: usize,     // 工作区修改文件数
    pub untracked: usize,    // 未跟踪文件数
    pub additions: i64,      // 总增行数
    pub deletions: i64,      // 总删行数
    pub is_repository: bool,
    pub error: Option<String>,
    pub changed_files: Vec<GitFileStatus>,    // 变更文件列表（已折叠目录）
    pub branches: Vec<GitBranchSummary>,
    pub remote_branches: Vec<String>,
    pub remotes: Vec<GitRemoteSummary>,
    pub commits: Vec<GitCommitSummary>,       // 最近 20 条
    pub stashes: Vec<GitStashSummary>,
    pub tags: Vec<String>,
}

/// 文件状态 — path 可能以 / 结尾表示目录
pub struct GitFileStatus {
    pub path: String,
    pub index_status: String,     // 索引状态码 (M/A/D/R)
    pub worktree_status: String,  // 工作区状态码 (M/D/?)
}

/// Review 摘要 — 用于工作台审查视图
pub struct GitReviewSummary {
    pub mode: String,        // "workingTreeAudit" | "taskBranch"
    pub title: String,
    pub base_branch: Option<String>,
    pub diff_stat: String,
    pub files: Vec<GitReviewFile>,    // 含增删行数统计
    pub is_repository: bool,
    pub error: Option<String>,
}

/// Review 文件 — 带精确的行变更统计
pub struct GitReviewFile {
    pub path: String,
    pub status: String,      // "staged" | "modified" | "added" | "deleted"
    pub additions: i64,
    pub deletions: i64,
}

/// Diff 快照 — 纯文本格式的 diff 输出
pub struct GitDiffSnapshot {
    pub path: String,
    pub diff: String,
    pub is_repository: bool,
    pub error: Option<String>,
}

/// Review 内容 — 双栏对齐视图的源数据
pub struct GitReviewContentSummary {
    pub path: String,
    pub head_content: String,       // HEAD 版本内容
    pub base_content: Option<String>, // base 分支版本（跨分支 review 时）
    pub index_content: Option<String>, // 索引版本
    pub worktree_content: String,    // 工作区版本
    pub added_lines: Vec<usize>,     // 新增行号列表
    pub deleted_lines: Vec<usize>,   // 删除行号列表
    pub is_repository: bool,
    pub error: Option<String>,
}
```

### 仓库操作与状态采集

核心实现在 `repository.rs` 中。所有操作以 `open_git_repository()` 开始：

```rust
// crates/codux-git/src/repository.rs

fn open_git_repository(path: &str) -> Result<GitRepository, String> {
    // 从项目路径向上发现 .git 目录
    discover_git_repository(path)
}

fn repo_root(repo: &GitRepository) -> &Path {
    repo.workdir().or_else(|| repo.path().parent())
        .unwrap_or_else(|| Path::new(""))
}
```

**状态采集流水线** `git_status_and_files_from_repo()`：

```
open_git_repository()
  ↓
git2_status_files()       — 使用 git2::StatusOptions 扫描工作区和索引
  ├── 分为 staged / unstaged / untracked 三类
  └── 跳过 CODUX_MANAGED_MEMORY_ENTRYPOINT_MARKER 标记的文件
  ↓
flatten_unique_status_files()  — 去重合并三类文件
  ↓
collapse_path_status_files()   — 将目录内的文件折叠为目录条目
  ↓
current_branch_name() / upstream_branch_name() / ahead_behind()
git2_branches() / git2_remotes() / git2_commit_log(20)
git2_stashes() / git2_tags()
  ↓
GitSummary + 原始文件列表
```

关键常量：

- `MAX_GIT_STATUS_FILES = 1200` — 最大扫描文件数，防止超大仓库卡死
- `GIT_WATCH_DEBOUNCE_MS = 900` — 文件监听的防抖间隔

### Diff 计算引擎

实现在 `diff.rs` 中，通过 `git2::Diff` 计算三种 diff 类型：

```rust
// crates/codux-git/src/diff.rs

enum DiffTarget {
    Index,      // 索引 ↔ HEAD (staged diff)
    Worktree,   // 工作区 ↔ 索引 (unstaged diff)
    Workspace,  // 工作区 ↔ HEAD (combined diff)
}
```

**三种 diff 的计算方式**：

```
DiffTarget::Index:
  repo.diff_tree_to_index(tree, None, &options)
  → 显示已暂存但尚未 commit 的变更

DiffTarget::Worktree:
  repo.diff_index_to_workdir(None, &options)
  → 显示已修改但尚未暂存的变更

DiffTarget::Workspace:
  repo.diff_tree_to_workdir_with_index(tree, None, &options)
  → 显示工作区与 HEAD 的所有差异（推荐用于通用 diff）
```

**Diff 选项配置** (`git2_diff_options`)：

```rust
options
    .include_untracked(true)      // 包含未跟踪文件
    .recurse_untracked_dirs(true) // 递归未跟踪目录（仅在指定路径时）
    .context_lines(3)            // 上下文行数
    .pathspec(path)              // 可选路径过滤
```

**Diff 到文本的转换** (`diff_to_string`)：

```rust
fn diff_to_string(diff: &git2::Diff<'_>) -> Result<String, String> {
    // 使用 git2::DiffFormat::Patch 格式打印
    // 只保留 +, -, ' ' 开头的行（跳过 @@ 头等元信息行）
    diff.print(DiffFormat::Patch, |_delta, _hunk, line| {
        match line.origin() {
            '+' | '-' | ' ' => output.push(line.origin() as u8),
            _ => {}
        }
        output.extend_from_slice(line.content());
        true
    });
}
```

**Commit diff 截断**（`compact_commit_message_diff`）：

```
COMMIT_CONTEXT_MAX_CHARS = 24_000       // 最大字符数
COMMIT_CONTEXT_MAX_FILES = 80           // 最多包含的文件数
COMMIT_CONTEXT_MAX_LINES_PER_FILE = 80  // 每个文件最多行数
```

**行号解析**（`parse_diff_line_numbers`）：

```rust
fn parse_diff_line_numbers(diff: &str) -> (Vec<usize>, Vec<usize>) {
    // 解析 @@ -old_start,count +new_start,count @@ 头
    // 遍历每一行，跟踪 old_line / new_line 的偏移
    // + 行 → added 列表，- 行 → deleted 列表
}
```

### 文件系统监听器

`watch.rs` 实现了 Git 文件变更的自动监听：

```rust
// crates/codux-git/src/watch.rs — GitWatchManager

pub struct GitWatchManager {
    watcher: RecommendedWatcher,  // notify 库的文件系统监听器
    paths: Arc<Mutex<HashSet<String>>>,
    changed: Arc<Mutex<Vec<String>>>,
    debounce_timer: Arc<Mutex<Option<Instant>>>,
}
```

关键特性：

- **防抖延迟**：`GIT_WATCH_DEBOUNCE_MS = 900ms`，避免高频事件（如 `git stash`）触发过多刷新
- **强制刷新截止**：`GIT_WATCH_MAX_ACCUMULATE_MS = 3000ms`，连续构建场景下的保护
- **路径上限**：`GIT_WATCH_MAX_CHANGED_PATHS = 4096`，防止内存暴涨

---

## 桌面 Git Actions 层

### 操作生命周期管理

`git_actions/runner.rs` 实现所有 Git 操作的标准异步生命周期：

```rust
// apps/desktop/src/app/git_actions/runner.rs

pub(super) fn start_project_git_operation(
    project_id: String,
    project_path: String,
    operation: GitRunningOperation,       // 操作描述（含 label 和是否可取消）
    action: impl FnOnce(RuntimeService, String) -> Result<GitSummary, String>,
    completion: GitOperationCompletion,   // 完成回调策略
    cx: &mut Context<Self>,
)
```

**生命周期流程**：

```
start_project_git_operation()
  ├── 检查 git_running_operation 是否为空（防止并发操作）
  ├── 设置 git_running_operation = Some(operation)
  ├── 设置 status_message = "Git {label} started"
  ├── 注册 runtime_trace
  └── cx.spawn(async move {
        ├── codux_runtime::spawn_blocking(move || action(service, path))
        ├── .await 等待完成
        └── apply_project_git_operation_result(result)
              ├── 清除 git_running_operation
              ├── 更新 state.git = result (summary)
              ├── 执行 completion 回调
              └── 处理错误（显示错误提示）
      })
```

**操作类型**：

```rust
pub struct GitRunningOperation {
    pub label: String,        // 显示标签（"stage", "commit", "push"）
    pub cancellable: bool,    // 是否显示取消按钮
}
```

### Commit 工作流

`git_actions/commit.rs` 实现了完整的 commit 流程：

```
select_git_branch()           — 选择/切换分支
  ↓
git_commit()                  — 执行 commit
  └── GitService::commit_staged(message)
  ↓
apply_git_commit_result()     — 应用结果
  ├── 刷新状态
  └── 可选 push
```

关键特性：

- `selected_git_file` 自动规范化：当选中文件不在变更列表中时清空选中状态
- `refresh_git_review_for_project()`：提交后自动刷新 review 面板

---

## 桌面 Git Sidebar UI 层

UI 层使用 GPUI 框架的 Entity + View + Render 模式构建。

### GitFilesPanelView 主面板

`sidebars/git/mod.rs` 定义了两个 GPUI View：

```rust
// GitFilesPanelView — 变更文件列表面板
pub(in crate::app) struct GitFilesPanelView {
    app_entity: gpui::Entity<CoduxApp>,
    snapshot: GitFilesPanelSnapshot,   // 快照用于 Equals 比对
}

// GitHistoryPanelView — 提交历史面板
pub(in crate::app) struct GitHistoryPanelView {
    app_entity: gpui::Entity<CoduxApp>,
    snapshot: GitHistoryPanelSnapshot,
}
```

**快照机制**：每个 View 维护一个 `snapshot` 字段，通过 `set_snapshot()` 方法更新。当快照相等时跳过重渲染，避免无必要的 GPUI 更新。

**渲染流程**：

```
GitFilesPanelView::render()
  ↓
app_entity.update(cx, |app, cx| {
  ├── 加载 i18n labels: GitSidebarLabels::load(&language)
  ├── 按文件状态分类: staged / changed / untracked
  ├── git_files_panel(GitFilesPanelInput { ... })
  └── 调用 git_panel_header() + git_files_panel()
})
```

### GitHistoryPanelView 历史面板

渲染 commit 历史列表，数据来自 `state.git.commits`：

```rust
pub struct GitCommitSummary {
    pub hash: String,
    pub title: String,
    pub relative_time: String,    // "2 hours ago"
    pub decorations: Option<String>, // 分支/标签标记
    pub graph_prefix: String,     // ASCII 图形前缀
    pub author: String,
}
```

### 状态树虚拟列表

`status_tree.rs` 实现了一个高效的虚拟列表渲染系统：

```rust
// 虚拟行类型枚举
pub(super) enum GitStatusVirtualRow {
    GroupHeader { id, title, count, files, expanded, first },
    Spacer { height: f32 },
    Empty { text: String },
    Dir { section_id, name, path, expanded, depth, labels },
    File { file, active, selected_files, depth, labels },
    Limit { count, text },
}
```

**分组渲染策略**：

```
git_status_virtual_rows(input)
  │ 每组渲染流程：
  ├── GroupHeader        → 可折叠分组标题（Staged / Changes / Untracked）
  ├── Spacer             → 组间距
  ├── Empty / Dir / File → 内容行
  └── Limit              → 超出显示上限提示
```

**目录折叠**：

`append_git_status_virtual_directory_rows()` 实现无限层级目录展开：

```
对每个分组内的文件列表：
  1. collect_immediate_git_status_entries()
     → 分出直接文件和子目录
  2. 目录行：GitStatusVirtualRow::Dir（可展开）
  3. 文件行：GitStatusVirtualRow::File
  4. 递归子目录（depth + 1）
```

**文件行交互** (`status_rows.rs`):

- **单击**：选中文件
- **Shift + 单击**：多选
- **双击**：打开 Diff Window
- **右键菜单**：Stage / Unstage / Open Diff / Discard / Add to .gitignore

### Diff Window 双栏对齐视图

`diff_window.rs` 实现了两种 diff 渲染模式：

**模式 1：传统 Diff 视图**（`git_diff_window_body`）

当没有 `derived_rows` 时，显示原始 git diff 文本：

```rust
pub(super) fn git_diff_window_body(
    diff: &str,
    derived_rows: Option<&GitReviewDerivedRows>,
    empty_label: String,
    original_label: String,
    current_label: String,
    cx: &mut Context<CoduxApp>,
) -> AnyElement {
    if let Some(rows) = derived_rows {
        // 模式 2：双栏对齐视图
        return div().flex()
            .child(git_diff_window_content_panel("original", &original_label, rows.original))
            .child(git_diff_window_content_panel("current", &current_label, rows.current))
    }
    // 模式 1：传统 diff 文本
    diff.lines().map(|line| git_diff_line_row(line))
}
```

行颜色规则：

```rust
fn git_diff_line_row(line: &str) {
    let color = if line.starts_with('+') && !line.starts_with("+++") => GREEN
                 if line.starts_with('-') && !line.starts_with("---") => RED
                 if line.starts_with("@@") => ACCENT
                 else => TEXT_MUTED
}
```

**模式 2：双栏对齐视图**（`git_diff_window_content_panel`）

左右两个独立面板，但共享 `code_scroll_handle` 实现同步滚动：

```rust
fn git_diff_window_content_panel(
    list_id: &'static str,
    title: &str,                    // 标题（"Original" / "Current"）
    cells: Rc<Vec<GitReviewAlignedCell>>,  // 对齐的代码行
    scroll_handle: VirtualListScrollHandle,
) -> impl IntoElement {
    div().flex().flex_col().flex_1()
        .child(div().h(px(30.0))       // 标题栏
            .child(title))
        .child(div().flex_1().bg(BG_TERMINAL)
            .font_family("SF Mono")
            .text_size(rems(0.75))
            .child(v_virtual_list(...)  // GPUI 虚拟列表
                .track_scroll(&scroll_handle)
                .with_sizing_behavior(ListSizingBehavior::Auto)))
}
```

每行渲染（`git_diff_window_code_line`）：

```rust
┌────────────────────────────────────────────┐
│ 行号(46px) │ 代码文本(flex-1)              │
│ 背景色:                                    │
│   Addition → 绿色半透明                    │
│   Deletion → 红色半透明                    │
│   无变更 → 透明                            │
└────────────────────────────────────────────┘
```

### Review 对齐行构建器

`review.rs` 中的 `build_git_review_derived_rows()` 实现了双栏代码对齐的核心算法：

```rust
pub(in crate::app) fn build_git_review_derived_rows(
    original_content: &str,   // HEAD 版本内容
    current_content: &str,     // 工作区/索引版本内容
    deleted_lines: &[usize],   // 删除行号列表
    added_lines: &[usize],     // 新增行号列表
) -> GitReviewDerivedRows
```

**对齐算法**：

```
original_lines = split(original_content)   // 每行最多 160 字符
current_lines  = split(current_content)

old_line = 1, new_line = 1

while 行数 < 600:
  if old_line 在 deleted_lines 或 new_line 在 added_lines:
    // 变更块：收集连续删除行和连续新增行
    deleted_block = [old_line...]  // 连续删除
    added_block   = [new_line...]  // 连续新增
    for offset in 0..max(len(deleted_block), len(added_block)):
      original_cells.push(Deletion着色, old_number)
      current_cells.push(Addition着色, new_number)
  else:
    // 未变更行：直接对齐
    original_cells.push(无色, old_line)
    current_cells.push(无色, new_line)
    old_line++, new_line++
```

`GitReviewAlignedCell` 结构：

```rust
pub(super) struct GitReviewAlignedCell {
    pub line_number: Option<usize>,        // 行号（None 表示空行填充）
    pub text: String,
    pub tone: Option<GitReviewLineTone>,   // Addition | Deletion | None
}
```

**限制**：

- 最大对齐行数：600（防止超大 diff 撑爆内存）
- 每行最大字符：160
- 内容宽度基于最长行动态计算（`review_content_width`）

**Diff Window 整体布局**（`git_diff_window_workspace`）：

```
┌──────────────────────────────────────────┐
│ 标题栏 (h:52px)                          │
│  "Diff" · "src/main.rs"                 │
├──────────────────────────────────────────┤
│ 错误提示（可选，橙色边框）                │
├──────────────────────────────────────────┤
│ git_diff_window_body                     │
│ ┌───────────────┬──────────────────────┐│
│ │ Original      │ Current              ││
│ │ (h:30px)      │ (h:30px)             ││
│ ├───────────────┼──────────────────────┤│
│ │ 1 │ fn main() │ 1 │ fn main() {      ││
│ │ 2 │ {         │ 2 │   let x = 1;     ││
│ │   │           │ 3 │   println!(x);   ││
│ │ 3 │ }         │ 4 │ }                ││
│ └───────────────┴──────────────────────┘│
└──────────────────────────────────────────┘
```

### 面板布局与交互

**Git 面板整体布局**（`panels.rs`）：

```
┌──────────────────────────┐
│ Header (h:44px)          │
│ [分支名 ▾]       [AI][✕] │
├──────────────────────────┤
│ Staged (N) [可折叠]      │
│  ├── 📁 src/             │
│  │   └── main.rs  M      │
│  └── lib.rs       A      │
├──────────────────────────┤
│ Changes (N) [可折叠]     │
│  ├── src/utils.rs  M     │
│  └── README.md     M     │
├──────────────────────────┤
│ Untracked (N) [可折叠]   │
│  └── new_file.ts   ?     │
├──────────────────────────┤
│ History                  │
│  * abc1234 feat: add X   │
│  │ o def5678 fix: Y      │
│  o 789abcd chore: Z      │
└──────────────────────────┘
```

Header 交互：

- 分支名下拉菜单：切换分支、创建分支、Pull、Push、Fetch
- AI 按钮：使用 AI 生成 commit message
- 取消按钮：取消正在运行的 Git 操作

---

## 总结

| 组件 | 关键文件 | 核心职责 |
| ------ | --------- | --------- |
| Git 引擎 | `crates/codux-git/repository.rs` | 状态采集、文件分类、目录折叠 |
| Diff 引擎 | `crates/codux-git/diff.rs` | 三种 diff 类型、行号解析、截断 |
| 文件监听 | `crates/codux-git/watch.rs` | 自动刷新、防抖、限流 |
| 操作管理 | `apps/../git_actions/runner.rs` | 异步生命周期、错误处理 |
| 主面板 | `apps/../sidebars/git/mod.rs` | View 快照、文件分类渲染 |
| 状态树 | `apps/../sidebars/git/status_tree.rs` | 虚拟列表、分组、折叠树 |
| Diff Window | `apps/../sidebars/git/diff_window.rs` | 双栏对齐 diff 视图 |
| 对齐引擎 | `apps/../sidebars/git/review.rs` | 增减行对齐算法 |
