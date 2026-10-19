import { config } from '../config.js';
const levels = { debug: 10, info: 20, warn: 30, error: 40 };
const min = levels[config.logLevel] ?? 20;
const out = (lvl, scope, args) => {
  if (levels[lvl] < min) return;
  const line = `${new Date().toISOString()} ${lvl.toUpperCase().padEnd(5)} [${scope}]`;
  (lvl === 'error' ? console.error : console.log)(line, ...args);
};
export const logger = (scope) => ({
  debug: (...a) => out('debug', scope, a),
  info: (...a) => out('info', scope, a),
  warn: (...a) => out('warn', scope, a),
  error: (...a) => out('error', scope, a),
});
