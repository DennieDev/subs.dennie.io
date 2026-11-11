'use strict';

(async () => {
  const $ = (id) => document.getElementById(id);
  const match = location.pathname.match(/^\/([A-Za-z0-9_-]{32})\/configure$/);
  let token = match ? match[1] : null;

  const meta = await (await fetch('/api/meta')).json();
  // The notice can be dismissed; it comes back when its text changes.
  if (meta.notice) {
    const key = `notice-dismissed:${hash(meta.notice)}`;
    let dismissed = false;
    try {
      dismissed = localStorage.getItem(key) === '1';
    } catch {}
    if (!dismissed) {
      $('noticeText').replaceChildren(
        ...meta.notice
          .split(/\n\s*\n/)
          .map((text) => Object.assign(document.createElement('p'), { textContent: text.trim() })),
      );
      $('notice').hidden = false;
      $('noticeClose').addEventListener('click', () => {
        $('notice').hidden = true;
        try {
          localStorage.setItem(key, '1');
        } catch {}
      });
    }
  }
  function hash(text) {
    let h = 0;
    for (let i = 0; i < text.length; i++) h = (Math.imul(31, h) + text.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }
  const languageNames = new Map(meta.languages.map((l) => [l.code, l.name]));
  let languages = ['dut', 'eng'];
  let existing = null;

  if (token) {
    const res = await fetch(`/api/configs/${token}`);
    if (!res.ok) {
      showError('This config does not exist (anymore). Create a new one.');
      history.replaceState(null, '', '/configure');
      token = null;
    } else {
      existing = await res.json();
      languages = existing.preferences.languages;
      $('hearingImpaired').value = existing.preferences.hearingImpaired;
      $('maxPerLanguage').value = existing.preferences.maxPerLanguage;
      $('includeMachineTranslated').checked = existing.preferences.includeMachineTranslated;
      $('signup-section').hidden = true;
      $('delete').hidden = false;
      showResult(`${location.origin}/${token}/manifest.json`);
    }
  }

  // ---- languages ----
  function renderLanguages() {
    const list = $('languages');
    list.replaceChildren(
      ...languages.map((code, i) => {
        const li = document.createElement('li');
        const pos = Object.assign(document.createElement('span'), { className: 'pos', textContent: `${i + 1}.` });
        const name = Object.assign(document.createElement('span'), { textContent: languageNames.get(code) || code });
        const up = button('↑', `Move ${languageNames.get(code)} up`, () => move(i, -1), i === 0);
        const down = button('↓', `Move ${languageNames.get(code)} down`, () => move(i, 1), i === languages.length - 1);
        const remove = button('✕', `Remove ${languageNames.get(code)}`, () => {
          languages.splice(i, 1);
          renderLanguages();
        });
        li.append(pos, name, up, down, remove);
        return li;
      }),
    );
    const select = $('languageAdd');
    select.replaceChildren(
      ...meta.languages
        .filter((l) => !languages.includes(l.code))
        .map((l) => Object.assign(document.createElement('option'), { value: l.code, textContent: l.name })),
    );
  }
  function move(i, delta) {
    const [code] = languages.splice(i, 1);
    languages.splice(i + delta, 0, code);
    renderLanguages();
  }
  function button(text, label, onClick, disabled = false) {
    const b = Object.assign(document.createElement('button'), { type: 'button', className: 'secondary', textContent: text, disabled });
    b.setAttribute('aria-label', label);
    b.addEventListener('click', onClick);
    return b;
  }
  $('languageAddBtn').addEventListener('click', () => {
    const code = $('languageAdd').value;
    if (code && languages.length < 10) {
      languages.push(code);
      renderLanguages();
    }
  });
  renderLanguages();

  // ---- providers ----
  const providerEls = meta.providers.map((p) => {
    const stored = existing?.providers?.[p.id];
    const wrap = Object.assign(document.createElement('div'), { className: 'provider' });
    const toggle = Object.assign(document.createElement('input'), { type: 'checkbox', checked: !existing || !!stored });
    const head = document.createElement('label');
    head.className = 'check';
    head.append(toggle, Object.assign(document.createElement('h3'), { textContent: p.name }));
    const fields = Object.assign(document.createElement('div'), { className: 'fields' });
    const inputs = {};
    for (const f of p.credentialFields) {
      const id = `${p.id}-${f.key}`;
      const label = Object.assign(document.createElement('label'), { htmlFor: id, textContent: f.label });
      const input = Object.assign(document.createElement('input'), {
        id,
        type: f.type,
        autocomplete: f.type === 'password' ? 'current-password' : 'username',
        value: stored?.credentials?.[f.key] ?? '',
      });
      if (f.type === 'password' && stored) input.placeholder = 'Unchanged';
      inputs[f.key] = input;
      fields.append(label, input);
      if (f.help) fields.append(Object.assign(document.createElement('p'), { className: 'hint', textContent: f.help }));
    }
    const signup = document.createElement('p');
    signup.className = 'hint';
    const a = Object.assign(document.createElement('a'), { href: p.signupUrl, target: '_blank', rel: 'noopener', textContent: 'Create a free account' });
    signup.append('No account yet? ', a, '.');
    fields.append(signup);
    const sync = () => (fields.hidden = !toggle.checked);
    toggle.addEventListener('change', sync);
    sync();
    wrap.append(head, fields);
    $('providers').append(wrap);
    return { provider: p, toggle, inputs };
  });

  // ---- save / delete ----
  $('form').addEventListener('submit', async (event) => {
    event.preventDefault();
    hideError();
    const providers = {};
    for (const { provider, toggle, inputs } of providerEls) {
      if (!toggle.checked) continue;
      providers[provider.id] = {
        credentials: Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.value])),
      };
    }
    const body = {
      preferences: {
        languages,
        hearingImpaired: $('hearingImpaired').value,
        includeMachineTranslated: $('includeMachineTranslated').checked,
        maxPerLanguage: Number($('maxPerLanguage').value),
      },
      providers,
    };
    if (!token) body.signupCode = $('signupCode').value;

    const save = $('save');
    save.disabled = true;
    save.textContent = 'Signing in…';
    try {
      const res = await fetch(token ? `/api/configs/${token}` : '/api/configs', {
        method: token ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return showError(data.error || `Saving failed (HTTP ${res.status})`);
      if (!token) {
        token = data.token;
        history.replaceState(null, '', `/${token}/configure`);
        $('signup-section').hidden = true;
        $('delete').hidden = false;
      }
      for (const { inputs } of providerEls) {
        for (const el of Object.values(inputs)) if (el.type === 'password') {
          el.value = '';
          el.placeholder = 'Unchanged';
        }
      }
      showResult(data.manifestUrl);
      $('result').scrollIntoView({ behavior: 'smooth' });
    } catch {
      showError('Could not reach the server.');
    } finally {
      save.disabled = false;
      save.textContent = 'Save';
    }
  });

  $('delete').addEventListener('click', async () => {
    if (!token || !confirm('Delete this config? The addon URL stops working.')) return;
    const res = await fetch(`/api/configs/${token}`, { method: 'DELETE' });
    if (res.ok || res.status === 404) location.href = '/configure';
    else showError(`Deleting failed (HTTP ${res.status})`);
  });

  $('copy').addEventListener('click', async () => {
    await navigator.clipboard.writeText($('manifestUrl').value);
    $('copy').textContent = 'Copied';
    setTimeout(() => ($('copy').textContent = 'Copy'), 1500);
  });

  function showResult(url) {
    $('manifestUrl').value = url;
    $('install').href = url.replace(/^https?:\/\//, 'stremio://');
    $('editLink').href = url.replace(/manifest\.json$/, 'configure');
    $('result').hidden = false;
  }
  function showError(message) {
    $('error').textContent = message;
    $('error').hidden = false;
  }
  function hideError() {
    $('error').hidden = true;
  }
})();
