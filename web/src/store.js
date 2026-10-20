// Tiny global store with selector hooks (no external state library).
import { useSyncExternalStore, useRef } from 'react';

export function createStore(initial) {
  let state = initial;
  const subs = new Set();
  const get = () => state;
  const set = (patch) => {
    const next = typeof patch === 'function' ? patch(state) : patch;
    state = { ...state, ...next };
    subs.forEach((s) => s());
  };
  const subscribe = (fn) => { subs.add(fn); return () => subs.delete(fn); };
  function use(selector = (s) => s) {
    const last = useRef();
    return useSyncExternalStore(subscribe, () => {
      const v = selector(state);
      // Shallow-compare plain objects so selectors returning new objects don't loop.
      if (last.current && typeof v === 'object' && v && !Array.isArray(v) && shallowEq(last.current, v)) return last.current;
      last.current = v;
      return v;
    });
  }
  return { get, set, subscribe, use };
}

function shallowEq(a, b) {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => a[k] === b[k]);
}

export const store = createStore({
  user: null, settings: null, oauth: {}, accounts: [], folders: { accounts: [], counts: {} }, labels: [],
  toasts: [], composers: [], connected: false, aiProviders: [], spaces: [], space: '',
});
