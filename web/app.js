/* global window, document, fetch, localStorage, navigator */

// ============================================================================
// State
// ============================================================================

const VERSION = '0.2.0';

const state = {
  token: localStorage.getItem('am_token') || '',
  owner: safeParseJSON(localStorage.getItem('am_owner')) || null,
  ownerCard: null, // /.well-known/agentmail.json

  view: 'inbox', // 'inbox' | 'agents' | 'audit'
  currentTab: 'pending',
  currentThreadId: null,
  threads: [],
  thread: null,
  tabCounts: { pending: 0, escalated: 0, all: 0, filed: 0, quarantined: 0 },
  loginError: '',
  loginPending: false,

  // Agents page
  agents: [],
  agentsLoading: false,
  lastCreatedAgent: null,

  // Audit page
  audit: [],
  auditAction: '',

  draftCountdowns: new Map(),
  pollTimer: null,
  visible: true,
};

function safeParseJSON(s) {
  try { return s ? JSON.parse(s) : null; } catch { return null; }
}

// ============================================================================
// API helper
// ============================================================================

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  const res = await fetch(path, { ...opts, headers });
  if (res.status === 401) {
    if (path !== '/api/login') {
      localStorage.removeItem('am_token');
      localStorage.removeItem('am_owner');
      state.token = '';
      state.owner = null;
      render();
    }
    const e = new Error('unauthorized');
    e.status = 401;
    throw e;
  }
  if (!res.ok) {
    let detail = '';
    try { detail = await res.text(); } catch {}
    const e = new Error(`API ${res.status}: ${detail}`);
    e.status = res.status;
    e.detail = detail;
    throw e;
  }
  if (res.status === 204) return null;
  return res.json();
}

// ============================================================================
// Utilities
// ============================================================================

function h(tag, attrs = {}, children = []) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') {
      el.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (v !== false && v != null) {
      el.setAttribute(k, v);
    }
  }
  const list = Array.isArray(children) ? children : [children];
  for (const c of list) {
    if (c == null || c === false) continue;
    if (typeof c === 'string' || typeof c === 'number') el.appendChild(document.createTextNode(String(c)));
    else el.appendChild(c);
  }
  return el;
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function initials(s) {
  if (!s) return '?';
  const parts = String(s).trim().split(/\s+|[<.@]/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

function timeAgo(d) {
  if (!d) return '';
  const date = d instanceof Date ? d : new Date(d);
  const sec = Math.round((Date.now() - date.getTime()) / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.round(hr / 24);
  if (day < 7) return `${day}d`;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function fmtDateTime(d) {
  if (!d) return '';
  const date = d instanceof Date ? d : new Date(d);
  return date.toLocaleString(undefined, {
    month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}

function fmtTime(d) {
  if (!d) return '';
  const date = d instanceof Date ? d : new Date(d);
  return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function ownerEmail() {
  return (state.owner && state.owner.email) || (state.ownerCard && state.ownerCard.owner && state.ownerCard.owner.email) || '';
}

function ownerName() {
  return (state.owner && state.owner.name) || (state.ownerCard && state.ownerCard.owner && state.ownerCard.owner.name) || '';
}

function otherParticipants(parts) {
  const me = ownerEmail().toLowerCase();
  return (parts || []).filter((p) => (p || '').toLowerCase() !== me);
}

function toast(msg, kind = '') {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const t = h('div', { class: `toast ${kind}` }, [msg]);
  container.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transform = 'translateY(8px)'; t.style.transition = 'all 200ms'; }, 2400);
  setTimeout(() => t.remove(), 2700);
}

// ============================================================================
// Auth + bootstrap
// ============================================================================

async function loadOwnerCard() {
  try {
    const res = await fetch('/.well-known/agentmail.json');
    if (res.ok) state.ownerCard = await res.json();
  } catch {}
}

async function bootstrap() {
  await loadOwnerCard();
  if (state.token) {
    try {
      const me = await api('/api/me');
      if (me && me.owner) {
        state.owner = me.owner;
        localStorage.setItem('am_owner', JSON.stringify(me.owner));
      }
    } catch {
      // token bad — cleared by api()
    }
  }
  render();
  if (state.token) {
    startPolling();
    selectTab(state.currentTab);
  }
}

async function doLogin(password) {
  state.loginError = '';
  state.loginPending = true;
  render();
  try {
    const out = await api('/api/login', { method: 'POST', body: JSON.stringify({ password }) });
    state.token = out.token;
    state.owner = out.owner;
    localStorage.setItem('am_token', out.token);
    localStorage.setItem('am_owner', JSON.stringify(out.owner));
    state.loginPending = false;
    render();
    startPolling();
    selectTab('pending');
  } catch (e) {
    state.loginPending = false;
    state.loginError = e.status === 401 ? 'Wrong password.' : `Sign-in failed (${e.message || 'error'}).`;
    render();
  }
}

function logout() {
  if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
  localStorage.removeItem('am_token');
  localStorage.removeItem('am_owner');
  state.token = '';
  state.owner = null;
  state.currentThreadId = null;
  state.thread = null;
  state.threads = [];
  render();
}

// ============================================================================
// Polling
// ============================================================================

function startPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = setInterval(() => {
    if (!state.visible) return;
    if (state.view === 'inbox') {
      loadThreads();
      loadTabCounts();
      if (state.currentThreadId) loadThread(state.currentThreadId, { silent: true });
    } else if (state.view === 'audit') {
      loadAudit();
    } else if (state.view === 'agents') {
      loadAgents();
    }
  }, 10000);
}

document.addEventListener('visibilitychange', () => {
  state.visible = document.visibilityState === 'visible';
});

// ============================================================================
// Inbox: tab counts + threads
// ============================================================================

const TAB_DEFS = [
  { key: 'pending',     label: 'Pending Review', lane: 4, dot: 'lane-4' },
  { key: 'escalated',   label: 'Escalated',      lane: 5, dot: 'lane-5' },
  { key: 'all',         label: 'All Open',       status: 'open',         dot: null },
  { key: 'filed',       label: 'Filed',          lane: 2, dot: 'lane-2' },
  { key: 'quarantined', label: 'Quarantined',    lane: 1, dot: 'lane-1' },
];

function tabFilters(tab) {
  const def = TAB_DEFS.find((d) => d.key === tab);
  if (!def) return {};
  if (def.lane !== undefined) return { lane: def.lane };
  if (def.status) return { status: def.status };
  return {};
}

async function loadTabCounts() {
  try {
    const results = await Promise.all(TAB_DEFS.map(async (def) => {
      const params = new URLSearchParams();
      if (def.lane !== undefined) params.set('lane', String(def.lane));
      if (def.status) params.set('status', def.status);
      params.set('limit', '200');
      const data = await api(`/api/threads?${params}`);
      return [def.key, (data.threads || []).length];
    }));
    state.tabCounts = Object.fromEntries(results);
    // Just re-render sidebar
    const sidebar = document.querySelector('.sidebar');
    if (sidebar) sidebar.replaceWith(renderSidebar());
  } catch {}
}

async function loadThreads() {
  const f = tabFilters(state.currentTab);
  const params = new URLSearchParams();
  if (f.lane !== undefined) params.set('lane', String(f.lane));
  if (f.status) params.set('status', f.status);
  params.set('limit', '50');
  try {
    const data = await api(`/api/threads?${params}`);
    state.threads = data.threads || [];
    const listPane = document.querySelector('.list-pane');
    if (listPane) listPane.replaceWith(renderListPane());
  } catch (e) {
    if (e.status !== 401) console.error(e);
  }
}

async function loadThread(id, opts = {}) {
  state.currentThreadId = id;
  if (!opts.silent) {
    state.thread = null;
    const dp = document.querySelector('.detail-pane');
    if (dp) dp.replaceWith(renderDetailPane());
  }
  try {
    const data = await api(`/api/threads/${id}`);
    state.thread = data;
    const dp = document.querySelector('.detail-pane');
    if (dp) dp.replaceWith(renderDetailPane());
    // Also re-render list to update active row
    const lp = document.querySelector('.list-pane');
    if (lp) lp.replaceWith(renderListPane());
    if (window.innerWidth <= 800) document.body.classList.add('show-detail');
  } catch (e) {
    if (e.status !== 401) console.error(e);
  }
}

function selectTab(name) {
  state.currentTab = name;
  state.view = 'inbox';
  state.currentThreadId = null;
  state.thread = null;
  render();
  loadThreads();
  loadTabCounts();
}

// ============================================================================
// Draft actions
// ============================================================================

async function approveDraft(id, editedBody) {
  try {
    const orig = (state.thread.drafts || []).find((d) => d.id === id);
    const ta = document.querySelector(`#draft-textarea-${id}`);
    const current = ta ? ta.value : '';
    const passEdited = orig && current && current !== orig.body_text ? current : null;
    const body = passEdited != null ? JSON.stringify({ edited_body: passEdited }) : '{}';
    await api(`/api/drafts/${id}/approve`, { method: 'POST', body });
    toast('Approved. Sending soon.', 'success');
    await loadThread(state.currentThreadId);
  } catch (e) {
    toast(`Error: ${e.message}`, 'error');
  }
}

async function rejectDraft(id) {
  try {
    await api(`/api/drafts/${id}/reject`, { method: 'POST', body: '{}' });
    toast('Draft rejected.', 'success');
    await loadThread(state.currentThreadId);
  } catch (e) {
    toast(`Error: ${e.message}`, 'error');
  }
}

async function undoDraft(id) {
  try {
    await api(`/api/drafts/${id}/undo`, { method: 'POST' });
    toast('Send undone.', 'success');
    await loadThread(state.currentThreadId);
  } catch (e) {
    toast(`Error: ${e.message}`, 'error');
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
      setTimeout(() => state.currentThreadId && loadThread(state.currentThreadId), 1500);
    }
  }, 1000);
  state.draftCountdowns.set(draftId, interval);
}

// ============================================================================
// Render: top-level
// ============================================================================

function render() {
  const root = document.getElementById('root');
  root.replaceChildren();
  if (!state.token) {
    root.appendChild(renderLogin());
    return;
  }
  root.appendChild(renderApp());
}

// ============================================================================
// Render: login
// ============================================================================

function renderLogin() {
  const email = ownerEmail() || (state.ownerCard?.owner?.email) || '...';

  const form = h('form', {
    onsubmit: (e) => {
      e.preventDefault();
      const pw = e.target.elements.password.value;
      if (pw) doLogin(pw);
    },
  }, [
    h('label', { for: 'pw' }, ['Password']),
    h('input', {
      id: 'pw', name: 'password', type: 'password',
      placeholder: 'Enter your password',
      autofocus: true, autocomplete: 'current-password',
      disabled: state.loginPending ? 'disabled' : false,
    }),
    state.loginError ? h('div', { class: 'login-error' }, [state.loginError]) : null,
    h('button', { class: 'btn primary', type: 'submit', disabled: state.loginPending ? 'disabled' : false },
      [state.loginPending ? 'Signing in…' : 'Sign in']),
  ]);

  return h('div', { class: 'login-shell' }, [
    h('div', { class: 'login-card' }, [
      h('div', { class: 'login-brand' }, [
        h('span', { class: 'dot' }),
        'AgentMail',
      ]),
      h('h1', {}, ['Welcome back']),
      h('div', { class: 'sub' }, ['Sign in to your agent-native mailbox.']),
      email ? h('div', { class: 'owner-pill' }, [email]) : null,
      form,
      h('div', { class: 'login-footer' }, [`v${VERSION} · agent-native by design`]),
    ]),
  ]);
}

// ============================================================================
// Render: app shell
// ============================================================================

function renderApp() {
  const isInbox = state.view === 'inbox';
  return h('div', { class: `app ${isInbox ? '' : 'app-page'}` }, [
    renderSidebar(),
    isInbox ? renderListPane() : null,
    renderDetailPane(),
  ].filter(Boolean));
}

// ============================================================================
// Render: sidebar
// ============================================================================

function renderSidebar() {
  const name = ownerName() || 'You';
  const email = ownerEmail() || '';

  const navInbox = h('div', {}, [
    h('div', { class: 'nav-section-label' }, ['Inbox']),
    ...TAB_DEFS.map((def) =>
      h('button', {
        class: `nav-item ${state.view === 'inbox' && state.currentTab === def.key ? 'active' : ''}`,
        onclick: () => selectTab(def.key),
      }, [
        def.dot ? h('span', { class: `nav-dot lane-dot ${def.dot}` }) : h('span', { class: 'nav-dot', style: 'background:var(--text-faint)' }),
        h('span', { class: 'nav-label' }, [def.label]),
        h('span', { class: 'nav-count' }, [String(state.tabCounts[def.key] ?? 0)]),
      ])
    ),
  ]);

  const navPages = h('div', {}, [
    h('div', { class: 'nav-section-label' }, ['Console']),
    h('button', {
      class: `nav-item ${state.view === 'agents' ? 'active' : ''}`,
      onclick: () => switchView('agents'),
    }, [
      h('span', { class: 'nav-dot', style: 'background:var(--accent)' }),
      h('span', { class: 'nav-label' }, ['Agents']),
    ]),
    h('button', {
      class: `nav-item ${state.view === 'audit' ? 'active' : ''}`,
      onclick: () => switchView('audit'),
    }, [
      h('span', { class: 'nav-dot', style: 'background:var(--text-dim)' }),
      h('span', { class: 'nav-label' }, ['Audit log']),
    ]),
  ]);

  return h('aside', { class: 'sidebar' }, [
    h('div', { class: 'sidebar-user' }, [
      h('div', { class: 'user-avatar', title: name }, [initials(name)]),
      h('div', { class: 'user-meta' }, [
        h('div', { class: 'user-name' }, [name]),
        h('div', { class: 'user-email' }, [email]),
      ]),
    ]),
    h('div', { class: 'sidebar-nav' }, [
      navInbox,
      h('div', { class: 'nav-divider' }),
      navPages,
    ]),
    h('div', { class: 'sidebar-footer' }, [
      h('span', {}, [`v${VERSION}`]),
      h('button', { class: 'btn small ghost', onclick: logout }, ['Sign out']),
    ]),
  ]);
}

function switchView(v) {
  state.view = v;
  state.currentThreadId = null;
  state.thread = null;
  render();
  if (v === 'agents') loadAgents();
  if (v === 'audit') loadAudit();
}

// ============================================================================
// Render: list pane (thread list)
// ============================================================================

function renderListPane() {
  const def = TAB_DEFS.find((d) => d.key === state.currentTab) || TAB_DEFS[0];
  const list = h('div', { class: 'thread-list' });

  if (state.threads.length === 0) {
    list.appendChild(h('div', { class: 'empty-list' }, [
      h('div', { class: 'icon' }, ['—']),
      h('div', {}, ['No threads in this view.']),
    ]));
  } else {
    for (const t of state.threads) {
      const others = otherParticipants(t.participants);
      const lane = t.current_lane || 0;
      const active = t.id === state.currentThreadId;
      list.appendChild(
        h('div', {
          class: `thread-row${active ? ' active' : ''}`,
          'data-id': t.id,
          onclick: () => loadThread(t.id),
        }, [
          h('div', { class: 'row-top' }, [
            h('div', { class: 'row-from' }, [others.length > 0 ? others.join(', ') : '(no participants)']),
            h('div', { class: 'row-time' }, [timeAgo(t.last_message_at)]),
          ]),
          h('div', { class: 'row-subj' }, [t.subject_norm || '(no subject)']),
          h('div', { class: 'row-bottom' }, [
            h('div', { class: 'row-meta' }, [`${t.message_count} ${t.message_count === 1 ? 'message' : 'messages'} · ${t.status}`]),
            lane ? h('span', { class: `lane-chip lane-${lane}` }, [
              h('span', { class: `lane-dot lane-${lane}` }),
              `Lane ${lane}`,
            ]) : null,
          ]),
        ])
      );
    }
  }

  return h('div', { class: 'list-pane' }, [
    h('div', { class: 'list-header' }, [
      h('div', { class: 'list-title' }, [
        h('h2', {}, [def.label]),
        h('span', { class: 'count' }, [`${state.threads.length}`]),
      ]),
      h('div', { class: 'search-wrap' }, [
        h('input', { type: 'search', placeholder: 'Search (coming soon)', disabled: 'disabled' }),
      ]),
    ]),
    list,
  ]);
}

// ============================================================================
// Render: detail pane
// ============================================================================

function renderDetailPane() {
  if (state.view === 'agents') return renderAgentsPage();
  if (state.view === 'audit')  return renderAuditPage();

  if (!state.currentThreadId) {
    return h('div', { class: 'detail-pane' }, [
      h('div', { class: 'empty-detail' }, [
        h('div', { class: 'big' }, ['No thread selected']),
        h('div', {}, ['Pick a thread from the list to see messages.']),
        h('div', { class: 'kbd-hint' }, [
          h('span', { class: 'kbd' }, ['j']),
          h('span', {}, ['/']),
          h('span', { class: 'kbd' }, ['k']),
          h('span', {}, ['to navigate threads']),
        ]),
      ]),
    ]);
  }

  if (!state.thread) {
    return h('div', { class: 'detail-pane' }, [
      h('div', { class: 'detail-body' }, [
        h('div', { class: 'message' }, [
          h('div', { class: 'skeleton', style: 'height:14px;width:55%;margin-bottom:10px' }),
          h('div', { class: 'skeleton', style: 'height:10px;width:30%;margin-bottom:18px' }),
          h('div', { class: 'skeleton', style: 'height:10px;width:90%;margin-bottom:6px' }),
          h('div', { class: 'skeleton', style: 'height:10px;width:85%;margin-bottom:6px' }),
          h('div', { class: 'skeleton', style: 'height:10px;width:70%' }),
        ]),
      ]),
    ]);
  }

  const { thread, messages, drafts } = state.thread;
  const lane = thread.current_lane || 0;
  const pendingDraft = (drafts || []).find((d) => d.status === 'pending');
  const approvedDraft = (drafts || []).find((d) => d.status === 'approved');

  const headerActions = h('div', { class: 'detail-actions' }, [
    h('button', { class: 'btn small ghost', onclick: () => reclassifyThread(thread.id), title: 'Reclassify last inbound message' }, ['Reclassify']),
    h('button', { class: 'btn small ghost', onclick: () => archiveThread(thread.id) }, ['Archive']),
    h('button', { class: 'btn small ghost', onclick: () => snoozeThread(thread.id) }, ['Snooze 1d']),
  ]);

  const messageEls = (messages || []).map(renderMessage);

  let banner = null;
  if (approvedDraft) {
    const sec = Math.max(0, Math.floor((new Date(approvedDraft.send_at).getTime() - Date.now()) / 1000));
    banner = h('div', { class: 'undo-banner' }, [
      h('div', { class: 'left' }, [
        h('span', { class: 'pulse' }),
        h('span', {}, [
          'Sending in ',
          h('strong', { id: `countdown-${approvedDraft.id}` }, [String(sec)]),
          's',
        ]),
      ]),
      h('button', {
        class: 'btn small',
        onclick: () => undoDraft(approvedDraft.id),
      }, ['Undo']),
    ]);
  }

  let draftEl = null;
  if (pendingDraft) draftEl = renderDraft(pendingDraft);

  let escalated = null;
  if (!pendingDraft && !approvedDraft && lane === 5) {
    escalated = h('div', { class: 'escalated-callout' }, [
      h('div', { class: 'title' }, ['Escalated to you']),
      h('div', { class: 'body' }, ['This thread needs human handling. The agent did not propose a draft.']),
    ]);
  }

  const pane = h('div', { class: 'detail-pane' }, [
    h('div', { class: 'detail-header' }, [
      h('div', {}, [
        h('h1', {}, [thread.subject_norm || '(no subject)']),
        h('div', { class: 'meta-row' }, [
          lane ? h('span', { class: `lane-chip lane-${lane}` }, [
            h('span', { class: `lane-dot lane-${lane}` }),
            `Lane ${lane}`,
          ]) : null,
          h('span', {}, [`${thread.status}`]),
          h('span', {}, ['·']),
          h('span', {}, [otherParticipants(thread.participants).join(', ') || '(no participants)']),
        ]),
      ]),
      headerActions,
    ]),
    h('div', { class: 'detail-body' }, [
      ...messageEls,
      banner,
      draftEl,
      escalated,
    ].filter(Boolean)),
  ]);

  // After insert: start countdown
  if (approvedDraft) {
    setTimeout(() => startCountdown(approvedDraft.id, approvedDraft.send_at), 0);
  }

  return pane;
}

function renderMessage(m) {
  const cls = m.direction === 'outbound' ? 'message outbound' : 'message';
  const fromName = m.from_name || m.from_email || '';
  const fromEmail = m.from_email || '';
  let cls_block = null;
  if (m.trust) {
    cls_block = h('div', { class: 'classification' }, [
      h('div', { class: 'class-tags' }, [
        h('span', { class: 'tag' }, [`trust: ${m.trust}`]),
        h('span', { class: 'tag' }, [`sender: ${m.sender_class}`]),
        h('span', { class: 'tag' }, [`intent: ${m.intent}`]),
        h('span', { class: 'tag' }, [`urgency: ${m.urgency}`]),
        h('span', { class: 'tag' }, [`→ Lane ${m.recommended_lane}`]),
      ]),
      m.class_reasoning ? h('div', { class: 'reasoning' }, [m.class_reasoning]) : null,
    ]);
  }
  return h('div', { class: cls }, [
    h('div', { class: 'message-header' }, [
      h('div', { class: 'message-from' }, [
        h('div', { class: 'from-avatar' }, [initials(fromName || fromEmail)]),
        h('div', {}, [
          h('div', {}, [
            h('span', { class: 'from-name' }, [fromName]),
            fromEmail && fromEmail !== fromName ? h('span', { class: 'from-email' }, [` <${fromEmail}>`]) : null,
          ]),
        ]),
      ]),
      h('div', { class: 'message-meta' }, [fmtDateTime(m.received_at)]),
    ]),
    h('pre', { class: 'message-body' }, [m.text_body || '']),
    cls_block,
  ].filter(Boolean));
}

function renderDraft(d) {
  const requires = !!d.requires_extra_confirmation;
  return h('div', { class: `draft-card ${requires ? 'requires-confirm' : ''}`, 'data-draft-id': d.id }, [
    h('div', { class: 'draft-header' }, [
      h('div', { class: 'draft-label' }, [
        h('span', { class: 'lane-dot lane-4' }),
        'Draft awaiting review',
      ]),
      h('div', { class: 'draft-meta' }, [`drafted ${timeAgo(d.created_at)} ago`]),
    ]),
    requires ? h('div', { class: 'confirm-warning' }, ['Requires extra confirmation before send.']) : null,
    h('div', { class: 'draft-body' }, [
      h('div', { class: 'draft-field' }, [
        h('span', { class: 'label' }, ['To']),
        h('span', { class: 'value' }, [(d.to_emails || []).join(', ')]),
      ]),
      d.cc_emails && d.cc_emails.length > 0 ? h('div', { class: 'draft-field' }, [
        h('span', { class: 'label' }, ['Cc']),
        h('span', { class: 'value' }, [(d.cc_emails || []).join(', ')]),
      ]) : null,
      h('div', { class: 'draft-field' }, [
        h('span', { class: 'label' }, ['Subject']),
        h('span', { class: 'value', style: 'font-family:var(--font-sans);color:var(--text);font-size:13px' }, [d.subject || '']),
      ]),
      h('textarea', {
        class: 'draft-textarea',
        id: `draft-textarea-${d.id}`,
      }, [d.edited_body || d.body_text || '']),
    ].filter(Boolean)),
    d.agent_reasoning ? h('div', { class: 'draft-reasoning' }, [
      d.agent_reasoning,
      d.agent_confidence != null ? h('span', { class: 'conf' }, [`${Math.round((d.agent_confidence || 0) * 100)}% conf`]) : null,
    ]) : null,
    h('div', { class: 'draft-actions' }, [
      h('button', { class: 'btn good', onclick: () => approveDraft(d.id) }, ['Approve & send']),
      h('button', { class: 'btn danger', onclick: () => rejectDraft(d.id) }, ['Reject']),
      h('div', { class: 'spacer' }),
      h('span', { class: 'muted', style: 'font-size:11.5px' }, ['Edits in the textarea will be applied on approve.']),
    ]),
  ].filter(Boolean));
}

async function reclassifyThread(id) {
  try {
    await api(`/api/threads/${id}/reclassify`, { method: 'POST' });
    toast('Reclassify queued.', 'success');
  } catch (e) { toast(`Error: ${e.message}`, 'error'); }
}

async function archiveThread(id) {
  try {
    await api(`/api/threads/${id}/archive`, { method: 'POST' });
    toast('Archived.', 'success');
    state.currentThreadId = null;
    state.thread = null;
    await loadThreads();
    render();
  } catch (e) { toast(`Error: ${e.message}`, 'error'); }
}

async function snoozeThread(id) {
  const until = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
  try {
    await api(`/api/threads/${id}/snooze`, { method: 'POST', body: JSON.stringify({ until }) });
    toast('Snoozed for 1 day.', 'success');
    state.currentThreadId = null;
    state.thread = null;
    await loadThreads();
    render();
  } catch (e) { toast(`Error: ${e.message}`, 'error'); }
}

// ============================================================================
// Agents page
// ============================================================================

async function loadAgents() {
  state.agentsLoading = true;
  try {
    const data = await api('/api/v1/admin/agents');
    state.agents = data.agents || [];
  } catch (e) {
    if (e.status !== 401) console.error(e);
  } finally {
    state.agentsLoading = false;
    if (state.view === 'agents') {
      const dp = document.querySelector('.detail-pane');
      if (dp) dp.replaceWith(renderAgentsPage());
    }
  }
}

async function createAgent(payload) {
  try {
    const data = await api('/api/v1/admin/agents', { method: 'POST', body: JSON.stringify(payload) });
    state.lastCreatedAgent = data.agent;
    toast(`Agent ${data.agent.agent_id} created.`, 'success');
    await loadAgents();
  } catch (e) { toast(`Error: ${e.message}`, 'error'); }
}

async function deleteAgent(agentId) {
  if (!window.confirm(`Revoke agent ${agentId}? It will no longer be able to send messages.`)) return;
  try {
    await api(`/api/v1/admin/agents/${agentId}`, { method: 'DELETE' });
    toast('Agent revoked.', 'success');
    await loadAgents();
  } catch (e) { toast(`Error: ${e.message}`, 'error'); }
}

function renderAgentsPage() {
  const created = state.lastCreatedAgent;

  let createdEl = null;
  if (created) {
    const origin = window.location.origin;
    const curl = `curl -X POST ${origin}/api/v1/agent/messages \\
  -H "X-AgentMail-Key: ${created.agent_id}" \\
  -H "X-AgentMail-Timestamp: $(date +%s)" \\
  -H "X-AgentMail-Signature: <hmac_sha256(secret, timestamp + '\\n' + body)>" \\
  -H "Content-Type: application/json" \\
  -d '{"topic":"hello","body":"hi there"}'`;
    createdEl = h('div', { class: 'secret-reveal' }, [
      h('div', { class: 'title' }, [`Agent created: ${created.agent_id}`]),
      h('div', { class: 'warn' }, ['Save this secret — it will not be shown again.']),
      renderCopyBlock(created.secret),
      h('div', { style: 'margin-top:12px;font-size:11.5px;color:var(--text-dim)' }, ['Try it:']),
      renderCopyBlock(curl),
      h('div', { style: 'margin-top:10px' }, [
        h('button', { class: 'btn small ghost', onclick: () => { state.lastCreatedAgent = null; const dp = document.querySelector('.detail-pane'); if (dp) dp.replaceWith(renderAgentsPage()); } }, ['Dismiss']),
      ]),
    ]);
  }

  const formEl = h('form', {
    onsubmit: (e) => {
      e.preventDefault();
      const f = e.target;
      const payload = {
        agent_id: f.elements.agent_id.value.trim(),
        display_name: f.elements.display_name.value.trim(),
        operator_email: f.elements.operator_email.value.trim() || undefined,
        trust_level: f.elements.trust_level.value || undefined,
      };
      if (!payload.agent_id || !payload.display_name) return;
      createAgent(payload);
      f.reset();
    },
  }, [
    h('div', { class: 'form-row' }, [
      h('div', { class: 'form-field' }, [
        h('label', {}, ['Agent ID']),
        h('input', { name: 'agent_id', placeholder: 'e.g. acme-recruiter', required: 'required', pattern: '[a-zA-Z0-9_-]+' }),
      ]),
      h('div', { class: 'form-field' }, [
        h('label', {}, ['Display name']),
        h('input', { name: 'display_name', placeholder: 'Acme Recruiter Bot', required: 'required' }),
      ]),
    ]),
    h('div', { class: 'form-row' }, [
      h('div', { class: 'form-field' }, [
        h('label', {}, ['Operator email (optional)']),
        h('input', { name: 'operator_email', type: 'email', placeholder: 'ops@acme.com' }),
      ]),
      h('div', { class: 'form-field' }, [
        h('label', {}, ['Trust level']),
        renderSelect('trust_level', [
          { value: 'unknown', label: 'unknown' },
          { value: 'known', label: 'known' },
          { value: 'trusted', label: 'trusted' },
          { value: 'partner', label: 'partner' },
        ], 'unknown'),
      ]),
    ]),
    h('div', { style: 'margin-top:6px' }, [
      h('button', { type: 'submit', class: 'btn primary' }, ['Create agent']),
    ]),
  ]);

  const rows = (state.agents || []).map((a) =>
    h('tr', {}, [
      h('td', {}, [h('code', { style: 'font-size:12px' }, [a.agent_id])]),
      h('td', {}, [a.display_name]),
      h('td', {}, [h('span', { class: `trust-badge trust-${a.trust_level}` }, [a.trust_level])]),
      h('td', {}, [h('code', { style: 'font-size:11.5px;color:var(--text-dim)' }, [a.key_prefix || '—'])]),
      h('td', {}, [a.created_at ? fmtDateTime(a.created_at) : '—']),
      h('td', {}, [a.last_used_at ? timeAgo(a.last_used_at) + ' ago' : h('span', { class: 'muted' }, ['never'])]),
      h('td', { style: 'text-align:right' }, [
        h('button', { class: 'btn small danger', onclick: () => deleteAgent(a.agent_id) }, ['Revoke']),
      ]),
    ])
  );

  const table = (state.agents || []).length > 0
    ? h('table', { class: 'table' }, [
        h('thead', {}, [
          h('tr', {}, [
            h('th', {}, ['ID']),
            h('th', {}, ['Display name']),
            h('th', {}, ['Trust']),
            h('th', {}, ['Key prefix']),
            h('th', {}, ['Created']),
            h('th', {}, ['Last used']),
            h('th', { style: 'text-align:right' }, ['']),
          ]),
        ]),
        h('tbody', {}, rows),
      ])
    : h('div', { style: 'padding:24px;text-align:center;color:var(--text-faint);font-size:13px' }, [
        state.agentsLoading ? 'Loading agents…' : 'No agents yet. Register one below.',
      ]);

  return h('div', { class: 'detail-pane' }, [
    h('div', { class: 'page-header' }, [
      h('h1', {}, ['Agents']),
      h('div', { class: 'sub' }, ['Authorised software agents that can send messages into this mailbox.']),
    ]),
    h('div', { class: 'page-body' }, [
      createdEl,
      h('div', { class: 'section' }, [
        h('div', { class: 'section-header' }, [
          h('div', {}, [
            h('h3', {}, ['Registered agents']),
            h('div', { class: 'sub' }, [`${(state.agents || []).length} active`]),
          ]),
        ]),
        table,
      ]),
      h('div', { class: 'section' }, [
        h('div', { class: 'section-header' }, [
          h('h3', {}, ['Register a new agent']),
        ]),
        h('div', { class: 'section-body' }, [formEl]),
      ]),
      h('div', { class: 'section' }, [
        h('div', { class: 'section-header' }, [
          h('h3', {}, ['For agent authors']),
        ]),
        h('div', { class: 'section-body', style: 'font-size:13px;line-height:1.7' }, [
          h('div', {}, [
            'Skill manifest: ',
            h('a', { href: '/SKILL.md', target: '_blank' }, ['/SKILL.md']),
          ]),
          h('div', {}, [
            'Discovery document: ',
            h('a', { href: '/.well-known/agentmail.json', target: '_blank' }, ['/.well-known/agentmail.json']),
          ]),
          h('div', {}, [
            'SDK reference: ',
            h('a', { href: 'https://github.com/anthropics/agentmail/blob/main/sdk/README.md', target: '_blank' }, ['sdk/README.md on GitHub']),
          ]),
        ]),
      ]),
    ].filter(Boolean)),
  ]);
}

function renderSelect(name, options, defaultValue) {
  const sel = h('select', { name });
  for (const o of options) {
    const opt = document.createElement('option');
    opt.value = o.value;
    opt.textContent = o.label;
    if (o.value === defaultValue) opt.selected = true;
    sel.appendChild(opt);
  }
  return sel;
}

function renderCopyBlock(text) {
  const wrap = h('div', { class: 'code-block with-copy' }, [text]);
  const btn = h('button', { class: 'copy-btn', type: 'button' }, ['Copy']);
  btn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = 'Copied!';
      btn.classList.add('copied');
      setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 1400);
    } catch {
      toast('Copy failed', 'error');
    }
  });
  wrap.appendChild(btn);
  return wrap;
}

// ============================================================================
// Audit page
// ============================================================================

async function loadAudit() {
  try {
    const params = new URLSearchParams();
    params.set('limit', '200');
    if (state.auditAction) params.set('action', state.auditAction);
    const data = await api(`/api/audit?${params}`);
    state.audit = data.entries || [];
  } catch (e) {
    if (e.status !== 401) console.error(e);
  } finally {
    if (state.view === 'audit') {
      const dp = document.querySelector('.detail-pane');
      if (dp) dp.replaceWith(renderAuditPage());
    }
  }
}

function renderAuditPage() {
  const actions = Array.from(new Set(state.audit.map((e) => e.action))).sort();
  const actionSelect = h('select', {
    onchange: (e) => { state.auditAction = e.target.value; loadAudit(); },
  }, [
    (() => { const o = document.createElement('option'); o.value = ''; o.textContent = 'All actions'; if (!state.auditAction) o.selected = true; return o; })(),
    ...actions.map((a) => { const o = document.createElement('option'); o.value = a; o.textContent = a; if (state.auditAction === a) o.selected = true; return o; }),
  ]);

  const rows = state.audit.map((e) => {
    const outcomeClass = e.outcome === 'ok' ? 'outcome-ok' : e.outcome === 'blocked' ? 'outcome-blocked' : 'outcome-error';
    const payloadStr = (() => { try { return JSON.stringify(e.payload); } catch { return ''; }})();
    return h('tr', {}, [
      h('td', { style: 'font-family:var(--font-mono);font-size:11.5px;color:var(--text-dim);white-space:nowrap' }, [fmtTime(e.created_at)]),
      h('td', {}, [h('span', { class: 'actor-chip' }, [e.actor])]),
      h('td', {}, [h('span', { class: 'action-chip' }, [e.action])]),
      h('td', {}, [h('span', { class: `outcome-chip ${outcomeClass}` }, [e.outcome])]),
      h('td', {}, [h('span', { class: 'audit-payload', title: payloadStr }, [payloadStr])]),
    ]);
  });

  return h('div', { class: 'detail-pane' }, [
    h('div', { class: 'page-header' }, [
      h('h1', {}, ['Audit log']),
      h('div', { class: 'sub' }, ['Every policy-gated action this mailbox has taken.']),
    ]),
    h('div', { class: 'page-body' }, [
      h('div', { class: 'filter-bar' }, [
        h('label', {}, ['Filter by action:']),
        actionSelect,
        h('span', { class: 'muted', style: 'margin-left:auto;font-size:12px' }, [`${state.audit.length} entries`]),
      ]),
      h('div', { class: 'section' }, [
        rows.length > 0
          ? h('table', { class: 'table' }, [
              h('thead', {}, [
                h('tr', {}, [
                  h('th', {}, ['Time']),
                  h('th', {}, ['Actor']),
                  h('th', {}, ['Action']),
                  h('th', {}, ['Outcome']),
                  h('th', {}, ['Payload']),
                ]),
              ]),
              h('tbody', {}, rows),
            ])
          : h('div', { style: 'padding:32px;text-align:center;color:var(--text-faint)' }, ['No audit entries.']),
      ]),
    ]),
  ]);
}

// ============================================================================
// Keyboard shortcuts (j / k)
// ============================================================================

document.addEventListener('keydown', (e) => {
  if (!state.token || state.view !== 'inbox') return;
  const tag = (e.target && e.target.tagName) || '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  if (e.key === 'j' || e.key === 'k') {
    e.preventDefault();
    const list = state.threads;
    if (list.length === 0) return;
    const i = list.findIndex((t) => t.id === state.currentThreadId);
    let next = i;
    if (e.key === 'j') next = i < 0 ? 0 : Math.min(list.length - 1, i + 1);
    else                next = i <= 0 ? 0 : i - 1;
    const t = list[next];
    if (t) loadThread(t.id);
  } else if (e.key === 'Escape') {
    if (window.innerWidth <= 800) document.body.classList.remove('show-detail');
  }
});

// ============================================================================
// Boot
// ============================================================================

bootstrap();
