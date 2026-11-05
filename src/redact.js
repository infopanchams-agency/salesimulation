'use strict';
// PII redaction (PRD 5.4). Order matters: specific patterns run before the generic number rule.

const RULES = [
  { key: 'email', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, repl: '[EMAIL]' },
  { key: 'pan', re: /\b[A-Za-z]{5}[0-9]{4}[A-Za-z]\b/g, repl: '[PAN]' },
  { key: 'aadhaar', re: /\b\d{4}[ -]?\d{4}[ -]?\d{4}\b/g, repl: '[AADHAAR]' },
  {
    key: 'phone',
    re: /(?<![\w+])(?:\+\d{1,3}[ -]?)?\d(?:[ -]?\d){9}(?!\w)/g,
    repl: '[PHONE]',
  },
  { key: 'number', re: /(?<!\w|\d\.)\d{9,18}(?!\w|\.\d)/g, repl: '[NUMBER]' },
];

function redact(text, counts) {
  if (typeof text !== 'string' || !text) return text;
  let out = text;
  for (const rule of RULES) {
    out = out.replace(rule.re, () => {
      counts[rule.key] = (counts[rule.key] || 0) + 1;
      return rule.repl;
    });
  }
  return out;
}

/** Redact decision_text, company_description and every extra value. Returns { data, counts }. */
function redactIntake(intake) {
  const counts = {};
  const data = { ...intake };
  data.decision_text = redact(intake.decision_text, counts);
  data.company_description = redact(intake.company_description, counts);
  data.extras = {};
  for (const [k, v] of Object.entries(intake.extras || {})) data.extras[k] = redact(v, counts);
  return { data, counts };
}

module.exports = { redact, redactIntake };
