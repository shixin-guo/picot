# Bug Fix: Folder Picker Freeze

## Problem

Opening a workspace folder and then closing Finder caused the application to freeze.

### Root Cause

The `open_folder_as_workspace` Tauri command was using `blocking_pick_folder()` in a **synchronous** command handler. This violated Tauri v2 best practices:

- `blocking_pick_folder()` blocks the thread while waiting for user input
- When called from a sync command, it blocks the main thread
- Blocking the main thread freezes the event loop
- macOS Finder interactions can take time, especially if the user cancels or delays

```rust
// ❌ BEFORE: synchronous command with blocking call
#[tauri::command]
fn open_folder_as_workspace(app: AppHandle) -> Result<Option<String>, String> {
    let Some(picked) = app.dialog().file().blocking_pick_folder() else {
        return Ok(None);
    };
    // ...
}
```

## Solution

Changed the command to **async**. Tauri automatically runs async commands in a background thread pool, preventing the main thread from freezing:

```rust
// ✅ AFTER: async command with blocking call
#[tauri::command]
async fn open_folder_as_workspace(app: AppHandle) -> Result<Option<String>, String> {
    let Some(picked) = app.dialog().file().blocking_pick_folder() else {
        return Ok(None);
    };
    // ...
}
```

## Tauri Dialog Best Practices

Per [Tauri v2 docs](https://docs.rs/tauri-plugin-dialog/latest/tauri_plugin_dialog/struct.FileDialogBuilder.html):

- **`blocking_pick_folder()`** - blocking operation, use in **async commands** or background threads
- **`pick_folder(callback)`** - non-blocking (callback-based), use on main thread

The fix aligns with the documented pattern:

```rust
#[tauri::command]
async fn my_command(app: tauri::AppHandle) {
  let folder_path = app.dialog().file().blocking_pick_folder();
  // ✅ This is safe because Tauri runs async commands off the main thread
}
```

## Related Files

- `src-tauri/src/main.rs` - `open_folder_as_workspace` function
- `public/native/workspace-actions.js` - frontend button wiring

## Testing

Manual verification:
1. Click "Open folder as workspace"
2. System folder picker appears
3. Close Finder app while picker is open
4. ✅ Application should remain responsive (no freeze)
