'use strict';
// All settings come from environment variables (PRD section 9).
// Read lazily through load() so tests can change process.env between cases.

function str(name, def) {
  const v = process.env[name];
  return v === undefined || v === '' ? def : v;
}
function num(name, def) {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}
function bool(name, def) {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}

function load() {
  return {
    // LLM
    LLM_MODE: str('LLM_MODE', 'auto'), // auto | anthropic | mock
    ANTHROPIC_API_KEY: str('ANTHROPIC_API_KEY', ''),
    AGENT_MODEL: str('AGENT_MODEL', 'claude-opus-5-5'),
    REPORT_MODEL: str('REPORT_MODEL', 'claude-opus-5-5'),
    LLM_EFFORT: str('LLM_EFFORT', 'low'),
    // Prices must match the models above, or the budget kill-switch undercounts.
    PRICE_IN_USD_PER_MTOK: num('PRICE_IN_USD_PER_MTOK', 4.0),
    PRICE_OUT_USD_PER_MTOK: num('PRICE_OUT_USD_PER_MTOK', 20.0),
    USD_INR: num('USD_INR', 85),
    // Caps
    RUN_BUDGET_INR: num('RUN_BUDGET_INR', 200),
    DAILY_CAP_INR: num('DAILY_CAP_INR', 1700),
    MONTHLY_CAP_INR: num('MONTHLY_CAP_INR', 50000),
    // Shape (PRD: do not change without a PRD update)
    AGENTS_PER_RUN: num('AGENTS_PER_RUN', 80),
    ROUNDS: num('ROUNDS', 3),
    AGENT_BATCH_SIZE: num('AGENT_BATCH_SIZE', 10),
    // Token limits per task
    MAX_TOKENS_EXTRACT: num('MAX_TOKENS_EXTRACT', 2400),
    MAX_TOKENS_AGENT: num('MAX_TOKENS_AGENT', 4000),
    MAX_TOKENS_REPORT: num('MAX_TOKENS_REPORT', 2000),
    // Abuse
    IP_RUNS_PER_DAY: num('IP_RUNS_PER_DAY', 5),
    RELEASE_WINDOW_DAYS: num('RELEASE_WINDOW_DAYS', 30),
    TRUST_PROXY: bool('TRUST_PROXY', false),
    // Links and secrets
    PUBLIC_BASE_URL: str('PUBLIC_BASE_URL', 'http://localhost:3000').replace(/\/+$/, ''),
    WINROOM_TRIAL_URL: str('WINROOM_TRIAL_URL', 'https://winroom.ai/trial'),
    WEBHOOK_SECRET: str('WEBHOOK_SECRET', ''),
    ADMIN_TOKEN: str('ADMIN_TOKEN', ''),
    // Email
    SMTP_HOST: str('SMTP_HOST', ''),
    SMTP_PORT: num('SMTP_PORT', 587),
    SMTP_USER: str('SMTP_USER', ''),
    SMTP_PASSWORD: str('SMTP_PASSWORD', ''),
    MAIL_FROM: str('MAIL_FROM', 'Aerobee Decision Simulator <no-reply@aerobee.ai>'),
    OUTBOX_DIR: str('OUTBOX_DIR', 'data/outbox'),
    // Other
    DATABASE_PATH: str('DATABASE_PATH', 'data/simulator.db'),
    DISABLE_WORKER: bool('DISABLE_WORKER', false),
    PORT: num('PORT', 3000),
  };
}

module.exports = { load };
