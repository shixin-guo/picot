const SEARCH_DEBOUNCE_MS = 300;
const MAX_TITLE_RESULTS = 12;
const MAX_RECENT_RESULTS = 12;

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function normalizeQuery(query) {
  return String(query ?? "")
    .toLowerCase()
    .trim();
}

function sessionTitle(session) {
  return session?.name || session?.firstMessage || "Empty session";
}

function sessionSearchText(session) {
  return [sessionTitle(session), session?.projectName, session?.projectPath]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function formatMeta(session) {
  return [session?.projectName, session?.projectPath].filter(Boolean).join(" · ");
}

function highlight(text, query) {
  const escaped = escapeHtml(text);
  if (!query) return escaped;
  const re = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi");
  return escaped.replace(re, "<mark>$1</mark>");
}

export function setupSessionSearchDialog({
  triggerInput,
  triggerClear,
  overlay,
  dialog,
  input,
  list,
  data,
  getWorkspaceId,
  getSessions,
  onSelect,
  onQueryChange,
  onError = console.error,
} = {}) {
  if (!triggerInput || !overlay || !dialog || !input || !list) {
    return { open() {}, close() {} };
  }

  let query = "";
  let messageMatches = [];
  let searchTimer = null;
  let searchSeq = 0;
  let loadingMessages = false;
  let activeIndex = 0;
  let suppressOpenUntil = 0;

  function visibleRows() {
    return [...list.querySelectorAll(".session-search-result")];
  }

  function setActiveIndex(nextIndex) {
    const rows = visibleRows();
    if (rows.length === 0) {
      activeIndex = 0;
      return;
    }
    activeIndex = Math.max(0, Math.min(nextIndex, rows.length - 1));
    rows.forEach((row, index) => {
      row.classList.toggle("active", index === activeIndex);
      row.setAttribute("aria-selected", String(index === activeIndex));
    });
    rows[activeIndex]?.scrollIntoView?.({ block: "nearest" });
  }

  function close({ restoreFocus = false } = {}) {
    if (searchTimer) clearTimeout(searchTimer);
    searchSeq += 1;
    overlay.classList.add("hidden");
    dialog.classList.add("hidden");
    loadingMessages = false;
    if (restoreFocus) triggerInput.focus();
  }

  function selectSession(sessionId) {
    const session = getSessions?.().find((item) => item.id === sessionId) ?? {
      id: sessionId,
      isCurrentWorkspace: true,
    };
    close({ restoreFocus: false });
    onSelect?.(session, { query });
  }

  function resultButton({ sessionId, icon, title, meta, snippet }) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "session-search-result";
    button.dataset.sessionId = sessionId;
    button.setAttribute("role", "option");
    button.innerHTML = `
      <span class="session-search-result-icon">${escapeHtml(icon)}</span>
      <span class="session-search-result-copy">
        <span class="session-search-result-title">${highlight(title, query)}</span>
        ${snippet ? `<span class="session-search-result-snippet">${highlight(snippet, query)}</span>` : ""}
        ${meta ? `<span class="session-search-result-meta">${escapeHtml(meta)}</span>` : ""}
      </span>`;
    button.addEventListener("click", () => selectSession(sessionId));
    return button;
  }

  function appendGroup(title, items) {
    if (items.length === 0) return;
    const group = document.createElement("div");
    group.className = "session-search-group";
    const header = document.createElement("div");
    header.className = "session-search-group-header";
    header.textContent = title;
    group.appendChild(header);
    for (const item of items) group.appendChild(item);
    list.appendChild(group);
  }

  function render() {
    list.innerHTML = "";
    const sessions = getSessions?.() ?? [];
    const normalized = normalizeQuery(query);
    const titleMatches = normalized
      ? sessions
          .filter((session) => sessionSearchText(session).includes(normalized))
          .slice(0, MAX_TITLE_RESULTS)
      : sessions.slice(0, MAX_RECENT_RESULTS);

    appendGroup(
      normalized ? "Tasks" : "Recent tasks",
      titleMatches.map((session) =>
        resultButton({
          sessionId: session.id,
          icon: session.isCurrentWorkspace ? "●" : "○",
          title: sessionTitle(session),
          meta: formatMeta(session),
        }),
      ),
    );

    appendGroup(
      "Message matches",
      messageMatches.map((result) =>
        resultButton({
          sessionId: result.sessionId,
          icon: "⌕",
          title: result.sessionName || result.firstMessage || "Untitled",
          meta: result.matches?.length > 1 ? `${result.matches.length} matches` : "Message match",
          snippet: result.matches?.[0]?.snippet || "",
        }),
      ),
    );

    if (loadingMessages) {
      const loading = document.createElement("div");
      loading.className = "session-search-empty";
      loading.textContent = "Searching messages…";
      list.appendChild(loading);
    } else if (list.children.length === 0) {
      const empty = document.createElement("div");
      empty.className = "session-search-empty";
      empty.textContent = normalized ? "No tasks or messages found" : "No saved tasks";
      list.appendChild(empty);
    }

    setActiveIndex(0);
  }

  function runMessageSearch(nextQuery) {
    if (searchTimer) clearTimeout(searchTimer);
    messageMatches = [];
    if (nextQuery.length < 2) {
      loadingMessages = false;
      render();
      return;
    }
    loadingMessages = true;
    render();
    const seq = ++searchSeq;
    searchTimer = setTimeout(async () => {
      const workspaceId = getWorkspaceId?.();
      if (!workspaceId) return;
      try {
        const response = await data?.searchSessions(workspaceId, nextQuery);
        if (seq !== searchSeq) return;
        messageMatches = response?.results ?? [];
      } catch (error) {
        if (seq === searchSeq) onError(error);
      } finally {
        if (seq === searchSeq) {
          loadingMessages = false;
          render();
        }
      }
    }, SEARCH_DEBOUNCE_MS);
  }

  function setQuery(nextQuery) {
    query = nextQuery;
    input.value = nextQuery;
    triggerInput.value = nextQuery;
    triggerClear?.classList.toggle("hidden", nextQuery.length === 0);
    onQueryChange?.(nextQuery);
    render();
    runMessageSearch(normalizeQuery(nextQuery));
  }

  function open(initialQuery = triggerInput.value) {
    if (Date.now() < suppressOpenUntil) return;
    overlay.classList.remove("hidden");
    dialog.classList.remove("hidden");
    setQuery(initialQuery ?? "");
    requestAnimationFrame(() => {
      input.focus();
      input.select();
    });
  }

  triggerInput.addEventListener("focus", () => open());
  triggerInput.addEventListener("click", () => open());
  triggerInput.addEventListener("keydown", (event) => {
    if (event.key === "Escape") return;
    const editingKey =
      event.key.length === 1 || event.key === "Backspace" || event.key === "Delete";
    if (!editingKey) return;
    event.preventDefault();
    open(event.key.length === 1 ? event.key : triggerInput.value);
  });
  function clearWithoutOpening(event) {
    event.preventDefault();
    event.stopPropagation();
    suppressOpenUntil = Date.now() + 250;
    setQuery("");
    close({ restoreFocus: false });
  }

  triggerClear?.addEventListener("pointerdown", clearWithoutOpening);
  triggerClear?.addEventListener("mousedown", clearWithoutOpening);
  triggerClear?.addEventListener("click", clearWithoutOpening);
  overlay.addEventListener("click", () => close());
  input.addEventListener("input", () => setQuery(input.value));
  document.addEventListener("keydown", (event) => {
    if (dialog.classList.contains("hidden") || event.key !== "Escape") return;
    event.preventDefault();
    close();
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex(activeIndex + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex(activeIndex - 1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      visibleRows()[activeIndex]?.click();
    }
  });

  return { open, close };
}
