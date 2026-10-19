"""Scoreboard rendering, driven by a second page that writes game states: every phase both live and at load, at three
viewport sizes, with nothing off the stage, clipped or scrolling, the pending gap centered, no storage writes, and
no animation at load. Then reveals as they happen: correct, wrong, undo and the winning card, with and without
reduced motion."""
from playwright.sync_api import sync_playwright

from helpers import *

SIZES = [(1280, 720), (1920, 1080), (800, 450)]
SCENARIOS = [
    ('lobby-empty', 'T.lobbyEmpty()'),
    ('lobby', 'T.lobby()'),
    ('setup', 'T.setup()'),
    ('fresh', 'T.fresh()'),
    ('pending-card', "T.pending('card')"),
    ('pending-gap', "T.pending('gap')"),
    ('pending-both', "T.pending('both')"),
    ('sudden-death', 'T.suddenDeath()'),
    ('over-one', 'T.overOne()'),
    ('over-shared', 'T.overShared()'),
    ('eight', 'T.eight()'),
    ('forty-pending-middle', 'T.forty(20)'),
    ('forty-pending-start', 'T.forty(0)'),
    ('forty-pending-end', 'T.forty(41)'),
    ('forty-no-gap', 'T.forty()'),
    ('solo', 'T.solo()'),
    ('finished-mid-round', 'T.finishedMidRound()'),
    ('sudden-out', 'T.suddenOut()'),
    ('near-win', 'T.nearWin()'),
]

LAYOUT = '''() => {
  const stage = document.getElementById('stage');
  const sr = stage.getBoundingClientRect();
  const strip = document.getElementById('sb-timeline');
  const out = [];
  for (const el of stage.querySelectorAll('*')) {
    if (el.closest('[hidden]')) continue;
    if (strip.contains(el) && el !== strip) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    if (r.left < sr.left - 0.5 || r.right > sr.right + 0.5 || r.top < sr.top - 0.5 || r.bottom > sr.bottom + 0.5) {
      out.push(el.tagName + '#' + el.id + ' "' + (el.textContent || '').trim().slice(0, 30) + '" ' +
        JSON.stringify([r.left, r.top, r.right, r.bottom].map(Math.round)));
    }
  }
  const clipped = [];
  const sel = '#sb-timeline footer, #sb-hand footer, #sb-player, #sb-round, #sb-draw, #sb-goal, #sb-wait h1, ' +
    '#sb-wait p, #sb-winner, #sb-standings td, #sb-standings th, #sb-timeline > article, #sb-hand > article';
  for (const el of stage.querySelectorAll(sel)) {
    if (el.closest('[hidden]')) continue;
    const card = el.matches('article, footer');
    if (el.scrollWidth > el.clientWidth + 1 || (card && el.scrollHeight > el.clientHeight + 1)) {
      clipped.push(el.tagName + '#' + el.id + ' "' + el.textContent.trim().slice(0, 30) + '" ' +
        el.scrollWidth + '/' + el.clientWidth + ' ' + el.scrollHeight + '/' + el.clientHeight);
    }
  }
  const ghost = strip.querySelector('[data-ghost]');
  const tr = strip.getBoundingClientRect();
  let ghostOffset = null;
  if (ghost && !strip.hidden) {
    const gr = ghost.getBoundingClientRect();
    ghostOffset = Math.round((gr.left + gr.right) / 2 - (tr.left + tr.right) / 2);
  }
  const status = document.getElementById('sb-status');
  return {
    out, clipped, ghostOffset,
    ghostIndex: ghost ? [...strip.children].indexOf(ghost) : null,
    stage: [stage.scrollWidth - stage.clientWidth, stage.scrollHeight - stage.clientHeight],
    doc: [document.documentElement.scrollWidth - innerWidth, document.documentElement.scrollHeight - innerHeight],
    anims: document.getAnimations().length,
    strip: strip.hidden ? null : { left: Math.round(strip.scrollLeft), max: strip.scrollWidth - strip.clientWidth, cards: strip.children.length },
    results: [...strip.querySelectorAll('[data-result]')].map((a) => a.dataset.result + ':' + a.textContent.trim().slice(0, 40)),
    current: [...document.querySelectorAll('#sb-hand [aria-current]')].map((a) => a.textContent.trim().slice(0, 25)),
    status: status.hidden ? null : status.textContent.trim(),
    winner: document.getElementById('sb-standings').hidden ? null : document.getElementById('sb-standings').textContent.replace(/\\s+/g, ' ').trim(),
    writes: window.__writes
  };
}'''

# Resolves once no animation runs and the strip has not scrolled for 100 ms.
QUIET = '''async () => {
  const strip = document.getElementById('sb-timeline');
  for (let i = 0; i < 100; i++) {
    const before = strip.scrollLeft;
    await new Promise((r) => setTimeout(r, 100));
    if (!document.getAnimations().length && strip.scrollLeft === before) return true;
  }
  return false;
}'''

COUNT_WRITES = '''
window.__writes = 0;
for (const name of ['setItem', 'removeItem', 'clear']) {
  const orig = Storage.prototype[name];
  Storage.prototype[name] = function (...args) { window.__writes++; return orig.apply(this, args); };
}'''


def layout(sb, label):
    """Measure the scoreboard and record a failure for anything off the stage, clipped, scrolling or off center."""
    r = sb.evaluate(LAYOUT)
    problems = []
    if r['out']:
        problems.append('off stage: ' + '; '.join(r['out']))
    if r['clipped']:
        problems.append('clipped: ' + '; '.join(r['clipped']))
    if r['stage'][0] > 0 or r['stage'][1] > 0:
        problems.append('stage overflow %s' % r['stage'])
    if r['doc'][0] > 0 or r['doc'][1] > 0:
        problems.append('document scroll %s' % r['doc'])
    if (r['ghostOffset'] is not None and abs(r['ghostOffset']) > 3 and r['strip']['max'] > 0
            and 2 < r['strip']['left'] < r['strip']['max'] - 2):
        problems.append('ghost off center by %s' % r['ghostOffset'])
    if r['writes']:
        problems.append('scoreboard wrote storage %s times' % r['writes'])
    expect(not problems, label + ': ' + ' | '.join(problems))
    return r


def quiet(sb):
    expect(sb.evaluate(QUIET), 'scoreboard settles')


def drive(drv, sb, expr):
    """Run a driver expression that saves a state, and wait until the scoreboard has rendered it."""
    drv.evaluate(expr)
    synced(drv, sb)


def until(sb, js, label, timeout=8000):
    """Wait for js to hold on the scoreboard, recording a failure if it never does."""
    try:
        sb.wait_for_function(js, timeout=timeout)
        expect(True, label)
    except Exception:
        expect(False, label + ' within %d ms' % timeout)


def open_pair(browser, **kw):
    """A driver page and a scoreboard page in one context, on cleared storage."""
    ctx = new_context(browser, viewport={'width': 1280, 'height': 720}, **kw)
    ctx.route(BASE + '__driver.html', lambda route: route.fulfill(
        content_type='text/html',
        body='<!doctype html><title>driver</title><script type="module" src="/tests/scoreboard_driver.js"></script>'))
    drv = watch(ctx.new_page(), 'driver')
    drv.goto(BASE + '__driver.html')
    drv.wait_for_function('() => window.T')
    drv.evaluate('localStorage.clear()')
    sb = watch(ctx.new_page(), 'scoreboard')
    sb.add_init_script(COUNT_WRITES)
    sb.goto(BASE + 'scoreboard.html')
    sb.wait_for_load_state('networkidle')
    return ctx, drv, sb


def statics(browser):
    ctx, drv, sb = open_pair(browser)
    layout(sb, 'empty storage')
    for name, expr in SCENARIOS:
        # Live through a storage event first, then as present at load.
        drive(drv, sb, expr)
        quiet(sb)
        layout(sb, name + ' live')
        sb.reload()
        sb.wait_for_load_state('networkidle')
        sb.wait_for_timeout(300)
        expect(sb.evaluate('document.getAnimations().length') == 0,
               name + ': no animation for placements present at load')
        results = []
        for w, h in SIZES:
            sb.set_viewport_size({'width': w, 'height': h})
            quiet(sb)
            results.append(layout(sb, '%s at %dx%d' % (name, w, h)))
            shot(sb, 'sb-%s-%dx%d' % (name, w, h))
        sb.set_viewport_size({'width': 1280, 'height': 720})
        r = results[0]
        if name.startswith('over'):
            expect(r['winner'] is not None, name + ': standings shown')
        if name == 'over-shared':
            expect('share the win' in (r['winner'] or ''), name + ': shared win heading %s' % r['winner'])
        if name in ('pending-both', 'eight') or name.startswith('forty-pending'):
            expect(r['ghostIndex'] is not None and len(r['current']) == 1, name + ': ghost and highlight')
    ctx.close()


def live(browser, reduced):
    tag = 'reduced motion: ' if reduced else ''
    ctx, drv, sb = open_pair(browser, reduced_motion='reduce' if reduced else 'no-preference')
    drv.evaluate('T.save(T.dealt(4, 4, 42, 11))')
    sb.reload()
    sb.wait_for_load_state('networkidle')
    has = "() => document.querySelector('#sb-timeline > [data-result=\"%s\"]')"
    none = "() => !document.querySelector('#sb-timeline > [data-result]') && !document.getAnimations().length"

    # A correct reveal flips the card in, marks it, then settles with the status kept.
    drive(drv, sb, 'T.choose(true)')
    quiet(sb)
    layout(sb, tag + 'correct chosen')
    drv.evaluate('T.reveal()')
    until(sb, has % 'correct', tag + 'correct mark shown')
    expect((sb.evaluate('document.getAnimations().length') > 0) != reduced,
           tag + 'the correct reveal animates only without reduced motion')
    sb.wait_for_timeout(250)
    layout(sb, tag + 'correct reveal')
    until(sb, none, tag + 'correct mark gone after the flash')
    expect('CORRECT' in (sb.evaluate(LAYOUT)['status'] or ''), tag + 'status keeps the correct result')

    # A wrong card takes the ghost's slot, then leaves.
    drive(drv, sb, 'T.choose(false)')
    quiet(sb)
    before = sb.evaluate("document.getElementById('sb-timeline').children.length")
    drv.evaluate('T.reveal()')
    until(sb, has % 'wrong', tag + 'wrong mark shown')
    r = layout(sb, tag + 'wrong reveal')
    expect(r['strip']['cards'] == before, tag + 'the wrong card takes the ghost slot')
    until(sb, none, tag + 'wrong card leaves')
    r = layout(sb, tag + 'wrong card gone')
    expect(r['strip']['cards'] == before - 1, tag + 'the strip loses the ghost slot')
    expect('WRONG' in (r['status'] or ''), tag + 'status keeps the wrong result')

    # The next player's choice can land while the wrong card still shows.
    drive(drv, sb, 'T.choose(false)')
    drv.evaluate('T.reveal()')
    until(sb, has % 'wrong', tag + 'second wrong mark shown')
    drive(drv, sb, 'T.choose(true)')
    r = layout(sb, tag + 'wrong card and next ghost')
    expect(r['ghostIndex'] is not None and any(x.startswith('wrong:') for x in r['results']),
           tag + 'the wrong card and the next ghost show together %s' % r['results'])
    until(sb, none, tag + 'settles after the wrong card')

    # Undo restores the pending choice without animating, and the redo animates again.
    drv.evaluate('T.reveal()')
    sb.wait_for_timeout(300)
    drv.evaluate('T.undo()')
    until(sb, "() => document.querySelector('#sb-timeline > [data-ghost]') && "
              "!document.querySelector('#sb-timeline > [data-result]')", tag + 'undo shows the ghost again')
    expect(sb.evaluate('document.getAnimations().length') == 0, tag + 'nothing animates after undo')
    drv.evaluate('T.reveal()')
    until(sb, has % 'correct', tag + 'the redo animates again')
    until(sb, none, tag + 'settles after the redo')

    # The winning reveal flips the last card in while the standings appear.
    drive(drv, sb, 'T.nearWin()')
    quiet(sb)
    drv.evaluate('T.reveal()')
    until(sb, "() => !document.getElementById('sb-standings').hidden && "
              "document.querySelector('#sb-timeline > [data-result=\"correct\"]')",
          tag + 'the winning card flashes over the standings')
    layout(sb, tag + 'winning reveal')
    until(sb, none, tag + 'settles after the win')

    # Back in the lobby the strip hides; the next deal scrolls to the ghost at once, and a resize recenters it.
    drive(drv, sb, 'T.lobby()')
    layout(sb, tag + 'back to lobby')
    drive(drv, sb, 'T.forty(30)')
    sb.wait_for_timeout(200)
    r = layout(sb, tag + 'forty after lobby')
    expect(r['ghostOffset'] is not None and abs(r['ghostOffset']) <= 3,
           tag + 'the first scroll is instant and centered: %s' % r['ghostOffset'])
    sb.set_viewport_size({'width': 1920, 'height': 1080})
    quiet(sb)
    r = layout(sb, tag + 'after resize')
    expect(r['ghostOffset'] is not None and abs(r['ghostOffset']) <= 3, tag + 'a resize recenters: %s' % r['ghostOffset'])
    ctx.close()


with sync_playwright() as pw:
    browser = launch(pw)
    sections({'static': lambda: statics(browser), 'live': lambda: live(browser, False),
              'live with reduced motion': lambda: live(browser, True)})
    browser.close()

finish('scoreboard')
