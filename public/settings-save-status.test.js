import { describe, it, expect, vi } from 'vitest';
import {
  clearSettingsSaveMessage,
  showSettingsSaveError,
  showSettingsSaveSuccess,
  setSettingsSaveButtonSaving,
} from './settings-save-status.js';

describe('settings save status helpers', () => {
  it('shows a green Saved message and auto-hides it', () => {
    vi.useFakeTimers();
    const status = document.createElement('div');

    showSettingsSaveSuccess(status);

    expect(status.textContent).toBe('Saved');
    expect(status.classList.contains('hidden')).toBe(false);
    expect(status.dataset.tone).toBe('ok');

    vi.advanceTimersByTime(2200);

    expect(status.textContent).toBe('');
    expect(status.classList.contains('hidden')).toBe(true);
    expect(status.dataset.tone).toBeUndefined();
    vi.useRealTimers();
  });

  it('shows an error message without auto-hiding', () => {
    vi.useFakeTimers();
    const status = document.createElement('div');

    showSettingsSaveError(status, 'Invalid JSON');

    expect(status.textContent).toBe('Invalid JSON');
    expect(status.classList.contains('hidden')).toBe(false);
    expect(status.dataset.tone).toBe('error');

    vi.advanceTimersByTime(3000);

    expect(status.textContent).toBe('Invalid JSON');
    expect(status.classList.contains('hidden')).toBe(false);
    expect(status.dataset.tone).toBe('error');
    vi.useRealTimers();
  });

  it('restores button text after saving state', () => {
    const button = document.createElement('button');
    button.textContent = 'Save';

    setSettingsSaveButtonSaving(button, true);

    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe('Saving...');

    setSettingsSaveButtonSaving(button, false);

    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe('Save');
  });

  it('clears a pending success timer when an error replaces it', () => {
    vi.useFakeTimers();
    const status = document.createElement('div');

    showSettingsSaveSuccess(status);
    showSettingsSaveError(status, 'Failed');
    vi.advanceTimersByTime(2200);

    expect(status.textContent).toBe('Failed');
    expect(status.classList.contains('hidden')).toBe(false);
    expect(status.dataset.tone).toBe('error');
    vi.useRealTimers();
  });

  it('clears message content and tone', () => {
    const status = document.createElement('div');
    showSettingsSaveError(status, 'Failed');

    clearSettingsSaveMessage(status);

    expect(status.textContent).toBe('');
    expect(status.classList.contains('hidden')).toBe(true);
    expect(status.dataset.tone).toBeUndefined();
  });
});
