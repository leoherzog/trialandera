"""Deck building in js/wiki.js without the network: label and year helpers checked directly, buildCards on fixture
pages with the Wikipedia and Wikidata APIs mocked, and request retries against bodies that stall. Serves the repo's
js/ itself, with a copy of wiki.js that exports its internals and gives up sooner."""
import http.server, json, re, threading, time, urllib.parse

from playwright.sync_api import sync_playwright

from helpers import *

WIKI = (ROOT / 'js/wiki.js').read_text()
NAMES = re.findall(r'^(?:async )?function (\w+)', WIKI, re.M)
INTERNALS = (WIKI.replace('const ATTEMPT_TIMEOUT_MS = 30000;', 'const ATTEMPT_TIMEOUT_MS = 1500;')
             .replace('const RETRIES = 5;', 'const RETRIES = 1;')
             + '\nexport { ' + ', '.join(NAMES) + ' };\n')
assert 'ATTEMPT_TIMEOUT_MS = 1500' in INTERNALS and 'RETRIES = 1' in INTERNALS, 'wiki.js timeout constants moved'

slow_hits = {}


class Handler(http.server.BaseHTTPRequestHandler):
    def send(self, body, ctype):
        self.send_response(200)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split('?')[0]
        if path == '/':
            return self.send(b'<!doctype html><title>t</title>', 'text/html')
        if path == '/js/wiki-internals.js':
            return self.send(INTERNALS.encode(), 'text/javascript')
        if path in ('/js/wiki.js', '/js/years.js'):
            return self.send((ROOT / path[1:]).read_bytes(), 'text/javascript')
        if path in ('/slow-once', '/slow-always'):
            # A body that trickles in for 4 s, outlasting the 1.5 s attempt timeout; /slow-once is fast when retried.
            n = slow_hits[path] = slow_hits.get(path, 0) + 1
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            try:
                self.wfile.write(b'{"ok":"')
                self.wfile.flush()
                if path == '/slow-always' or n == 1:
                    for _ in range(40):
                        self.wfile.write(b'x' * 50)
                        self.wfile.flush()
                        time.sleep(0.1)
                self.wfile.write(b'"}')
            except OSError:
                pass
            self.close_connection = True
            return
        self.send_response(404)
        self.end_headers()

    def log_message(self, *args):
        pass


UNIT = r"""async () => {
  const w = await import('/js/wiki-internals.js');
  const out = [];
  function eq(name, actual, expected) {
    out.push([name, JSON.stringify(actual) === JSON.stringify(expected), JSON.stringify(actual) + ' expected ' + JSON.stringify(expected)]);
  }
  eq('lead', w.withoutYear('1876: Bell patents the telephone.', 1876), 'Bell patents the telephone.');
  eq('lead qualifier', w.withoutYear('By 407 BC: Wheelbarrow in Greece', -407), 'Wheelbarrow in Greece');
  eq('lead bare', w.withoutYear('563: Pendentive dome', 563), 'Pendentive dome');
  eq('paren', w.withoutYear('Toy Story (1995) by Pixar', 1995), 'Toy Story by Pixar');
  eq('paren end', w.withoutYear('Toy Story (1995)', 1995), 'Toy Story');
  eq('trailing', w.withoutYear('Telephone, 1876', 1876), 'Telephone');
  eq('trailing dot', w.withoutYear('Telephone invented in 1876.', 1876), 'Telephone invented');
  eq('mid stays', w.withoutYear('Bombs are used in 1221 by the Jin', 1221), 'Bombs are used in 1221 by the Jin');
  eq('other year', w.withoutYear('1984 (novel)', 1949), '1984 (novel)');
  eq('linkLabel paren', w.linkLabel('Up (2009 film)', 2009), 'Up');
  eq('linkLabel lead', w.linkLabel('1906 San Francisco earthquake', 1906), 'San Francisco earthquake');
  eq('linkLabel other lead', w.linkLabel('2001: A Space Odyssey (film)', 1968), '2001: A Space Odyssey');
  eq('linkLabel only year', w.linkLabel('1984 (novel)', 1984), '1984');
  eq('vague century', w.vagueRange('13th century: Buttons'), [1201, 1300]);
  eq('vague bc range', w.vagueRange('6th century – 2nd century BC: Medicine'), [-600, -101]);
  eq('vague mixed', w.vagueRange('6th century BC – 10th century AD: Steel'), [-600, 1000]);
  eq('vague decade', w.vagueRange('1420s: Brace'), [1420, 1429]);
  eq('vague qualifier', w.vagueRange('By at least the 3rd century BC: Screw'), [-300, -201]);
  eq('vague millennium', w.vagueRange('Late 4th millennium BC: Writing'), [-4000, -3001]);
  eq('vague none', w.vagueRange('1876: Telephone'), null);
  eq('heading year', w.headingYear('1876'), 1876);
  eq('heading bc', w.headingYear('500 BC'), -500);
  eq('heading range', w.headingYear('1945-1950'), null);
  eq('heading decade', w.headingYear('1870s'), null);
  eq('heading word', w.headingYear('Films'), null);
  eq('dateOnly', w.dateOnly('November 22, 1995[a]'), 1995);
  eq('dateOnly paren', w.dateOnly('1995 (Japan)'), 1995);
  eq('dateOnly words', w.dateOnly('Released in 1995 worldwide'), null);
  eq('shorten initials', w.shorten('Public-key cryptography is invented and developed by James H. Ellis, Clifford Cocks, Malcolm J. Williamson, Whitfield Diffie and others.'), 'Public-key cryptography is invented and developed by James H. Ellis, Clifford Cocks, Malcolm J. Williamson, Whitfield…');
  eq('shorten sentence', w.shorten('Alexander Graham Bell has a patent granted for the telephone. However, other inventors before Bell had worked on the development of the telephone.'), 'Alexander Graham Bell has a patent granted for the telephone.');
  eq('wikidataYear', w.wikidataYear({ time: '+1876-03-10T00:00:00Z', precision: 11 }), 1876);
  eq('wikidataYear bc', w.wikidataYear({ time: '-0500-00-00T00:00:00Z', precision: 9 }), -500);
  eq('wikidataYear century', w.wikidataYear({ time: '+1500-00-00T00:00:00Z', precision: 7 }), null);
  const claim = (time, precision, rank) => ({ rank: rank || 'normal', mainsnak: { snaktype: 'value', datavalue: { type: 'time', value: { time, precision } } } });
  eq('entityYear order', w.entityYear({ P577: [claim('+1995-11-22T00:00:00Z', 11)], P571: [claim('+1993-00-00T00:00:00Z', 9)] }), 1993);
  eq('entityYear earliest', w.entityYear({ P577: [claim('+1996-01-01T00:00:00Z', 11), claim('+1995-11-22T00:00:00Z', 11)] }), 1995);
  eq('entityYear skips imprecise', w.entityYear({ P575: [claim('+1500-00-00T00:00:00Z', 7)], P571: [claim('+1510-00-00T00:00:00Z', 9)] }), 1510);
  eq('entityYear deprecated', w.entityYear({ P571: [claim('+1000-00-00T00:00:00Z', 9, 'deprecated'), claim('+1510-00-00T00:00:00Z', 9)] }), 1510);
  eq('entityYear future', w.entityYear({ P577: [claim('+2099-01-01T00:00:00Z', 11)] }), null);
  eq('entityYear novalue', w.entityYear({ P571: [{ rank: 'normal', mainsnak: { snaktype: 'novalue' } }] }), null);
  eq('alias iPhone', w.linkLabel('IPhone 17 Pro', 2025, 'iPhone 17 Pro'), 'iPhone 17 Pro');
  eq('alias telephone', w.linkLabel('Telephone', 1876, 'telephone'), 'Telephone');
  eq('alias longer', w.linkLabel('IPhone 4s', 2011, 'iPhone 4S (16 GB)'), 'iPhone 4s');
  eq('alias short', w.linkLabel('IPad Mini (6th generation)', 2021, 'iPad Mini'), 'iPad Mini');
  eq('month day', w.textLabel({ text: 'October 20: Stanisław Mikołajczyk flees', year: 1947 }), 'Stanisław Mikołajczyk flees');
  eq('month day range', w.textLabel({ text: 'December 21–27: The launch of Apollo 8', year: 1968 }), 'The launch of Apollo 8');
  eq('day month', w.textLabel({ text: '4 February – Yalta Conference', year: 1945 }), 'Yalta Conference');
  eq('month only', w.textLabel({ text: 'March: Truman Doctrine', year: 1947 }), 'Truman Doctrine');
  eq('month cross', w.textLabel({ text: 'June 24 – May 12: Berlin Blockade', year: 1948 }), 'Berlin Blockade');
  eq('may word', w.textLabel({ text: 'May Day parade happens', year: 1950 }), 'May Day parade happens');
  return out;
}"""


def row(*cells):
    return '<tr>' + ''.join(cells) + '</tr>'


def td(html):
    return '<td>' + html + '</td>'


def a(title, text=None):
    return ('<a href="/wiki/' + urllib.parse.quote(title.replace(' ', '_')) + '" title="' + title + '">' +
            (text or title) + '</a>')


def flag(country):
    return ('<span class="flagicon"><span typeof="mw:File"><a href="/wiki/' + country + '" title="' + country +
            '"><img alt="' + country + '" src="f.png"></a></span></span> ')


PAGES = {
    'Winners': (
        '<table class="wikitable">' + row('<th>Year of film release (ceremony)</th>', '<th>Film</th>', '<th>Studio</th>')
        + row(td(a('1943 in film', '1943') + ' ' + a('16th Academy Awards', '(16th)')), td(a('Casablanca (film)', 'Casablanca')), td(a('Warner Bros.')))
        + row(td(a('1944 in film', '1944') + ' ' + a('17th Academy Awards', '(17th)')), td(a('Going My Way')), td(a('Paramount Pictures', 'Paramount')))
        + row(td(a('1945 in film', '1945') + ' ' + a('18th Academy Awards', '(18th)')), td(a('The Lost Weekend')), td(a('Paramount Pictures', 'Paramount')))
        + '</table>'
        + '<table class="wikitable">' + row('<th>Year</th>', '<th>Winners</th>', '<th>Score</th>')
        + row(td(a('1930 FIFA World Cup', '1930')), td(a('Uruguay national football team', 'Uruguay')), td('4–2'))
        + row(td(a('1934 FIFA World Cup', '1934')), td(a('Italy national football team', 'Italy')), td('2–1'))
        + '</table>'
        + '<table class="wikitable">' + row('<th>Season</th>', '<th>Driver</th>', '<th>Age</th>')
        + row(td(a('1950 Formula One season', '1950')), td(flag('Italy') + a('Giuseppe Farina')), td('44'))
        + row(td(a('1951 Formula One season', '1951')), td(flag('Argentina') + a('Juan Manuel Fangio')), td('40'))
        + row(td(a('1952 Formula One season', '1952')), td(flag('Italy') + a('Alberto Ascari')), td('34'))
        + '</table>'
        + '<table class="wikitable">' + row('<th>Driver</th>', '<th>Titles</th>', '<th>Season(s)</th>')
        + row(td(flag('Germany') + a('Michael Schumacher')), td('7'), td('1994'))
        + row(td(flag('United Kingdom') + a('Lewis Hamilton')), td('7'), td('2008'))
        + '</table>'
        + '<table class="wikitable">' + row('<th>Title</th>', '<th>Year</th>')
        + row(td(a('1917 (2019 film)', '1917')), td('2019'))
        + row(td(a('Parasite (2019 film)', 'Parasite')), td('2019'))
        + '</table>'
        + '<ul><li>' + a('1st Academy Awards', '1927/28') + '–' + a('2nd Academy Awards', '1928/29') + ': ' + a('Winners') + '</li></ul>'
    ),
    'Discography': (
        '<h2>Studio albums</h2><table class="wikitable">' + row('<th>Title</th>', '<th>Album details</th>', '<th>Peak</th>')
        + row('<th scope="row">' + a('The Piper at the Gates of Dawn') + '</th>', td('<ul>\n<li>Released: 4 August 1967 (UK)</li>\n<li>Label: ' + a('Columbia Graphophone Company', 'Columbia') + '</li>\n</ul>'), td('6'))
        + row('<th scope="row">' + a('The Dark Side of the Moon') + '</th>', td('<ul>\n<li>Released: 1 March 1973</li>\n<li>Label: ' + a('Harvest Records', 'Harvest') + '</li>\n</ul>'), td('2'))
        + row('<th scope="row">' + a('The Wall') + '</th>', td('<ul>\n<li>Released: 30 November 1979</li>\n<li>Label: Harvest</li>\n</ul>'), td('3'))
        + '</table><h2>Singles</h2><table class="wikitable">' + row('<th>Year</th>', '<th>Title</th>')
        + row(td('1967'), td(a('Arnold Layne')))
        + row(td('1967'), td(a('See Emily Play')))
        + row(td('1979'), td(a('Another Brick in the Wall')))
        + row(td('1983'), td(a('Not Now John')))
        + '</table>'
    ),
    'Ancient': (
        '<ul>'
        + '<li><figure typeof="mw:File/Thumb"><a href="/wiki/File:Map.png"><img src="m.png"></a><figcaption>The Eastern Hemisphere in '
        + a('500 BC') + ', with the ' + a('Achaemenid Empire') + '</figcaption></figure><b>509 BC:</b> Expulsion of Lucius Tarquinius Superbus, founding of the '
        + a('Roman Republic') + ' and its consuls.</li>'
        + '<li><b>490 BC:</b> The Athenians defeat the Persians at the ' + a('Battle of Marathon') + ' in Greece.</li>'
        + '<li><b>480 BC:</b> The Spartans hold the pass at the ' + a('Battle of Thermopylae') + ' for three days.</li>'
        + '</ul>'
    ),
    'Discoveries': (
        '<ul>'
        + '<li>1543: ' + a('Nicolaus Copernicus') + ' publishes his heliocentric model of the solar system.</li>'
        + '<li>1600: ' + a('William Gilbert (physicist)', 'William Gilbert') + ' describes the Earth as a giant magnet.</li>'
        + '<li>1609: ' + a('Johannes Kepler') + ' publishes the first two laws of planetary motion.</li>'
        + '<li>16th century: ' + a('Tycho Brahe') + ' proves that comets are astronomical objects beyond the Moon.</li>'
        + '</ul>'
    ),
    'Scientists': '<ul>' + ''.join('<li>' + a(n) + '</li>' for n in ['Isaac Newton', 'Marie Curie']) + '</ul>',
    'Many': '<ul>' + ''.join('<li>' + a('Thing ' + str(i)) + '</li>' for i in range(25)) + '</ul>',
    'Quantities': (
        '<table class="wikitable">' + row('<th>Date (CE) or years from now</th>', '<th>Event</th>')
        + row(td('10<sup>15</sup> (1 quadrillion)'), td(a('Black dwarf') + ' stars cool'))
        + row(td('1 trillion'), td(a('Star formation') + ' ends'))
        + row(td('110–120 trillion'), td(a('Red dwarf') + ' stars die'))
        + row(td('1.16×10<sup>67</sup>'), td(a('Solar mass') + ' black holes evaporate'))
        + row(td('2000'), td(a('Millennium') + ' passes'))
        + '</table>'
    ),
    'Ranges': (
        '<table class="wikitable">' + row('<th>Name</th>', '<th>Period</th>')
        + row(td(a('Çatalhöyük')), td('c. 7,100 – 5,700 BCE'))
        + row(td(a('Göbekli Tepe')), td('9,500 – 8,000 BC'))
        + '</table>'
        + '<table class="wikitable">' + row('<th>Name</th>', '<th>Completed</th>')
        + row(td(a('Pyramid of Userkaf')), td('2494~2345 BC'))
        + row(td(a('Temple of Artemis')), td('470~469 BC'))
        + '</table>'
    ),
}

CLAIMS = {
    'Tycho Brahe': {'P569': '+1546-12-14T00:00:00Z'},
    'Isaac Newton': {'P569': '+1643-01-04T00:00:00Z'},
    'Marie Curie': {'P569': '+1867-11-07T00:00:00Z'},
}
wikidata_batches = []


def query(route):
    return dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(route.request.url).query))


def wikipedia(route):
    q = query(route)
    if q.get('action') == 'parse':
        body = {'parse': {'title': q['page'], 'text': PAGES[q['page']]}}
    elif q.get('action') == 'query':
        body = {'query': {'pages': [{'title': t, 'ns': 0, 'pageid': i + 1, 'description': ''}
                                    for i, t in enumerate(q['titles'].split('|'))]}}
    else:
        body = {'error': {'info': 'unexpected ' + route.request.url}}
    route.fulfill(status=200, headers={'Access-Control-Allow-Origin': '*'}, content_type='application/json',
                  body=json.dumps(body))


def wikidata(route):
    titles = query(route)['titles'].split('|')
    wikidata_batches.append(len(titles))
    entities = {}
    for i, t in enumerate(titles):
        claims = {p: [{'rank': 'normal', 'mainsnak': {'snaktype': 'value', 'datavalue': {
            'type': 'time', 'value': {'time': v, 'precision': 11}}}}] for p, v in CLAIMS.get(t, {}).items()}
        entities['Q%d' % (i + 1)] = {'id': 'Q%d' % (i + 1), 'sitelinks': {'enwiki': {'site': 'enwiki', 'title': t}},
                                     'claims': claims}
    route.fulfill(status=200, headers={'Access-Control-Allow-Origin': '*'}, content_type='application/json',
                  body=json.dumps({'entities': entities}))


GET_JSON = '''async ([path, abortAfter]) => {
    const w = await import('/js/wiki-internals.js');
    const ctl = new AbortController();
    if (abortAfter) setTimeout(() => ctl.abort(new DOMException('Cancelled', 'AbortError')), abortAfter);
    try { return await w.getJson(location.origin + path, 'Test', {}, ctl.signal); }
    catch (err) { return err.name + ': ' + err.message; }
}'''

srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
threading.Thread(target=srv.serve_forever, daemon=True).start()
try:
    with sync_playwright() as pw:
        browser = launch(pw)
        page = watch(browser.new_page(), 'wiki')
        page.route('https://en.wikipedia.org/w/api.php*', wikipedia)
        page.route('https://www.wikidata.org/w/api.php*', wikidata)
        page.goto('http://127.0.0.1:%d/' % srv.server_address[1])

        for name, ok, detail in page.evaluate(UNIT):
            expect(ok, name + ': ' + detail)

        def build(title):
            return page.evaluate('''async (title) => {
                const wiki = await import('/js/wiki.js');
                try { return await wiki.buildCards(title, () => {}, null, null); }
                catch (err) { return { error: err.name + ': ' + err.message, cards: [] }; }
            }''', title)

        def years(r):
            return {c['label']: c['year'] for c in r['cards']}

        # A year column whose links name editions, seasons or ceremonies is not the item column.
        w = years(build('Winners'))
        expect(w.get('Casablanca') == 1943 and w.get('Going My Way') == 1944 and not any('Academy Awards' in k for k in w),
               'winners: films, not ceremonies %s' % w)
        expect(w.get('Uruguay national football team') == 1930 and 'FIFA World Cup' not in w,
               'winners: FIFA winners, not editions %s' % w)
        expect(w.get('Giuseppe Farina') == 1950 and w.get('Alberto Ascari') == 1952 and 'Formula One season' not in w
               and 'Italy' not in w, 'winners: drivers, not seasons or flag countries %s' % w)
        expect(w.get('Michael Schumacher') == 1994, 'winners: a Titles count column is not the item %s' % w)
        expect(w.get('1917') == 2019, 'winners: a film titled with a year stays %s' % w)

        # Discography tables date albums from a "Released:" line.
        d = years(build('Discography'))
        expect(d.get('The Piper at the Gates of Dawn') == 1967 and d.get('The Dark Side of the Moon') == 1973
               and d.get('The Wall') == 1979, 'discography: albums dated from Released: %s' % d)
        expect(d.get('Arnold Layne') == 1967, 'discography: singles kept %s' % d)

        # Figure captions inside a list item are not part of it.
        r = build('Ancient')
        rr = next((c for c in r['cards'] if c['title'] == 'Roman Republic'), None)
        expect(rr is not None and rr['year'] == -509,
               'caption: Roman Republic card dated -509 %s' % [(c['title'], c['year']) for c in r['cards']])
        expect(rr is not None and 'Hemisphere' not in rr['textLabel'] and 'Hemisphere' not in rr['context'],
               'caption: label has no caption text %s' % rr)
        expect(not any(c['title'] == 'Achaemenid Empire' for c in r['cards']),
               'caption: no card from a caption link %s' % [c['title'] for c in r['cards']])

        # An entry-text card never takes a birth year from Wikidata; an article-title card does.
        r = build('Discoveries')
        tb = next((c for c in r['cards'] if c['title'] == 'Tycho Brahe'), None)
        expect(r.get('labelMode') == 'text', 'text mode: page builds in text mode %s' % r.get('labelMode'))
        expect(tb is not None and tb['year'] is None and 'noyear' in tb['flags'],
               'text mode: no birth year for an event card %s' % tb)
        s = years(build('Scientists'))
        expect(s.get('Isaac Newton') == 1643 and s.get('Marie Curie') == 1867, 'link mode: people dated by birth %s' % s)

        wikidata_batches.clear()
        build('Many')
        expect(wikidata_batches and max(wikidata_batches) <= 10 and sum(wikidata_batches) == 25,
               'wikidata: at most 10 titles per request %s' % wikidata_batches)

        q = years(build('Quantities'))
        expect(q.get('Black dwarf') is None and q.get('Star formation') is None and q.get('Red dwarf') is None
               and q.get('Solar mass') is None, 'quantities: exponents and -illions are not years %s' % q)
        expect(q.get('Millennium') == 2000, 'quantities: a real date in the column still counts %s' % q)

        g = years(build('Ranges'))
        expect(g.get('Çatalhöyük') == -7100 and g.get('Göbekli Tepe') == -9500,
               'ranges: comma-grouped BC range gives its start %s' % g)
        expect(g.get('Pyramid of Userkaf') == -2494 and g.get('Temple of Artemis') == -470,
               'ranges: tilde range gives its BC start %s' % g)

        # A body that outlasts the attempt timeout is retried, and running out of retries reports a timeout.
        r = page.evaluate(GET_JSON, ['/slow-once', 0])
        expect(isinstance(r, dict) and 'ok' in r and slow_hits.get('/slow-once') == 2,
               'timeout: slow body retried %s %s' % (r, slow_hits))
        r = page.evaluate(GET_JSON, ['/slow-always', 0])
        expect(isinstance(r, str) and 'timed out' in r and 'aborted' not in r,
               'timeout: exhausted retries report a timeout, not a user abort: %s' % r)
        r = page.evaluate(GET_JSON, ['/slow-always', 300])
        expect(r == 'AbortError: Cancelled', 'timeout: a caller abort still rejects with its reason: %s' % r)
        browser.close()
finally:
    srv.shutdown()
    srv.server_close()

finish('wiki')
