# Decision Simulator (Winroom lead magnet)

A free tool for sales, collections, retention and support managers. They describe a decision, and 80 simulated buyers and staff react to it over 3 rounds. The result is a risk report. The full report is released by work email and ends with a tracked Winroom trial CTA.

Built from *PRD: Decision Simulator MVP (Winroom Lead Magnet)*. Live target: `https://salesimulation.aerobee.ai`.

## Stack

- **Node.js 22.13+ and Express.** One process runs the HTTP server and a single background worker thread (PRD 8).
- **SQLite** through Node's built-in `node:sqlite`, so there are no native modules to compile.
- **Anthropic API** through `@anthropic-ai/sdk`, with structured JSON outputs. `LLM_MODE=mock` runs the whole pipeline without a key.
- **Plain HTML, CSS and JS frontend** in `public/`. No frameworks and no bundler.
- **Email:** SMTP with STARTTLS via `nodemailer`. If `SMTP_HOST` is unset, each email is written to `OUTBOX_DIR` as an HTML file.

## Run locally

```bash
npm install
cp .env.example .env   # optional; without a key it runs in mock mode
npm start              # http://localhost:3000
npm test               # 32 tests
```

Pages: `/` (intake form), `/run.html?id=…` (status, teaser, report), `/admin.html` (metrics, needs `ADMIN_TOKEN`).

## Deploy on Hostinger (Node.js web app)

- Build command `npm run build`. It checks the Node version and that every module loads; there is no bundling step.
- Start command `npm start`, entry file `server.js`.
- The server listens on `process.env.PORT`, bound to `0.0.0.0`.
- Set every secret in Hostinger's environment variables, never in the repo: `ANTHROPIC_API_KEY`, `ADMIN_TOKEN`, `WEBHOOK_SECRET`, the SMTP settings, `PUBLIC_BASE_URL`, `WINROOM_TRIAL_URL` and `TRUST_PROXY=1`.
- Set `DATABASE_PATH` to a directory that survives redeploys.

A `Dockerfile` is included for the PRD's original container plus Caddy setup. Mount `/app/data` as a volume.

## API

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/api/templates` | none | Enabled templates for the form |
| POST | `/api/runs` | none | Create a run → `201 {id, status}` |
| GET | `/api/runs/{id}` | none | Status, then teaser, then full report after release |
| POST | `/api/runs/{id}/release` | none | Work-email gate. Emails the report and returns it |
| GET | `/go/winroom?run=` | none | Logs the click, then 302 to Winroom with UTM params |
| POST | `/api/webhooks/winroom-trial` | `X-Signature` HMAC-SHA256 | Trial started |
| GET | `/api/admin/metrics` | `X-Admin-Token` | Funnel and spend |

## Deviations from the PRD

These are deliberate. Each one keeps the PRD's behavior while adapting to the hosting target or the current API.

1. **Node.js instead of Python/FastAPI.** Hostinger's managed hosting runs Node.js apps, not long-running Python.
   - Endpoints, data model, stages, limits and status codes follow the PRD.
   - `backend/app/templates.py` became `src/templates.js`.
   - The acceptance command is `npm test` (32 tests covering every area listed in PRD 10).
2. **Persona RNG.** Python's `random.Random(seed)` is replaced by a SHA-256-seeded mulberry32 PRNG. The guarantee is unchanged: the same template always gives the same 100-person pool, and the same run id always gives the same 80-person panel. The pools differ from the Python reference.
3. **Default model is `claude-opus-5-5` at `LLM_EFFORT=low`.**
   - Price defaults are set to its rates ($4 / $20 per MTok) so the INR 200 kill-switch counts real cost. The PRD's 1.0 / 5.0 defaults would undercount it about 4×.
   - Change `AGENT_MODEL`, `REPORT_MODEL` and both price variables together.
   - Server-side refusal fallback (`fallbacks: "default"`) is on for models that support it.
4. **Token limits are higher than the PRD** (extract 2400, agent 4000, report 2000). Current models count thinking tokens against `max_tokens`, and the PRD values risk cutting off the JSON. Cost is still capped per run by `RUN_BUDGET_INR`. All three are env-configurable.
5. **Partial runs skip the report LLM call.** Once the budget is hit, the report is built from code-computed stats and fallbacks. Making another call would exceed the budget.
6. **`email_captured` is logged on release**, resolving the note in PRD 7.
7. **Domain:** `salesimulation.aerobee.ai` instead of `simulate.aerobee.com`. Set it through `PUBLIC_BASE_URL`.

## Known gaps (accepted for MVP, from PRD 13)

These are not built yet:

- Unsubscribe endpoint. Build it before public launch.
- Delete-by-email for DPDP requests.
- Redaction of personal names.
- Industry-specific personas.
- CI.

The collections and retention leads must also review the persona pools before live use, and the compliance checklist in PRD 11 applies before the first live `settlement_offer` run.
