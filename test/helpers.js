'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BASE_ENV = {
  LLM_MODE: 'mock',
  DISABLE_WORKER: '1',
  ANTHROPIC_API_KEY: '',
  RUN_BUDGET_INR: '200',
  DAILY_CAP_INR: '1700',
  MONTHLY_CAP_INR: '50000',
  IP_RUNS_PER_DAY: '5',
  RELEASE_WINDOW_DAYS: '30',
  TRUST_PROXY: '1',
  PUBLIC_BASE_URL: 'https://sim.example.com',
  WINROOM_TRIAL_URL: 'https://winroom.example.com/trial',
  WEBHOOK_SECRET: '',
  ADMIN_TOKEN: '',
  SMTP_HOST: '',
};

/** Fresh DB + app on an ephemeral port. Returns { base, request, close, db, pipeline, email }. */
async function setup(envOverrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsim-'));
  Object.assign(process.env, BASE_ENV, { DATABASE_PATH: path.join(dir, 'test.db'), OUTBOX_DIR: path.join(dir, 'outbox') }, envOverrides);
  const db = require('../src/db');
  const pipeline = require('../src/pipeline');
  const email = require('../src/email');
  const { createApp } = require('../src/app');
  db.open(process.env.DATABASE_PATH);
  const sent = [];
  email.setSender(async (msg) => {
    sent.push(msg);
    return { via: 'test' };
  });
  const server = await new Promise((resolve) => {
    const s = createApp().listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  async function request(method, url, { body, headers, raw, ip } = {}) {
    const h = Object.assign({ 'X-Forwarded-For': ip || '203.0.113.10' }, headers || {});
    let payload;
    if (raw !== undefined) payload = raw;
    else if (body !== undefined) {
      h['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(base + url, { method, headers: h, body: payload, redirect: 'manual' });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch (_) {
      /* not json */
    }
    return { status: res.status, json, text, headers: res.headers };
  }

  async function close() {
    await new Promise((r) => server.close(r));
    email.setSender(null);
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  return { base, request, close, db, pipeline, email, sent };
}

function intake(template = 'sales_script', overrides = {}) {
  const extras = {
    settlement_offer: { settlement_offer: '70% of dues in one payment', validity: '15 days' },
    cancel_save_offer: { new_offer: '3 months at 50% off', monthly_fee: 'INR 799' },
    refund_goodwill: { new_policy: 'Instant refund up to INR 2,000 without approval' },
    sales_script: { new_script: 'Open with a two-minute ROI calculator', target_objection: 'price is too high' },
  }[template];
  return Object.assign(
    {
      template,
      role: 'sales_leader',
      industry: 'B2B SaaS',
      team_size: 40,
      company_description: 'A 40-seat inside sales team selling HR software to Indian SMBs.',
      decision_text: 'We will change how reps open calls and handle the price objection from next month.',
      extras,
    },
    overrides,
  );
}

/** Create a run through the API and process it with the worker. */
async function createAndProcess(ctx, template, overrides) {
  const res = await ctx.request('POST', '/api/runs', { body: intake(template, overrides) });
  if (res.status !== 201) throw new Error(`create failed ${res.status} ${res.text}`);
  await ctx.pipeline.processNext();
  return res.json.id;
}

module.exports = { setup, intake, createAndProcess };
