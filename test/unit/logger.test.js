import { describe, it, expect, beforeEach } from 'vitest';
import {
  log,
  info,
  warn,
  error,
  getEntries,
  subscribe,
  configureLogger,
  _reset,
} from '../../src/logger.js';

beforeEach(() => {
  _reset();
});

describe('logger ring buffer', () => {
  it('records entries with monotonic seq and ISO timestamp', () => {
    info('a', 'first');
    info('a', 'second');
    const all = getEntries();
    expect(all).toHaveLength(2);
    expect(all[0].seq).toBe(1);
    expect(all[1].seq).toBe(2);
    expect(all[0].level).toBe('info');
    expect(all[0].scope).toBe('a');
    expect(all[0].message).toBe('first');
    expect(new Date(all[0].ts).toString()).not.toBe('Invalid Date');
  });

  it('level helpers set the level correctly', () => {
    info('x', 'i');
    warn('x', 'w');
    error('x', 'e');
    const levels = getEntries().map((e) => e.level);
    expect(levels).toEqual(['info', 'warn', 'error']);
  });

  it('trims oldest entries when over capacity', () => {
    configureLogger({ capacity: 3 });
    for (let i = 1; i <= 5; i++) info('x', `msg-${i}`);
    const remaining = getEntries();
    expect(remaining).toHaveLength(3);
    expect(remaining.map((e) => e.message)).toEqual(['msg-3', 'msg-4', 'msg-5']);
    // seq still monotonic even though the buffer was trimmed
    expect(remaining.map((e) => e.seq)).toEqual([3, 4, 5]);
  });

  it('filters via since={seq} to return only new entries', () => {
    info('x', 'a');
    info('x', 'b');
    info('x', 'c');
    const after = getEntries({ since: 1 });
    expect(after.map((e) => e.message)).toEqual(['b', 'c']);
    expect(getEntries({ since: 999 })).toEqual([]);
  });

  it('stringifies non-string messages (objects, errors)', () => {
    log('info', 'x', { hello: 'world' });
    log('info', 'x', new Error('boom'));
    log('info', 'x', null);
    const msgs = getEntries().map((e) => e.message);
    expect(msgs[0]).toBe('{"hello":"world"}');
    expect(msgs[1]).toBe('Error: boom');
    expect(msgs[2]).toBe('null');
  });

  it('notifies subscribers synchronously for each new entry', () => {
    const seen = [];
    const unsub = subscribe((e) => seen.push(e.seq));
    info('x', 'one');
    info('x', 'two');
    unsub();
    info('x', 'after-unsub');
    expect(seen).toEqual([1, 2]);
  });

  it('survives a throwing subscriber', () => {
    subscribe(() => {
      throw new Error('bad subscriber');
    });
    const good = [];
    subscribe((e) => good.push(e.seq));
    info('x', 'still works');
    expect(good).toEqual([1]);
  });
});
