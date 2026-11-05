'use strict';
/* Shared helpers. No frameworks. */
window.DS = (function () {
  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const k of Object.keys(attrs)) {
        const v = attrs[k];
        if (v === null || v === undefined || v === false) continue;
        if (k === 'text') node.textContent = v;
        else if (k === 'class') node.className = v;
        else node.setAttribute(k, v === true ? '' : v);
      }
    }
    for (const c of [].concat(children || [])) {
      if (c === null || c === undefined || c === false) continue;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return node;
  }

  async function api(method, url, body, headers) {
    const opts = { method, headers: Object.assign({ Accept: 'application/json' }, headers || {}) };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    let res;
    try {
      res = await fetch(url, opts);
    } catch (e) {
      return { ok: false, status: 0, data: { detail: 'Network error. Check your connection and try again.' } };
    }
    let data = null;
    try {
      data = await res.json();
    } catch (_) {
      data = {};
    }
    return { ok: res.ok, status: res.status, data };
  }

  const PLATFORM = { buyer_forum: 'Customer side', rep_channel: 'Team side' };

  return { el, api, PLATFORM };
})();
