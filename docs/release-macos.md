# macOS release policy

This project publishes macOS artifacts to intentionally trigger the Gatekeeper
"developer cannot be verified" path (not a damaged app path).

For Apple Silicon compatibility and stable Gatekeeper behavior, macOS bundles
must be signed consistently at bundle level using Tauri's ad-hoc identity.

## Rules

- Use `bundle.macOS.signingIdentity = "-"` so the entire app bundle is signed.
- Do not modify `.app` contents after Tauri bundling.
- Use standard Tauri bundling (`tauri build --bundles dmg`) only.
- Publish the generated `.dmg` directly.

## Release command

```bash
bun run release:mac:dmg
```

The script:

1. Builds DMG via Tauri.
2. Mounts the DMG and inspects the bundled `.app`.
3. Verifies bundle signature integrity.
4. Fails if Gatekeeper reports damaged/invalid sealed resources.
5. Prints Gatekeeper assessment output for release records.

## Expected end-user flow

1. Drag app to `/Applications`.
2. Right-click **Open**.
3. Go to **Privacy & Security**.
4. Click **Open Anyway**.
