export function getOnboardingState({ hasSessions, workspacePath, availableModels }) {
  const hasWorkspace = typeof workspacePath === "string" && workspacePath.trim().length > 0;
  const hasModel = Array.isArray(availableModels) && availableModels.length > 0;

  if (!hasWorkspace && !hasSessions) {
    return {
      canQuery: false,
      needsProject: true,
      needsModel: false,
      message: "Open a project to start chatting.",
    };
  }

  if (!hasModel) {
    return {
      canQuery: false,
      needsProject: false,
      needsModel: true,
      message: "Configure an API key or provider to start chatting.",
    };
  }

  return {
    canQuery: true,
    needsProject: false,
    needsModel: false,
    message: "",
  };
}
