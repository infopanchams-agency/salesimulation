'use strict';
(function () {
  const { el, api, PLATFORM } = window.DS;
  const $ = (id) => document.getElementById(id);
  const id = new URLSearchParams(location.search).get('id');
  const ORDER = ['queued', 'graph_build', 'simulate', 'report', 'done'];
  const STAGE_TEXT = {
    queued: 'Waiting in queue',
    graph_build: 'Reading your scenario',
    simulate: 'Simulated people are reacting',
    report: 'Writing your report',
    done: 'Done',
  };
  const TEMPLATE_LABELS = {
    settlement_offer: 'Settlement or waiver offer',
    cancel_save_offer: 'Cancellation save-offer change',
    refund_goodwill: 'Refund or goodwill policy change',
    sales_script: 'Sales script or objection-handling change',
  };

  let timer = null;
  let lastStage = null;
  let shown = null;

  function show(view) {
    if (shown === view) return;
    shown = view;
    for (const v of ['progress-view', 'teaser-view', 'report-view', 'failed-view']) $(v).classList.toggle('hidden', v !== view);
    const heading = $(view).querySelector('h1');
    if (heading && view !== 'progress-view') heading.focus();
  }

  function renderProgress(s) {
    const pct = Math.max(0, Math.min(100, Number(s.progress) || 0));
    $('bar-fill').style.width = `${pct}%`;
    $('bar').setAttribute('aria-valuenow', String(pct));
    const idx = ORDER.indexOf(s.stage);
    document.querySelectorAll('#stages li').forEach((li) => {
      const i = ORDER.indexOf(li.dataset.stage);
      li.classList.toggle('done', i < idx);
      li.classList.toggle('now', i === idx);
    });
    if (s.stage !== lastStage) {
      lastStage = s.stage;
      const live = $('status-live');
      live.classList.remove('hidden');
      live.className = 'fine';
      live.textContent = `${STAGE_TEXT[s.stage] || s.stage} (${pct}%)`;
    }
  }

  function renderTeaser(t) {
    const risk = $('t-risk');
    risk.textContent = t.risk_level.charAt(0).toUpperCase() + t.risk_level.slice(1);
    risk.className = `v risk-${t.risk_level}`;
    $('t-agents').textContent = String(t.agent_count);
    $('t-objection').textContent = t.top_objection ? `“${t.top_objection}”` : 'No repeated objection';
  }

  function renderReport(s, justSent) {
    const r = s.report;
    $('r-template').textContent = TEMPLATE_LABELS[s.template] || 'Decision Simulator';
    $('r-scenario').textContent = r.scenario_summary;
    const pill = $('r-risk');
    pill.textContent = `${r.risk_level.toUpperCase()} RISK`;
    pill.className = `pill ${r.risk_level}`;
    $('r-summary').textContent = r.executive_summary;
    $('r-meta').textContent = `${r.agent_count} simulated people · ${r.rounds_completed} round(s) · ${Math.round(r.negative_share * 100)}% of reactions negative`;
    if (r.partial) {
      $('r-partial').textContent = 'This run hit its cost limit before finishing, so the report is based on the reactions collected so far.';
      $('r-partial').classList.remove('hidden');
    }
    if (justSent) {
      $('r-sent').textContent = 'We have emailed you a copy of this report.';
      $('r-sent').classList.remove('hidden');
    }

    const curve = $('r-curve');
    curve.textContent = '';
    for (const row of r.stance_curve) {
      const bar = el('div', { class: 'bar', role: 'img', 'aria-label': `Round ${row.round}: ${row.positive} positive, ${row.mixed} mixed, ${row.neutral} neutral, ${row.negative} negative` });
      for (const [k, cls] of [['positive', 'b-pos'], ['mixed', 'b-mix'], ['neutral', 'b-neu'], ['negative', 'b-neg']]) {
        const seg = el('span', { class: cls });
        seg.style.width = row.total ? `${(row[k] / row.total) * 100}%` : '0';
        bar.appendChild(seg);
      }
      const net = row.net_sentiment > 0 ? `+${row.net_sentiment}` : String(row.net_sentiment);
      curve.appendChild(el('div', { class: 'bar-row' }, [el('span', { text: `Round ${row.round}` }), bar, el('span', { text: `net ${net}`, title: 'Net sentiment: (positive − negative) / total' })]));
    }
    if (!r.stance_curve.length) curve.appendChild(el('p', { class: 'fine', text: 'No reactions were collected.' }));

    const obj = $('r-objections');
    obj.textContent = '';
    for (const o of r.top_objections) obj.appendChild(el('li', null, [o.objection, el('span', { class: 'fine', text: ` · raised ${o.count} time${o.count === 1 ? '' : 's'}` })]));
    if (!r.top_objections.length) obj.appendChild(el('li', { text: 'No repeated objections.' }));

    const quotes = $('r-quotes');
    quotes.textContent = '';
    for (const q of r.quotes) {
      quotes.appendChild(
        el('blockquote', { class: `quote ${q.stance}` }, [
          el('p', { text: `“${q.text}”` }),
          el('small', { text: `${q.agent_role} · ${PLATFORM[q.platform] || q.platform} · round ${q.round} · ${q.stance}` }),
        ]),
      );
    }
    if (!r.quotes.length) quotes.appendChild(el('p', { class: 'fine', text: 'No quotes available.' }));

    const fixes = $('r-fixes');
    fixes.textContent = '';
    for (const f of r.friction_fixes) fixes.appendChild(el('li', { text: f }));
    $('r-next').textContent = r.next_step;
    $('r-pitch').textContent = r.pitch;
    $('r-cta').href = `/go/winroom?run=${encodeURIComponent(s.id)}`;
    $('r-disclaimer').textContent = r.disclaimer;
  }

  function render(s, justSent) {
    if (s.status === 'failed') {
      $('failed-text').textContent = s.error || 'The simulation failed. Please submit the scenario again.';
      show('failed-view');
      return stop();
    }
    if (s.status === 'report_ready') {
      if (s.report) {
        renderReport(s, justSent);
        show('report-view');
      } else if (s.teaser) {
        renderTeaser(s.teaser);
        show('teaser-view');
      }
      return stop();
    }
    renderProgress(s);
    show('progress-view');
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  async function poll() {
    const res = await api('GET', `/api/runs/${encodeURIComponent(id)}`);
    if (res.status === 404) {
      $('page-error').textContent = 'We could not find this simulation. Start a new one from the home page.';
      $('progress-view').classList.add('hidden');
      return stop();
    }
    if (!res.ok) return; // transient; keep polling
    render(res.data, false);
  }

  $('release').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('release-error');
    err.textContent = '';
    const emailInput = $('email');
    const consent = $('consent');
    emailInput.removeAttribute('aria-invalid');
    consent.removeAttribute('aria-invalid');
    const email = emailInput.value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      err.textContent = 'Enter a valid work email.';
      emailInput.setAttribute('aria-invalid', 'true');
      return emailInput.focus();
    }
    if (!consent.checked) {
      err.textContent = 'Please tick the box to receive the report by email.';
      consent.setAttribute('aria-invalid', 'true');
      return consent.focus();
    }
    const btn = $('release-btn');
    btn.disabled = true;
    btn.textContent = 'Sending…';
    const res = await api('POST', `/api/runs/${encodeURIComponent(id)}/release`, { email, consent: true });
    btn.disabled = false;
    btn.textContent = 'Email me the full report';
    if (res.ok && res.data.report) return render(res.data, true);
    err.textContent = (res.data && res.data.detail) || 'Something went wrong. Please try again.';
  });

  if (!id) {
    $('page-error').textContent = 'No simulation id in the link. Start a new simulation from the home page.';
    $('progress-view').classList.add('hidden');
    return;
  }
  poll();
  timer = setInterval(poll, 3000);
})();
