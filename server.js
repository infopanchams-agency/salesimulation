'use strict';
// Entry point: one HTTP server and one background worker in a single process (PRD 8).

const { load } = require('./src/config');
const db = require('./src/db');
const { createApp } = require('./src/app');
const pipeline = require('./src/pipeline');
const llm = require('./src/llm');

const cfg = load();
db.open(cfg.DATABASE_PATH);

const app = createApp();
const port = process.env.PORT || cfg.PORT || 3000;
const server = app.listen(port, '0.0.0.0', () => {
  let mode;
  try {
    mode = llm.resolveMode(cfg);
  } catch (e) {
    mode = `error: ${e.message}`;
  }
  console.log(`Decision Simulator listening on port ${port} (LLM mode: ${mode})`);
});

if (!cfg.DISABLE_WORKER) pipeline.startWorker();

function shutdown() {
  pipeline.stopWorker();
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
