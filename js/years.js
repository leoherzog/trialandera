// Year parsing and formatting for cards: a strict parse for host input and a scanner that finds the first year
// in free text from Wikipedia rows and list items. Years are integers, negative for BC, never 0.

const MIN_YEAR = -10000;
const MONTH = '(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sept?(?:ember)?|' +
  'Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\.?';
const DAY = '\\d{1,2}(?:st|nd|rd|th)?(?:\\s*[-–]\\s*\\d{1,2}(?:st|nd|rd|th)?)?';
const BC = 'BCE|BC|B\\.C\\.E\\.|B\\.C\\.';
const AD = 'AD|A\\.D\\.|CE|C\\.E\\.';
// A year with optional circa and era markers, and an optional range end that is consumed but not used.
const CORE = '(?:(?:c|ca|circa)\\.?\\s*)?(?<pre>(?:AD|A\\.D\\.)\\s*)?(?<num>\\d{1,3}(?:,\\d{3})+|\\d{1,5})' +
  '(?:\\s*(?<era>' + BC + '|' + AD + ')(?![\\p{L}\\p{N}]))?' +
  '(?<range>(?:\\s*[-–—~]\\s*|/|\\s+(?:and|or|to)\\s+)(?:c\\.\\s*)?(?:AD\\s*)?(?<end>\\d{1,3}(?:,\\d{3})+|\\d{1,5})' +
  '(?:\\s*(?<endEra>' + BC + '|' + AD +
  ')(?![\\p{L}\\p{N}]))?)?';
const START = '(?<![\\p{L}\\p{N}$£€¥₹#])';
// Tried in order; the earliest match wins, and the longest among those at the same index.
const PATTERNS = [
  // ISO dates, whose month and day would otherwise read as a range end.
  new RegExp(START + '(?<num>\\d{4})-(?:0[1-9]|1[0-2])-(?:[0-2]\\d|3[01])(?!\\d)', 'dgu'),
  // Dates whose day and month would otherwise read as numbers: March 10, 1876; 10 March 1876; March 1876.
  new RegExp(START + MONTH + '\\s+' + DAY + ',?\\s+' + CORE, 'dgu'),
  new RegExp(START + DAY + '\\s+' + MONTH + ',?\\s+' + CORE, 'dgu'),
  new RegExp(START + MONTH + ',?\\s+' + CORE, 'dgu'),
  new RegExp(START + CORE, 'dgu')
];
// Words before a number that make it a count, label, or reference rather than a year.
const NOT_BEFORE = new RegExp('(?:^|[^\\p{L}])(?:no|nos|nr|number|p|pp|pg|page|pages|ch|chap|chapter|chapters|vol|' +
  'volume|issue|section|sec|article|episode|ep|season|track|route|highway|interstate|flight|model|type|mark|' +
  'mk|top|windows|boeing|airbus|version|op|opus|usd|eur|gbp|rs|pop|population|catalogue|catalog)\\.?\\s*$',
  'iu');
// Units and counts after a number that make it a quantity rather than a year.
const NOT_AFTER = new RegExp('^\\s*(?:[%°]|(?:percent|per cent|km|kilomet(?:re|er)s?|mi|miles?|m|met(?:re|er)s?|ft|' +
  'feet|foot|inch(?:es)?|cm|mm|kg|g|lbs?|pounds|tons?|tonnes?|hp|cc|mph|kph|km/h|kw|mw|gw|years?|yrs?|' +
  'months?|weeks?|days?|hours?|minutes?|seconds?|people|persons|men|women|soldiers|troops|deaths|dead|' +
  'casualties|copies|units|votes|\\p{L}*illion|thousand|hundred|dollars|euros|yen|rupees|times|points|pts|' +
  'goals|runs|employees|members|students|words|light[- ]years?)[²³]?(?![\\p{L}\\p{N}]))', 'iu');
// An acronym before a number makes it a model or standard number, as in "IBM 1620" or "ISO/IEC 1989".
const ACRONYM_BEFORE = /(?:^|[^\p{L}])\p{Lu}{2,}[\s/-]*$/u;
// Geological and archaeological ages: before present, millions and thousands of years ago.
const AGES = /^\s*(?:BP|Ma|Mya|mya|ka|kya|Ga|cal)(?![\p{L}\p{N}])/u;
// Only whitespace, a bullet, or a qualifier such as "By" or "Before" may come before a leading year.
const LEADING = /^[\s"'“‘•·*]*(?:(?:by|before|after|around|about|approximately|from|in|since|until|early|mid|late)[\s-]+)?$/iu;
const BC_ONLY = new RegExp('^(?:' + BC + ')$');
const MONTH_AFTER = new RegExp('^\\s*' + MONTH + '(?!\\p{L})', 'u');
const MONTH_BEFORE = new RegExp(MONTH + '\\s*$', 'u');
const THOUSANDS = /(\d),(?=\d{3}(?!\d))/g;
// A range whose end keeps only its last two digits, as in a season "1946–47".
const SHORT_RANGE = /(?<!\d)(\d{2})(\d{2})(\s*[-–—/]\s*)(\d{2})(?!\d)/g;
const DIGIT = /\p{N}/u;

function currentYear() {
  return new Date().getFullYear();
}

/**
 * Display text for a year.
 * @param {number|null} year
 * @returns {string} '1876', '500 BC', or '' for null
 */
export function formatYear(year) {
  if (year == null) return '';
  return year < 0 ? -year + ' BC' : String(year);
}

// Year for one pattern match, or null when the surrounding text or the range shows it is not a year.
// Date patterns pass bare as false, so "March 10" never reads as year 10.
function readMatch(text, m, bare) {
  const g = m.groups;
  let era = g.era || '';
  let length = m[0].length;
  if (g.range) {
    const start = g.num.replace(/,/g, '');
    const end = g.end.replace(/,/g, '');
    const endBC = BC_ONLY.test(g.endEra || '');
    let ok;
    if (endBC || (!g.endEra && BC_ONLY.test(era))) {
      ok = Number(end) < Number(start);
      if (ok && !era) era = 'BC';
    } else if (/^\s+[a-z]/.test(g.range)) {
      // "1990 and 5 more" is no range; only a dash or slash abbreviates the end year.
      ok = end.length === start.length && Number(end) > Number(start);
    } else if (end.length < start.length) {
      ok = Number(start.slice(0, start.length - end.length) + end) > Number(start);
    } else {
      ok = Number(end) > Number(start) || Boolean(g.endEra);
    }
    if (!ok) length = m.indices.groups.range[0] - m.index;
  }

  const before = text.slice(0, m.index);
  const after = text.slice(m.index + length);
  // A number right after a digit and a dash or slash ends a range whose start was not a year. A caret marks an
  // exponent, as in "10^15".
  if (/\p{N}[.,^]$|\p{N}\s*[-–—/~]\s*$/u.test(before) || /^[.,:^]\p{N}/u.test(after)) return null;
  if (/^['’]?s(?!\p{L})/u.test(after) || /^\p{L}/u.test(after)) return null;
  if (NOT_BEFORE.test(before) || NOT_AFTER.test(after) || AGES.test(after)) return null;
  if (!bare && ACRONYM_BEFORE.test(before)) return null;

  const isBC = BC_ONLY.test(era);
  const hasEra = Boolean(era || g.pre);
  if (g.num.includes(',') && !isBC) return null;
  const n = Number(g.num.replace(/,/g, ''));
  if (n === 0) return null;
  if (isBC) {
    if (-n < MIN_YEAR) return null;
  } else if (n > currentYear()) {
    return null;
  } else if (n < 1000 && !hasEra && (!bare || MONTH_AFTER.test(after) || MONTH_BEFORE.test(before))) {
    return null;
  }
  return { year: isBC ? -n : n, index: m.index, length: length, leading: LEADING.test(before) };
}

/**
 * First year in free text, skipping numbers that read as counts, prices, measures, references, or decades.
 * @param {string} text
 * @param {{bare?: boolean}} [opts] bare: accept numbers under 1000 without an era marker, as in a year column
 * @returns {{year: number, index: number, length: number, leading: boolean}|null} index and length span the
 *   whole date or range; leading is true when only whitespace, a bullet, or a qualifier like "By" comes before it
 */
export function findYear(text, opts) {
  const bare = Boolean(opts && opts.bare);
  let best = null;
  PATTERNS.forEach(function (re, i) {
    re.lastIndex = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      if (best && m.index > best.index) break;
      const found = readMatch(text, m, bare && i === PATTERNS.length - 1);
      if (found) {
        if (!best || found.index < best.index || (found.index === best.index && found.length > best.length)) {
          best = found;
        }
        break;
      }
      re.lastIndex = m.index + 1;
    }
  });
  return best;
}

/**
 * Whole-string year parse for host input. Accepts a signed integer, an era-marked year, a circa year, or a date,
 * with era and circa markers in any case.
 * @param {string} text
 * @returns {number|null} null when the text is anything but a single valid year
 */
export function parseYear(text) {
  const trimmed = String(text ?? '').trim()
    .replace(/^(?:circa|ca\.?|c\.)\s*/i, function (m) { return m.toLowerCase(); })
    .replace(/^a\.?d\.?(?=\s*\d)|(?<!\p{L})(?:b\.?c\.?(?:e\.?)?|a\.?d\.?|c\.?e\.?)$/iu, function (m) {
      return m.toUpperCase();
    });
  if (/^-\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    return n >= MIN_YEAR && n !== 0 ? n : null;
  }
  const found = findYear(trimmed, { bare: true });
  if (!found || found.index !== 0 || found.length !== trimmed.length) return null;
  return found.year;
}

/**
 * Whether text shows a year's number, as a label that would give the answer away. Thousands commas count, as in
 * "9,600 BC", and so does the end of a range cut to two digits, as "1946–47" shows 1947.
 * @param {string} text
 * @param {number|null} year
 * @returns {boolean}
 */
export function mentionsYear(text, year) {
  if (year == null || !text) return false;
  const plain = text.replace(THOUSANDS, '$1').replace(SHORT_RANGE, function (m, century, start, separator, end) {
    const full = Number(century) * 100 + Number(end) + (Number(end) < Number(start) ? 100 : 0);
    return century + start + separator + full;
  });
  const digits = String(Math.abs(year));
  for (let i = plain.indexOf(digits); i !== -1; i = plain.indexOf(digits, i + 1)) {
    if (!DIGIT.test(plain.charAt(i - 1)) && !DIGIT.test(plain.charAt(i + digits.length))) return true;
  }
  return false;
}
