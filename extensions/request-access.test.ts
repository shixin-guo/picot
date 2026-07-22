// ABOUTME: Verifies the embedded server loopback boundary for HTTP and WebSocket control surfaces.
// ABOUTME: Covers address normalization and the distinction between read-only LAN and control routes.

import { describe, expect, it } from "vitest";
import { isLoopbackAddress, isLoopbackOnlyApiRequest } from "./request-access";

describe("isLoopbackAddress", () => {
  it.each([
    "127.0.0.1",
    "127.0.0.2",
    "::1",
    "::ffff:127.0.0.1",
  ])("accepts loopback address %s", (address) => {
    expect(isLoopbackAddress(address)).toBe(true);
  });

  it.each([
    undefined,
    null,
    "",
    "192.168.1.20",
    "10.0.0.2",
    "::ffff:192.168.1.20",
  ])("rejects non-loopback address %s", (address) => {
    expect(isLoopbackAddress(address)).toBe(false);
  });
});

describe("isLoopbackOnlyApiRequest", () => {
  it.each([
    ["POST", "/api/rpc"],
    ["PUT", "/api/files/content"],
    ["POST", "/api/open"],
    ["POST", "/api/sessions/delete-batch"],
    ["POST", "/api/sessions/switch"],
    ["POST", "/api/workspace/open"],
    ["GET", "/api/agent-config"],
    ["PUT", "/api/agent-config"],
    ["GET", "/api/models-config"],
    ["PUT", "/api/models-config"],
    ["POST", "/api/chat-telegram/validate"],
    ["POST", "/api/chat-telegram/bind"],
    ["GET", "/api/chat-config"],
    ["PUT", "/api/chat-config"],
    ["GET", "/api/super-agent/tasks"],
    ["PUT", "/api/super-agent/tasks"],
    ["GET", "/api/super-agent/projects"],
    ["GET", "/api/chat-telegram/doctor"],
    ["GET", "/api/home"],
    ["GET", "/api/files?scope=picker&path=%2F"],
  ])("requires loopback for %s %s", (method, urlPath) => {
    expect(isLoopbackOnlyApiRequest(urlPath, method)).toBe(true);
  });

  it.each([
    ["GET", "/api/health"],
    ["GET", "/api/sessions"],
    ["GET", "/api/files?scope=workspace"],
    ["GET", "/api/files/content?path=%2Fworkspace%2Ffile.txt"],
    ["GET", "/api/search?q=hello"],
    ["GET", "/api/cost-dashboard"],
    ["GET", "/api/git-branch"],
    ["GET", "/api/lan-qr"],
  ])("allows LAN read-only request %s %s", (method, urlPath) => {
    expect(isLoopbackOnlyApiRequest(urlPath, method)).toBe(false);
  });
});
