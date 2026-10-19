// Browser client for the MediaWiki Action API and the Wikidata API: page search, list extraction, title
// resolution, and building timeline cards whose years come from the list itself or from Wikidata.

import { findYear, mentionsYear } from './years.js';

const API = 'https://en.wikipedia.org/w/api.php';
const WIKIDATA = 'https://www.wikidata.org/w/api.php';
const WIKI_BASE = 'https://en.wikipedia.org/wiki/';
const USER_AGENT = 'TrialAndEra/1.0 (https://spitball.show; podcast@spitball.show)';
const RETRIES = 5;
const ATTEMPT_TIMEOUT_MS = 30000;
const BATCH = 50;
// Full claims for 50 claim-heavy entities such as countries run to 4 MB gzipped, too slow for one attempt on a slow
// link.
const WIKIDATA_BATCH = 10;
// Wikimedia's published limit for unauthenticated browser requests is 200 per minute across its sites and APIs;
// this leaves headroom.
const RATE_LIMIT = 180;
const RATE_WINDOW_MS = 60000;

// Links inside these never become candidates.
const SKIP = '.navbox, .vertical-navbox, .sidebar, .reflist, .references, sup.reference, .hatnote, ' +
  '.shortdescription, .ambox, .metadata, .sistersitebox, .portalbox';
// Candidate links. Parsoid gives self-links an href, which legacy markup omits.
const LINK = 'a[href]:not(.mw-selflink)';
// Regions whose rows and list items are not list entries.
const NOT_ITEMS = '.infobox, .gallery, figure, .thumb';
// Never part of an entry's text: footnote marks, hidden sort keys, styles, and image captions.
const NOT_TEXT = 'sup.reference, sup.noprint, .sortkey, [style*="display:none"], [style*="display: none"], style, ' +
  'link, .mw-ref, figure, figcaption, .thumb';
const END_SECTIONS = ['see also', 'notes', 'references', 'citations', 'sources', 'bibliography',
  'further reading', 'external links'];
const NAME_HEADER = /\b(name|title)\b/i;
const NAMESPACE = /^(file|image|media|category|template|help|wikipedia|wp|portal|special|talk|user|module|draft|mediawiki|timedtext)( talk)?:/i;
// Year, date, decade, and century articles, which a dated entry often links before its subject.
const DATE_TITLE = new RegExp('^(?:(?:AD )?\\d{1,4}s?(?: BCE?| AD)?|\\d+(?:st|nd|rd|th) (?:century|millennium)' +
  '(?: BCE?| AD)?|\\d{1,4}s?(?: BCE?)? in .+|(?:January|February|March|April|May|June|July|August|September|' +
  'October|November|December) \\d{1,2})$');
const YEAR_HEADER = /\b(years?|dates?|released?|introduced|invented|founded|established|opened|launched|premiered|published|discovered|first|built|completed|inception)\b/i;
const NOT_YEAR_HEADER = /\b(death|died|closed|demolished|retired|end|ended|dissolved|disestablished|defunct|discontinued|last|final|until|born|birth|age|active)\b/i;
// Link text that is only an ordinal, as a ceremony's "(16th)" links to its edition article.
const ORDINAL_TEXT = /^\(?\d+(?:st|nd|rd|th)\)?$/;
// A label before a date in a details cell, as discography tables give "Released: 4 August 1967".
const DATE_LABEL = /\b(?:Released|Premiered|Published|Opened|Founded):\s*/;
// An entry that opens with a century, millennium, or decade gives a period, not a year: its text is not searched
// for one, and a Wikidata year must fall inside the period.
const VAGUE_LEAD = /^[\s"'“]*(?:(?:by|before|after|around|about|from|since|until|in|at|least|the|early|mid|late|c\.|ca\.)[\s-]+)*(?:\d+(?:st|nd|rd|th)[\s-](?:century|millennium)|\d+0s)(?!\p{L})/iu;
const PERIOD = /(\d+)(?:st|nd|rd|th)[\s-](century|millennium)(?:\s*(BCE?|AD|CE)(?!\p{L}))?|(\d+0)s(?:\s*(BCE?)(?!\p{L}))?/giu;
// A bare number leads a timeline entry as its year only when a separator, not another number, follows it.
const BARE_LEAD_END = /^\s*(?::|[–—-](?!\s*\p{N}))/u;
const LEAD_SEPARATOR = /^[\s:;,.–—-]+/;
const MONTH = '(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sept?(?:ember)?|' +
  'Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\.?';
const DAY = '\\d{1,2}(?:st|nd|rd|th)?';
// A day and month with no year before a separator, as entries under a year heading open: "October 20:".
const MONTH_DAY_LEAD = new RegExp('^(?:(?:early|mid|late)[\\s-]+)?(?:' + MONTH + '(?:\\s+' + DAY + ')?|' + DAY + '\\s+' +
  MONTH + ')(?:\\s*[–—-]\\s*(?:' + MONTH + '\\s+)?' + DAY + '(?:\\s+' + MONTH + ')?)?\\s*(?::|[–—-]\\s)\\s*', 'i');
const LABEL_LENGTH = 120;
const CONTEXT_LENGTH = 300;
// Wikidata date properties in priority order: discovery or invention, inception, publication, first
// performance, point in time, start time, launch, first flight, service entry, official opening, birth.
const DATE_PROPS = ['P575', 'P571', 'P577', 'P1191', 'P585', 'P580', 'P619', 'P606', 'P729', 'P1619', 'P569'];
// A text card describes an event, so the birth year of the person it links first is never its year.
const EVENT_DATE_PROPS = DATE_PROPS.filter(function (prop) { return prop !== 'P569'; });
// Wikidata time precision 9 is a year; lower values are decades, centuries, and coarser.
const YEAR_PRECISION = 9;
const MIN_YEAR = -10000;

/** Card rules version; cached lists built under other rules are rebuilt. */
export const RULES = 2;

function sleep(ms, signal) {
  if (signal) signal.throwIfAborted();
  return new Promise(function (resolve, reject) {
    function onAbort() {
      clearTimeout(timer);
      reject(signal.reason);
    }
    const timer = setTimeout(function () {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

const sent = [];

// Waits until one more request keeps this window under RATE_LIMIT per rolling minute, then records it.
async function throttle(signal) {
  for (;;) {
    const now = Date.now();
    while (sent.length && now - sent[0] >= RATE_WINDOW_MS) sent.shift();
    if (sent.length < RATE_LIMIT) {
      sent.push(now);
      return;
    }
    await sleep(RATE_WINDOW_MS - (now - sent[0]), signal);
  }
}

/**
 * Rate-limited fetch() that retries 429, 5xx, network errors, and attempts that time out, honoring Retry-After where
 * the host exposes it. Rejects with the caller's abort reason once `init.signal` aborts.
 * @param {string} url
 * @param {object} init
 * @returns {Promise<Response>} with the body already read when the status is OK
 */
async function fetchRetry(url, init) {
  const signal = init.signal;
  for (let attempt = 0; ; attempt++) {
    await throttle(signal);
    const timeout = AbortSignal.timeout(ATTEMPT_TIMEOUT_MS);
    const attemptSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let res = null;
    let failure = null;
    try {
      res = await fetch(url, Object.assign({}, init, { signal: attemptSignal }));
      // The body is read within the attempt, so a timeout while it downloads is retried like one before the headers.
      if (res.ok) res = new Response(await res.blob(), res);
    } catch (err) {
      if (signal && signal.aborted) throw signal.reason;
      // A timeout rejects with TimeoutError before the headers but with AbortError during the body.
      if (attempt >= RETRIES) throw timeout.aborted ? new Error(new URL(url).hostname + ' request timed out') : err;
      res = null;
      failure = timeout.aborted ? 'timed out' : 'network error';
    }
    if (res && ((res.status !== 429 && res.status < 500) || attempt >= RETRIES)) return res;
    // Doubling from 2 s, the retries span just over a minute: the window Wikimedia's limits are measured over.
    const retryAfter = res ? Number(res.headers.get('Retry-After')) : 0;
    const delay = retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** (attempt + 1);
    console.log('Retrying in ' + delay + ' ms (' + (res ? 'HTTP ' + res.status : failure) + '): ' + url);
    await sleep(delay, signal);
  }
}

// Both hosts allow Api-User-Agent in their CORS preflight, so every request identifies the app.
async function getJson(base, name, params, signal) {
  const query = new URLSearchParams(Object.assign({}, params, { format: 'json', formatversion: '2', origin: '*' }));
  const res = await fetchRetry(base + '?' + query.toString(), {
    headers: { 'Api-User-Agent': USER_AGENT },
    signal: signal
  });
  if (!res.ok) throw new Error(name + ' API HTTP ' + res.status);
  const data = await res.json();
  if (data.error) throw new Error(data.error.info || data.error.code);
  return data;
}

function api(params, signal) {
  return getJson(API, 'Wikipedia', params, signal);
}

function wikidataApi(params, signal) {
  return getJson(WIKIDATA, 'Wikidata', params, signal);
}

/**
 * Article suggestions for a search box.
 * @param {string} text
 * @param {AbortSignal} [signal]
 * @returns {Promise<Array<string>>} titles
 */
export async function search(text, signal) {
  const data = await api({ action: 'opensearch', search: text, namespace: '0', limit: '10' }, signal);
  return data[1] || [];
}

/**
 * Page title from a pasted English Wikipedia URL.
 * @param {string} text
 * @returns {string|null} null when `text` is not a URL; throws for non-English Wikipedia URLs
 */
export function titleFromUrl(text) {
  let url;
  try {
    url = new URL(text.trim());
  } catch (err) {
    return null;
  }
  if (!/^https?:$/.test(url.protocol)) return null;
  if (!/^en\.(m\.)?wikipedia\.org$/.test(url.hostname)) {
    throw new Error('Only English Wikipedia URLs are supported.');
  }
  const title = urlTitle(url);
  if (!title) throw new Error('That URL does not point to a Wikipedia page.');
  return title;
}

// Page title in a URL's `title` parameter or /wiki/ path, with underscores as spaces; null when there is none.
function urlTitle(url) {
  let raw = url.searchParams.get('title');
  if (!raw && url.pathname.startsWith('/wiki/')) {
    try {
      raw = decodeURIComponent(url.pathname.slice(6));
    } catch (err) {
      return null;
    }
  }
  const title = raw ? raw.replace(/_/g, ' ').trim() : '';
  return title || null;
}

// Page title a link in parsed HTML points to, or null for links off en.wikipedia.org/wiki/. Hrefs resolve against
// the /wiki/ base because the parsers differ: '/wiki/X', './X', and absolute URLs all occur.
function titleFromHref(href) {
  let url;
  try {
    url = new URL(href, WIKI_BASE);
  } catch (err) {
    return null;
  }
  // Red links carry ?action=edit&redlink=1, and no plain article link has a query.
  if (url.hostname !== 'en.wikipedia.org' || url.search) return null;
  return urlTitle(url);
}

/**
 * Rendered HTML of a page, following redirects.
 * @param {string} title
 * @param {AbortSignal} [signal]
 * @returns {Promise<{title: string, html: string}>}
 */
async function fetchPage(title, signal) {
  const data = await api({
    action: 'parse',
    page: title,
    prop: 'text',
    redirects: '1',
    disableeditsection: '1',
    disabletoc: '1',
    disablelimitreport: '1'
  }, signal);
  return { title: data.parse.title, html: data.parse.text };
}

// First end-matter h2; everything after it is skipped. With edit links disabled, an h2's text is its heading.
function findCutoff(doc) {
  return Array.from(doc.querySelectorAll('h2')).find(function (h2) {
    return END_SECTIONS.includes(h2.textContent.replace(/\s+/g, ' ').trim().toLowerCase());
  });
}

// Cell grid that accounts for rowspan and colspan, so column indexes line up across rows.
function tableGrid(table) {
  const rows = Array.from(table.rows);
  const grid = rows.map(function () { return []; });
  rows.forEach(function (row, r) {
    let c = 0;
    Array.from(row.cells).forEach(function (cell) {
      while (grid[r][c]) c++;
      const rowSpan = Math.min(Math.max(1, cell.rowSpan || 1), rows.length - r);
      const colSpan = Math.max(1, cell.colSpan || 1);
      for (let i = 0; i < rowSpan; i++) {
        for (let j = 0; j < colSpan; j++) grid[r + i][c + j] = cell;
      }
      c += colSpan;
    });
  });
  return { rows: rows, grid: grid };
}

// Links in `container` that belong to `scope` rather than a nested table or list, and that can be articles:
// files, categories, other namespaces, year or century pages, editions, images such as flag icons, and image
// captions never count as a row's item.
function articleLinks(container, scope) {
  return Array.from(container.querySelectorAll(LINK)).filter(function (a) {
    const title = titleFromHref(a.getAttribute('href'));
    return a.closest(scope.tagName) === scope && !container.contains(a.closest('figure, .thumb')) &&
      !a.querySelector('img') && title && !NAMESPACE.test(title) && !DATE_TITLE.test(title) && !isEdition(a, title);
  });
}

// Link whose text is only a year, range, or ordinal, as a winners table links each year to that year's edition,
// unless the article is titled that way too, as the film "1917 (2019 film)" is.
function isEdition(a, title) {
  const text = a.textContent.replace(/\s+/g, ' ').trim();
  const found = findYear(text);
  return (ORDINAL_TEXT.test(text) || Boolean(found && found.index === 0 && found.length === text.length)) &&
    title.replace(/\s*\([^()]*\)$/, '') !== text;
}

function isHeaderRow(row) {
  return row.cells.length > 0 && Array.from(row.cells).every(function (cell) { return cell.tagName === 'TH'; });
}

// Leading all-th rows, or the first all-th row when the table does not open with one.
function headerRows(rows) {
  const lead = [];
  while (lead.length < rows.length && isHeaderRow(rows[lead.length])) lead.push(lead.length);
  if (lead.length) return lead;
  const first = rows.findIndex(isHeaderRow);
  return first === -1 ? [] : [first];
}

// Every grid column under the first header cell matching `test`, so a header spanning columns covers them all.
function headerColumns(grid, header, test) {
  for (let h = 0; h < header.length; h++) {
    const cells = grid[header[h]];
    const match = cells.find(function (cell) { return cell && test(textOf(cell)); });
    if (match) {
      const cols = [];
      cells.forEach(function (cell, c) { if (cell === match) cols.push(c); });
      return cols;
    }
  }
  return [];
}

// A header like "First title" or "Last title" names a date column, not the item.
function nameColumns(grid, header) {
  return headerColumns(grid, header, function (text) {
    return NAME_HEADER.test(text) && !YEAR_HEADER.test(text) && !NOT_YEAR_HEADER.test(text);
  });
}

function yearColumns(grid, header) {
  return headerColumns(grid, header, function (text) {
    return YEAR_HEADER.test(text) && !NOT_YEAR_HEADER.test(text);
  });
}

// The column holding each row's first article link in most rows, so one unlinked row cannot borrow a neighbor.
// Year columns vote only when no other column has links, so a winners table yields its winners.
function linkColumn(layout, start, table, yearCols) {
  function vote(skip) {
    const counts = [];
    for (let r = start; r < layout.rows.length; r++) {
      if (isHeaderRow(layout.rows[r])) continue;
      const cells = layout.grid[r];
      for (let c = 0; c < cells.length; c++) {
        if (cells[c] && !skip.includes(c) && articleLinks(cells[c], table).length) {
          counts[c] = (counts[c] || 0) + 1;
          break;
        }
      }
    }
    let best = -1;
    counts.forEach(function (n, c) {
      if (best === -1 || n > counts[best]) best = c;
    });
    return best;
  }
  let best = vote(yearCols);
  if (best === -1) best = vote([]);
  return best === -1 ? [] : [best];
}

// Visible text of an element without footnote marks, hidden sort keys, or nested lists when `own` is set.
function textOf(el, own) {
  const clone = el.cloneNode(true);
  clone.querySelectorAll(NOT_TEXT + (own ? ', ul, ol, dl' : '')).forEach(function (node) { node.remove(); });
  clone.querySelectorAll('br').forEach(function (br) { br.replaceWith(' '); });
  // A superscript number right after a digit is an exponent, as in 10<sup>15</sup>, not more digits.
  clone.querySelectorAll('sup').forEach(function (sup) {
    const prev = sup.previousSibling;
    if (/^\d+$/.test(sup.textContent) && prev && /\d$/.test(prev.textContent)) sup.replaceWith('^' + sup.textContent);
  });
  return clone.textContent
    .replace(/\[(?:\d+|[a-z]|note \d+|citation needed|clarification needed)\]/gi, '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s†‡§¶*#]+|[\s†‡§¶*#]+$/g, '')
    .trim();
}

function clip(text, max) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return (space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:–—-]+$/, '') + '…';
}

// First sentence when it fits, else the text clipped at a word. Initials and abbreviations such as "James H."
// or "Dr." do not end a sentence.
function shorten(text) {
  if (text.length <= LABEL_LENGTH) return text;
  for (const m of text.matchAll(/[.!?](?=\s+[A-Z“"(])/g)) {
    const end = m.index + 1;
    if (end > LABEL_LENGTH) break;
    if (end < 30 || /(?:^|[\s.(])(?:[A-Z]|Dr|Mr|Mrs|Ms|St|Jr|Sr|Co|Inc|Ltd|vs|no|ca|c|fl|e\.g|i\.e|etc)\.$/.test(text.slice(0, end))) {
      continue;
    }
    return text.slice(0, end);
  }
  return clip(text, LABEL_LENGTH);
}

// Range of years a leading century, millennium, or decade covers, such as [1201, 1300] for "13th century:", or
// null when the text does not open with one. A period with no era takes the era of the next one that has it.
function vagueRange(text) {
  const lead = VAGUE_LEAD.exec(text);
  if (!lead) return null;
  const colon = text.indexOf(':');
  const head = colon !== -1 && colon < 80 ? text.slice(0, colon) : lead[0];
  const periods = Array.from(head.matchAll(PERIOD));
  let era = '';
  const bounds = periods.reverse().map(function (m) {
    era = m[3] || m[5] || (era.startsWith('B') ? era : '');
    if (m[4]) {
      const decade = Number(m[4]);
      const span = decade % 100 === 0 ? 99 : 9;
      return era.startsWith('B') ? [-(decade + span), -decade] : [decade, decade + span];
    }
    const size = m[2].toLowerCase() === 'century' ? 100 : 1000;
    const n = Number(m[1]);
    return era.startsWith('B') ? [-n * size, -((n - 1) * size + 1)] : [(n - 1) * size + 1, n * size];
  });
  return [Math.min(...bounds.map(function (b) { return b[0]; })), Math.max(...bounds.map(function (b) { return b[1]; }))];
}

// Year that is a whole heading's text, such as "1876" or "500 BC", but not a range or a decade.
function headingYear(text) {
  const found = findYear(text);
  if (!found || found.index !== 0 || found.length !== text.length) return null;
  return (text.match(/\d+/g) || []).length === 1 ? found.year : null;
}

// Year a table row gives in a year-headed column, else in the first date-like column holding only a date, else
// after a date label in any cell.
function rowYear(layout, r, cols) {
  for (const c of cols.yearCols) {
    const cell = layout.grid[r][c];
    const found = cell ? findYear(textOf(cell), { bare: true }) : null;
    if (found) return { year: found.year, col: c };
  }
  for (const c of cols.dateCols) {
    const cell = layout.grid[r][c];
    const year = cell ? dateOnly(textOf(cell)) : null;
    if (year != null) return { year: year, col: c };
  }
  for (const cell of new Set(layout.grid[r])) {
    const text = cell ? textOf(cell) : '';
    const label = DATE_LABEL.exec(text);
    const found = label ? findYear(text.slice(label.index + label[0].length)) : null;
    if (found) return { year: found.year, col: layout.grid[r].indexOf(cell) };
  }
  return null;
}

// Year when the text is a date or year and nothing else but notes in brackets or parentheses.
function dateOnly(text) {
  const found = findYear(text);
  if (!found) return null;
  const rest = text.slice(0, found.index) + text.slice(found.index + found.length);
  return /[\p{L}\p{N}]/u.test(rest.replace(/\[[^\]]*\]|\([^)]*\)/g, '')) ? null : found.year;
}

// Columns outside the item columns where at least half the body rows hold only a date.
function dateColumns(layout, start, itemCols) {
  const width = Math.max(0, ...layout.grid.map(function (cells) { return cells.length; }));
  const cols = [];
  for (let c = 0; c < width; c++) {
    if (itemCols.includes(c)) continue;
    let rows = 0;
    let dates = 0;
    for (let r = start; r < layout.rows.length; r++) {
      const cell = layout.grid[r][c];
      if (!cell || isHeaderRow(layout.rows[r])) continue;
      rows++;
      if (dateOnly(textOf(cell)) != null) dates++;
    }
    if (rows && dates * 2 >= rows) cols.push(c);
  }
  return cols;
}

/**
 * Entries of a page: one per table row with an article link in its item column, and one per list item with an
 * article link of its own. Each keeps its links, text, and the year the page gives it, if any.
 * @param {Document} doc
 * @returns {Array<object>} groups in document order: {el, container, links, text, context, year, leading, guess}
 */
function itemGroups(doc) {
  const cutoff = findCutoff(doc);
  const groups = [];
  function counts(el) {
    if (el.closest(SKIP) || el.closest(NOT_ITEMS)) return false;
    return !(cutoff && (cutoff.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING));
  }

  doc.querySelectorAll('table').forEach(function (table) {
    if (!counts(table) || !table.querySelector('th')) return;
    const layout = tableGrid(table);
    const header = headerRows(layout.rows);
    const lastHeader = header.length ? header[header.length - 1] : -1;
    const yearCols = yearColumns(layout.grid, header);
    let itemCols = nameColumns(layout.grid, header);
    if (!itemCols.length) itemCols = linkColumn(layout, lastHeader + 1, table, yearCols);
    const cols = {
      yearCols: yearCols.filter(function (c) { return !itemCols.includes(c); }),
      dateCols: dateColumns(layout, lastHeader + 1, itemCols)
    };
    const seenCells = new Set();
    layout.rows.forEach(function (row, r) {
      if (r <= lastHeader || isHeaderRow(row)) return;
      let links = [];
      const texts = [];
      itemCols.forEach(function (c) {
        const cell = layout.grid[r][c];
        if (!cell || seenCells.has(cell)) return;
        seenCells.add(cell);
        links = links.concat(articleLinks(cell, table));
        texts.push(textOf(cell));
      });
      if (!links.length) return;
      const found = rowYear(layout, r, cols);
      const cells = Array.from(new Set(layout.grid[r])).filter(Boolean);
      groups.push({
        el: row,
        container: table,
        links: links,
        text: texts.filter(Boolean).join(' '),
        context: cells.map(function (cell) { return textOf(cell); }).filter(Boolean).join(' · '),
        year: found ? found.year : null,
        leading: Boolean(found && found.col < itemCols[0]),
        guess: false
      });
    });
  });

  doc.querySelectorAll('li').forEach(function (li) {
    if (!counts(li)) return;
    const cell = li.closest('td, th');
    if (cell && cell.closest('table').querySelector('th')) return;
    const links = articleLinks(li, li);
    if (!links.length) return;
    const text = textOf(li, true);
    const lead = findYear(text);
    groups.push({
      el: li,
      container: li.parentElement,
      links: links,
      text: text,
      context: text,
      year: lead && lead.leading ? lead.year : null,
      leading: Boolean(lead && lead.leading),
      guess: false
    });
  });

  bareLeadYears(groups);
  fillListYears(doc, groups);
  groups.sort(function (a, b) {
    return a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
  });
  return groups;
}

// On a timeline page, where most list items lead with a year, a bare number leading an item is its year too,
// as in "563: Pendentive dome".
function bareLeadYears(groups) {
  const items = groups.filter(function (g) { return g.el.tagName === 'LI'; });
  if (items.filter(function (g) { return g.leading; }).length * 2 < items.length) return;
  items.forEach(function (g) {
    if (g.year != null) return;
    const found = findYear(g.text, { bare: true });
    if (found && found.leading && BARE_LEAD_END.test(g.text.slice(found.index + found.length))) {
      g.year = found.year;
      g.leading = true;
    }
  });
}

// Years for entries the row or item text left undated: an enclosing list item that leads with a year, then the
// nearest heading that is a single year, then, for list items only, the first year in the text as a guess.
// An entry dated by its place under a year reads like one that leads with it.
function fillListYears(doc, groups) {
  const byEl = new Map(groups.map(function (g) { return [g.el, g]; }));
  const stack = [];
  doc.querySelectorAll('h1, h2, h3, h4, h5, h6, tr, li').forEach(function (el) {
    const level = /^H(\d)$/.exec(el.tagName);
    if (level) {
      stack.length = Number(level[1]);
      stack[Number(level[1]) - 1] = headingYear(textOf(el));
      return;
    }
    const group = byEl.get(el);
    if (!group || group.year != null) return;
    const parent = el.tagName === 'LI' ? el.parentElement.closest('li') : null;
    const parentLead = parent ? findYear(textOf(parent, true)) : null;
    if (parentLead && parentLead.leading) {
      group.year = parentLead.year;
      group.leading = true;
      return;
    }
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i] != null) {
        group.year = stack[i];
        group.leading = true;
        return;
      }
    }
    if (el.tagName === 'LI' && !VAGUE_LEAD.test(group.text)) {
      const loose = findYear(group.text);
      if (loose) {
        group.year = loose.year;
        group.guess = true;
      }
    }
  });
}

/**
 * Resolve titles to canonical article titles in batches of 50, following normalization and redirects.
 * @param {Array<string>} titles
 * @param {function(number, number)} [onProgress] called with (batches done, total batches)
 * @param {AbortSignal} [signal]
 * @returns {Promise<Map<string, {title: string, description: string, disambig: boolean}|null>>}
 *   null for missing pages and non-article namespaces
 */
async function resolveTitles(titles, onProgress, signal) {
  const unique = Array.from(new Set(titles));
  const result = new Map();
  const total = Math.ceil(unique.length / BATCH);
  for (let start = 0; start < unique.length; start += BATCH) {
    const batch = unique.slice(start, start + BATCH);
    const normalized = new Map();
    const redirects = new Map();
    const pages = new Map();
    let cont = {};
    while (cont) {
      const data = await api(Object.assign({
        action: 'query',
        titles: batch.join('|'),
        redirects: '1',
        prop: 'description|pageprops',
        ppprop: 'disambiguation'
      }, cont), signal);
      const q = data.query || {};
      (q.normalized || []).forEach(function (n) { normalized.set(n.from, n.to); });
      (q.redirects || []).forEach(function (r) { redirects.set(r.from, r.to); });
      (q.pages || []).forEach(function (p) {
        const prev = pages.get(p.title) || {};
        pages.set(p.title, Object.assign(prev, p, { pageprops: Object.assign({}, prev.pageprops, p.pageprops) }));
      });
      cont = data.continue || null;
    }
    batch.forEach(function (title) {
      let name = normalized.get(title) || title;
      for (let hops = 0; redirects.has(name) && hops < 5; hops++) name = redirects.get(name);
      const page = pages.get(name);
      if (!page || page.missing || page.invalid || page.ns !== 0) {
        result.set(title, null);
        return;
      }
      result.set(title, {
        title: page.title,
        description: page.description ?? '',
        disambig: Object.hasOwn(page.pageprops, 'disambiguation')
      });
    });
    if (onProgress) onProgress(start / BATCH + 1, total);
  }
  return result;
}

// Year of a Wikidata time value such as '+1876-03-10T00:00:00Z'; negative years are BC.
function wikidataYear(value) {
  const m = /^([+-])(\d+)-/.exec(value.time);
  if (!m || value.precision < YEAR_PRECISION) return null;
  const year = Number(m[2]) * (m[1] === '-' ? -1 : 1);
  return year === 0 ? null : year;
}

// Earliest year of the first of `props` with a value at year precision or finer; null when none has one or that
// year is out of range.
function entityYear(claims, props = DATE_PROPS) {
  for (const prop of props) {
    const years = (claims[prop] || []).filter(function (claim) {
      const snak = claim.mainsnak;
      return claim.rank !== 'deprecated' && snak.snaktype === 'value' && snak.datavalue.type === 'time';
    }).map(function (claim) { return wikidataYear(claim.mainsnak.datavalue.value); }).filter(function (year) {
      return year != null;
    });
    if (years.length) {
      const year = Math.min(...years);
      return year >= MIN_YEAR && year <= new Date().getFullYear() ? year : null;
    }
  }
  return null;
}

/**
 * Years from Wikidata for canonical English Wikipedia titles, 10 per request.
 * @param {Array<string>} titles
 * @param {Array<string>} props date properties in priority order
 * @param {function(number, number)} [onProgress] called with (batches done, total batches)
 * @param {AbortSignal} [signal]
 * @returns {Promise<Map<string, number>>} titles with a usable year
 */
async function wikidataYears(titles, props, onProgress, signal) {
  const result = new Map();
  const total = Math.ceil(titles.length / WIKIDATA_BATCH);
  for (let start = 0; start < titles.length; start += WIKIDATA_BATCH) {
    const data = await wikidataApi({
      action: 'wbgetentities',
      sites: 'enwiki',
      titles: titles.slice(start, start + WIKIDATA_BATCH).join('|'),
      props: 'claims|sitelinks',
      sitefilter: 'enwiki'
    }, signal);
    Object.values(data.entities || {}).forEach(function (entity) {
      const link = entity.sitelinks && entity.sitelinks.enwiki;
      if (!link || !entity.claims) return;
      const year = entityYear(entity.claims, props);
      if (year != null) result.set(link.title, year);
    });
    if (onProgress) onProgress(start / WIKIDATA_BATCH + 1, total);
  }
  return result;
}

// Text without the first mention of `year` that leads it, sits in parentheses, or ends it, along with that
// mention's separators, so the label hides the answer. A mention inside a sentence stays, and the card is
// flagged as a leak. Bare numbers count, since only a mention equal to the card's year is removed.
function withoutYear(text, year) {
  if (year == null) return text;
  for (let from = 0; from < text.length;) {
    const found = findYear(text.slice(from), { bare: true });
    if (!found) break;
    const index = from + found.index;
    const end = index + found.length;
    if (found.year === year) {
      if (found.leading && from === 0) return text.slice(end).replace(LEAD_SEPARATOR, '').trim();
      const before = text.slice(0, index);
      const after = text.slice(end);
      const paren = /\(\s*$/.exec(before) && /^\s*\)/.exec(after);
      if (paren) {
        return (before.replace(/\s*\(\s*$/, '') + after.replace(/^\s*\)/, '')).replace(/\s+/g, ' ').trim();
      }
      if (/^[\s.]*$/.test(after)) {
        return before.replace(/[\s,;:–—-]+$/, '').replace(/\s+(?:in|on|by|from|since|until|during|of|around|about)$/i, '')
          .trim();
      }
    }
    from = end;
  }
  return text;
}

// Article title without a trailing parenthetical, and without a leading year when that year is the card's.
// Titles always start uppercase, so link text such as "iPhone" restores a lowercase start.
function linkLabel(title, year, alias) {
  const name = alias && /^\p{Ll}\p{Lu}/u.test(alias) && alias[0].toUpperCase() === title[0] && alias[1] === title[1] ?
    alias[0] + title.slice(1) : title;
  const base = name.replace(/\s*\([^()]*\)$/, '');
  const lead = findYear(base);
  if (lead && lead.leading && lead.year === year) {
    const rest = base.slice(lead.index + lead.length).replace(LEAD_SEPARATOR, '');
    if (rest) return rest;
  }
  return base;
}

function wordCount(text) {
  return text.split(/\s+/).filter(Boolean).length;
}

/**
 * Entries claimed by their first resolved article link. A disambiguation page drops its entry, links to missing
 * pages and to the list itself are passed over.
 * @returns {{entries: Array<object>, dropped: number}}
 */
function claimEntries(groups, resolved, pageTitle) {
  const entries = [];
  let dropped = 0;
  groups.forEach(function (group) {
    const link = group.links.find(function (a) {
      const target = resolved.get(titleFromHref(a.getAttribute('href')));
      return target && target.title !== pageTitle;
    });
    if (!link) return;
    const page = resolved.get(titleFromHref(link.getAttribute('href')));
    if (page.disambig) {
      dropped++;
      return;
    }
    entries.push(Object.assign({}, group, {
      page: page,
      alias: link.textContent.replace(/\s+/g, ' ').trim(),
      vague: vagueRange(group.text)
    }));
  });
  return { entries: entries, dropped: dropped };
}

// Timeline pages lead most entries with a year and describe them in a sentence; other lists name things.
function chooseLabelMode(entries) {
  const prose = entries.filter(function (e) {
    return e.leading && wordCount(withoutYear(e.text, e.year)) > 6;
  }).length;
  return prose * 2 > entries.length ? 'text' : 'link';
}

// One entry per article in link mode, preferring one with a list year; one per article and text in text mode.
function dedupe(entries, labelMode) {
  const kept = new Map();
  entries.forEach(function (e) {
    const key = labelMode === 'link' ? e.page.title : e.page.title + '\n' + e.text;
    const prev = kept.get(key);
    if (!prev || (prev.year == null && e.year != null) || (prev.guess && e.year != null && !e.guess)) {
      kept.set(key, e);
    }
  });
  const keep = new Set(kept.values());
  return entries.filter(function (e) { return keep.has(e); });
}

// On a page where most entries are dated, tables and lists with no dated entry are side lists, such as a count
// of laureates by country, so they are dropped rather than dated from Wikidata.
function dropUndatedContainers(entries) {
  const dated = entries.filter(function (e) { return e.year != null; });
  if (dated.length * 2 < entries.length) return entries;
  const datedContainers = new Set(dated.map(function (e) { return e.container; }));
  return entries.filter(function (e) { return datedContainers.has(e.container); });
}

// Entry text without its year, a leading month and day, or a leading period once the card has a year of its own.
function textLabel(entry) {
  let text = withoutYear(entry.text, entry.year).replace(MONTH_DAY_LEAD, '');
  if (entry.vague && entry.year != null) {
    const colon = text.indexOf(':');
    if (colon !== -1 && colon < 80) text = text.slice(colon + 1).replace(LEAD_SEPARATOR, '');
  }
  return shorten(text);
}

function toCard(entry, labelMode) {
  const year = entry.year;
  const link = linkLabel(entry.page.title, year, entry.alias);
  const text = textLabel(entry) || link;
  const label = labelMode === 'text' ? text : link;
  const flags = [];
  if (year == null) flags.push('noyear');
  else if (mentionsYear(label, year)) flags.push('leak');
  if (entry.guess) flags.push('guess');
  return {
    title: entry.page.title,
    linkLabel: link,
    textLabel: text,
    label: label,
    labelEdited: false,
    year: year,
    yearFrom: entry.yearFrom,
    description: entry.page.description,
    context: clip(entry.context, CONTEXT_LENGTH),
    flags: flags
  };
}

/**
 * Build timeline cards from a list or timeline page: page HTML → entries → canonical titles → years from the
 * page, then from Wikidata for entries the page leaves undated.
 * @param {string} title page to build from
 * @param {function(string, number, number)} onProgress (step label, done, total)
 * @param {AbortSignal} [signal]
 * @param {function(string): object|null} [cached] returns a cached result for a canonical title, or null
 * @returns {Promise<{title: string, labelMode: string, cards: Array<object>, dropped: number}>} the cached
 *   result on a hit; dropped counts entries left out as disambiguation pages, repeats, or side lists
 */
export async function buildCards(title, onProgress, signal, cached) {
  onProgress('Fetching page', 0, 0);
  const page = await fetchPage(title, signal);
  const hit = cached ? cached(page.title) : null;
  if (hit) return hit;

  const doc = new DOMParser().parseFromString(page.html, 'text/html');
  const groups = itemGroups(doc);
  const titles = [];
  groups.forEach(function (g) {
    g.links.forEach(function (a) { titles.push(titleFromHref(a.getAttribute('href'))); });
  });
  console.log('Extracted ' + groups.length + ' entries from ' + page.title);
  const resolved = await resolveTitles(titles, function (done, total) {
    onProgress('Resolving titles', done, total);
  }, signal);

  const claimed = claimEntries(groups, resolved, page.title);
  const labelMode = chooseLabelMode(claimed.entries);
  const entries = dropUndatedContainers(dedupe(claimed.entries, labelMode));
  entries.forEach(function (e) { e.yearFrom = e.year != null ? 'list' : null; });

  // A text card describes an event, not its first linked article, so it takes a Wikidata year only when the
  // year falls inside the period its text gives.
  const undated = entries.filter(function (e) { return e.year == null && (labelMode === 'link' || e.vague); });
  if (undated.length) {
    const years = await wikidataYears(Array.from(new Set(undated.map(function (e) { return e.page.title; }))),
      labelMode === 'text' ? EVENT_DATE_PROPS : DATE_PROPS,
      function (done, total) { onProgress('Wikidata dates', done, total); }, signal);
    undated.forEach(function (e) {
      const year = years.get(e.page.title);
      if (year == null || (e.vague && (year < e.vague[0] || year > e.vague[1]))) return;
      e.year = year;
      e.yearFrom = 'wikidata';
    });
  }

  const cards = entries.map(function (e) { return toCard(e, labelMode); });
  console.log('Built ' + cards.length + ' cards from ' + page.title);
  return { title: page.title, labelMode: labelMode, cards: cards, dropped: claimed.entries.length - entries.length +
    claimed.dropped };
}
