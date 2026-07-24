import { describe, expect, it, vi } from "vitest";

import {
  setupConfigGatewayConnectionListener,
  signalConfigGatewayReady,
} from "./config-gateway-readiness.js";

describe("config gateway readiness", () => {
  it("announces readiness only after the host transport connects", () => {
    let listener;
    const adapter = {
      setConnectionListener: vi.fn((nextListener) => {
        listener = nextListener;
      }),
    };
    const eventTarget = new EventTarget();
    const ready = vi.fn();
    eventTarget.addEventListener("picot-config-gateway-ready", ready);

    setupConfigGatewayConnectionListener({ adapter, eventTarget });
    expect(ready).not.toHaveBeenCalled();

    listener(true);
    expect(ready).toHaveBeenCalledTimes(1);
  });

  it("reports disconnects without announcing readiness", () => {
    let listener;
    const adapter = {
      setConnectionListener: vi.fn((nextListener) => {
        listener = nextListener;
      }),
    };
    const eventTarget = new EventTarget();
    const ready = vi.fn();
    const onDisconnected = vi.fn();
    eventTarget.addEventListener("picot-config-gateway-ready", ready);

    setupConfigGatewayConnectionListener({ adapter, eventTarget, onDisconnected });
    listener(false);

    expect(onDisconnected).toHaveBeenCalledTimes(1);
    expect(ready).not.toHaveBeenCalled();
  });

  it("does not announce a connection before the active target is ready", () => {
    let listener;
    const adapter = {
      setConnectionListener: vi.fn((nextListener) => {
        listener = nextListener;
      }),
    };
    const eventTarget = new EventTarget();
    const ready = vi.fn();
    eventTarget.addEventListener("picot-config-gateway-ready", ready);

    setupConfigGatewayConnectionListener({ adapter, eventTarget, isReady: () => false });
    listener(true);

    expect(ready).not.toHaveBeenCalled();
  });

  it("can announce readiness after the active target is subscribed", () => {
    const eventTarget = new EventTarget();
    const ready = vi.fn();
    eventTarget.addEventListener("picot-config-gateway-ready", ready);

    signalConfigGatewayReady(eventTarget);

    expect(ready).toHaveBeenCalledOnce();
  });
});
