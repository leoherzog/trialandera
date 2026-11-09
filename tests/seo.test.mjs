// Search and link-preview metadata: the splash page, robots.txt and sitemap.xml name one site URL, the images they
// point to exist at the sizes the tags state, and the host console, scoreboard and 404 page stay out of search.
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

test('the structured data parses, names the site URL and resolves every reference', function () {
  const json = JSON.parse(splash.match(/<script type="application\/ld\+json">([^]*?)<\/script>/)[1]);
  const ids = new Set(json['@graph'].map((node) => node['@id']));
  const own = json['@graph'].filter((node) => node['@id'].startsWith(SITE));
  assert.ok(own.length > 0);
  for (const node of own) assert.equal(node.url, SITE, node['@id']);
  for (const [, id] of JSON.stringify(json).matchAll(/\{"@id":"([^"]*)"\}/g)) assert.ok(ids.has(id), id);
});

test('robots.txt points at the sitemap, which lists the site URL', function () {
  assert.ok(read('robots.txt').toString().split('\n').includes('Sitemap: ' + SITE + 'sitemap.xml'));
  assert.deepEqual([...read('sitemap.xml').toString().matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => m[1]), [SITE]);
});

test('the host console, scoreboard and 404 page are kept out of search', function () {
  for (const page of ['host.html', 'scoreboard.html', '404.html']) {
    assert.ok(read(page).toString().includes('<meta name="robots" content="noindex">'), page);
  }
});

// Pages serves 404.html at any unknown path, where a relative URL would resolve under that path and miss.
test('the 404 page loads local files from the root', function () {
  const page = read('404.html').toString();
  const urls = [...page.matchAll(/\b(?:href|src)="([^"]*)"/g)].map((m) => m[1]);
  assert.ok(urls.length > 0);
  for (const url of urls) assert.ok(/^(https:\/\/|\/)/.test(url), url);
});
