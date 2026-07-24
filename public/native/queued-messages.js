export function renderQueuedMessages(container, queue = {}) {
  if (!container) return;

  container.innerHTML = "";
  const items = [
    ...normalizeQueueItems(queue.steering, "Steering"),
    ...normalizeQueueItems(queue.followUp, "Follow-up"),
  ];

  container.classList.toggle("hidden", items.length === 0);
  for (const item of items) {
    const row = document.createElement("div");
    row.className = "queued-msg";

    const label = document.createElement("span");
    label.className = "queued-msg-label";
    label.textContent = item.label;

    const text = document.createElement("span");
    text.className = "queued-msg-text";
    text.textContent = item.message;

    row.append(label, text);
    container.appendChild(row);
  }
}

function normalizeQueueItems(messages, label) {
  return (messages ?? [])
    .map((message) => String(message ?? "").trim())
    .filter(Boolean)
    .map((message) => ({ label, message }));
}
