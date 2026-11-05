'use strict';
const { getTemplate } = require('./templates');

const ROLES = ['sales_leader', 'support_manager', 'collections_manager', 'retention_manager'];
const INDUSTRIES = [
  'BPO / debt collection',
  'Real estate tele-sales',
  'B2B SaaS',
  'Logistics',
  'Insurance',
  'Ed-tech',
  'Telecom / ISP',
  'Retail banking / microfinance',
  'Other',
];

class ValidationError extends Error {
  constructor(detail) {
    super(detail);
    this.detail = detail;
  }
}

function fail(msg) {
  throw new ValidationError(msg);
}

function lengthIn(name, value, min, max) {
  if (typeof value !== 'string') fail(`${name} is required.`);
  const n = value.trim().length;
  if (n < min || n > max) fail(`${name} must be ${min} to ${max} characters (got ${n}).`);
}

/** Validate an intake body (PRD 5.2). Returns a cleaned object or throws ValidationError. */
function validateIntake(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail('Request body must be a JSON object.');

  const tpl = getTemplate(body.template);
  if (!tpl || !tpl.enabled) fail('Choose one of the available decision templates.');

  if (!ROLES.includes(body.role)) fail(`role must be one of: ${ROLES.join(', ')}.`);
  if (!INDUSTRIES.includes(body.industry)) fail('Choose an industry from the list.');

  const size = body.team_size;
  const sizeNum = typeof size === 'string' && /^\d+$/.test(size.trim()) ? Number(size) : size;
  if (!Number.isInteger(sizeNum) || sizeNum < 1 || sizeNum > 500) fail('Team size must be a whole number from 1 to 500.');

  lengthIn('Company description', body.company_description, 20, 400);
  lengthIn('Decision text', body.decision_text, 20, 800);

  const extrasIn = body.extras === undefined || body.extras === null ? {} : body.extras;
  if (typeof extrasIn !== 'object' || Array.isArray(extrasIn)) fail('extras must be an object.');
  const keys = Object.keys(extrasIn);
  if (keys.length > 6) fail('At most 6 template fields are allowed.');
  const allowed = new Set([...tpl.required, ...tpl.optional]);
  const extras = {};
  for (const k of keys) {
    if (!allowed.has(k)) fail(`Field "${k}" does not belong to this template.`);
    const v = extrasIn[k];
    if (v === null || v === undefined) continue;
    if (typeof v !== 'string') fail(`Field "${k}" must be text.`);
    if (v.length > 200) fail(`Field "${k}" must be at most 200 characters.`);
    if (v.trim()) extras[k] = v.trim();
  }
  for (const r of tpl.required) {
    if (!extras[r]) fail(`Field "${r}" is required for this template.`);
  }

  let utm = body.utm_source;
  if (utm === undefined || utm === null || utm === '') utm = null;
  else if (typeof utm !== 'string' || utm.length > 50) fail('utm_source must be at most 50 characters.');

  return {
    template: tpl.id,
    role: body.role,
    industry: body.industry,
    team_size: sizeNum,
    company_description: body.company_description.trim(),
    decision_text: body.decision_text.trim(),
    extras,
    utm_source: utm,
  };
}

const FREE_DOMAINS = new Set([
  'gmail.com',
  'yahoo.com',
  'yahoo.co.in',
  'hotmail.com',
  'outlook.com',
  'live.com',
  'icloud.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
  'rediffmail.com',
  'zoho.com',
  'gmx.com',
  'yandex.com',
]);

const EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

/** Returns a lowercased work email or throws ValidationError. */
function validateWorkEmail(email) {
  if (typeof email !== 'string') fail('Enter your work email.');
  const e = email.trim().toLowerCase();
  if (e.length > 254 || !EMAIL_RE.test(e)) fail('Enter a valid email address.');
  const domain = e.split('@')[1];
  if (FREE_DOMAINS.has(domain)) fail('Please use your work email. Free email providers are not accepted.');
  return e;
}

module.exports = { validateIntake, validateWorkEmail, ValidationError, ROLES, INDUSTRIES, FREE_DOMAINS };
