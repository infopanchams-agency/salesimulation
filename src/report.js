'use strict';
// Report statistics and assembly (PRD 5.10). Stats are computed here, never by the model.

const PITCH =
  "Friction like this is what Winroom's coaching and call-practice tools are built to reduce before it reaches real customers.";
const DISCLAIMER = 'Directional output from simulated buyers and reps. It is not a forecast of real customer behavior.';
const COMPLIANCE_DISCLAIMER =
  " This is not legal advice. Check any recovery or collections offer against your regulator's conduct rules before use.";

const DEFAULT_FIXES = [
  'Explain the change in one plain sentence before any detail.',
  'Give frontline staff a short, approved answer to the top objection.',
  'Pilot the change with a small group and compare against a control group.',
];

function round2(n) {
  return Math.round(n * 100) / 100;
}

function computeStats(posts) {
  const byRound = new Map();
  for (const p of posts) {
    if (!byRound.has(p.round)) byRound.set(p.round, { positive: 0, mixed: 0, neutral: 0, negative: 0 });
    byRound.get(p.round)[p.stance] += 1;
  }
  const stance_curve = [...byRound.keys()]
    .sort((a, b) => a - b)
    .map((round) => {
      const c = byRound.get(round);
      const total = c.positive + c.mixed + c.neutral + c.negative;
      return { round, ...c, total, net_sentiment: total ? round2((c.positive - c.negative) / total) : 0 };
    });

  const objCounts = new Map();
  for (const p of posts) {
    if ((p.stance === 'negative' || p.stance === 'mixed') && p.objection) {
      objCounts.set(p.objection, (objCounts.get(p.objection) || 0) + 1);
    }
  }
  const top_objections = [...objCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 3)
    .map(([objection, count]) => ({ objection, count }));

  const negatives = posts.filter((p) => p.stance === 'negative').length;
  const negative_share = posts.length ? round2(negatives / posts.length) : 0;

  const candidates = [
    ...posts.filter((p) => p.stance === 'negative').slice(0, 20),
    ...posts.filter((p) => p.stance === 'positive').slice(0, 6),
  ];

  return { stance_curve, top_objections, negative_share, candidates };
}

function truncateWords(s, max) {
  const words = String(s).trim().split(/\s+/).filter(Boolean);
  return words.length <= max ? words.join(' ') : words.slice(0, max).join(' ') + '…';
}

function fallbackSummary(stats, postsCount) {
  const top = stats.top_objections[0];
  const share = Math.round(stats.negative_share * 100);
  return (
    `Across ${postsCount} simulated reactions, ${share}% were negative.` +
    (top ? ` The most common objection was "${top.objection}".` : '')
  );
}

/**
 * Merge model output with computed stats. Quotes always come from stored posts.
 * @param {object|null} modelOut parsed report JSON from the model (may be null)
 */
function assembleReport({ run, template, posts, stats, roundsCompleted, partial, modelOut }) {
  const m = modelOut && typeof modelOut === 'object' ? modelOut : {};
  const candidateIds = new Set(stats.candidates.map((p) => p.id));
  const postById = new Map(posts.map((p) => [p.id, p]));

  let quoteIds = Array.isArray(m.quote_ids) ? m.quote_ids.filter((id) => typeof id === 'string' && candidateIds.has(id)) : [];
  quoteIds = [...new Set(quoteIds)].slice(0, 5);
  if (!quoteIds.length) quoteIds = stats.candidates.slice(0, 3).map((p) => p.id);
  const quotes = quoteIds.map((id) => {
    const p = postById.get(id);
    return { agent_role: p.agent_role, platform: p.platform, round: p.round, stance: p.stance, text: p.text };
  });

  const risk_level = ['low', 'medium', 'high'].includes(m.risk_level) ? m.risk_level : 'medium';
  const executive_summary =
    typeof m.executive_summary === 'string' && m.executive_summary.trim()
      ? truncateWords(m.executive_summary, 80)
      : fallbackSummary(stats, posts.length);

  let friction_fixes = Array.isArray(m.friction_fixes)
    ? m.friction_fixes.filter((f) => typeof f === 'string' && f.trim()).map((f) => truncateWords(f, 25))
    : [];
  for (const d of DEFAULT_FIXES) if (friction_fixes.length < 3) friction_fixes.push(d);
  friction_fixes = friction_fixes.slice(0, 3);

  const next_step =
    typeof m.next_step === 'string' && m.next_step.trim()
      ? m.next_step.trim().slice(0, 300)
      : 'Pilot the change with one team before a full rollout and compare results against a control group.';

  return {
    scenario_summary: run.decision_text.slice(0, 240),
    agent_count: new Set(posts.map((p) => p.agent_id)).size,
    rounds_completed: roundsCompleted,
    partial,
    risk_level,
    executive_summary,
    stance_curve: stats.stance_curve,
    top_objections: stats.top_objections,
    negative_share: stats.negative_share,
    quotes,
    friction_fixes,
    next_step,
    pitch: PITCH,
    disclaimer: DISCLAIMER + (template.compliance ? COMPLIANCE_DISCLAIMER : ''),
  };
}

module.exports = { computeStats, assembleReport, PITCH, DISCLAIMER, COMPLIANCE_DISCLAIMER };
