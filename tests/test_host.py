"""Host console flow: lobby, typed and bulk cards, deck table edits, filter and view, export, clear and import, hand
size, turns by click, drag and keyboard, undo, refresh, play to a winner, play again, new game and sudden death.
Then a second session for a bad import, the New game dialog's Escape, a second host tab, and reload when over."""
import json

from playwright.sync_api import sync_playwright

from helpers import *

BULK = """1876 Telephone
Radio, 1895
Printing press (c. 1440)
1903 Wright Flyer
Light bulb, 1879
Steam engine, 1712
Television, 1927
1969 Apollo 11 lands on the Moon
Great Pyramid of Giza, 2560 BC
Rome founded, 753 BC
Penicillin, 1928
World Wide Web, 1989
1957 Sputnik 1
Transistor, 1947
Gunpowder, 850 AD
1608 Telescope
Microscope, 1590
Windows 95
Typewriter, 1868
1885 Automobile
Dynamite, 1867
Phonograph 1877
1837 Telegraph
Bicycle, 1817
Vaccine 1796
1926 Liquid-fuel rocket
Jet engine, 1939
not a card at all
1971 Microprocessor
Smartphone, 2007
San Francisco earthquake of 1906, 1906
Telephone, 1877
"""


def card_by_id(page, cid):
    return next(c for c in state(page)['deck']['cards'] if c['id'] == int(cid))


def visible_rows(page):
    return page.locator('#deck-table tbody tr[data-id]:visible').count()


def flow(browser):
    ctx = new_context(browser)
    page = open_host(ctx)

    # Every Font Awesome span becomes an SVG of a known icon.
    page.wait_for_timeout(500)
    missing = page.evaluate("""() => Array.from(document.querySelectorAll('svg.svg-inline--fa'))
      .filter(s => !s.getAttribute('data-icon') || s.getAttribute('data-icon') === 'question')
      .map(s => s.outerHTML.slice(0, 80))""")
    check(not missing, 'missing icons %s' % missing)

    # ---------- Lobby ----------
    add_players(page, ['Ana', 'Ben', 'Cat', 'Dee'])
    check(page.locator('#player-list tr').count() == 4, 'four players')
    page.click('#player-list tr:nth-child(2) [data-act=up]')
    check(page.locator('#player-list tr:nth-child(1) th').inner_text().strip().endswith('Ben'), 'Ben moved up')
    page.click('#player-list tr:nth-child(4) [data-act=remove]')
    check(page.locator('#player-list tr').count() == 3, 'removed Dee')
    check([pl['name'] for pl in state(page)['players']] == ['Ben', 'Ana', 'Cat'], 'player order')
    shot(page, 'host-lobby')

    add_players(page, ['P4', 'P5', 'P6', 'P7', 'P8'])
    check(page.locator('#player-list tr').count() == 8 and
          page.evaluate("document.querySelector('#add-player fieldset').disabled") and
          page.locator('#add-player input').is_disabled(), 'lobby full at 8')
    check(page.evaluate('document.activeElement.id') == 'start-game', 'focus moves to start when full')
    for _ in range(5):
        page.click('#player-list tr:last-child [data-act=remove]')
    check(page.locator('#player-list tr').count() == 3, 'back to 3')

    # ---------- Start: the scoreboard popup ----------
    with ctx.expect_page() as pop:
        page.click('#start-game')
    popup = watch(pop.value, 'scoreboard')
    popup.wait_for_load_state()
    check('scoreboard.html' in popup.url, 'popup url ' + popup.url)
    check(popup.evaluate('window.name') == 'trial-and-era-scoreboard', 'popup name')
    check(page.locator('#setup').is_visible(), 'setup visible')
    check(page.evaluate('document.activeElement.name') == 'q', 'search focused')
    check(page.locator('#open-scoreboard').is_visible(), 'open scoreboard button visible in setup')
    check(page.locator('#deal').is_disabled(), 'deal disabled on empty deck')

    # ---------- Typed cards ----------
    page.click('details:has(#card-form) > summary')
    page.fill('#card-form input[name=label]', 'Printing telegraph')
    page.fill('#card-form input[name=year]', 'nope')
    page.click('#card-form button[type=submit]')
    check(page.get_attribute('#card-form input[name=year]', 'aria-invalid') == 'true', 'bad typed year flagged')
    page.fill('#card-form input[name=year]', '1846')
    page.press('#card-form input[name=year]', 'Enter')
    check(page.get_attribute('#card-form input[name=year]', 'aria-invalid') is None, 'typed year ok')
    check(page.evaluate('document.activeElement.name') == 'label', 'focus back to label')
    st = state(page)
    check(len(st['deck']['cards']) == 1 and st['deck']['cards'][0]['year'] == 1846, 'typed card added')
    check(st['deck']['sources'] == [{'name': 'Typed', 'title': None, 'labelMode': 'text'}], 'typed source')

    page.fill('#bulk-form textarea', BULK)
    page.click('#bulk-form button[type=submit]')
    left_lines = page.input_value('#bulk-form textarea')
    check(left_lines.split('\n') == ['Windows 95', 'not a card at all'], 'unparsed lines stay: %r' % left_lines)
    st = state(page)
    cards = {}
    for c in st['deck']['cards']:
        cards.setdefault(c['label'], c)
    check(cards['Telephone']['year'] == 1876 and cards['Radio']['year'] == 1895, 'year first and last')
    check(cards['Printing press']['year'] == 1440, 'circa in parens')
    check(cards['Great Pyramid of Giza']['year'] == -2560, 'BC')
    check(cards['Gunpowder']['year'] == 850, 'AD era')
    check(cards['Apollo 11 lands on the Moon']['year'] == 1969, 'year leading a sentence')
    leak = cards['San Francisco earthquake of 1906']
    check('leak' in leak['flags'] and not leak['include'], 'year in label excluded')
    tel = [c for c in st['deck']['cards'] if c['label'] == 'Telephone']
    check(len(tel) == 2 and all('duplicate' in c['flags'] for c in tel), 'duplicate labels flagged')
    n_cards = len(st['deck']['cards'])

    page.fill('#bulk-form textarea', '1876 Telephone\nRadio, 1895')
    page.click('#bulk-form button[type=submit]')
    check(len(state(page)['deck']['cards']) == n_cards, 'repeats skipped')
    shot(page, 'host-setup-deck')

    # ---------- Deck table edits ----------
    rid = page.evaluate("""() => Array.from(document.querySelectorAll('#deck-table [data-field=label]'))
      .find(i => i.value === 'Radio').closest('tr').dataset.id""")
    radio = page.locator(f'#deck-table tr[data-id="{rid}"]')
    year_in = radio.locator('[data-field=year]')
    year_in.fill('eighteen')
    year_in.press('Tab')
    check(year_in.get_attribute('aria-invalid') == 'true', 'bad year aria-invalid')
    check(year_in.input_value() == 'eighteen', 'bad text kept')
    c = card_by_id(page, rid)
    check(c['year'] is None and 'noyear' in c['flags'] and not c['include'], 'bad year clears and flags noyear')
    check(page.evaluate("document.activeElement.closest('tr') && document.activeElement.closest('tr').dataset.id")
          is not None, 'focus stays in table after change')
    year_in.fill('AD 1895')
    year_in.press('Enter')
    check(year_in.get_attribute('aria-invalid') is None, 'fixed year')
    check(year_in.input_value() == '1895', 'year normalized')
    c = card_by_id(page, rid)
    check(c['year'] == 1895 and c['flags'] == [] and c['include'] and c['yearFrom'] == 'typed',
          'year restored and included')

    lab = radio.locator('[data-field=label]')
    lab.fill('Radio 1895')
    lab.press('Tab')
    c = card_by_id(page, rid)
    check('leak' in c['flags'] and not c['include'] and c['labelEdited'], 'label leak excluded')
    check(page.evaluate('document.activeElement.dataset.field') == 'year', 'tab moved to year input')
    lab.fill('Wireless radio')
    lab.press('Tab')
    c = card_by_id(page, rid)
    check(c['flags'] == [] and c['include'] and c['label'] == 'Wireless radio', 'label fixed, included')
    radio.locator('[data-field=include]').uncheck()
    check(not card_by_id(page, rid)['include'], 'include unchecked')
    radio.locator('[data-field=include]').check()

    page.fill('#deck-filter', 'telephone')
    page.wait_for_timeout(300)
    check(visible_rows(page) == 2, 'filter telephone')
    page.fill('#deck-filter', '')
    page.wait_for_timeout(300)
    page.select_option('#deck-view', 'excluded')
    page.wait_for_timeout(100)
    check(visible_rows(page) == len([c for c in state(page)['deck']['cards'] if not c['include']]), 'excluded view')
    page.select_option('#deck-view', 'noyear')
    page.wait_for_timeout(100)
    check(visible_rows(page) == 0, 'noyear view empty')
    page.select_option('#deck-view', 'all')
    page.wait_for_timeout(100)

    # ---------- Export, clear, import ----------
    with page.expect_download() as dl:
        page.click('#export-deck')
    exported = open(dl.value.path()).read()
    data = json.loads(exported)
    check(dl.value.suggested_filename == 'trial-and-era-deck.json', 'export file name')
    check(data['format'] == 'trial-and-era-deck' and len(data['cards']) == len(state(page)['deck']['cards']), 'export')
    check('id' not in data['cards'][0], 'export drops ids')
    before = state(page)['deck']
    page.click('#clear-deck')
    check(page.locator('#confirm-clear').is_visible(), 'clear dialog open')
    page.click('#confirm-clear button[value=cancel]')
    check(len(state(page)['deck']['cards']) == len(before['cards']), 'cancel keeps deck')
    page.click('#clear-deck')
    page.click('#confirm-clear button[value=confirm]')
    page.wait_for_function('k => JSON.parse(localStorage.getItem(k)).deck.cards.length === 0', arg=GAME_KEY)
    check(state(page)['deck']['cards'] == [] and state(page)['deck']['sources'] == [], 'deck cleared')
    page.set_input_files('#import-deck', json_file(exported))
    page.wait_for_function('k => JSON.parse(localStorage.getItem(k)).deck.cards.length > 0', arg=GAME_KEY)
    after = state(page)['deck']
    strip = lambda cs: [{k: v for k, v in c.items() if k != 'id'} for c in cs]
    check(strip(after['cards']) == strip(before['cards']), 'import round trip')
    check(after['sources'] == before['sources'], 'sources round trip')
    page.set_input_files('#import-deck', json_file(exported))
    page.wait_for_timeout(300)
    check(len(state(page)['deck']['cards']) == len(before['cards']), 'reimport merges as skips')

    # ---------- Hand size and the deal blocker ----------
    hs = page.locator('#deal-form input[name=handSize]')
    hs.fill('8')
    hs.press('Tab')
    st = state(page)
    check(st['settings']['handSize'] == 8, 'hand size 8')
    ready = len([c for c in st['deck']['cards'] if c['include'] and c['year'] is not None])
    check(page.locator('#deal').is_disabled() == (ready < 3 * 8 + 1), 'deal disabled when short')
    hs.fill('3')
    hs.press('Tab')
    check(not page.locator('#deal').is_disabled(), 'deal enabled')
    shot(page, 'host-setup-ready')

    page.click('#deal')
    check(page.locator('#playing').is_visible(), 'playing')
    st = state(page)
    g = st['game']
    check(st['phase'] == 'playing' and g['number'] == 1, 'game 1')
    check(page.locator('#hand input[type=radio]').count() == 3, 'hand of 3')
    check(page.evaluate('document.activeElement.name') == 'card', 'focus on hand after deal')
    hand_text = page.inner_text('#hand')
    for cid in g['hands'][str(active(g))]:
        c = g['cards'][str(cid)]
        check(str(abs(c['year'])) not in hand_text or str(abs(c['year'])) in c['label'], 'no year in hand')
    check(page.locator('#strip button[data-gap]').count() == 2, 'two gaps')
    check(page.locator('#reveal').is_disabled(), 'reveal disabled at start')

    # Turn 1: click a card, then the correct gap.
    g = state(page)['game']
    cid = g['hands'][str(active(g))][0]
    page.check(f'#hand input[value="{cid}"]')
    check(state(page)['game']['pending']['cardId'] == cid, 'pending card saved')
    check(page.locator('#reveal').is_disabled(), 'reveal still disabled without gap')
    gap = correct_gap(g, cid)
    page.click(f'#strip button[data-gap="{gap}"]')
    check(state(page)['game']['pending'] == {'cardId': cid, 'index': gap}, 'pending gap saved')
    check(page.get_attribute(f'#strip button[data-gap="{gap}"]', 'aria-pressed') == 'true', 'gap pressed')
    shot(page, 'host-playing-pending')
    page.click('#reveal')
    check(page.inner_text('#result').strip().startswith('Correct: '), 'correct readout')
    check(page.locator('#strip article[data-latest]').count() == 1, 'latest highlighted')

    # Turn 2: a wrong placement by drag and drop, revealed with Enter.
    g = state(page)['game']
    p2 = active(g)
    cid = next(c for c in g['hands'][str(p2)] if wrong_gap(g, c) is not None)
    wg = wrong_gap(g, cid)
    page.drag_and_drop(f'#hand label[data-card="{cid}"]', f'#strip button[data-gap="{wg}"]')
    check(state(page)['game']['pending'] == {'cardId': cid, 'index': wg}, 'drop sets pending')
    check(page.evaluate('document.activeElement.id') == 'reveal', 'focus to reveal after drop')
    page.keyboard.press('Enter')
    res = page.inner_text('#result').strip()
    check(res.startswith('Wrong: ') and 'draws a new card' in res, 'wrong readout: ' + res)
    check(len(state(page)['game']['hands'][str(p2)]) == 3, 'hand size unchanged on wrong')
    shot(page, 'host-playing-wrong')

    # Turn 3: correct by drag and drop.
    g = state(page)['game']
    cid = g['hands'][str(active(g))][1]
    page.drag_and_drop(f'#hand label[data-card="{cid}"]', f'#strip button[data-gap="{correct_gap(g, cid)}"]')
    page.click('#reveal')
    check(page.inner_text('#result').strip().startswith('Correct'), 'drag and drop correct')

    # Turn 4: keyboard only.
    g = state(page)['game']
    hand = g['hands'][str(active(g))]
    page.locator('#hand input').first.focus()
    page.keyboard.press('ArrowRight')
    g = state(page)['game']
    check(g['pending']['cardId'] == hand[1], 'arrow selects next card %s' % g['pending'])
    check(page.evaluate('document.activeElement.value') == str(hand[1]), 'focus kept on radio after commit')
    target = correct_gap(g, hand[1])
    page.keyboard.press('Tab')
    focused = page.evaluate('document.activeElement.dataset.gap')
    check(focused == '0', 'tab lands on first gap, got %s' % focused)
    for _ in range(target):
        page.keyboard.press('ArrowRight')
    check(page.evaluate('document.activeElement.dataset.gap') == str(target), 'arrows move to gap')
    page.keyboard.press('Enter')
    check(state(page)['game']['pending']['index'] == target, 'enter selects gap')
    check(page.evaluate('document.activeElement.dataset.gap') == str(target), 'focus kept on gap')
    page.keyboard.press('End')
    check(page.evaluate('document.activeElement.dataset.gap') == str(len(g['timeline'])), 'End')
    page.keyboard.press('Home')
    check(page.evaluate('document.activeElement.dataset.gap') == '0', 'Home')
    for _ in range(target):
        page.keyboard.press('ArrowRight')
    page.keyboard.press('Tab')
    check(page.evaluate('document.activeElement.id') == 'reveal', 'tab to reveal')
    page.keyboard.press('Enter')
    check(page.inner_text('#result').strip().startswith('Correct'), 'keyboard correct ' + page.inner_text('#result'))
    check(page.evaluate('document.activeElement.name') == 'card', 'focus back on hand')

    page.click('#strip button[data-gap="0"]')
    page.click('#strip button[data-gap="0"]')
    check(state(page)['game']['pending']['index'] is None, 'gap toggles off')

    log_len = len(state(page)['game']['log'])
    page.click('#undo')
    st = state(page)
    check(len(st['game']['log']) == log_len - 1, 'undo pops')
    check(st['game']['pending']['cardId'] is not None, 'undo restores pending')
    page.click('#reveal')

    # Refresh mid-game keeps the picked card.
    g = state(page)['game']
    cid = g['hands'][str(active(g))][0]
    page.check(f'#hand input[value="{cid}"]')
    page.reload()
    page.wait_for_selector('#playing:not([hidden])')
    check(page.is_checked(f'#hand input[value="{cid}"]'), 'pending card restored after reload')
    check(page.locator('#strip button[data-gap]').count() == len(g['timeline']) + 1, 'strip restored')

    # ---------- Play to a winner, mixing in wrong guesses ----------
    turns = 0
    while state(page)['phase'] == 'playing' and turns < 200:
        g = state(page)['game']
        cid = g['hands'][str(active(g))][0]
        wrong = turns % 3 == 1 and wrong_gap(g, cid) is not None
        page.check(f'#hand input[value="{cid}"]')
        page.click(f'#strip button[data-gap="{wrong_gap(g, cid) if wrong else correct_gap(g, cid)}"]')
        page.click('#reveal')
        turns += 1
    check(state(page)['phase'] == 'over', 'game over')
    check(page.locator('#over').is_visible(), 'over visible')
    check(page.evaluate('document.activeElement.id') == 'over-heading', 'focus over heading')
    shot(page, 'host-over')

    page.click('#undo-over')
    check(state(page)['phase'] == 'playing', 'undo from over')
    check(page.evaluate('document.activeElement.name') == 'card', 'focus hand after undo from over')
    check(not page.locator('#reveal').is_disabled(), 'pending restored so reveal enabled')
    page.click('#reveal')
    check(state(page)['phase'] == 'over', 'over again')

    page.click('#play-again')
    st = state(page)
    check(st['phase'] == 'playing' and st['game']['number'] == 2, 'game 2')
    check(st['game']['seats'][0] == st['players'][1]['id'], 'first seat rotated')
    check(st['game']['log'] == [], 'fresh log')

    page.click('details:has(#new-game) > summary')
    page.click('#new-game')
    page.click('#confirm-new button[value=confirm]')
    page.wait_for_function("k => JSON.parse(localStorage.getItem(k)).phase === 'lobby'", arg=GAME_KEY)
    st = state(page)
    check(st['phase'] == 'lobby' and st['game'] is None and len(st['deck']['cards']) > 0 and len(st['players']) == 3,
          'new game keeps deck and players')
    check(st['placementSeq'] > 0, 'placementSeq kept')

    # The named popup is reused, so no new page opens. Every move is right, so sudden death comes.
    page.click('#start-game')
    page.click('#deal')
    st = state(page)
    check(st['game']['seats'][0] == st['players'][0]['id'], 'new game starts at seat 1')
    sd_seen = False
    while state(page)['phase'] == 'playing':
        g = state(page)['game']
        cid = g['hands'][str(active(g))][0]
        page.check(f'#hand input[value="{cid}"]')
        page.click(f'#strip button[data-gap="{correct_gap(g, cid)}"]')
        page.click('#reveal')
        st = state(page)
        if st['phase'] == 'playing' and st['game']['suddenDeath'] and not sd_seen:
            sd_seen = True
            check(page.inner_text('#round-title').startswith('Sudden death'), 'sudden death heading')
            shot(page, 'host-sudden-death')
    check(sd_seen, 'sudden death reached')
    page.click('#edit-deck')
    st = state(page)
    check(st['phase'] == 'setup' and st['game'] is None, 'edit deck clears game')
    ctx.close()


def extras(browser):
    ctx = new_context(browser)
    page = open_host(ctx)
    add_players(page, ['Ana', 'Ben'])
    page.click('#start-game')
    page.click('details:has(#card-form) > summary')
    page.fill('#bulk-form textarea', BULK)
    page.click('#bulk-form button[type=submit]')

    page.set_input_files('#import-deck', json_file({'nope': 1}, 'bad.json'))
    page.wait_for_timeout(300)
    check('Could not import' in page.inner_text('#message'), 'bad import message: ' + page.inner_text('#message'))

    page.click('#deal')
    g = state(page)['game']
    cid = g['hands'][str(active(g))][2]
    page.click(f'#hand label[data-card="{cid}"]')
    check(state(page)['game']['pending']['cardId'] == cid, "clicking a card's text selects it")

    page.click('details:has(#new-game) > summary')
    page.click('#new-game')
    page.keyboard.press('Escape')
    page.wait_for_timeout(200)
    check(state(page)['phase'] == 'playing', 'Escape on the New game dialog keeps the game')

    # A second host tab's change reaches this one through the storage event.
    other = watch(ctx.new_page(), 'tab2')
    other.goto(BASE + 'index.html')
    other.wait_for_selector('#playing:not([hidden])')
    gap = correct_gap(state(other)['game'], cid)
    other.click(f'#strip button[data-gap="{gap}"]')
    page.wait_for_function('g => document.querySelector(`#strip button[data-gap="${g}"]`).ariaPressed === "true"', arg=gap)
    check(not page.locator('#reveal').is_disabled(), 'first tab sees the pending gap from the second')
    other.close()

    while state(page)['phase'] == 'playing':
        g = state(page)['game']
        c = g['hands'][str(active(g))][0]
        page.check(f'#hand input[value="{c}"]')
        gap = correct_gap(g, c)
        if g['pending']['index'] != gap:
            page.click(f'#strip button[data-gap="{gap}"]')
        page.click('#reveal')
    page.reload()
    page.wait_for_selector('#over:not([hidden])')
    check(page.locator('#open-scoreboard').is_visible(), 'reload when over restores the over screen')

    # Enter on a checked radio reveals through implicit submission.
    page.click('#undo-over')
    page.keyboard.press('Enter')
    check(state(page)['phase'] == 'over', 'Enter on the hand reveals')
    ctx.close()


with sync_playwright() as pw:
    browser = launch(pw)
    flow(browser)
    extras(browser)
    browser.close()

finish('host')
