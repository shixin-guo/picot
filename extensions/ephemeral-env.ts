// ABOUTME: Parses trusted host-injected ephemeral session markers from the process env.
// ABOUTME: Kepts dependency-free so tests can import it without loading the full embedded server.

export type EphemeralEnv = {
  kind: "side-chat" | "quick-chat";
  instanceId: string;
  generation: number;
};

/** Parse the trusted host-injected ephemeral markers. Absent or partial → null. */
export function parseEphemeralEnv(env: NodeJS.ProcessEnv = process.env): EphemeralEnv | null {
  const kind = env.PI_STUDIO_EPHEMERAL_KIND;
  if (kind !== "side-chat" && kind !== "quick-chat") return null;
  const instanceId = env.PI_STUDIO_EPHEMERAL_INSTANCE_ID || "";
  const generation = Number.parseInt(env.PI_STUDIO_EPHEMERAL_GENERATION || "0", 10) || 0;
  if (!instanceId) return null;
  return { kind, instanceId, generation };
}
