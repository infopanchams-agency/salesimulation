'use strict';
// Report email (PRD 5.11). SMTP with STARTTLS when SMTP_HOST is set, otherwise write to OUTBOX_DIR.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { load } = require('./config');

const C = { graphite: '#1b1e23', panel: '#262a31', amber: '#f5a524', cyan: '#22d3ee', text: '#e8eaed', muted: '#a9b0bb' };

function esc(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const RISK_COLOR = { low: '#34d399', medium: C.amber, high: '#f87171' };
const PLATFORM = { buyer_forum: 'Customer side', rep_channel: 'Team side' };

function section(title, inner) {
  return `<tr><td style="padding:0 24px 20px">
  <div style="background:${C.panel};border-radius:10px;padding:18px 20px">
    <div style="color:${C.cyan};font-size:12px;letter-spacing:.08em;text-transform:uppercase;font-weight:700;margin-bottom:10px">${esc(title)}</div>
    ${inner}
  </div></td></tr>`;
}

function renderEmailHtml(run, templateLabel, report) {
  const cfg = load();
  const cta = `${cfg.PUBLIC_BASE_URL}/go/winroom?run=${encodeURIComponent(run.id)}&utm_source=email`;
  const risk = report.risk_level;
  const p = (t) => `<p style="margin:0 0 8px;color:${C.text};font-size:15px;line-height:1.55">${t}</p>`;

  const curve = report.stance_curve
    .map(
      (r) => `<tr>
      <td style="padding:6px 8px;color:${C.text};white-space:nowrap">Round ${esc(r.round)}</td>
      <td style="padding:6px 8px;color:#34d399">${esc(r.positive)}</td>
      <td style="padding:6px 8px;color:${C.amber}">${esc(r.mixed)}</td>
      <td style="padding:6px 8px;color:${C.muted}">${esc(r.neutral)}</td>
      <td style="padding:6px 8px;color:#f87171">${esc(r.negative)}</td>
      <td style="padding:6px 8px;color:${C.text};font-weight:700">${esc(r.net_sentiment)}</td></tr>`,
    )
    .join('');
  const th = (t) => `<th align="left" style="padding:6px 8px;color:${C.muted};font-size:12px;font-weight:600">${t}</th>`;

  const objections = report.top_objections.length
    ? `<ol style="margin:0;padding-left:20px;color:${C.text};font-size:15px;line-height:1.6">${report.top_objections
        .map((o) => `<li>${esc(o.objection)} <span style="color:${C.muted}">(${esc(o.count)})</span></li>`)
        .join('')}</ol>`
    : p('No repeated objections were raised.');

  const quotes = report.quotes
    .map(
      (q) => `<div style="border-left:3px solid ${q.stance === 'positive' ? '#34d399' : C.amber};padding:4px 0 4px 12px;margin:0 0 12px">
      <div style="color:${C.text};font-size:15px;line-height:1.5">“${esc(q.text)}”</div>
      <div style="color:${C.muted};font-size:12px;margin-top:4px">${esc(q.agent_role)} · ${esc(PLATFORM[q.platform] || q.platform)} · round ${esc(q.round)} · ${esc(q.stance)}</div></div>`,
    )
    .join('');

  const fixes = `<ol style="margin:0;padding-left:20px;color:${C.text};font-size:15px;line-height:1.6">${report.friction_fixes
    .map((f) => `<li>${esc(f)}</li>`)
    .join('')}</ol>`;

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(`Your Decision Simulator report: ${templateLabel}`)}</title></head>
<body style="margin:0;padding:0;background:${C.graphite};font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:${C.graphite}"><tr><td align="center" style="padding:24px 8px">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:620px">
<tr><td style="padding:8px 24px 20px">
  <div style="color:${C.amber};font-weight:800;font-size:14px;letter-spacing:.06em">AEROBEE · DECISION SIMULATOR</div>
  <h1 style="margin:8px 0 6px;color:${C.text};font-size:22px;line-height:1.3">${esc(templateLabel)}</h1>
  <div style="color:${C.muted};font-size:14px;line-height:1.5">${esc(report.scenario_summary)}</div>
</td></tr>
${section(
  'Result',
  `<div style="display:inline-block;background:${RISK_COLOR[risk] || C.amber};color:${C.graphite};font-weight:800;border-radius:999px;padding:4px 12px;font-size:13px;margin-bottom:10px">${esc(risk.toUpperCase())} RISK</div>
   ${p(esc(report.executive_summary))}
   <div style="color:${C.muted};font-size:13px">${esc(report.agent_count)} simulated people · ${esc(report.rounds_completed)} round(s) · ${esc(Math.round(report.negative_share * 100))}% negative${report.partial ? ' · partial run' : ''}</div>`,
)}
${section(
  'Sentiment by round',
  `<table role="presentation" cellspacing="0" cellpadding="0" style="width:100%;font-size:14px"><tr>${th('Round')}${th('Pos')}${th('Mixed')}${th('Neutral')}${th('Neg')}${th('Net')}</tr>${curve}</table>`,
)}
${section('Top objections', objections)}
${section('What simulated people said', quotes || p('No quotes available.'))}
${section('Friction fixes', fixes)}
${section('Next step', p(esc(report.next_step)))}
<tr><td style="padding:4px 24px 24px">
  <div style="background:${C.panel};border:1px solid ${C.amber};border-radius:10px;padding:20px">
    ${p(esc(report.pitch))}
    <a href="${esc(cta)}" style="display:inline-block;margin-top:8px;background:${C.amber};color:${C.graphite};text-decoration:none;font-weight:800;border-radius:8px;padding:12px 20px;font-size:15px">Start a free Winroom trial</a>
  </div>
</td></tr>
<tr><td style="padding:0 24px 24px;color:${C.muted};font-size:12px;line-height:1.5">${esc(report.disclaimer)}</td></tr>
</table></td></tr></table></body></html>`;
}

let transport = null;
function smtpTransport(cfg) {
  if (!transport) {
    const nodemailer = require('nodemailer');
    transport = nodemailer.createTransport({
      host: cfg.SMTP_HOST,
      port: cfg.SMTP_PORT,
      secure: cfg.SMTP_PORT === 465,
      requireTLS: cfg.SMTP_PORT !== 465,
      auth: cfg.SMTP_USER ? { user: cfg.SMTP_USER, pass: cfg.SMTP_PASSWORD } : undefined,
    });
  }
  return transport;
}

// Tests may replace the sender.
let override = null;
function setSender(fn) {
  override = fn;
  transport = null;
}

async function sendReportEmail(run, to, templateLabel, report) {
  const cfg = load();
  const subject = `Your Decision Simulator report: ${templateLabel}`;
  const html = renderEmailHtml(run, templateLabel, report);
  if (override) return override({ to, subject, html, run });
  if (cfg.SMTP_HOST) {
    await smtpTransport(cfg).sendMail({ from: cfg.MAIL_FROM, to, subject, html });
    return { via: 'smtp' };
  }
  fs.mkdirSync(cfg.OUTBOX_DIR, { recursive: true });
  const hash = crypto.createHash('sha256').update(`${to}|${Date.now()}`).digest('hex').slice(0, 10);
  const file = path.join(cfg.OUTBOX_DIR, `${run.id}-${hash}.html`);
  fs.writeFileSync(file, html);
  return { via: 'outbox', file };
}

module.exports = { sendReportEmail, renderEmailHtml, setSender, esc };
