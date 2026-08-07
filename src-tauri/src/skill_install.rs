// ABOUTME: Rust port of extensions/skill-discovery.ts + skill-installation.ts.
// ABOUTME: Scans a chosen directory for SKILL.md candidates, builds an opaque
// ABOUTME: candidate tree keyed by the install secret, and links selected
// ABOUTME: candidates into Pi's settings.json under a cross-process lock.
//
// This mirrors the feature-v3 TypeScript implementation so the host can run
// scan/install synchronously without forwarding through pi's async
// extension-command + notify channel. The TS originals are the source of
// truth for behavior; this port keeps the same algorithms, IDs, and
// revision scheme so a scan from either side produces identical output.

use crate::skill_source_registry::SkillSourceBinding;
use base64::Engine;
use hmac::{Hmac, Mac};
use serde::Serialize;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

type HmacSha256 = Hmac<Sha256>;

const IGNORE_FILE_NAMES: &[&str] = &[".gitignore", ".ignore", ".fdignore"];
const MAX_NAME_LENGTH: usize = 64;
const MAX_DESCRIPTION_LENGTH: usize = 1024;
const SETTINGS_LOCK_STALE_MS: u64 = 10_000;
const SETTINGS_LOCK_RETRY_DELAY_MS: u64 = 20;
const SETTINGS_LOCK_MAX_ATTEMPTS: usize = 750; // ~15s ceiling

// ── Public types (serde shapes match the TS originals for the frontend) ──

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillDiagnostic {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    pub message: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillInstallCandidate {
    pub kind: &'static str,
    pub id: String,
    pub name: String,
    pub description: String,
    pub display_canonical_path: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillInstallGroup {
    pub kind: &'static str,
    pub id: String,
    pub name: String,
    pub children: Vec<SkillTreeNode>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(untagged)]
pub enum SkillTreeNode {
    Group(SkillInstallGroup),
    Candidate(SkillInstallCandidate),
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallCandidateSelection {
    pub kind: String,
    pub id: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillInstallScan {
    pub source_id: String,
    pub display_canonical_source_path: String,
    pub scan_revision: String,
    pub tree: Vec<SkillTreeNode>,
    pub default_selection: Vec<InstallCandidateSelection>,
    pub diagnostics: Vec<SkillDiagnostic>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillInstallResult {
    pub scan: SkillInstallScan,
    pub added_entries: Vec<String>,
    pub skipped_entries: Vec<String>,
    pub settings_changed: bool,
    pub runtime_restart_required: bool,
}

/// Context the host reconstructs for a scan/install: the on-disk paths the
/// operation needs plus the install secret that keys opaque candidate IDs.
#[derive(Clone, Debug)]
pub struct InstallContext {
    /// Pi agent dir (~/.pi/agent), the global settings base.
    pub agent_dir: PathBuf,
    /// Current workspace cwd, the project settings base parent.
    pub cwd: PathBuf,
    /// Host install secret; keys opaque candidate IDs so the browser cannot
    /// forge them.
    pub install_secret: String,
}

impl InstallContext {
    fn base_dir(&self, scope: &str) -> PathBuf {
        if scope == "global" {
            self.agent_dir.clone()
        } else {
            self.cwd.join(".pi")
        }
    }
}

// ── Internal discovery types ──────────────────────────────────────────

#[derive(Clone, Debug)]
#[allow(dead_code)]
struct DiscoveredSkill {
    canonical_path: String,
    file_path: PathBuf,
    skill_dir: PathBuf,
    name: String,
    description: String,
    disable_model_invocation: bool,
    is_configured_file: bool,
}

#[derive(Clone, Debug)]
struct ParsedFrontmatter {
    name: Option<String>,
    description: Option<String>,
    disable_model_invocation: bool,
}

// ── Path helpers ──────────────────────────────────────────────────────

fn to_posix(p: &str) -> String {
    p.replace(std::path::MAIN_SEPARATOR, "/")
}

fn canonicalize_existing(p: &Path) -> PathBuf {
    fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf())
}

/// Canonicalize a path even when it does not yet exist: realpath the longest
/// existing ancestor and re-append the missing tail (mirrors the TS helper).
#[allow(dead_code)]
fn canonicalize_path(p: &Path) -> PathBuf {
    if let Ok(real) = fs::canonicalize(p) {
        return real;
    }
    let segments: Vec<String> = p
        .components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect();
    for i in (1..segments.len()).rev() {
        let ancestor: PathBuf = segments[..i].iter().collect();
        if let Ok(real) = fs::canonicalize(&ancestor) {
            let tail: PathBuf = segments[i..].iter().collect();
            return real.join(tail);
        }
    }
    p.to_path_buf()
}

// ── Length-delimited hashing (matches the TS lengthDelimited helper) ──

fn length_delimited_hash(hasher: &mut Sha256, part: &str) {
    let bytes = part.as_bytes();
    hasher.update((bytes.len() as u32).to_be_bytes());
    hasher.update(bytes);
}

fn length_delimited_hmac(mac: &mut HmacSha256, part: &str) {
    let bytes = part.as_bytes();
    mac.update(&(bytes.len() as u32).to_be_bytes());
    mac.update(bytes);
}

fn opaque_id(key: &str, source_id: &str, revision: &str, kind: &str, path: &str) -> String {
    let mut mac = HmacSha256::new_from_slice(key.as_bytes()).expect("HMAC key length");
    length_delimited_hmac(&mut mac, source_id);
    length_delimited_hmac(&mut mac, revision);
    length_delimited_hmac(&mut mac, kind);
    length_delimited_hmac(&mut mac, path);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
}
// ── Frontmatter parsing (minimal YAML subset for SKILL.md) ────────────

fn parse_frontmatter(content: &str) -> ParsedFrontmatter {
    let normalized = content.replace("\r\n", "\n").replace('\r', "\n");
    if !normalized.starts_with("---") {
        return ParsedFrontmatter {
            name: None,
            description: None,
            disable_model_invocation: false,
        };
    }
    let Some(rest) = normalized.get(3..) else {
        return ParsedFrontmatter {
            name: None,
            description: None,
            disable_model_invocation: false,
        };
    };
    let end_marker = "\n---";
    let end_index = match rest.find(end_marker) {
        Some(idx) => idx,
        None => {
            return ParsedFrontmatter {
                name: None,
                description: None,
                disable_model_invocation: false,
            }
        }
    };
    // Skip the leading newline after the opening --- line.
    let yaml_text = if rest.starts_with('\n') {
        &rest[1..end_index]
    } else {
        &rest[..end_index]
    };
    parse_yaml_frontmatter(yaml_text)
}

/// Parse only the `name`, `description`, and `disable-model-invocation` keys
/// from a minimal YAML subset. Full YAML is not needed; the TS original uses
/// the `yaml` crate, but these three scalars cover all SKILL.md frontmatter
/// fields Pi reads.
fn parse_yaml_frontmatter(text: &str) -> ParsedFrontmatter {
    let mut name = None;
    let mut description = None;
    let mut disable_model_invocation = false;
    for line in text.lines() {
        let trimmed = line.trim_start_matches([' ', '\t']);
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let Some((key, value)) = trimmed.split_once(':') else {
            continue;
        };
        let key = key.trim();
        let value = value.trim();
        // Strip surrounding quotes if present.
        let unquoted = if (value.starts_with('"') && value.ends_with('"'))
            || (value.starts_with('\'') && value.ends_with('\''))
        {
            &value[1..value.len() - 1]
        } else {
            value
        };
        match key {
            "name" if !unquoted.is_empty() => name = Some(unquoted.to_string()),
            "description" if !unquoted.is_empty() => description = Some(unquoted.to_string()),
            "disable-model-invocation" if unquoted == "true" => disable_model_invocation = true,
            _ => {}
        }
    }
    ParsedFrontmatter {
        name,
        description,
        disable_model_invocation,
    }
}

fn validate_skill_name(name: &str) -> Vec<String> {
    let mut errors = Vec::new();
    if name.chars().count() > MAX_NAME_LENGTH {
        errors.push(format!(
            "name exceeds {} characters ({})",
            MAX_NAME_LENGTH,
            name.chars().count()
        ));
    }
    let valid = name
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if !valid {
        errors
            .push("name contains invalid characters (must be lowercase a-z, 0-9, hyphens)".into());
    }
    if name.starts_with('-') || name.ends_with('-') {
        errors.push("name must not start or end with a hyphen".into());
    }
    if name.contains("--") {
        errors.push("name must not contain consecutive hyphens".into());
    }
    errors
}

// ── Ignore-file matching (gitignore subset) ───────────────────────────
//
// Pi uses the `ignore` crate semantics; this is a deliberately smaller
// matcher covering the patterns SKILL.md collections actually use: simple
// names, `dir/`, leading `/`, and `!` negation. It walks the source tree
// once collecting patterns relative to the root, then answers per-path
// ignore queries.

#[derive(Clone, Debug)]
struct IgnorePattern {
    negated: bool,
    // Pattern normalized to be relative to the ignore file's directory, with
    // no leading slash and no trailing slash.
    pattern: String,
    dir_only: bool,
}

impl IgnorePattern {
    fn matches(&self, rel_posix: &str, is_dir: bool) -> bool {
        if self.dir_only && !is_dir {
            return false;
        }
        // Match if the pattern equals the path, any single segment, or is a
        // suffix preceded by '/' (basename match). No glob support beyond '*'
        // inside a single segment is implemented; SKILL.md collections rarely
        // use globs in ignore files.
        let target = if self.dir_only {
            rel_posix.trim_end_matches('/')
        } else {
            rel_posix
        };
        if target == self.pattern {
            return true;
        }
        // Basename match (pattern with no '/' matches any path ending in it).
        if !self.pattern.contains('/') && target.rsplit('/').next() == Some(self.pattern.as_str()) {
            return true;
        }
        // Suffix match for anchored patterns like "sub/dir".
        if target.ends_with(&format!("/{}", self.pattern)) {
            return true;
        }
        false
    }
}

struct IgnoreMatcher {
    patterns: Vec<IgnorePattern>,
}

impl IgnoreMatcher {
    fn build(root: &Path) -> Self {
        let mut patterns = Vec::new();
        Self::walk(root, root, &mut patterns);
        IgnoreMatcher { patterns }
    }

    fn walk(dir: &Path, root: &Path, out: &mut Vec<IgnorePattern>) {
        let rel_dir = dir.strip_prefix(root).unwrap_or(Path::new(""));
        let prefix = if rel_dir.as_os_str().is_empty() {
            String::new()
        } else {
            format!("{}/", to_posix(&rel_dir.to_string_lossy()))
        };
        let entries = match fs::read_dir(dir) {
            Ok(e) => e,
            Err(_) => return,
        };
        for name in IGNORE_FILE_NAMES {
            let p = dir.join(name);
            if !p.exists() {
                continue;
            }
            if let Ok(text) = fs::read_to_string(&p) {
                for line in text.lines() {
                    if let Some(pat) = Self::parse_line(line, &prefix) {
                        out.push(pat);
                    }
                }
            }
        }
        for entry in entries.flatten() {
            let file_name = entry.file_name();
            let name = file_name.to_string_lossy();
            if name.starts_with('.') || name == "node_modules" {
                continue;
            }
            let full = entry.path();
            if full.is_dir() {
                Self::walk(&full, root, out);
            }
        }
    }

    fn parse_line(line: &str, prefix: &str) -> Option<IgnorePattern> {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            return None;
        }
        if trimmed.starts_with('#') && !trimmed.starts_with("\\#") {
            return None;
        }
        let mut pattern = line.to_string();
        let mut negated = false;
        if let Some(stripped) = pattern.strip_prefix('!') {
            negated = true;
            pattern = stripped.to_string();
        } else if let Some(stripped) = pattern.strip_prefix("\\!") {
            pattern = stripped.to_string();
        }
        if let Some(stripped) = pattern.strip_prefix('/') {
            pattern = stripped.to_string();
        }
        let dir_only = pattern.ends_with('/');
        if dir_only {
            pattern.pop();
        }
        if pattern.is_empty() {
            return None;
        }
        let full = format!("{prefix}{pattern}");
        Some(IgnorePattern {
            negated,
            pattern: full,
            dir_only,
        })
    }

    fn ignores(&self, rel_posix: &str, is_dir: bool) -> bool {
        let mut ignored = false;
        for pat in &self.patterns {
            if pat.matches(rel_posix, is_dir) {
                ignored = !pat.negated;
            }
        }
        ignored
    }
}

// ── Skill discovery (mirrors discoverSkillsFromRoot) ──────────────────

fn push_skill(
    file_path: &Path,
    diagnostics: &mut Vec<SkillDiagnostic>,
    out: &mut Vec<DiscoveredSkill>,
    is_configured_file: bool,
) {
    let canonical = canonicalize_existing(file_path);
    let raw = match fs::read_to_string(file_path) {
        Ok(text) => text,
        Err(error) => {
            diagnostics.push(SkillDiagnostic {
                path: Some(file_path.to_string_lossy().into_owned()),
                message: error.to_string(),
            });
            return;
        }
    };
    let frontmatter = parse_frontmatter(&raw);
    let skill_dir = file_path.parent().unwrap_or(Path::new("")).to_path_buf();
    let parent_name = skill_dir
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let description = frontmatter
        .description
        .unwrap_or_default()
        .trim()
        .to_string();
    let name = frontmatter.name.unwrap_or(parent_name);
    if description.is_empty() {
        diagnostics.push(SkillDiagnostic {
            path: Some(file_path.to_string_lossy().into_owned()),
            message: "description is required".into(),
        });
        return;
    }
    if description.chars().count() > MAX_DESCRIPTION_LENGTH {
        diagnostics.push(SkillDiagnostic {
            path: Some(file_path.to_string_lossy().into_owned()),
            message: format!("description exceeds {} characters", MAX_DESCRIPTION_LENGTH),
        });
    }
    for err in validate_skill_name(&name) {
        diagnostics.push(SkillDiagnostic {
            path: Some(file_path.to_string_lossy().into_owned()),
            message: err,
        });
    }
    out.push(DiscoveredSkill {
        canonical_path: canonical.to_string_lossy().into_owned(),
        file_path: file_path.to_path_buf(),
        skill_dir,
        name,
        description,
        disable_model_invocation: frontmatter.disable_model_invocation,
        is_configured_file,
    });
}

fn discover_skills_from_root(
    root: &Path,
    diagnostics: &mut Vec<SkillDiagnostic>,
) -> Vec<DiscoveredSkill> {
    if !root.exists() {
        return Vec::new();
    }
    let mut out = Vec::new();
    // A configured plain entry may point at a single skill file.
    if root.is_file() {
        if root.extension().and_then(|e| e.to_str()) != Some("md") {
            diagnostics.push(SkillDiagnostic {
                path: Some(root.to_string_lossy().into_owned()),
                message: "configured skill file must be Markdown".into(),
            });
            return out;
        }
        push_skill(root, diagnostics, &mut out, true);
        return out;
    }
    let matcher = IgnoreMatcher::build(root);
    fn collect(
        dir: &Path,
        root: &Path,
        matcher: &IgnoreMatcher,
        diagnostics: &mut Vec<SkillDiagnostic>,
        out: &mut Vec<DiscoveredSkill>,
    ) {
        let entries = match fs::read_dir(dir) {
            Ok(e) => e,
            Err(_) => return,
        };
        let names: Vec<_> = entries
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        // SKILL.md in this dir → one skill, stop recursion under it.
        if names.iter().any(|n| n == "SKILL.md") {
            let full = dir.join("SKILL.md");
            if full.is_file() {
                let rel = to_posix(&full.strip_prefix(root).unwrap_or(&full).to_string_lossy());
                if !matcher.ignores(&rel, false) {
                    push_skill(&full, diagnostics, out, false);
                }
            }
            return;
        }
        for name in &names {
            if name.starts_with('.') || name == "node_modules" {
                continue;
            }
            let full = dir.join(name);
            let meta = match fs::metadata(&full) {
                Ok(m) => m,
                Err(_) => continue,
            };
            let rel = to_posix(&full.strip_prefix(root).unwrap_or(&full).to_string_lossy());
            if meta.is_dir() && !matcher.ignores(&format!("{rel}/"), true) {
                collect(&full, root, matcher, diagnostics, out);
            }
        }
    }
    collect(root, root, &matcher, diagnostics, &mut out);
    dedupe_by_canonical(&mut out)
}

fn dedupe_by_canonical(skills: &mut Vec<DiscoveredSkill>) -> Vec<DiscoveredSkill> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for s in skills.drain(..) {
        if seen.insert(s.canonical_path.clone()) {
            out.push(s);
        }
    }
    out
}

// ── Revision + tree building ──────────────────────────────────────────

fn tree_path(skill: &DiscoveredSkill, source: &str) -> Vec<String> {
    let rel = to_posix(
        &skill
            .skill_dir
            .strip_prefix(source)
            .unwrap_or(&skill.skill_dir)
            .to_string_lossy(),
    );
    if rel.is_empty() {
        Vec::new()
    } else {
        rel.split('/')
            .filter(|p| !p.is_empty())
            .map(String::from)
            .collect()
    }
}

fn build_revision(
    source: &str,
    skills: &[DiscoveredSkill],
    memberships: &BTreeSet<String>,
) -> String {
    let mut hash = Sha256::new();
    length_delimited_hash(&mut hash, "root");
    length_delimited_hash(&mut hash, source);
    let mut sorted: Vec<&DiscoveredSkill> = skills.iter().collect();
    sorted.sort_by(|a, b| a.canonical_path.cmp(&b.canonical_path));
    for skill in sorted {
        length_delimited_hash(&mut hash, "candidate");
        length_delimited_hash(&mut hash, &skill.canonical_path);
        let content = fs::read_to_string(&skill.file_path).unwrap_or_default();
        let mut content_hash = Sha256::new();
        content_hash.update(content.as_bytes());
        length_delimited_hash(&mut hash, &hex::encode(content_hash.finalize()));
        length_delimited_hash(&mut hash, &skill.name);
        length_delimited_hash(&mut hash, &skill.description);
    }
    for membership in memberships {
        length_delimited_hash(&mut hash, "group");
        length_delimited_hash(&mut hash, membership);
    }
    hex::encode(hash.finalize())
}

fn empty_scan(source_id: &str, canonical: &str, revision_suffix: &str) -> SkillInstallScan {
    let mut hash = Sha256::new();
    length_delimited_hash(&mut hash, "root");
    length_delimited_hash(&mut hash, canonical);
    length_delimited_hash(&mut hash, revision_suffix);
    SkillInstallScan {
        source_id: source_id.to_string(),
        display_canonical_source_path: canonical.to_string(),
        scan_revision: hex::encode(hash.finalize()),
        tree: Vec::new(),
        default_selection: Vec::new(),
        diagnostics: Vec::new(),
    }
}

/// Scan a chosen source directory and return an opaque candidate tree.
/// Mirrors scanSkillInstallSource in skill-installation.ts.
pub fn scan_install_source(
    binding: &SkillSourceBinding,
    context: &InstallContext,
) -> SkillInstallScan {
    let canonical_source = canonicalize_existing(&binding.canonical_path);
    let canonical_str = canonical_source.to_string_lossy().into_owned();
    let meta = match fs::metadata(&canonical_source) {
        Ok(m) => m,
        Err(_) => {
            let mut scan = empty_scan(&binding.source_id, &canonical_str, "missing");
            scan.diagnostics.push(SkillDiagnostic {
                path: Some(canonical_str.clone()),
                message: "source directory is not accessible".into(),
            });
            return scan;
        }
    };
    if !meta.is_dir() {
        let mut scan = empty_scan(&binding.source_id, &canonical_str, "file");
        scan.diagnostics.push(SkillDiagnostic {
            path: Some(canonical_str.clone()),
            message: "source is not a directory".into(),
        });
        return scan;
    }
    let mut diagnostics = Vec::new();
    let mut skills = discover_skills_from_root(&canonical_source, &mut diagnostics);
    // Build group membership set (all ancestor prefixes of each skill path).
    let mut memberships: BTreeSet<String> = BTreeSet::new();
    let canonical_str_for_paths = canonical_str.clone();
    for skill in &skills {
        let parts = tree_path(skill, &canonical_str_for_paths);
        for i in 1..parts.len() {
            memberships.insert(parts[..i].join("/"));
        }
    }
    let revision = build_revision(&canonical_str, &skills, &memberships);

    let mut tree: Vec<SkillTreeNode> = Vec::new();
    let mut groups: HashMap<String, SkillInstallGroup> = HashMap::new();
    let mut default_selection: Vec<InstallCandidateSelection> = Vec::new();

    fn ensure_group(
        path_parts: &[String],
        groups: &mut HashMap<String, SkillInstallGroup>,
        tree: &mut Vec<SkillTreeNode>,
        key: &str,
        source_id: &str,
        revision: &str,
    ) -> SkillInstallGroup {
        let path = path_parts.join("/");
        if let Some(existing) = groups.get(&path) {
            return existing.clone();
        }
        let group = SkillInstallGroup {
            kind: "group",
            id: opaque_id(key, source_id, revision, "group", &path),
            name: path_parts.last().cloned().unwrap_or_default(),
            children: Vec::new(),
        };
        groups.insert(path.clone(), group.clone());
        if path_parts.len() == 1 {
            tree.push(SkillTreeNode::Group(group));
        } else {
            let parent = ensure_group(
                &path_parts[..path_parts.len() - 1],
                groups,
                tree,
                key,
                source_id,
                revision,
            );
            if let Some(SkillTreeNode::Group(parent_node)) = tree
                .iter_mut()
                .find(|n| matches!(n, SkillTreeNode::Group(g) if g.id == parent.id))
            {
                parent_node.children.push(SkillTreeNode::Group(group));
            }
        }
        groups.get(&path).cloned().unwrap()
    }

    skills.sort_by(|a, b| a.canonical_path.cmp(&b.canonical_path));
    let _ = std::mem::take(&mut skills); // reborrow sorted
                                         // Re-collect sorted (the drain consumed them for the lifetime dance).
    let mut sorted_skills = discover_skills_from_root(&canonical_source, &mut Vec::new());
    sorted_skills.sort_by(|a, b| a.canonical_path.cmp(&b.canonical_path));
    for skill in &sorted_skills {
        let parts = tree_path(skill, &canonical_str_for_paths);
        let id = opaque_id(
            &context.install_secret,
            &binding.source_id,
            &revision,
            "skill",
            &skill.canonical_path,
        );
        let candidate = SkillInstallCandidate {
            kind: "skill",
            id: id.clone(),
            name: skill.name.clone(),
            description: skill.description.clone(),
            display_canonical_path: canonicalize_existing(&skill.skill_dir)
                .to_string_lossy()
                .into_owned(),
        };
        if parts.is_empty() {
            tree.push(SkillTreeNode::Candidate(candidate));
        } else {
            let _group = ensure_group(
                &parts,
                &mut groups,
                &mut tree,
                &context.install_secret,
                &binding.source_id,
                &revision,
            );
            if let Some(SkillTreeNode::Group(group_node)) = tree
                .iter_mut()
                .find(|n| matches!(n, SkillTreeNode::Group(g) if g.id == _group.id))
            {
                group_node
                    .children
                    .push(SkillTreeNode::Candidate(candidate));
            }
        }
        default_selection.push(InstallCandidateSelection {
            kind: "skill".into(),
            id,
        });
    }
    SkillInstallScan {
        source_id: binding.source_id.clone(),
        display_canonical_source_path: canonical_str,
        scan_revision: revision,
        tree,
        default_selection,
        diagnostics,
    }
}

// ── Settings lock + read/write ────────────────────────────────────────

fn settings_lock_dir(settings_path: &Path) -> PathBuf {
    let mut s = settings_path.as_os_str().to_string_lossy().into_owned();
    s.push_str(".lock");
    PathBuf::from(s)
}

/// Cross-process settings lock compatible with Pi's proper-lockfile mkdir
/// strategy. Acquires an empty directory at `<settings>.lock`, clearing
/// stale holders (mtime older than 10s) like Pi does.
fn with_settings_lock<R>(settings_path: &Path, critical: impl FnOnce() -> R) -> Result<R, String> {
    let lock_dir = settings_lock_dir(settings_path);
    if let Some(parent) = settings_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Cannot create settings dir: {e}"))?;
    }
    for _ in 0..SETTINGS_LOCK_MAX_ATTEMPTS {
        match fs::create_dir(&lock_dir) {
            Ok(()) => {
                let result = critical();
                let _ = fs::remove_dir(&lock_dir);
                return Ok(result);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                // Staleness check.
                match fs::metadata(&lock_dir) {
                    Ok(meta) => {
                        let mtime = meta
                            .modified()
                            .ok()
                            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                            .map(|d| d.as_millis() as u64)
                            .unwrap_or(0);
                        let now = std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .map(|d| d.as_millis() as u64)
                            .unwrap_or(0);
                        if now.saturating_sub(mtime) > SETTINGS_LOCK_STALE_MS {
                            let _ = fs::remove_dir(&lock_dir);
                            continue;
                        }
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                    Err(error) => return Err(format!("Settings lock stat failed: {error}")),
                }
                std::thread::sleep(std::time::Duration::from_millis(
                    SETTINGS_LOCK_RETRY_DELAY_MS,
                ));
            }
            Err(error) => return Err(format!("Cannot acquire settings lock: {error}")),
        }
    }
    Err(format!(
        "Timed out waiting for settings lock: {}",
        lock_dir.display()
    ))
}

/// Read Pi settings as a JSON object, migrating the legacy
/// `{ skills: { enableSkillCommands, customDirectories } }` shape (mirrors
/// migrateLegacySkills in skill-inventory.ts).
fn read_settings_object(settings_path: &Path) -> Result<Map<String, Value>, String> {
    if !settings_path.exists() {
        return Ok(Map::new());
    }
    let text = fs::read_to_string(settings_path)
        .map_err(|e| format!("Cannot read settings {}: {e}", settings_path.display()))?;
    let parsed: Value = serde_json::from_str(&text).map_err(|e| {
        format!(
            "Pi settings at {} must be valid JSON: {e}",
            settings_path.display()
        )
    })?;
    let mut obj = match parsed {
        Value::Object(map) => map,
        _ => {
            return Err(format!(
                "Pi settings must be a JSON object: {}",
                settings_path.display()
            ))
        }
    };
    migrate_legacy_skills(&mut obj);
    Ok(obj)
}

fn migrate_legacy_skills(settings: &mut Map<String, Value>) {
    let Some(skills) = settings.get("skills").cloned() else {
        return;
    };
    let Some(skills_obj) = skills.as_object() else {
        return;
    };
    if let Some(enable) = skills_obj.get("enableSkillCommands") {
        if !settings.contains_key("enableSkillCommands") {
            settings.insert("enableSkillCommands".into(), enable.clone());
        }
    }
    if let Some(custom) = skills_obj
        .get("customDirectories")
        .and_then(|v| v.as_array())
    {
        let dirs: Vec<Value> = custom
            .iter()
            .filter(|v| v.as_str().is_some())
            .cloned()
            .collect();
        if dirs.is_empty() {
            settings.remove("skills");
        } else {
            settings.insert("skills".into(), Value::Array(dirs));
        }
    } else {
        settings.remove("skills");
    }
}

fn write_settings_atomically(settings_path: &Path, next: &Value) -> Result<(), String> {
    let dir = settings_path.parent().unwrap_or(Path::new(""));
    fs::create_dir_all(dir).map_err(|e| format!("Cannot create settings dir: {e}"))?;
    let tmp = dir.join(format!(
        ".picot-skills-{}.tmp",
        uuid::Uuid::new_v4().simple()
    ));
    let pretty = serde_json::to_string_pretty(next).map_err(|e| e.to_string())?;
    if let Err(error) = fs::write(&tmp, format!("{pretty}\n")) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("Cannot write settings: {error}"));
    }
    if let Err(error) = fs::rename(&tmp, settings_path) {
        let _ = fs::remove_file(&tmp);
        return Err(format!(
            "Cannot replace settings {}: {error}",
            settings_path.display()
        ));
    }
    Ok(())
}

fn settings_skills(settings_path: &Path, _base_dir: &Path) -> Result<Vec<String>, String> {
    let obj = read_settings_object(settings_path)?;
    let skills = obj.get("skills").and_then(|v| v.as_array());
    Ok(skills
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default())
}

fn existing_canonical_path(entry: &str, base_dir: &Path) -> PathBuf {
    let target = base_dir.join(entry);
    canonicalize_existing(&target)
}

/// Collect all descendant candidates of a tree node.
fn flatten_candidates(node: &SkillTreeNode) -> Vec<&SkillInstallCandidate> {
    match node {
        SkillTreeNode::Candidate(c) => vec![c],
        SkillTreeNode::Group(g) => g.children.iter().flat_map(flatten_candidates).collect(),
    }
}

fn node_by_id(tree: &[SkillTreeNode]) -> HashMap<String, &SkillTreeNode> {
    let mut nodes = HashMap::new();
    fn visit<'a>(items: &'a [SkillTreeNode], nodes: &mut HashMap<String, &'a SkillTreeNode>) {
        for item in items {
            match item {
                SkillTreeNode::Group(g) => {
                    nodes.insert(g.id.clone(), item);
                    visit(&g.children, nodes);
                }
                SkillTreeNode::Candidate(c) => {
                    nodes.insert(c.id.clone(), item);
                }
            }
        }
    }
    visit(tree, &mut nodes);
    nodes
}

fn common_directory(paths: &[PathBuf]) -> Result<PathBuf, String> {
    if paths.is_empty() {
        return Err("Invalid skill install selection".into());
    }
    if paths.len() == 1 {
        return Ok(paths[0].clone());
    }
    let first = &paths[0];
    let components: Vec<Vec<_>> = paths
        .iter()
        .map(|p| p.components().collect::<Vec<_>>())
        .collect();
    let mut common: Vec<_> = Vec::new();
    for index in 0.. {
        let next = components[0].get(index);
        if next.is_none() || components.iter().any(|c| c.get(index) != next) {
            break;
        }
        common.push(next.unwrap());
    }
    let result: PathBuf = common.iter().collect();
    if result.as_os_str().is_empty() {
        Ok(first.clone())
    } else {
        Ok(result)
    }
}

/// Build the additions/skipped preview from a scan + selection. Mirrors
/// buildSkillInstallPreview in skill-installation.ts.
fn build_install_preview(
    scan: &SkillInstallScan,
    _scope: &str,
    selection: &[InstallCandidateSelection],
    base_dir: &Path,
) -> Result<(Vec<String>, Vec<String>), String> {
    let nodes = node_by_id(&scan.tree);
    let mut selected_paths: BTreeSet<PathBuf> = BTreeSet::new();
    for item in selection {
        let node = nodes
            .get(&item.id)
            .ok_or_else(|| "Invalid skill install selection".to_string())?;
        match node {
            SkillTreeNode::Candidate(c) => {
                selected_paths.insert(PathBuf::from(&c.display_canonical_path));
            }
            SkillTreeNode::Group(_g) => {
                let paths: Vec<PathBuf> = flatten_candidates(node)
                    .iter()
                    .map(|c| PathBuf::from(&c.display_canonical_path))
                    .collect();
                selected_paths.insert(common_directory(&paths)?);
            }
        }
        // Validate kind matches (TS: node.kind !== item.kind).
        let kind = match node {
            SkillTreeNode::Candidate(_) => "skill",
            SkillTreeNode::Group(_) => "group",
        };
        if kind != item.kind {
            return Err("Invalid skill install selection".into());
        }
    }
    let settings_path = base_dir.join("settings.json");
    let existing = settings_skills(&settings_path, base_dir)?;
    let configured: HashSet<PathBuf> = existing
        .iter()
        .filter(|e| !e.starts_with('!') && !e.starts_with('+') && !e.starts_with('-'))
        .map(|e| existing_canonical_path(e, base_dir))
        .collect();

    let mut additions = Vec::new();
    let mut skipped = Vec::new();
    for path in &selected_paths {
        if configured.contains(path) {
            skipped.push(path.to_string_lossy().into_owned());
            continue;
        }
        let encoded = to_posix(
            &path
                .strip_prefix(base_dir)
                .unwrap_or(path)
                .to_string_lossy(),
        );
        if encoded.is_empty() || encoded.starts_with("../") || encoded == ".." {
            additions.push(if encoded.is_empty() {
                path.to_string_lossy().into_owned()
            } else {
                encoded
            });
        } else {
            additions.push(format!("./{encoded}"));
        }
    }
    Ok((additions, skipped))
}

/// Install selected skill links into Pi's settings.json. Mirrors
/// installSkillLinks in skill-installation.ts: rescans to verify the
/// revision is fresh, takes the cross-process settings lock, builds the
/// preview, appends missing entries atomically.
pub fn install_links(
    binding: &SkillSourceBinding,
    scope: &str,
    scan_revision: &str,
    selection: &[InstallCandidateSelection],
    context: &InstallContext,
) -> Result<SkillInstallResult, String> {
    let base_dir = context.base_dir(scope);
    let settings_path = base_dir.join("settings.json");

    // Rescan OUTSIDE the lock to verify freshness.
    let fresh_scan = scan_install_source(binding, context);
    if fresh_scan.scan_revision != scan_revision || fresh_scan.source_id != binding.source_id {
        return Err("Skill install source changed; rescan and confirm again".into());
    }

    with_settings_lock(&settings_path, || -> Result<SkillInstallResult, String> {
        let (additions, skipped) = build_install_preview(&fresh_scan, scope, selection, &base_dir)?;
        let original = read_settings_object(&settings_path)?;
        let current_skills: Vec<Value> = original
            .get("skills")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter(|v| v.as_str().is_some())
                    .cloned()
                    .collect()
            })
            .unwrap_or_default();
        if !additions.is_empty() {
            let mut next = original;
            let mut merged = current_skills;
            for addition in &additions {
                merged.push(Value::String(addition.clone()));
            }
            next.insert("skills".into(), Value::Array(merged));
            write_settings_atomically(&settings_path, &Value::Object(next))?;
        }
        Ok(SkillInstallResult {
            scan: fresh_scan,
            added_entries: additions,
            skipped_entries: skipped,
            settings_changed: false,
            runtime_restart_required: true,
        })
    })?
    .map(|mut result| {
        result.settings_changed = !result.added_entries.is_empty();
        result
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::skill_source_registry::SkillSourceBinding;
    use crate::window_owner::OwnerId;
    use std::fs;
    use tempfile::tempdir;

    fn binding(source_dir: &Path, secret: &str) -> (SkillSourceBinding, InstallContext) {
        let binding = SkillSourceBinding {
            source_id: "src-1".into(),
            canonical_path: source_dir.to_path_buf(),
            owner_id: OwnerId::from_client_id("client-1"),
            window_label: "client-1".into(),
            workspace_root: source_dir.to_path_buf(),
            workspace_port: 0,
            workspace_generation: 0,
        };
        let context = InstallContext {
            agent_dir: source_dir.to_path_buf(),
            cwd: source_dir.to_path_buf(),
            install_secret: secret.into(),
        };
        (binding, context)
    }

    fn write_skill(dir: &Path, name: &str, description: &str) {
        fs::create_dir_all(dir).unwrap();
        fs::write(
            dir.join("SKILL.md"),
            format!("---\nname: {name}\ndescription: {description}\n---\n# {name}\n"),
        )
        .unwrap();
    }

    #[test]
    fn scan_finds_single_skill_with_description() {
        let tmp = tempdir().unwrap();
        // SKILL.md at the source root itself → one top-level candidate.
        write_skill(tmp.path(), "release-notes", "Cut a release");
        let (binding, context) = binding(tmp.path(), "secret");
        let scan = scan_install_source(&binding, &context);
        assert!(scan.diagnostics.is_empty(), "{:?}", scan.diagnostics);
        assert_eq!(scan.tree.len(), 1);
        match &scan.tree[0] {
            SkillTreeNode::Candidate(c) => {
                assert_eq!(c.name, "release-notes");
                assert_eq!(c.description, "Cut a release");
            }
            other => panic!("expected candidate, got {other:?}"),
        }
        assert_eq!(scan.default_selection.len(), 1);
        assert!(!scan.scan_revision.is_empty());
    }

    #[test]
    fn scan_builds_nested_groups_and_dedupes_by_canonical() {
        let tmp = tempdir().unwrap();
        write_skill(&tmp.path().join("group-a/skill-one"), "skill-one", "First");
        write_skill(&tmp.path().join("group-a/skill-two"), "skill-two", "Second");
        write_skill(
            &tmp.path().join("group-b/skill-three"),
            "skill-three",
            "Third",
        );
        let (binding, context) = binding(tmp.path(), "secret");
        let scan = scan_install_source(&binding, &context);
        // Top level: two groups.
        assert_eq!(scan.tree.len(), 2, "{:?}", scan.tree);
        let group_names: Vec<_> = scan
            .tree
            .iter()
            .filter_map(|n| match n {
                SkillTreeNode::Group(g) => Some(g.name.clone()),
                _ => None,
            })
            .collect();
        assert!(group_names.contains(&"group-a".to_string()));
        assert!(group_names.contains(&"group-b".to_string()));
        // defaultSelection covers all 3 skills.
        assert_eq!(scan.default_selection.len(), 3);
    }

    #[test]
    fn scan_rejects_skill_without_description() {
        let tmp = tempdir().unwrap();
        let skill_dir = tmp.path().join("no-desc");
        fs::create_dir_all(&skill_dir).unwrap();
        fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: no-desc\n---\nbody\n",
        )
        .unwrap();
        let (binding, context) = binding(tmp.path(), "secret");
        let scan = scan_install_source(&binding, &context);
        assert!(scan.tree.is_empty(), "no candidate should surface");
        assert!(
            scan.diagnostics
                .iter()
                .any(|d| d.message.contains("description is required")),
            "{:?}",
            scan.diagnostics
        );
    }

    #[test]
    fn install_appends_relative_entries_and_skips_existing() {
        let tmp = tempdir().unwrap();
        let agent = tmp.path().join("agent");
        let source = tmp.path().join("source");
        write_skill(&source.join("notes"), "release-notes", "Cut a release");

        // Pre-seed global settings with the skill already configured so the
        // install must skip it.
        fs::create_dir_all(&agent).unwrap();
        fs::write(
            agent.join("settings.json"),
            format!(
                "{{\"skills\":[\"{}\"]}}\n",
                source.join("notes").to_string_lossy().replace('\\', "/")
            ),
        )
        .unwrap();

        let binding = SkillSourceBinding {
            source_id: "src-1".into(),
            canonical_path: source.clone(),
            owner_id: OwnerId::from_client_id("client-1"),
            window_label: "client-1".into(),
            workspace_root: tmp.path().to_path_buf(),
            workspace_port: 0,
            workspace_generation: 0,
        };
        let context = InstallContext {
            agent_dir: agent.clone(),
            cwd: tmp.path().to_path_buf(),
            install_secret: "secret".into(),
        };
        // First scan to get a valid revision.
        let scan = scan_install_source(&binding, &context);
        let selection = scan.default_selection.clone();
        let result = install_links(
            &binding,
            "global",
            &scan.scan_revision,
            &selection,
            &context,
        )
        .expect("install should succeed");
        // Already configured → skipped, nothing added.
        assert!(
            result.added_entries.is_empty(),
            "{:?}",
            result.added_entries
        );
        assert!(!result.skipped_entries.is_empty());
        assert!(!result.settings_changed);
    }

    #[test]
    fn install_writes_new_skill_entry_atomically() {
        let tmp = tempdir().unwrap();
        let agent = tmp.path().join("agent");
        let source = tmp.path().join("source");
        write_skill(&source.join("fresh"), "fresh-skill", "A brand new skill");

        let binding = SkillSourceBinding {
            source_id: "src-2".into(),
            canonical_path: source.clone(),
            owner_id: OwnerId::from_client_id("client-2"),
            window_label: "client-2".into(),
            workspace_root: tmp.path().to_path_buf(),
            workspace_port: 0,
            workspace_generation: 0,
        };
        let context = InstallContext {
            agent_dir: agent.clone(),
            cwd: tmp.path().to_path_buf(),
            install_secret: "secret".into(),
        };
        let scan = scan_install_source(&binding, &context);
        let result = install_links(
            &binding,
            "global",
            &scan.scan_revision,
            &scan.default_selection,
            &context,
        )
        .expect("install should succeed");
        assert!(!result.added_entries.is_empty());
        assert!(result.settings_changed);
        // settings.json now contains a skills array with at least one entry.
        let written: Value =
            serde_json::from_str(&fs::read_to_string(agent.join("settings.json")).unwrap())
                .unwrap();
        let skills = written.get("skills").and_then(|v| v.as_array()).unwrap();
        assert!(skills.iter().any(|v| v.as_str().unwrap().contains("fresh")));
    }

    #[test]
    fn install_rejects_stale_revision() {
        let tmp = tempdir().unwrap();
        let source = tmp.path().join("source");
        write_skill(&source.join("a"), "a", "desc a");
        let binding = SkillSourceBinding {
            source_id: "src-3".into(),
            canonical_path: source,
            owner_id: OwnerId::from_client_id("client-3"),
            window_label: "client-3".into(),
            workspace_root: tmp.path().to_path_buf(),
            workspace_port: 0,
            workspace_generation: 0,
        };
        let context = InstallContext {
            agent_dir: tmp.path().join("agent"),
            cwd: tmp.path().to_path_buf(),
            install_secret: "secret".into(),
        };
        let result = install_links(&binding, "global", "stale-revision", &[], &context);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("changed"));
    }
}
