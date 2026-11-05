'use strict';
// LLM access. LLM_MODE: auto (anthropic when a key is set, else mock), anthropic, mock.
// The mock gives deterministic, schema-valid output so the whole pipeline runs without a key.

const { load } = require('./config');

let client = null;
function anthropicClient(apiKey) {
  if (!client) {
    const Anthropic = require('@anthropic-ai/sdk');
    const Ctor = Anthropic.default || Anthropic;
    client = new Ctor({ apiKey, maxRetries: 3, timeout: 180000 });
  }
  return client;
}

function resolveMode(cfg = load()) {
  if (cfg.LLM_MODE === 'mock') return 'mock';
  if (cfg.LLM_MODE === 'anthropic') {
    if (!cfg.ANTHROPIC_API_KEY) throw new Error('LLM_MODE=anthropic but ANTHROPIC_API_KEY is not set');
    return 'anthropic';
  }
  return cfg.ANTHROPIC_API_KEY ? 'anthropic' : 'mock';
}

// Models that accept server-side refusal fallbacks.
const FALLBACK_MODELS = ['claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-1', 'claude-sonnet-5-5'];

/**
 * Run one model call.
 * @param {{task:'extract'|'agent'|'report', system:string, user:string, maxTokens:number, schema?:object}} req
 * @returns {Promise<{text:string, tokensIn:number, tokensOut:number}>}
 */
async function complete(req) {
  const cfg = load();
  const mode = resolveMode(cfg);
  if (mode === 'mock') return mockComplete(req);

  const model = req.task === 'report' ? cfg.REPORT_MODEL : cfg.AGENT_MODEL;
  const params = {
    model,
    max_tokens: req.maxTokens,
    system: req.system,
    messages: [{ role: 'user', content: req.user }],
  };
  const outputConfig = {};
  if (cfg.LLM_EFFORT) outputConfig.effort = cfg.LLM_EFFORT;
  if (req.schema) outputConfig.format = { type: 'json_schema', schema: req.schema };
  if (Object.keys(outputConfig).length) params.output_config = outputConfig;

  const api = anthropicClient(cfg.ANTHROPIC_API_KEY);
  let res;
  if (FALLBACK_MODELS.includes(model)) {
    res = await api.beta.messages.create({
      ...params,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    });
  } else {
    res = await api.messages.create(params);
  }

  const u = res.usage || {};
  const tokensIn =
    (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
  const tokensOut = u.output_tokens || 0;
  let text = '';
  if (res.stop_reason !== 'refusal') {
    for (const block of res.content || []) if (block.type === 'text') text += block.text;
  }
  return { text, tokensIn, tokensOut };
}

/** Pull the first JSON object out of a model reply. Returns null when it cannot be parsed. */
function parseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (_) {
    /* fall through */
  }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------- mock

function estTokens(s) {
  return Math.max(1, Math.ceil(String(s || '').length / 4));
}

function hashInt(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const MOCK_OBJECTIONS = [
  'too expensive',
  'unclear terms',
  'feels like pressure',
  'extra workload',
  'not enough proof',
  'approval delays',
  'fairness concerns',
];
const STANCES = ['positive', 'mixed', 'neutral', 'negative'];

function mockComplete(req) {
  let out;
  if (req.task === 'extract') {
    const scen = (req.user.match(/<scenario>([\s\S]*?)<\/scenario>/) || [, req.user])[1];
    const lines = scen.split('\n').map((l) => l.trim()).filter((l) => l.length > 15).slice(0, 8);
    out = {
      entities: [
        { id: 'E1', name: 'Company', type: 'organization' },
        { id: 'E2', name: 'Customers', type: 'group' },
        { id: 'E3', name: 'Frontline team', type: 'group' },
      ],
      facts: lines.map((l, i) => ({ id: `F${i + 1}`, text: l.slice(0, 200) })),
      edges: [
        { source: 'E1', target: 'E2', relation: 'offers decision to' },
        { source: 'E3', target: 'E2', relation: 'communicates with' },
      ],
    };
  } else if (req.task === 'agent') {
    const m = req.user.match(/AGENTS_JSON\s*([\s\S]*?)\nEND_AGENTS_JSON/);
    let agents = [];
    try {
      agents = JSON.parse(m ? m[1] : '[]');
    } catch (_) {
      agents = [];
    }
    const round = (req.user.match(/Round (\d+)/) || [, '1'])[1];
    out = {
      actions: agents.map((a) => {
        const h = hashInt(`${a.id}-${round}`);
        const stance = STANCES[h % STANCES.length];
        const objection = stance === 'positive' || stance === 'neutral' ? '' : MOCK_OBJECTIONS[h % MOCK_OBJECTIONS.length];
        const text =
          stance === 'positive'
            ? `As a ${a.role.toLowerCase()}, I think this works if it is explained clearly.`
            : stance === 'negative'
              ? `As a ${a.role.toLowerCase()}, my worry is ${objection}. I would push back on this.`
              : stance === 'mixed'
                ? `Some of this makes sense, but ${objection} could hurt it.`
                : `I need more detail before I decide how I feel about this.`;
        return { agent_id: a.id, stance, objection, text };
      }),
    };
  } else {
    const ids = [...req.user.matchAll(/\[(R\d+-P\d{3})\]/g)].map((x) => x[1]);
    out = {
      executive_summary:
        'Simulated reactions were split. Several people flagged clarity and fairness concerns that could slow adoption unless the terms are explained plainly.',
      risk_level: 'medium',
      friction_fixes: [
        'State the offer terms in one plain sentence before any detail.',
        'Give frontline staff a short answer to the top objection.',
        'Test the change with a small group before a full rollout.',
      ],
      quote_ids: ids.slice(0, 4),
      next_step: 'Pilot the change with one team for two weeks and compare results to a control group.',
    };
  }
  const text = JSON.stringify(out);
  return Promise.resolve({ text, tokensIn: estTokens(req.system) + estTokens(req.user), tokensOut: estTokens(text) });
}

function _resetClient() {
  client = null;
}

module.exports = { complete, parseJson, resolveMode, _resetClient };
