'use strict';
// `npm run build`: there is no bundling step (plain HTML/JS frontend). This verifies the
// runtime and that every module loads, so a broken deploy fails at build time instead of at start.

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(`Node.js >= 22.13 is required (built-in SQLite). Found ${process.versions.node}.`);
  process.exit(1);
}
require('node:sqlite');
for (const m of ['config', 'templates', 'db', 'redact', 'validation', 'llm', 'personas', 'report', 'pipeline', 'email', 'app']) {
  require(`../src/${m}`);
}
const fs = require('node:fs');
const path = require('node:path');
for (const f of ['index.html', 'run.html', 'admin.html', 'styles.css']) {
  if (!fs.existsSync(path.join(__dirname, '..', 'public', f))) {
    console.error(`missing public/${f}`);
    process.exit(1);
  }
}
console.log('Build check passed.');
