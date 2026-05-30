import { describe, it, expect, vi } from 'vitest';
import {
  startNewProjectChat,
  openProjectWorkspace,
  openFolderAsWorkspace,
  startInWindowNewSession,
} from './workspace-actions.js';

function makeDeps({
  instances = [],
  currentPort = 3001,
  openWorkspacePort = 3099,
} = {}) {
  const tauriNative = {
    openWorkspace: vi.fn().mockResolvedValue(openWorkspacePort),
    pickFolder: vi.fn().mockResolvedValue('/picked/path'),
  };
  const fetchInstances = vi.fn().mockResolvedValue(instances);
  const getCurrentPort = vi.fn().mockReturnValue(currentPort);
  const navigate = vi.fn();
  const renderError = vi.fn();
  return {
    tauriNative,
    fetchInstances,
    getCurrentPort,
    navigate,
    renderError,
  };
}

describe('startNewProjectChat', () => {
  it('spawns a fresh headless pi for the project cwd and navigates the current window to it', async () => {
    const deps = makeDeps({
      instances: [{ port: 3001, cwd: '/Users/me/proj', sessionFile: '' }],
      currentPort: 3001,
      openWorkspacePort: 3099,
    });

    const result = await startNewProjectChat({
      project: { path: '/Users/me/proj', sessions: [{ cwd: '/Users/me/proj' }] },
      ...deps,
    });

    expect(result).toBe(true);
    expect(deps.tauriNative.openWorkspace).toHaveBeenCalledTimes(1);
    expect(deps.tauriNative.openWorkspace).toHaveBeenCalledWith('/Users/me/proj', {
      forceNewSession: false,
      openWindow: false,
      waitForSessions: false,
    });
    expect(deps.navigate).toHaveBeenCalledWith('http://localhost:3099/');
    expect(deps.renderError).not.toHaveBeenCalled();
  });

  it('spawns a fresh pi even when an instance for that cwd already exists on a different port', async () => {
    const deps = makeDeps({
      instances: [
        { port: 3001, cwd: '/Users/me/proj', sessionFile: '' },
        { port: 3005, cwd: '/Users/me/other', sessionFile: '' },
      ],
      currentPort: 3001,
      openWorkspacePort: 3099,
    });

    const result = await startNewProjectChat({
      project: { path: '/Users/me/other', sessions: [{ cwd: '/Users/me/other' }] },
      ...deps,
    });

    expect(result).toBe(true);
    expect(deps.tauriNative.openWorkspace).toHaveBeenCalledWith('/Users/me/other', {
      forceNewSession: false,
      openWindow: false,
      waitForSessions: false,
    });
    expect(deps.navigate).toHaveBeenCalledWith('http://localhost:3099/');
  });

  it('falls back to project path when a session cwd is missing', async () => {
    const deps = makeDeps({ instances: [], currentPort: 3001, openWorkspacePort: 3010 });

    const result = await startNewProjectChat({
      project: { path: '/project/path', sessions: [{ cwd: '' }] },
      ...deps,
    });

    expect(result).toBe(true);
    expect(deps.tauriNative.openWorkspace).toHaveBeenCalledWith('/project/path', {
      forceNewSession: false,
      openWindow: false,
      waitForSessions: false,
    });
    expect(deps.navigate).toHaveBeenCalledWith('http://localhost:3010/');
  });

  it('renders error when tauri is unavailable', async () => {
    const deps = makeDeps();
    const result = await startNewProjectChat({
      project: { path: '/project/path', sessions: [] },
      ...deps,
      tauriNative: null,
    });

    expect(result).toBe(false);
    expect(deps.renderError).toHaveBeenCalledWith('Project new chat is only supported in Tauri mode.');
  });

  it('renders error when project path is unavailable', async () => {
    const deps = makeDeps();
    const result = await startNewProjectChat({
      project: { path: '', sessions: [] },
      ...deps,
    });

    expect(result).toBe(false);
    expect(deps.tauriNative.openWorkspace).not.toHaveBeenCalled();
    expect(deps.navigate).not.toHaveBeenCalled();
    expect(deps.renderError.mock.calls[0][0]).toContain('Failed to start new chat:');
  });

  it('renders error when navigate is missing', async () => {
    const deps = makeDeps();
    const result = await startNewProjectChat({
      project: { path: '/p', sessions: [] },
      ...deps,
      navigate: undefined,
    });

    expect(result).toBe(false);
    expect(deps.tauriNative.openWorkspace).not.toHaveBeenCalled();
    expect(deps.renderError.mock.calls[0][0]).toContain('navigation is unavailable');
  });

  it('renders error when openWorkspace rejects', async () => {
    const deps = makeDeps();
    deps.tauriNative.openWorkspace = vi.fn().mockRejectedValue(new Error('boom'));

    const result = await startNewProjectChat({
      project: { path: '/p', sessions: [] },
      ...deps,
    });

    expect(result).toBe(false);
    expect(deps.navigate).not.toHaveBeenCalled();
    expect(deps.renderError.mock.calls[0][0]).toContain('Failed to start new chat:');
  });
});

describe('openProjectWorkspace', () => {
  it('does nothing when the project cwd matches the current window', async () => {
    const deps = makeDeps({
      instances: [{ port: 3001, cwd: '/Users/me/proj', sessionFile: '' }],
      currentPort: 3001,
    });

    const result = await openProjectWorkspace({
      project: { path: '/Users/me/proj', sessions: [] },
      ...deps,
    });

    expect(result).toBe(true);
    expect(deps.tauriNative.openWorkspace).not.toHaveBeenCalled();
    expect(deps.navigate).not.toHaveBeenCalled();
  });

  it('attaches to an existing pi instance without spawning a new one', async () => {
    const deps = makeDeps({
      instances: [
        { port: 3001, cwd: '/Users/me/proj', sessionFile: '' },
        { port: 3005, cwd: '/Users/me/other', sessionFile: '' },
      ],
      currentPort: 3001,
    });

    const result = await openProjectWorkspace({
      project: { path: '/Users/me/other', sessions: [] },
      ...deps,
    });

    expect(result).toBe(true);
    expect(deps.tauriNative.openWorkspace).not.toHaveBeenCalled();
    expect(deps.navigate).toHaveBeenCalledWith('http://localhost:3005/');
  });

  it('spawns a windowless pi when no instance exists for the cwd', async () => {
    const deps = makeDeps({
      instances: [{ port: 3001, cwd: '/Users/me/proj', sessionFile: '' }],
      currentPort: 3001,
      openWorkspacePort: 3010,
    });

    const result = await openProjectWorkspace({
      project: { path: '/Users/me/fresh', sessions: [] },
      ...deps,
    });

    expect(result).toBe(true);
    expect(deps.tauriNative.openWorkspace).toHaveBeenCalledWith('/Users/me/fresh', {
      forceNewSession: false,
      openWindow: false,
      waitForSessions: false,
    });
    expect(deps.navigate).toHaveBeenCalledWith('http://localhost:3010/');
  });

  it('renders error when project path is unavailable', async () => {
    const deps = makeDeps();
    const result = await openProjectWorkspace({
      project: { path: '', sessions: [] },
      ...deps,
    });

    expect(result).toBe(false);
    expect(deps.tauriNative.openWorkspace).not.toHaveBeenCalled();
    expect(deps.renderError.mock.calls[0][0]).toContain('Failed to open project:');
  });

  it('renders error when tauri is unavailable', async () => {
    const deps = makeDeps();
    const result = await openProjectWorkspace({
      project: { path: '/x', sessions: [] },
      ...deps,
      tauriNative: null,
    });

    expect(result).toBe(false);
    expect(deps.renderError).toHaveBeenCalledWith('Open project is only supported in Tauri mode.');
  });
});

describe('openFolderAsWorkspace', () => {
  it('is a no-op when the picked folder matches the current window', async () => {
    const deps = makeDeps({
      instances: [{ port: 3001, cwd: '/picked/path', sessionFile: '' }],
      currentPort: 3001,
    });
    deps.tauriNative.pickFolder = vi.fn().mockResolvedValue('/picked/path');

    const result = await openFolderAsWorkspace(deps);

    expect(result).toBe(true);
    expect(deps.tauriNative.openWorkspace).not.toHaveBeenCalled();
    expect(deps.navigate).not.toHaveBeenCalled();
  });

  it('attaches to an existing pi instance for the picked folder', async () => {
    const deps = makeDeps({
      instances: [
        { port: 3001, cwd: '/Users/me/proj', sessionFile: '' },
        { port: 3005, cwd: '/picked/path', sessionFile: '' },
      ],
      currentPort: 3001,
    });

    const result = await openFolderAsWorkspace(deps);

    expect(result).toBe(true);
    expect(deps.tauriNative.openWorkspace).not.toHaveBeenCalled();
    expect(deps.navigate).toHaveBeenCalledWith('http://localhost:3005/');
  });

  it('spawns a windowless pi when no instance matches', async () => {
    const deps = makeDeps({
      instances: [{ port: 3001, cwd: '/Users/me/proj', sessionFile: '' }],
      currentPort: 3001,
      openWorkspacePort: 3010,
    });

    const result = await openFolderAsWorkspace(deps);

    expect(result).toBe(true);
    expect(deps.tauriNative.openWorkspace).toHaveBeenCalledWith('/picked/path', {
      forceNewSession: false,
      openWindow: false,
      waitForSessions: false,
    });
    expect(deps.navigate).toHaveBeenCalledWith('http://localhost:3010/');
  });

  it('does nothing when folder picker is cancelled', async () => {
    const deps = makeDeps();
    deps.tauriNative.pickFolder = vi.fn().mockResolvedValue('');

    const result = await openFolderAsWorkspace(deps);

    expect(result).toBe(false);
    expect(deps.tauriNative.openWorkspace).not.toHaveBeenCalled();
    expect(deps.navigate).not.toHaveBeenCalled();
  });

  it('renders error when tauri is unavailable', async () => {
    const deps = makeDeps();
    const result = await openFolderAsWorkspace({
      ...deps,
      tauriNative: null,
    });

    expect(result).toBe(false);
    expect(deps.renderError).toHaveBeenCalledWith('Open folder is only supported in Tauri mode.');
  });
});

describe('startInWindowNewSession', () => {
  it('spawns a headless pi for the current cwd and navigates the current window to the new port', async () => {
    const tauriNative = {
      openWorkspace: vi.fn().mockResolvedValue(3099),
    };
    const navigate = vi.fn();

    const result = await startInWindowNewSession({
      tauriNative,
      getCurrentCwd: () => '/Users/me/proj',
      navigate,
      renderError: vi.fn(),
    });

    expect(result).toBe(true);
    expect(tauriNative.openWorkspace).toHaveBeenCalledWith('/Users/me/proj', {
      forceNewSession: false,
      openWindow: false,
      waitForSessions: false,
    });
    expect(navigate).toHaveBeenCalledWith('http://localhost:3099/');
  });

  it('falls back to fetchInstances + getCurrentPort to discover the current cwd', async () => {
    const tauriNative = {
      openWorkspace: vi.fn().mockResolvedValue(3099),
    };
    const fetchInstances = vi.fn().mockResolvedValue([
      { port: 3001, cwd: '/Users/me/proj', sessionFile: '' },
      { port: 3005, cwd: '/Users/me/other', sessionFile: '' },
    ]);
    const getCurrentPort = vi.fn().mockReturnValue(3005);
    const navigate = vi.fn();

    const result = await startInWindowNewSession({
      tauriNative,
      fetchInstances,
      getCurrentPort,
      navigate,
      renderError: vi.fn(),
    });

    expect(result).toBe(true);
    expect(tauriNative.openWorkspace).toHaveBeenCalledWith('/Users/me/other', {
      forceNewSession: false,
      openWindow: false,
      waitForSessions: false,
    });
    expect(navigate).toHaveBeenCalledWith('http://localhost:3099/');
  });

  it('renders error when tauri is unavailable', async () => {
    const renderError = vi.fn();

    const result = await startInWindowNewSession({
      tauriNative: null,
      navigate: vi.fn(),
      renderError,
    });

    expect(result).toBe(false);
    expect(renderError).toHaveBeenCalledWith('New session is only supported in Tauri mode.');
  });

  it('renders error when current cwd cannot be determined', async () => {
    const renderError = vi.fn();
    const tauriNative = {
      openWorkspace: vi.fn().mockResolvedValue(3099),
    };
    const navigate = vi.fn();

    const result = await startInWindowNewSession({
      tauriNative,
      fetchInstances: vi.fn().mockResolvedValue([]),
      getCurrentPort: vi.fn().mockReturnValue(3001),
      navigate,
      renderError,
    });

    expect(result).toBe(false);
    expect(tauriNative.openWorkspace).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    expect(renderError.mock.calls[0][0]).toContain('current workspace path is unavailable');
  });

  it('renders error when navigate is missing', async () => {
    const renderError = vi.fn();
    const tauriNative = {
      openWorkspace: vi.fn().mockResolvedValue(3099),
    };

    const result = await startInWindowNewSession({
      tauriNative,
      getCurrentCwd: () => '/Users/me/proj',
      renderError,
    });

    expect(result).toBe(false);
    expect(tauriNative.openWorkspace).not.toHaveBeenCalled();
    expect(renderError.mock.calls[0][0]).toContain('navigation is unavailable');
  });

  it('renders error when openWorkspace rejects', async () => {
    const renderError = vi.fn();
    const tauriNative = {
      openWorkspace: vi.fn().mockRejectedValue(new Error('boom')),
    };
    const navigate = vi.fn();

    const result = await startInWindowNewSession({
      tauriNative,
      getCurrentCwd: () => '/Users/me/proj',
      navigate,
      renderError,
    });

    expect(result).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
    expect(renderError.mock.calls[0][0]).toContain('Failed to start new session:');
  });
});

describe('instance-swap overlay (onBeforeSwap)', () => {
  it('startInWindowNewSession invokes onBeforeSwap before openWorkspace and does NOT dismiss it on success', async () => {
    const order = [];
    const tauriNative = {
      openWorkspace: vi.fn(async () => {
        order.push('openWorkspace');
        return 3099;
      }),
    };
    const dismiss = vi.fn();
    const onBeforeSwap = vi.fn(() => {
      order.push('onBeforeSwap');
      return dismiss;
    });
    const navigate = vi.fn(() => order.push('navigate'));

    const result = await startInWindowNewSession({
      tauriNative,
      getCurrentCwd: () => '/Users/me/proj',
      navigate,
      onBeforeSwap,
      renderError: vi.fn(),
    });

    expect(result).toBe(true);
    expect(order).toEqual(['onBeforeSwap', 'openWorkspace', 'navigate']);
    expect(onBeforeSwap).toHaveBeenCalledWith('Starting session…');
    expect(dismiss).not.toHaveBeenCalled();
  });

  it('startInWindowNewSession dismisses the overlay if openWorkspace rejects', async () => {
    const dismiss = vi.fn();
    const onBeforeSwap = vi.fn(() => dismiss);
    const tauriNative = {
      openWorkspace: vi.fn().mockRejectedValue(new Error('boom')),
    };

    const result = await startInWindowNewSession({
      tauriNative,
      getCurrentCwd: () => '/Users/me/proj',
      navigate: vi.fn(),
      onBeforeSwap,
      renderError: vi.fn(),
    });

    expect(result).toBe(false);
    expect(onBeforeSwap).toHaveBeenCalledTimes(1);
    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  it('startNewProjectChat dismisses the overlay if openWorkspace rejects', async () => {
    const dismiss = vi.fn();
    const onBeforeSwap = vi.fn(() => dismiss);
    const tauriNative = {
      openWorkspace: vi.fn().mockRejectedValue(new Error('boom')),
    };

    const result = await startNewProjectChat({
      project: { path: '/p', sessions: [] },
      tauriNative,
      navigate: vi.fn(),
      onBeforeSwap,
      renderError: vi.fn(),
    });

    expect(result).toBe(false);
    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  it('openProjectWorkspace skips the overlay when the cwd is already the current window', async () => {
    const onBeforeSwap = vi.fn(() => vi.fn());
    const deps = makeDeps({
      instances: [{ port: 3001, cwd: '/Users/me/proj', sessionFile: '' }],
      currentPort: 3001,
    });

    await openProjectWorkspace({
      project: { path: '/Users/me/proj', sessions: [] },
      ...deps,
      onBeforeSwap,
    });

    expect(onBeforeSwap).not.toHaveBeenCalled();
    expect(deps.navigate).not.toHaveBeenCalled();
  });

  it('openProjectWorkspace raises the overlay when attaching to a different cwd', async () => {
    const onBeforeSwap = vi.fn(() => vi.fn());
    const deps = makeDeps({
      instances: [
        { port: 3001, cwd: '/Users/me/proj', sessionFile: '' },
        { port: 3005, cwd: '/Users/me/other', sessionFile: '' },
      ],
      currentPort: 3001,
    });

    await openProjectWorkspace({
      project: { path: '/Users/me/other', sessions: [] },
      ...deps,
      onBeforeSwap,
    });

    expect(onBeforeSwap).toHaveBeenCalledWith('Opening workspace…');
    expect(deps.navigate).toHaveBeenCalledWith('http://localhost:3005/');
  });
});
