/* global window, document, fetch, localStorage */
const state = {
  token: localStorage.getItem('am_token') || '',
  currentTab: 'pending',
  currentLane: 4,
  currentStatus: null,
  currentThreadId: null,
  threads: [],
  thread: null,
  draftCountdowns: new Map(),
};

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  const res = await fetch(path, { ...opts, headers });
  if (res.status === 401) {
    showSetupBanner();
    throw new Error('unauthorized');
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API ${res.status}: ${text}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

function showSetupBanner() {
  $('#setup-banner').hidden = false;
  $('#empty-state').hidden = true;
  $('#thread-detail').hidden = true;
}

function setStatus(msg) {
  $('#setup-status').textContent = msg;
}

function tabFilters(tab) {
  switch (tab) {
    case 'pending': return { lane: 4 };
    case 'escalated': return { lane: 5 };
    case 'all': return { status: 'open' };
    case 'filed': return { lane: 2 };
    case 'quarantined': return { lane: 1 };
    case 'audit': return { audit: true };
    default: return {};
  }
}

async function loadThreads() {
  if (state.currentTab === 'audit') return;
  const f = tabFilters(state.currentTab);
  const params = new URLSearchParams();
  if (f.lane !== undefined) params.set('lane', String(f.lane));
  if (f.status) params.set('status', f.status);
  try {
    const data = await api('/api/threads?' + params.toString());
    state.threads = data.threads || [];
    renderThreadList();
  } catch (e) {
    console.error(e);
  }
}

function renderThreadList() {
  const root = $('#thread-list');
  if (state.threads.length === 0) {
    root.innerHTML = '<div class="thread-row" style="color:#999">No threads here.</div>';
    return;
  }
  root.innerHTML = state.threads
    .map((t) => {
      const lane = t.current_lane || 0;
      const active = t.id === state.currentThreadId ? ' active' : '';
      const dateStr = t.last_message_at ? new Date(t.last_message_at).toLocaleString() : '';
      return `<div class="thread-row${active}" data-id="${t.id}">
        <div class="subj">${escapeHtml(t.subject_norm || '(no subject)')}</div>
        <div class="meta">
          <span>${escapeHtml((t.participants || []).join(', '))}</span>
          <span><span class="lane-badge lane-${lane}">Lane ${lane}</span></span>
        </div>
        <div class="meta">
          <span>${t.message_count} msg · ${escapeHtml(t.status)}</span>
          <span>${escapeHtml(dateStr)}</span>
        </div>
      </div>`;
    })
    .join('');
  for (const el of $$('.thread-row')) {
    el.addEventListener('click', () => {
      const id = el.getAttribute('data-id');
      if (id) loadThread(id);
    });
  }
}

async function loadThread(id) {
  state.currentThreadId = id;
  $('#empty-state').hidden = true;
  $('#audit-view').hidden = true;
  $('#thread-detail').hidden = false;
  renderThreadList();
  try {
    const data = await api(`/api/threads/${id}`);
    state.thread = data;
    renderThreadDetail();
  } catch (e) {
    console.error(e);
  }
}

function renderThreadDetail() {
  if (!state.thread) return;
  const { thread, messages, drafts } = state.thread;
  const messagesHtml = (messages || [])
    .map((m) => {
      const cls = m.direction === 'outbound' ? 'message outbound' : 'message';
      const sentAt = m.received_at ? new Date(m.received_at).toLocaleString() : '';
      let classBlock = '';
      if (m.trust) {
        classBlock = `<div style="margin-top:8px;font-size:11px;color:#6b6b73">
          trust=${m.trust} · sender=${m.sender_class} · intent=${m.intent} · urgency=${m.urgency} · lane=${m.recommended_lane}<br>
          <em>${escapeHtml(m.class_reasoning || '')}</em>
        </div>`;
      }
      return `<div class="${cls}">
        <div class="hdr">
          <span class="from">${escapeHtml(m.from_name || '')} &lt;${escapeHtml(m.from_email)}&gt;</span>
          <span>${escapeHtml(sentAt)}</span>
        </div>
        <div class="subject">${escapeHtml(m.subject || '')}</div>
        <pre>${escapeHtml(m.text_body || '')}</pre>
        ${classBlock}
      </div>`;
    })
    .join('');

  const pendingDraft = (drafts || []).find((d) => d.status === 'pending');
  const approvedDraft = (drafts || []).find((d) => d.status === 'approved');

  let draftHtml = '';
  if (approvedDraft) {
    const secondsLeft = Math.max(
      0,
      Math.floor((new Date(approvedDraft.send_at).getTime() - Date.now()) / 1000),
    );
    draftHtml = `<div class="undo-banner">
      <span>Sending in <strong id="countdown-${approvedDraft.id}">${secondsLeft}</strong>s...</span>
      <button class="secondary" id="undo-${approvedDraft.id}">Undo</button>
    </div>`;
  }
  if (pendingDraft) {
    const requiresConfirm = pendingDraft.requires_extra_confirmation;
    draftHtml += `<div class="draft-card ${requiresConfirm ? 'requires-confirm' : ''}" data-draft-id="${pendingDraft.id}">
      ${requiresConfirm ? '<div style="color:#dc2626;font-weight:bold;margin-bottom:8px;">⚠ Requires extra confirmation</div>' : ''}
      <h3>Pending draft to ${escapeHtml((pendingDraft.to_emails || []).join(', '))}</h3>
      <textarea id="edit-${pendingDraft.id}">${escapeHtml(pendingDraft.body_text)}</textarea>
      <div class="draft-actions">
        <button class="primary" id="approve-${pendingDraft.id}">Approve</button>
        <button class="secondary" id="edit-approve-${pendingDraft.id}">Edit & Approve</button>
        <button class="danger" id="reject-${pendingDraft.id}">Reject</button>
      </div>
      <div class="reasoning">
        Agent: ${escapeHtml(pendingDraft.agent_reasoning)}
        <span class="confidence">confidence: ${(pendingDraft.agent_confidence * 100).toFixed(0)}%</span>
      </div>
    </div>`;
  }

  $('#thread-detail').innerHTML = `
    <h2>${escapeHtml(thread.subject_norm || '(no subject)')} <span class="lane-badge lane-${thread.current_lane || 0}">Lane ${thread.current_lane || '-'}</span></h2>
    <div style="color:#6b6b73;font-size:12px;margin-bottom:16px">
      ${escapeHtml((thread.participants || []).join(', '))} · status ${escapeHtml(thread.status)}
    </div>
    ${messagesHtml}
    ${draftHtml}
  `;

  if (pendingDraft) {
    $(`#approve-${pendingDraft.id}`).addEventListener('click', () =>
      approveDraft(pendingDraft.id, null),
    );
    $(`#edit-approve-${pendingDraft.id}`).addEventListener('click', () => {
      const newBody = $(`#edit-${pendingDraft.id}`).value;
      approveDraft(pendingDraft.id, newBody);
    });
    $(`#reject-${pendingDraft.id}`).addEventListener('click', () => rejectDraft(pendingDraft.id));
  }
  if (approvedDraft) {
    $(`#undo-${approvedDraft.id}`).addEventListener('click', () => undoDraft(approvedDraft.id));
    startCountdown(approvedDraft.id, approvedDraft.send_at);
  }
}

async function approveDraft(id, editedBody) {
  try {
    const body = editedBody != null ? JSON.stringify({ edited_body: editedBody }) : '{}';
    await api(`/api/drafts/${id}/approve`, { method: 'POST', body });
    setStatus('approved — sending soon');
    await loadThread(state.currentThreadId);
  } catch (e) {
    setStatus(`error: ${e.message}`);
  }
}

async function rejectDraft(id) {
  try {
    await api(`/api/drafts/${id}/reject`, { method: 'POST', body: '{}' });
    setStatus('rejected');
    await loadThread(state.currentThreadId);
  } catch (e) {
    setStatus(`error: ${e.message}`);
  }
}

async function undoDraft(id) {
  try {
    await api(`/api/drafts/${id}/undo`, { method: 'POST' });
    setStatus('undone');
    await loadThread(state.currentThreadId);
  } catch (e) {
    setStatus(`error: ${e.message}`);
  }
}

function startCountdown(draftId, sendAt) {
  if (state.draftCountdowns.has(draftId)) {
    clearInterval(state.draftCountdowns.get(draftId));
  }
  const interval = setInterval(() => {
    const el = document.getElementById(`countdown-${draftId}`);
    if (!el) {
      clearInterval(interval);
      state.draftCountdowns.delete(draftId);
      return;
    }
    const sec = Math.max(0, Math.floor((new Date(sendAt).getTime() - Date.now()) / 1000));
    el.textContent = sec;
    if (sec <= 0) {
      clearInterval(interval);
      state.draftCountdowns.delete(draftId);
      setTimeout(() => loadThread(state.currentThreadId), 1500);
    }
  }, 1000);
  state.draftCountdowns.set(draftId, interval);
}

async function loadAudit() {
  $('#thread-detail').hidden = true;
  $('#empty-state').hidden = true;
  $('#audit-view').hidden = false;
  try {
    const data = await api('/api/audit?limit=100');
    const rows = data.entries.map((e) => {
      const cls = e.outcome === 'ok' ? '' : e.outcome;
      const payload = JSON.stringify(e.payload).slice(0, 200);
      const date = new Date(e.created_at).toLocaleTimeString();
      return `<div class="audit-row ${cls}">
        <span>${date}</span>
        <span class="audit-action">${escapeHtml(e.action)}</span>
        <span>${escapeHtml(e.actor)}</span>
        <span class="audit-payload">${escapeHtml(payload)}</span>
        <span>${escapeHtml(e.outcome)}</span>
      </div>`;
    });
    $('#audit-view').innerHTML = `<h2>Audit Log</h2>${rows.join('')}`;
  } catch (e) {
    console.error(e);
  }
}

function escapeHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function selectTab(name) {
  state.currentTab = name;
  $$('.tab').forEach((b) => b.classList.toggle('active', b.getAttribute('data-tab') === name));
  if (name === 'audit') {
    loadAudit();
  } else {
    $('#audit-view').hidden = true;
    $('#empty-state').hidden = !!state.currentThreadId;
    loadThreads();
  }
}

function init() {
  if (!state.token) {
    showSetupBanner();
  } else {
    $('#setup-banner').hidden = true;
  }
  $$('.tab').forEach((b) =>
    b.addEventListener('click', () => selectTab(b.getAttribute('data-tab'))),
  );
  $('#token-save').addEventListener('click', () => {
    const v = $('#token-input').value.trim();
    if (v) {
      localStorage.setItem('am_token', v);
      state.token = v;
      $('#setup-banner').hidden = true;
      selectTab('pending');
    }
  });
  selectTab('pending');
  setInterval(() => {
    if (state.currentTab !== 'audit') loadThreads();
    if (state.currentThreadId) loadThread(state.currentThreadId);
  }, 10000);
}

init();
