const $ = (id) => document.getElementById(id);
const state = { data: null, conversation: null, entries: new Map(), before: null, next: null, tab: 'timeline', selected: null, query: '', filter: 'all', manager: null, tasks: [], taskId: null, managerError: null };
let requestNumber = 0;
let lastPayload = '';

// Every database string is text, never HTML (including model output and tool results).
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
}
function button(text, action, className = '') {
  const node = el('button', className, text);
  node.type = 'button';
  node.addEventListener('click', action);
  return node;
}
const json = (value) => JSON.stringify(value, null, 2);
function raw(title, value, key) {
  const node = el('details');
  node.dataset.key = key ?? title;
  node.append(el('summary', '', title), el('pre', '', json(value)));
  return node;
}
function badge(text) { return el('span', `badge ${text}`, text); }
function status(task) { return task.state?.outcome?.status ?? task.state?.status ?? 'unknown'; }
function empty(text) { return el('div', 'empty', text); }
function time(value) { return value ? new Date(value).toLocaleString() : ''; }
function documentValue(kind) { return state.data?.documents.find((doc) => doc.record.kind === kind)?.value; }
function select(type, value) {
  state.selected = { type, value };
  renderDetail();
  for (const node of document.querySelectorAll('[data-select]')) node.classList.toggle('selected', node.dataset.select === `${type}:${value.id ?? value.record?.id}`);
}
function selectable(node, type, value) {
  node.dataset.select = `${type}:${value.id ?? value.record?.id}`;
  node.classList.toggle('selected', state.selected?.type === type && (state.selected.value.id ?? state.selected.value.record?.id) === (value.id ?? value.record?.id));
}
function preserve(container, render) {
  const top = container.scrollTop;
  const open = new Set([...container.querySelectorAll('details[open]')].map((item) => item.dataset.key));
  render();
  for (const item of container.querySelectorAll('details')) item.open = open.has(item.dataset.key);
  container.scrollTop = top;
}
function resetEntries() { state.entries.clear(); state.next = null; lastPayload = ''; }
async function refresh(older = false) {
  const request = ++requestNumber;
  const task = state.taskId;
  // Manager mode without a selected task has nothing to read yet.
  if (state.manager !== null && task === null) return;
  const params = new URLSearchParams({ q: state.query, filter: state.filter });
  if (state.conversation !== null) params.set('conversation', state.conversation);
  const before = older ? state.next : state.before;
  if (before) params.set('before', before);
  const endpoint = state.manager !== null ? `/api/tasks/${task}/state` : '/api/state';
  try {
    const response = await fetch(`${endpoint}?${params}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
    // A late response from another task must never replace the selected task's view.
    if (request !== requestNumber || task !== state.taskId) return;
    $('error').hidden = true;
    $('connection').textContent = `Synced ${new Date().toLocaleTimeString()}`;
    const payload = JSON.stringify(data);
    if (!older && payload === lastPayload) return;
    if (!older) lastPayload = payload;
    // A burst larger than one page must not leave an invisible gap in the transcript.
    if (!older && state.entries.size && data.entries.length && !data.entries.some((entry) => state.entries.has(entry.id))) state.entries.clear();
    const firstPage = state.entries.size === 0;
    for (const entry of data.entries) state.entries.set(entry.id, entry);
    if (older || firstPage) state.next = data.next;
    state.data = data;
    state.conversation = data.conversation ?? null;
    renderNavigation();
    renderContent();
    renderDetail();
  } catch (error) {
    if (request !== requestNumber) return;
    $('connection').textContent = 'Not synced';
    $('error').textContent = `${error.message}. Previously loaded data may be stale; retrying every second.`;
    $('error').hidden = false;
  }
}
function jump(id) {
  if (!Number.isSafeInteger(Number(id)) || Number(id) < 1) return;
  state.before = Number(id) + 1;
  state.query = ''; state.filter = 'all';
  $('search').value = ''; $('filter').value = 'all';
  resetEntries();
  setTab('timeline');
  refresh().then(() => {
    const entry = state.entries.get(Number(id));
    if (entry) select('entry', entry);
    $('content').scrollTop = $('content').scrollHeight;
  });
}
function renderNavigation() {
  const { data } = state;
  const selected = state.manager !== null && state.taskId ? taskById(state.taskId) : null;
  $('title').textContent = selected ? selected.objective : `Conversation ${data.conversation ?? '—'}`;
  $('commit').textContent = `commit ${Number(data.seq) - 1}`;
  $('conversation').replaceChildren(...data.conversations.map((item) => {
    const option = el('option', '', `#${item.id}${item.parent ? ` · fork of #${item.parent.conversationId}` : ''}`);
    option.value = item.id; return option;
  }));
  $('conversation').value = String(state.conversation);
  $('request-count').textContent = data.submissions.length;
  $('task-count').textContent = data.tasks.filter((task) => task.conversationId === data.conversation).length;
  preserve($('requests'), () => $('requests').replaceChildren(...data.submissions.map((submission) => {
    const node = button('', () => { select('request', submission); if (submission.entry) jump(submission.entry); }, 'request');
    node.append(el('strong', '', submission.requestId ?? `Submission ${submission.id}`), badge(submission.status));
    node.title = submission.requestId ?? String(submission.id);
    return node;
  })));
}
function setTab(tab) {
  state.tab = tab;
  for (const node of document.querySelectorAll('[data-tab]')) node.setAttribute('aria-pressed', String(node.dataset.tab === tab));
  document.querySelector('.toolbar').hidden = tab !== 'timeline';
  renderContent();
}
function renderContent() {
  if (!state.data) return;
  preserve($('content'), () => {
    $('content').replaceChildren();
    if (state.tab === 'timeline') renderTimeline();
    if (state.tab === 'tasks') renderTasks();
    if (state.tab === 'state') renderState();
  });
}
function renderTimeline() {
  const content = $('content');
  if (state.before) content.append(el('div', 'notice', 'Viewing an earlier position. Choose Latest to return to the newest entries.'));
  if (state.next) content.append(button('↑ Load older entries', () => refresh(true), 'load-older'));
  if (!state.entries.size) content.append(empty('No entries match. Try another search or start a conversation in the CLI.'));
  for (const entry of [...state.entries.values()].sort((a, b) => a.id - b.id)) {
    const archived = state.data.head !== undefined && entry.id < state.data.head;
    const card = el('article', `entry ${entry.kind.replaceAll('.', '-')}${archived ? ' archived' : ''}`);
    selectable(card, 'entry', entry);
    const labels = { 'pi.user': ['YOU', 'You'], 'pi.assistant': ['AI', 'Assistant'], 'pi.tool-result': ['↳', 'Tool result'], 'pi.system': ['⚙', 'System prompt change'], 'pi.compaction': ['≋', 'Compaction'], 'pi.reset': ['↻', 'Context reset'] };
    const [icon, label] = labels[entry.kind] ?? ['·', entry.kind];
    const head = el('div', 'entry-head');
    head.append(el('span', 'avatar', icon), el('span', 'kind', label));
    if (archived) head.append(el('span', 'meta', 'before current context'));
    const error = entry.model?.some((message) => message.isError || ['error', 'aborted'].includes(message.stopReason));
    if (error) head.append(badge('error'));
    head.append(button(`#${entry.id} ↗`, () => select('entry', entry), 'inspect-button'));
    const body = el('div', 'entry-body');
    for (const [index, message] of (entry.model ?? []).entries()) {
      const key = `${entry.id}:${index}`;
      if (message.role === 'system') {
        body.append(raw('Recorded prompt / tool changes', message, key));
      } else if (message.role === 'toolResult') {
        body.append(raw(`${message.toolName ?? 'Tool'} · result`, message.content, key));
      } else if (typeof message.content === 'string') {
        body.append(el('p', 'prose', message.content));
      } else {
        for (const [partIndex, part] of (message.content ?? []).entries()) {
          if (part.type === 'text') body.append(el('p', 'prose', part.text));
          else if (part.type === 'toolCall') { const call = raw(`${part.name} · arguments`, part.arguments, `${key}:${partIndex}`); call.classList.add('tool-call'); body.append(call); }
          else if (part.type === 'thinking') body.append(raw('Thinking', part.thinking, `${key}:${partIndex}`));
          else body.append(el('p', 'muted', `[${part.type} content — inspect raw entry]`));
        }
      }
      if (message.errorMessage) body.append(el('p', 'prose', message.errorMessage));
    }
    if (entry.head !== undefined) body.append(el('p', 'meta', `Context boundary → entry #${entry.head}. Older entries remain available.`));
    if (entry.data !== undefined) body.append(raw('Entry data', entry.data, `data:${entry.id}`));
    card.append(head, body); content.append(card);
  }
  const live = documentValue('pi.live');
  if (live) content.append(raw('Live generation / partial output (persisted)', live, 'live-timeline'));
}
function taskButton(task) {
  const node = button('', () => select('task', task), 'list-button');
  selectable(node, 'task', task);
  const label = el('span', '', `${task.kind} #${task.id}`);
  label.append(el('span', 'task-owner', `${task.owner ? `↳ owner #${task.owner}` : `conversation #${task.conversationId}`}${task.background ? ' · background' : ''}${task.state?.checkpoint?.phase ? ` · ${task.state.checkpoint.phase}` : ''}`));
  node.append(label, badge(status(task))); return node;
}
function renderTasks() {
  const content = $('content');
  content.append(el('div', 'notice', 'Current stored task states, including finished work. “Running” can be stale after a crash. Select a task for its input, checkpoint or outcome, owner, and children.'));
  const tasks = state.data.tasks.filter((task) => task.conversationId === state.conversation);
  if (!tasks.length) content.append(empty('No durable tasks yet.'));
  for (const task of [...tasks].reverse()) content.append(taskButton(task));
}
function stat(value, label) {
  const node = el('div', 'stat'); node.append(el('strong', '', value), el('span', '', label)); return node;
}
function documentRecord(kind) { return state.data?.documents.find((doc) => doc.record.kind === kind); }
function renderState() {
  const content = $('content');
  content.append(el('div', 'notice', 'Current session and conversation documents, reconstructed from their committed base and Chord deltas. Includes usage, agent configuration, inbox, and live output.'));
  const usageDoc = documentRecord('pi.usage');
  const usage = usageDoc?.value;
  const buckets = [...Object.entries(usage?.models ?? {}).map(([key, value]) => [`model · ${key}`, value]), ...Object.entries(usage?.tools ?? {}).map(([key, value]) => [`tool · ${key}`, value])];
  const cost = buckets.reduce((total, [, value]) => total + value.cost.total, 0);
  const tokens = buckets.reduce((total, [, value]) => total + value.totalTokens, 0);
  content.append(el('h3', '', 'Spend (this conversation)'));
  const stats = el('div', 'stats');
  stats.append(stat(`$${cost.toFixed(4)}`, 'total cost'), stat(tokens.toLocaleString(), 'total tokens'), stat(buckets.length, 'usage buckets'));
  content.append(stats);
  if (!buckets.length) content.append(el('p', 'muted', 'No model or tool usage recorded for this conversation yet.'));
  for (const [label, value] of buckets) {
    const node = button('', () => usageDoc && select('document', usageDoc), 'list-button');
    node.append(el('span', '', label), el('span', 'meta', `${value.totalTokens.toLocaleString()} tok · $${value.cost.total.toFixed(4)}`));
    content.append(node);
  }
  for (const doc of state.data.documents) {
    const node = button('', () => select('document', doc), 'list-button');
    selectable(node, 'document', doc);
    node.append(el('span', '', doc.record.kind), badge(doc.record.scope.kind));
    content.append(node);
  }
}
function renderDetail() {
  const detail = $('detail');
  if (!state.selected) {
    detail.replaceChildren(empty('Select an entry, task, request, or document to inspect its persisted details and connections.'));
    return;
  }
  preserve(detail, () => {
    detail.replaceChildren();
    let { type, value } = state.selected;
    if (type === 'task') value = state.data.tasks.find((task) => task.id === value.id) ?? value;
    if (type === 'document') value = state.data.documents.find((doc) => doc.record.id === value.record.id) ?? value;
    if (type === 'request') value = state.data.submissions.find((item) => item.id === value.id) ?? value;
    detail.append(el('h2', '', `${type === 'document' ? value.record.kind : value.kind ?? type} #${value.id ?? value.record?.id}`));
    if (type === 'task') {
      detail.append(badge(status(value)));
      if (value.startedAt) detail.append(el('p', 'meta', `Started ${time(value.startedAt)}`));
      if (value.endedAt) detail.append(el('p', 'meta', `Ended ${time(value.endedAt)}`));
      detail.append(raw('Input', value.input, `input:${value.id}`), raw('Checkpoint / outcome', value.state, `state:${value.id}`));
      if (value.state?.outcome?.result?.entryId) detail.append(button(`Result entry #${value.state.outcome.result.entryId} ↗`, () => jump(value.state.outcome.result.entryId), 'list-button'));
    }
    if (type === 'entry') {
      const requests = state.data.submissions.filter((item) => item.entry === value.id || item.answer === value.id);
      for (const item of requests) detail.append(button(`Request: ${item.requestId ?? item.id}`, () => select('request', item), 'list-button'));
    }
    if (type === 'request') {
      detail.append(badge(value.status));
      for (const [label, id] of [['Input', value.entry], ['Answer', value.answer]]) if (id) detail.append(button(`${label} entry #${id} ↗`, () => jump(id), 'list-button'));
    }
    if (type === 'entry' || type === 'task') {
      const tasks = state.data.tasks;
      const ids = new Set(type === 'task' ? [value.id] : tasks.filter((task) => task.id === value.byTaskId || task.input?.assistant === value.id || task.state?.outcome?.result?.entryId === value.id).map((task) => task.id));
      // Include descendants of directly related tasks, then their ancestor chain, not unrelated siblings.
      for (let size = -1; size !== ids.size;) { size = ids.size; for (const task of tasks) if (ids.has(task.owner)) ids.add(task.id); }
      for (let size = -1; size !== ids.size;) { size = ids.size; for (const task of tasks) if (ids.has(task.id) && task.owner) ids.add(task.owner); }
      const related = tasks.filter((task) => ids.has(task.id) && !(type === 'task' && task.id === value.id));
      detail.append(el('h3', '', 'Related durable tasks'));
      if (!related.length) detail.append(el('p', 'muted', 'No other persisted task links.'));
      for (const task of related) detail.append(taskButton(task));
    }
    detail.append(raw('Raw persisted record', value, `raw:${type}:${value.id ?? value.record?.id}`));
  });
}

// --- Manager mode: user-facing tasks layered over the same inspector views ---

function taskById(id) { return state.tasks.find((task) => task.id === id) ?? null; }

function taskBadge(text) { return el('span', `badge ${String(text).toLowerCase()}`, text); }

function selectTask(id) {
  if (state.taskId === id) return;
  state.taskId = id;
  state.before = null;
  state.selected = null;
  state.actionError = null;
  // Clear the previous task's view first: a switch must never show another task's transcript.
  state.data = null;
  state.conversation = null;
  resetEntries();
  $('content').replaceChildren();
  $('detail').replaceChildren();
  $('requests').replaceChildren();
  $('conversation').replaceChildren();
  history.replaceState(null, '', `#task=${id}`);
  renderTaskPanel();
  refresh();
}

function renderTaskPanel() {
  const panel = $('tasks-panel');
  if (state.manager === null) { panel.hidden = true; return; }
  panel.hidden = false;
  const disconnected = state.managerError !== null;
  $('mode').textContent = disconnected ? 'MANAGER OFFLINE' : 'MANAGER';
  $('user-task-count').textContent = state.tasks.length;
  preserve($('task-list'), () => {
    $('task-list').replaceChildren();
    if (disconnected) $('task-list').append(el('p', 'form-error', `Manager unreachable: ${state.managerError}. Showing stored task summaries; they may be stale.`));
    if (!state.tasks.length && !disconnected) $('task-list').append(el('p', 'meta', 'No tasks yet. Start one above.'));
    for (const task of state.tasks) {
      const node = el('button', `task-card${task.id === state.taskId ? ' selected' : ''}${disconnected ? ' stale' : ''}`);
      node.type = 'button';
      node.append(el('span', 'objective', task.objective), taskBadge(task.status));
      if (task.lastError) node.append(el('span', 'task-meta', task.lastError));
      node.append(el('span', 'task-meta', `workspace: ${task.workspacePath}`));
      node.addEventListener('click', () => selectTask(task.id));
      $('task-list').append(node);
    }
  });
  renderTaskControls();
}

function renderTaskControls() {
  const controls = $('task-controls');
  const task = state.taskId ? taskById(state.taskId) : null;
  if (state.manager === null || !task) { controls.hidden = true; return; }
  controls.hidden = false;
  const disconnected = state.managerError !== null;
  const status = $('task-status');
  status.textContent = task.status;
  status.className = `badge ${task.status.toLowerCase()}`;
  const pausable = ['Queued', 'Running', 'Recovering', 'Interrupted'].includes(task.status);
  const resumable = ['Paused', 'Interrupted', 'Failed'].includes(task.status);
  const followable = ['Completed', 'Failed'].includes(task.status);
  $('pause').disabled = disconnected || !pausable;
  $('pause').title = disconnected ? 'The manager is unreachable.' : pausable ? 'Persist pause intent and close the active run.' : `Pause is not available while the task is ${task.status}.`;
  $('resume').disabled = disconnected || !resumable;
  $('resume').title = disconnected ? 'The manager is unreachable.' : resumable ? 'Re-enqueue the same request and reset the recovery budget.' : `Resume is not available while the task is ${task.status}.`;
  $('followup-text').disabled = disconnected || !followable;
  $('followup-send').disabled = disconnected || !followable;
  $('followup-send').title = disconnected ? 'The manager is unreachable.' : followable ? 'Send a follow-up in this task’s conversation.' : 'A follow-up is allowed once the current request settles.';
  if (task.result) { $('task-result').textContent = task.result; $('task-result').hidden = false; } else { $('task-result').hidden = true; }
  const error = state.actionError ?? (task.lastError ? `${task.status === 'Failed' ? 'Failure' : 'Last error'}: ${task.lastError}` : null);
  $('task-error').textContent = error ?? '';
  $('task-error').hidden = error === null;
  $('task-workspace').textContent = `Local workspace: ${task.workspacePath}`;
}

async function pollTasks() {
  if (state.manager === null) return;
  try {
    const response = await fetch('/api/tasks');
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
    state.manager = data;
    state.tasks = data.tasks ?? [];
    state.managerError = null;
    if (state.taskId === null && state.tasks.length) selectTask(state.tasks[0].id);
    $('connection').textContent = `Manager synced ${new Date().toLocaleTimeString()}`;
    renderTaskPanel();
  } catch (error) {
    state.managerError = error.message;
    $('connection').textContent = 'Manager disconnected';
    renderTaskPanel();
  }
}

function populateModels() {
  const models = state.manager?.models ?? [];
  const options = models.map((model) => {
    const option = el('option', '', `${model.provider}/${model.modelId}`);
    option.value = `${model.provider}/${model.modelId}`;
    return option;
  });
  $('model').replaceChildren(...options);
  const fallback = state.manager?.defaultModel;
  if (fallback) $('model').value = `${fallback.provider}/${fallback.modelId}`;
}

async function post(path, body) {
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
  return data;
}

// One creation key survives retries, so a lost acknowledgement never creates a second task.
let createIntent = null;
async function submitCreate(event) {
  event.preventDefault();
  const objective = $('objective').value.trim();
  const model = $('model').value;
  if (!objective) return;
  if (!createIntent || createIntent.objective !== objective || createIntent.model !== model) {
    createIntent = { key: crypto.randomUUID(), objective, model };
  }
  $('create').disabled = true;
  $('create-error').hidden = true;
  try {
    const data = await post('/api/tasks', { creationKey: createIntent.key, objective, model });
    createIntent = null;
    $('objective').value = '';
    selectTask(data.task.id);
    await pollTasks();
  } catch (error) {
    $('create-error').textContent = `${error.message} Retrying keeps the same command.`;
    $('create-error').hidden = false;
  } finally {
    $('create').disabled = false;
  }
}

// One follow-up request ID survives retries the same way.
let followIntent = null;
async function submitFollowUp(event) {
  event.preventDefault();
  const prompt = $('followup-text').value.trim();
  const taskId = state.taskId;
  if (!prompt || !taskId) return;
  if (!followIntent || followIntent.prompt !== prompt || followIntent.taskId !== taskId) {
    followIntent = { taskId, requestId: crypto.randomUUID(), prompt };
  }
  $('followup-send').disabled = true;
  state.actionError = null;
  try {
    await post(`/api/tasks/${taskId}/requests`, { requestId: followIntent.requestId, prompt });
    followIntent = null;
    $('followup-text').value = '';
    await pollTasks();
  } catch (error) {
    state.actionError = `${error.message} Retrying keeps the same command.`;
  } finally {
    renderTaskControls();
  }
}

async function lifecycle(action) {
  const taskId = state.taskId;
  if (!taskId) return;
  state.actionError = null;
  $(action).disabled = true;
  try {
    await post(`/api/tasks/${taskId}/${action}`, {});
    await pollTasks();
  } catch (error) {
    state.actionError = error.message;
  } finally {
    renderTaskControls();
  }
}

// Read-only inspector mode is exactly GET /api/tasks failing.
async function detectManager() {
  try {
    const response = await fetch('/api/tasks');
    if (!response.ok) return false;
    state.manager = await response.json();
    state.tasks = state.manager.tasks ?? [];
    return true;
  } catch {
    return false;
  }
}

$('conversation').addEventListener('change', () => {
  state.conversation = Number($('conversation').value); state.before = null; state.selected = null;
  resetEntries(); refresh();
});
let searchTimer;
$('search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { state.query = $('search').value; state.before = null; resetEntries(); refresh(); }, 200);
});
$('filter').addEventListener('change', () => { state.filter = $('filter').value; state.before = null; resetEntries(); refresh(); });
$('latest').addEventListener('click', () => { state.before = null; resetEntries(); refresh().then(() => { $('content').scrollTop = $('content').scrollHeight; }); });
$('clear-selection').addEventListener('click', () => { state.selected = null; renderDetail(); renderContent(); });
for (const node of document.querySelectorAll('[data-tab]')) node.addEventListener('click', () => setTab(node.dataset.tab));
$('create-task').addEventListener('submit', submitCreate);
$('follow-up').addEventListener('submit', submitFollowUp);
$('pause').addEventListener('click', () => lifecycle('pause'));
$('resume').addEventListener('click', () => lifecycle('resume'));

if (await detectManager()) {
  populateModels();
  renderTaskPanel();
  const requested = new URLSearchParams(location.hash.replace(/^#/, '')).get('task');
  const first = requested && state.tasks.some((task) => task.id === requested) ? requested : state.tasks[0]?.id ?? null;
  if (first) selectTask(first);
}
await refresh();
// Recursive timeout avoids stacking polling requests when the database is busy.
async function poll() { await pollTasks(); await refresh(); setTimeout(poll, 1000); }
setTimeout(poll, 1000);
