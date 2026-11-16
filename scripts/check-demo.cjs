const { readFileSync } = require('node:fs');
const { Script } = require('node:vm');
const files = ['app', 'dispatch', 'refine', 'experience'];
// Classic scripts share globals and intentionally override handlers across files.
// Parse them as one browser script to catch syntax and duplicate declarations.
new Script(
  files.map((file) => readFileSync(`public/demo/${file}.js`, 'utf8')).join('\n'),
);
console.log('Demo scripts parse successfully.');
