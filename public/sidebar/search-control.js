export function setupSidebarSearchControl({ input, clearButton, onChange }) {
  if (!input || !clearButton || typeof onChange !== "function") return;

  const syncClearButton = () => {
    clearButton.classList.toggle("hidden", input.value.length === 0);
  };

  input.addEventListener("input", () => {
    syncClearButton();
    onChange(input.value);
  });

  clearButton.addEventListener("click", () => {
    if (!input.value) return;
    input.value = "";
    syncClearButton();
    onChange("");
    input.focus();
  });

  syncClearButton();
}
