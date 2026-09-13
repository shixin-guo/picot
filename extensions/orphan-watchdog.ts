// ABOUTME: Exits this pi runtime once the Picot that spawned it is gone.
// ABOUTME: Last line of defence behind Picot's own teardown and the stdin EOF.

const DEFAULT_INTERVAL_MS = 30_000;
/** A reparented process is an orphan: its original parent no longer exists. */
const INIT_PID = 1;

export interface OrphanWatchdogHooks {
  getParentPid: () => number;
  exit: (code: number) => void;
  setInterval: (handler: () => void, ms: number) => unknown;
}

const defaultHooks: OrphanWatchdogHooks = {
  getParentPid: () => process.ppid,
  exit: (code) => process.exit(code),
  setInterval: (handler, ms) => {
    const timer = setInterval(handler, ms);
    // Never keep the process alive just to watch for its parent's death.
    (timer as { unref?: () => void }).unref?.();
    return timer;
  },
};

/**
 * Picot stops its runtimes on exit, and pi exits by itself when stdin reaches
 * EOF — but neither fires when Picot is killed outright, and a runtime wedged
 * in a blocking call never reads the stdin that would have stopped it. Polling
 * the parent pid costs nothing and catches the ordinary orphan long before the
 * next Picot launch would sweep it up.
 */
export function startOrphanWatchdog(
  intervalMs: number = DEFAULT_INTERVAL_MS,
  hooks: Partial<OrphanWatchdogHooks> = {},
): void {
  const { getParentPid, exit, setInterval: schedule } = { ...defaultHooks, ...hooks };
  // Already orphaned at startup means we were never supervised (a bare `pi`
  // launch, or a detached process) — polling would kill a legitimate session.
  if (getParentPid() === INIT_PID) return;
  schedule(() => {
    if (getParentPid() === INIT_PID) exit(0);
  }, intervalMs);
}
