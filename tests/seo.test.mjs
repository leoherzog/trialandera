// Search and link-preview metadata: the splash page, robots.txt and sitemap.xml name one site URL, the images they
// point to exist at the sizes the tags state, and the host console and scoreboard stay out of search.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SITE = 'https://trialandera.spitball.show/';

function read(path) {
  return readFileSync(new URL('../' + path, import.meta.url));
}

// Width and height from a PNG's IHDR chunk.
function pngSize(path) {
  const png = read(path);
  return [png.readUInt32BE(16), png.readUInt32BE(20)];
}

const splash = read('index.html').toString();

function tag(attr, name) {
  const m = splash.match(new RegExp('<meta ' + attr + '="' + name + '" content="([^"]*)">'));
  return m ? m[1] : null;
}

test('the splash page names the site URL', function () {
  assert.ok(splash.includes('<link rel="canonical" href="' + SITE + '">'));
  assert.equal(tag('property', 'og:url'), SITE);
});

test('the splash page describes itself the same way everywhere', function () {
  const description = tag('name', 'description');
  assert.ok(description && description.length <= 160, description);
  assert.equal(tag('property', 'og:description'), description);
  assert.equal(tag('property', 'og:title'), splash.match(/<title>([^<]*)<\/title>/)[1]);
  assert.equal(tag('name', 'twitter:card'), 'summary_large_image');
});

test('the preview image exists at the size its tags state', function () {
  const image = tag('property', 'og:image');
  assert.ok(image.startsWith(SITE), image);
  assert.deepEqual(pngSize(image.slice(SITE.length)),
    [Number(tag('property', 'og:image:width')), Number(tag('property', 'og:image:height'))]);
  assert.ok(tag('property', 'og:image:alt'));
});

test('the touch icon is 180 pixels square', function () {
  assert.ok(splash.includes('<link rel="apple-touch-icon" href="apple-touch-icon.png">'));
  assert.deepEqual(pngSize('apple-touch-icon.png'), [180, 180]);
});

test('the structured data parses and names the site URL', function () {
  const json = JSON.parse(splash.match(/<script type="application\/ld\+json">([^]*?)<\/script>/)[1]);
  assert.ok(json['@graph'].length > 0);
  for (const node of json['@graph']) assert.equal(node.url, SITE);
});

test('robots.txt points at the sitemap, which lists the site URL', function () {
  assert.ok(read('robots.txt').toString().split('\n').includes('Sitemap: ' + SITE + 'sitemap.xml'));
  assert.deepEqual([...read('sitemap.xml').toString().matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => m[1]), [SITE]);
});

test('the host console and scoreboard are kept out of search', function () {
  for (const page of ['host.html', 'scoreboard.html']) {
    assert.ok(read(page).toString().includes('<meta name="robots" content="noindex">'), page);
  }
});
