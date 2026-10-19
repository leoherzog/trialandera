"""Whole games through the host console, checking the scoreboard popup against the saved state at every step: theme,
lobby, a typed deck, a game to a single winner with undo and refreshes, play again into sudden death, standings,
edit deck and new game. Then reduced motion, and "Open scoreboard" reusing the named popup mid-game."""
import re

from playwright.sync_api import sync_playwright

from helpers import *

BULK = """1876 Telephone
Radio, 1895
Printing press, c. 1440
1903 Wright Flyer
Light bulb, 1879
Steam engine, 1712
Television, 1927
1969 Apollo 11 Moon landing
Great Pyramid of Giza, 2560 BC
Rome founded, 753 BC
Penicillin, 1928
World Wide Web, 1989
1957 Sputnik 1
Transistor, 1947
Gunpowder, 850 AD
1608 Telescope
Microscope, 1590
Typewriter, 1868
1885 Automobile
Dynamite, 1867
1837 Telegraph
Bicycle, 1817
Vaccine, 1796
1971 Microprocessor
Smartphone, 2007"""


def fy(year):
    return f'{-year} BC' if year < 0 else str(year)


def cards_word(n):
    return f'{n} card' + ('' if n == 1 else 's')


def name_of(st, pid):
    return next(p['name'] for p in st['players'] if p['id'] == pid)


def sb_matches_state(popup, st, label=''):
    """The scoreboard's banner, active player, hand, chips and ghost against the host's state."""
    g = st['game']
    info = sb(popup)
    pid = active(g)
    check(info['draw'] == cards_word(len(g['draw'])) + ' to draw', label + ' draw count ' + info['draw'])
    if st['phase'] == 'over':
        check(info['round'] == 'GAME OVER', label + ' game over banner ' + info['round'])
    elif g['suddenDeath']:
        check(info['round'] == 'SUDDEN DEATH', label + ' sudden death banner ' + info['round'])
    else:
        check(info['round'] == f"ROUND {g['round']}", label + ' round banner ' + info['round'])
    if pid is None:
        return info
    hand = g['hands'][str(pid)]
    check(info['player'] == f"{name_of(st, pid)} · {cards_word(len(hand))} to play", label + ' player ' + str(info['player']))
    check([h['label'] for h in info['hand']] == [g['cards'][str(c)]['label'] for c in hand], label + ' hand labels')
    check(all(h['year'] == '?' for h in info['hand']), label + ' hand years hidden')
    cur = [h['label'] for h in info['hand'] if h['current']]
    pend = g['pending']
    want = [g['cards'][str(pend['cardId'])]['label']] if pend['cardId'] is not None else []
    check(cur == want, label + f' hand highlight {cur} vs {want}')
    # Chips: the others in turn order after the active player, then players sudden death left out.
    seats = g['seats']
    t = g['turn']
    order = seats[t + 1:] + seats[:t]
    out = [p['id'] for p in st['players'] if str(p['id']) in g['hands'] and p['id'] not in seats]
    names = [name_of(st, i) for i in order + out]
    check([c['name'] for c in info['chips']] == names, label + f" chips {[c['name'] for c in info['chips']]} vs {names}")
    nxt = up_next(g)
    for c, i in zip(info['chips'], order + out):
        n = len(g['hands'][str(i)])
        detail = (cards_word(n) + ' left') if n else 'no cards left'
        if i in out:
            detail = 'out · ' + detail
        check(c['detail'] == detail, label + f" chip detail {c['detail']} vs {detail}")
        if i in g['finished']:
            check(c['mark'] == 'FINISHED', label + ' finished mark')
        elif i == nxt:
            check(c['mark'] == 'UP NEXT', label + f" up next mark on {c['name']}")
        else:
            check(c['mark'] is None, label + f" no mark on {c['name']}: {c['mark']}")
    # Timeline: settled cards in order with years, plus the ghost in the pending gap.
    slots = [s for s in info['slots'] if s['result'] != 'wrong']
    ghosts = [i for i, s in enumerate(slots) if s['ghost']]
    if pend['index'] is None:
        check(not ghosts, label + ' no ghost')
    else:
        check(ghosts == [pend['index']], label + f" ghost at {ghosts} vs {pend['index']}")
        gh = slots[ghosts[0]]
        check(gh['year'] == '?', label + ' ghost year hidden')
        want_label = g['cards'][str(pend['cardId'])]['label'] if pend['cardId'] is not None else ''
        check(gh['label'] == want_label, label + ' ghost label')
    line = [s for s in slots if not s['ghost']]
    check([(s['label'], s['year']) for s in line] ==
          [(g['cards'][str(c)]['label'], fy(g['cards'][str(c)]['year'])) for c in g['timeline']], label + ' timeline cards')
    return info


CENTERED = """sel => {
  const t = document.querySelector(sel);
  if (!t) return false;
  const s = t.parentElement;
  const want = Math.max(0, Math.min(s.scrollWidth - s.clientWidth, t.offsetLeft - (s.clientWidth - t.offsetWidth) / 2));
  return Math.abs(s.scrollLeft - want) <= 1;
}"""


def centered(page, sel):
    """Wait until a strip has scrolled to center sel, or as near as its ends allow."""
    page.wait_for_function(CENTERED, arg=sel, timeout=4000)
    check(True, sel + ' centered')


def take_turn(page, popup, want, mode, pick=None, snap=None):
    """Place pick, or the first card in the active hand, right or wrong as want says, by 'click', 'drag' or 'keys',
    and check both windows before and after the reveal. Returns the placement."""
    st = state(page)
    g = st['game']
    pid = active(g)
    hand = list(g['hands'][str(pid)])
    cid = pick if pick is not None else hand[0]
    gap = correct_gap(g, cid) if want else wrong_gap(g, cid)
    check(gap is not None, 'a gap exists')
    if mode == 'click':
        page.click(f'#hand label[data-card="{cid}"]')
        st1 = state(page)
        check(st1['game']['pending']['cardId'] == cid, 'card picked by click')
        synced(page, popup)
        sb_matches_state(popup, st1, 'card only:')
        page.click(f'#strip button[data-gap="{gap}"]')
    elif mode == 'drag':
        page.drag_and_drop(f'#hand label[data-card="{cid}"]', f'#strip button[data-gap="{gap}"]')
        check(page.evaluate('document.activeElement.id') == 'reveal', 'drop moves focus to reveal')
    elif mode == 'keys':
        page.focus(f'#hand input[value="{cid}"]')
        page.keyboard.press('Space')
        page.keyboard.press('Tab')
        cur = int(page.evaluate("document.activeElement.dataset.gap"))
        key = 'ArrowRight' if gap > cur else 'ArrowLeft'
        for _ in range(abs(gap - cur)):
            page.keyboard.press(key)
        page.keyboard.press('Enter')
    st2 = state(page)
    check(st2['game']['pending'] == {'cardId': cid, 'index': gap}, f"pending {st2['game']['pending']} vs {cid},{gap}")
    check(not page.locator('#reveal').is_disabled(), 'reveal enabled')
    pressed = page.locator('#strip button[aria-pressed=true]')
    check(pressed.count() == 1 and pressed.get_attribute('data-gap') == str(gap), 'gap pressed on host')
    check(page.locator(f'#hand input[value="{cid}"]').is_checked(), 'hand radio checked')
    synced(page, popup)
    sb_matches_state(popup, st2, 'pending:')
    centered(popup, '#sb-timeline > [data-ghost]')
    centered(page, '#strip > [aria-pressed=true]')
    if snap:
        shot(page, 'host-' + snap + '-pending')
        shot(popup, 'sb-' + snap + '-pending')
    # No year of a hand card appears on the host.
    hand_text = page.inner_text('#hand')
    for c in st2['game']['hands'][str(pid)]:
        y = st2['game']['cards'][str(c)]['year']
        check(fy(y) not in hand_text, 'host hand hides years')

    page.click('#reveal')
    st3 = state(page)
    g3 = st3['game']
    p = g3['log'][-1]
    check(p['cardId'] == cid and p['index'] == gap and p['playerId'] == pid and p['correct'] == want,
          f'placement {p}')
    year = g['cards'][str(cid)]['year']
    check(p['year'] == year, 'placement year')
    new_hand = g3['hands'][str(pid)]
    if want:
        # Starting sudden death deals each finalist one card.
        extra = 1 if g3['suddenDeath'] and g3['round'] != g['round'] and pid in g3['seats'] else 0
        check(len(new_hand) == len(hand) - 1 + extra and cid not in new_hand, 'correct card leaves the hand')
        check(g3['timeline'].index(cid) == gap and len(g3['timeline']) == len(g['timeline']) + 1, 'joins the timeline')
    else:
        check(len(new_hand) == len(hand), 'wrong keeps hand size')
        check(cid not in new_hand and p['drawn'] in new_hand, 'wrong card swapped for a drawn one')
        check(cid in g3['discard'], 'wrong card discarded')
        check(g3['timeline'] == g['timeline'], 'timeline unchanged')
    result = page.inner_text('#result').strip()
    check(g3['winners'] or result.startswith('Correct' if want else 'Wrong'), 'host result line ' + result)
    check(g3['pending'] == {'cardId': None, 'index': None}, 'pending cleared')
    # Scoreboard shows the result card.
    synced(page, popup)
    want_res = 'correct' if want else 'wrong'
    popup.wait_for_function("r => document.querySelector('#sb-timeline > article[data-result=\"' + r + '\"]')", arg=want_res)
    info = sb(popup)
    res = [s for s in info['slots'] if s['result'] == want_res]
    check(len(res) == 1 and res[0]['mark'] == ('CORRECT' if want else 'WRONG') and res[0]['year'] == fy(year),
          f'scoreboard result {res}')
    check(info['status'].startswith(('CORRECT · ' if want else 'WRONG · ') + fy(year)), 'sb status ' + info['status'])
    if not popup.evaluate("matchMedia('(prefers-reduced-motion: reduce)').matches"):
        check(info['animations'] > 0, 'result animates')
    if snap:
        popup.wait_for_timeout(450)
        shot(popup, 'sb-' + snap + '-' + want_res)
        shot(page, 'host-' + snap + '-' + want_res)
    if g3['winners']:
        return p
    sb_matches_state(popup, st3, 'after reveal:')
    if want:
        centered(popup, '#sb-timeline > [data-result]')
        centered(page, '#strip > [data-latest]')
    return p


def settle(popup):
    """Wait until the scoreboard shows no result card and runs no animation."""
    popup.wait_for_function("() => !document.querySelector('#sb-timeline > article[data-result]') && "
                            "!document.getAnimations().length", timeout=8000)


def over_shown(popup):
    """Wait until the scoreboard shows the standings with the reveal animation done."""
    popup.wait_for_function("() => !document.getElementById('sb-standings').hidden && "
                            "!document.getAnimations().length", timeout=8000)


LINES = '\n'.join(f'Event {i}, {1700 + i * 7}' for i in range(30))


def reduced_motion_and_reopen(browser):
    """Reveals never animate under reduced motion, and "Open scoreboard" reloads the named popup without animating."""
    ctx = new_context(browser, reduced_motion='reduce')
    page = open_host(ctx)
    add_players(page, ['Fay', 'Gus'])
    with ctx.expect_page() as pop:
        page.click('#start-game')
    popup = watch(pop.value, 'scoreboard')
    popup.set_viewport_size({'width': 1280, 'height': 720})
    page.click('details:has(#card-form) > summary')
    page.fill('#bulk-form textarea', LINES)
    page.click('#bulk-form button[type=submit]')
    page.click('#deal')
    page.wait_for_selector('#playing:not([hidden])')
    for want in (True, False):
        g = state(page)['game']
        cid = g['hands'][str(active(g))][0]
        gap = correct_gap(g, cid) if want else wrong_gap(g, cid)
        page.click(f'#hand label[data-card="{cid}"]')
        page.click(f'#strip button[data-gap="{gap}"]')
        page.click('#reveal')
        res = 'correct' if want else 'wrong'
        popup.wait_for_function("r => document.querySelector('#sb-timeline > article[data-result=\"' + r + '\"]')", arg=res)
        check(popup.evaluate('() => document.getAnimations().length') == 0, 'no animation under reduced motion: ' + res)
        shot(popup, 'sb-reduced-' + res)
    settle(popup)

    pages_before = len(ctx.pages)
    page.click('#open-scoreboard')
    popup.wait_for_load_state()
    popup.wait_for_timeout(500)
    check(len(ctx.pages) == pages_before, 'the named popup is reused')
    info = sb(popup)
    check(info['animations'] == 0 and info['player'] is not None and info['round'] == 'ROUND 2', 'reopened scoreboard')
    ctx.close()


with sync_playwright() as pw:
    browser = launch(pw)
    ctx = new_context(browser)
    page = open_host(ctx)

    # ---------- Theme: auto, light, dark ----------
    theme = page.locator('#theme')
    page.wait_for_timeout(300)
    seen = []
    for i in range(4):
        icons = page.evaluate("Array.from(document.querySelectorAll('#theme svg')).filter(s => getComputedStyle(s).display !== 'none').map(s => s.dataset.icon)")
        seen.append((page.evaluate("document.documentElement.dataset.theme || 'auto'"), theme.get_attribute('aria-label'), icons))
        if i < 3:
            theme.click()
    check([s[0] for s in seen] == ['auto', 'light', 'dark', 'auto'], f'theme cycle {seen}')
    check(all(s[1] == 'Theme: ' + s[0] for s in seen), 'theme labels')
    check([s[2] for s in seen] == [['circle-half-stroke'], ['sun'], ['moon'], ['circle-half-stroke']], f'theme icons {seen}')

    # ---------- Lobby ----------
    add_players(page, ['Ana', 'Ben', 'Cat'])
    check(page.locator('#player-list tr').count() == 3, 'three players')
    shot(page, 'host-01-lobby')

    with ctx.expect_page() as pop:
        page.click('#start-game')
    popup = pop.value
    watch(popup, 'scoreboard')
    popup.set_viewport_size({'width': 1280, 'height': 720})
    popup.wait_for_load_state()
    popup.wait_for_timeout(400)
    check(popup.evaluate('window.name') == 'trial-and-era-scoreboard', 'popup name')
    info = sb(popup)
    check(info['wait'] and 'Building the deck' in info['wait'], 'scoreboard waits in setup: ' + str(info['wait']))
    check([c['name'] for c in info['chips']] == ['Ana', 'Ben', 'Cat'], 'lobby chips')
    check(info['theme'] == 'dark', 'scoreboard dark')
    shot(page, 'host-02-setup-empty')
    shot(popup, 'sb-02-setup-empty')

    # ---------- Typed deck: two by form, the rest in bulk ----------
    page.click('details:has(#card-form) > summary')
    for label, year in [('Wheel', '3500 BC'), ('Magna Carta', '1215')]:
        page.fill('#card-form input[name=label]', label)
        page.fill('#card-form input[name=year]', year)
        page.press('#card-form input[name=year]', 'Enter')
    page.fill('#bulk-form textarea', BULK)
    page.click('#bulk-form button[type=submit]')
    check(page.input_value('#bulk-form textarea') == '', 'every bulk line parsed')
    st = state(page)
    check(len(st['deck']['cards']) == 27, f"27 cards, got {len(st['deck']['cards'])}")
    check(all(c['include'] and c['year'] for c in st['deck']['cards']), 'all included with years')
    years = [c['year'] for c in st['deck']['cards']]
    check(len(set(years)) == 27, 'distinct years')
    page.fill('#hand-size', '3')
    page.press('#hand-size', 'Tab')
    check(state(page)['settings']['handSize'] == 3, 'hand size 3')
    check(not page.locator('#deal').is_disabled(), 'deal enabled')
    popup.wait_for_function("() => document.querySelector('#sb-wait-detail').textContent.includes('27 cards')")
    check('3 cards each' in sb(popup)['wait'], 'scoreboard shows hand size')
    shot(page, 'host-03-setup-deck')
    page.evaluate("window.scrollTo(0, 0)")
    shot(page, 'host-03-setup-deck-full', full=True)
    shot(popup, 'sb-03-setup-deck')

    # ---------- Game 1 to a single winner ----------
    page.click('#deal')
    page.wait_for_selector('#playing:not([hidden])')
    st = state(page)
    g = st['game']
    check(g['seats'] == [1, 2, 3] and g['number'] == 1, 'game 1 starts with Ana')
    check(all(len(h) == 3 for h in g['hands'].values()) and len(g['timeline']) == 1 and len(g['draw']) == 17,
          'dealt 3 each, one start card')
    check(page.evaluate('document.activeElement.name') == 'card', 'focus on the hand after deal')
    synced(page, popup)
    sb_matches_state(popup, st, 'deal:')
    shot(page, 'host-04-playing-start')
    shot(popup, 'sb-04-playing-start')

    # Round 1: Ana right by click, Ben wrong by drag, then undo and redo, Cat right by drag.
    take_turn(page, popup, True, 'click', snap='05-r1-ana')
    settle(popup)
    sb_matches_state(popup, state(page), 'settled:')
    shot(popup, 'sb-05-r1-ana-settled')
    take_turn(page, popup, False, 'drag', snap='06-r1-ben')
    settle(popup)
    shot(popup, 'sb-06-r1-ben-settled')

    # Undo: Ben's choice comes back preselected, the scoreboard shows the ghost without animating.
    before = state(page)
    page.click('#undo')
    st = state(page)
    g = st['game']
    check(active(g) == 2 and len(g['log']) == 1, 'undo returns to Ben')
    check(g['pending']['cardId'] == before['game']['log'][-1]['cardId'], 'undo restores the pending card')
    check(len(g['draw']) == 17, 'undo restores the draw pile')
    synced(page, popup)
    sb_matches_state(popup, st, 'undo:')
    check(not [s for s in sb(popup)['slots'] if s['result']], 'no result card after undo')
    popup.wait_for_timeout(100)
    check(sb(popup)['animations'] == 0, 'nothing animates after undo')
    shot(page, 'host-07-undo')
    shot(popup, 'sb-07-undo')
    # Clear the restored choice by clicking the pressed gap, then redo by drag.
    page.click('#strip button[aria-pressed=true]')
    check(state(page)['game']['pending']['index'] is None, 'clicking the pressed gap clears it')
    take_turn(page, popup, False, 'drag', pick=before['game']['log'][-1]['cardId'])
    take_turn(page, popup, True, 'drag')

    # Refresh the scoreboard mid-game: nothing animates on load.
    popup.reload()
    popup.wait_for_load_state()
    popup.wait_for_timeout(500)
    info = sb_matches_state(popup, state(page), 'scoreboard reload:')
    check(info['animations'] == 0, 'no animation on scoreboard load')
    check(not [s for s in info['slots'] if s['result']], 'no result card on load')
    shot(popup, 'sb-08-reloaded')

    # Round 2: Ana wrong by keyboard, Ben right, Cat right; refresh the host with a pending choice first.
    st = state(page)
    check(st['game']['round'] == 2, 'round 2')
    pid = active(st['game'])
    cid = st['game']['hands'][str(pid)][0]
    page.click(f'#hand label[data-card="{cid}"]')
    page.click('#strip button[data-gap="0"]')
    page.reload()
    page.wait_for_selector('#playing:not([hidden])')
    check(page.locator(f'#hand input[value="{cid}"]').is_checked(), 'host refresh keeps the pending card')
    check(page.locator('#strip button[aria-pressed=true]').get_attribute('data-gap') == '0', 'and the gap')
    check(page.inner_text('#result').strip().startswith('Correct'), 'result line survives a refresh')
    shot(page, 'host-09-refreshed')
    page.click('#strip button[aria-pressed=true]')
    take_turn(page, popup, False, 'keys', pick=cid)
    take_turn(page, popup, True, 'click')
    take_turn(page, popup, True, 'click')

    # Round 3: Ana right, Ben right, Cat right and finished, so Cat wins alone.
    take_turn(page, popup, True, 'drag')
    take_turn(page, popup, True, 'click')
    st = state(page)
    check(up_next(st['game']) == 1, 'Ana up next while nobody has finished')
    take_turn(page, popup, True, 'drag', snap='10-win')
    page.wait_for_selector('#over:not([hidden])')
    st = state(page)
    check(st['phase'] == 'over' and st['game']['winners'] == [3], 'Cat wins')
    check(page.evaluate('document.activeElement.id') == 'over-heading', 'focus on the over heading')
    check(page.inner_text('#over-title') == 'Cat wins', 'host winner')
    rows = [r.split('\t') for r in page.inner_text('#standings').split('\n')]
    check(rows[0][1].strip() == 'Cat' and rows[0][0] == '1', f'standings {rows}')
    synced(page, popup)
    over_shown(popup)
    info = sb(popup)
    check(info['winner'] == 'Cat wins!', 'scoreboard winner ' + str(info['winner']))
    check(info['standings'][0] == ['1st', 'Cat', 'no cards left'] and info['standings'][1][0] == '2nd' and
          info['standings'][2][0] == '2nd', f"scoreboard standings {info['standings']}")
    check(info['player'] is None and info['goal'] == 'first to play every card wins' and info['round'] == 'GAME OVER',
          'over hides the turn and marks GAME OVER ' + info['goal'] + ' / ' + info['round'])
    shot(page, 'host-11-over')
    shot(popup, 'sb-11-over')

    # ---------- Undo from over, then finish again ----------
    page.click('#undo-over')
    page.wait_for_selector('#playing:not([hidden])')
    st = state(page)
    check(st['phase'] == 'playing' and active(st['game']) == 3 and not st['game']['winners'], 'undo from over')
    synced(page, popup)
    info = sb_matches_state(popup, st, 'undo from over:')
    check(info['winner'] is None, 'scoreboard leaves over')
    take_turn(page, popup, True, 'drag', pick=st['game']['pending']['cardId'])
    page.wait_for_selector('#over:not([hidden])')
    check(state(page)['game']['winners'] == [3], 'Cat wins again')

    # ---------- Play again, rotated, into sudden death ----------
    page.click('#play-again')
    page.wait_for_selector('#playing:not([hidden])')
    st = state(page)
    check(st['game']['number'] == 2 and st['game']['seats'] == [2, 3, 1], 'game 2 starts with Ben')
    synced(page, popup)
    info = sb_matches_state(popup, st, 'play again:')
    check(info['animations'] == 0 and not [s for s in info['slots'] if s['result']], 'new game starts quiet')
    shot(popup, 'sb-12-game2-start')
    # Ben and Ana play right every turn; Cat misses once, so Ben and Ana finish in round 3.
    plan = [(True, 'click'), (False, 'drag'), (True, 'drag'),
            (True, 'drag'), (True, 'click'), (True, 'click'),
            (True, 'click'), (True, 'drag')]
    for want, mode in plan:
        take_turn(page, popup, want, mode)
    st = state(page)
    check(active(st['game']) == 1 and st['game']['finished'] == [2], 'Ben finished; Ana to play last')
    info = sb(popup)
    ben = [c for c in info['chips'] if c['name'] == 'Ben'][0]
    check(ben['mark'] == 'FINISHED', 'Ben marked finished')
    take_turn(page, popup, True, 'click', snap='13-sd-start')
    st = state(page)
    g = st['game']
    check(g['suddenDeath'] and g['seats'] == [2, 1] and g['round'] == 4, 'sudden death between Ben and Ana')
    check(len(g['hands']['2']) == 1 and len(g['hands']['1']) == 1, 'finalists draw one card each')
    check(st['phase'] == 'playing', 'still playing')
    check('Sudden death' in page.inner_text('#round-title'), 'host sudden death heading')
    check('Sudden death, round 4: Ben and Ana' in page.inner_text('#result'), 'host result names sudden death')
    synced(page, popup)
    info = sb_matches_state(popup, st, 'sudden death:')
    check(info['round'] == 'SUDDEN DEATH', 'scoreboard says SUDDEN DEATH')
    cat = [c for c in info['chips'] if c['name'] == 'Cat'][0]
    check(cat['out'] and cat['detail'].startswith('out · '), 'Cat out of sudden death')
    settle(popup)
    shot(page, 'host-14-sudden-death')
    shot(popup, 'sb-14-sudden-death')
    # A round where both miss repeats; then Ben right and Ana wrong.
    take_turn(page, popup, False, 'click')
    take_turn(page, popup, False, 'drag')
    st = state(page)
    check(st['game']['suddenDeath'] and st['game']['round'] == 5 and st['game']['seats'] == [2, 1], 'sudden death repeats')
    take_turn(page, popup, True, 'drag')
    take_turn(page, popup, False, 'click')
    page.wait_for_selector('#over:not([hidden])')
    st = state(page)
    check(st['game']['winners'] == [2], 'Ben wins sudden death')
    check(st['game']['out'] == {'3': 3}, f"Cat was knocked out after round 3: {st['game']['out']}")
    hands = {pid: len(h) for pid, h in st['game']['hands'].items()}
    host_rows = page.evaluate("Array.from(document.querySelectorAll('#standings tr'))"
                              ".map(r => Array.from(r.cells).map(c => c.textContent.trim()))")
    check(host_rows == [['1', 'Ben', '0'], ['2', 'Ana', str(hands['1'])], ['3', 'Cat', str(hands['3'])]],
          f'host standings {host_rows}')
    synced(page, popup)
    over_shown(popup)
    info = sb(popup)
    check(info['winner'] == 'Ben wins!' and info['round'] == 'GAME OVER', 'scoreboard sudden death winner')
    check(popup.locator('#sb-round mark svg[data-icon="flag-checkered"]').count() == 1, 'GAME OVER flag icon')
    check(info['goal'] == 'first to play every card wins', 'goal line kept when over')
    check([r[:2] for r in info['standings']] == [['1st', 'Ben'], ['2nd', 'Ana'], ['3rd', 'Cat']],
          f"finalist Ana ranks ahead of Cat, out earlier {info['standings']}")
    shot(page, 'host-15-over-sudden-death')
    shot(popup, 'sb-15-over-sudden-death')

    # ---------- Edit deck, then New game ----------
    page.click('#edit-deck')
    page.wait_for_selector('#setup:not([hidden])')
    st = state(page)
    check(st['phase'] == 'setup' and st['game'] is None and len(st['deck']['cards']) == 27, 'edit deck keeps the deck')
    check(page.locator('#deck-table tbody tr[data-id]:visible').count() == 27, 'deck table rows')
    popup.wait_for_function("() => !document.querySelector('#sb-wait').hidden")
    shot(popup, 'sb-16-edit-deck')
    page.click('summary:has-text("Settings")')
    page.click('#new-game')
    page.click('#confirm-new button[value=confirm]')
    page.wait_for_selector('#lobby:not([hidden])')
    st = state(page)
    check(st['phase'] == 'lobby' and [p['name'] for p in st['players']] == ['Ana', 'Ben', 'Cat'] and
          len(st['deck']['cards']) == 27 and st['settings']['handSize'] == 3, 'new game keeps players, deck, settings')
    popup.wait_for_function("() => document.querySelector('#sb-wait-title').textContent === 'Waiting for the host'")
    shot(page, 'host-17-new-game-lobby')
    shot(popup, 'sb-17-lobby')
    # The next deal after New game starts with seat 1 again.
    page.click('#start-game')
    page.wait_for_selector('#setup:not([hidden])')
    page.click('#deal')
    page.wait_for_selector('#playing:not([hidden])')
    st = state(page)
    check(st['game']['number'] == 1 and st['game']['seats'] == [1, 2, 3], 'new game deals from seat 1')
    synced(page, popup)
    sb_matches_state(popup, st, 'after new game:')

    # Host themes while playing.
    for t in ('light', 'dark'):
        while page.evaluate("document.documentElement.dataset.theme || 'auto'") != t:
            page.click('#theme')
        page.wait_for_timeout(200)
        shot(page, 'host-18-playing-' + t)
    info = sb(popup)
    rgb = [int(x) for x in re.findall(r'\d+', info['scheme'])[:3]]
    check(info['theme'] == 'dark' and sum(rgb) < 150, 'scoreboard stays dark ' + info['scheme'])
    page.set_viewport_size({'width': 390, 'height': 844})
    page.wait_for_timeout(200)
    check(no_overflow(page), 'no horizontal scroll at 390 px while playing')
    shot(page, 'host-19-playing-narrow')
    ctx.close()

    reduced_motion_and_reopen(browser)
    browser.close()

finish('game')
