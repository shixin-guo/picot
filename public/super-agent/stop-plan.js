import { isSuperAgentProjectPath } from "./session.js";

function asPortSet(values) {
  const ports = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const port = Number(value);
    if (Number.isFinite(port) && port > 0) ports.add(port);
  }
  return ports;
}

export function planSuperAgentShutdown({
  currentPort,
  superAgentPorts,
  instances,
  superAgentPath,
} = {}) {
  const ports = asPortSet(superAgentPorts);
  const foregroundPort = Number(currentPort);
  const currentIsSuperAgent = ports.has(foregroundPort);
  const normalInstance = (Array.isArray(instances) ? instances : []).find(
    (instance) =>
      Number(instance?.port) !== foregroundPort &&
      !isSuperAgentProjectPath(instance?.cwd, superAgentPath),
  );

  if (currentIsSuperAgent && normalInstance?.port) {
    return {
      portsToStopBeforeNavigation: [...ports].filter((port) => port !== foregroundPort),
      navigateToPort: Number(normalInstance.port),
      portsToStopAfterNavigation: [foregroundPort],
    };
  }

  return {
    portsToStopBeforeNavigation: currentIsSuperAgent
      ? [...ports].filter((port) => port !== foregroundPort)
      : [...ports],
    navigateToPort: null,
    portsToStopAfterNavigation: [],
  };
}
