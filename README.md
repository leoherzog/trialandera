# Trial and Era

Trial and Era is a host console and pop-out scoreboard for a card game in the style of Timeline. The host builds a deck of events, inventions and works, each with a year, from Wikipedia list pages or by typing them. Players take turns placing a card from their hand into a shared timeline, and the host acts for all of them. It is a static site with no build step and no backend.

## Running locally

Serve the folder over HTTP, because browsers refuse to load ES modules from `file://`.

```sh
uv run python -m http.server 8000
# or: python3 -m http.server 8000
```

Open http://localhost:8000/ for the splash page, whose "Start game" leads to the host console at `host.html`. The lobby's own "Start game" opens the scoreboard in a popup named `trial-and-era-scoreboard`, the window to screen-share. If the browser blocks it, use "Open scoreboard" in the header.

## Deploying

Publish the repository root on any static host. On GitHub Pages, deploy from your branch's `/ (root)` folder. On Cloudflare Pages, use no framework preset, no build command, and `/` as the output directory, or run `npx wrangler pages deploy . --project-name timeline`.

The site lives at https://trialandera.spitball.show/. Link previews and search need absolute URLs, so `index.html`, `robots.txt`, `sitemap.xml` and `tests/seo.test.mjs` all name it, and a deploy elsewhere must change all four.

Only Cloudflare Pages applies the Content Security Policy in `_headers`, so a violation shows up only once deployed. The policy blocks inline scripts and `eval`, and its `connect-src` allows only `https://en.wikipedia.org` and `https://www.wikidata.org`, so any new origin must be added to it. Inline styles stay allowed for the `<style>` blocks in the splash and host pages, the `<style>` Font Awesome injects, and Wikipedia's HTML, which the parsed copy checks against the page's policy. `font-src` allows jsDelivr for the Acme and Permanent Marker files, and `data:` images stay allowed for Pico's form icons.

## How a game runs

1. Add up to eight players, order them, and press "Start game".
2. Build the deck from Wikipedia pages, typed cards or a deck file, and review it.
3. Set cards per hand and press "Deal". It stays disabled until the deck has enough included cards with a year: a hand for each player plus one to start the timeline.
4. Each turn, pick the card the active player names, then the gap they choose by clicking it or dragging the card onto it, and press "Reveal". The arrow keys, Home and End move between gaps, and Enter or Space picks one. Picking the chosen gap again clears it.
5. "Undo last" reverses placements one at a time, including the one that ended the game. At the end, "Play again" deals again from the same deck and players, and "Edit deck" returns to deck building.

Settings has "New game", which drops the current game and returns to the lobby with the players, hand size and deck.

The scoreboard shows the host's picks as they are made and animates each reveal, except under reduced motion or for placements made before it loaded. Neither window shows the year of a card in a hand, but the host's deck table lists every year, so share only the scoreboard.

## Rules

Each player is dealt the hand size, 1 to 8 cards, and one more card starts the timeline face up. Turns go in seat order. Each game starts one seat later than the last, and "New game" starts that count over.

A placement is correct when the card's year is no earlier than its left neighbor's and no later than its right neighbor's, so equal years fit on either side. A wrong card goes to the discard pile and the player draws a replacement, so a wrong guess never changes hand size. When the draw pile runs out, the discard pile except the card just missed is shuffled into a new one, and when that leaves nothing to draw, the card returns to the hand.

A round is one turn for each seat. A player who empties their hand is finished, and the round still plays out. When a round ends with nobody finished, the next begins with the same players, and with one finished, that player wins. With several, sudden death begins: only they play on, each drawing one card, and this repeats until a round ends with exactly one finished. Finalists share the win when the draw and discard piles together hold fewer cards than there are finalists.

Standings list winners first, then players who lasted longer in sudden death, then fewest cards in hand. Equal rows share a rank in lobby order. Undo reaches back 50 placements.

## Building a deck

Search for a list or timeline page, or paste an English Wikipedia URL, and press "Build"; picking a suggestion builds it at once. Removing a source in the Sources table removes its cards.

Each list item, defined term and table row with an article link becomes a card for the first article it links, taken from the item column in a table. A term with no definition after it is a heading, not a card. Entries that link a disambiguation page are dropped, and so are undated side lists, such as a count by country, on a mostly dated page. Repeats within a page collapse to one card per article, or per article and text on an entry-text source. The full rules live in `js/wiki.js`.

Adding to the deck skips a card with the same year as one already there and the same label or, where both show article titles, the same article. Labels compare without case, accents or punctuation. A source built again keeps its label mode.

## Where years come from

A card takes its year from the page where it can, such as from a date column, a "Released:" label, a year its list item leads with, or a year heading above it. An entry the page leaves undated can take one from its article's Wikidata item, such as its inception, publication or birth date. An entry-text card describes an event rather than its first link, so it takes a Wikidata year only when its text opens with a century, millennium or decade that contains it, and never a birth date. Switching a source to article titles later changes only its labels, so cards the build left undated stay undated.

Years read like "1876", "c. 1440", "500 BC", "AD 79" or "March 10, 1876", and a range gives its first year. Decades such as "1440s" are not years. Years run from 10,000 BC to the current year, with no year 0.

## Labels and flags

Each card has two built labels: the linked article's title, and the entry's own text cut to a sentence or about 120 characters. A link whose text is its own target keeps that name when it redirects, so "Crock-Pot" stays Crock-Pot rather than Slow cooker. Both drop the card's year where it leads, so "1906 San Francisco earthquake" reads "San Francisco earthquake", and the entry text also drops it where it ends or sits in parentheses. Entry text that opens with a century, millennium or decade, as in "6th millennium BC: Irrigation", loses it only when the build found the card's year, so a card whose year the host types keeps it until the label is edited.

Timeline pages start on entry text, and other lists on article titles. The Labels select in the Sources table switches between the two and leaves labels the host has edited alone. Clearing an edited label restores the built one.

In the deck table, small print under each label gives the card's source, article, short description and entry text, which often give the year away. The filter searches all of these once typing pauses, and the view select narrows the table to included, excluded, undated or flagged cards.

- **no year**: the card has none. It starts excluded.
- **year in label**: the label shows the year's number, even as "9,600 BC" or in a season such as "1946–47". It starts excluded.
- **loose year**: the year was the first found anywhere in a list item's text. Typing a year clears it.
- **duplicate**: another included card shows the same label, or links the same article where both show article titles.

Editing a label or year, or switching label mode, excludes a card when it sets no year or year in label, and includes it again when it clears them, unless the host unchecked it. The checkbox can still override either. A year the deck table cannot read is marked invalid and leaves the card without one.

In play, a card also shows its short description under the label, in both windows. A deal drops the card's year where it leads the description, ends it or sits in parentheses, so "1985 video game" reads "Video game". A description that still names a year, decade, century or millennium is left off the card.

## Typed cards and deck files

"Type cards" opens a form for one label and year, and a box that takes one card per line with the year first or last, as in "1876 Telephone" or "Great Pyramid of Giza, 2560 BC". When both ends read as a year the end wins, so "2001: A Space Odyssey, 1968" is a card for 1968. In the box, a bare number under 1000 needs an era, and lines with no year at either end stay behind to fix. Typed cards go under a source named Typed.

"Export deck" downloads `trial-and-era-deck.json`. Importing one merges it like a build: repeats are skipped, cards keep their description, their include setting and whether the host unchecked them, and each source keeps its label mode unless the deck already has one by that name. A bare JSON array of cards imports too, and cards that name no source go under Imported.

## Data and state

All data comes from the browser: the MediaWiki Action API on en.wikipedia.org and the Wikidata API on www.wikidata.org. Every request carries an `Api-User-Agent` header, which both hosts allow in their CORS preflight. Requests share a budget of 180 per rolling minute, under Wikimedia's limit of 200 for unauthenticated browsers. A build spends one request on the page, one per 50 titles it resolves, and one per 10 undated articles on Wikidata. Failed, rate-limited and timed-out requests retry with backoff for about a minute.

Game state, deck included, lives in `localStorage` under `trial-and-era:v1`, and host UI state under `trial-and-era:v1:ui` so typing never wakes the scoreboard. Built lists are cached under `trial-and-era:list:r<RULES>:<title>` and never expire, so a page edited since its build stays as built until `RULES` in `js/wiki.js` changes. Bump it whenever extraction changes. At startup the host deletes lists from other rules and game and UI keys from older versions, but keeps newer ones so a stale tab cannot wipe a newer deploy's game. When storage fills, cached lists go first. The theme choice lives under `trial-and-era:theme`, which cleanup leaves alone.

The saved state has this shape. Bump `VERSION` in `js/store.js` whenever it changes. Startup cleanup then deletes the old key, deck included, so hosts lose any deck they have not exported.

```js
state = {
  settings: { handSize },
  players: [{ id, name }],
  nextId,
  phase,                // 'lobby', 'setup', 'playing' or 'over'
  deck: { cards: [Card], sources: [{ name, title, labelMode }], nextCardId },  // labelMode: 'link' or 'text'
  gameNumber,           // games dealt so far
  placementSeq,         // next placement id; undo never rolls it back, so a redone placement animates again
  game                  // null until the first deal
}

Card = {
  id, source, title,    // source name; linked Wikipedia article or null
  linkLabel, textLabel, // built labels from the article title and from the entry text
  label, labelEdited,   // what players see; an edited label survives a label mode switch
  year,                 // integer, negative for BC, never 0; null when unknown
  yearFrom,             // 'list', 'wikidata', 'typed' or null
  description, context, // either may give the year away; the deck table shows both, and cards in play a cleaned description
  include, excludedByHost,
  flags                 // 'noyear', 'leak', 'guess', 'duplicate'
}

game = {
  number,
  cards: { [id]: { id, label, year, description } },  // copied at deal, so deck edits never touch a game; description is '' when it would give the year away
  draw: [id],           // the top is the last element
  discard: [id],
  timeline: [id],       // oldest first; gap i inserts before timeline[i]
  hands: { [playerId]: [id] },
  seats: [playerId],    // who plays this round, in turn order
  turn, round, suddenDeath,
  finished: [playerId], // emptied their hand this round
  pending: { cardId, index },  // the host's choice before reveal, shown as the ghost card
  log: [{ id, round, playerId, cardId, index, correct, year, drawn }],  // drawn: card id or null
  winners: [playerId],
  out: { [playerId]: round },  // last round each player knocked out of sudden death played
  history: [snapshot]   // undo stack, at most 50; see remember() in js/game.js
}
```

Browsers give a site about 5 MB, and a dealt game copies each card it uses. When the deck and the dealt game would come near that, the deal summary warns that the scoreboard could stop following the game; removing a source or excluding cards makes room. A failed save says the scoreboard will miss the change and a reload will lose it, and that message stays up.

The host console is the only writer. The scoreboard re-renders on `storage` events, which browsers fire only in other windows. Refreshing either window restores the game, and the host resumes an interrupted build.

## Files

| File | Role |
| --- | --- |
| `index.html` | Splash page, the one page with search and link-preview tags |
| `host.html`, `js/host.js` | Host console |
| `js/theme.js` | Theme button for the splash page and host console, a blocking `<head>` script so the saved theme applies before first paint |
| `scoreboard.html`, `js/scoreboard.js` | Screen-shared scoreboard |
| `js/store.js` | State, persistence, list cache, cross-window sync |
| `js/wiki.js` | Wikipedia and Wikidata client, card building |
| `js/years.js` | Year parsing and formatting |
| `js/game.js` | Rules of play, with no DOM or storage |
| `js/dom.js` | Helpers shared by both pages |
| `css/app.css` | Scoreboard styles; the splash and host pages keep their few rules inline |
| `favicon.svg` | Font Awesome's `timeline` in Pico's orange as literal hex, because an SVG image cannot read CSS variables |
| `apple-touch-icon.png` | The same icon on Pico's dark background, 180 pixels square, for home screens |
| `og.png` | Link preview image at 1200 × 630, the size `og:image:width` and `og:image:height` state |
| `robots.txt`, `sitemap.xml` | Crawler rules and the one page to index; the host console and scoreboard opt out with `noindex` |
| `_headers` | Content Security Policy for Cloudflare Pages |
| `tests/` | Node and browser test suites |

All three pages load Pico CSS 2.1.1's orange theme and Fontsource's Acme and Permanent Marker 5.3.0 from jsDelivr with Subresource Integrity hashes, so a version change means updating `integrity` in each. Acme sets headings and years, and Permanent Marker the wordmark. The scoreboard also loads Pico's `pico.colors.min.css` from the floating `@2` tag with no integrity hash, for its amber, jade and red marks. All three load Font Awesome Free 7 from jsDelivr's floating `@7` tag.

## Testing

The rules, year parsing and search metadata have Node tests, run from the repository root:

```sh
node --test
```

The browser suites drive headless Chromium through the host console and scoreboard, including whole games with sudden death. `tests/run.py` serves the repository on a free port with the Content Security Policy from `_headers`, so policy violations fail locally too, as do console and page errors.

```sh
uv run tests/run.py                  # offline suites, with Wikipedia mocked
uv run tests/run.py host scoreboard  # only these suites
uv run tests/run.py --live           # also build decks from live Wikipedia
```

`--shots` saves screenshots to `tests/artifacts/`, which git ignores. The offline suites still need internet for Pico CSS, the fonts and Font Awesome. The runner uses Playwright's Chromium, installed with `uvx playwright install chromium`, and on Linux falls back to the newest one already under `~/.cache/ms-playwright`.

## License

The MIT License (MIT)

Copyright © 2026 Leo Herzog

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## About Me

<a href="https://herzog.tech/" target="_blank">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://herzog.tech/signature/link-light.svg.png">
    <source media="(prefers-color-scheme: light)" srcset="https://herzog.tech/signature/link.svg.png">
    <img src="https://herzog.tech/signature/link.svg.png" width="32px">
  </picture>
</a>
<a href="https://mastodon.social/@herzog" target="_blank">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://herzog.tech/signature/mastodon-light.svg.png">
    <source media="(prefers-color-scheme: light)" srcset="https://herzog.tech/signature/mastodon.svg.png">
    <img src="https://herzog.tech/signature/mastodon.svg.png" width="32px">
  </picture>
</a>
<a href="https://github.com/leoherzog" target="_blank">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://herzog.tech/signature/github-light.svg.png">
    <source media="(prefers-color-scheme: light)" srcset="https://herzog.tech/signature/github.svg.png">
    <img src="https://herzog.tech/signature/github.svg.png" width="32px">
  </picture>
</a>
<a href="https://keybase.io/leoherzog" target="_blank">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://herzog.tech/signature/keybase-light.svg.png">
    <source media="(prefers-color-scheme: light)" srcset="https://herzog.tech/signature/keybase.svg.png">
    <img src="https://herzog.tech/signature/keybase.svg.png" width="32px">
  </picture>
</a>
<a href="https://www.linkedin.com/in/leoherzog" target="_blank">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://herzog.tech/signature/linkedin-light.svg.png">
    <source media="(prefers-color-scheme: light)" srcset="https://herzog.tech/signature/linkedin.svg.png">
    <img src="https://herzog.tech/signature/linkedin.svg.png" width="32px">
  </picture>
</a>
<a href="https://hope.edu/directory/people/herzog-leo/" target="_blank">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://herzog.tech/signature/anchor-light.svg.png">
    <source media="(prefers-color-scheme: light)" srcset="https://herzog.tech/signature/anchor.svg.png">
    <img src="https://herzog.tech/signature/anchor.svg.png" width="32px">
  </picture>
</a>
<br />
<a href="https://herzog.tech/$" target="_blank">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://herzog.tech/signature/mug-tea-saucer-solid-light.svg.png">
    <source media="(prefers-color-scheme: light)" srcset="https://herzog.tech/signature/mug-tea-saucer-solid.svg.png">
    <img src="https://herzog.tech/signature/mug-tea-saucer-solid.svg.png" alt="Buy Me A Tea" width="32px">
  </picture>
  Found this helpful? Buy me a tea!
</a>
