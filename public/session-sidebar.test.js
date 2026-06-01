// public/session-sidebar.test.js
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SessionSidebar } from './session-sidebar.js';

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

function makeContainer() {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

function makeSidebar(container) {
  return new SessionSidebar(container, vi.fn(), vi.fn());
}

function makeSessions(filePaths) {
  return filePaths.map((fp, i) => ({
    filePath: fp,
    name: `Session ${i}`,
    timestamp: new Date().toISOString(),
  }));
}

describe('SessionSidebar — delete all archived', () => {
  let container;
  let sidebar;

  beforeEach(() => {
    localStorage.clear();
    container = makeContainer();
    sidebar = makeSidebar(container);
    mockFetch.mockReset();
  });

  afterEach(() => {
    container.remove();
  });

  it('does NOT render delete button when archived list is empty', () => {
    sidebar.projects = [{ dirName: 'proj', path: '/proj', sessions: makeSessions(['/proj/a.jsonl']) }];
    sidebar.render();
    expect(container.querySelector('.archived-delete-all-btn')).toBeNull();
  });

  it('renders delete button when archived sessions exist', () => {
    const fp = '/home/user/.pi/agent/sessions/proj/a.jsonl';
    sidebar.archived = [fp];
    sidebar.projects = [{ dirName: 'proj', path: '/proj', sessions: makeSessions([fp]) }];
    sidebar.render();
    expect(container.querySelector('.archived-delete-all-btn')).not.toBeNull();
  });

  it('calls fetch with archived paths when user confirms in modal', async () => {
    const fp = '/home/user/.pi/agent/sessions/proj/a.jsonl';
    sidebar.archived = [fp];
    sidebar.projects = [{ dirName: 'proj', path: '/proj', sessions: makeSessions([fp]) }];
    sidebar.render();

    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ deleted: 1, errors: [] }) }) // delete-batch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ projects: [] }) });           // loadSessions

    const btn = container.querySelector('.archived-delete-all-btn');
    btn.click();
    await new Promise(r => setTimeout(r, 0));
    const dialog = document.querySelector('.sidebar-confirm-overlay');
    dialog.querySelector('.sidebar-confirm-yes').click();
    await new Promise(r => setTimeout(r, 0)); // flush microtasks

    expect(mockFetch).toHaveBeenCalledWith('/api/sessions/delete-batch', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ filePaths: [fp] }),
    }));
  });

  it('does NOT call fetch when user cancels the custom modal', async () => {
    const fp = '/home/user/.pi/agent/sessions/proj/a.jsonl';
    sidebar.archived = [fp];
    sidebar.projects = [{ dirName: 'proj', path: '/proj', sessions: makeSessions([fp]) }];
    sidebar.render();

    const btn = container.querySelector('.archived-delete-all-btn');
    btn.click();
    await new Promise(r => setTimeout(r, 0));
    const dialog = document.querySelector('.sidebar-confirm-overlay');
    dialog.querySelector('.sidebar-confirm-no').click();
    await new Promise(r => setTimeout(r, 0));

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('clears this.archived for successfully deleted paths', async () => {
    const fp = '/home/user/.pi/agent/sessions/proj/a.jsonl';
    sidebar.archived = [fp];
    sidebar.projects = [{ dirName: 'proj', path: '/proj', sessions: makeSessions([fp]) }];
    sidebar.render();

    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ deleted: 1, errors: [] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ projects: [] }) });

    const btn = container.querySelector('.archived-delete-all-btn');
    btn.click();
    await new Promise(r => setTimeout(r, 0));
    const dialog = document.querySelector('.sidebar-confirm-overlay');
    dialog.querySelector('.sidebar-confirm-yes').click();
    await new Promise(r => setTimeout(r, 10));

    expect(sidebar.archived).toEqual([]);
  });

  it('uses custom modal even when native confirm exists', async () => {
    const fp = '/home/user/.pi/agent/sessions/proj/a.jsonl';
    sidebar.archived = [fp];
    sidebar.projects = [{ dirName: 'proj', path: '/proj', sessions: makeSessions([fp]) }];
    sidebar.render();

    const nativeConfirmSpy = vi.fn(() => true);
    vi.stubGlobal('confirm', nativeConfirmSpy);
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ deleted: 1, errors: [] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ projects: [] }) });

    const btn = container.querySelector('.archived-delete-all-btn');
    btn.click();
    await new Promise(r => setTimeout(r, 0));

    const fallbackDialog = document.querySelector('.sidebar-confirm-overlay');
    expect(fallbackDialog).not.toBeNull();

    fallbackDialog.querySelector('.sidebar-confirm-yes').click();
    await new Promise(r => setTimeout(r, 0));

    expect(mockFetch).toHaveBeenCalledWith('/api/sessions/delete-batch', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ filePaths: [fp] }),
    }));
    expect(nativeConfirmSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
