"""Shared helpers for the browser suites: Chromium launch, error watching, checks, game-state readers, the
scoreboard's rendered state, and a mock Wikipedia. Each suite is a script that takes the base URL of a server for
the repo root as its first argument; run.py starts that server and runs them."""
import glob, json, os, re, sys, urllib.parse
from pathlib import Path

from playwright.sync_api import Error

TESTS = Path(__file__).resolve().parent
ROOT = TESTS.parent
BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:8000/'
# Screenshots are taken only when run.py is given --shots.
SHOTS = os.environ.get('SHOTS')
GAME_KEY = 'trial-and-era:v1'
UI_KEY = GAME_KEY + ':ui'

checks = 0
errors = []
failures = []

# Records the game state this window last rendered, at load and on each storage event, so a test can wait for the
# scoreboard to catch up. Every CSP violation is also logged as a console error, which fails the suite.
INIT = """
window.__csp = [];
try { window.__seen = localStorage.getItem('%(key)s'); } catch (e) {}
window.addEventListener('storage', function (e) {
  if (e.key === '%(key)s' || e.key === null) window.__seen = e.newValue;
});
document.addEventListener('securitypolicyviolation', function (e) {
  window.__csp.push(e.violatedDirective + ' ' + e.blockedURI);
  console.error('CSP violation: ' + e.violatedDirective + ' ' + e.blockedURI);
});
""" % {'key': GAME_KEY}


def check(cond, msg):
    """Count a check and raise AssertionError with msg when cond is false."""
    global checks
    checks += 1
    if not cond:
        raise AssertionError(msg)


def expect(cond, msg):
    """Count a check and record msg as a failure when cond is false, without stopping the suite."""
    global checks
    checks += 1
    if not cond:
        failures.append(msg)
        print('FAIL', msg, flush=True)


def sections(tests):
    """Run each named function in turn; one that raises is recorded as a failure and the rest still run."""
    for name, fn in tests.items():
        try:
            fn()
        except Exception as err:
            failures.append(name + ': ' + repr(err)[:500])
            print('FAIL', name + ':', repr(err)[:500], flush=True)


def launch(pw, **kw):
    """Playwright's own Chromium, or else the newest Chromium in the Playwright cache."""
    try:
        return pw.chromium.launch(**kw)
    except Error as err:
        if "Executable doesn't exist" not in str(err):
            raise
    found = glob.glob(os.path.expanduser('~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome'))
    if not found:
        raise RuntimeError('No Chromium found. Run: uv run --with playwright playwright install chromium')
    newest = max(found, key=lambda p: int(re.search(r'chromium-(\d+)', p).group(1)))
    return pw.chromium.launch(executable_path=newest, **kw)


def new_context(browser, **kw):
    kw.setdefault('viewport', {'width': 1280, 'height': 900})
    ctx = browser.new_context(accept_downloads=True, **kw)
    ctx.add_init_script(INIT)
    return ctx


def watch(page, tag):
    """Collect console errors and uncaught exceptions from page; finish() fails the suite on any."""
    def on_console(msg):
        if msg.type == 'error':
            errors.append(tag + ' console: ' + msg.text + ' @ ' + str(msg.location.get('url', '')))
    page.on('console', on_console)
    page.on('pageerror', lambda err: errors.append(tag + ' pageerror: ' + str(err)))
    return page


def open_host(ctx, tag='host'):
    """A host console page on a cleared localStorage, showing the lobby."""
    page = watch(ctx.new_page(), tag)
    page.goto(BASE + 'host.html')
    page.evaluate('localStorage.clear()')
    page.reload()
    page.wait_for_selector('#lobby:not([hidden])')
    return page


def add_players(page, names):
    for n in names:
        page.fill('#add-player input[name=name]', n)
        page.press('#add-player input[name=name]', 'Enter')


def state(page):
    return json.loads(page.evaluate('k => localStorage.getItem(k)', GAME_KEY))


def ui(page):
    return json.loads(page.evaluate('k => localStorage.getItem(k)', UI_KEY) or '{}')


def synced(page, popup):
    """Wait until popup has rendered the game state page saved last."""
    value = page.evaluate('k => localStorage.getItem(k)', GAME_KEY)
    popup.wait_for_function('v => window.__seen === v', arg=value)
    popup.wait_for_timeout(30)


def shot(page, name, full=False):
    if SHOTS:
        os.makedirs(SHOTS, exist_ok=True)
        page.screenshot(path=os.path.join(SHOTS, name + '.png'), full_page=full)


def fits(g, card_id, i):
    year = g['cards'][str(card_id)]['year']
    line = g['timeline']
    left = line[i - 1] if i > 0 else None
    right = line[i] if i < len(line) else None
    return (left is None or g['cards'][str(left)]['year'] <= year) and \
        (right is None or year <= g['cards'][str(right)]['year'])


def correct_gap(g, card_id):
    for i in range(len(g['timeline']) + 1):
        if fits(g, card_id, i):
            return i
    raise AssertionError('no gap fits')


def wrong_gap(g, card_id):
    for i in range(len(g['timeline']) + 1):
        if not fits(g, card_id, i):
            return i
    return None


def active(g):
    return None if g['winners'] else g['seats'][g['turn']]


def up_next(g):
    if active(g) is None:
        return None
    rest = g['seats'][g['turn'] + 1:] + ([] if g['finished'] else g['seats'][:g['turn']])
    return rest[0] if rest else None


SB_INFO = """() => {
  const q = s => document.querySelector(s);
  const strip = q('#sb-timeline');
  const slots = strip.hidden ? [] : Array.from(strip.children).map(a => ({
    label: a.querySelector('p').textContent,
    year: a.querySelector('footer strong').textContent,
    ghost: a.hasAttribute('data-ghost'),
    result: a.dataset.result || null,
    mark: a.querySelector(':scope > mark') ? a.querySelector(':scope > mark').textContent.trim() : null
  }));
  const hand = q('#sb-turn').hidden ? [] : Array.from(q('#sb-hand').children).map(a => ({
    label: a.querySelector('p').textContent,
    year: a.querySelector('footer strong').textContent,
    current: a.getAttribute('aria-current') === 'true'
  }));
  const chips = q('#sb-players').hidden ? [] : Array.from(q('#sb-players').children).map(a => ({
    name: a.querySelector('strong').textContent.trim(),
    detail: a.querySelector('small').textContent.trim(),
    mark: a.querySelector(':scope > mark') ? a.querySelector(':scope > mark').textContent.trim() : null,
    out: a.hasAttribute('data-out')
  }));
  return {
    wait: q('#sb-wait').hidden ? null : q('#sb-wait').textContent.replace(/\\s+/g, ' ').trim(),
    goal: q('#sb-goal').textContent.trim(),
    round: q('#sb-round').textContent.replace(/\\s+/g, ' ').trim(),
    draw: q('#sb-draw').textContent.replace(/\\s+/g, ' ').trim(),
    status: q('#sb-status').hidden ? null : q('#sb-status').textContent.replace(/\\s+/g, ' ').trim(),
    player: q('#sb-turn').hidden ? null : q('#sb-player').textContent.replace(/\\s+/g, ' ').trim(),
    slots, hand, chips,
    winner: q('#sb-standings').hidden ? null : q('#sb-winner').textContent.trim(),
    standings: q('#sb-standings').hidden ? [] : Array.from(q('#sb-standings-body').rows).map(r =>
      Array.from(r.cells).map(c => c.textContent.trim())),
    animations: document.getAnimations().length,
    theme: document.documentElement.dataset.theme,
    scheme: getComputedStyle(document.body).backgroundColor
  };
}"""


def sb(popup):
    """What the scoreboard shows: banner, turn, hand, chips, timeline slots and standings."""
    return popup.evaluate(SB_INFO)


def no_overflow(page):
    return page.evaluate('document.documentElement.scrollWidth <= document.documentElement.clientWidth')


# A mock of the two Wikimedia APIs, for building decks without the network.

CORS = {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Content-Type': 'application/json'}


def list_page(title, n, start=1800):
    rows = ''.join('<tr><td><a href="/wiki/%s_Item_%d">%s Item %d</a></td><td>%d</td></tr>' %
                   (title.replace(' ', '_'), i, title, i, start + i) for i in range(n))
    return ('<div class="mw-parser-output"><table class="wikitable"><tr><th>Name</th><th>Year</th></tr>%s</table></div>'
            % rows)


class MockWiki:
    """Routes the Wikipedia and Wikidata APIs for ctx. Every page is a dated table of `sizes.get(title, 12)` rows.
    Requests whose action is in `hold` wait in `held` until release()."""

    def __init__(self, ctx, sizes=None):
        self.sizes = sizes or {}
        self.hold = set()
        self.held = []
        self.log = []
        ctx.route('https://en.wikipedia.org/**', self.handle)
        ctx.route('https://www.wikidata.org/**', self.handle)

    def handle(self, route):
        req = route.request
        if req.method == 'OPTIONS':
            route.fulfill(status=204, headers=CORS)
            return
        q = dict(urllib.parse.parse_qsl(urllib.parse.urlparse(req.url).query))
        self.log.append((q.get('action'), q.get('page') or q.get('search') or q.get('titles', '')[:40]))
        if q.get('action') in self.hold:
            self.held.append((route, q))
            return
        self.respond(route, q)

    def respond(self, route, q):
        action = q.get('action')
        if action == 'opensearch':
            s = q['search']
            body = [s, [s + ' one', s + ' two', 'List of ' + s]]
        elif action == 'parse':
            body = {'parse': {'title': q['page'], 'text': list_page(q['page'], self.sizes.get(q['page'], 12))}}
        elif action == 'query':
            body = {'query': {'pages': [{'title': t, 'ns': 0, 'pageid': i + 1, 'description': 'desc of ' + t}
                                        for i, t in enumerate(q.get('titles', 'Untitled').split('|'))]}}
        elif action == 'wbgetentities':
            body = {'entities': {}}
        else:
            body = {}
        route.fulfill(status=200, headers=CORS, body=json.dumps(body))

    def release(self):
        held, self.held = self.held, []
        for route, q in held:
            self.respond(route, q)


def card(i, source='Typed', year=None, **kw):
    """A typed deck card with id i, labelled 'Card i', in year 1000 + i unless given."""
    c = {'id': i, 'source': source, 'title': None, 'linkLabel': 'Card %d' % i, 'textLabel': 'Card %d' % i,
         'label': 'Card %d' % i, 'labelEdited': False, 'year': 1000 + i if year is None else year,
         'yearFrom': 'typed', 'description': '', 'context': '', 'include': True, 'flags': []}
    c.update(kw)
    return c


def setup_state(n_cards=12, players=('Ana', 'Ben'), phase='setup', hand=4):
    """Saved game state in setup with n_cards typed cards."""
    return {'settings': {'handSize': hand},
            'players': [{'id': i + 1, 'name': n} for i, n in enumerate(players)], 'nextId': len(players) + 1,
            'phase': phase,
            'deck': {'cards': [card(i) for i in range(1, n_cards + 1)],
                     'sources': [{'name': 'Typed', 'title': None, 'labelMode': 'text'}] if n_cards else [],
                     'nextCardId': n_cards + 1},
            'gameNumber': 0, 'placementSeq': 0, 'game': None}


def seed(page, st, ui_state=None):
    """Load the host console with only st, and ui_state if given, in localStorage."""
    page.goto(BASE + 'host.html')
    page.evaluate("([k, s, u]) => { localStorage.clear(); localStorage.setItem(k, s);"
                  " if (u) localStorage.setItem(k + ':ui', u); }",
                  [GAME_KEY, json.dumps(st), json.dumps(ui_state) if ui_state else None])
    page.reload()
    page.wait_for_load_state('networkidle')


# Fills localStorage until only `keep` characters fit, under the key 'filler'.
FILL = """(keep) => { localStorage.removeItem('filler'); let lo = 0, hi = 16 * 1024 * 1024;
  while (hi - lo > 16) { const mid = (lo + hi) >> 1;
    try { localStorage.setItem('filler', 'a'.repeat(mid)); lo = mid; } catch (e) { hi = mid; } }
  localStorage.setItem('filler', 'a'.repeat(Math.max(0, lo - keep))); return lo; }"""


def json_file(data, name='deck.json'):
    """An in-memory file for set_input_files."""
    body = data if isinstance(data, (bytes, str)) else json.dumps(data)
    return {'name': name, 'mimeType': 'application/json', 'buffer': body.encode() if isinstance(body, str) else body}


def finish(name):
    """Report the suite's checks, failures and errors, and exit non-zero on any failure or console or page error."""
    for f in failures:
        print('FAIL', f)
    for e in errors:
        print('ERROR', e)
    print(name + ':', checks - len(failures), 'checks passed' + (', %d failed' % len(failures) if failures else ''))
    sys.exit(1 if errors or failures else 0)
