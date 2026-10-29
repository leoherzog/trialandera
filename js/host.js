// Host console: players, deck building from Wikipedia and typed cards, deck review, turns and reveals, and the end
// of each game. This window is the only writer of game state.

import { $, fmt, icon, fromTemplate } from './dom.js';
import { load, save, subscribe, defaultState, loadUi, saveUi, getList, putList, prune, room } from './store.js';
import * as wiki from './wiki.js';
import { formatYear, parseYear, mentionsYear } from './years.js';
import { dealable, deal, activePlayer, setPending, reveal, undo, upNext, standings } from './game.js';

const SCOREBOARD_URL = 'scoreboard.html';
const SCOREBOARD_NAME = 'trial-and-era-scoreboard';
const SCOREBOARD_FEATURES = 'popup,width=1280,height=720';
const MAX_PLAYERS = 8;
const MAX_HAND = 8;
const MIN_YEAR = -10000;
const TYPED = 'Typed';
const IMPORTED = 'Imported';
const FLAGS = ['noyear', 'leak', 'guess', 'duplicate'];
const FLAG_NAMES = { noyear: 'no year', leak: 'year in label', guess: 'loose year', duplicate: 'duplicate' };
const YEAR_FROM = { list: 'list', wikidata: 'Wikidata', typed: 'typed' };
const DECK_FORMAT = 'trial-and-era-deck';
// A drag from the hand carries this type, so text dragged in from elsewhere is never taken for a card.
const CARD_TYPE = 'application/x-trial-and-era-card';
// What may stand between a typed line's year and its label, and what is trimmed from the label's ends.
const SEPARATOR = /[\s,;:(–—-]/;
const EDGES = /^[\s,;:()–—-]+|[\s,;:()–—-]+$/g;

function defaultUi() {
  return { q: '', filter: '', view: 'all', building: null };
}

let state = load();
let ui = Object.assign(defaultUi(), loadUi());
let popupBlocked = false;
let suggestions = [];
let searchTimer = 0;
let filterTimer = 0;
let messageTimer = 0;
const controllers = { search: new AbortController(), build: new AbortController() };
// What the deck table, hand and strip last drew, so a render that changes none of their rows updates them in place
// and keeps focus and any text being typed.
const shown = { deck: null, match: null, matches: 0, sources: null, hand: null, strip: null, scroll: null };
const names = new Intl.ListFormat('en', { style: 'long', type: 'conjunction' });
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

/**
 * Abort the running request of one kind and start tracking its replacement.
 * @param {string} key 'search' or 'build'
 * @returns {AbortController}
 */
function restart(key) {
  controllers[key].abort();
  controllers[key] = new AbortController();
  return controllers[key];
}

/**
 * Save the state, then render it. A failed save puts up a message, which callers must not replace with a report.
 * @returns {boolean} whether the save worked
 */
function commit() {
  let saved = true;
  try {
    save(state);
  } catch (err) {
    saved = false;
    console.log('Could not save game state', err);
    showMessage('Could not save the game, so the scoreboard will not show this change and a reload will lose it: ' +
      err.message);
  }
  render();
  return saved;
}

// The status region stays in the page so screen readers announce what is put into it.
function showMessage(text) {
  const box = document.createElement('article');
  box.append(icon('circle-info'), ' ' + text);
  $('message').replaceChildren(box);
  clearTimeout(messageTimer);
  messageTimer = setTimeout(function () { $('message').replaceChildren(); }, 8000);
}

// A table row; each cell is a <td> or <th>, or text or a node to put in a new <td>.
function row(cells) {
  const tr = document.createElement('tr');
  cells.forEach(function (cell) {
    if (cell instanceof HTMLTableCellElement) tr.append(cell);
    else tr.insertCell().append(cell);
  });
  return tr;
}

function rowHeader(...content) {
  const th = document.createElement('th');
  th.scope = 'row';
  th.append(...content);
  return th;
}

function plural(n, word) {
  return fmt.format(n) + ' ' + word + (n === 1 ? '' : 's');
}

function playerName(id) {
  const player = state.players.find(function (p) { return p.id === id; });
  return player ? player.name : 'Player ' + id;
}

// ---------- Scoreboard window ----------

function openScoreboard() {
  const win = window.open(SCOREBOARD_URL, SCOREBOARD_NAME, SCOREBOARD_FEATURES);
  popupBlocked = !win;
  if (popupBlocked) showMessage('The scoreboard popup was blocked. Use "Open scoreboard" to open it.');
  renderHeader();
}

function renderHeader() {
  $('open-scoreboard').hidden = state.phase === 'lobby' && !popupBlocked;
}

// ---------- Lobby ----------

function renderLobby() {
  const last = state.players.length - 1;
  $('player-list').replaceChildren(...state.players.map(function (player, i) {
    const tr = fromTemplate('tpl-player-row');
    tr.dataset.index = String(i);
    tr.cells[0].append(' ' + (i + 1) + '. ' + player.name);
    tr.querySelectorAll('button').forEach(function (button) {
      button.setAttribute('aria-label', button.getAttribute('aria-label') + ': ' + player.name);
    });
    tr.querySelector('[data-act="up"]').disabled = i === 0;
    tr.querySelector('[data-act="down"]').disabled = i === last;
    return tr;
  }));
  const full = state.players.length >= MAX_PLAYERS;
  const form = $('add-player');
  form.querySelector('fieldset').disabled = full;
  form.elements.name.placeholder = full ? 'Eight players maximum' : 'Player name';
  $('start-game').disabled = state.players.length === 0;
}

function playerAction(act, i) {
  const players = state.players;
  if (act === 'remove') {
    players.splice(i, 1);
    commit();
    $('add-player').elements.name.focus();
    return;
  }
  const to = act === 'up' ? Math.max(i - 1, 0) : Math.min(i + 1, players.length - 1);
  players.splice(to, 0, players.splice(i, 1)[0]);
  commit();
  // A row moved to either end has that direction's button disabled, so focus goes to the other one.
  const moved = $('player-list').rows[to];
  const same = moved.querySelector('[data-act="' + act + '"]');
  (same.disabled ? moved.querySelector('[data-act="' + (act === 'up' ? 'down' : 'up') + '"]') : same).focus();
}

$('player-list').addEventListener('click', function (event) {
  const button = event.target.closest('button[data-act]');
  if (button) playerAction(button.dataset.act, Number(button.closest('tr').dataset.index));
});

$('add-player').addEventListener('submit', function (event) {
  event.preventDefault();
  const input = event.target.elements.name;
  const name = input.value.trim();
  if (!name || state.players.length >= MAX_PLAYERS) return;
  state.players.push({ id: state.nextId++, name: name });
  input.value = '';
  commit();
  // A full lobby disables the input, so focus moves on to starting the game.
  (input.matches(':disabled') ? $('start-game') : input).focus();
});

$('start-game').addEventListener('click', function () {
  if (!state.players.length) return;
  openScoreboard();
  state.phase = 'setup';
  commit();
  $('source-form').elements.q.focus();
});

$('open-scoreboard').addEventListener('click', openScoreboard);

// ---------- Page search and list build ----------

function renderSetup() {
  const input = $('source-form').elements.q;
  if (document.activeElement !== input) input.value = ui.q;
  $('build').hidden = !ui.building;
  renderSuggestions();
  renderSources();
  renderDeal();
  renderDeck();
}

function renderSuggestions() {
  $('suggestions').replaceChildren(...suggestions.map(function (title) { return new Option('', title); }));
}

function looksLikeUrl(text) {
  return /^https?:\/\//i.test(text);
}

async function runSuggest() {
  const text = ui.q.trim();
  const controller = restart('search');
  if (!text || looksLikeUrl(text)) {
    suggestions = [];
    renderSuggestions();
    return;
  }
  try {
    const titles = await wiki.search(text, controller.signal);
    if (controller.signal.aborted) return;
    suggestions = titles;
    renderSuggestions();
  } catch (err) {
    if (!controller.signal.aborted) console.log('Suggestion search failed', err);
  }
}

$('source-form').elements.q.addEventListener('input', function (event) {
  ui.q = event.target.value;
  clearTimeout(searchTimer);
  // Picking a datalist option replaces the text instead of typing it; some browsers send a plain Event.
  const picked = event.inputType === 'insertReplacementText' || event.inputType === undefined;
  if (picked && suggestions.indexOf(ui.q) !== -1) {
    chooseSource(ui.q);
    return;
  }
  searchTimer = setTimeout(runSuggest, 300);
});

$('source-form').elements.q.addEventListener('change', function () {
  saveUi(ui);
});

$('source-form').addEventListener('submit', function (event) {
  event.preventDefault();
  const text = event.target.elements.q.value.trim();
  if (!text) return;
  let title;
  try {
    title = wiki.titleFromUrl(text) || text;
  } catch (err) {
    showMessage(err.message);
    return;
  }
  chooseSource(title);
});

function chooseSource(title) {
  clearTimeout(searchTimer);
  controllers.search.abort();
  suggestions = [];
  renderSuggestions();
  ui.building = { title: title };
  saveUi(ui);
  startBuild();
}

function setProgress(title, label, done, total) {
  const progress = $('build-progress');
  if (total > 0) {
    progress.max = total;
    progress.value = done;
    $('build-label').textContent = 'Building ' + title + ' · ' + label + ': ' + done + ' of ' + total;
  } else {
    progress.removeAttribute('value');
    $('build-label').textContent = 'Building ' + title + ' · ' + label;
  }
}

async function startBuild() {
  const job = ui.building;
  if (!job) return;
  const controller = restart('build');
  $('build').hidden = false;
  setProgress(job.title, 'Starting', 0, 0);
  try {
    const list = getList(job.title) || await wiki.buildCards(job.title, function (label, done, total) {
      setProgress(job.title, label, done, total);
    }, controller.signal, getList);
    putList(list);
    if (controller !== controllers.build || state.phase !== 'setup') return;
    ui.building = null;
    ui.q = '';
    saveUi(ui);
    const source = addSource({ name: list.title, title: list.title, labelMode: list.labelMode });
    const result = mergeCards([[source, list.cards]]);
    if (commit()) showMessage(mergeReport(result, list.title));
  } catch (err) {
    if (controller.signal.aborted) return;
    console.log('List build failed', err);
    showMessage('Could not build cards from "' + job.title + '": ' + err.message);
    ui.building = null;
    saveUi(ui);
    $('build').hidden = true;
  }
}

// ---------- Deck model ----------

function fold(text) {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function clean(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function validYear(value) {
  return Number.isInteger(value) && value !== 0 && value >= MIN_YEAR && value <= new Date().getFullYear()
    ? value : null;
}

function findCard(id) {
  return state.deck.cards.find(function (card) { return card.id === id; }) || null;
}

function findSource(name) {
  return state.deck.sources.find(function (source) { return source.name === name; }) || null;
}

/**
 * The deck's source with this name, added first when missing. An existing source keeps its label mode.
 * @param {{name: string, title: string|null, labelMode: string}} info
 * @returns {object} the Source in state
 */
function addSource(info) {
  let source = findSource(info.name);
  if (!source) {
    source = { name: info.name, title: info.title, labelMode: info.labelMode === 'link' ? 'link' : 'text' };
    state.deck.sources.push(source);
  }
  return source;
}

function builtLabel(card, source) {
  return source && source.labelMode === 'link' ? card.linkLabel : card.textLabel;
}

function setFlag(card, flag, on) {
  if (on === card.flags.includes(flag)) return;
  card.flags = FLAGS.filter(function (f) { return f === flag ? on : card.flags.includes(f); });
}

// Cards flagged noyear or leak are left out of the deck until the host includes them.
function blocked(card) {
  return card.flags.includes('noyear') || card.flags.includes('leak');
}

function refreshFlags(card) {
  setFlag(card, 'noyear', card.year === null);
  setFlag(card, 'leak', card.year !== null && mentionsYear(card.label, card.year));
}

/**
 * Change a card's label or year, then update its flags. An edit that sets noyear or leak excludes the card, and one
 * that clears them includes it again unless the host unchecked it; the host can still override with the checkbox.
 * @param {object} card
 * @param {function(object)} change
 */
function editCard(card, change) {
  const was = blocked(card);
  change(card);
  refreshFlags(card);
  if (blocked(card) !== was && !card.excludedByHost) card.include = was;
}

// Only article-title cards compare articles: entry-text cards often share a first link, such as an inventor, while
// describing different events.
function dupKeys(card) {
  const keys = [];
  const source = findSource(card.source);
  if (card.title && source && source.labelMode === 'link') keys.push('t:' + card.title);
  const label = fold(card.label);
  if (label) keys.push('l:' + label);
  return keys;
}

// A card is a duplicate when another included card shows the same label, or links the same article where both
// show article titles.
function markDuplicates() {
  const counts = new Map();
  state.deck.cards.forEach(function (card) {
    if (card.include) dupKeys(card).forEach(function (key) { counts.set(key, (counts.get(key) || 0) + 1); });
  });
  state.deck.cards.forEach(function (card) {
    const self = card.include ? 1 : 0;
    setFlag(card, 'duplicate', dupKeys(card).some(function (key) { return counts.get(key) - self > 0; }));
  });
}

// Merging skips a card that shares a duplicate key and its year with a card already there, so entry-text cards
// that share a first link stay apart, as they do for the duplicate flag.
function cardKeys(card) {
  return dupKeys(card).map(function (key) { return key + '|' + card.year; });
}

/**
 * A deck card from a built, typed or imported candidate, without an id. Include defaults to off for noyear and
 * leak cards unless the candidate says otherwise.
 * @param {object} source the Source it joins
 * @param {object} c candidate with Card fields
 * @returns {object|null} null when the candidate has no label
 */
function makeCard(source, c) {
  const label = clean(c.label) || clean(c.textLabel) || clean(c.linkLabel) || clean(c.title);
  if (!label) return null;
  const year = validYear(c.year);
  const card = {
    id: 0,
    source: source.name,
    title: clean(c.title) || null,
    linkLabel: clean(c.linkLabel) || label,
    textLabel: clean(c.textLabel) || label,
    label: label,
    labelEdited: c.labelEdited === true,
    year: year,
    yearFrom: year === null ? null : Object.hasOwn(YEAR_FROM, c.yearFrom) ? c.yearFrom : 'typed',
    description: clean(c.description),
    context: clean(c.context),
    include: true,
    excludedByHost: false,
    flags: year !== null && Array.isArray(c.flags) && c.flags.includes('guess') ? ['guess'] : []
  };
  if (!card.labelEdited && source.title) card.label = builtLabel(card, source);
  refreshFlags(card);
  card.include = typeof c.include === 'boolean' ? c.include : !blocked(card);
  card.excludedByHost = !card.include && c.excludedByHost === true;
  return card;
}

/**
 * Add candidates to the deck, skipping repeats of cards already there or earlier in the batch. Each group's Source
 * must already be in the deck.
 * @param {Array<[object, Array<object>]>} groups pairs of a Source and the candidates that join it
 * @returns {{added: Array<object>, skipped: number, invalid: number}}
 */
function mergeCards(groups) {
  const deck = state.deck;
  const seen = new Set(deck.cards.flatMap(cardKeys));
  const result = { added: [], skipped: 0, invalid: 0 };
  groups.forEach(function ([source, candidates]) {
    candidates.forEach(function (candidate) {
      const card = candidate && typeof candidate === 'object' ? makeCard(source, candidate) : null;
      if (!card) {
        result.invalid++;
        return;
      }
      const keys = cardKeys(card);
      if (keys.some(function (key) { return seen.has(key); })) {
        result.skipped++;
        return;
      }
      keys.forEach(function (key) { seen.add(key); });
      card.id = deck.nextCardId++;
      deck.cards.push(card);
      result.added.push(card);
    });
  });
  markDuplicates();
  return result;
}

// "Added 40 cards from X. 2 were already in the deck. 3 start excluded: 2 need a year, 1 shows its year."
function mergeReport(result, from) {
  const parts = ['Added ' + plural(result.added.length, 'card') + (from ? ' from ' + from : '') + '.'];
  if (result.skipped) parts.push(fmt.format(result.skipped) + (result.skipped === 1 ? ' was' : ' were') +
    ' already in the deck.');
  if (result.invalid) parts.push(fmt.format(result.invalid) + ' had no label.');
  const noyear = result.added.filter(function (c) { return c.flags.includes('noyear'); }).length;
  const leak = result.added.filter(function (c) { return c.flags.includes('leak'); }).length;
  const out = result.added.filter(function (c) { return !c.include; }).length;
  if (out) {
    const why = [];
    if (noyear) why.push(fmt.format(noyear) + (noyear === 1 ? ' needs a year' : ' need a year'));
    if (leak) why.push(fmt.format(leak) + (leak === 1 ? ' shows its year' : ' show their year') + ' in the label');
    parts.push(fmt.format(out) + (out === 1 ? ' starts' : ' start') + ' excluded' +
      (why.length ? ': ' + why.join(', ') : '') + '.');
  }
  return parts.join(' ');
}

// ---------- Sources ----------

function renderSources() {
  const sources = state.deck.sources;
  const table = $('sources');
  table.hidden = !sources.length;
  const counts = new Map(sources.map(function (s) { return [s.name, { all: 0, included: 0 }]; }));
  state.deck.cards.forEach(function (card) {
    const count = counts.get(card.source);
    if (!count) return;
    count.all++;
    if (card.include) count.included++;
  });
  const key = sources.map(function (s) { return s.name; }).join('\n');
  const body = table.tBodies[0];
  if (key !== shown.sources) {
    shown.sources = key;
    body.replaceChildren(...sources.map(function (source, i) {
      const tr = fromTemplate('tpl-source-row');
      tr.dataset.index = String(i);
      tr.cells[0].append(source.title ? articleLink(source.title, source.name) : source.name);
      const select = tr.querySelector('select');
      select.setAttribute('aria-label', 'Labels for ' + source.name);
      select.disabled = !source.title;
      tr.querySelector('button').setAttribute('aria-label', 'Remove ' + source.name);
      return tr;
    }));
  }
  Array.from(body.rows).forEach(function (tr, i) {
    const source = sources[i];
    const count = counts.get(source.name);
    tr.cells[1].textContent = plural(count.all, 'card') + ' · ' + fmt.format(count.included) + ' included';
    tr.querySelector('select').value = source.labelMode;
  });
}

// A link that opens an English Wikipedia article in a new tab.
function articleLink(title, text) {
  const link = document.createElement('a');
  link.href = 'https://en.wikipedia.org/wiki/' + encodeURIComponent(title.replace(/ /g, '_'));
  link.target = '_blank';
  link.rel = 'noopener';
  link.textContent = text;
  return link;
}

$('sources').tBodies[0].addEventListener('change', function (event) {
  const source = state.deck.sources[Number(event.target.closest('tr').dataset.index)];
  if (!source || event.target.tagName !== 'SELECT') return;
  source.labelMode = event.target.value === 'link' ? 'link' : 'text';
  state.deck.cards.forEach(function (card) {
    if (card.source !== source.name || card.labelEdited) return;
    editCard(card, function (c) { c.label = builtLabel(c, source); });
  });
  markDuplicates();
  commit();
});

$('sources').tBodies[0].addEventListener('click', function (event) {
  const button = event.target.closest('button');
  if (!button) return;
  const deck = state.deck;
  const source = deck.sources[Number(button.closest('tr').dataset.index)];
  if (!source) return;
  const before = deck.cards.length;
  deck.cards = deck.cards.filter(function (card) { return card.source !== source.name; });
  deck.sources = deck.sources.filter(function (s) { return s !== source; });
  markDuplicates();
  if (commit()) showMessage('Removed ' + source.name + ' and its ' + plural(before - deck.cards.length, 'card') + '.');
  $('source-form').elements.q.focus();
});

// ---------- Typed cards ----------

function typedSource() {
  return addSource({ name: TYPED, title: null, labelMode: 'text' });
}

$('card-form').addEventListener('submit', function (event) {
  event.preventDefault();
  const form = event.target;
  const label = clean(form.elements.label.value);
  const year = parseYear(form.elements.year.value);
  if (!label || year === null) {
    form.elements.year.setAttribute('aria-invalid', 'true');
    showMessage('Could not read "' + form.elements.year.value.trim() + '" as a year. Try 1876, 500 BC or AD 79.');
    form.elements.year.focus();
    return;
  }
  const result = mergeCards([[typedSource(), [{ label: label, year: year, yearFrom: 'typed' }]]]);
  form.elements.year.removeAttribute('aria-invalid');
  form.reset();
  if (commit()) {
    showMessage(result.added.length ? mergeReport(result)
      : label + ' (' + formatYear(year) + ') is already in the deck.');
  }
  form.elements.label.focus();
});

/**
 * Year at the start or end of a typed line, with the rest as the label. A year at the end wins when both ends
 * read as one, as in "2001: A Space Odyssey, 1968". A bare number under 1000 needs an era.
 * @param {string} line
 * @returns {{label: string, year: number}|null}
 */
function parseLine(line) {
  const text = clean(line);
  for (let i = 1; i < text.length; i++) {
    if (!SEPARATOR.test(text[i - 1])) continue;
    const found = lineYear(text.slice(i).replace(/\)$/, ''));
    const label = text.slice(0, i).replace(EDGES, '');
    if (found !== null && label) return { label: label, year: found };
  }
  for (let i = text.length - 1; i > 0; i--) {
    if (!SEPARATOR.test(text[i])) continue;
    const found = lineYear(text.slice(0, i));
    const label = text.slice(i).replace(EDGES, '');
    if (found !== null && label) return { label: label, year: found };
  }
  return null;
}

function lineYear(text) {
  const trimmed = text.trim();
  const year = parseYear(trimmed);
  if (year === null || (/^\d+$/.test(trimmed) && year < 1000)) return null;
  return year;
}

$('bulk-form').addEventListener('submit', function (event) {
  event.preventDefault();
  const area = event.target.elements.lines;
  const cards = [];
  const failed = [];
  area.value.split('\n').forEach(function (line) {
    if (!line.trim()) return;
    const parsed = parseLine(line);
    if (parsed) cards.push({ label: parsed.label, year: parsed.year, yearFrom: 'typed' });
    else failed.push(line.trim());
  });
  if (!cards.length && !failed.length) return;
  const result = mergeCards([[typedSource(), cards]]);
  area.value = failed.join('\n');
  if (failed.length) area.setAttribute('aria-invalid', 'true');
  else area.removeAttribute('aria-invalid');
  if (commit()) {
    showMessage(mergeReport(result) + (failed.length
      ? ' ' + plural(failed.length, 'line') + ' had no year at the start or end and stayed in the box.' : ''));
  }
  area.focus();
});

// ---------- Deck table ----------

const VIEWS = {
  all: function () { return true; },
  included: function (card) { return card.include; },
  excluded: function (card) { return !card.include; },
  noyear: function (card) { return card.year === null; },
  flagged: function (card) { return card.flags.length > 0; }
};

function cardMatches(card, query) {
  if (!query) return true;
  return [card.label, card.title || '', card.description, card.context, formatYear(card.year), card.source]
    .some(function (text) { return fold(text).includes(query); });
}

function appendNote(cell, ...content) {
  const small = document.createElement('small');
  small.append(...content);
  cell.append(document.createElement('br'), small);
}

function buildDeckRow(card) {
  const tr = fromTemplate('tpl-deck-row');
  tr.dataset.id = String(card.id);
  const cell = tr.cells[1];
  const about = [card.source];
  if (card.title) about.push(' · ', articleLink(card.title, card.title));
  if (card.description) about.push(' · ' + card.description);
  appendNote(cell, ...about);
  if (card.context && card.context !== card.label) appendNote(cell, card.context);
  fillDeckRow(tr, card);
  return tr;
}

// Inputs keep what the host is typing; the year input keeps unreadable text until the card's year changes.
function fillDeckRow(tr, card) {
  const box = tr.querySelector('[data-field=include]');
  box.checked = card.include;
  box.setAttribute('aria-label', 'Include ' + card.label);
  const label = tr.querySelector('[data-field=label]');
  if (label !== document.activeElement) label.value = card.label;
  label.setAttribute('aria-label', 'Label' + (card.title ? ' for ' + card.title : ''));
  const year = tr.querySelector('[data-field=year]');
  if (year !== document.activeElement && year.dataset.year !== String(card.year)) {
    year.value = formatYear(card.year);
    year.removeAttribute('aria-invalid');
  }
  year.dataset.year = String(card.year);
  year.setAttribute('aria-label', 'Year of ' + card.label);
  tr.cells[3].textContent = YEAR_FROM[card.yearFrom] || '—';
  tr.cells[4].textContent = card.flags.map(function (f) { return FLAG_NAMES[f]; }).join(', ');
}

/**
 * Draw the deck table: a row for every card, hidden unless it matches the view and filter. Matches change only when
 * the filter, view or set of cards does, so a row never vanishes while the host is working in it.
 */
function renderDeck() {
  const deck = state.deck;
  const filter = $('deck-filter');
  if (document.activeElement !== filter) filter.value = ui.filter;
  if (!Object.hasOwn(VIEWS, ui.view)) ui.view = 'all';
  $('deck-view').value = ui.view;
  const body = $('deck-table').tBodies[0];
  const ids = deck.cards.map(function (c) { return c.id; }).join(',');
  const focused = document.activeElement;
  if (ids !== shown.deck && body.contains(focused)) {
    // Removing a focused input fires its change event after the new rows are drawn, so the rows would miss the
    // edit. Blurring commits it first, and that commit's render may redraw the table itself.
    const start = focused.selectionStart;
    const end = focused.selectionEnd;
    focused.blur();
    renderDeck();
    const twin = body.querySelector('tr[data-id="' + focused.closest('tr').dataset.id + '"]:not([hidden]) ' +
      '[data-field="' + focused.dataset.field + '"]');
    if (twin) {
      twin.focus();
      if (twin.type === 'text') twin.setSelectionRange(start, end);
    }
    return;
  }
  const byId = new Map(deck.cards.map(function (card) { return [card.id, card]; }));
  if (ids !== shown.deck) {
    shown.deck = ids;
    shown.match = null;
    const empty = row([deck.cards.length ? 'No cards match the filter.'
      : 'No cards yet. Build some from a Wikipedia page or type them.']);
    empty.cells[0].colSpan = 5;
    body.replaceChildren(...deck.cards.map(buildDeckRow), empty);
  } else {
    body.querySelectorAll('tr[data-id]').forEach(function (tr) { fillDeckRow(tr, byId.get(Number(tr.dataset.id))); });
  }
  // Hiding rows that are already drawn is far cheaper than drawing them again for each key typed in the filter.
  const match = ui.view + '\n' + ui.filter;
  if (match !== shown.match) {
    shown.match = match;
    const query = fold(ui.filter);
    shown.matches = 0;
    body.querySelectorAll('tr[data-id]').forEach(function (tr) {
      const card = byId.get(Number(tr.dataset.id));
      tr.hidden = !(VIEWS[ui.view](card) && cardMatches(card, query));
      if (!tr.hidden) shown.matches++;
    });
    body.querySelector('tr:not([data-id])').hidden = shown.matches > 0;
  }
  const included = deck.cards.filter(function (c) { return c.include; }).length;
  const ready = dealable(state).cards.length;
  const flagged = deck.cards.filter(function (c) { return c.flags.length; }).length;
  $('deck-meta').textContent = plural(deck.cards.length, 'card') + ' · ' + fmt.format(included) + ' included · ' +
    fmt.format(ready) + ' ready to deal · ' + fmt.format(flagged) + ' flagged · showing ' +
    fmt.format(shown.matches);
  $('export-deck').disabled = !deck.cards.length;
  $('clear-deck').disabled = !deck.cards.length && !deck.sources.length;
}

$('deck-table').tBodies[0].addEventListener('change', function (event) {
  const input = event.target;
  const field = input.dataset.field;
  const card = field ? findCard(Number(input.closest('tr').dataset.id)) : null;
  if (!card) return;
  if (field === 'include') {
    card.include = input.checked;
    card.excludedByHost = !input.checked;
  } else if (field === 'label') {
    const text = clean(input.value);
    editCard(card, function (c) {
      c.labelEdited = text !== '' && text !== builtLabel(c, findSource(c.source));
      c.label = text || builtLabel(c, findSource(c.source));
    });
    input.value = card.label;
  } else if (field === 'year') {
    const text = input.value.trim();
    const year = text ? parseYear(text) : null;
    editCard(card, function (c) {
      c.year = year;
      c.yearFrom = year === null ? null : 'typed';
      setFlag(c, 'guess', false);
    });
    input.dataset.year = String(year);
    if (text && year === null) {
      input.setAttribute('aria-invalid', 'true');
      showMessage('Could not read "' + text + '" as a year, so ' + card.label +
        ' has none for now. Try 1876, 500 BC or AD 79.');
    } else {
      input.removeAttribute('aria-invalid');
      input.value = formatYear(year);
    }
  }
  markDuplicates();
  commit();
});

// Filtering a large deck can outlast the gap between keystrokes, so it waits for a pause in typing.
$('deck-filter').addEventListener('input', function (event) {
  ui.filter = event.target.value;
  clearTimeout(filterTimer);
  filterTimer = setTimeout(renderDeck, 150);
});

$('deck-filter').addEventListener('change', function () {
  saveUi(ui);
});

$('deck-view').addEventListener('change', function (event) {
  ui.view = event.target.value;
  saveUi(ui);
  renderDeck();
});

// ---------- Deck files ----------

$('export-deck').addEventListener('click', function () {
  const deck = state.deck;
  const data = {
    format: DECK_FORMAT,
    version: 1,
    sources: deck.sources,
    cards: deck.cards.map(function (card) {
      const { id, ...rest } = card;
      return rest;
    })
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'trial-and-era-deck.json';
  document.body.append(link);
  link.click();
  link.remove();
  // Revoking at once can cancel the download in some browsers.
  setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
});

/**
 * Merge an exported deck file into the deck. Cards keep their include setting and their source's label mode;
 * a source already in the deck keeps its own.
 * @param {object|Array<object>} data a deck export, or a bare array of cards
 * @returns {{added: Array<object>, skipped: number, invalid: number}}
 */
function importDeck(data) {
  const cards = Array.isArray(data) ? data : data && Array.isArray(data.cards) ? data.cards : null;
  if (!cards) throw new Error('it is not a deck file');
  const infos = new Map();
  (Array.isArray(data.sources) ? data.sources : []).forEach(function (s) {
    if (s && clean(s.name)) infos.set(clean(s.name), s);
  });
  const groups = new Map();
  cards.forEach(function (card) {
    const name = (card && clean(card.source)) || IMPORTED;
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(card);
  });
  return mergeCards(Array.from(groups, function ([name, list]) {
    const info = infos.get(name) || {};
    return [addSource({ name: name, title: clean(info.title) || null, labelMode: info.labelMode }), list];
  }));
}

$('import-deck').addEventListener('change', async function (event) {
  const input = event.target;
  const file = input.files[0];
  if (!file) return;
  try {
    const result = importDeck(JSON.parse(await file.text()));
    if (commit()) showMessage(mergeReport(result, file.name));
  } catch (err) {
    console.log('Deck import failed', err);
    showMessage('Could not import ' + file.name + ': ' + err.message);
  }
  // Clearing the input lets the same file be imported again.
  input.value = '';
});

// The Clear deck button opens this dialog through its command attributes.
$('confirm-clear').addEventListener('close', function (event) {
  const dialog = event.target;
  const confirmed = dialog.returnValue === 'confirm';
  dialog.returnValue = '';
  if (!confirmed) return;
  state.deck = { cards: [], sources: [], nextCardId: state.deck.nextCardId };
  commit();
  $('source-form').elements.q.focus();
});

// ---------- Deal ----------

/**
 * Why the deck cannot be dealt, or '' when it can.
 * @returns {string}
 */
function dealBlocker() {
  const ready = dealable(state);
  if (ready.cards.length >= ready.needed) return '';
  return 'Include or add ' + plural(ready.needed - ready.cards.length, 'more card') + ' with a year.';
}

/**
 * Whether the state, once dealt from these cards, would likely fill browser storage during play. Counts the deck and
 * the game as dealt, and leaves a tenth of the room for the log and undo history that play adds.
 * @param {Array<object>} cards the dealable cards
 * @returns {boolean}
 */
function tooBigToPlay(cards) {
  const snapshot = {};
  cards.forEach(function (card) { snapshot[card.id] = { id: card.id, label: card.label, year: card.year }; });
  // Each id also sits once in the draw pile, a hand or the timeline.
  const piles = cards.reduce(function (n, card) { return n + String(card.id).length + 1; }, 0);
  return JSON.stringify(state).length + JSON.stringify(snapshot).length + piles > room() * 0.9;
}

function renderDeal() {
  const form = $('deal-form');
  // A build or another window can render while the host is typing a hand size; Enter must deal what they typed.
  if (document.activeElement !== form.elements.handSize) form.elements.handSize.value = String(state.settings.handSize);
  const ready = dealable(state);
  const count = state.players.length;
  const blocker = dealBlocker();
  $('deal-summary').textContent = names.format(state.players.map(function (p) { return p.name; })) + ': ' +
    plural(count, 'player') + ' × ' + plural(state.settings.handSize, 'card') + ', plus 1 to start the timeline, ' +
    'needs ' + plural(ready.needed, 'card') + ' with a year. The deck has ' + fmt.format(ready.cards.length) + '.' +
    (blocker ? ' ' + blocker : '') +
    (tooBigToPlay(ready.cards) ? ' The deck may be too big for browser storage once dealt, and then the ' +
      'scoreboard would stop following the game. Removing a source or excluding cards makes room.' : '');
  $('deal').disabled = !!blocker;
}

function readHandSize() {
  const n = Number($('deal-form').elements.handSize.value);
  if (Number.isInteger(n) && n >= 1 && n <= MAX_HAND) state.settings.handSize = n;
}

// Enter in the hand size field submits the form before its change event, so submit reads the field too.
$('deal-form').elements.handSize.addEventListener('change', function (event) {
  readHandSize();
  commit();
  event.target.value = String(state.settings.handSize);
});

$('deal-form').addEventListener('submit', function (event) {
  event.preventDefault();
  readHandSize();
  startGame();
});

function startGame() {
  try {
    deal(state);
  } catch (err) {
    showMessage(err.message);
    render();
    return;
  }
  controllers.build.abort();
  ui.building = null;
  saveUi(ui);
  console.log('Dealt game ' + state.game.number);
  commit();
  focusHand();
}

// ---------- Play ----------

function cardText(game, id) {
  const card = game.cards[id];
  return card.label + ' (' + formatYear(card.year) + ')';
}

function gapLabel(game, i) {
  const line = game.timeline;
  if (i === 0) return 'Place before ' + cardText(game, line[0]);
  if (i === line.length) return 'Place after ' + cardText(game, line[i - 1]);
  return 'Place between ' + cardText(game, line[i - 1]) + ' and ' + cardText(game, line[i]);
}

// The card the latest placement added to the timeline, or null when it was wrong.
function latestCard(game) {
  const last = game.log[game.log.length - 1];
  return last && last.correct ? last.cardId : null;
}

function renderPlay() {
  const game = state.game;
  const active = activePlayer(game);
  $('round-title').textContent = (game.suddenDeath ? 'Sudden death · round ' : 'Round ') + game.round;
  $('round-meta').textContent = 'Game ' + game.number + ' · ' + plural(game.draw.length, 'card') +
    ' in the draw pile · ' + fmt.format(game.discard.length) + ' discarded · ' +
    plural(game.timeline.length, 'card') + ' in the timeline';
  const hand = game.hands[active] || [];
  $('turn-name').textContent = 'Now playing: ' + playerName(active);
  const next = upNext(game, 3).map(playerName);
  $('turn-detail').textContent = plural(hand.length, 'card') + ' in hand' +
    (next.length ? ' · then ' + next.join(', ') : '');
  renderHand(game, active);
  renderStrip(game);
  $('reveal').disabled = game.pending.cardId === null || game.pending.index === null;
  $('undo').disabled = !game.history.length;
  const summary = resultText(game, active);
  const result = $('result');
  // Rewriting identical text would make screen readers repeat it on every render.
  if (result.dataset.text !== summary.text) {
    result.dataset.text = summary.text;
    result.replaceChildren(icon(summary.icon), ' ' + summary.text);
  }
  renderPlayerTable(game, active);
  scrollStrip(game);
}

function renderHand(game, active) {
  const ids = game.hands[active] || [];
  const fieldset = $('hand');
  const key = active + '\n' + ids.map(function (id) {
    return id + ':' + game.cards[id].label + ':' + (game.cards[id].description || '');
  }).join('\n');
  if (key !== shown.hand) {
    shown.hand = key;
    $('hand-legend').textContent = playerName(active) + '\'s hand';
    fieldset.replaceChildren($('hand-legend'), ...ids.map(function (id) {
      const label = fromTemplate('tpl-hand-card');
      label.dataset.card = String(id);
      label.firstElementChild.value = String(id);
      label.append(game.cards[id].label);
      if (game.cards[id].description) {
        const about = document.createElement('small');
        about.textContent = game.cards[id].description;
        label.append(about);
      }
      return label;
    }));
  }
  fieldset.querySelectorAll('input').forEach(function (input) {
    input.checked = Number(input.value) === game.pending.cardId;
  });
}

function gapContent(game, on) {
  if (!on) return [icon('plus')];
  if (game.pending.cardId === null) return [icon('location-dot')];
  return [icon('arrow-down'), ' ' + game.cards[game.pending.cardId].label];
}

function renderStrip(game) {
  const strip = $('strip');
  const key = game.number + '\n' + game.timeline.map(function (id) { return cardText(game, id); }).join('\n');
  if (key !== shown.strip) {
    shown.strip = key;
    const nodes = [];
    game.timeline.forEach(function (id, i) {
      nodes.push(gapButton(game, i));
      const article = fromTemplate('tpl-timeline-card');
      article.dataset.card = String(id);
      article.querySelector('small').textContent = game.cards[id].label;
      article.querySelector('strong').textContent = formatYear(game.cards[id].year);
      nodes.push(article);
    });
    nodes.push(gapButton(game, game.timeline.length));
    strip.replaceChildren(...nodes);
  }
  // One gap is in the tab order: the focused one, else the pending one, else the first. Arrow keys move along.
  const focused = strip.contains(document.activeElement) ? document.activeElement : null;
  const pending = game.pending.index;
  const home = focused ? Number(focused.dataset.gap) : pending ?? 0;
  strip.querySelectorAll('button[data-gap]').forEach(function (button) {
    const i = Number(button.dataset.gap);
    const on = pending === i;
    button.setAttribute('aria-pressed', String(on));
    button.className = on ? '' : 'secondary outline';
    button.tabIndex = i === home ? 0 : -1;
    const content = on + ':' + game.pending.cardId;
    if (button.dataset.content !== content) {
      button.dataset.content = content;
      button.replaceChildren(...gapContent(game, on));
    }
  });
  const latest = latestCard(game);
  strip.querySelectorAll('article').forEach(function (article) {
    article.toggleAttribute('data-latest', Number(article.dataset.card) === latest);
  });
}

function gapButton(game, i) {
  const button = fromTemplate('tpl-gap');
  button.dataset.gap = String(i);
  button.setAttribute('aria-label', gapLabel(game, i));
  return button;
}

// Center the pending gap, or else the card just placed, whenever either changes. The scroll waits a frame because
// Font Awesome swaps the gaps' icon spans for wider SVGs after this render, which moves every card.
function scrollStrip(game) {
  const strip = $('strip');
  const pending = game.pending.index;
  const latest = latestCard(game);
  const key = shown.strip + '\n' + pending + '\n' + latest;
  if (key === shown.scroll) return;
  const first = shown.scroll === null;
  shown.scroll = key;
  const target = pending !== null ? strip.querySelector('[data-gap="' + pending + '"]')
    : latest !== null ? strip.querySelector('[data-card="' + latest + '"]') : null;
  if (!target) return;
  requestAnimationFrame(function () {
    if (!target.isConnected) return;
    strip.scrollTo({
      left: target.offsetLeft - (strip.clientWidth - target.offsetWidth) / 2,
      behavior: first || reduceMotion.matches ? 'instant' : 'smooth'
    });
  });
}

/**
 * Readout of the latest placement, such as "Wrong: Telephone is 1876. Discarded; Ana draws a new card. Ben is up."
 * @returns {{icon: string, text: string}}
 */
function resultText(game, active) {
  const last = game.log[game.log.length - 1];
  const up = playerName(active) + ' is up.';
  if (!last) return { icon: 'circle-info', text: 'No cards placed yet. ' + up };
  // Entry-text labels are often sentences, and their full stop would run into the year.
  const label = game.cards[last.cardId].label.replace(/\.$/, '');
  const who = playerName(last.playerId);
  let text;
  if (last.correct) {
    text = 'Correct: ' + label + ', ' + formatYear(last.year) + '.';
  } else if (last.drawn !== null) {
    text = 'Wrong: ' + label + ' is ' + formatYear(last.year) + '. Discarded; ' + who + ' draws a new card.';
  } else {
    text = 'Wrong: ' + label + ' is ' + formatYear(last.year) + '. The draw and discard piles are empty, ' +
      'so it goes back to ' + who + '\'s hand.';
  }
  if (last.round !== game.round) {
    text += game.suddenDeath
      ? ' Sudden death, round ' + game.round + ': ' + names.format(game.seats.map(playerName)) + '.'
      : ' Round ' + game.round + '.';
  }
  return { icon: last.correct ? 'circle-check' : 'circle-xmark', text: text + ' ' + up };
}

function renderPlayerTable(game, active) {
  const seated = game.seats.slice();
  state.players.forEach(function (p) {
    if (game.hands[p.id] && !seated.includes(p.id)) seated.push(p.id);
  });
  $('player-table').replaceChildren(...seated.map(function (id) {
    const seat = game.seats.indexOf(id);
    let status = '';
    if (id === active) status = [icon('hand-point-right'), ' Playing now'];
    else if (game.finished.includes(id)) status = [icon('flag-checkered'), ' Finished'];
    else if (seat === -1) status = [icon('user-slash'), ' Out of sudden death'];
    const cell = document.createElement('td');
    cell.append(...[].concat(status));
    const tr = row([seat === -1 ? '—' : String(seat + 1), rowHeader(playerName(id)),
      String(game.hands[id].length), cell]);
    if (id === active) tr.setAttribute('aria-current', 'true');
    return tr;
  }));
}

function focusHand() {
  const inputs = Array.from($('hand').querySelectorAll('input'));
  const target = inputs.find(function (input) { return input.checked; }) || inputs[0];
  if (target) target.focus();
}

/**
 * Apply a change to the pending choice and show it on the scoreboard.
 * @param {{cardId?: number|null, index?: number|null}} patch
 */
function choose(patch) {
  if (state.phase !== 'playing') return;
  try {
    setPending(state.game, patch);
  } catch (err) {
    showMessage(err.message);
    render();
    return;
  }
  commit();
}

$('hand').addEventListener('change', function (event) {
  if (event.target.name === 'card') choose({ cardId: Number(event.target.value) });
});

$('strip').addEventListener('click', function (event) {
  const button = gapAt(event);
  if (!button) return;
  const index = Number(button.dataset.gap);
  choose({ index: state.game.pending.index === index ? null : index });
});

$('strip').addEventListener('keydown', function (event) {
  const button = gapAt(event);
  if (!button) return;
  const gaps = Array.from(this.querySelectorAll('button[data-gap]'));
  const i = gaps.indexOf(button);
  const to = { ArrowLeft: i - 1, ArrowRight: i + 1, Home: 0, End: gaps.length - 1 }[event.key];
  if (to === undefined) return;
  event.preventDefault();
  const target = gaps[Math.max(0, Math.min(to, gaps.length - 1))];
  gaps.forEach(function (gap) { gap.tabIndex = gap === target ? 0 : -1; });
  target.focus();
});

$('hand').addEventListener('dragstart', function (event) {
  const label = event.target instanceof Element ? event.target.closest('label[data-card]') : null;
  if (!label) return;
  event.dataTransfer.setData(CARD_TYPE, label.dataset.card);
  event.dataTransfer.effectAllowed = 'move';
});

$('hand').addEventListener('dragend', clearDragOver);

function clearDragOver() {
  $('strip').querySelectorAll('[data-over]').forEach(function (el) { el.removeAttribute('data-over'); });
}

// The gap button an event happened in, or null.
function gapAt(event) {
  return event.target instanceof Element ? event.target.closest('button[data-gap]') : null;
}

// Only gaps accept a drop, and only a card dragged from the hand.
function dropGap(event) {
  const button = gapAt(event);
  return button && event.dataTransfer.types.includes(CARD_TYPE) ? button : null;
}

$('strip').addEventListener('dragover', function (event) {
  const button = dropGap(event);
  if (!button) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  if (!button.hasAttribute('data-over')) {
    clearDragOver();
    button.setAttribute('data-over', '');
  }
});

$('strip').addEventListener('dragleave', function (event) {
  const button = gapAt(event);
  if (button && !button.contains(event.relatedTarget)) button.removeAttribute('data-over');
});

$('strip').addEventListener('drop', function (event) {
  const button = dropGap(event);
  if (!button) return;
  event.preventDefault();
  clearDragOver();
  choose({ cardId: Number(event.dataTransfer.getData(CARD_TYPE)), index: Number(button.dataset.gap) });
  $('reveal').focus();
});

$('turn-form').addEventListener('submit', function (event) {
  event.preventDefault();
  if (state.phase !== 'playing') return;
  let placement;
  try {
    placement = reveal(state);
  } catch (err) {
    showMessage(err.message);
    return;
  }
  console.log('Placement ' + placement.id + ': ' + playerName(placement.playerId) + ' · ' +
    cardText(state.game, placement.cardId) + ' at gap ' + placement.index + ' · ' +
    (placement.correct ? 'correct' : 'wrong'));
  commit();
  if (state.phase === 'over') $('over-heading').focus();
  else focusHand();
});

function undoLast() {
  const fromOver = state.phase === 'over';
  if (!undo(state)) return;
  console.log('Undid the latest placement');
  commit();
  if (fromOver || $('undo').disabled) focusHand();
}

$('undo').addEventListener('click', undoLast);
$('undo-over').addEventListener('click', undoLast);

// ---------- Game over ----------

function renderOver() {
  const game = state.game;
  const winners = game.winners.map(playerName);
  $('over-title').textContent = winners.length === 1 ? winners[0] + ' wins' : names.format(winners) + ' share the win';
  $('over-meta').textContent = 'Game ' + game.number + ' · ' + (game.suddenDeath ? 'sudden death, ' : '') +
    'round ' + game.round + ' · ' + plural(game.timeline.length, 'card') + ' in the timeline';
  $('standings').replaceChildren(...standings(state).map(function (r) {
    const name = rowHeader();
    if (r.winner) name.append(icon('crown'), ' ');
    name.append(r.player.name);
    return row([String(r.rank), name, String(r.cards)]);
  }));
  $('undo-over').disabled = !game.history.length;
  $('play-again').disabled = !!dealBlocker();
}

$('play-again').addEventListener('click', startGame);

$('edit-deck').addEventListener('click', function () {
  state.game = null;
  state.phase = 'setup';
  commit();
  $('source-form').elements.q.focus();
});

// ---------- Settings ----------

// The New game button opens this dialog through its command attributes.
$('confirm-new').addEventListener('close', function (event) {
  const dialog = event.target;
  const confirmed = dialog.returnValue === 'confirm';
  dialog.returnValue = '';
  if (!confirmed) return;
  Object.keys(controllers).forEach(restart);
  // placementSeq carries over so a placement id never repeats on the scoreboard.
  const fresh = defaultState();
  fresh.players = state.players;
  fresh.nextId = state.nextId;
  fresh.settings = state.settings;
  fresh.deck = state.deck;
  fresh.placementSeq = state.placementSeq;
  state = fresh;
  ui = defaultUi();
  saveUi(ui);
  suggestions = [];
  commit();
});

// ---------- Render and restore ----------

// Each phase has a section with the same id.
const PHASES = { lobby: renderLobby, setup: renderSetup, playing: renderPlay, over: renderOver };

function render() {
  if (!Object.hasOwn(PHASES, state.phase) || (state.phase === 'playing' || state.phase === 'over') && !state.game) {
    state.phase = 'setup';
  }
  Object.keys(PHASES).forEach(function (phase) { $(phase).hidden = phase !== state.phase; });
  renderHeader();
  PHASES[state.phase]();
}

subscribe(function () {
  state = load();
  render();
});

prune();
render();

if (ui.building && state.phase === 'setup') {
  startBuild();
} else if (ui.building) {
  ui.building = null;
  saveUi(ui);
}
