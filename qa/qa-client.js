const $ = (id) => document.getElementById(id);
const state = {
  topics: [], byId: new Map(), children: new Map(), roots: [], expanded: new Set(),
  query: '', topic: null, limit: 10, offset: 0, total: 0, ready: false,
  request: 0, controller: null,
};
const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true });
const alphabetical = (a, b) => collator.compare(a.name, b.name) || a.id - b.id;
const chevronSvg = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 3 5 5-5 5"/></svg>';
const answerArrowSvg = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 10h12m-5-5 5 5-5 5"/></svg>';
const folded = (text) => String(text).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('en');
const letterOf = (topic) => {
  const letter = folded(topic.name).match(/[a-z0-9]/)?.[0].toUpperCase();
  return /^[A-Z]$/.test(letter || '') ? letter : '#';
};

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function sourceLink(value, text, className = '') {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'qa.suscopts.org' || url.username || url.password) return null;
    const link = element('a', className, text);
    link.href = url.href;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    return link;
  } catch {
    return null;
  }
}

function pathChevron() {
  const span = element('span', 'path-chevron');
  span.setAttribute('aria-hidden', 'true');
  span.innerHTML = chevronSvg;
  return span;
}

function topicButton(topic, className = 'answer-topic-link') {
  const button = element('button', className, topic.name);
  button.type = 'button';
  button.dataset.topicId = topic.id;
  button.addEventListener('click', () => selectTopic(topic.id));
  return button;
}

function closeMobileTopics(hadFocus = $('topic-controls').contains(document.activeElement)) {
  document.querySelector('.topic-sidebar').classList.remove('mobile-open');
  $('mobile-topic-toggle').setAttribute('aria-expanded', 'false');
  if (hadFocus && window.matchMedia('(max-width: 760px)').matches) $('mobile-topic-toggle').focus();
}

function expandSelectedPath() {
  const topic = state.byId.get(state.topic);
  for (const id of topic?.path_ids || []) state.expanded.add(id);
}

function revealSelectedTopic() {
  const tree = $('topic-tree');
  const selected = tree.querySelector('.topic-select.selected');
  if (!selected || !tree.clientHeight) return;
  const box = selected.getBoundingClientRect();
  const viewport = tree.getBoundingClientRect();
  if (box.top < viewport.top) tree.scrollTop -= viewport.top - box.top;
  else if (box.bottom > viewport.bottom) tree.scrollTop += box.bottom - viewport.bottom;
}

function renderTopics({ focusId = null } = {}) {
  const query = folded($('topic-filter').value.trim());
  const words = query.split(/\s+/).filter(Boolean);
  const matches = new Set();
  const visible = new Set();
  if (query) {
    for (const topic of state.topics) {
      if (words.every((word) => folded(topic.name).includes(word))) {
        matches.add(topic.id);
        for (const id of topic.path_ids) visible.add(id);
      }
    }
  }
  const filtered = Boolean(query);
  const letter = $('topic-letter').value;
  $('topic-letter').disabled = filtered;
  $('topic-tree-label').textContent = filtered ? `${matches.size.toLocaleString()} matching ${matches.size === 1 ? 'topic' : 'topics'}` : 'Original topic branches';
  $('topic-filter-status').textContent = filtered ? `${matches.size.toLocaleString()} topic names match ${$('topic-filter').value.trim()}. Parent topics are shown for context.` : '';
  const list = element('ul', 'topic-root-list');

  function addTopic(topic, parent) {
    const children = state.children.get(topic.id) || [];
    const shownChildren = filtered ? children.filter((child) => visible.has(child.id)) : children;
    const hasBranch = shownChildren.length > 0;
    const open = filtered ? hasBranch : state.expanded.has(topic.id);
    const item = element('li');
    const row = element('div', 'topic-row');
    if (hasBranch) {
      const toggle = element('button', 'branch-toggle');
      toggle.type = 'button';
      toggle.dataset.branchId = topic.id;
      toggle.setAttribute('aria-label', `${open ? 'Collapse' : 'Expand'} ${topic.name} subtopics`);
      toggle.setAttribute('aria-expanded', String(open));
      toggle.setAttribute('aria-controls', `topic-children-${topic.id}`);
      toggle.innerHTML = chevronSvg;
      toggle.disabled = filtered;
      toggle.addEventListener('click', () => {
        if (state.expanded.has(topic.id)) state.expanded.delete(topic.id);
        else state.expanded.add(topic.id);
        renderTopics({ focusId: topic.id });
      });
      row.append(toggle);
    } else {
      row.append(element('span', 'branch-spacer'));
    }
    const selected = state.topic === topic.id;
    const button = topicButton(topic, `topic-select${selected ? ' selected' : ''}${filtered && !matches.has(topic.id) ? ' context-node' : ''}${filtered && matches.has(topic.id) ? ' topic-name-match' : ''}`);
    button.replaceChildren(element('span', 'topic-name', topic.name), element('span', 'topic-count', Number(topic.question_count).toLocaleString()));
    button.setAttribute('aria-pressed', String(selected));
    button.setAttribute('aria-label', `${topic.name}, ${Number(topic.question_count).toLocaleString()} ${topic.question_count === 1 ? 'question' : 'questions'}${children.length ? ', including subtopics' : ''}`);
    row.append(button);
    item.append(row);
    if (hasBranch) {
      const branch = element('ul');
      branch.id = `topic-children-${topic.id}`;
      branch.hidden = !open;
      for (const child of shownChildren) addTopic(child, branch);
      item.append(branch);
    }
    parent.append(item);
  }

  const roots = filtered ? state.roots.filter((topic) => visible.has(topic.id)) : state.roots.filter((topic) => letter === 'all' || letterOf(topic) === letter);
  for (const topic of roots) addTopic(topic, list);
  $('topic-tree').replaceChildren(roots.length ? list : element('p', 'quiet-message', filtered ? 'No topic names match. Try a shorter name or a different word.' : 'No topics begin with this letter.'));
  $('topic-tree').setAttribute('aria-busy', 'false');
  $('all-topics').classList.toggle('selected', state.topic === null);
  $('all-topics').setAttribute('aria-pressed', String(state.topic === null));
  const selected = state.byId.get(state.topic);
  $('mobile-topic-name').textContent = selected?.name || 'All topics';
  if (focusId !== null) $('topic-tree').querySelector(`[data-branch-id="${focusId}"]`)?.focus();
  else if (!query) revealSelectedTopic();
}

function renderBreadcrumbs() {
  const fragment = document.createDocumentFragment();
  const all = element('button', '', 'All topics');
  all.type = 'button';
  all.addEventListener('click', () => selectTopic(null));
  if (state.topic === null) {
    all.setAttribute('aria-current', 'page');
    all.disabled = true;
  }
  fragment.append(all);
  const current = state.byId.get(state.topic);
  for (const id of current?.path_ids || []) {
    const topic = state.byId.get(id);
    if (!topic) continue;
    const button = topicButton(topic, '');
    if (id === state.topic) {
      button.setAttribute('aria-current', 'page');
      button.disabled = true;
    }
    fragment.append(pathChevron(), button);
  }
  $('breadcrumbs').replaceChildren(fragment);
}

function updateUrl() {
  const url = new URL(window.location.href);
  url.search = '';
  if (state.query) url.searchParams.set('q', state.query);
  if (state.topic !== null) url.searchParams.set('topic', state.topic);
  if (state.limit !== 10) url.searchParams.set('limit', state.limit);
  if (state.offset) url.searchParams.set('offset', state.offset);
  if (url.href !== window.location.href) window.history.pushState(null, '', url);
}

function restoreUrl() {
  const params = new URL(window.location.href).searchParams;
  state.query = (params.get('q') || '').slice(0, 2000).trim();
  const topic = Number(params.get('topic'));
  state.topic = params.has('topic') && state.byId.has(topic) ? topic : null;
  const limit = Number(params.get('limit'));
  state.limit = [10, 20, 30].includes(limit) ? limit : 10;
  const offset = Number(params.get('offset'));
  state.offset = Number.isSafeInteger(offset) && offset >= 0 && offset <= 100000 ? offset : 0;
  $('search-query').value = state.query;
  $('result-limit').value = String(state.limit);
  expandSelectedPath();
}

function selectTopic(id) {
  if (!state.ready || (id !== null && !state.byId.has(id))) return;
  const hadTopicFocus = $('topic-controls').contains(document.activeElement);
  state.topic = id;
  state.query = $('search-query').value.trim();
  state.offset = 0;
  expandSelectedPath();
  updateUrl();
  renderTopics();
  if (id !== null && !$('topic-tree').querySelector('.topic-select.selected')) {
    $('topic-filter').value = '';
    $('topic-letter').value = 'all';
    renderTopics();
  }
  closeMobileTopics(hadTopicFocus);
  requestResults();
}

function excerpt(answer) {
  const flat = answer.replace(/\s+/gu, ' ').trim();
  if (flat.length <= 320) return flat;
  const end = flat.lastIndexOf(' ', 320);
  return `${flat.slice(0, end > 220 ? end : 320)}…`;
}

function renderResultTopics(result) {
  const nav = element('nav', 'answer-topics');
  nav.setAttribute('aria-label', 'Topics for this question');
  for (const [pathIndex, path] of (Array.isArray(result.topic_paths) ? result.topic_paths : []).entries()) {
    if (pathIndex) {
      const separator = element('span', '', '·');
      separator.setAttribute('aria-hidden', 'true');
      nav.append(separator);
    }
    for (const [index, sourceTopic] of (path.topics || []).entries()) {
      if (index) nav.append(pathChevron());
      const topic = state.byId.get(sourceTopic.topic_id);
      nav.append(topic ? topicButton(topic) : element('span', '', sourceTopic.name));
    }
  }
  return nav;
}

function renderResults(results) {
  const fragment = document.createDocumentFragment();
  const labels = { phrase: 'Full phrase match', all_words: 'All main words match', some_words: 'Some main words match' };
  for (const result of results) {
    const row = element('article', 'answer-row');
    row.dataset.qaId = result.qa_id;
    const meta = element('div', 'answer-meta');
    meta.append(renderResultTopics(result));
    if (labels[result.match_type]) meta.append(element('p', 'match-label', labels[result.match_type]));
    const title = element('h3', '', result.question);
    title.id = `question-${result.qa_id}`;
    row.setAttribute('aria-labelledby', title.id);
    const answerText = String(result.answer || '');
    const preview = excerpt(answerText);
    const answer = element('p', 'answer-text', preview);
    answer.id = `answer-${result.qa_id}`;
    row.append(meta, title, answer);
    const actions = element('div', 'answer-actions');
    if (preview !== answerText) {
      const expand = element('button');
      const expandLabel = element('span', '', 'Read full answer');
      const expandArrow = element('span', 'answer-arrow');
      expandArrow.innerHTML = answerArrowSvg;
      expand.append(expandLabel, expandArrow);
      expand.type = 'button';
      expand.setAttribute('aria-expanded', 'false');
      expand.setAttribute('aria-controls', answer.id);
      expand.addEventListener('click', () => {
        const open = expand.getAttribute('aria-expanded') !== 'true';
        expand.setAttribute('aria-expanded', String(open));
        expandLabel.textContent = open ? 'Show less' : 'Read full answer';
        expandArrow.hidden = open;
        answer.textContent = open ? answerText : preview;
        answer.classList.toggle('full', open);
      });
      actions.append(expand);
    }
    const publisher = result.publisher || result.citation?.publisher || 'Coptic Orthodox Diocese of the Southern United States';
    const citation = element('p', 'citation');
    citation.append(document.createTextNode('Source: '), sourceLink(result.source_url, publisher) || document.createTextNode(publisher), document.createTextNode(` · Q&A #${result.qa_id}`));
    if (actions.childElementCount) row.append(actions);
    row.append(citation);
    fragment.append(row);
  }
  $('results').replaceChildren(fragment);
}

function showEmpty() {
  const section = element('div', 'empty-state');
  section.append(element('h3', '', state.query ? 'No matches found' : 'No questions in this topic yet'));
  section.append(element('p', '', state.query ? 'Try fewer words, a different phrase, or a broader topic. You can also clear the search to browse this topic’s questions.' : 'This topic appears in the original collection, but it has no published questions in our saved collection. Explore another branch to keep browsing.'));
  const action = element('button', 'text-button', state.query ? 'Browse without a search' : 'Browse all topics');
  action.type = 'button';
  action.addEventListener('click', () => {
    if (state.query) {
      state.query = '';
      $('search-query').value = '';
      state.offset = 0;
      updateUrl();
      requestResults();
    } else selectTopic(null);
  });
  section.append(action);
  $('results').replaceChildren(section);
}

function showRequestError(message) {
  $('result-error').replaceChildren(document.createTextNode(message), document.createTextNode(' '));
  const retry = element('button', 'text-button', 'Try again');
  retry.type = 'button';
  retry.addEventListener('click', () => state.ready ? requestResults() : initialize());
  $('result-error').append(retry);
  $('result-error').hidden = false;
}

async function requestResults() {
  if (!state.ready) return;
  state.controller?.abort();
  const controller = new AbortController();
  state.controller = controller;
  const ticket = ++state.request;
  renderBreadcrumbs();
  const topic = state.byId.get(state.topic);
  const hasChildren = Boolean(state.children.get(state.topic)?.length);
  $('answers-heading').textContent = state.query ? 'Search results' : (topic?.name || 'Questions & answers');
  $('scope-description').textContent = topic ? `${state.query ? 'Searching' : 'Browsing'} ${topic.name}${hasChildren ? ' and its subtopics' : ''}.` : (state.query ? 'Searching every question, answer and topic.' : 'Browse the collection or search above.');
  $('clear-search').hidden = !state.query;
  $('result-summary').textContent = state.query ? 'Searching…' : 'Loading questions…';
  $('result-error').hidden = true;
  $('results').setAttribute('aria-busy', 'true');
  $('results').replaceChildren();
  $('pagination').hidden = true;
  const params = new URLSearchParams({ limit: String(state.limit), offset: String(state.offset) });
  if (state.query) params.set('q', state.query);
  if (state.topic !== null) params.set('topic_id', state.topic);
  try {
    const response = await fetch(`/api/qa/lexical?${params}`, { signal: controller.signal, headers: { Accept: 'application/json' } });
    if (!response.ok) {
      if (response.status === 400 || response.status === 429) {
        const problem = await response.json();
        const failure = new Error('The search could not be completed.');
        failure.userMessage = typeof problem.error === 'string' ? problem.error.slice(0, 500) : 'Please adjust the search and try again.';
        throw failure;
      }
      throw new Error('Search is temporarily unavailable. Please try again shortly.');
    }
    const data = await response.json();
    if (ticket !== state.request) return;
    state.total = Number(data.total_count) || 0;
    const results = Array.isArray(data.results) ? data.results : [];
    if (!results.length && state.total > 0 && state.offset >= state.total) {
      state.offset = Math.floor((state.total - 1) / state.limit) * state.limit;
      updateUrl();
      return requestResults();
    }
    if (results.length) renderResults(results);
    else showEmpty();
    const start = results.length ? state.offset + 1 : 0;
    const end = state.offset + results.length;
    const count = state.total.toLocaleString();
    $('result-summary').textContent = state.query ? `${count} ${state.total === 1 ? 'match' : 'matches'} for “${state.query}”${results.length ? ` · ${start.toLocaleString()}–${end.toLocaleString()} shown` : ''}` : `${count} ${state.total === 1 ? 'question' : 'questions'}${results.length ? ` · ${start.toLocaleString()}–${end.toLocaleString()} shown` : ''}`;
    $('pagination').hidden = state.total <= state.limit;
    $('previous-page').disabled = state.offset === 0;
    $('next-page').disabled = state.offset + state.limit >= state.total;
    $('page-summary').textContent = `Page ${Math.floor(state.offset / state.limit) + 1} of ${Math.max(1, Math.ceil(state.total / state.limit))}`;
  } catch (error) {
    if (error.name === 'AbortError' || ticket !== state.request) return;
    $('result-summary').textContent = error.userMessage ? 'The search could not be completed.' : 'Questions are temporarily unavailable.';
    showRequestError(error.userMessage || 'We couldn’t load the questions. Please try again.');
  } finally {
    if (ticket === state.request) $('results').setAttribute('aria-busy', 'false');
  }
}

$('search-form').addEventListener('submit', (event) => {
  event.preventDefault();
  state.query = $('search-query').value.trim();
  state.offset = 0;
  updateUrl();
  requestResults();
});
$('clear-search').addEventListener('click', () => {
  state.query = '';
  state.offset = 0;
  $('search-query').value = '';
  updateUrl();
  requestResults();
  $('search-query').focus();
});
$('all-topics').addEventListener('click', () => selectTopic(null));
$('topic-filter').addEventListener('input', () => state.ready && renderTopics());
$('topic-letter').addEventListener('change', () => {
  renderTopics();
  $('topic-tree').scrollTop = 0;
});
$('result-limit').addEventListener('change', () => {
  state.limit = Number($('result-limit').value);
  state.offset = 0;
  updateUrl();
  requestResults();
});
function changePage(direction) {
  const offset = state.offset + direction * state.limit;
  if (offset < 0 || offset >= state.total) return;
  state.offset = offset;
  updateUrl();
  requestResults();
  $('answers-heading').scrollIntoView({ block: 'start', behavior: 'instant' });
}
$('previous-page').addEventListener('click', () => changePage(-1));
$('next-page').addEventListener('click', () => changePage(1));
$('mobile-topic-toggle').addEventListener('click', () => {
  const open = $('mobile-topic-toggle').getAttribute('aria-expanded') !== 'true';
  $('mobile-topic-toggle').setAttribute('aria-expanded', String(open));
  document.querySelector('.topic-sidebar').classList.toggle('mobile-open', open);
  if (open) revealSelectedTopic();
});
window.addEventListener('popstate', () => {
  if (!state.ready) return;
  restoreUrl();
  $('topic-filter').value = '';
  $('topic-letter').value = 'all';
  renderTopics();
  closeMobileTopics();
  requestResults();
});

async function initialize() {
  $('search-submit').disabled = true;
  $('result-limit').disabled = true;
  $('result-error').hidden = true;
  try {
    const response = await fetch('/api/qa/topics', { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`Topic request failed (${response.status})`);
    const data = await response.json();
    state.topics = data.topics;
    state.byId = new Map(state.topics.map((topic) => [topic.id, topic]));
    state.children = new Map();
    state.roots = [];
    for (const topic of state.topics) {
      if (topic.parent_id === null) state.roots.push(topic);
      else {
        if (!state.children.has(topic.parent_id)) state.children.set(topic.parent_id, []);
        state.children.get(topic.parent_id).push(topic);
      }
    }
    state.roots.sort(alphabetical);
    for (const children of state.children.values()) children.sort(alphabetical);
    const letters = [...new Set(state.roots.map(letterOf))].sort();
    $('topic-letter').replaceChildren(element('option', '', 'A–Z'));
    $('topic-letter').firstElementChild.value = 'all';
    for (const letter of letters) {
      const option = element('option', '', letter);
      option.value = letter;
      $('topic-letter').append(option);
    }
    $('topic-total').textContent = `${state.topics.length.toLocaleString()} topics`;
    $('all-question-count').textContent = Number(data.question_count).toLocaleString();
    state.ready = true;
    restoreUrl();
    renderTopics();
    requestResults();
  } catch {
    $('topic-tree').replaceChildren(element('p', 'quiet-message', 'Topics are temporarily unavailable.'));
    $('topic-tree').setAttribute('aria-busy', 'false');
    $('results').setAttribute('aria-busy', 'false');
    $('result-summary').textContent = 'The collection could not be loaded.';
    showRequestError('We couldn’t load the collection. Please try again.');
  } finally {
    $('search-submit').disabled = !state.ready;
    $('result-limit').disabled = !state.ready;
  }
}

initialize();
