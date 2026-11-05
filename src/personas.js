'use strict';
const crypto = require('node:crypto');

// PRD 5.7. Deterministic: the same template always yields the same pool,
// and the same run id always yields the same 80-person panel.

const ROLES = {
  settlement_offer: {
    internal: ['Collections agent', 'Collections team lead', 'Collections manager', 'Compliance lead'],
    buyer: [
      'Borrower 90+ days overdue',
      'Borrower who recently lost income',
      'Borrower who has already paid part',
      'Borrower who ignores calls',
    ],
  },
  cancel_save_offer: {
    internal: ['Retention agent', 'Retention team lead', 'Account manager', 'Finance controller'],
    buyer: [
      'Customer requesting cancellation',
      'Long-tenure customer on a discount',
      'Price-sensitive subscriber',
      'Customer who switched providers before',
    ],
  },
  refund_goodwill: {
    internal: ['Support agent', 'Support team lead', 'Support operations manager', 'Finance controller'],
    buyer: [
      'Customer waiting on a refund',
      'Customer who had a bad experience',
      'Repeat complainer',
      'Customer with a small issue',
    ],
  },
  sales_script: {
    internal: ['Account executive', 'Tele-sales floor manager', 'Sales leader', 'Sales trainer'],
    buyer: [
      'Prospect comparing vendors',
      'Skeptical procurement manager',
      'Small business owner',
      'Existing customer nearing renewal',
    ],
  },
};

const STYLES = [
  'blunt and data-driven',
  'warm but cautious',
  'impatient early adopter',
  'skeptical veteran',
  'budget-first',
  'loyal and slow to change',
];

const CONCERNS = [
  'price sensitivity',
  'switching cost',
  'trust in the vendor',
  'team morale',
  'compliance risk',
  'measurable return',
  'workload',
  'loyalty',
  'approval politics',
  'speed of rollout',
  'recovery rate',
  'fairness perception',
  'conduct risk',
  'cost to company',
];

/** Seeded PRNG (mulberry32) keyed by a string through SHA-256. */
function rng(seedStr) {
  let a = crypto.createHash('sha256').update(String(seedStr)).digest().readUInt32BE(0);
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(rand, arr) {
  return arr[Math.floor(rand() * arr.length)];
}

function buildPool(template) {
  const roles = ROLES[template];
  if (!roles) throw new Error(`no persona roles for template ${template}`);
  const rand = rng(`${template}-7`);
  const pool = [];
  for (let i = 1; i <= 100; i++) {
    const side = i % 2 === 1 ? 'internal' : 'buyer';
    pool.push({
      id: `P${String(i).padStart(3, '0')}`,
      side,
      role: pick(rand, roles[side]),
      style: pick(rand, STYLES),
      concern: pick(rand, CONCERNS),
    });
  }
  return pool;
}

/** Seed = first 8 hex digits of SHA-256 of the run id. */
function runSeed(runId) {
  return crypto.createHash('sha256').update(String(runId)).digest('hex').slice(0, 8);
}

function samplePanel(template, runId, count = 80) {
  const pool = buildPool(template);
  const rand = rng(runSeed(runId));
  // Fisher-Yates, then take the first `count`, then restore pool order for readability.
  const idx = pool.map((_, i) => i);
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  return idx
    .slice(0, Math.min(count, pool.length))
    .sort((a, b) => a - b)
    .map((i) => pool[i]);
}

module.exports = { buildPool, samplePanel, runSeed, ROLES, STYLES, CONCERNS };
