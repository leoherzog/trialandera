"""Deck building against live Wikipedia and Wikidata, run only with --live: search suggestions, building from a
suggestion and from a URL, the list cache, a refresh mid-build, label modes and edits, the undated view, export and
import, then a deal played with the scoreboard open."""
import json

from playwright.sync_api import sync_playwright

from helpers import *

PIXAR = 'List of Pixar films'
INVENTIONS = 'Timeline of historic inventions'


def deck(page):
    return state(page)['deck']


def by_id(page, cid):
    return next(c for c in deck(page)['cards'] if c['id'] == cid)


def by_label(cards, label):
    return next(c for c in cards if c['label'] == label)


def wait_built(page, title, timeout=240000):
    page.wait_for_function("t => Array.from(document.querySelectorAll('#sources tbody th')).some(th => th.textContent === t)",
                           arg=title, timeout=timeout)
    page.wait_for_selector('#build', state='hidden')


def first_row(page, text):
    """Filter the deck table to text and return the first visible row's card id."""
    page.fill('#deck-filter', text)
    page.wait_for_timeout(300)
    page.press('#deck-filter', 'Tab')
    return int(page.locator('#deck-table tbody tr[data-id]:visible').first.get_attribute('data-id'))


def clear_filter(page):
    page.fill('#deck-filter', '')
    page.wait_for_timeout(300)
    page.press('#deck-filter', 'Tab')


with sync_playwright() as pw:
    browser = launch(pw)
    ctx = new_context(browser)
    page = open_host(ctx)
    requests = []
    page.on('request', lambda r: requests.append(r.url))
    add_players(page, ['Dana', 'Eli'])
    with ctx.expect_page() as pop:
        page.click('#start-game')
    popup = watch(pop.value, 'scoreboard')
    popup.set_viewport_size({'width': 1280, 'height': 720})
    popup.wait_for_load_state()

    # Suggestions arrive after the debounce, and picking one builds it at once.
    q = page.locator('#source-form input[name=q]')
    q.press_sequentially('List of Pixar', delay=40)
    page.wait_for_function("() => document.querySelectorAll('#suggestions option').length > 0", timeout=20000)
    opts = page.evaluate("Array.from(document.querySelectorAll('#suggestions option')).map(o => o.value)")
    check(PIXAR in opts, 'suggestions %s' % opts)
    page.evaluate("""t => { const i = document.querySelector('#source-form input[name=q]'); i.value = t;
      i.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertReplacementText' })); }""", PIXAR)
    page.wait_for_selector('#build:not([hidden])')
    wait_built(page, PIXAR)
    d = deck(page)
    src = d['sources'][0]
    check(src['title'] == PIXAR and src['labelMode'] == 'link', 'Pixar source in link mode %s' % src)
    check(len(d['cards']) >= 25, 'Pixar cards %d' % len(d['cards']))
    check(all(c['source'] == PIXAR for c in d['cards']), 'cards tagged with their source')
    check(all(c['include'] == ('noyear' not in c['flags'] and 'leak' not in c['flags']) for c in d['cards']),
          'cards start excluded exactly when undated or showing their year')
    check(by_label(d['cards'], 'Toy Story')['year'] == 1995, 'Toy Story 1995')
    check(ui(page).get('building') is None, 'no build left in UI state')
    shot(page, 'live-pixar')

    # Removing the source and building it again by URL uses the cached list.
    n = len(d['cards'])
    page.click('#sources tbody button')
    check(deck(page)['cards'] == [] and deck(page)['sources'] == [], 'source removed with its cards')
    requests.clear()
    q.fill('https://en.wikipedia.org/wiki/List_of_Pixar_films')
    q.press('Enter')
    page.wait_for_function('k => JSON.parse(localStorage.getItem(k)).deck.cards.length > 0', arg=GAME_KEY,
                           timeout=20000)
    check(len(deck(page)['cards']) == n, 'same cards from the cache')
    check(not any('action=parse' in u for u in requests), 'the cached list fetches no page')

    q.fill('https://de.wikipedia.org/wiki/Telefon')
    q.press('Enter')
    check('English' in page.inner_text('#message'), 'a non-English URL is refused: ' + page.inner_text('#message'))

    # A timeline page by URL, with the host refreshed mid-build.
    q.fill('https://en.wikipedia.org/wiki/Timeline_of_historic_inventions')
    q.press('Enter')
    page.wait_for_function("() => /Resolving titles|Wikidata/.test(document.querySelector('#build-label').textContent)",
                           timeout=60000)
    check(ui(page)['building']['title'] == INVENTIONS, 'the build is saved in UI state')
    page.reload()
    page.wait_for_selector('#setup:not([hidden])')
    check(page.locator('#build').is_visible(), 'the build resumes after a refresh')
    wait_built(page, INVENTIONS)
    check(ui(page)['building'] is None, 'the finished build leaves UI state')
    d = deck(page)
    inv = [c for c in d['cards'] if c['source'] == INVENTIONS]
    src = next(s for s in d['sources'] if s['name'] == INVENTIONS)
    check(len(inv) > 300 and src['labelMode'] == 'text', 'inventions %d %s' % (len(inv), src))
    check(any(c['yearFrom'] == 'wikidata' for c in inv), 'some years come from Wikidata')
    dups = [c for c in inv if 'duplicate' in c['flags']]
    check(len(dups) < 20, 'entry-text cards that share an article are not duplicates: %d' % len(dups))
    shot(popup, 'live-sb-setup')

    # An edited label survives label-mode switches, and clearing it restores the built one.
    rid = first_row(page, 'Ratatouille')
    lab = page.locator(f'#deck-table tr[data-id="{rid}"] input[data-field=label]')
    lab.fill('Ratatouille, the rat chef film')
    lab.press('Tab')
    check(by_id(page, rid)['labelEdited'], 'label edited')
    toy = by_label(deck(page)['cards'], 'Toy Story 3')
    sel = page.locator('#sources select[aria-label="Labels for ' + PIXAR + '"]')
    sel.focus()
    sel.select_option('text')
    toy2 = by_id(page, toy['id'])
    check(toy2['label'] == toy2['textLabel'], 'text mode uses the entry text: ' + toy2['label'])
    check(by_id(page, rid)['label'] == 'Ratatouille, the rat chef film', 'edited label kept')
    check(page.evaluate('document.activeElement.tagName') == 'SELECT', 'focus stays on the select')
    sel.select_option('link')
    check(by_id(page, toy['id'])['label'] == 'Toy Story 3', 'back to the article title')
    check(next(s for s in deck(page)['sources'] if s['name'] == PIXAR)['labelMode'] == 'link', 'link mode saved')
    lab.fill('')
    lab.press('Tab')
    c = by_id(page, rid)
    check(not c['labelEdited'] and c['label'] == c['linkLabel'], 'clearing an edited label restores the built one')
    lab.fill('Ratatouille, the rat chef film')
    lab.press('Tab')

    # An undated card takes a typed year and stays in the view until the view changes.
    clear_filter(page)
    page.select_option('#deck-view', 'noyear')
    page.wait_for_timeout(100)
    row = page.locator('#deck-table tbody tr[data-id]:visible').first
    nid = int(row.get_attribute('data-id'))
    c = by_id(page, nid)
    check(c['year'] is None and not c['include'], 'an undated card starts excluded')
    yin = row.locator('input[data-field=year]')
    yin.fill('nonsense')
    yin.press('Tab')
    check(yin.get_attribute('aria-invalid') == 'true', 'a bad year is marked invalid')
    yin.fill('c. 1500')
    yin.press('Tab')
    c = by_id(page, nid)
    check(c['year'] == 1500 and c['yearFrom'] == 'typed' and c['include'] and 'noyear' not in c['flags'],
          'year edit %s' % c)
    check(yin.get_attribute('aria-invalid') is None and yin.input_value() == '1500', 'year input normalized')
    check(page.locator(f'#deck-table tr[data-id="{nid}"]').is_visible(), 'the row stays until the view changes')
    page.select_option('#deck-view', 'all')
    page.wait_for_timeout(100)
    xid = first_row(page, 'Cars 2')
    page.locator(f'#deck-table tr[data-id="{xid}"] input[data-field=include]').uncheck()
    check(not by_id(page, xid)['include'], 'card excluded')
    clear_filter(page)
    snapshot = deck(page)

    # Export, clear and import.
    with page.expect_download() as dl:
        page.click('#export-deck')
    exported = open(dl.value.path()).read()
    data = json.loads(exported)
    check(data['format'] == 'trial-and-era-deck' and len(data['cards']) == len(snapshot['cards']), 'export file')
    page.click('#clear-deck')
    page.click('#confirm-clear button[value=confirm]')
    check(deck(page)['cards'] == [] and deck(page)['sources'] == [], 'deck cleared')
    page.set_input_files('#import-deck', json_file(exported))
    page.wait_for_function('k => JSON.parse(localStorage.getItem(k)).deck.cards.length > 0', arg=GAME_KEY)
    d = deck(page)
    strip_id = lambda c: {k: v for k, v in c.items() if k != 'id'}
    check([strip_id(c) for c in d['cards']] == [strip_id(c) for c in snapshot['cards']], 'import matches export')
    check(d['sources'] == snapshot['sources'], 'sources restored')
    check(by_label(d['cards'], 'Ratatouille, the rat chef film')['labelEdited'], 'edited label survives import')
    check(any(c['year'] == 1500 and c['yearFrom'] == 'typed' for c in d['cards']), 'edited year survives import')
    check(not by_label(d['cards'], 'Cars 2')['include'], 'exclusion survives import')

    # Deal and play with the scoreboard open.
    page.evaluate('window.scrollTo(0, 0)')
    page.click('#deal')
    page.wait_for_selector('#playing:not([hidden])')
    st = state(page)
    g = st['game']
    check(all(c['year'] is not None for c in g['cards'].values()), 'dealt cards have years')
    excluded = {c['id'] for c in st['deck']['cards'] if not c['include']}
    check(not excluded & {int(k) for k in g['cards']}, 'excluded cards stay out of the game')
    popup.wait_for_function("() => !document.querySelector('#sb-turn').hidden")
    for want in (True, False, True):
        g = state(page)['game']
        cid = g['hands'][str(active(g))][0]
        gap = correct_gap(g, cid) if want else wrong_gap(g, cid)
        page.drag_and_drop(f'#hand label[data-card="{cid}"]', f'#strip button[data-gap="{gap}"]')
        popup.wait_for_function("() => document.querySelector('#sb-timeline > article[data-ghost]')")
        page.click('#reveal')
        check(state(page)['game']['log'][-1]['correct'] == want, 'placement result')
        synced(page, popup)
    shot(popup, 'live-sb-playing')
    over = popup.evaluate("""() => {
      const stage = document.getElementById('stage').getBoundingClientRect();
      return Array.from(document.querySelectorAll('#sb-hand > article, #sb-players > article, #sb-player'))
        .filter(el => { const r = el.getBoundingClientRect(); return r.bottom > stage.bottom + 1 || r.right > stage.right + 1; })
        .map(el => el.textContent.slice(0, 40));
    }""")
    check(not over, 'Wikipedia labels fit on the scoreboard stage %s' % over)
    browser.close()

finish('wiki_live')
