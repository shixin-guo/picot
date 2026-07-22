// ABOUTME: Owns Super Agent navigation cleanup when a regular session is selected.
// ABOUTME: Exposes an explicit installer so the behavior has a controllable lifecycle.

export function installSuperAgentSessionNavigationReset(documentRef = document) {
  const sessionList = documentRef.getElementById("session-list");
  if (!sessionList) return () => {};

  const onSessionClick = (event) => {
    if (!event.target.closest?.(".session-item")) return;
    documentRef.body.classList.remove("super-agent-active");
    documentRef.getElementById("super-agent-sidebar-entry")?.classList.remove("active");
    documentRef.getElementById("super-agent-chat-header")?.classList.add("hidden");
  };

  sessionList.addEventListener("click", onSessionClick);
  return () => sessionList.removeEventListener("click", onSessionClick);
}
