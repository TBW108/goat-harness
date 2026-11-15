(() => {
  const $ = (id) => document.getElementById(id);

  const state = {
    appState: null,
    models: [],
    selectedRunId: '',
    lastSessionId: '',
    pollTimer: null,
    modelsLoadedForAuth: '',
  };

  function syncScheme() {
    const probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;color:var(--background, #0f172a)';
    document.documentElement.appendChild(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    const nums = (c.match(/[\d.]+/g) || []).map(Number);
    if (nums.length < 3) return;
    const scale = c.startsWith('color(') ? 1 : 255;
    const [r, g, b] = nums.slice(0, 3).map((v) => v / scale);
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    document.documentElement.dataset.theme = lum < 0.5 ? 'dark' : 'light';
  }
  syncScheme();
  new MutationObserver(syncScheme).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['style'],
  });

  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[c]));

  async function apiGet(path) {
    const f = window.sidecar?.fetch ? window.sidecar.fetch.bind(window.sidecar) : fetch;
    const res = await f(path, { method: 'GET' });
    if (!res.ok) throw new Error(`${path}: ${res.status}`);
    return res.json();
  }

  async function apiPost(path, body = {}) {
    const f = window.sidecar?.fetch ? window.sidecar.fetch.bind(window.sidecar) : fetch;
    const res = await f(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${path}: ${res.status}`);
    return res.json();
  }

  async function detectWorkspace() {
    try {
      if (window.sidecar?.getWorkspaceUris) {
        const uris = await window.sidecar.getWorkspaceUris();
        if (Array.isArray(uris) && uris.length && !$('input-cwd').value) {
          const first = String(uris[0]).replace(/^file:\/\//, '');
          $('input-cwd').value = decodeURIComponent(first);
        }
      }
    } catch {
      // Ignore standalone fallback.
    }
  }

  function renderAuth(auth, claude, settings) {
    const openaiBadge = $('badge-openai');
    if (auth?.connected) {
      openaiBadge.textContent = auth.mode === 'oauth' ? 'ChatGPT: Connected' : 'OpenAI: API Key';
      openaiBadge.className = 'pill pill-ok';
      $('auth-disconnected').classList.add('hidden');
      $('auth-connected').classList.remove('hidden');

      const label = auth.account?.email || auth.account?.name || 'ChatGPT Account';
      const plan = auth.account?.planType ? `Plan: ${auth.account.planType}` : 'OAuth session active';
      $('account-identity').textContent = auth.mode === 'oauth' ? label : 'OpenAI API Key Fallback';
      $('account-meta').textContent = auth.mode === 'oauth' ? plan : 'Using fallback API key';
    } else {
      openaiBadge.textContent = auth?.pendingOAuth?.pending ? 'ChatGPT: Signing in…' : 'OpenAI: Not signed in';
      openaiBadge.className = auth?.pendingOAuth?.pending ? 'pill pill-warn' : 'pill pill-warn';
      $('auth-connected').classList.add('hidden');
      $('auth-disconnected').classList.remove('hidden');

      if (auth?.pendingOAuth?.pending) {
        $('oauth-pending-box').classList.remove('hidden');
        $('btn-cancel-oauth').classList.remove('hidden');
        $('oauth-link').href = auth.pendingOAuth.authUrl;
      } else {
        $('oauth-pending-box').classList.add('hidden');
        $('btn-cancel-oauth').classList.add('hidden');
      }
    }

    const claudeBadge = $('badge-claude');
    if (claude?.available) {
      claudeBadge.textContent = `Claude: ${claude.version || 'Ready'}`;
      claudeBadge.className = 'pill pill-ok';
    } else {
      claudeBadge.textContent = 'Claude CLI: Missing';
      claudeBadge.className = 'pill pill-err';
    }

    if (document.activeElement !== $('input-claudepath')) {
      $('input-claudepath').value = settings?.claudePath || '';
    }
    if (document.activeElement !== $('select-effort')) {
      $('select-effort').value = settings?.reasoningEffort || 'medium';
    }
    if (document.activeElement !== $('select-perm')) {
      $('select-perm').value = settings?.permissionMode || 'acceptEdits';
    }
    $('chk-strict-verify').checked = Boolean(settings?.strictVerifyHook);
  }

  function fmtTokens(count) {
    const n = Math.max(0, Number(count) || 0);
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
    return String(Math.round(n));
  }

  function renderUsage(usage) {
    if (!usage) return;
    const setTile = (prefix, bucket) => {
      const b = bucket || {};
      $(`usage-${prefix}-tokens`).textContent = fmtTokens(b.totalTokens);
      $(`usage-${prefix}-reqs`).textContent = `${b.requests || 0} reqs · in ${fmtTokens(b.inputTokens)} / out ${fmtTokens(b.outputTokens)}`;
    };
    setTile('today', usage.today);
    setTile('7d', usage.last7Days);
    setTile('30d', usage.last30Days);
    setTile('all', usage.allTime);

    const modelsBox = $('usage-models');
    const entries = Object.entries(usage.byModel || {}).sort(
      (a, b) => (b[1]?.totalTokens || 0) - (a[1]?.totalTokens || 0)
    );
    if (!entries.length) {
      modelsBox.innerHTML = '<div class="muted">No local proxy requests recorded yet.</div>';
    } else {
      modelsBox.innerHTML = entries
        .map(
          ([slug, s]) => `<div class="usage-model-row">
            <span><strong>${esc(slug)}</strong> · ${esc(s.requests || 0)} reqs</span>
            <span class="muted">${esc(fmtTokens(s.totalTokens))} total (in ${esc(fmtTokens(s.inputTokens))}, cached ${esc(fmtTokens(s.cachedTokens))}, out ${esc(fmtTokens(s.outputTokens))}, reasoning ${esc(fmtTokens(s.reasoningTokens))})</span>
          </div>`
        )
        .join('');
    }

    const alertEl = $('usage-quota-alert');
    if (usage.lastQuotaError?.message) {
      alertEl.classList.remove('hidden');
      alertEl.textContent = `Last rate-limit / quota response (HTTP ${usage.lastQuotaError.status} · ${usage.lastQuotaError.model || 'unknown'}): ${usage.lastQuotaError.message}`;
    } else {
      alertEl.classList.add('hidden');
      alertEl.textContent = '';
    }

    if (usage.chatgptUsageSettingsUrl) {
      $('link-chatgpt-quota').href = usage.chatgptUsageSettingsUrl;
    }
    if (usage.serverQuotaNote) {
      $('usage-note').textContent = usage.serverQuotaNote;
    }
  }

  function renderModels(defaultModel) {
    const sel = $('select-model');
    if (!state.models.length) {
      if (defaultModel) {
        sel.innerHTML = `<option value="${esc(defaultModel)}">${esc(defaultModel)}</option>`;
      } else {
        sel.innerHTML = '<option value="">Sign in with ChatGPT to load models…</option>';
      }
      return;
    }

    const current = defaultModel || sel.value || state.models[0].slug;
    sel.innerHTML = state.models
      .map((m) => {
        const meta = [];
        if (m.displayName && m.displayName !== m.slug) meta.push(m.slug);
        if (m.contextWindow) meta.push(`${fmtTokens(m.contextWindow)} ctx`);
        const suffix = meta.length ? ` (${meta.join(' · ')})` : '';
        return `<option value="${esc(m.slug)}" title="${esc(m.description || m.slug)}">${esc(m.displayName || m.slug)}${esc(suffix)}</option>`;
      })
      .join('');
    sel.value = state.models.some((m) => m.slug === current) ? current : state.models[0].slug;
  }

  function renderRunsList(runs) {
    const box = $('runs-list');
    if (!runs?.length) {
      box.innerHTML = '<div class="muted">No runs recorded yet.</div>';
      return;
    }
    box.innerHTML = runs
      .map((r) => {
        const selected = r.id === state.selectedRunId ? 'selected' : '';
        const statusColor =
          r.status === 'completed'
            ? 'pill-ok'
            : r.status === 'running'
              ? 'pill-warn'
              : 'pill-err';
        return `<button type="button" class="run-item ${selected}" data-run-id="${esc(r.id)}">
          <div class="run-item-top">
            <span><strong>${esc(r.model || 'auto')}</strong> · [${esc(r.source || 'sidecar')}] · ${esc(r.permissionMode)}</span>
            <span class="pill ${statusColor}">${esc(r.status)}</span>
          </div>
          <div class="run-item-prompt">${esc(r.prompt)}</div>
        </button>`;
      })
      .join('');

    box.querySelectorAll('.run-item').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.selectedRunId = btn.dataset.runId || '';
        void refreshSelectedRun();
      });
    });
  }

  async function refreshModels(forceRefresh = false) {
    $('model-status').textContent = 'Loading models…';
    const res = await apiGet(`/api/models${forceRefresh ? '?refresh=true' : ''}`);
    if (res.ok) {
      state.models = res.models || [];
      $('model-status').textContent = `${state.models.length} models`;
      renderModels(state.appState?.settings?.defaultModel || '');
      if (state.models.length && !state.appState?.settings?.defaultModel) {
        await apiPost('/api/settings', { defaultModel: state.models[0].slug });
      }
    } else {
      state.models = [];
      $('model-status').textContent = res.error ? 'Models unavailable' : '';
      renderModels(state.appState?.settings?.defaultModel || '');
    }
  }

  async function refreshSelectedRun() {
    if (!state.selectedRunId) return;
    const res = await apiGet(`/api/run?id=${encodeURIComponent(state.selectedRunId)}`);
    if (!res.ok || !res.run) return;
    const run = res.run;

    if (run.claudeSessionId) {
      state.lastSessionId = run.claudeSessionId;
    }

    const running = run.status === 'running';
    $('btn-stop').classList.toggle('hidden', !running);
    $('btn-run').disabled = running;
    $('btn-send-agy').classList.toggle('hidden', running || !run.resultText);

    const metaParts = [
      run.status,
      run.model,
      run.durationMs ? `${(run.durationMs / 1000).toFixed(1)}s` : '',
      run.claudeSessionId ? `session:${run.claudeSessionId.slice(0, 8)}` : '',
    ].filter(Boolean);
    $('run-meta').textContent = metaParts.join(' · ');

    const tools = Array.isArray(run.toolsUsed) ? run.toolsUsed : [];
    const toolsBox = $('run-tools');
    if (tools.length) {
      toolsBox.classList.remove('hidden');
      toolsBox.innerHTML = tools
        .slice(-16)
        .map((t) => `<span class="tool-chip" title="${esc(t.inputPreview)}">${esc(t.name)}</span>`)
        .join('');
    } else {
      toolsBox.classList.add('hidden');
      toolsBox.innerHTML = '';
    }

    const body =
      run.error && run.status === 'error'
        ? `${run.resultText || run.streamText || ''}\n\n[Error]\n${run.error}`.trim()
        : run.resultText || run.streamText || run.thinkingText || 'Running Claude Code harness…';
    $('run-output').textContent = body;
  }

  async function refreshState() {
    const data = await apiGet('/api/state');
    state.appState = data;
    renderAuth(data.auth, data.claude, data.settings);
    renderUsage(data.usage);

    const authKey = `${data.auth?.connected}:${data.auth?.mode}:${data.auth?.account?.email || ''}`;
    if (data.auth?.connected && state.modelsLoadedForAuth !== authKey) {
      state.modelsLoadedForAuth = authKey;
      await refreshModels(false);
    } else {
      renderModels(data.settings?.defaultModel || '');
    }

    if (!state.selectedRunId && data.runs?.length) {
      state.selectedRunId = data.runs[0].id;
    }
    for (const r of data.runs || []) {
      if (r.claudeSessionId) {
        state.lastSessionId = r.claudeSessionId;
        break;
      }
    }

    renderRunsList(data.runs || []);
    if (state.selectedRunId) {
      await refreshSelectedRun();
    }

    const hasActiveRun = (data.runs || []).some((r) => r.status === 'running');
    const pendingOAuth = Boolean(data.auth?.pendingOAuth?.pending);
    schedulePoll(hasActiveRun || pendingOAuth ? 750 : 4000);
  }

  function schedulePoll(ms) {
    clearTimeout(state.pollTimer);
    state.pollTimer = setTimeout(() => {
      refreshState().catch(() => schedulePoll(4000));
    }, ms);
  }

  $('btn-signin').addEventListener('click', async () => {
    const res = await apiPost('/api/oauth/start', { openBrowser: true });
    if (res.authUrl) {
      $('oauth-link').href = res.authUrl;
      $('oauth-pending-box').classList.remove('hidden');
      $('btn-cancel-oauth').classList.remove('hidden');
    }
    await refreshState();
  });

  $('btn-cancel-oauth').addEventListener('click', async () => {
    await apiPost('/api/oauth/cancel');
    await refreshState();
  });

  $('btn-signout').addEventListener('click', async () => {
    await apiPost('/api/oauth/logout');
    state.models = [];
    state.modelsLoadedForAuth = '';
    await refreshState();
  });

  $('btn-refresh-models').addEventListener('click', async () => {
    await refreshModels(true);
  });

  $('btn-toggle-advanced').addEventListener('click', () => {
    $('advanced-panel').classList.toggle('hidden');
  });

  $('btn-save-advanced').addEventListener('click', async () => {
    const payload = {
      claudePath: $('input-claudepath').value,
      reasoningEffort: $('select-effort').value,
      strictVerifyHook: $('chk-strict-verify').checked,
    };
    const key = $('input-apikey').value.trim();
    if (key) payload.apiKeyFallback = key;
    await apiPost('/api/settings', payload);
    $('input-apikey').value = '';
    state.modelsLoadedForAuth = '';
    await refreshState();
  });

  $('select-model').addEventListener('change', async () => {
    await apiPost('/api/settings', { defaultModel: $('select-model').value });
  });

  $('select-perm').addEventListener('change', async () => {
    await apiPost('/api/settings', { permissionMode: $('select-perm').value });
  });

  $('select-effort').addEventListener('change', async () => {
    await apiPost('/api/settings', { reasoningEffort: $('select-effort').value });
  });

  $('btn-reset-usage').addEventListener('click', async () => {
    const res = await apiPost('/api/usage/reset');
    if (res?.usage) renderUsage(res.usage);
  });

  $('chk-strict-verify').addEventListener('change', async () => {
    await apiPost('/api/settings', { strictVerifyHook: $('chk-strict-verify').checked });
  });

  $('btn-resume-last').addEventListener('click', () => {
    if (state.lastSessionId) {
      $('input-resume').value = state.lastSessionId;
    }
  });

  $('btn-run').addEventListener('click', async () => {
    const prompt = $('input-prompt').value.trim();
    if (!prompt) return;
    const res = await apiPost('/api/run/start', {
      prompt,
      cwd: $('input-cwd').value.trim(),
      model: $('select-model').value,
      permissionMode: $('select-perm').value,
      resumeSessionId: $('input-resume').value.trim(),
    });
    if (res.ok && res.runId) {
      state.selectedRunId = res.runId;
    }
    await refreshState();
  });

  $('btn-stop').addEventListener('click', async () => {
    if (!state.selectedRunId) return;
    await apiPost('/api/run/cancel', { runId: state.selectedRunId });
    await refreshState();
  });

  $('btn-send-agy').addEventListener('click', async () => {
    const text = $('run-output').textContent || '';
    if (!text) return;
    const msg = `[GOAT Harness — Claude Code + OpenAI (${$('select-model').value})]\n\n${text.slice(0, 6000)}`;
    if (window.sidecar?.agent?.sendMessage) {
      await window.sidecar.agent.sendMessage(msg);
    } else if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(msg);
    }
  });

  $('btn-refresh-state').addEventListener('click', () => {
    void refreshState();
  });

  void detectWorkspace();
  void refreshState();
})();
