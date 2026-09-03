const $ = selector => document.querySelector(selector);
const legacy = JSON.parse(localStorage.getItem('teamask') || 'null') || {};
const state = {
  name: '', sessions: [], active: null,
  config: {baseUrl: '', endpoint: '/chat/completions', model: 'gpt-4o-mini', sessionId: '', configured: false},
};
let aiOn = true;
let syncing = 0;
let legacyMigrated = false;

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
function esc(value) {
  return String(value).replace(/[&<>"']/g, char => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'}[char]));
}
function formatMessage(value) {
  return esc(String(value || '').replace(/^(?:[ \t]*\r?\n)+/, '')).replace(/\r?\n/g, '<br>');
}
function activeSession() { return state.sessions.find(session => session.id === state.active); }

function acceptShared(data) {
  state.name = data.name || '';
  state.sessions = Array.isArray(data.sessions) ? data.sessions : [];
  state.config = data.config || state.config;
  state.active = data.active || state.active;
  if (!activeSession()) state.active = state.sessions[0]?.id || null;
  localStorage.removeItem('teamask');
  $('#nameGate').classList.toggle('hidden', Boolean(state.name));
  $('#app').classList.toggle('hidden', !state.name);
  if (state.name) render();
}

async function apiRequest(path, options = {}) {
  const response = await fetch(path, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '请求失败');
  return data;
}

async function postShared(path, body) {
  syncing += 1;
  try {
    const data = await apiRequest(path, {
      method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body),
    });
    acceptShared(data);
    return data;
  } catch (error) {
    console.error(error);
    return null;
  } finally {
    syncing -= 1;
  }
}

async function loadShared() {
  if (syncing) return;
  syncing += 1;
  try {
    let data = await apiRequest('/api/state');
    if (!legacyMigrated) {
      if (!data.name && legacy.name) {
        data = await apiRequest('/api/profile', {
          method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({name: legacy.name, active: legacy.active}),
        });
      }
      if (!data.config.configured && legacy.config?.baseUrl && legacy.config?.key) {
        data = await apiRequest('/api/config', {
          method: 'POST', headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({...legacy.config, initialOnly: true}),
        });
      }
      if (!data.sessions.length && legacy.sessions?.length) {
        data = await apiRequest('/api/state', {
          method: 'POST', headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({action: 'initialize', sessions: legacy.sessions}),
        });
      }
      legacyMigrated = true;
    }
    acceptShared(data);
  } catch (error) {
    console.error(error);
  } finally {
    syncing -= 1;
  }
}

function newSession() {
  const session = {
    id: uid(), title: '新的对话',
    time: new Date().toLocaleDateString('zh-CN', {month: 'short', day: 'numeric'}), messages: [],
  };
  state.sessions.unshift(session);
  state.active = session.id;
  render();
  postShared('/api/state', {action: 'create_session', session});
}

function render() {
  if (!state.name) return;
  $('#profileName').textContent = state.name;
  $('#profileAvatar').textContent = state.name.slice(0, 2);
  $('#sessionList').innerHTML = state.sessions.map(session => `
    <div class="session ${session.id === state.active ? 'active' : ''}" data-id="${session.id}">
      <div class="session-top"><div class="session-title">${esc(session.title)}</div><button class="record-btn" data-record-id="${session.id}">调试记录</button></div>
      <div class="session-time">${esc(session.time)}</div>
    </div>`).join('');
  document.querySelectorAll('.session').forEach(element => {
    element.onclick = () => { state.active = element.dataset.id; render(); postShared('/api/profile', {active: state.active}); };
  });
  document.querySelectorAll('.record-btn').forEach(button => {
    button.onclick = event => { event.stopPropagation(); openRecord(button.dataset.recordId); };
  });
  const messages = activeSession()?.messages || [];
  $('#messageList').innerHTML = '<div class="day-divider">今天 · PUBLIC ROOM</div>' + messages.map(messageHTML).join('');
  $('#messageList').scrollTop = $('#messageList').scrollHeight;
  $('#modelBadge').textContent = state.config.model || '未设置模型';
}

function messageHTML(message) {
  const me = message.author === state.name;
  const ai = message.kind === 'ai';
  return `<article class="message ${me ? 'me' : ''} ${ai ? 'ai' : ''}">
    <div class="avatar ${message.avatar || 'avatar-me'}">${esc(message.initials || message.author.slice(0, 2))}</div>
    <div class="message-body"><div class="message-meta">${esc(message.author)} ${ai ? `<span class="ai-label">AI · ${esc(message.model || state.config.model)}</span>` : ''}<span>${esc(message.time)}</span></div>
    <div class="bubble ${message.pending ? 'pending-bubble' : ''}">${message.pending ? '<span class="thinking"><i></i><i></i><i></i> 正在思考…</span>' : formatMessage(message.text)}</div></div>
  </article>`;
}

function openRecord(sessionId) {
  const session = state.sessions.find(item => item.id === sessionId);
  if (!session) return;
  $('#recordTitle').textContent = session.title + ' · 完整输入输出';
  const records = session.debugRecords || [];
  $('#recordList').innerHTML = records.length ? records.map((record, index) => `
    <article class="record-entry">
      <div class="record-meta"><strong>调用 ${index + 1}</strong><span>${esc(record.time || '')} · HTTP ${esc(record.response?.status ?? 'ERROR')}</span></div>
      <h4>REQUEST</h4><pre>${esc(JSON.stringify(record.request, null, 2))}</pre>
      <h4>RESPONSE</h4><pre>${esc(JSON.stringify(record.response, null, 2))}</pre>
    </article>
  `).join('') : '<p class="record-empty">暂无 API 调试记录；新请求完成后会显示在这里。</p>';
  $('#recordDialog').showModal();
}

function appendMessage(message) {
  const session = activeSession();
  message.id = message.id || uid();
  session.messages.push(message);
  if (session.title === '新的对话' && message.author === state.name) session.title = message.text.slice(0, 25);
  render();
  postShared('/api/state', {action: 'append_message', sessionId: session.id, message});
  return message;
}
function updateMessage(sessionId, message) {
  postShared('/api/state', {action: 'update_message', sessionId, message});
}

async function askAI() {
  const session = activeSession();
  const config = state.config;
  if (!aiOn) return;
  const pending = appendMessage({
    author: config.model || 'AI', initials: 'AI', avatar: 'avatar-c', kind: 'ai',
    model: config.model || 'AI', pending: true, time: now(),
  });
  if (!config.configured) {
    pending.pending = false;
    pending.text = '请先在设置中配置共享 API。';
    render();
    updateMessage(session.id, pending);
    return;
  }
  try {
    const messages = session.messages.filter(message => !message.pending).map(message => ({
      role: message.kind === 'ai' ? 'assistant' : 'user',
      content: message.kind === 'ai' ? message.text : `[User: ${message.author}]\n${message.text}`,
    }));
    const body = config.endpoint === '/responses' ? {input: messages} : {messages};
    const data = await apiRequest('/api/ai', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({body, sessionId: session.id, messageId: pending.id}),
    });
    pending.pending = false;
    pending.text = data.output_text || data.choices?.[0]?.message?.content || data.output?.flatMap(item => item.content || []).map(item => item.text || '').join('') || '模型没有返回内容。';
  } catch (error) {
    pending.pending = false;
    pending.text = '请求失败：' + error.message;
  }
  pending.time = now();
  render();
  updateMessage(session.id, pending);
}

function now() { return new Date().toLocaleTimeString('zh-CN', {hour: '2-digit', minute: '2-digit'}); }

$('#nameForm').onsubmit = async event => {
  event.preventDefault();
  const name = $('#nameInput').value.trim();
  if (!name) return;
  const data = await postShared('/api/profile', {name});
  if (data && !state.sessions.length) newSession();
};
$('#newSessionBtn').onclick = newSession;
$('#renameBtn').onclick = async () => {
  const name = prompt('输入新名字', state.name);
  if (name?.trim()) await postShared('/api/profile', {name: name.trim()});
};
$('#messageForm').onsubmit = event => {
  event.preventDefault();
  const input = $('#messageInput');
  const text = input.value.trim();
  if (!text) return;
  appendMessage({author: state.name, initials: state.name.slice(0, 2), avatar: 'avatar-me', text, time: now()});
  input.value = '';
  input.style.height = 'auto';
  askAI();
};
$('#messageInput').onkeydown = event => {
  if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); $('#messageForm').requestSubmit(); }
  else if (event.key === 'Enter' && event.shiftKey) setTimeout(() => event.target.style.height = event.target.scrollHeight + 'px');
};
$('#aiToggle').onclick = () => {
  aiOn = !aiOn;
  $('#aiToggle').classList.toggle('on', aiOn);
  $('#aiToggle').setAttribute('aria-pressed', aiOn);
};

function openSettings() {
  $('#apiBaseUrl').value = state.config.baseUrl;
  $('#apiEndpoint').value = state.config.endpoint;
  $('#apiKey').value = '';
  $('#apiKey').placeholder = state.config.hasKey ? '已保存在部署机，留空则不修改' : 'sk-…';
  $('#apiModel').value = state.config.model;
  $('#apiSessionId').value = state.config.sessionId;
  $('#settingsDialog').showModal();
}
$('#settingsBtn').onclick = openSettings;
$('#modelSettings').onclick = openSettings;
$('#closeSettings').onclick = () => $('#settingsDialog').close();
$('#saveSettings').onclick = async () => {
  const data = await postShared('/api/config', {
    baseUrl: $('#apiBaseUrl').value.trim(), endpoint: $('#apiEndpoint').value,
    key: $('#apiKey').value.trim(), model: $('#apiModel').value.trim() || 'gpt-4o-mini',
    sessionId: $('#apiSessionId').value.trim(),
  });
  if (data) $('#settingsDialog').close();
};
$('#clearSettings').onclick = () => {
  $('#apiBaseUrl').value = '';
  $('#apiEndpoint').value = '/chat/completions';
  $('#apiKey').value = '';
  $('#apiModel').value = 'gpt-4o-mini';
  $('#apiSessionId').value = '';
};
$('#closeRecord').onclick = () => $('#recordDialog').close();

$('#app').classList.add('hidden');
$('#aiToggle').classList.add('on');
loadShared();
setInterval(loadShared, 2000);
