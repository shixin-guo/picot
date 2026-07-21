# Picot design system

Picot uses CSS custom properties and reusable `.ui-*` primitives to keep the desktop UI consistent. The CSS variables in `public/style-theme.css` are the single source of truth.

## CSS layers

Load styles in this order:

1. `style-theme.css` — foundation and theme tokens
2. `design-system.css` — reusable UI primitives
3. `style.css` / `cost.css` — page and domain-specific layout

Business styles may position a component or represent domain state, but must not duplicate a primitive's typography, dimensions, colors, or generic interaction states.

## Foundation tokens

### Typography

Use only the shared type scale:

- `--font-size-sm`: metadata and compact labels
- `--font-size-md`: default body and controls
- `--font-size-lg`: prominent labels and small headings
- `--font-size-xl`: headings
- `--font-size-2xl`: display values

Do not add a token merely to preserve an isolated historical font size. Choose the closest semantic level and visually review the result.

Define `font-family` only once on the top-level `body` of each document. Descendants must use normal CSS inheritance; do not add component-level `font-family` declarations, including redundant `font-family: inherit` or monospace overrides.

### Spacing

Spacing follows a 4px base scale. `--space-0-5` and `--space-1-5` exist for dense desktop controls. Prefer the scale over literal values in `gap`, `padding`, and component spacing.

### Control heights

- `--control-height-xs` (24px): dense toolbars only
- `--control-height-sm` (28px): compact controls
- `--control-height-md` (32px): default controls
- `--control-height-lg` (40px): primary actions and spacious forms

The default `.ui-*` control size is medium. Add a size modifier only for non-default sizes.

### Shape

Use `--radius-xs`, `--radius-sm`, `--radius-md`, `--radius`, `--radius-lg`, or `--radius-pill`. Do not introduce component-specific radius values.

## UI primitives

Primitives live in `public/design-system.css`:

- `.ui-button`
- `.ui-icon-button`
- `.ui-input`
- `.ui-textarea`
- `.ui-select`
- `.ui-badge`
- `.ui-panel`
- `.ui-card`
- `.ui-toolbar`

Button variants are `--primary`, `--secondary`, `--ghost`, and `--danger`. Size modifiers are `--xs`, `--sm`, and `--lg`; medium is the default.

```html
<button
  type="button"
  class="ui-button ui-button--primary save-settings-button"
>
  Save
</button>

<button
  type="button"
  class="ui-icon-button ui-icon-button--sm ui-icon-button--ghost new-session-btn"
  aria-label="New session"
>
  …
</button>
```

Keep business classes when migrating existing markup. `.ui-*` owns shared appearance; the business class owns positioning, domain state, JS hooks, and test selectors.

## Interaction and accessibility

The design system owns hover, active, focus-visible, disabled, busy, and invalid presentation. Prefer native semantics:

- Use `<button type="button">` for actions.
- Use `<a href>` for navigation.
- Use native `<input>`, `<textarea>`, and `<select>` elements.
- Use `disabled`, `aria-disabled`, `aria-busy`, and `aria-invalid` rather than visual-only state classes.
- Do not apply button styling to a `div` or `span` to simulate a control.

Domain states such as `.selected`, `.current`, or `.is-recording` remain in business CSS.

## Rules

Recommended:

```css
.settings-actions {
  display: flex;
  gap: var(--space-2);
}

.settings-title {
  font-size: var(--font-size-lg);
}
```

Avoid:

```css
.settings-button {
  height: 34px;
  padding: 7px 14px;
  border-radius: 9px;
  font-size: 13px;
}
```

Do not create one-off variables such as `--settings-special-gap` merely to satisfy the checker. Stable, repeated component semantics may become tokens; one-off page layouts should compose foundation tokens.

## Legitimate exceptions

Not every CSS dimension is a design token. Percentages, viewport units, calculated geometry, responsive breakpoints, dynamic measurements, one-pixel dividers, and chart geometry may be literal when they describe layout or rendering rather than visual scale.

For an exceptional fixed value that the checker cannot infer, explain it locally:

```css
/* design-token-ignore: fixed plotting area required by Chart.js */
.cost-chart-canvas {
  height: 300px;
}
```

An ignore without a reason is invalid. Do not use ignores for ordinary font sizes, control heights, padding, gaps, or radii.

## Checks

After changing CSS, UI markup, or inline styles, run:

```bash
bun run check
```

Useful focused commands:

```bash
bun run check:design
bun run check:design:fix
```

The fixer only performs exact token substitutions. Ambiguous values require human selection and visual review. Static inline styles in JavaScript are reported as warnings; dynamic measured geometry is allowed.

## Visual review checklist

Before completing a design-system migration, review:

- every built-in theme
- sidebar and header controls
- chat composer
- settings forms
- dialogs
- cost dashboard and charts
- hover, active, focus, disabled, busy, and invalid states
- narrow windows
- long text, truncation, wrapping, and icon alignment
