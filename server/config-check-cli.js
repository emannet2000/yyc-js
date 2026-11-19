import { checkConfiguration } from './config-check.js';

const items = checkConfiguration();
const marks = { ok: 'OK   ', warn: 'SETUP', error: 'ERROR' };
for (const item of items)
  console.log(`${marks[item.level]}  ${item.area}: ${item.message}`);
const errors = items.filter((item) => item.level === 'error').length;
const todo = items.filter((item) => item.level === 'warn').length;
console.log(`\n${errors} error(s), ${todo} item(s) still to set up.`);
process.exitCode = errors > 0 ? 1 : 0;
