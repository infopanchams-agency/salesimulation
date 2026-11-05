'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { setup, intake, createAndProcess } = require('./helpers');

let ctx;
test.beforeEach(async () => {
  ctx = await setup();
});
test.afterEach(async () => {
  await ctx.close();
});

function hasKeyDeep(obj, key) {
  if (!obj || typeof obj !== 'object') return false;
  if (Object.prototype.hasOwnProperty.call(obj, key)) return true;
  return Object.values(obj).some((v) => hasKeyDeep(v, key));
}

// ---------------------------------------------------------------- templates and validation

test('GET /api/templates lists only the four enabled templates', async () => {
  const res = await ctx.request('GET', '/api/templates');
  assert.equal(res.status, 200);
  assert.deepEqual(res.json.map((t) => t.id).sort(), ['cancel_save_offer', 'refund_goodwill', 'sales_script', 'settlement_offer']);
  const s = res.json.find((t) => t.id === 'settlement_offer');
  assert.deepEqual(s.required, ['settlement_offer']);
  assert.ok(s.fields.every((f) => f.key && f.label));
});

test('validation rejects disabled and unknown templates with 422', async () => {
  for (const template of ['price_change', 'rep_incentive', 'territory_reassignment']) {
    const res = await ctx.request('POST', '/api/runs', { body: intake('sales_script', { template, extras: {} }) });
    assert.equal(res.status, 422, template);
    assert.equal(typeof res.json.detail, 'string');
  }
});

test('validation enforces role, industry and team size', async () => {
  const bad = [{ role: 'ceo' }, { industry: 'Mining' }, { team_size: 0 }, { team_size: 501 }, { team_size: 2.5 }, { team_size: 'ten' }];
  for (const o of bad) {
    const res = await ctx.request('POST', '/api/runs', { body: intake('sales_script', o) });
    assert.equal(res.status, 422, JSON.stringify(o));
  }
});

test('validation enforces text lengths', async () => {
  const bad = [
    { company_description: 'too short' },
    { company_description: 'x'.repeat(401) },
    { decision_text: 'too short' },
    { decision_text: 'x'.repeat(801) },
    { utm_source: 'u'.repeat(51) },
  ];
  for (const o of bad) {
    const res = await ctx.request('POST', '/api/runs', { body: intake('sales_script', o) });
    assert.equal(res.status, 422, Object.keys(o)[0]);
  }
});

test('validation enforces template extras', async () => {
  const cases = [
    { extras: { new_script: 'ok', new_price: '100' } }, // key not in template
    { extras: { target_objection: 'price' } }, // required missing
    { extras: { new_script: '   ' } }, // required empty
    { extras: { new_script: 'x'.repeat(201) } }, // too long
    { extras: { new_script: 'a', old_script: 'b', target_objection: 'c', d: '1', e: '2', f: '3', g: '4' } }, // > 6 keys
  ];
  for (const o of cases) {
    const res = await ctx.request('POST', '/api/runs', { body: intake('sales_script', o) });
    assert.equal(res.status, 422, JSON.stringify(o.extras));
  }
});

test('valid intake creates a queued run', async () => {
  const res = await ctx.request('POST', '/api/runs', { body: intake('sales_script', { utm_source: 'linkedin' }) });
  assert.equal(res.status, 201);
  assert.equal(res.json.status, 'queued');
  const run = ctx.db.getRun(res.json.id);
  assert.equal(run.utm_source, 'linkedin');
  assert.equal(run.ip, '203.0.113.10');
  const ev = ctx.db.get().prepare("SELECT * FROM events WHERE type = 'run_created'").get();
  assert.equal(ev.run_id, res.json.id);
});

// ---------------------------------------------------------------- pipeline

for (const template of ['settlement_offer', 'cancel_save_offer', 'refund_goodwill', 'sales_script']) {
  test(`full pipeline produces a report for ${template}`, async () => {
    const id = await createAndProcess(ctx, template);
    const run = ctx.db.getRun(id);
    assert.equal(run.status, 'report_ready');
    assert.equal(run.stage, 'done');
    assert.equal(run.progress, 100);
    const r = run.report;
    assert.equal(r.agent_count, 80);
    assert.equal(r.rounds_completed, 3);
    assert.equal(r.partial, false);
    assert.equal(run.posts.length, 240);
    assert.equal(r.stance_curve.length, 3);
    for (const row of r.stance_curve) {
      assert.equal(row.total, 80);
      assert.equal(row.net_sentiment, Math.round(((row.positive - row.negative) / row.total) * 100) / 100);
    }
    assert.ok(['low', 'medium', 'high'].includes(r.risk_level));
    assert.equal(r.friction_fixes.length, 3);
    assert.ok(r.top_objections.length <= 3);
    assert.ok(r.quotes.length >= 1 && r.quotes.length <= 5);
    assert.ok(run.cost_inr > 0);
    const compliance = r.disclaimer.includes('This is not legal advice.');
    assert.equal(compliance, template === 'settlement_offer');
    for (const p of run.posts) {
      assert.match(p.id, /^R[1-3]-P\d{3}$/);
      assert.equal(p.platform, p.side === 'buyer' ? 'buyer_forum' : 'rep_channel');
    }
  });
}

test('same run id always gets the same 80-person panel', () => {
  const { samplePanel, buildPool } = require('../src/personas');
  const a = samplePanel('sales_script', 'run-abc', 80);
  const b = samplePanel('sales_script', 'run-abc', 80);
  const c = samplePanel('sales_script', 'run-xyz', 80);
  assert.equal(a.length, 80);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a.map((p) => p.id), c.map((p) => p.id));
  const pool = buildPool('settlement_offer');
  assert.equal(pool.length, 100);
  assert.equal(pool[0].side, 'internal');
  assert.equal(pool[1].side, 'buyer');
  assert.equal(pool[99].id, 'P100');
});

test('quotes come only from stored posts; invented ids are dropped', async () => {
  const id = await createAndProcess(ctx, 'refund_goodwill');
  const run = ctx.db.getRun(id);
  const stored = new Set(run.posts.map((p) => p.text));
  for (const q of run.report.quotes) assert.ok(stored.has(q.text));

  const { computeStats, assembleReport } = require('../src/report');
  const { getTemplate } = require('../src/templates');
  const stats = computeStats(run.posts);
  const invented = assembleReport({
    run,
    template: getTemplate('refund_goodwill'),
    posts: run.posts,
    stats,
    roundsCompleted: 3,
    partial: false,
    modelOut: { quote_ids: ['R9-P999', 'made-up'], risk_level: 'extreme' },
  });
  assert.equal(invented.quotes.length, 3);
  assert.deepEqual(invented.quotes.map((q) => q.text), stats.candidates.slice(0, 3).map((p) => p.text));
  assert.equal(invented.risk_level, 'medium');
});

test('agent actions are filtered and normalized', () => {
  const { parseActions } = require('../src/pipeline');
  const batch = [
    { id: 'P001', side: 'internal', role: 'Sales leader' },
    { id: 'P002', side: 'buyer', role: 'Small business owner' },
  ];
  const text = JSON.stringify({
    actions: [
      { agent_id: 'P001', stance: 'furious', objection: '  TOO EXPENSIVE ', text: 'x'.repeat(400) },
      { agent_id: 'P001', stance: 'positive', objection: '', text: 'duplicate' },
      { agent_id: 'P099', stance: 'positive', objection: '', text: 'not in batch' },
      { agent_id: 'P002', stance: 'negative', objection: 'o'.repeat(80), text: '   ' },
    ],
  });
  const posts = parseActions(text, batch, 2, new Set());
  assert.equal(posts.length, 1);
  assert.equal(posts[0].id, 'R2-P001');
  assert.equal(posts[0].stance, 'neutral');
  assert.equal(posts[0].objection, 'too expensive');
  assert.equal(posts[0].text.length, 300);
  assert.equal(posts[0].platform, 'rep_channel');
});

test('budget kill-switch before round 1 ends gives a partial report with 0 rounds', async () => {
  process.env.RUN_BUDGET_INR = '0.0001';
  const id = await createAndProcess(ctx, 'sales_script');
  const run = ctx.db.getRun(id);
  assert.equal(run.status, 'report_ready');
  assert.equal(run.report.partial, true);
  assert.equal(run.report.rounds_completed, 0);
  const calls = ctx.db.get().prepare('SELECT COUNT(*) AS n FROM spend WHERE run_id = ?').get(id).n;
  assert.equal(calls, 1);
});

test('budget kill-switch mid-run stops and reports posts so far', async () => {
  const { callCostInr } = require('../src/pipeline');
  const { load } = require('../src/config');
  // Mock calls cost a small, stable amount; allow roughly one round and a bit.
  const perCall = callCostInr(load(), 1500, 500);
  process.env.RUN_BUDGET_INR = String(perCall * 12);
  const id = await createAndProcess(ctx, 'cancel_save_offer');
  const run = ctx.db.getRun(id);
  assert.equal(run.report.partial, true);
  assert.ok(run.report.rounds_completed < 3);
  assert.ok(run.posts.length > 0 && run.posts.length < 240);
  assert.ok(run.cost_inr >= Number(process.env.RUN_BUDGET_INR));
});

test('LLM failure marks the run failed with a safe message', async () => {
  const llm = require('../src/llm');
  const original = llm.complete;
  llm.complete = async () => {
    throw new Error('upstream exploded: secret detail');
  };
  try {
    const id = await createAndProcess(ctx, 'sales_script');
    const res = await ctx.request('GET', `/api/runs/${id}`);
    assert.equal(res.json.status, 'failed');
    assert.equal(res.json.error, 'The simulation failed. Please submit the scenario again.');
    assert.ok(!res.text.includes('secret detail'));
    const rel = await ctx.request('POST', `/api/runs/${id}/release`, { body: { email: 'a@acme.in', consent: true } });
    assert.equal(rel.status, 409);
  } finally {
    llm.complete = original;
  }
});

test('stale running runs are reset to queued on start', async () => {
  const res = await ctx.request('POST', '/api/runs', { body: intake() });
  ctx.db.updateRun(res.json.id, { status: 'running', stage: 'simulate', progress: 35 });
  ctx.pipeline.resetStale();
  const run = ctx.db.getRun(res.json.id);
  assert.equal(run.status, 'queued');
  assert.equal(run.progress, 0);
});

// ---------------------------------------------------------------- gate and release

test('before report_ready there is no report or teaser; at report_ready only a teaser', async () => {
  const res = await ctx.request('POST', '/api/runs', { body: intake() });
  const id = res.json.id;
  const before = await ctx.request('GET', `/api/runs/${id}`);
  assert.equal(before.json.status, 'queued');
  assert.ok(!hasKeyDeep(before.json, 'report'));
  assert.ok(!hasKeyDeep(before.json, 'teaser'));

  await ctx.pipeline.processNext();
  const after = await ctx.request('GET', `/api/runs/${id}`);
  assert.equal(after.json.status, 'report_ready');
  assert.equal(after.json.released, false);
  assert.ok(!hasKeyDeep(after.json, 'report'));
  assert.deepEqual(Object.keys(after.json.teaser).sort(), ['agent_count', 'risk_level', 'top_objection']);
  assert.ok(!after.text.includes('executive_summary'));
});

test('release returns 404 for unknown runs and 409 while processing', async () => {
  const missing = await ctx.request('POST', '/api/runs/nope/release', { body: { email: 'a@acme.in', consent: true } });
  assert.equal(missing.status, 404);
  const res = await ctx.request('POST', '/api/runs', { body: intake() });
  const early = await ctx.request('POST', `/api/runs/${res.json.id}/release`, { body: { email: 'a@acme.in', consent: true } });
  assert.equal(early.status, 409);
});

test('release requires consent and a valid email', async () => {
  const id = await createAndProcess(ctx, 'sales_script');
  const noConsent = await ctx.request('POST', `/api/runs/${id}/release`, { body: { email: 'vp@acme.in', consent: false } });
  assert.equal(noConsent.status, 422);
  const badEmail = await ctx.request('POST', `/api/runs/${id}/release`, { body: { email: 'not-an-email', consent: true } });
  assert.equal(badEmail.status, 422);
  assert.equal(ctx.sent.length, 0);
});

test('release rejects free email domains', async () => {
  const id = await createAndProcess(ctx, 'sales_script');
  for (const d of ['gmail.com', 'yahoo.co.in', 'Outlook.com', 'rediffmail.com', 'proton.me']) {
    const res = await ctx.request('POST', `/api/runs/${id}/release`, { body: { email: `someone@${d}`, consent: true } });
    assert.equal(res.status, 422, d);
  }
  assert.equal(ctx.db.getRun(id).released, false);
});

test('release emails the report, stores the email, and is idempotent', async () => {
  const id = await createAndProcess(ctx, 'settlement_offer', { role: 'collections_manager' });
  const res = await ctx.request('POST', `/api/runs/${id}/release`, { body: { email: 'Head.Ops@Acme-Collect.in', consent: true } });
  assert.equal(res.status, 200);
  assert.equal(res.json.released, true);
  assert.ok(res.json.report.executive_summary);
  assert.equal(ctx.sent.length, 1);
  assert.equal(ctx.sent[0].to, 'head.ops@acme-collect.in');
  assert.equal(ctx.sent[0].subject, 'Your Decision Simulator report: Settlement or waiver offer');
  assert.ok(ctx.sent[0].html.includes(`https://sim.example.com/go/winroom?run=${id}&amp;utm_source=email`));
  const run = ctx.db.getRun(id);
  assert.equal(run.email, 'head.ops@acme-collect.in');
  assert.ok(run.released_at);

  const again = await ctx.request('POST', `/api/runs/${id}/release`, { body: { email: 'head.ops@acme-collect.in', consent: true } });
  assert.equal(again.status, 200);
  assert.ok(again.json.report);
  assert.equal(ctx.sent.length, 1);
  const status = await ctx.request('GET', `/api/runs/${id}`);
  assert.ok(status.json.report);
  assert.ok(!status.json.teaser);
});

test('one released report per email within the window', async () => {
  const a = await createAndProcess(ctx, 'sales_script');
  const b = await createAndProcess(ctx, 'refund_goodwill');
  const first = await ctx.request('POST', `/api/runs/${a}/release`, { body: { email: 'cx@acme.in', consent: true } });
  assert.equal(first.status, 200);
  const second = await ctx.request('POST', `/api/runs/${b}/release`, { body: { email: 'CX@acme.in', consent: true } });
  assert.equal(second.status, 429);
  assert.equal(ctx.db.getRun(b).released, false);
});

test('email failure returns 502 and leaves the run unreleased', async () => {
  const id = await createAndProcess(ctx, 'sales_script');
  ctx.email.setSender(async () => {
    throw new Error('smtp down');
  });
  const res = await ctx.request('POST', `/api/runs/${id}/release`, { body: { email: 'vp@acme.in', consent: true } });
  assert.equal(res.status, 502);
  assert.equal(ctx.db.getRun(id).released, false);
});

test('email HTML escapes user-provided text', () => {
  const { renderEmailHtml } = require('../src/email');
  const html = renderEmailHtml({ id: 'r1' }, 'Label', {
    scenario_summary: '<script>alert(1)</script>',
    risk_level: 'high',
    executive_summary: 'a & b',
    agent_count: 80,
    rounds_completed: 3,
    negative_share: 0.5,
    partial: false,
    stance_curve: [],
    top_objections: [{ objection: '<b>x</b>', count: 2 }],
    quotes: [{ agent_role: 'R', platform: 'buyer_forum', round: 1, stance: 'negative', text: '"><img src=x>' }],
    friction_fixes: ['f1', 'f2', 'f3'],
    next_step: 'n',
    pitch: 'p',
    disclaimer: 'd',
  });
  assert.ok(!html.includes('<script>alert'));
  assert.ok(!html.includes('<img src=x>'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('#1b1e23') && html.includes('#f5a524') && html.includes('#22d3ee'));
});

// ---------------------------------------------------------------- CTA, limits, redaction

test('Winroom CTA logs the click and redirects with UTM parameters', async () => {
  const id = await createAndProcess(ctx, 'sales_script');
  const res = await ctx.request('GET', `/go/winroom?run=${id}&utm_source=email`);
  assert.equal(res.status, 302);
  const loc = new URL(res.headers.get('location'));
  assert.equal(loc.origin + loc.pathname, 'https://winroom.example.com/trial');
  assert.equal(loc.searchParams.get('utm_source'), 'aerobee_simulator');
  assert.equal(loc.searchParams.get('utm_medium'), 'lead_magnet');
  assert.equal(loc.searchParams.get('utm_campaign'), 'decision_simulator');
  assert.equal(loc.searchParams.get('ref'), id);
  const n = ctx.db.get().prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'winroom_click' AND run_id = ?").get(id).n;
  assert.equal(n, 1);
  const unknown = await ctx.request('GET', '/go/winroom?run=unknown');
  assert.equal(unknown.status, 302);
  assert.equal(ctx.db.get().prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'winroom_click'").get().n, 1);
});

test('redaction replaces PII before storage and logs counts', async () => {
  const { redact } = require('../src/redact');
  const c = {};
  assert.equal(redact('mail ravi.k@acme.in now', c), 'mail [EMAIL] now');
  assert.equal(redact('PAN ABCDE1234F here', c), 'PAN [PAN] here');
  assert.equal(redact('Aadhaar 1234 5678 9012.', c), 'Aadhaar [AADHAAR].');
  assert.equal(redact('call +91 98765 43210 or 9876543210', c), 'call [PHONE] or [PHONE]');
  assert.equal(redact('acct 123456789012345 ok', c), 'acct [NUMBER] ok');
  assert.equal(redact('70% of INR 40,000 dues in 15 days', c), '70% of INR 40,000 dues in 15 days');

  const res = await ctx.request('POST', '/api/runs', {
    body: intake('sales_script', {
      decision_text: 'Reps call +91-98765-43210 and email ops@acme.in about account 55512345678901.',
      extras: { new_script: 'Quote PAN ABCDE1234F on the call' },
    }),
  });
  assert.equal(res.status, 201);
  const run = ctx.db.getRun(res.json.id);
  assert.ok(run.decision_text.includes('[PHONE]') && run.decision_text.includes('[EMAIL]') && run.decision_text.includes('[NUMBER]'));
  assert.ok(!run.decision_text.includes('98765'));
  assert.equal(run.extras.new_script, 'Quote PAN [PAN] on the call');
  const ev = ctx.db.get().prepare("SELECT meta FROM events WHERE type = 'run_created'").get();
  assert.deepEqual(JSON.parse(ev.meta).redactions, { email: 1, phone: 1, number: 1, pan: 1 });
});

test('per-IP daily limit returns 429', async () => {
  for (let i = 0; i < 5; i++) {
    const ok = await ctx.request('POST', '/api/runs', { body: intake(), ip: '198.51.100.7' });
    assert.equal(ok.status, 201);
  }
  const blocked = await ctx.request('POST', '/api/runs', { body: intake(), ip: '198.51.100.7, 10.0.0.1' });
  assert.equal(blocked.status, 429);
  const other = await ctx.request('POST', '/api/runs', { body: intake(), ip: '198.51.100.8' });
  assert.equal(other.status, 201);
});

test('daily and monthly spend caps return 503', async () => {
  ctx.db.addSpend('x', 1700);
  const daily = await ctx.request('POST', '/api/runs', { body: intake() });
  assert.equal(daily.status, 503);
  process.env.DAILY_CAP_INR = '100000';
  process.env.MONTHLY_CAP_INR = '1000';
  const monthly = await ctx.request('POST', '/api/runs', { body: intake() });
  assert.equal(monthly.status, 503);
});

// ---------------------------------------------------------------- webhook and admin

test('webhook fails closed without a secret and checks the HMAC signature', async () => {
  const body = JSON.stringify({ run_id: 'x' });
  const closed = await ctx.request('POST', '/api/webhooks/winroom-trial', { raw: body, headers: { 'Content-Type': 'application/json' } });
  assert.equal(closed.status, 503);

  process.env.WEBHOOK_SECRET = 'whsec_test';
  const id = await createAndProcess(ctx, 'sales_script');
  const good = JSON.stringify({ run_id: id });
  const sig = crypto.createHmac('sha256', 'whsec_test').update(good).digest('hex');
  const bad = await ctx.request('POST', '/api/webhooks/winroom-trial', { raw: good, headers: { 'X-Signature': 'deadbeef' } });
  assert.equal(bad.status, 401);
  const none = await ctx.request('POST', '/api/webhooks/winroom-trial', { raw: good });
  assert.equal(none.status, 401);

  const ok = await ctx.request('POST', '/api/webhooks/winroom-trial', { raw: good, headers: { 'X-Signature': sig, 'Content-Type': 'application/json' } });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json, { ok: true, attributed: true });
  await ctx.request('POST', '/api/webhooks/winroom-trial', { raw: good, headers: { 'X-Signature': sig } });
  assert.equal(ctx.db.get().prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'trial_started'").get().n, 1);

  const orphan = JSON.stringify({ run_id: 'does-not-exist' });
  const osig = crypto.createHmac('sha256', 'whsec_test').update(orphan).digest('hex');
  const un = await ctx.request('POST', '/api/webhooks/winroom-trial', { raw: orphan, headers: { 'X-Signature': osig } });
  assert.deepEqual(un.json, { ok: true, attributed: false });
  const ev = ctx.db.get().prepare("SELECT run_id FROM events WHERE type = 'trial_started_unattributed'").get();
  assert.equal(ev.run_id, null);
});

test('admin metrics require the token and report the funnel', async () => {
  const closed = await ctx.request('GET', '/api/admin/metrics');
  assert.equal(closed.status, 503);
  process.env.ADMIN_TOKEN = 'admin-secret';
  const wrong = await ctx.request('GET', '/api/admin/metrics', { headers: { 'X-Admin-Token': 'nope' } });
  assert.equal(wrong.status, 401);

  const id = await createAndProcess(ctx, 'sales_script');
  await ctx.request('POST', `/api/runs/${id}/release`, { body: { email: 'vp@acme.in', consent: true } });
  await ctx.request('GET', `/go/winroom?run=${id}`);
  await ctx.request('GET', `/go/winroom?run=${id}`);
  const res = await ctx.request('GET', '/api/admin/metrics', { headers: { 'X-Admin-Token': 'admin-secret' } });
  assert.equal(res.status, 200);
  const m = res.json;
  assert.equal(m.runs_total, 1);
  assert.equal(m.reports_generated, 1);
  assert.equal(m.reports_released, 1);
  assert.equal(m.winroom_clicks, 1);
  assert.equal(m.trial_starts, 0);
  assert.equal(m.release_rate, 1);
  assert.equal(m.click_rate, 1);
  assert.equal(m.kill_gate, 'collecting');
  assert.ok(m.avg_cost_per_report_inr > 0);
  assert.equal(m.daily_cap_inr, 1700);
});

test('static pages are served', async () => {
  for (const p of ['/', '/run.html', '/admin.html', '/styles.css', '/js/run.js']) {
    const res = await ctx.request('GET', p);
    assert.equal(res.status, 200, p);
  }
});
