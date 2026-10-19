"""Deck building in the host console against a mock Wikipedia: save failures when storage is full, edits and hand
size typed while a build lands, label modes and exclusion, importing many sources, the storage warning before Deal,
the deck table's empty-state row, and arrow keys on the strip."""
from playwright.sync_api import sync_playwright

from helpers import *

WATCH_MESSAGES = """() => { window.__msgs = []; new MutationObserver(() => {
  const t = document.getElementById('message').textContent.trim(); if (t) window.__msgs.push(t); })
  .observe(document.getElementById('message'), {childList: true, subtree: true}); }"""
EMPTY_NOTE = """(() => { const tr = document.querySelector('#deck-table tbody tr:not([data-id])');
  return tr && !tr.hidden ? tr.textContent : null; })()"""
WARN = 'browser storage'


def cards(page):
    return {c['id']: c for c in state(page)['deck']['cards']}


def build(page, mock, title, hold=False):
    """Start building title; with hold, its title lookups wait until land()."""
    mock.hold = {'query'} if hold else set()
    page.fill('#source-form input[name=q]', title)
    page.click('#source-form button[type=submit]')
    if hold:
        page.wait_for_timeout(300)


def land(page, mock):
    mock.hold = set()
    mock.release()
    page.wait_for_function("() => document.getElementById('build').hidden", timeout=10000)
    page.wait_for_timeout(200)


def message(page):
    return page.inner_text('#message')


def wordy_state(n):
    """A deck of n cards with long labels and context, to size the deal warning."""
    st = setup_state(0, players=('Ana', 'Ben', 'Cy'), hand=4)
    st['deck']['sources'] = [{'name': 'Typed', 'title': None, 'labelMode': 'text'}]
    st['deck']['cards'] = [card(i, year=1000 + i % 1000, label=('Entry %d ' % i).ljust(300, 'x'),
                                textLabel=('Entry %d ' % i).ljust(300, 'x'), linkLabel='Entry %d' % i,
                                context='c' * 3000) for i in range(1, n + 1)]
    st['deck']['nextCardId'] = n + 1
    return st


def t_savefail(page, mock):
    seed(page, setup_state(6))
    page.evaluate(FILL, 0)
    page.click('summary:has-text("Type cards")')
    page.fill('#card-form input[name=label]', 'Telephone')
    page.fill('#card-form input[name=year]', '1876')
    page.click('#card-form button[type=submit]')
    page.wait_for_timeout(200)
    check('Could not save' in message(page), 'card form shows the save failure: ' + message(page))
    page.fill('#bulk-form textarea', '1895 Radio\n1903 Airplane')
    page.click('#bulk-form button[type=submit]')
    page.wait_for_timeout(200)
    check('Could not save' in message(page), 'bulk add shows the save failure: ' + message(page))
    page.set_input_files('#import-deck', json_file([{'label': 'Imported %d' % i, 'year': 1500 + i} for i in range(5)]))
    page.wait_for_timeout(400)
    check('Could not save' in message(page), 'import shows the save failure: ' + message(page))
    build(page, mock, 'Alpha')
    page.wait_for_function("() => document.getElementById('build').hidden", timeout=10000)
    page.wait_for_timeout(200)
    check('Could not save' in message(page), 'landing build shows the save failure: ' + message(page))
    check(len(state(page)['deck']['cards']) == 6, 'stored deck kept 6 cards')
    # Once storage has room again, an add reports its cards.
    page.evaluate("localStorage.removeItem('filler')")
    page.fill('#card-form input[name=label]', 'Kettle')
    page.fill('#card-form input[name=year]', '1891')
    page.click('#card-form button[type=submit]')
    page.wait_for_timeout(200)
    check(message(page).strip().startswith('Added 1 card'), 'a saved add reports its cards: ' + message(page))


def t_handsize(page, mock):
    seed(page, setup_state(30))
    build(page, mock, 'Alpha', hold=True)
    hs = page.locator('#hand-size')
    hs.click()
    page.keyboard.press('Control+a')
    page.keyboard.type('6')
    land(page, mock)
    check(hs.input_value() == '6', 'typed hand size survives a landing build: ' + hs.input_value())
    page.keyboard.press('Enter')
    page.wait_for_timeout(300)
    st = state(page)
    sizes = sorted({len(v) for v in st['game']['hands'].values()}) if st['game'] else None
    check(st['settings']['handSize'] == 6 and sizes == [6], 'Enter deals the typed hand size %s %s' % (st['settings'], sizes))
    seed(page, setup_state(30))
    hs.fill('0')
    hs.press('Tab')
    page.wait_for_timeout(100)
    check(hs.input_value() == '4', 'an invalid hand size reverts on change: ' + hs.input_value())


def t_edit(page, mock):
    seed(page, setup_state(6))
    for field, value, want in (('label', 'Telephone 1001', {'label': 'Telephone 1001', 'include': False}),
                               ('year', '1999', {'year': 1999, 'include': True})):
        build(page, mock, 'Src ' + field, hold=True)
        inp = page.locator('#deck-table tr[data-id="1"] [data-field=%s]' % field)
        inp.click()
        page.keyboard.press('Control+a')
        page.keyboard.type(value)
        land(page, mock)
        c1 = cards(page)[1]
        got = {k: c1[k] for k in want}
        check(got == want, field + ' edit saved when a build lands %s' % got)
        row = page.evaluate("""() => { const tr = document.querySelector('#deck-table tr[data-id="1"]');
          return { label: tr.querySelector('[data-field=label]').value, year: tr.querySelector('[data-field=year]').value,
                   include: tr.querySelector('[data-field=include]').checked, flags: tr.cells[4].textContent,
                   connected: tr.isConnected }; }""")
        want_row = {'label': c1['label'], 'year': str(c1['year']), 'include': c1['include'],
                    'flags': ', '.join({'leak': 'year in label', 'noyear': 'no year', 'guess': 'loose year',
                                        'duplicate': 'duplicate'}[f] for f in c1['flags']), 'connected': True}
        check(row == want_row, field + ' row matches saved state %s %s' % (row, want_row))
        focus = page.evaluate("""() => { const a = document.activeElement;
          return [a.dataset.field || a.tagName, a.closest('tr') && a.closest('tr').dataset.id, a.selectionStart,
                  (a.value || '').length]; }""")
        check(focus == [field, '1', focus[3], focus[3]], field + ' focus stays in the field, caret at the end %s' % focus)
        rows = page.locator('#deck-table tr[data-id]').count()
        check(rows == len(state(page)['deck']['cards']), field + ' build added its rows: %d' % rows)
        page.keyboard.type('x')
        page.keyboard.press('Tab')
        page.wait_for_timeout(100)
        if field == 'label':
            ok = str(cards(page)[1]['label']).endswith('x')
        else:
            ok = page.locator('#deck-table tr[data-id="1"] [data-field=year]').get_attribute('aria-invalid') == 'true'
        check(ok, field + ' typing continues in the same field %s' % cards(page)[1][field])


def t_labelmode(page, mock):
    st = setup_state(12)
    st['deck']['sources'].append({'name': 'Gizmos', 'title': 'Gizmos', 'labelMode': 'link'})
    st['deck']['cards'] += [
        card(13, source='Gizmos', title='Gadget', linkLabel='Gadget', textLabel='In 1950 the gadget appeared',
             label='Gadget', year=1950, yearFrom='list'),
        card(14, source='Gizmos', title='Doohickey', linkLabel='Doohickey', textLabel='In 1960 the doohickey came',
             label='Doohickey', year=1960, yearFrom='list'),
        card(15, source='Gizmos', title='Thing', linkLabel='Thing', textLabel='A thing', label='Thing', year=None,
             yearFrom=None, include=False, flags=['noyear'])]
    st['deck']['nextCardId'] = 16
    seed(page, st)
    page.uncheck('#deck-table tr[data-id="13"] [data-field=include]')
    sel = page.locator('#sources select[aria-label="Labels for Gizmos"]')
    sel.select_option('text')
    page.wait_for_timeout(100)
    c = cards(page)
    check(not c[13]['include'] and not c[14]['include'], 'labels with their year are excluded %s %s' % (c[13], c[14]))
    sel.select_option('link')
    page.wait_for_timeout(100)
    c = cards(page)
    check(not c[13]['include'], 'a card the host unchecked stays out after a round trip')
    check(c[14]['include'], 'a card a flag excluded comes back after a round trip')
    year = page.locator('#deck-table tr[data-id="15"] [data-field=year]')
    year.fill('1970')
    year.press('Tab')
    page.wait_for_timeout(100)
    check(cards(page)[15]['include'], 'typing a year includes a card that had none')
    page.check('#deck-table tr[data-id="13"] [data-field=include]')
    sel.select_option('text')
    page.wait_for_timeout(100)
    check(not cards(page)[13]['include'], 'a re-checked card is excluded again by a new year in its label')
    sel.select_option('link')
    page.wait_for_timeout(100)
    check(cards(page)[13]['include'], 'and included again when that clears')


def t_import(page, mock):
    n = 500
    deck = [{'label': 'Card %d' % i, 'year': 1000 + i, 'source': 'S%d' % i} for i in range(n)]
    count = "k => (JSON.parse(localStorage.getItem(k)) || {deck: {cards: []}}).deck.cards.length"
    seed(page, setup_state(0))
    page.set_input_files('#import-deck', json_file(deck))
    page.wait_for_function(count + ' >= %d' % n, arg=GAME_KEY, timeout=120000)
    st = state(page)
    check(len(st['deck']['cards']) == n and len(st['deck']['sources']) == n,
          'an import of %d sources adds every card and source: %d, %d' % (n, len(st['deck']['cards']),
                                                                          len(st['deck']['sources'])))
    page.evaluate(WATCH_MESSAGES)
    page.set_input_files('#import-deck', json_file(deck))
    page.wait_for_function("() => window.__msgs.some(m => m.includes('already in the deck'))", timeout=120000)
    check(len(state(page)['deck']['cards']) == n, 're-import skips every card')


def t_arrows(page, mock):
    seed(page, setup_state(12))
    page.click('#deal')
    help_text = ' '.join(page.inner_text('#strip-help').split())
    check('arrow keys' in help_text and 'Enter' in help_text, 'strip help says arrows move and Enter picks: ' + help_text)
    page.locator('#strip button[data-gap="0"]').focus()
    page.keyboard.press('ArrowRight')
    page.wait_for_timeout(100)
    pending = state(page)['game']['pending']['index']
    focused = page.evaluate('document.activeElement.dataset.gap')
    page.keyboard.press('Enter')
    page.wait_for_timeout(100)
    check(pending is None and focused == '1' and state(page)['game']['pending']['index'] == 1,
          'arrows move focus and Enter picks the gap %s %s' % (pending, focused))


def t_quota(page, mock):
    seed(page, setup_state(30))
    check(WARN not in page.inner_text('#deal-summary'), 'a small deck has no storage warning')
    # Leave room for the deck but not for the game dealt from it.
    page.evaluate(FILL, 500)
    page.reload()
    page.wait_for_selector('#setup:not([hidden])')
    summary = page.inner_text('#deal-summary')
    check(WARN in summary, 'a game that will not fit warns before Deal: ' + summary)
    check(not page.locator('#deal').is_disabled(), 'Deal stays enabled')
    shot(page, 'deck-storage-warning')
    page.evaluate("localStorage.removeItem('filler')")
    page.reload()
    page.wait_for_selector('#setup:not([hidden])')
    check(WARN not in page.inner_text('#deal-summary'), 'freed storage clears the warning')
    # Dealt, 1200 such cards come to about 95% of the quota and 600 to about 47%.
    for n, warn in ((1200, True), (600, False)):
        seed(page, wordy_state(n))
        page.wait_for_selector('#deck-table tbody tr[data-id]')
        summary = page.inner_text('#deal-summary')
        check((WARN in summary) == warn, 'a %d-card deck %s: %s' % (n, 'warns' if warn else 'does not warn', summary))


def t_empty_row(page, mock):
    seed(page, setup_state(0))
    note = page.evaluate(EMPTY_NOTE)
    check(note == 'No cards yet. Build some from a Wikipedia page or type them.', 'empty deck shows the empty note: %s' % note)
    seed(page, setup_state(12))
    check(page.evaluate(EMPTY_NOTE) is None, 'a deck with matches hides the note')
    page.fill('#deck-filter', 'zzz')
    page.wait_for_timeout(300)
    check(page.evaluate(EMPTY_NOTE) == 'No cards match the filter.', 'a filter with no matches shows the note')
    check(page.inner_text('#deck-meta').endswith('showing 0'), 'meta counts no rows: ' + page.inner_text('#deck-meta'))
    page.fill('#deck-filter', 'card 1')
    page.wait_for_timeout(300)
    check(page.locator('#deck-table tbody tr[data-id]:visible').count() == 4 and page.evaluate(EMPTY_NOTE) is None,
          '"card 1" shows cards 1, 10, 11 and 12')
    page.fill('#deck-filter', '')
    page.wait_for_timeout(300)
    page.select_option('#deck-view', 'noyear')
    check(page.evaluate(EMPTY_NOTE) == 'No cards match the filter.', 'an empty view shows the note')
    page.select_option('#deck-view', 'all')
    check(page.locator('#deck-table tbody tr[data-id]:visible').count() == 12, 'back to all shows every row')
    page.reload()
    page.wait_for_selector('#setup:not([hidden])')
    check(page.locator('#deck-table tbody tr[data-id]:visible').count() == 12, 'filter and view survive a reload')


TESTS = [t_savefail, t_handsize, t_edit, t_labelmode, t_import, t_arrows, t_quota, t_empty_row]

with sync_playwright() as pw:
    browser = launch(pw)

    def isolated(fn):
        def run():
            ctx = new_context(browser)
            try:
                fn(watch(ctx.new_page(), fn.__name__[2:]), MockWiki(ctx))
            finally:
                ctx.close()
        return run

    sections({fn.__name__[2:]: isolated(fn) for fn in TESTS})
    browser.close()

finish('deck')
