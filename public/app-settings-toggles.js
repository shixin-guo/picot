export function setupSettingsToggles({
  toggleAutoCompact,
  btnThinkingLevel,
  toggleShowThinking,
  toggleAuth,
  rpcCommand,
  getCurrentThinkingLevel,
  setCurrentThinkingLevel,
  updateThinkingBtn,
}) {
  const formatThinkingLevelLabel = (level) => `Thinking: ${level || "off"}`;

  toggleAutoCompact?.addEventListener("click", async () => {
    const isOn = toggleAutoCompact.classList.contains("on");
    toggleAutoCompact.className = `settings-toggle${isOn ? "" : " on"}`;
    await rpcCommand({ type: "set_auto_compaction", enabled: !isOn });
  });

  btnThinkingLevel?.addEventListener("click", async () => {
    const data = await rpcCommand({ type: "cycle_thinking_level" });
    if (data?.success && data.data?.level) {
      btnThinkingLevel.textContent = formatThinkingLevelLabel(data.data.level);
      setCurrentThinkingLevel(data.data.level);
      updateThinkingBtn();
    }
  });

  const showThinking = localStorage.getItem("pi-studio-show-thinking") !== "false";
  if (toggleShowThinking) {
    toggleShowThinking.className = `settings-toggle${showThinking ? " on" : ""}`;
  }
  if (!showThinking) document.body.classList.add("hide-thinking");

  toggleShowThinking?.addEventListener("click", () => {
    const isOn = toggleShowThinking.classList.contains("on");
    toggleShowThinking.className = `settings-toggle${isOn ? "" : " on"}`;
    document.body.classList.toggle("hide-thinking", isOn);
    localStorage.setItem("pi-studio-show-thinking", !isOn);
  });

  toggleAuth?.addEventListener("click", async () => {
    const isOn = toggleAuth.classList.contains("on");
    const data = await rpcCommand({ type: "set_auth", enabled: !isOn });
    if (data?.success) {
      toggleAuth.className = `settings-toggle${!isOn ? " on" : ""}`;
    }
  });

  return {
    getCurrentThinkingLevel,
  };
}
