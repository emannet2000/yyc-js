export function createLogger(output = process.stdout) {
  function write(level, msg, context = {}) {
    output.write(JSON.stringify({ level, time: new Date().toISOString(), msg, ...context }) + '\n');
  }
  return {
    info:  (msg, ctx = {}) => write('info',  msg, ctx),
    warn:  (msg, ctx = {}) => write('warn',  msg, ctx),
    error: (msg, ctx = {}) => write('error', msg, ctx),
  };
}
