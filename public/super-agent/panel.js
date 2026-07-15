/**
 * super-agent/panel.js
 *
 * Legacy entry point kept for compatibility.
 * All logic has been migrated to Web Components under components/:
 *
 *   <super-agent-entry>   → components/super-agent-entry.js
 *   <super-agent-runtime> → components/super-agent-runtime.js
 *   <sa-chat-header>      → components/sa-chat-header.js
 *   <chat-settings-panel> → components/chat-settings-panel.js
 *
 * Only keeps the session-list click handler that deactivates SA mode
 * when the user navigates away.
 */

function initSuperAgentListeners() {
  document.getElementById("session-list")?.addEventListener("click", (e) => {
    if (e.target.closest(".session-item")) {
      document.body.classList.remove("super-agent-active");
      document.getElementById("super-agent-sidebar-entry")?.classList.remove("active");
      document.getElementById("super-agent-chat-header")?.classList.add("hidden");
    }
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initSuperAgentListeners);
} else {
  initSuperAgentListeners();
}
