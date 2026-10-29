// Year parsing and formatting in js/years.js: what counts as a year, the span it covers, and year leaks in labels.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatYear, parseYear, findYear, mentionsYear, yearlessText } from '../js/years.js';

const NOW = new Date().getFullYear();

function year(text, opts) {
  const found = findYear(text, opts);
  return found ? found.year : null;
}

test('formatYear', function () {
  assert.equal(formatYear(1876), '1876');
  assert.equal(formatYear(-500), '500 BC');
  assert.equal(formatYear(79), '79');
  assert.equal(formatYear(null), '');
});

test('findYear finds years', function () {
  const cases = {
    'c. 1440': 1440,
    'c.1440': 1440,
    'ca. 1440 printing press': 1440,
    'circa 1440': 1440,
    '1876–77': 1876,
    '1876-77': 1876,
    '1876–1877': 1876,
    '1876/77': 1876,
    'March 10, 1876': 1876,
    'Mar. 10, 1876': 1876,
    '10 March 1876': 1876,
    'March 1876': 1876,
    'March 10–12, 1876': 1876,
    '1876-03-10': 1876,
    '500 BC': -500,
    '500 BCE': -500,
    '500 B.C.': -500,
    'AD 79': 79,
    '79 AD': 79,
    '79 CE': 79,
    '3000–2500 BC': -3000,
    'c. 3500 BC – c. 3000 BC': -3500,
    '10,000 BC': -10000,
    '15 March 44 BC': -44,
    'Bell patents the telephone in 1876.': 1876,
    'Toy Story (1995)': 1995,
    '1876: Bell': 1876,
    '1914 – 1918': 1914,
    'In 1876, Bell': 1876,
    'released November 22, 1995[1]': 1995,
    '1876 - 5 people killed': 1876,
    '1998': 1998
  };
  for (const [text, expected] of Object.entries(cases)) assert.equal(year(text), expected, text);
});

test('findYear skips non-years', function () {
  const cases = ['1,000', '$1500', '500 km', 'No. 12', 'Top 100', 'Windows 95', 'Boeing 747', 'p. 1876',
    'pp. 1876–1880', 'page 1500', 'chapter 1200', 'Chapter 1900', '50%', '1500%', '3rd century BC',
    '5th century', '1440s', 'the 1870s', "1990's", '2.6 Ma', '90 kya', '1500 BP', '2000 years ago',
    '1500 metres', '1,500 km', '$1,500', '1500 m', '12,000 BC', '12345', String(NOW + 1), '0', '1876.5',
    '1500 °C', 'vol. 1999', 'Issue 1998', 'sold 1500 copies', 'March 10', 'US$1500', '€1500', '1500 million',
    '#1999', 'version 2000', 'Route 1999', 'COBOL – ISO/IEC 1989', 'GOTRAN (IBM 1620)', 'RFC 2616'];
  for (const text of cases) assert.equal(findYear(text), null, text);
});

test('findYear needs an era or a year column for numbers under 1000', function () {
  assert.equal(year('in 793'), null);
  assert.equal(year('793', { bare: true }), 793);
  assert.equal(year('Top 100', { bare: true }), null);
  assert.equal(year('Windows 95', { bare: true }), null);
  assert.equal(year('No. 12', { bare: true }), null);
  assert.equal(year('500 km', { bare: true }), null);
  assert.equal(year('March 10, 1876', { bare: true }), 1876);
  assert.equal(year('10 March 1876', { bare: true }), 1876);
  assert.equal(year('March 10', { bare: true }), null);
  assert.equal(year('10 March', { bare: true }), null);
  assert.equal(year('1995', { bare: true }), 1995);
  assert.equal(year('NA 1996', { bare: true }), 1996);
  assert.equal(year('AD 1500'), 1500);
  assert.equal(year('500 BC'), -500);
});

test('findYear reports the span and whether it leads', function () {
  assert.deepEqual(findYear('c. 1440 – printing press'), { year: 1440, index: 0, length: 7, leading: true });
  assert.deepEqual(findYear('Telephone (1876)'), { year: 1876, index: 11, length: 4, leading: false });
  assert.deepEqual(findYear('  March 10, 1876: call'), { year: 1876, index: 2, length: 14, leading: true });
  assert.deepEqual(findYear('1876–77 season'), { year: 1876, index: 0, length: 7, leading: true });
  assert.deepEqual(findYear('1876 - 5 dead people'), { year: 1876, index: 0, length: 4, leading: true });
  assert.equal(findYear('The 1,000 and then 1876').year, 1876);
  assert.equal(findYear('Top 100 in 1999').year, 1999);
  assert.deepEqual(findYear('By 407 BC: wheelbarrow'), { year: -407, index: 3, length: 6, leading: true });
  assert.deepEqual(findYear('Before 40 BC: trip hammer'), { year: -40, index: 7, length: 5, leading: true });
  assert.deepEqual(findYear('400 and 300 BC: zero'), { year: -400, index: 0, length: 14, leading: true });
  assert.deepEqual(findYear('After 500: charkha', { bare: true }), { year: 500, index: 6, length: 3, leading: true });
  assert.deepEqual(findYear('280 – 550: chaturanga', { bare: true }), { year: 280, index: 0, length: 9, leading: true });
  assert.equal(findYear('Bell, in 1876').leading, false);
  assert.equal(findYear('Between 1876 and 1880').year, 1876);
  assert.equal(findYear('1990 and 5 more').length, 4);
});

test('parseYear takes a whole string', function () {
  const cases = { '1876': 1876, '-500': -500, '500 BC': -500, 'AD 79': 79, 'c. 1440': 1440, '79': 79,
    ' 1876 ': 1876, 'March 10, 1876': 1876, '79 CE': 79, '-10000': -10000, '500 bc': -500, '500 bce': -500,
    'ad 79': 79, '79 ad': 79, '79 ce': 79, 'C. 1440': 1440, 'Circa 1440': 1440, 'ca. 1440': 1440, '500 b.c.': -500 };
  for (const [text, expected] of Object.entries(cases)) assert.equal(parseYear(text), expected, text);
  const bad = ['', '0', '-0', '1440s', '1876 telephone', 'abc', String(NOW + 1), '-10001', '12,000 BC',
    '3rd century BC', '1,000', null, undefined];
  for (const text of bad) assert.equal(parseYear(text), null, String(text));
});

test('mentionsYear', function () {
  assert.equal(mentionsYear('1906 San Francisco earthquake', 1906), true);
  assert.equal(mentionsYear('Windows 95', 1995), false);
  assert.equal(mentionsYear('Library of 500 BC', -500), true);
  assert.equal(mentionsYear('12345', 2345), false);
  assert.equal(mentionsYear('Telephone', null), false);
  assert.equal(mentionsYear('1946–47 Chicago Stags season', 1947), true);
  assert.equal(mentionsYear('1946–47 Chicago Stags season', 1946), true);
  assert.equal(mentionsYear('1999–00 season', 2000), true);
  assert.equal(mentionsYear('1946–47 Chicago Stags season', 1948), false);
  assert.equal(mentionsYear('Score 21–17', 2117), false);
});

test('BC ranges with thousands commas give their start', function () {
  assert.equal(year('c. 7,100 – 5,700 BCE'), -7100);
  assert.equal(year('9,500 – 9,000 BC'), -9500);
  assert.equal(year('10,000 BC – 8,000 BC'), -10000);
  assert.equal(year('c. 9,500 – 6,000 BCE', { bare: true }), -9500);
  const found = findYear('10,000 BC – 8,000 BC');
  assert.equal(found.index, 0);
  assert.equal(found.length, '10,000 BC – 8,000 BC'.length);
});

test('AD numbers with thousands commas are not years', function () {
  assert.equal(year('1,000 – 2,000'), null);
  assert.equal(year('1876–1,000 people'), 1876);
});

test('a tilde separates a range', function () {
  assert.equal(year('2494~2345 BC'), -2494);
  assert.equal(year('470~469 BC', { bare: true }), -470);
  assert.equal(year('1550~1560'), 1550);
  assert.equal(year('c. 300 BC~'), -300);
});

test('counts, exponents and squared units are not years', function () {
  assert.equal(year('1 trillion', { bare: true }), null);
  assert.equal(year('110–120 trillion', { bare: true }), null);
  assert.equal(year('2 quadrillion', { bare: true }), null);
  assert.equal(year('10^15 (1 quadrillion)', { bare: true }), null);
  assert.equal(year('1.16×10^67', { bare: true }), null);
  assert.equal(year('covers 1500 km²'), null);
  assert.equal(year('a 1200 m² hall'), null);
  assert.equal(year('1500 million'), null);
});

test('ordinary years parse next to those quantity rules', function () {
  assert.equal(year('2000', { bare: true }), 2000);
  assert.equal(year('In 1876 Bell patents the telephone'), 1876);
  assert.equal(year('1876^'), 1876);
  assert.equal(parseYear('1876'), 1876);
});

test('mentionsYear sees a year written with a thousands comma', function () {
  assert.equal(mentionsYear('Jericho has evidence of settlement dating back to 9,600 BC.', -9600), true);
  assert.equal(mentionsYear('Settled by 10,000 BC', -10000), true);
  assert.equal(mentionsYear('Settled by 10,000 BC', -1000), false);
  assert.equal(mentionsYear('9,600 people', -600), false);
  assert.equal(mentionsYear('Telephone (1876)', 1876), true);
});

test('yearlessText drops the year where it leads, ends or sits in parentheses', function () {
  assert.equal(yearlessText('1985 video game', 1985), 'Video game');
  assert.equal(yearlessText('Video game by Nintendo (1985)', 1985), 'Video game by Nintendo');
  assert.equal(yearlessText('Toy introduced in 1959', 1959), 'Toy introduced');
  assert.equal(yearlessText('American rock band', 1965), 'American rock band');
  assert.equal(yearlessText('Nintendo 64 game', 1996), 'Nintendo 64 game');
  assert.equal(yearlessText('', 1985), '');
  assert.equal(yearlessText(undefined, 1985), '');
});

test('yearlessText hides text that still dates the card', function () {
  assert.equal(yearlessText('Film released in 1995 by Disney', 1995), '');
  assert.equal(yearlessText('1986 sequel to the 1985 video game', 1986), '');
  assert.equal(yearlessText('Fad of the 1990s', 1997), '');
  assert.equal(yearlessText('19th-century painting', 1850), '');
  assert.equal(yearlessText('Eruption in AD 79 that buried Pompeii', 79), '');
  assert.equal(yearlessText('1985', 1985), '');
});
