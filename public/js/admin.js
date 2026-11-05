'use strict';
(function () {
  const { el, api } = window.DS;
  const $ = (id) => document.getElementById(id);
  let token = null; // memory only, never stored

  const pct = (x) => `${Math.round((Number(x) || 0) * 1000) / 10}%`;
  const inr = (x) => `₹${(Number(x) || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

  function card(label, value, cls) {
    return el('div', { class: 'stat' }, [el('div', { class: 'k', text: label }), el('div', { class: `v ${cls || ''}`, text: String(value) })]);
  }

  async function load() {
    const res = await api('GET', '/api/admin/metrics', undefined, { 'X-Admin-Token': token });
    if (!res.ok) {
      token = null;
      $('dash').classList.add('hidden');
      $('login').classList.remove('hidden');
      $('login-error').textContent =
        res.status === 401 ? 'Wrong token.' : res.status === 503 ? 'Admin is not configured on the server (ADMIN_TOKEN is empty).' : (res.data && res.data.detail) || 'Could not load metrics.';
      return;
    }
    const m = res.data;
    const f = $('funnel');
    f.textContent = '';
    [
      ['Runs', m.runs_total],
      ['Reports generated', m.reports_generated],
      ['Reports released', m.reports_released],
      ['Winroom clicks', m.winroom_clicks],
      ['Trial starts', m.trial_starts],
      ['Release rate', pct(m.release_rate)],
      ['Click rate', pct(m.click_rate)],
      ['Trial rate', pct(m.trial_rate)],
    ].forEach(([k, v]) => f.appendChild(card(k, v)));
    f.appendChild(card('Kill gate', m.kill_gate, `gate-${m.kill_gate}`));
    const s = $('spend');
    s.textContent = '';
    [
      ['Avg cost per report', inr(m.avg_cost_per_report_inr)],
      ['Spend today', `${inr(m.spend_today_inr)} / ${inr(m.daily_cap_inr)}`],
      ['Spend this month', `${inr(m.spend_month_inr)} / ${inr(m.monthly_cap_inr)}`],
    ].forEach(([k, v]) => s.appendChild(card(k, v)));
    $('updated').textContent = `Updated ${new Date().toLocaleTimeString()}`;
    $('login').classList.add('hidden');
    $('dash').classList.remove('hidden');
  }

  $('login').addEventListener('submit', (e) => {
    e.preventDefault();
    $('login-error').textContent = '';
    const v = $('token').value;
    if (!v) {
      $('login-error').textContent = 'Enter the admin token.';
      return $('token').focus();
    }
    token = v;
    $('token').value = '';
    load();
  });
  $('refresh').addEventListener('click', load);
})();
