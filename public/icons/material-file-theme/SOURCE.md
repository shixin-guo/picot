# Material Icon Theme — vendored vocabulary source manifest

This directory documents the pinned upstream source for the curated,
trusted-local object-icon vocabulary embedded in
`public/file-type-icons.js`.

## Upstream

- **Project:** vscode-material-icon-theme
- **Author:** Philipp Kief (<https://github.com/PKief>)
- **License:** MIT (see `LICENSE` below)
- **Repository:** <https://github.com/vscode-material-icon-theme/vscode-material-icon-theme>
- **Pinned release tag:** v5.x (latest stable at the time of vendoring)

## What is vendored

Only a curated **whitelist** of object-icon names required by the
integrated UI modernization plan is represented, as trusted inline SVG
definitions inside `public/file-type-icons.js`. **No upstream asset files
are copied verbatim**; the inline definitions are Picot-authored SVG that
reproduce the Material Icon Theme visual language (folder, source file,
config document) for object recognition. No remote URL, emoji fallback,
or Material asset is ever used for an action control.

Vendored vocabulary (resolver names): `folder`, `folder-open`,
`folder-git`, `folder-git-open`, `file`, `ts`, `js`, `python`, `json`,
`markdown`, `html`, `css`, `yaml`, `toml`, `shell`, `rust`, `image`,
`pdf`, `env`, `lock`, `config`.

## Policy

- File/Git object icons use these trusted local definitions only.
- Action controls (maximize, minimize, text-collapse, refresh-cw, etc.)
  remain the separate local monochrome registry in `public/icons.js`
  and never reuse Material artwork.

## LICENSE (upstream MIT)

```
MIT License

Copyright (c) Philipp Kief and contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
