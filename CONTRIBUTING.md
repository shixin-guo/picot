# Contributing to Picot

Thanks for taking the time to contribute. This document covers the practical
steps for getting a change merged. For architecture, module conventions, and
the full command reference, see [`AGENTS.md`](./AGENTS.md) — it is written
for both humans and coding agents working in this repo.

## Before you start

- For anything beyond a small fix, open an issue first to discuss the
  approach. This avoids wasted work on changes that don't fit the project's
  direction.
- Check open issues and pull requests to avoid duplicating work.

## Development setup

```bash
git clone https://github.com/shixin-guo/picot.git
cd picot
bun install --frozen-lockfile
bun run dev      # fetches the embedded pi binary, starts tauri dev with hot reload
```

This project uses **Bun** exclusively. Never run `npm install` / `npm ci` —
that creates a stray `package-lock.json` that drifts from `bun.lock`.

## Making a change

1. Create a branch off `main`.
2. Make your change. Keep pull requests focused — one logical change per PR.
3. Run the checks that apply to what you touched:

   ```bash
   bun run check         # Biome lint + format (JS/TS under public/, extensions/)
   bun run test           # vitest + Tauri permission check
   bun run check:rust     # cargo check + clippy + fmt (after any Rust edit)
   ```

   Single test file: `bun run vitest run public/settings-save-status.test.js`

4. If you touched CSS, UI markup, or inline styles, read
   [`docs/DESIGN.md`](docs/DESIGN.md) first and use tokens from
   `public/style-theme.css` / `public/design-system.css` rather than literal
   dimensions.
5. Commit with a clear, descriptive message. Conventional prefixes
   (`feat:`, `fix:`, `chore:`, `refactor:`, `docs:`) are used throughout the
   project's history and are appreciated but not mandatory.

## Pull requests

- Fill in the PR template — describe what changed and why, and how you
  tested it.
- CI runs Biome checks, the vitest suite, and Rust checks (`cargo check`,
  `clippy`, unit tests, `cargo fmt --check`) on every PR. Please make sure
  these pass, or explain in the PR why a failure is expected/pre-existing.
- Keep the diff scoped to the stated purpose of the PR — unrelated
  refactors or formatting churn make review harder.

## Reporting bugs / requesting features

Use the issue templates under **New Issue**. Include reproduction steps,
your OS/platform, and the Picot version for bug reports.

## Security issues

Do not open a public issue for a security vulnerability — see
[`SECURITY.md`](./SECURITY.md) for how to report it privately.

## Code of conduct

Participation in this project is governed by our
[Code of Conduct](./CODE_OF_CONDUCT.md).
