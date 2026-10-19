# Trial and Era

Trial and Era is a host console and pop-out scoreboard for a card game in the style of Timeline. The host builds a deck of cards, each an event, invention or work with a year, from Wikipedia list pages or by typing them. Players take turns placing a card from their hand into a shared timeline, and the host acts for all of them. It is a static site with no build step and no backend, modeled on `../wikiest-link`: same file layout, Pico CSS 2.1.1, Font Awesome 7, and localStorage sync between the two windows.

## Design rules

- Pico CSS 2 semantic markup, as few custom classes as possible. Style through ids, elements, ARIA attributes and `data-*` attributes. The only classes in markup are Font Awesome's and Pico's own (`secondary`, `contrast`, `outline`, `container`).
- Native browser APIs over libraries: `<dialog>`, `<template>`, `<datalist>`, `command`/`commandfor`, HTML drag and drop, the Web Animations API, `Intl`, `AbortSignal.any`. No frameworks, no bundler.
- Same idioms as wikiest-link: ES modules, `function` declarations, `$()` and `icon()` helpers, templates cloned with `document.importNode`, one `commit()` that saves then renders.
- The host console follows the system theme with an auto/light/dark button. The scoreboard is always Pico dark, laid out on a 16:9 stage that scales with the window.
- Code comments and docs follow the writing rules in the user's CLAUDE.md.

## Rules of play

- Players: 1 to 8, in seat order set in the lobby.
- Each player is dealt `handSize` cards, a setting from 1 to 8, default 4. One more card is turned face up to start the timeline.
- Turns go in seat order. Game n starts with seat (n − 1) mod players, so the first seat rotates each game.
- On a turn the host picks a card from the active player's hand and a gap in the timeline, then reveals.
- A placement is correct when the card's year is at least its left neighbor's and at most its right neighbor's. Equal years fit on either side. A correct card joins the timeline with its year shown.
- A wrong card has its year revealed, goes to the discard pile, and the player draws a replacement. When the draw pile is empty, the discard pile except that card is shuffled into a new draw pile. When that is empty too, the card goes back to the hand. A wrong guess never changes hand size.
- A round is one turn for each seat. A player who empties their hand is finished, and the rest of the round still plays.
- When a round ends with nobody finished, the next round starts. With one finished, that player wins. With several, sudden death: only they play on, each draws one card, and rounds repeat until one ends with exactly one finished. A sudden-death round where nobody finishes repeats with the same players; one where several finish continues with just those. If the draw and discard piles together hold fewer cards than there are finalists, they share the win.
- The host can undo placements one at a time, including the one that ended the game.

## Phases

`lobby` → `setup` → `playing` → `over`.

- **lobby**: add, reorder and remove players. "Start game" opens the scoreboard popup and moves to setup.
- **setup**: build and review the deck, set hand size, then "Deal". Deal stays disabled, with the count shown, until the included cards that have a year number at least players × handSize + 1.
- **playing**: turns as above.
- **over**: winner and standings. "Play again" deals a new game from the same deck and players. "Edit deck" returns to setup. "Undo last" reverts the final placement and returns to playing.
- Settings "New game" (with a confirm dialog) drops the current game and returns to the lobby, keeping players, settings, deck and `placementSeq`. `gameNumber` restarts, so the next deal starts with seat 1.

## State

Game state lives in `localStorage` under `trial-and-era:v1`, written only by the host. The scoreboard re-renders on `storage` events.

```js
state = {
  settings: { handSize: 4 },
  players: [{ id, name }],
  nextId: 1,            // next player id
  phase: 'lobby',
  deck: {
    cards: [Card],
    sources: [Source],
    nextCardId: 1
  },
  gameNumber: 0,        // games dealt so far
  placementSeq: 0,      // next Placement id; never rolled back by undo, so a redone placement animates again
  game: null            // Game while playing or over
}

Source = {
  name,                 // page title, 'Typed' for cards entered by hand, or 'Imported' for imported cards with no source
  title,                // Wikipedia page title, null for typed cards
  labelMode             // 'link' or 'text': which built label the source's unedited cards show
}

Card = {
  id,
  source,               // Source name
  title,                // linked Wikipedia article, or null
  linkLabel,            // label taken from the linked article
  textLabel,            // label taken from the entry's own text, year removed
  label,                // what players see; host-editable
  labelEdited,          // true once the host edits the label, so a label mode switch leaves it alone
  year,                 // integer, negative for BC, never 0; null when unknown
  yearFrom,             // 'list', 'wikidata', 'typed', or null
  description,          // Wikipedia short description; host only, may contain the year
  context,              // the row or list item text it came from; host only
  include,              // in the deck when true
  excludedByHost,       // true once the host unchecks the card, until they check it again
  flags                 // strings: 'noyear', 'leak' (label shows the year), 'guess' (year found loosely), 'duplicate'
}

Game = {
  number,               // state.gameNumber when dealt
  cards: { [id]: { id, label, year } },  // snapshot at deal, so deck edits never touch a game
  draw: [id],           // draw pile; the top is the last element
  discard: [id],
  timeline: [id],       // oldest first
  hands: { [playerId]: [id] },
  seats: [playerId],    // who plays this round, in turn order
  turn: 0,              // index into seats
  round: 1,
  suddenDeath: false,
  finished: [playerId], // emptied their hand this round
  pending: { cardId: null, index: null },  // host's tentative choice; index is a gap, 0..timeline.length
  log: [Placement],     // oldest first
  winners: [playerId],  // set when the game ends
  out: { [playerId]: round },  // last round each player knocked out of sudden death took part in
  history: [Snapshot]   // undo stack, newest last, at most 50
}

Placement = { id, round, playerId, cardId, index, correct, year, drawn }  // drawn: card id or null

Snapshot = { ...Game without cards, log, history and draw, drawTop: [id], drawUnder }
  // drawTop: at most seats.length + 1 cards from the top of the draw pile; drawUnder: how many lie beneath them
```

A reveal draws at most one card per seat plus one and reshuffles only an emptied pile, so undo rebuilds the draw pile exactly from the current pile's bottom `drawUnder` cards and `drawTop`, and a snapshot's size does not grow with the deck.

Gap `index` i inserts before `timeline[i]`; `timeline.length` appends. Card ids in `Game` refer to `game.cards`.

Host-only UI state lives under `trial-and-era:v1:ui` so typing never wakes the scoreboard: search text, deck filter and view, and the build in progress so a refresh resumes it. Each built list is cached under `trial-and-era:list:r<RULES>:<title>`; bump `RULES` in `js/wiki.js` when extraction changes. At startup the host prunes cached lists from other rules and game and UI keys from older versions, keeping newer ones. When storage fills, cached lists go first. A failed save reads "Could not save the game, so the scoreboard will not show this change and a reload will lose it: …", and no success report replaces it. The host theme lives under `trial-and-era:theme`.

## Building cards from Wikipedia

The host searches for a page or pastes a URL, as in wikiest-link. Good sources are pages like "Timeline of historic inventions", "List of Pixar films" or "List of best-selling video games". Each table row or list item with an article link yields one candidate card, using wikiest-link's extraction: first article link per row or item, skipping infoboxes, galleries, figures, navboxes, sidebars, hatnotes, references, maintenance boxes and everything after the first end-matter heading. Only tables with a header cell supply rows, and a list inside such a table belongs to its row. A table's item column is the one headed Name or Title, singular and not naming a date as "First title" or "Last title" do; otherwise the column holding most rows' first link, where year columns count only when no other column has links.

Some links never count: red links, links back to the page and other namespaces; year, decade, century and date articles; links whose text is only a year, range or ordinal ("1930" → "1930 FIFA World Cup", "(16th)" → "16th Academy Awards") unless the article is titled with that text ("1917 (2019 film)"); links that wrap an image, such as flag icons; and links inside figures and image captions. A candidate whose article is a disambiguation page is dropped, and repeats collapse to one per article in `link` mode, preferring a dated one, or one per article and text in `text` mode. On a page where at least half the candidates are dated, tables and lists with no dated candidate are side lists and are dropped.

Each candidate's year comes from, in order:

1. Its table row: the column under the first header like Year, Date, Released, Introduced, Invented, Founded, Established, Opened, Launched, Premiered, Published, Discovered, First, Built, Completed or Inception, unless that header also names an end such as Died, Closed or Discontinued; otherwise the first column outside the item column where at least half the body rows hold only a date; otherwise the first year after a "Released:", "Premiered:", "Published:", "Opened:" or "Founded:" label in any cell, as discography tables give "Released: 4 August 1967".
2. Its list item: a leading year such as "1876 –", "1876:" or "c. 1440". On a timeline page, where at least half the items lead with a year, a bare number before a colon or dash also counts.
3. For rows and items still undated: the year an enclosing list item leads with, then the nearest preceding heading whose text is a single year. Failing those, a list item that does not open with a century, millennium or decade takes the first year in its text, flagged `guess`.
4. Wikidata, for candidates still undated: all of them in `link` mode, but in `text` mode only those whose text opens with a century, millennium or decade, and only with a year inside that period, because a text card describes an event rather than its first link. The article's item via `wbgetentities` with `sites=enwiki&titles=…`, 10 titles per request so a slow connection finishes each within the request timeout. Properties in priority order: P575 time of discovery or invention, P571 inception, P577 publication date, P1191 date of first performance, P585 point in time, P580 start time, P619 launch date, P606 first flight, P729 service entry, P1619 date of official opening, and in `link` mode only P569 date of birth. The earliest value of the first property with a non-deprecated value at year precision or finer (precision ≥ 9) counts, unless it falls outside the valid range. Negative Wikidata years are BC. Switching a source's `labelMode` later fetches nothing.

Years parse "1876", "c. 1440", "500 BC", "500 BCE", "AD 79", "79 CE", "1876–1877" and "2494~2345 BC" (first year), "c. 7,100 – 5,700 BCE" (a BC range end may use thousands commas), "March 10, 1876", "10 March 1876" and "1876-03-10". Bare numbers under 1000 need an era marker, except in a year column, as a timeline page's leading year, and in `parseYear`. Numbers that read as counts, prices, measures or references are never years, including counts ending in "-illion", units followed by ² or ³, and a number beside "^", an exponent. Decades such as "1440s" are not years. Valid years run from −10000 to the current year, never 0.

Entry text leaves out figures and image captions. A superscript number right after a digit reads as an exponent, so "10<sup>15</sup>" becomes "10^15" rather than more digits.

`linkLabel` is the article title without a trailing parenthetical, and without a leading year when that year is the card's ("1906 San Francisco earthquake" → "San Francisco earthquake"); link text such as "iPhone" restores a lowercase start. `textLabel` is the item's text without the card's year where it leads, ends or sits in parentheses, along with its separator, and without a leading month and day such as "October 20:". An item that opens with a century, millennium or decade loses that opening too, but only when the build found its year. The result is cut to its first sentence when that fits, else to about 120 characters at a word. A source's default `labelMode` is `text` when most of its items lead with a year and their text runs past six words, which is how timeline pages read, and `link` otherwise. A host edit that clears a label restores the built one.

A card is flagged `leak` when its label shows its year's number, including with a thousands comma ("9,600 BC") or as a two-digit range end ("1946–47" shows 1947), `noyear` when it has none, and `duplicate` when another included card shares its label, compared without case, accents or punctuation, or its article where both cards' sources are in `link` mode. Entry-text cards often share a first link, such as an inventor, while describing different events. Cards flagged `noyear` or `leak` start excluded; the rest start included. A host edit to a label or year, or a label mode switch, that sets either flag excludes the card, and one that clears them includes it again unless `excludedByHost` is set.

Adding a source merges its candidates into the deck, skipping any that share their year and what `duplicate` compares (label, or article between `link`-mode cards) with a card already there. Typed cards come from a label-and-year form and from a textarea that takes one card per line, year first or last ("1876 Telephone", "Telephone, 1876"); a year at the end wins when both ends read as one, and a bare number under 1000 needs an era. The deck exports as `trial-and-era-deck.json` without card ids and imports again, which merges: cards keep `include`, excluded cards keep `excludedByHost`, each source keeps its `labelMode` unless the deck already has one by that name, and a bare array of cards also imports.

Requests to en.wikipedia.org and www.wikidata.org share one budget of 180 per rolling minute and the retrying fetch from wikiest-link. Every request carries `Api-User-Agent`, which both hosts allow in their CORS preflight. A timeout while the body downloads retries like one before the headers. After the last retry the error reads "<host> request timed out", and a caller's abort rejects with the caller's reason.

## Modules

| File | Owns |
| --- | --- |
| `index.html`, `js/host.js` | Host console |
| `scoreboard.html`, `js/scoreboard.js`, `css/app.css` | Scoreboard; the host's few rules sit in a `<style>` in `index.html` |
| `js/theme.js` | Host theme button, port of wikiest-link's |
| `js/store.js` | State, persistence, list cache, cross-window sync, port of wikiest-link's |
| `js/wiki.js` | Wikipedia and Wikidata client, card building |
| `js/years.js` | Year parsing and formatting |
| `js/game.js` | Rules: dealing, placement, turns, rounds, sudden death, undo, standings. Pure functions on state, no DOM or storage |
| `js/dom.js` | `$`, `icon`, `fromTemplate`, `fmt` |
| `favicon.svg`, `_headers`, `README.md` | As in wikiest-link; the CSP's `connect-src` allows only `https://en.wikipedia.org` and `https://www.wikidata.org` |

### Module contracts

```js
// js/years.js
formatYear(year)            // 1876 → '1876', -500 → '500 BC'
parseYear(text)             // whole-string parse for host input: '1876', '-500', '500 BC', 'AD 79', 'c. 1440' → int, or null
findYear(text, opts)        // first year in free text → { year, index, length, leading } or null;
                            // opts.bare: accept bare numbers under 1000 (year columns)
mentionsYear(text, year)    // true when text shows the year's number, as a label that gives it away

// js/wiki.js
RULES                       // cache version for built lists
search(text, signal)        // opensearch titles for the datalist
titleFromUrl(text)          // page title from a pasted English Wikipedia URL; null when not a URL; throws on others
buildCards(title, onProgress, signal, cached)
  // → { title, labelMode, cards: [Card without id/source/include/excludedByHost], dropped }
  // onProgress(label, done, total); cached(canonicalTitle) returns a cached result or null

// js/store.js
load(), save(state), subscribe(onChange), defaultState(), loadUi(), saveUi(ui), prune(),
getList(title), putList(result)
room()                      // characters of serialized game state that fit after the origin's other keys, cached
                            // lists not counted, estimated against 5 MiB of UTF-16 code units

// js/game.js — every function that changes state takes it as an argument and mutates it
dealable(state)             // → { cards: [Card], needed }: included cards with a year, and how many a deal needs
deal(state, rng = Math.random)
activePlayer(game)          // → playerId or null
setPending(game, patch)     // patch: { cardId?, index? }
fits(game, cardId, index)   // → boolean
reveal(state, rng = Math.random)  // resolve game.pending → Placement; advances turn, round, sudden death, end
undo(state)                 // → boolean
upNext(game, n)             // → up to n playerIds due after the active one, without repeats; crosses into the
                            // next round only while nobody has finished this one
standings(state)            // → [{ player, cards, rank, winner }]: winners first, then by the last round each
                            // player took part in (game.out, or game.round while seated), later first, then
                            // fewest cards in hand; equal rows share a rank and keep lobby order

// js/dom.js
$(id), icon(name), fromTemplate(id), fmt (Intl.NumberFormat)
```

## Host console

Same header as wikiest-link: title with a Font Awesome `timeline` icon, "host console", theme button, "Open scoreboard".

- **Lobby**: player form, reorderable list, "Start game".
- **Setup**: page search with datalist suggestions and a build progress bar. A sources list shows each source's card and included counts, a label mode select (disabled for sources with no page title) and a remove button. Typed-card form and bulk textarea. The deck table has include checkbox, editable label, editable year (invalid input marked `aria-invalid`), where the year came from, flags, and the source, article, description and context in small text. Every card has a row, hidden unless it matches the filter box and the view select (all, included, excluded, needs a year, flagged); rows are redrawn only when the set of cards changes, and the filter applies 150 ms after typing stops. A deck cell being edited when a build lands or another window saves is committed first, and focus and the caret stay in it. Hand size setting, which keeps what the host is typing across renders, deck export and import, clear deck with a confirm dialog, and "Deal". The deal summary warns when the deck plus the dealt game would pass nine tenths of `room()`, since the scoreboard stops following a game that cannot be saved; Deal stays enabled.
- **Playing**: round and turn headings, the active player's hand as a radio group, and the timeline as a horizontally scrolling row of cards with a gap button before, between and after them. Picking a card and a gap sets `game.pending`, which the scoreboard shows at once. Hand cards can also be dragged onto a gap. Arrow keys, Home and End move between gaps, and Enter or Space picks one. Picking the chosen gap again clears it. The strip centers the pending gap, or else the card just placed. "Reveal" resolves the turn and a status line reads back the result. "Undo last", a player table with seats, cards left and status (playing, finished, out of sudden death), and draw and discard counts. The host console never shows the years of cards in hand.
- **Over**: winner, standings, "Play again", "Edit deck", "Undo last".

## Scoreboard

A 16:9 stage, always dark, never interactive, screen-shared to players.

- Top bar: game name and a one-line goal, "ROUND n", "SUDDEN DEATH" or "GAME OVER", draw pile count.
- Timeline strip across the stage: cards oldest first, label above a large year. It scrolls itself horizontally to keep the pending gap, or else the latest placement, in view. The pending gap holds a ghost card with "?" for a year, labeled once a card is picked.
- A status line under the strip: a prompt before the first placement, then the latest result with "CORRECT" or "WRONG", its year, and who played it. It stays on one line: only the card label shortens, with an ellipsis, at up to 45% of the line.
- The active player's name and hand as large cards with "?" years. The pending card is highlighted. Labels clamp at 5 lines, or 7 in a hand of seven or eight.
- A row of the other players in turn order with card counts and finished marks, plus "UP NEXT"; players out of sudden death follow in muted text with a dashed border.
- After a reveal: the placed card flashes in the timeline with "CORRECT" and its year, or the wrong card shows its true year with "WRONG" before leaving. Placements present when the scoreboard loads never animate, and reduced motion skips animation.
- Lobby and setup show a waiting screen with the count of cards ready to deal. Over shows the winner, or "X and Y share the win!", or past two winners "N players share the win!" with the crowned standings rows naming them, then the standings.
