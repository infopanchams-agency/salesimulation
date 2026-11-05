'use strict';
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');

const db = require('./db');
const { load } = require('./config');
const { publicList, getTemplate } = require('./templates');
const { validateIntake, validateWorkEmail, ValidationError } = require('./validation');
const { redactIntake } = require('./redact');
const email = require('./email');
const pipeline = require('./pipeline');

function clientIp(req, cfg) {
  if (cfg.TRUST_PROXY) {
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff.trim()) return xff.split(',')[0].trim();
  }
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) {
    crypto.timingSafeEqual(ab, ab); // keep timing roughly constant
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

function statusBody(run) {
  const body = {
    id: run.id,
    status: run.status,
    stage: run.stage,
    progress: run.progress,
    template: run.template,
    error: run.error || null,
    released: run.released,
  };
  if (run.status === 'report_ready' && run.report) {
    if (run.released) body.report = run.report;
    else
      body.teaser = {
        risk_level: run.report.risk_level,
        agent_count: run.report.agent_count,
        top_objection: run.report.top_objections[0] ? run.report.top_objections[0].objection : null,
      };
  }
  return body;
}

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false); // client IP is resolved by clientIp() per TRUST_PROXY

  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy':
        "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    });
    next();
  });

  // Webhook needs the raw body for the HMAC check, so it is registered before the JSON parser.
  app.post('/api/webhooks/winroom-trial', express.raw({ type: '*/*', limit: '16kb' }), (req, res) => {
    const cfg = load();
    if (!cfg.WEBHOOK_SECRET) return res.status(503).json({ detail: 'Webhook is not configured.' });
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
    const expected = crypto.createHmac('sha256', cfg.WEBHOOK_SECRET).update(raw).digest('hex');
    const sig = String(req.get('X-Signature') || '').trim().toLowerCase();
    if (!sig || !safeEqual(sig, expected)) return res.status(401).json({ detail: 'Invalid signature.' });
    let payload;
    try {
      payload = JSON.parse(raw.toString('utf8'));
    } catch (_) {
      return res.status(422).json({ detail: 'Body must be JSON.' });
    }
    const runId = payload && typeof payload.run_id === 'string' ? payload.run_id : '';
    const run = runId ? db.getRun(runId) : null;
    if (run) {
      const already = db.get().prepare("SELECT 1 FROM events WHERE type = 'trial_started' AND run_id = ? LIMIT 1").get(run.id);
      if (!already) db.logEvent(run.id, 'trial_started', {});
      return res.json({ ok: true, attributed: true });
    }
    db.logEvent(null, 'trial_started_unattributed', {});
    return res.json({ ok: true, attributed: false });
  });

  app.use('/api', express.json({ limit: '32kb' }));

  app.get('/api/health', (req, res) => res.json({ ok: true }));

  app.get('/api/templates', (req, res) => res.json(publicList()));

  app.post('/api/runs', (req, res) => {
    const cfg = load();
    let intake;
    try {
      intake = validateIntake(req.body);
    } catch (e) {
      if (e instanceof ValidationError) return res.status(422).json({ detail: e.detail });
      throw e;
    }
    const ip = clientIp(req, cfg);
    const today = db.startOfTodayUtc();
    const ipCount = db.get().prepare('SELECT COUNT(*) AS n FROM runs WHERE ip = ? AND created_at >= ?').get(ip, today).n;
    if (ipCount >= cfg.IP_RUNS_PER_DAY)
      return res.status(429).json({ detail: 'You have reached the daily limit of simulations. Please try again tomorrow.' });
    if (db.spendSince(today) >= cfg.DAILY_CAP_INR)
      return res.status(503).json({ detail: 'The simulator is at capacity for today. Please try again tomorrow.' });
    if (db.spendSince(db.startOfMonthUtc()) >= cfg.MONTHLY_CAP_INR)
      return res.status(503).json({ detail: 'The simulator is at capacity this month. Please try again later.' });

    const { data, counts } = redactIntake(intake);
    const id = crypto.randomUUID();
    const now = db.nowIso();
    db.get()
      .prepare(
        `INSERT INTO runs (id, status, stage, progress, template, role, industry, team_size, company_desc, decision_text,
          extras, utm_source, ip, created_at, updated_at)
         VALUES (?, 'queued', 'queued', 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        data.template,
        data.role,
        data.industry,
        data.team_size,
        data.company_description,
        data.decision_text,
        JSON.stringify(data.extras),
        data.utm_source,
        ip,
        now,
        now,
      );
    db.logEvent(id, 'run_created', { template: data.template, utm_source: data.utm_source, redactions: counts });
    pipeline.kick();
    return res.status(201).json({ id, status: 'queued' });
  });

  app.get('/api/runs/:id', (req, res) => {
    const run = db.getRun(req.params.id);
    if (!run) return res.status(404).json({ detail: 'Run not found.' });
    return res.json(statusBody(run));
  });

  app.post('/api/runs/:id/release', async (req, res) => {
    const cfg = load();
    const run = db.getRun(req.params.id);
    if (!run) return res.status(404).json({ detail: 'Run not found.' });
    if (run.status === 'failed') return res.status(409).json({ detail: 'This simulation failed. Please submit it again.' });
    if (run.status !== 'report_ready') return res.status(409).json({ detail: 'The report is not ready yet.' });

    const body = req.body || {};
    if (body.consent !== true) return res.status(422).json({ detail: 'Please agree to receive the report and follow-up emails.' });
    let addr;
    try {
      addr = validateWorkEmail(body.email);
    } catch (e) {
      if (e instanceof ValidationError) return res.status(422).json({ detail: e.detail });
      throw e;
    }

    if (run.released) return res.json(statusBody(run));

    const since = new Date(Date.now() - cfg.RELEASE_WINDOW_DAYS * 86400000).toISOString();
    const recent = db
      .get()
      .prepare('SELECT id FROM runs WHERE email = ? AND released = 1 AND released_at >= ? AND id != ? LIMIT 1')
      .get(addr, since, run.id);
    if (recent)
      return res
        .status(429)
        .json({ detail: `This email already received a report in the last ${cfg.RELEASE_WINDOW_DAYS} days.` });

    const tpl = getTemplate(run.template);
    try {
      await email.sendReportEmail(run, addr, tpl.label, run.report);
    } catch (e) {
      console.error(`[release] email failed for run ${run.id}:`, e && e.message);
      return res.status(502).json({ detail: 'We could not send the email. Please try again in a few minutes.' });
    }

    db.updateRun(run.id, { released: true, email: addr, released_at: db.nowIso() });
    db.logEvent(run.id, 'email_captured', { domain: addr.split('@')[1] });
    db.logEvent(run.id, 'report_released', {});
    return res.json(statusBody(db.getRun(run.id)));
  });

  app.get('/go/winroom', (req, res) => {
    const cfg = load();
    const runId = typeof req.query.run === 'string' ? req.query.run.slice(0, 64) : '';
    if (runId && db.getRun(runId)) {
      db.logEvent(runId, 'winroom_click', { utm_source: typeof req.query.utm_source === 'string' ? req.query.utm_source.slice(0, 50) : null });
    }
    let target;
    try {
      target = new URL(cfg.WINROOM_TRIAL_URL);
    } catch (_) {
      return res.status(503).send('Trial link is not configured.');
    }
    target.searchParams.set('utm_source', 'aerobee_simulator');
    target.searchParams.set('utm_medium', 'lead_magnet');
    target.searchParams.set('utm_campaign', 'decision_simulator');
    if (runId) target.searchParams.set('ref', runId);
    return res.redirect(302, target.toString());
  });

  app.get('/api/admin/metrics', (req, res) => {
    const cfg = load();
    if (!cfg.ADMIN_TOKEN) return res.status(503).json({ detail: 'Admin is not configured.' });
    const token = req.get('X-Admin-Token') || '';
    if (!token || !safeEqual(token, cfg.ADMIN_TOKEN)) return res.status(401).json({ detail: 'Invalid admin token.' });
    return res.json(metrics(cfg));
  });

  app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'], maxAge: '5m' }));

  app.use('/api', (req, res) => res.status(404).json({ detail: 'Not found.' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err && (err.type === 'entity.parse.failed' || err.status === 400))
      return res.status(400).json({ detail: 'Request body must be valid JSON.' });
    if (err && err.type === 'entity.too.large') return res.status(413).json({ detail: 'Request is too large.' });
    console.error('[http] unhandled', err);
    return res.status(500).json({ detail: 'Something went wrong. Please try again.' });
  });

  return app;
}

function metrics(cfg) {
  const d = db.get();
  const one = (sql, ...args) => d.prepare(sql).get(...args).n;
  const runs_total = one('SELECT COUNT(*) AS n FROM runs');
  const reports_generated = one("SELECT COUNT(*) AS n FROM runs WHERE status = 'report_ready'");
  const reports_released = one('SELECT COUNT(*) AS n FROM runs WHERE released = 1');
  const winroom_clicks = one("SELECT COUNT(DISTINCT run_id) AS n FROM events WHERE type = 'winroom_click' AND run_id IS NOT NULL");
  const trial_starts = one("SELECT COUNT(DISTINCT run_id) AS n FROM events WHERE type = 'trial_started' AND run_id IS NOT NULL");
  const avg = d.prepare("SELECT AVG(cost_inr) AS n FROM runs WHERE status = 'report_ready'").get().n;
  const ratio = (a, b) => (b ? Math.round((a / b) * 1000) / 1000 : 0);
  const trial_rate = ratio(trial_starts, reports_released);
  let kill_gate = 'collecting';
  if (reports_released >= 150) kill_gate = trial_rate >= 0.15 ? 'pass' : 'fail';
  const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
  return {
    runs_total,
    reports_generated,
    reports_released,
    winroom_clicks,
    trial_starts,
    release_rate: ratio(reports_released, reports_generated),
    click_rate: ratio(winroom_clicks, reports_released),
    trial_rate,
    avg_cost_per_report_inr: r2(avg),
    spend_today_inr: r2(db.spendSince(db.startOfTodayUtc())),
    spend_month_inr: r2(db.spendSince(db.startOfMonthUtc())),
    daily_cap_inr: cfg.DAILY_CAP_INR,
    monthly_cap_inr: cfg.MONTHLY_CAP_INR,
    kill_gate,
  };
}

module.exports = { createApp, statusBody, clientIp };
