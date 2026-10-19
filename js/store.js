// Game state, localStorage persistence, the cache of built lists, and cross-window sync. The host console is the
// only writer; the scoreboard re-renders from localStorage on storage events.

import { RULES } from './wiki.js';

const KEY_ROOT = 'trial-and-era:';
const VERSION = 1;
const GAME_KEY = KEY_ROOT + 'v' + VERSION;
const UI_KEY = GAME_KEY + ':ui';
// Game and UI keys of any version.
const VERSIONED_KEY = /^trial-and-era:v(\d+)(:|$)/;
const LIST_ROOT = KEY_ROOT + 'list:';
const LIST_PREFIX = LIST_ROOT + 'r' + RULES + ':';
// Browsers give an origin about 5 MiB of localStorage, counted in UTF-16 code units of keys and values.
const QUOTA = 5 * 1024 * 1024;

/**
 * Fresh game state with no players and an empty deck. Phases: lobby → setup → playing → over.
 * @returns {object}
 */
export function defaultState() {
  return {
    settings: { handSize: 4 },
    players: [],
    nextId: 1,
    phase: 'lobby',
    deck: { cards: [], sources: [], nextCardId: 1 },
    gameNumber: 0,
    placementSeq: 0,
    game: null
  };
}

/**
 * Read game state, falling back to a fresh game when missing or unreadable.
 * @returns {object}
 */
export function load() {
  try {
    const state = JSON.parse(localStorage.getItem(GAME_KEY));
    if (state) return state;
  } catch (err) {
    console.log('Could not read saved game', err);
  }
  return defaultState();
}

/**
 * Delete stored data this version cannot use: lists built under other rules, and older game and UI keys.
 * Newer versions are kept so a stale tab cannot wipe a newer deploy's game. Only the host calls this.
 */
export function prune() {
  Object.keys(localStorage).forEach(function (key) {
    const versioned = VERSIONED_KEY.exec(key);
    if ((key.startsWith(LIST_ROOT) && !key.startsWith(LIST_PREFIX)) || (versioned && Number(versioned[1]) < VERSION)) {
      localStorage.removeItem(key);
    }
  });
}

function clearLists() {
  Object.keys(localStorage).forEach(function (key) {
    if (key.startsWith(LIST_ROOT)) localStorage.removeItem(key);
  });
}

// Cached lists are the only expendable data, so a full store drops them and tries once more.
function setItem(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch (err) {
    if (err.name !== 'QuotaExceededError') throw err;
    console.log('localStorage is full; clearing cached lists', err);
    clearLists();
    localStorage.setItem(key, value);
  }
}

/**
 * Persist game state; other windows hear it as a storage event.
 * Throws when the write fails, including when storage is still full after cached lists are cleared.
 * @param {object} state
 */
export function save(state) {
  setItem(GAME_KEY, JSON.stringify(state));
}

/**
 * Characters of serialized game state that fit in localStorage, after the other keys on this origin. Cached lists
 * do not count against it, since a full store drops them. An estimate: browsers do not report the real quota.
 * @returns {number}
 */
export function room() {
  let used = GAME_KEY.length;
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key !== GAME_KEY && !key.startsWith(LIST_ROOT)) used += key.length + localStorage.getItem(key).length;
  }
  return QUOTA - used;
}

/**
 * Call `onChange` when another window saves different game state. Browsers fire storage events only in other
 * windows and only when the value changes; a null key means storage was cleared.
 * @param {function} onChange
 */
export function subscribe(onChange) {
  window.addEventListener('storage', function (event) {
    if (event.key === GAME_KEY || event.key === null) onChange();
  });
}

/**
 * Host-only UI state (search text, deck filter and view, the build in progress), kept apart so it never wakes the
 * scoreboard.
 * @returns {object}
 */
export function loadUi() {
  try {
    return JSON.parse(localStorage.getItem(UI_KEY)) || {};
  } catch (err) {
    console.log('Could not read host UI state', err);
    return {};
  }
}

/**
 * Persist host UI state. Never throws; a failed write is logged.
 * @param {object} ui
 */
export function saveUi(ui) {
  try {
    setItem(UI_KEY, JSON.stringify(ui));
  } catch (err) {
    console.log('Could not save host UI state', err);
  }
}

function listKey(title) {
  return LIST_PREFIX + title;
}

/**
 * Cached list for a canonical page title, built under the current rules, or null. Fits buildCards' `cached`.
 * @param {string} title canonical page title
 * @returns {object|null} {title, labelMode, cards, dropped}
 */
export function getList(title) {
  try {
    return JSON.parse(localStorage.getItem(listKey(title)));
  } catch (err) {
    console.log('Could not read cached list', err);
    return null;
  }
}

/**
 * Cache a built list under its canonical title and the current rules. Never throws; a list that does not fit even
 * after cached lists are cleared is logged and skipped.
 * @param {object} result buildCards' result {title, labelMode, cards, dropped}
 */
export function putList(result) {
  try {
    setItem(listKey(result.title), JSON.stringify(result));
  } catch (err) {
    console.log('Could not cache list', err);
  }
}
