# /// script
# requires-python = ">=3.12"
# dependencies = ["playwright>=1.64.0"]
# ///
"""Runs the browser suites in headless Chromium against the repo served on a free local port with the
Content-Security-Policy from _headers, and prints a PASS or FAIL line for each.

Usage: uv run tests/run.py [--live] [--shots] [suite ...]
  --live   also run the suites that build decks from live Wikipedia
  --shots  save screenshots under tests/artifacts/
  suite    run only these, by name, such as host or scoreboard
"""
import argparse, functools, http.server, os, re, subprocess, sys, threading, time
from pathlib import Path

TESTS = Path(__file__).resolve().parent
ROOT = TESTS.parent
SUITES = ['store', 'csp', 'wiki', 'host', 'deck', 'scoreboard', 'game']
LIVE = ['wiki_live']
# Seconds before a hung suite is stopped and counted as failed.
TIMEOUT = 1200


def policy():
    for line in (ROOT / '_headers').read_text().splitlines():
        line = line.strip()
        if line.startswith('Content-Security-Policy:'):
            return line.split(':', 1)[1].strip()
    raise SystemExit('_headers has no Content-Security-Policy')


class Handler(http.server.SimpleHTTPRequestHandler):
    csp = None

    def end_headers(self):
        self.send_header('Content-Security-Policy', self.csp)
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def log_message(self, *args):
        pass


def main():
    ap = argparse.ArgumentParser(description='Run the browser suites.')
    ap.add_argument('--live', action='store_true', help='also run the live Wikipedia suites')
    ap.add_argument('--shots', action='store_true', help='save screenshots under tests/artifacts/')
    ap.add_argument('suites', nargs='*', help='suite names: ' + ', '.join(SUITES + LIVE))
    args = ap.parse_args()
    names = args.suites or SUITES + (LIVE if args.live else [])
    unknown = [n for n in names if n not in SUITES + LIVE]
    if unknown:
        ap.error('unknown suite: ' + ', '.join(unknown))

    Handler.csp = policy()
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Handler, directory=str(ROOT)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = 'http://127.0.0.1:%d/' % server.server_address[1]
    env = dict(os.environ)
    if args.shots:
        env['SHOTS'] = str(TESTS / 'artifacts')
    print('Serving', ROOT, 'at', base, 'with its CSP', flush=True)

    failed = []
    try:
        for name in names:
            start = time.time()
            try:
                run = subprocess.run([sys.executable, str(TESTS / ('test_%s.py' % name)), base], cwd=ROOT, env=env,
                                     capture_output=True, text=True, timeout=TIMEOUT)
                out, code = run.stdout + run.stderr, run.returncode
            except subprocess.TimeoutExpired as err:
                out, code = (err.stdout or b'').decode() + '\ntimed out after %d s' % TIMEOUT, -1
            secs = time.time() - start
            counted = re.findall(r': (\d+) checks passed', out)
            detail = (counted[-1] + ' checks, ' if counted and code == 0 else '') + '%.0f s' % secs
            print('%s  %-11s %s' % ('PASS' if code == 0 else 'FAIL', name, detail), flush=True)
            if code != 0:
                failed.append(name)
                for line in out.strip().splitlines()[-40:]:
                    print('      ' + line)
    finally:
        server.shutdown()
        server.server_close()
    print('%d of %d suites passed' % (len(names) - len(failed), len(names)))
    sys.exit(1 if failed else 0)


if __name__ == '__main__':
    main()
