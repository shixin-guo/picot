import "./cost/dashboard.js";

syncThemeFromCookie();

function syncThemeFromCookie() {
  const applyTheme = (themeId) => {
    if (!themeId) return;
    document.documentElement.setAttribute("data-theme", themeId);
  };

  try {
    const saved = readThemeCookie();
    if (saved === "dark") applyTheme("night");
    else if (saved === "light") applyTheme("terracotta");
    else if (saved) applyTheme(saved);
    else if (window.matchMedia?.("(prefers-color-scheme: light)").matches) applyTheme("terracotta");
    else applyTheme("night");
  } catch {
    applyTheme("night");
  }
}

function readThemeCookie() {
  try {
    const cookies = document.cookie ? document.cookie.split("; ") : [];
    for (const entry of cookies) {
      const eq = entry.indexOf("=");
      if (eq === -1) continue;
      if (entry.slice(0, eq) !== "pi-studio-theme") continue;
      const raw = entry.slice(eq + 1);
      try {
        return decodeURIComponent(raw);
      } catch {
        return raw;
      }
    }
  } catch {}
  return null;
}
