'use strict';
// Background simulation worker (PRD 5.5 to 5.10). One run at a time, one thread.

const db = require('./db');
const { load } = require('./config');
const llm = require('./llm');
const { getTemplate, COMPLIANCE_LINE } = require('./templates');
const { samplePanel } = require('./personas');
const { computeStats, assembleReport } = require('./report');

const FAIL_TEXT = 'The simulation failed. Please submit the scenario again.';
const ROLE_LABELS = {
  sales_leader: 'Sales leader',
  support_manager: 'Support manager',
  collections_manager: 'Collections manager',
  retention_manager: 'Retention manager',
};
const STANCES = new Set(['positive', 'mixed', 'neutral', 'negative']);

class BudgetExceeded extends Error {}

// ---------------------------------------------------------------- scenario

function buildScenario(run, template) {
  const lines = [
    template.frame,
    `Company: ${run.company_desc}`,
    `Industry: ${run.industry}. Team size: ${run.team_size}. Submitted by: ${ROLE_LABELS[run.role] || run.role}.`,
    `Decision being tested: ${run.decision_text}`,
  ];
  for (const key of [...template.required, ...template.optional]) {
    const v = run.extras && run.extras[key] ? run.extras[key] : 'not specified';
    lines.push(`${key.replace(/_/g, ' ')}: ${v}`);
  }
  if (template.compliance) lines.push(COMPLIANCE_LINE);
  return lines.join('\n');
}

// ---------------------------------------------------------------- cost

function callCostInr(cfg, tokensIn, tokensOut) {
  return (
    ((tokensIn / 1e6) * cfg.PRICE_IN_USD_PER_MTOK + (tokensOut / 1e6) * cfg.PRICE_OUT_USD_PER_MTOK) * cfg.USD_INR
  );
}

function makeCaller(runId, cfg) {
  const state = { cost: db.getRun(runId).cost_inr || 0 };
  async function call(req) {
    const res = await llm.complete(req);
    const inr = callCostInr(cfg, res.tokensIn, res.tokensOut);
    state.cost += inr;
    db.addSpend(runId, inr);
    db.updateRun(runId, { cost_inr: state.cost });
    if (state.cost >= cfg.RUN_BUDGET_INR) {
      const err = new BudgetExceeded('run budget reached');
      err.result = res;
      throw err;
    }
    return res;
  }
  return { call, state };
}

// ---------------------------------------------------------------- graph

const GRAPH_SCHEMA = {
  type: 'object',
  properties: {
    entities: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' }, name: { type: 'string' }, type: { type: 'string' } },
        required: ['id', 'name', 'type'],
        additionalProperties: false,
      },
    },
    facts: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' }, text: { type: 'string' } },
        required: ['id', 'text'],
        additionalProperties: false,
      },
    },
    edges: {
      type: 'array',
      items: {
        type: 'object',
        properties: { source: { type: 'string' }, target: { type: 'string' }, relation: { type: 'string' } },
        required: ['source', 'target', 'relation'],
        additionalProperties: false,
      },
    },
  },
  required: ['entities', 'facts', 'edges'],
  additionalProperties: false,
};

function fallbackFacts(scenario) {
  return scenario
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length >= 12 && !/: not specified$/.test(l))
    .slice(0, 12)
    .map((text, i) => ({ id: `F${i + 1}`, text: text.slice(0, 300) }));
}

function normalizeGraph(parsed, scenario) {
  const g = parsed && typeof parsed === 'object' ? parsed : {};
  const entities = (Array.isArray(g.entities) ? g.entities : []).filter((e) => e && typeof e === 'object').slice(0, 12);
  let facts = (Array.isArray(g.facts) ? g.facts : [])
    .filter((f) => f && typeof f.text === 'string' && f.text.trim())
    .slice(0, 12)
    .map((f, i) => ({ id: typeof f.id === 'string' ? f.id : `F${i + 1}`, text: f.text.trim().slice(0, 300) }));
  const edges = (Array.isArray(g.edges) ? g.edges : []).filter((e) => e && typeof e === 'object').slice(0, 30);
  let fallback = false;
  if (!facts.length) {
    facts = fallbackFacts(scenario);
    fallback = true;
  }
  return { entities, facts, edges, fallback };
}

// ---------------------------------------------------------------- memory

const STOP = new Set('a an and are as at be by for from has have in is it of on or the to with who was this that not'.split(' '));
function words(s) {
  return new Set(
    String(s)
      .toLowerCase()
      .split(/[^a-z0-9+]+/)
      .filter((w) => w.length > 2 && !STOP.has(w)),
  );
}

/** Top-4 facts by keyword overlap with the persona's role, concern and style. */
function memoryFor(persona, facts) {
  const key = words(`${persona.role} ${persona.concern} ${persona.style}`);
  return facts
    .map((f, i) => {
      let score = 0;
      for (const w of words(f.text)) if (key.has(w)) score += 1;
      return { f, i, score };
    })
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, 4)
    .map((x) => x.f.text);
}

// ---------------------------------------------------------------- rounds

const AGENT_SYSTEM = [
  'You simulate how specific people react to a business decision.',
  'You speak for every agent listed in AGENTS_JSON, in character, given their side, role, style, concern, and memory.',
  'Each agent may reply to the recent thread. Keep each text to one to three short sentences.',
  'stance is one of: positive, mixed, neutral, negative.',
  'objection is a short phrase (a few words) naming the main objection, or an empty string if there is none.',
  'Never write threats, harassment, or false urgency toward customers, even when a character is frustrated.',
  'Return JSON only, in this exact shape: {"actions":[{"agent_id":"P001","stance":"mixed","objection":"unclear terms","text":"..."}]}',
  'Return exactly one action per agent.',
].join('\n');

const AGENT_SCHEMA = {
  type: 'object',
  properties: {
    actions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          agent_id: { type: 'string' },
          stance: { type: 'string', enum: ['positive', 'mixed', 'neutral', 'negative'] },
          objection: { type: 'string' },
          text: { type: 'string' },
        },
        required: ['agent_id', 'stance', 'objection', 'text'],
        additionalProperties: false,
      },
    },
  },
  required: ['actions'],
  additionalProperties: false,
};

function batchPrompt(scenario, thread, round, rounds, agentsJson) {
  const recent = thread.slice(-12);
  const threadText = recent.length
    ? recent.map((p) => `[${p.id}] ${p.agent_role} (${p.platform}, ${p.stance}): ${p.text}`).join('\n')
    : '(no posts yet)';
  return [
    `<scenario>\n${scenario}\n</scenario>`,
    '',
    `Round ${round} of ${rounds}.`,
    'Recent thread (last 12 posts):',
    threadText,
    '',
    'AGENTS_JSON',
    JSON.stringify(agentsJson),
    'END_AGENTS_JSON',
    '',
    'Write one action for each agent above.',
  ].join('\n');
}

function parseActions(text, batch, round, seen) {
  const parsed = llm.parseJson(text);
  const actions = parsed && Array.isArray(parsed.actions) ? parsed.actions : [];
  const byId = new Map(batch.map((p) => [p.id, p]));
  const posts = [];
  for (const a of actions) {
    if (!a || typeof a !== 'object') continue;
    const persona = byId.get(a.agent_id);
    if (!persona || seen.has(a.agent_id)) continue;
    const body = typeof a.text === 'string' ? a.text.trim().slice(0, 300) : '';
    if (!body) continue;
    seen.add(a.agent_id);
    posts.push({
      id: `R${round}-${persona.id}`,
      round,
      agent_id: persona.id,
      agent_role: persona.role,
      side: persona.side,
      platform: persona.side === 'buyer' ? 'buyer_forum' : 'rep_channel',
      stance: STANCES.has(a.stance) ? a.stance : 'neutral',
      objection: typeof a.objection === 'string' ? a.objection.trim().toLowerCase().slice(0, 60) : '',
      text: body,
    });
  }
  return posts;
}

// ---------------------------------------------------------------- report call

const REPORT_SYSTEM = [
  'You write a short decision-risk report from simulated reactions. The statistics are already computed; do not change them.',
  'executive_summary: at most 80 words, plain language.',
  'risk_level: low, medium, or high.',
  'friction_fixes: exactly 3 concrete fixes, each at most 25 words.',
  'quote_ids: up to 5 ids chosen only from the QUOTE CANDIDATES list, copied exactly.',
  'next_step: one sentence.',
  'Return JSON only.',
].join('\n');

const REPORT_SCHEMA = {
  type: 'object',
  properties: {
    executive_summary: { type: 'string' },
    risk_level: { type: 'string', enum: ['low', 'medium', 'high'] },
    friction_fixes: { type: 'array', items: { type: 'string' } },
    quote_ids: { type: 'array', items: { type: 'string' } },
    next_step: { type: 'string' },
  },
  required: ['executive_summary', 'risk_level', 'friction_fixes', 'quote_ids', 'next_step'],
  additionalProperties: false,
};

function reportPrompt(scenario, stats, postsCount) {
  return [
    `<scenario>\n${scenario}\n</scenario>`,
    '',
    `Total posts: ${postsCount}. Negative share: ${stats.negative_share}.`,
    `Stance by round: ${JSON.stringify(stats.stance_curve)}`,
    `Top objections: ${JSON.stringify(stats.top_objections)}`,
    '',
    'QUOTE CANDIDATES',
    ...stats.candidates.map((p) => `[${p.id}] ${p.agent_role} (${p.stance}): ${p.text}`),
  ].join('\n');
}

// ---------------------------------------------------------------- run

async function processRun(runId) {
  const cfg = load();
  const run = db.getRun(runId);
  const template = getTemplate(run.template);
  const { call } = makeCaller(runId, cfg);
  const scenario = buildScenario(run, template);
  const posts = [];
  let roundsCompleted = 0;
  let partial = false;

  try {
    // graph_build
    db.updateRun(runId, { status: 'running', stage: 'graph_build', progress: 5 });
    let graph;
    try {
      const res = await call({
        task: 'extract',
        system:
          'Extract a small fact graph from the scenario. entities: at most 12. facts: at most 12 short factual statements. edges: at most 30. Return JSON only.',
        user: `<scenario>\n${scenario}\n</scenario>`,
        maxTokens: cfg.MAX_TOKENS_EXTRACT,
        schema: GRAPH_SCHEMA,
      });
      graph = normalizeGraph(llm.parseJson(res.text), scenario);
    } catch (e) {
      if (!(e instanceof BudgetExceeded)) throw e;
      graph = normalizeGraph(llm.parseJson(e.result && e.result.text), scenario);
      throw e;
    } finally {
      if (graph) db.updateRun(runId, { graph });
    }

    // simulate
    db.updateRun(runId, { stage: 'simulate', progress: 15 });
    const panel = samplePanel(run.template, runId, cfg.AGENTS_PER_RUN);
    for (let round = 1; round <= cfg.ROUNDS; round++) {
      const seen = new Set();
      for (let i = 0; i < panel.length; i += cfg.AGENT_BATCH_SIZE) {
        const batch = panel.slice(i, i + cfg.AGENT_BATCH_SIZE);
        const agentsJson = batch.map((p) => ({
          id: p.id,
          side: p.side,
          role: p.role,
          style: p.style,
          concern: p.concern,
          memory: memoryFor(p, graph.facts),
        }));
        const req = {
          task: 'agent',
          system: AGENT_SYSTEM,
          user: batchPrompt(scenario, posts, round, cfg.ROUNDS, agentsJson),
          maxTokens: cfg.MAX_TOKENS_AGENT,
          schema: AGENT_SCHEMA,
        };
        try {
          const res = await call(req);
          posts.push(...parseActions(res.text, batch, round, seen));
        } catch (e) {
          if (e instanceof BudgetExceeded) posts.push(...parseActions(e.result.text, batch, round, seen));
          throw e;
        }
      }
      roundsCompleted = round;
      db.updateRun(runId, { posts, progress: Math.round(15 + (60 * round) / cfg.ROUNDS) });
    }
  } catch (e) {
    if (!(e instanceof BudgetExceeded)) return failRun(runId, e);
    partial = true;
  }

  try {
    db.updateRun(runId, { stage: 'report', progress: 85, posts });
    const stats = computeStats(posts);
    let modelOut = null;
    if (!partial && posts.length) {
      try {
        const res = await call({
          task: 'report',
          system: REPORT_SYSTEM,
          user: reportPrompt(scenario, stats, posts.length),
          maxTokens: cfg.MAX_TOKENS_REPORT,
          schema: REPORT_SCHEMA,
        });
        modelOut = llm.parseJson(res.text);
      } catch (e) {
        if (!(e instanceof BudgetExceeded)) throw e;
        partial = true;
        modelOut = llm.parseJson(e.result && e.result.text);
      }
    }
    const report = assembleReport({ run, template, posts, stats, roundsCompleted, partial, modelOut });
    db.updateRun(runId, { status: 'report_ready', stage: 'done', progress: 100, report });
    db.logEvent(runId, 'report_ready', {
      partial,
      rounds_completed: roundsCompleted,
      cost_inr: Math.round((db.getRun(runId).cost_inr || 0) * 100) / 100,
    });
  } catch (e) {
    failRun(runId, e);
  }
}

function failRun(runId, err) {
  console.error(`[worker] run ${runId} failed:`, err && err.stack ? err.stack : err);
  db.updateRun(runId, { status: 'failed', error: FAIL_TEXT });
  db.logEvent(runId, 'run_failed', { message: String((err && err.message) || err).slice(0, 300) });
}

// ---------------------------------------------------------------- worker loop

let running = false;
let timer = null;
let wake = null;

function nextQueuedId() {
  const row = db.get().prepare("SELECT id FROM runs WHERE status = 'queued' ORDER BY created_at ASC, rowid ASC LIMIT 1").get();
  return row ? row.id : null;
}

/** Process the oldest queued run. Returns the id processed, or null. */
async function processNext() {
  const id = nextQueuedId();
  if (!id) return null;
  await processRun(id);
  return id;
}

function resetStale() {
  db.get().prepare("UPDATE runs SET status = 'queued', stage = 'queued', progress = 0 WHERE status = 'running'").run();
}

function startWorker() {
  if (running) return;
  running = true;
  resetStale();
  const loop = async () => {
    while (running) {
      let id = null;
      try {
        id = await processNext();
      } catch (e) {
        console.error('[worker] loop error', e);
      }
      if (!id) {
        await new Promise((resolve) => {
          wake = resolve;
          timer = setTimeout(resolve, 2000);
        });
        wake = null;
      }
    }
  };
  loop();
}

function kick() {
  if (wake) {
    clearTimeout(timer);
    wake();
  }
}

function stopWorker() {
  running = false;
  kick();
}

module.exports = {
  processRun,
  processNext,
  startWorker,
  stopWorker,
  kick,
  resetStale,
  buildScenario,
  memoryFor,
  parseActions,
  callCostInr,
  FAIL_TEXT,
};
