const $ = selector => document.querySelector(selector);
const state = {
  name: '', sessions: [], active: null,
  config: {baseUrl: '', model: 'gpt-4o-mini', sessionId: '', configured: false},
};
let aiOn = true;
let syncing = 0;

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
function esc(value) {
  return String(value).replace(/[&<>"']/g, char => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'}[char]));
}
function formatInline(value) {
  const code = [];
  const links = [];
  let html = String(value).replace(/`([^`\n]+)`/g, (_, content) => {
    code.push(esc(content));
    return `\u0001${code.length - 1}\u0002`;
  });
  html = html.replace(/\[([^\]]+)]\((https?:\/\/[^\s)]+)\)/g, (_, label, url) => {
    links.push(`<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>`);
    return `\u0003${links.length - 1}\u0004`;
  });
  html = esc(html)
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_\n]+)__/g, '<strong>$1</strong>')
    .replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
    .replace(/_([^_\n]+)_/g, '<em>$1</em>');
  return html
    .replace(/\u0001(\d+)\u0002/g, (_, index) => `<code>${code[Number(index)]}</code>`)
    .replace(/\u0003(\d+)\u0004/g, (_, index) => links[Number(index)]);
}

function formatMessage(value) {
  const lines = String(value || '').replace(/\r\n/g, '\n').replace(/^(?:[ \t]*\n)+/, '').split('\n');
  const output = [];
  let paragraph = [];
  let listType = '';
  let listItems = [];
  let codeLines = null;
  let codeLanguage = '';

  const flushParagraph = () => {
    if (paragraph.length) output.push(`<p>${paragraph.join('<br>')}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (listItems.length) output.push(`<${listType}>${listItems.map(item => `<li>${item}</li>`).join('')}</${listType}>`);
    listType = '';
    listItems = [];
  };
  const flushText = () => {
    flushParagraph();
    flushList();
  };

  for (const line of lines) {
    if (codeLines !== null) {
      if (/^```\s*$/.test(line)) {
        output.push(`<pre><code${codeLanguage ? ` data-language="${esc(codeLanguage)}"` : ''}>${esc(codeLines.join('\n'))}</code></pre>`);
        codeLines = null;
        codeLanguage = '';
      } else {
        codeLines.push(line);
      }
      continue;
    }

    const fence = line.match(/^```\s*([^\s`]*)\s*$/);
    if (fence) {
      flushText();
      codeLines = [];
      codeLanguage = fence[1];
      continue;
    }
    if (!line.trim()) {
      flushText();
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      flushText();
      const level = heading[1].length;
      output.push(`<h${level}>${formatInline(heading[2])}</h${level}>`);
      continue;
    }
    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      flushText();
      output.push(`<blockquote>${formatInline(quote[1])}</blockquote>`);
      continue;
    }
    const unordered = line.match(/^[-*+]\s+(.+)$/);
    const ordered = line.match(/^\d+[.)]\s+(.+)$/);
    if (unordered || ordered) {
      flushParagraph();
      const type = unordered ? 'ul' : 'ol';
      if (listType && listType !== type) flushList();
      listType = type;
      listItems.push(formatInline((unordered || ordered)[1]));
      continue;
    }
    flushList();
    paragraph.push(formatInline(line));
  }
  flushText();
  if (codeLines !== null) output.push(`<pre><code${codeLanguage ? ` data-language="${esc(codeLanguage)}"` : ''}>${esc(codeLines.join('\n'))}</code></pre>`);
  return output.join('');
}
function activeSession() { return state.sessions.find(session => session.id === state.active); }

function acceptShared(data) {
  state.name = data.name || '';
  state.sessions = Array.isArray(data.sessions) ? data.sessions : [];
  state.config = data.config || state.config;
  state.active = data.active || state.active;
  if (!activeSession()) state.active = state.sessions[0]?.id || null;
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
    const data = await apiRequest('/api/state');
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
  const record = session.debugRecord;
  $('#recordList').innerHTML = record ? `
    <article class="record-entry">
      <div class="record-meta"><strong>最近一次调用</strong><span>${esc(record.time || '')} · HTTP ${esc(record.response?.status ?? 'ERROR')}</span></div>
      <h4>REQUEST</h4><pre>${esc(JSON.stringify(record.request, null, 2))}</pre>
      <h4>RESPONSE</h4><pre>${esc(JSON.stringify(record.response, null, 2))}</pre>
    </article>
  ` : '<p class="record-empty">暂无 API 调试记录；新请求完成后会显示在这里。</p>';
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
    model: config.model || 'AI', pending: true, time: now(), includeInAi: true,
  });
  if (!config.configured) {
    pending.pending = false;
    pending.text = '请先在设置中配置共享 API。';
    render();
    updateMessage(session.id, pending);
    return;
  }
  try {
    const messages = session.messages.filter(message => !message.pending && message.includeInAi === true).map(message => ({
      role: message.kind === 'ai' ? 'assistant' : 'user',
      content: message.kind === 'ai' ? message.text : `[User: ${message.author}]\n${message.text}`,
    }));
    const body = {messages};
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
  appendMessage({author: state.name, initials: state.name.slice(0, 2), avatar: 'avatar-me', text, time: now(), includeInAi: aiOn});
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
    baseUrl: $('#apiBaseUrl').value.trim(),
    key: $('#apiKey').value.trim(), model: $('#apiModel').value.trim() || 'gpt-4o-mini',
    sessionId: $('#apiSessionId').value.trim(),
  });
  if (data) $('#settingsDialog').close();
};
$('#clearSettings').onclick = () => {
  $('#apiBaseUrl').value = '';
  $('#apiKey').value = '';
  $('#apiModel').value = 'gpt-4o-mini';
  $('#apiSessionId').value = '';
};
$('#closeRecord').onclick = () => $('#recordDialog').close();

$('#app').classList.add('hidden');
$('#aiToggle').classList.add('on');
loadShared();
setInterval(loadShared, 2000);
