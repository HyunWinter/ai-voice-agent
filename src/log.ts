const ts = () => new Date().toISOString();
const DEBUG = !!process.env.DEBUG; // Detailed event logs only when DEBUG=1

export const log = {
  info: (...a: unknown[]) => console.log(ts(), '[info]', ...a),
  warn: (...a: unknown[]) => console.warn(ts(), '[warn]', ...a),
  error: (...a: unknown[]) => console.error(ts(), '[error]', ...a),
  // Detailed realtime events etc. — hidden by default, printed only when DEBUG=1.
  debug: (...a: unknown[]) => {
    if (DEBUG) console.log(ts(), '[debug]', ...a);
  },
};
