"""Storage, theme and DOM helpers: js/store.js (state, UI and list keys, cross-window events, pruning, the full-store
fallback), js/theme.js (cycle, early apply, storage that throws), js/dom.js, and favicon.svg in both color schemes."""
from playwright.sync_api import sync_playwright

from helpers import *

PAGES = {
    'store.html': '''<!doctype html><html><head><meta charset="utf-8"><link rel="icon" href="/favicon.svg">
<script type="module">
import * as store from '/js/store.js';
import { RULES } from '/js/wiki.js';
window.store = store; window.RULES = RULES; window.hits = [];
store.subscribe(function () { window.hits.push(Date.now()); });
window.ready = true;
</script></head><body></body></html>''',
    'theme.html': '''<!doctype html><html><head><meta charset="utf-8"><link rel="icon" href="/favicon.svg">
<script src="/js/theme.js"></script>
<script>window.early = document.documentElement.dataset.theme || 'auto';</script>
</head><body><button id="theme">t</button></body></html>''',
    'dom.html': '''<!doctype html><html><head><meta charset="utf-8"><link rel="icon" href="/favicon.svg">
<script type="module">
import * as dom from '/js/dom.js';
window.dom = dom; window.ready = true;
</script></head><body><ul id="list"></ul><template id="tpl"><li data-x="1"><strong>x</strong></li></template>
<img id="fav" src="/favicon.svg" width="576" height="512"></body></html>''',
}
K = 'trial-and-era:'


def route(ctx):
    ctx.route(BASE + '__t/**', lambda r: r.fulfill(status=200, content_type='text/html',
                                                   body=PAGES[r.request.url[len(BASE + '__t/'):]]))


def open_page(ctx, name, tag):
    """The test page and a list that collects every console message it logs."""
    page = watch(ctx.new_page(), tag)
    logs = []
    page.on('console', lambda m: logs.append(m.text))
    page.goto(BASE + '__t/' + name)
    if name != 'theme.html':
        page.wait_for_function('() => window.ready === true')
    return page, logs


with sync_playwright() as pw:
    browser = launch(pw)

    # Store basics.
    ctx = browser.new_context()
    route(ctx)
    a, a_logs = open_page(ctx, 'store.html', 'A')
    a.evaluate('localStorage.clear()')
    rules = a.evaluate('RULES')
    default = a.evaluate('store.defaultState()')
    check(default == {
        'settings': {'handSize': 4}, 'players': [], 'nextId': 1, 'phase': 'lobby',
        'deck': {'cards': [], 'sources': [], 'nextCardId': 1}, 'gameNumber': 0, 'placementSeq': 0, 'game': None,
    }, 'defaultState shape %s' % default)
    check(a.evaluate(
        '(() => { const s = store.defaultState(); s.deck.cards.push(1); s.settings.handSize = 9;'
        ' const t = store.defaultState(); return t.deck.cards.length === 0 && t.settings.handSize === 4; })()'),
        'defaultState is fresh each call')
    check(a.evaluate('store.load()') == default, 'load with nothing saved is default')

    saved = dict(default, players=[{'id': 1, 'name': 'Ada'}], nextId=2, phase='playing', gameNumber=1,
                 game={'number': 1, 'cards': {'1': {'id': 1, 'label': 'Telephone', 'year': 1876}}, 'timeline': [1],
                       'pending': {'cardId': None, 'index': None}})
    a.evaluate('s => store.save(s)', saved)
    check(a.evaluate('store.load()') == saved, 'save/load round trip')
    check(a.evaluate('k => localStorage.getItem(k) !== null', GAME_KEY), 'game key name')

    a.evaluate("k => localStorage.setItem(k, '{not json')", GAME_KEY)
    check(a.evaluate('store.load()') == default, 'corrupt game falls back to default')
    check(any('Could not read saved game' in l for l in a_logs), 'corrupt game is logged')
    a.evaluate("k => localStorage.setItem(k, 'null')", GAME_KEY)
    check(a.evaluate('store.load()') == default, 'null game falls back to default')

    check(a.evaluate('store.loadUi()') == {}, 'loadUi with nothing saved is {}')
    ui_state = {'search': 'Timeline of inventions', 'filter': 'tel', 'view': 'flagged', 'build': {'title': 'X'}}
    a.evaluate('u => store.saveUi(u)', ui_state)
    check(a.evaluate('store.loadUi()') == ui_state, 'saveUi/loadUi round trip')
    check(a.evaluate('k => localStorage.getItem(k) !== null', UI_KEY), 'ui key name')
    a.evaluate("k => localStorage.setItem(k, '{')", UI_KEY)
    check(a.evaluate('store.loadUi()') == {}, 'corrupt ui is {}')

    check(a.evaluate("store.getList('Nothing here')") is None, 'getList miss is null')
    lst = {'title': 'Timeline of historic inventions: part 1', 'labelMode': 'text',
           'cards': [{'title': 'Telephone', 'year': 1876, 'flags': []}], 'dropped': 3}
    a.evaluate('l => store.putList(l)', lst)
    check(a.evaluate('t => store.getList(t)', lst['title']) == lst, 'putList/getList round trip')
    check(a.evaluate('k => localStorage.getItem(k) !== null', f'{K}list:r{rules}:' + lst['title']),
          'list key uses rules and canonical title')
    a.evaluate("k => localStorage.setItem(k, '{')", f'{K}list:r{rules}:Broken')
    check(a.evaluate("store.getList('Broken')") is None, 'corrupt list is null')

    # Storage events reach a second page in the same context, and only for game state.
    b, _ = open_page(ctx, 'store.html', 'B')
    a.evaluate('window.hits = []')

    def b_hits_after(js, arg=None):
        before = b.evaluate('hits.length')
        a.evaluate(js, arg)
        a.wait_for_timeout(300)
        return b.evaluate('hits.length') - before

    check(b_hits_after('s => store.save(s)', dict(saved, nextId=3)) == 1, 'save wakes other page')
    check(b.evaluate('store.load().nextId') == 3, 'other page loads saved state')
    check(b_hits_after('s => store.save(s)', dict(saved, nextId=3)) == 0, 'unchanged save does not wake')
    check(b_hits_after("store.saveUi({search: 'abc'})") == 0, 'saveUi does not wake')
    check(b_hits_after("store.putList({title: 'Q', cards: []})") == 0, 'putList does not wake')
    check(b_hits_after("k => localStorage.setItem(k, 'dark')", K + 'theme') == 0, 'theme key does not wake')
    check(b_hits_after('localStorage.clear()') == 1, 'clear wakes other page')
    check(a.evaluate('hits.length') == 0, 'saving page hears nothing itself')
    b.close()

    # Prune drops other rules' lists and older versions, and keeps newer versions and other keys.
    a.evaluate('localStorage.clear()')
    keep = [K + 'v1', K + 'v1:ui', K + 'v2', K + 'v2:ui', K + 'v10', K + 'theme',
            f'{K}list:r{rules}:Foo', f'{K}list:r{rules}:Bar: baz', 'timeline:v0', 'other']
    drop = [K + 'v0', K + 'v0:ui', f'{K}list:r{rules - 1}:Foo', f'{K}list:r{rules + 1}:Foo',
            f'{K}list:r{rules}0:Foo', K + 'list:junk']
    a.evaluate('keys => keys.forEach(k => localStorage.setItem(k, "{}"))', keep + drop)
    a.evaluate('store.prune()')
    left = sorted(a.evaluate('Object.keys(localStorage)'))
    check(left == sorted(keep), 'prune keeps current and newer, drops the rest: %s' % left)

    # A full store drops cached lists and tries once more.
    a.evaluate('localStorage.clear()')
    a.evaluate("([t, u]) => { localStorage.setItem(t, 'dark'); localStorage.setItem(u, '{}'); }", [K + 'theme', UI_KEY])
    filled = a.evaluate('''p => { const chunk = 'x'.repeat(256 * 1024); let i = 0;
        try { for (;;) { localStorage.setItem(p + 'fill' + i, chunk); i++; } }
        catch (err) { return [i, err.name]; } }''', f'{K}list:r{rules}:')
    check(filled[0] > 0 and filled[1] == 'QuotaExceededError', 'storage filled to quota %s' % filled)
    big = dict(saved, padding='y' * (1024 * 1024))
    try:
        a.evaluate('s => store.save(s)', big)
        ok = True
    except Exception as e:
        ok = str(e)
    check(ok is True, 'save succeeds by clearing lists: %s' % ok)
    check(a.evaluate("p => Object.keys(localStorage).filter(k => k.startsWith(p)).length", K + 'list:') == 0,
          'lists cleared on full store')
    check(any('localStorage is full; clearing cached lists' in l for l in a_logs), 'full-store clear is logged')
    check(a.evaluate("([t, u]) => localStorage.getItem(t) === 'dark' && localStorage.getItem(u) === '{}'",
                     [K + 'theme', UI_KEY]), 'theme and ui survive the clear')
    check(a.evaluate('store.load().padding.length') == 1024 * 1024, 'big state round trips')
    too_big = a.evaluate('''() => { try { store.save({padding: 'z'.repeat(20 * 1024 * 1024)}); return 'no throw'; }
        catch (err) { return err.name; } }''')
    check(too_big == 'QuotaExceededError', 'save throws when still full: ' + too_big)
    check(a.evaluate('store.load().padding.length') == 1024 * 1024, 'failed save leaves previous state')
    check(a.evaluate(
        "(() => { try { store.saveUi({p: 'z'.repeat(20 * 1024 * 1024)}); return true; } catch (e) { return false; } })()"),
        'saveUi never throws when full')
    check(a.evaluate(
        "(() => { try { store.putList({title: 'T', p: 'z'.repeat(20 * 1024 * 1024)}); return true; }"
        " catch (e) { return false; } })()"), 'putList never throws when full')
    a.evaluate("k => localStorage.setItem(k, '{}')", f'{K}list:r{rules}:Keep')
    other = a.evaluate('''() => { const real = Storage.prototype.setItem;
        Storage.prototype.setItem = function () { throw new TypeError('boom'); };
        try { store.save({}); return 'no throw'; } catch (err) { return err.name; }
        finally { Storage.prototype.setItem = real; } }''')
    check(other == 'TypeError', 'non-quota error rethrown: ' + other)
    check(a.evaluate('k => localStorage.getItem(k) === "{}"', f'{K}list:r{rules}:Keep'), 'non-quota error keeps lists')
    a.evaluate('localStorage.clear()')
    a.close()

    # Theme.
    t, _ = open_page(ctx, 'theme.html', 'theme')
    t.evaluate('localStorage.clear()')
    t.reload()
    btn = t.locator('#theme')
    check(t.evaluate('early') == 'auto' and btn.get_attribute('aria-label') == 'Theme: auto', 'theme starts auto')
    seq = []
    for _ in range(3):
        btn.click()
        seq.append((t.evaluate("document.documentElement.dataset.theme || 'auto'"),
                    t.evaluate('k => localStorage.getItem(k)', K + 'theme'), btn.get_attribute('aria-label'),
                    btn.get_attribute('title')))
    check(seq == [('light', 'light', 'Theme: light', 'Theme: light'), ('dark', 'dark', 'Theme: dark', 'Theme: dark'),
                  ('auto', None, 'Theme: auto', 'Theme: auto')], 'theme cycles auto, light, dark, auto: %s' % seq)
    btn.click()
    btn.click()
    t.reload()
    check(t.evaluate('early') == 'dark', 'stored theme applies before first paint')
    check(t.locator('#theme').get_attribute('aria-label') == 'Theme: dark', 'stored theme labels the button')
    t.evaluate("k => localStorage.setItem(k, 'blue')", K + 'theme')
    t.reload()
    check(t.evaluate('early') == 'auto', 'unknown stored theme is auto')
    t.evaluate('localStorage.clear()')
    t.close()

    # Theme with storage that throws.
    ctx2 = browser.new_context()
    route(ctx2)
    ctx2.add_init_script("Object.defineProperty(window, 'localStorage', {get() { throw new DOMException('denied', "
                         "'SecurityError'); }});")
    t2, t2_logs = open_page(ctx2, 'theme.html', 'theme-nostorage')
    t2.locator('#theme').click()
    check(t2.evaluate('document.documentElement.dataset.theme') == 'light', 'theme works without storage')
    check(any('Could not read theme' in l for l in t2_logs) and any('Could not save theme' in l for l in t2_logs),
          'theme storage failures are logged')
    ctx2.close()

    # DOM helpers and the favicon's fill in each color scheme.
    for scheme, want in (('light', (0x01, 0x72, 0xad)), ('dark', (0x01, 0xaa, 0xff))):
        c = browser.new_context(color_scheme=scheme)
        route(c)
        d, _ = open_page(c, 'dom.html', 'dom-' + scheme)
        d.wait_for_function("() => document.getElementById('fav').complete")
        px = d.evaluate('''() => { const img = document.getElementById('fav');
            const cv = document.createElement('canvas'); cv.width = 576; cv.height = 512;
            const g = cv.getContext('2d'); g.drawImage(img, 0, 0, 576, 512);
            return Array.from(g.getImageData(288, 256, 1, 1).data); }''')
        check(tuple(px[:3]) == want and px[3] == 255, f'favicon fill in {scheme}: {px}')
        if scheme == 'light':
            res = d.evaluate('''() => { const { $, icon, fromTemplate, fmt } = dom;
                const li = fromTemplate('tpl');
                const anim = li.animate([{opacity: 0}, {opacity: 1}], 1000);
                const ok = { owner: li.ownerDocument === document, tag: li.tagName, deep: li.querySelector('strong') !== null,
                  timeline: anim.timeline === document.timeline, fresh: fromTemplate('tpl') !== li };
                $('list').append(li);
                const i = icon('timeline');
                return Object.assign(ok, { dollar: $('list') === document.getElementById('list'),
                  iconClass: i.className, iconHidden: i.getAttribute('aria-hidden'), fmt: fmt.format(12345),
                  playState: anim.playState }); }''')
            check(res['owner'] and res['tag'] == 'LI' and res['deep'] and res['fresh'],
                  'fromTemplate imports into the live document %s' % res)
            check(res['timeline'] and res['playState'] == 'running', 'fromTemplate copy animates %s' % res)
            check(res['iconClass'] == 'fa-solid fa-timeline' and res['iconHidden'] == 'true', 'icon markup %s' % res)
            check(res['dollar'] and res['fmt'] == '12,345', '$ and fmt %s' % res)
        c.close()

    ctx.close()
    browser.close()

finish('store')
