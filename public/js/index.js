'use strict';
(function () {
  const { el, api } = window.DS;
  const form = document.getElementById('intake');
  const tplBox = document.getElementById('templates');
  const extrasBox = document.getElementById('extras');
  const errorBox = document.getElementById('form-error');
  const submitBtn = document.getElementById('submit');
  const role = document.getElementById('role');

  const DESCRIPTIONS = {
    settlement_offer: 'Collections: settlement or waiver for borrowers',
    cancel_save_offer: 'Retention: offer for customers who ask to cancel',
    refund_goodwill: 'Support: refund or goodwill policy',
    sales_script: 'Sales: pitch or objection handling',
  };
  const ROLE_TEMPLATE = {
    collections_manager: 'settlement_offer',
    retention_manager: 'cancel_save_offer',
    support_manager: 'refund_goodwill',
    sales_leader: 'sales_script',
  };

  let templates = [];

  function current() {
    const checked = form.querySelector('input[name=template]:checked');
    return checked ? templates.find((t) => t.id === checked.value) : null;
  }

  function renderTemplates() {
    tplBox.textContent = '';
    templates.forEach((t, i) => {
      const input = el('input', { type: 'radio', name: 'template', value: t.id, id: `tpl_${t.id}`, required: i === 0 });
      input.addEventListener('change', renderExtras);
      tplBox.appendChild(
        el('label', { class: 'tpl', for: `tpl_${t.id}` }, [
          input,
          el('span', null, [el('b', { text: t.label }), el('small', { text: DESCRIPTIONS[t.id] || '' })]),
        ]),
      );
    });
  }

  function renderExtras() {
    const t = current();
    const saved = {};
    extrasBox.querySelectorAll('input').forEach((i) => (saved[i.name] = i.value));
    extrasBox.textContent = '';
    if (!t) return;
    t.fields.forEach((f) => {
      const req = t.required.includes(f.key);
      const id = `x_${f.key}`;
      extrasBox.appendChild(
        el('div', { class: 'field' }, [
          el('label', { for: id }, [f.label, req ? el('span', { class: 'req', 'aria-hidden': 'true', text: ' *' }) : el('span', { class: 'hint', text: ' (optional)' })]),
          el('input', { type: 'text', id, name: f.key, maxlength: '200', required: req, placeholder: f.placeholder || '', value: saved[f.key] || '' }),
        ]),
      );
    });
  }

  function counter(textareaId, countId, min, max) {
    const ta = document.getElementById(textareaId);
    const out = document.getElementById(countId);
    const update = () => {
      const n = ta.value.trim().length;
      out.textContent = `${n} / ${max} characters` + (n > 0 && n < min ? ` (at least ${min})` : '');
      out.classList.toggle('bad', (n > 0 && n < min) || n > max);
    };
    ta.addEventListener('input', update);
    update();
  }

  function showError(msg, field) {
    errorBox.textContent = msg;
    form.querySelectorAll('[aria-invalid]').forEach((n) => n.removeAttribute('aria-invalid'));
    if (field) {
      field.setAttribute('aria-invalid', 'true');
      field.focus();
    } else {
      errorBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  function collect() {
    const t = current();
    if (!t) return showError('Choose what you are testing.', tplBox.querySelector('input'));
    const v = (id) => document.getElementById(id).value;
    if (!v('role')) return showError('Choose your role.', role);
    if (!v('industry')) return showError('Choose your industry.', document.getElementById('industry'));
    const size = Number(v('team_size'));
    if (!Number.isInteger(size) || size < 1 || size > 500)
      return showError('Team size must be a whole number from 1 to 500.', document.getElementById('team_size'));
    const cd = v('company_description').trim();
    if (cd.length < 20 || cd.length > 400)
      return showError('Company description must be 20 to 400 characters.', document.getElementById('company_description'));
    const dt = v('decision_text').trim();
    if (dt.length < 20 || dt.length > 800)
      return showError('Decision text must be 20 to 800 characters.', document.getElementById('decision_text'));
    const extras = {};
    for (const f of t.fields) {
      const input = document.getElementById(`x_${f.key}`);
      const val = input.value.trim();
      if (t.required.includes(f.key) && !val) return showError(`${f.label} is required.`, input);
      if (val) extras[f.key] = val;
    }
    const utm = new URLSearchParams(location.search).get('utm_source');
    return {
      template: t.id,
      role: v('role'),
      industry: v('industry'),
      team_size: size,
      company_description: cd,
      decision_text: dt,
      extras,
      utm_source: utm ? utm.slice(0, 50) : undefined,
    };
  }

  role.addEventListener('change', () => {
    const want = ROLE_TEMPLATE[role.value];
    if (!want || current()) return;
    const radio = document.getElementById(`tpl_${want}`);
    if (radio) {
      radio.checked = true;
      renderExtras();
    }
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorBox.textContent = '';
    const body = collect();
    if (!body) return;
    submitBtn.disabled = true;
    submitBtn.textContent = 'Starting…';
    const res = await api('POST', '/api/runs', body);
    if (res.ok && res.data.id) {
      location.href = `run.html?id=${encodeURIComponent(res.data.id)}`;
      return;
    }
    submitBtn.disabled = false;
    submitBtn.textContent = 'Run the simulation';
    showError((res.data && res.data.detail) || 'Something went wrong. Please try again.');
  });

  counter('company_description', 'cd_count', 20, 400);
  counter('decision_text', 'dt_count', 20, 800);

  (async function init() {
    const res = await api('GET', '/api/templates');
    if (!res.ok || !Array.isArray(res.data)) {
      tplBox.textContent = '';
      showError('Could not load templates. Refresh the page to try again.');
      return;
    }
    templates = res.data;
    renderTemplates();
  })();
})();
