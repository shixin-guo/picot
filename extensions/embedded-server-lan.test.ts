// @vitest-environment node

import { describe, expect, it } from "vitest";
import { buildLanAccessUrls, LAN_BIND_HOST } from "./embedded-server.ts";

function restoreBrokerPort(value: string | undefined) {
  if (value === undefined) delete process.env.PI_STUDIO_BROKER_PORT;
  else process.env.PI_STUDIO_BROKER_PORT = value;
}

describe("embedded server LAN access helpers", () => {
  it("binds to all interfaces unconditionally", () => {
    expect(LAN_BIND_HOST).toBe("0.0.0.0");
  });

  it("builds mobile chat urls for every LAN host", () => {
    const previous = process.env.PI_STUDIO_BROKER_PORT;
    delete process.env.PI_STUDIO_BROKER_PORT;
    expect(buildLanAccessUrls(47821, ["192.168.1.20", "10.0.0.8"])).toEqual([
      "http://192.168.1.20:47821/?mobile=1",
      "http://10.0.0.8:47821/?mobile=1",
    ]);
    restoreBrokerPort(previous);
  });

  it("includes the LAN broker websocket url when broker port is available", () => {
    const previous = process.env.PI_STUDIO_BROKER_PORT;
    process.env.PI_STUDIO_BROKER_PORT = "49123";
    expect(buildLanAccessUrls(47821, ["192.168.1.20"])).toEqual([
      "http://192.168.1.20:47821/?mobile=1&brokerWs=ws%3A%2F%2F192.168.1.20%3A49123%2Fui-ws",
    ]);
    restoreBrokerPort(previous);
  });
});
