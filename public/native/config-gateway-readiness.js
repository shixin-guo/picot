export function setupConfigGatewayConnectionListener({
  adapter,
  eventTarget = window,
  isReady = () => true,
  onDisconnected,
}) {
  adapter.setConnectionListener((connected) => {
    if (connected) {
      if (isReady()) signalConfigGatewayReady(eventTarget);
      return;
    }
    onDisconnected?.();
  });
}

export function signalConfigGatewayReady(eventTarget = window) {
  eventTarget.dispatchEvent(new CustomEvent("picot-config-gateway-ready"));
}
