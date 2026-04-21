/**
 * In-process ring buffer of log entries. Dashboard `/api/logs` reads from here.
 *
 * Entries look like:
 *   { ts: ISO string, seq: monotonic int, level, scope, message }
 *
 * `seq` is used by the UI to ask for "everything after N" without clock skew.
 */

const DEFAULT_CAPACITY = 500;

let buffer = [];
let capacity = DEFAULT_CAPACITY;
let nextSeq = 1;
let listeners = new Set();
let consoleIntercepted = false;

export function configureLogger({ capacity: cap } = {}) {
  if (typeof cap === 'number' && cap > 0) capacity = cap;
}

/**
 * Record a log entry. Trims the oldest entries when over capacity.
 */
export function log(level, scope, message) {
  const entry = {
    ts: new Date().toISOString(),
    seq: nextSeq++,
    level,
    scope,
    message: typeof message === 'string' ? message : formatValue(message),
  };
  buffer.push(entry);
  if (buffer.length > capacity) {
    buffer.splice(0, buffer.length - capacity);
  }
  for (const fn of listeners) {
    try {
      fn(entry);
    } catch {
      // Listener bugs should never break logging
    }
  }
  return entry;
}

export const info = (scope, msg) => log('info', scope, msg);
export const warn = (scope, msg) => log('warn', scope, msg);
export const error = (scope, msg) => log('error', scope, msg);

/**
 * Return all buffered entries, or only those with `seq > since`.
 */
export function getEntries({ since } = {}) {
  if (typeof since === 'number') {
    return buffer.filter((e) => e.seq > since);
  }
  return buffer.slice();
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Test-only: wipe the buffer and listeners.
 */
export function _reset() {
  buffer = [];
  nextSeq = 1;
  listeners.clear();
  capacity = DEFAULT_CAPACITY;
}

/**
 * Route `console.log` / `console.warn` / `console.error` writes into the ring
 * buffer in addition to the terminal. The original methods stay intact so
 * chalk/ora output still renders normally.
 */
export function interceptConsole() {
  if (consoleIntercepted) return;
  consoleIntercepted = true;

  const orig = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };

  console.log = (...args) => {
    orig.log(...args);
    log('info', 'console', stringifyArgs(args));
  };
  console.warn = (...args) => {
    orig.warn(...args);
    log('warn', 'console', stringifyArgs(args));
  };
  console.error = (...args) => {
    orig.error(...args);
    log('error', 'console', stringifyArgs(args));
  };
}

function stringifyArgs(args) {
  return args
    .map((a) => (typeof a === 'string' ? a : formatValue(a)))
    // Strip ANSI escapes so the dashboard gets clean text.
    .map((s) => s.replace(/\u001b\[[0-9;]*m/g, ''))
    .join(' ');
}

function formatValue(v) {
  if (v == null) return String(v);
  if (v instanceof Error) return `${v.name}: ${v.message}`;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
