"""The Content-Security-Policy from _headers: the server applies it, both pages load and render their icons under it
with no violation, and it blocks inline scripts, eval, and requests to any origin but the Wikipedia and Wikidata APIs.
Every other suite runs under the same policy and fails on any violation."""
from playwright.sync_api import sync_playwright

from helpers import *

POLICY = next(line.split(':', 1)[1].strip() for line in (ROOT / '_headers').read_text().splitlines()
              if line.strip().startswith('Content-Security-Policy:'))
PROBE = """async () => {
  async function hit(url) {
    try { const r = await fetch(url); return r.ok ? 'ok' : 'status ' + r.status; } catch (err) { return 'blocked'; }
  }
  const s = document.createElement('script');
  s.textContent = 'window.inlineRan = true';
  document.body.append(s);
  // Code Playwright evaluates is exempt from the policy, so eval runs in a same-origin script the page loads.
  const evalResult = await new Promise((resolve) => {
    const e = document.createElement('script');
    e.src = '/__eval.js';
    e.onload = () => resolve(window.evalResult);
    e.onerror = () => resolve('script failed to load');
    document.body.append(e);
  });
  return {
    wikipedia: await hit('https://en.wikipedia.org/w/api.php?action=query&titles=Telephone&format=json&origin=*'),
    wikidata: await hit('https://www.wikidata.org/w/api.php?action=wbgetentities&titles=Telephone&sites=enwiki&format=json&origin=*'),
    other: await hit('https://wikimedia.org/api/rest_v1/'),
    inline: window.inlineRan === true,
    eval: evalResult
  };
}"""

with sync_playwright() as pw:
    browser = launch(pw)
    ctx = new_context(browser)
    MockWiki(ctx)

    page = watch(ctx.new_page(), 'host')
    resp = page.goto(BASE + 'index.html')
    check(resp.headers.get('content-security-policy') == POLICY, 'host page served with the policy from _headers')
    page.evaluate('localStorage.clear()')
    page.reload()
    page.wait_for_selector('#lobby:not([hidden])')
    add_players(page, ['Ana', 'Ben'])
    with ctx.expect_page() as pop:
        page.click('#start-game')
    popup = watch(pop.value, 'scoreboard')
    popup.wait_for_load_state('networkidle')
    for p in (page, popup):
        p.wait_for_function("() => document.querySelector('svg.svg-inline--fa') !== null", timeout=15000)
        check(p.evaluate('window.__csp') == [], 'no violations on ' + p.url)
    check(popup.evaluate('getComputedStyle(document.body).fontFamily') != '', 'scoreboard styles load')

    # A build fetches from the Wikipedia API under the policy.
    page.fill('#source-form input[name=q]', 'Gadgets')
    page.press('#source-form input[name=q]', 'Enter')
    page.wait_for_function("k => (JSON.parse(localStorage.getItem(k)).deck.cards.length || 0) === 12", arg=GAME_KEY,
                           timeout=15000)
    check(page.evaluate('window.__csp') == [], 'a build raises no violation')

    # The probe's blocked requests and scripts are expected violations, so it runs on a page watched apart.
    ctx.route(BASE + '__eval.js', lambda r: r.fulfill(
        content_type='text/javascript', body="try { window.evalResult = eval('1 + 1'); } catch (err) { window.evalResult = err.name; }"))
    probe = ctx.new_page()
    probe.goto(BASE + 'scoreboard.html')
    res = probe.evaluate(PROBE)
    violations = probe.evaluate('window.__csp')
    check(res['wikipedia'] == 'ok' and res['wikidata'] == 'ok', 'connect-src allows the two APIs %s' % res)
    check(res['other'] == 'blocked' and any(v.startswith('connect-src') and 'wikimedia.org' in v for v in violations),
          'connect-src blocks other origins %s %s' % (res, violations))
    check(not res['inline'] and any(v.startswith('script-src') and v.endswith('inline') for v in violations),
          'inline scripts are blocked %s %s' % (res, violations))
    check(res['eval'] == 'EvalError' and any(v.startswith('script-src') and v.endswith('eval') for v in violations),
          'eval is blocked %s %s' % (res, violations))
    browser.close()

finish('csp')
