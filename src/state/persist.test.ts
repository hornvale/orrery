import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadLocalControls, resolveControls, saveLocalControls } from './persist';

describe('local control persistence', () => {
  beforeEach(() => { localStorage.clear(); });

  it('round-trips', () => {
    saveLocalControls('winds:1');
    expect(loadLocalControls()).toBe('winds:1');
  });

  it('returns empty when nothing is stored', () => {
    expect(loadLocalControls()).toBe('');
  });

  it('returns empty rather than throwing when storage is unavailable', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError: storage is disabled');
    });
    expect(loadLocalControls()).toBe('');
    spy.mockRestore();
  });

  it('swallows a write failure rather than breaking the app', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    expect(() => saveLocalControls('winds:1')).not.toThrow();
    spy.mockRestore();
  });
});

describe('resolveControls — the URL wins over local storage', () => {
  it('takes the URL blob outright when the hash carries one, ignoring local entirely', () => {
    const loadLocal = vi.fn(() => 'winds:1');
    expect(resolveControls('look:dither3d', loadLocal)).toBe('look:dither3d');
    expect(loadLocal).not.toHaveBeenCalled(); // a shared link must show the SENDER's view, full stop
  });

  it('falls back to local only when the hash carries none', () => {
    expect(resolveControls('', () => 'winds:1')).toBe('winds:1');
  });

  it('is empty when neither the URL nor local storage has anything', () => {
    expect(resolveControls('', () => '')).toBe('');
  });
});
