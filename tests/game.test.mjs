// Rules of play in js/game.js: dealing, placement, turns, rounds, sudden death, undo and standings, plus whole
// seeded games checked against every rule after each reveal.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  dealable, deal, activePlayer, setPending, fits, reveal, undo, upNext, standings
} from '../js/game.js';

// Every shuffle must use the rng argument.
Math.random = function () { throw new Error('Math.random was called'); };

function seeded(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Card ids start at 100; by default card 100 + i has year 1000 + 10 i.
function makeState(playerCount, handSize, years) {
  const players = Array.from({ length: playerCount }, (_, i) => ({ id: i + 1, name: 'P' + (i + 1) }));
  const list = typeof years === 'number' ? Array.from({ length: years }, (_, i) => 1000 + 10 * i) : years;
  const cards = list.map((year, i) => ({
    id: 100 + i, source: 'Typed', title: null, linkLabel: '', textLabel: 'Card ' + (100 + i),
    label: 'Card ' + (100 + i), labelEdited: false, year, yearFrom: 'typed', description: 'd', context: 'c',
    include: true, flags: []
  }));
  return {
    settings: { handSize }, players, nextId: playerCount + 1, phase: 'setup',
    deck: { cards, sources: [], nextCardId: 100 + list.length }, gameNumber: 0, placementSeq: 0, game: null
  };
}

// Replace piles after a deal so scenarios are exact.
function rig(state, spec) {
  Object.assign(state.game, spec);
}

function allIds(game) {
  return [...game.draw, ...game.discard, ...game.timeline, ...Object.values(game.hands).flat()];
}

function correctGap(game, cardId) {
  for (let i = 0; i <= game.timeline.length; i++) if (fits(game, cardId, i)) return i;
  throw new Error('no correct gap');
}

function wrongGap(game, cardId) {
  for (let i = 0; i <= game.timeline.length; i++) if (!fits(game, cardId, i)) return i;
  return null;
}

function play(state, cardId, index, rng = seeded(1)) {
  setPending(state.game, { cardId, index });
  return reveal(state, rng);
}

function withoutHistory(game) {
  const { history, ...rest } = game;
  return structuredClone(rest);
}

function checkInvariants(state, total) {
  const g = state.game;
  const ids = allIds(g);
  assert.equal(ids.length, total, 'card count conserved');
  assert.equal(new Set(ids).size, total, 'no card in two places');
  for (let i = 1; i < g.timeline.length; i++) {
    assert.ok(g.cards[g.timeline[i - 1]].year <= g.cards[g.timeline[i]].year, 'timeline sorted');
  }
  assert.ok(g.history.length <= 50);
  assert.deepEqual(g.pending, { cardId: null, index: null });
  for (const id of Object.keys(g.hands).map(Number)) {
    assert.equal(g.seats.includes(id), !(id in g.out), 'knocked out exactly when unseated');
  }
}

describe('dealable', () => {
  test('counts included cards with a year and the cards a deal needs', () => {
    const state = makeState(3, 4, 20);
    state.deck.cards[0].include = false;
    state.deck.cards[1].year = null;
    state.deck.cards[2].include = false;
    state.deck.cards[2].year = null;
    const ready = dealable(state);
    assert.equal(ready.cards.length, 17);
    assert.equal(ready.needed, 13);
    assert.ok(ready.cards.every((c) => c.include && Number.isInteger(c.year)));
  });

  test('needed follows players and hand size', () => {
    assert.equal(dealable(makeState(1, 1, 0)).needed, 2);
    assert.equal(dealable(makeState(8, 8, 0)).needed, 65);
  });
});

describe('deal', () => {
  test('deals hands, one face-up card and the rest to draw', () => {
    const state = makeState(3, 4, 30);
    deal(state, seeded(7));
    const g = state.game;
    assert.equal(state.phase, 'playing');
    assert.equal(state.gameNumber, 1);
    assert.equal(g.number, 1);
    assert.deepEqual(g.seats, [1, 2, 3]);
    for (const id of [1, 2, 3]) assert.equal(g.hands[id].length, 4);
    assert.equal(g.timeline.length, 1);
    assert.equal(g.draw.length, 30 - 13);
    assert.deepEqual(g.discard, []);
    assert.equal(g.turn, 0);
    assert.equal(g.round, 1);
    assert.equal(g.suddenDeath, false);
    assert.deepEqual(g.finished, []);
    assert.deepEqual(g.pending, { cardId: null, index: null });
    assert.deepEqual(g.log, []);
    assert.deepEqual(g.winners, []);
    assert.deepEqual(g.out, {});
    assert.deepEqual(g.history, []);
    checkInvariants(state, 30);
  });

  test('snapshots only dealable cards as id, label, year and description', () => {
    const state = makeState(2, 2, 10);
    state.deck.cards[0].include = false;
    state.deck.cards[1].year = null;
    deal(state, seeded(1));
    const g = state.game;
    assert.equal(Object.keys(g.cards).length, 8);
    assert.equal(g.cards[100], undefined);
    assert.equal(g.cards[101], undefined);
    assert.deepEqual(g.cards[102], { id: 102, label: 'Card 102', year: 1020, description: 'd' });
    state.deck.cards[2].label = 'Edited';
    state.deck.cards[2].year = 1;
    state.deck.cards[2].description = 'Edited';
    assert.deepEqual(g.cards[102], { id: 102, label: 'Card 102', year: 1020, description: 'd' });
  });

  test('first seat rotates each game', () => {
    const state = makeState(3, 1, 10);
    const seen = [];
    for (let n = 0; n < 4; n++) {
      deal(state, seeded(n));
      seen.push(state.game.seats);
      assert.equal(state.game.number, n + 1);
    }
    assert.deepEqual(seen, [[1, 2, 3], [2, 3, 1], [3, 1, 2], [1, 2, 3]]);
  });

  test('play again replaces the game and keeps placementSeq', () => {
    const state = makeState(1, 1, 10);
    deal(state, seeded(1));
    const g = state.game;
    play(state, g.hands[1][0], correctGap(g, g.hands[1][0]));
    assert.equal(state.phase, 'over');
    assert.equal(state.placementSeq, 1);
    deal(state, seeded(2));
    assert.notEqual(state.game, g);
    assert.equal(state.phase, 'playing');
    assert.equal(state.placementSeq, 1);
    assert.deepEqual(state.game.log, []);
    assert.deepEqual(state.game.history, []);
  });

  test('is deterministic for a given rng', () => {
    const a = makeState(4, 3, 40);
    const b = makeState(4, 3, 40);
    const c = makeState(4, 3, 40);
    deal(a, seeded(42));
    deal(b, seeded(42));
    deal(c, seeded(43));
    assert.deepEqual(a.game, b.game);
    assert.notDeepEqual(a.game.draw, c.game.draw);
  });

  test('uses the rng for its shuffle', () => {
    const state = makeState(2, 2, 10);
    let calls = 0;
    const r = seeded(3);
    deal(state, () => { calls++; return r(); });
    assert.equal(calls, 9);
  });

  test('throws without enough cards and leaves state untouched', () => {
    const state = makeState(3, 4, 12);
    const before = structuredClone(state);
    assert.throws(() => deal(state, seeded(1)), /needs 13 cards.*has 12/);
    assert.deepEqual(state, before);
  });

  test('throws on bad player counts or hand sizes', () => {
    assert.throws(() => deal(makeState(0, 4, 20), seeded(1)), /1 to 8 players/);
    assert.throws(() => deal(makeState(9, 1, 20), seeded(1)), /1 to 8 players/);
    for (const size of [0, 9, 2.5, '4', null]) {
      const state = makeState(2, size, 30);
      assert.throws(() => deal(state, seeded(1)), /Hand size/);
      assert.equal(state.game, null);
      assert.equal(state.gameNumber, 0);
    }
  });

  test('accepts exactly enough cards', () => {
    const state = makeState(8, 8, 65);
    deal(state, seeded(1));
    assert.equal(state.game.draw.length, 0);
    checkInvariants(state, 65);
  });
});

describe('activePlayer and setPending', () => {
  test('activePlayer is the seat at turn, null without a game or once over', () => {
    assert.equal(activePlayer(null), null);
    const state = makeState(2, 1, 10);
    deal(state, seeded(1));
    assert.equal(activePlayer(state.game), 1);
    state.game.turn = 1;
    assert.equal(activePlayer(state.game), 2);
    state.game.winners = [2];
    assert.equal(activePlayer(state.game), null);
  });

  test('sets, merges and clears the choice', () => {
    const state = makeState(2, 2, 10);
    deal(state, seeded(1));
    const g = state.game;
    const card = g.hands[1][1];
    setPending(g, { cardId: card });
    assert.deepEqual(g.pending, { cardId: card, index: null });
    setPending(g, { index: 1 });
    assert.deepEqual(g.pending, { cardId: card, index: 1 });
    setPending(g, { index: 0 });
    assert.deepEqual(g.pending, { cardId: card, index: 0 });
    setPending(g, { cardId: null });
    assert.deepEqual(g.pending, { cardId: null, index: 0 });
    setPending(g, {});
    assert.deepEqual(g.pending, { cardId: null, index: 0 });
    setPending(g, { cardId: card, index: null });
    assert.deepEqual(g.pending, { cardId: card, index: null });
  });

  test('rejects cards outside the active hand and gaps out of range', () => {
    const state = makeState(2, 2, 10);
    deal(state, seeded(1));
    const g = state.game;
    setPending(g, { cardId: g.hands[1][0], index: 1 });
    const before = structuredClone(g.pending);
    assert.throws(() => setPending(g, { cardId: g.hands[2][0] }), /not in the hand of player 1/);
    assert.throws(() => setPending(g, { cardId: g.timeline[0] }), /not in the hand/);
    assert.throws(() => setPending(g, { cardId: 9999 }), /not in the hand/);
    assert.throws(() => setPending(g, { cardId: String(g.hands[1][0]) }), /not in the hand/);
    assert.throws(() => setPending(g, { index: -1 }), /outside 0 to 1/);
    assert.throws(() => setPending(g, { index: 2 }), /outside 0 to 1/);
    assert.throws(() => setPending(g, { index: 0.5 }), /outside/);
    assert.throws(() => setPending(g, { index: '1' }), /outside/);
    assert.deepEqual(g.pending, before);
  });

  test('throws once the game is over', () => {
    const state = makeState(1, 1, 5);
    deal(state, seeded(1));
    const g = state.game;
    play(state, g.hands[1][0], correctGap(g, g.hands[1][0]));
    assert.throws(() => setPending(g, { index: 0 }), /No turn/);
  });
});

describe('fits', () => {
  test('checks both neighbors, with the ends open', () => {
    const state = makeState(1, 1, 10);
    deal(state, seeded(1));
    rig(state, { timeline: [102, 105, 108], hands: { 1: [100, 103, 109, 101, 104, 106, 107] }, draw: [], discard: [] });
    const g = state.game;
    assert.deepEqual([0, 1, 2, 3].map((i) => fits(g, 100, i)), [true, false, false, false]);
    assert.deepEqual([0, 1, 2, 3].map((i) => fits(g, 103, i)), [false, true, false, false]);
    assert.deepEqual([0, 1, 2, 3].map((i) => fits(g, 107, i)), [false, false, true, false]);
    assert.deepEqual([0, 1, 2, 3].map((i) => fits(g, 109, i)), [false, false, false, true]);
  });

  test('equal years fit on either side', () => {
    const state = makeState(1, 1, [1900, 1900, 1900, 1899, 1901, 1900]);
    deal(state, seeded(1));
    rig(state, { timeline: [100, 101], hands: { 1: [102, 103, 104, 105] }, draw: [], discard: [] });
    const g = state.game;
    assert.deepEqual([0, 1, 2].map((i) => fits(g, 102, i)), [true, true, true]);
    assert.deepEqual([0, 1, 2].map((i) => fits(g, 103, i)), [true, false, false]);
    assert.deepEqual([0, 1, 2].map((i) => fits(g, 104, i)), [false, false, true]);
    rig(state, { timeline: [103, 102, 104] });
    assert.deepEqual([0, 1, 2, 3].map((i) => fits(g, 105, i)), [false, true, true, false]);
  });

  test('handles BC years', () => {
    const state = makeState(1, 1, [-500, -44, 79, 1]);
    deal(state, seeded(1));
    rig(state, { timeline: [101], hands: { 1: [100, 102, 103] }, draw: [], discard: [] });
    const g = state.game;
    assert.equal(fits(g, 100, 0), true);
    assert.equal(fits(g, 100, 1), false);
    assert.equal(fits(g, 103, 1), true);
  });

  test('throws on unknown cards and bad gaps', () => {
    const state = makeState(1, 1, 5);
    deal(state, seeded(1));
    assert.throws(() => fits(state.game, 999, 0), /not in this game/);
    assert.throws(() => fits(state.game, state.game.hands[1][0], 5), /outside/);
  });
});

describe('reveal', () => {
  function threeOfOne() {
    const state = makeState(3, 1, 10);
    deal(state, seeded(1));
    rig(state, {
      hands: { 1: [101], 2: [102], 3: [103] }, timeline: [105], draw: [100, 104, 106, 107, 108, 109], discard: []
    });
    return state;
  }

  test('a correct card joins the timeline and the turn passes', () => {
    const state = makeState(2, 2, 10);
    deal(state, seeded(1));
    rig(state, { hands: { 1: [101, 102], 2: [103, 104] }, timeline: [105], draw: [100, 106, 107, 108, 109] });
    state.placementSeq = 7;
    const p = play(state, 102, 0);
    const g = state.game;
    assert.deepEqual(p, { id: 7, round: 1, playerId: 1, cardId: 102, index: 0, correct: true, year: 1020, drawn: null });
    assert.deepEqual(g.log, [p]);
    assert.equal(state.placementSeq, 8);
    assert.deepEqual(g.timeline, [102, 105]);
    assert.deepEqual(g.hands[1], [101]);
    assert.deepEqual(g.pending, { cardId: null, index: null });
    assert.equal(g.turn, 1);
    assert.equal(activePlayer(g), 2);
    assert.deepEqual(g.draw, [100, 106, 107, 108, 109]);
  });

  test('a wrong card is discarded and replaced from the draw pile', () => {
    const state = makeState(2, 2, 10);
    deal(state, seeded(1));
    rig(state, { hands: { 1: [101, 102], 2: [103, 104] }, timeline: [105], draw: [100, 106, 107, 108, 109] });
    const p = play(state, 101, 1);
    const g = state.game;
    assert.deepEqual(p, { id: 0, round: 1, playerId: 1, cardId: 101, index: 1, correct: false, year: 1010, drawn: 109 });
    assert.deepEqual(g.timeline, [105]);
    assert.deepEqual(g.discard, [101]);
    assert.deepEqual(g.hands[1], [102, 109]);
    assert.deepEqual(g.draw, [100, 106, 107, 108]);
    assert.equal(activePlayer(g), 2);
  });

  test('an empty draw pile is refilled from the discard pile minus the wrong card', () => {
    const state = makeState(2, 2, 10);
    deal(state, seeded(1));
    rig(state, { hands: { 1: [101, 102], 2: [103, 104] }, timeline: [105], draw: [], discard: [100, 106, 107, 108, 109] });
    const p = play(state, 101, 1, seeded(5));
    const g = state.game;
    assert.deepEqual(g.discard, [101]);
    assert.equal(g.draw.length, 4);
    assert.ok([100, 106, 107, 108, 109].includes(p.drawn));
    assert.deepEqual(g.hands[1], [102, p.drawn]);
    assert.deepEqual([...g.draw, p.drawn].sort(), [100, 106, 107, 108, 109]);
    checkInvariants(state, 10);

    const again = makeState(2, 2, 10);
    deal(again, seeded(1));
    rig(again, { hands: { 1: [101, 102], 2: [103, 104] }, timeline: [105], draw: [], discard: [100, 106, 107, 108, 109] });
    play(again, 101, 1, seeded(5));
    assert.deepEqual(again.game, g);
  });

  test('the wrong card goes back to the hand when both piles are empty', () => {
    const state = makeState(2, 2, 5);
    deal(state, seeded(1));
    rig(state, { hands: { 1: [101, 102], 2: [103, 104] }, timeline: [100], draw: [], discard: [] });
    const p = play(state, 101, 0);
    const g = state.game;
    assert.equal(p.correct, false);
    assert.equal(p.drawn, null);
    assert.equal(p.year, 1010);
    assert.deepEqual(g.hands[1], [101, 102]);
    assert.deepEqual(g.discard, []);
    assert.deepEqual(g.draw, []);
    assert.equal(activePlayer(g), 2);
    const q = play(state, 104, 0);
    assert.equal(q.correct, false);
    assert.deepEqual(g.hands[2], [103, 104]);
  });

  test('consecutive reshuffles leave only the newest wrong card in the discard pile', () => {
    const state = makeState(2, 2, 6);
    deal(state, seeded(1));
    rig(state, { hands: { 1: [101, 102], 2: [103, 104] }, timeline: [100], draw: [], discard: [105] });
    const p = play(state, 102, 0);
    assert.equal(p.drawn, 105);
    assert.deepEqual(state.game.discard, [102]);
    const q = play(state, 103, 0);
    assert.equal(q.drawn, 102);
    assert.deepEqual(state.game.hands[2], [104, 102]);
    assert.deepEqual(state.game.discard, [103]);
    assert.deepEqual(state.game.draw, []);
  });

  test('throws, changing nothing, without a complete valid choice', () => {
    const state = makeState(2, 2, 10);
    assert.throws(() => reveal(state, seeded(1)), /No game/);
    deal(state, seeded(1));
    const g = state.game;
    const snapshot = structuredClone(state);
    assert.throws(() => reveal(state, seeded(1)), /Pick a card and a gap/);
    setPending(g, { cardId: g.hands[1][0] });
    assert.throws(() => reveal(state, seeded(1)), /Pick a card and a gap/);
    setPending(g, { cardId: null, index: 0 });
    assert.throws(() => reveal(state, seeded(1)), /Pick a card and a gap/);
    g.pending = { cardId: g.hands[2][0], index: 0 };
    assert.throws(() => reveal(state, seeded(1)), /not in the hand of player 1/);
    g.pending = { cardId: g.hands[1][0], index: 3 };
    assert.throws(() => reveal(state, seeded(1)), /outside 0 to 1/);
    g.pending = { cardId: null, index: null };
    assert.deepEqual(state, snapshot);
    state.phase = 'setup';
    g.pending = { cardId: g.hands[1][0], index: 0 };
    assert.throws(() => reveal(state, seeded(1)), /No game/);
  });

  test('throws once the game is over', () => {
    const state = threeOfOne();
    play(state, 101, 0);
    play(state, 102, 2);
    play(state, 103, 2);
    assert.equal(state.phase, 'over');
    state.game.pending = { cardId: 109, index: 0 };
    assert.throws(() => reveal(state, seeded(1)), /No game/);
  });

  test('a finished player waits while the round plays out, then wins alone', () => {
    const state = threeOfOne();
    const g = state.game;
    play(state, 101, 0);
    assert.deepEqual(g.finished, [1]);
    assert.deepEqual(g.hands[1], []);
    assert.equal(state.phase, 'playing');
    assert.equal(activePlayer(g), 2);
    assert.deepEqual(upNext(g, 5), [3]);
    const p2 = play(state, 102, 2);
    assert.equal(p2.correct, false);
    assert.equal(p2.drawn, 109);
    play(state, 103, 2);
    assert.equal(state.phase, 'over');
    assert.deepEqual(g.winners, [1]);
    assert.equal(activePlayer(g), null);
    assert.deepEqual(upNext(g, 3), []);
    assert.equal(g.round, 1);
    const rows = standings(state);
    assert.deepEqual(rows.map((r) => [r.player.id, r.cards, r.rank, r.winner]), [[1, 0, 1, true], [2, 1, 2, false], [3, 1, 2, false]]);
  });

  test('a round with nobody finished starts the next with the same seats', () => {
    const state = makeState(2, 2, 10);
    deal(state, seeded(1));
    deal(state, seeded(1));
    rig(state, { hands: { 1: [101, 102], 2: [103, 104] }, timeline: [105], draw: [100, 106, 107, 108, 109] });
    const g = state.game;
    assert.deepEqual(g.seats, [2, 1]);
    const p = play(state, 103, 1);
    assert.equal(p.playerId, 2);
    play(state, 101, 1);
    assert.equal(g.round, 2);
    assert.equal(g.turn, 0);
    assert.deepEqual(g.seats, [2, 1]);
    assert.equal(g.suddenDeath, false);
    assert.equal(activePlayer(g), 2);
    const q = play(state, 104, 0);
    assert.equal(q.round, 2);
  });

  test('one player wins on their first correct card when the hand size is 1', () => {
    const state = makeState(1, 1, 3);
    deal(state, seeded(1));
    rig(state, { hands: { 1: [100] }, timeline: [101], draw: [102] });
    play(state, 100, 1);
    assert.equal(state.phase, 'playing');
    assert.equal(state.game.round, 2);
    assert.deepEqual(state.game.hands[1], [102]);
    assert.deepEqual(upNext(state.game, 3), []);
    play(state, 102, 1);
    assert.equal(state.phase, 'over');
    assert.deepEqual(state.game.winners, [1]);
  });
});

describe('sudden death', () => {
  test('finalists draw one card each, repeat when nobody finishes, and continue to a winner', () => {
    const state = makeState(3, 1, 10);
    deal(state, seeded(1));
    rig(state, { hands: { 1: [101], 2: [102], 3: [103] }, timeline: [105], draw: [100, 104, 106, 107, 108, 109] });
    const g = state.game;
    play(state, 101, 0);
    play(state, 102, 1);
    const p3 = play(state, 103, 0);
    assert.equal(p3.correct, false);
    assert.equal(p3.drawn, 109);
    assert.equal(state.phase, 'playing');
    assert.equal(g.suddenDeath, true);
    assert.deepEqual(g.seats, [1, 2]);
    assert.deepEqual(g.out, { 3: 1 });
    assert.equal(g.round, 2);
    assert.equal(g.turn, 0);
    assert.deepEqual(g.finished, []);
    assert.deepEqual(g.hands, { 1: [108], 2: [107], 3: [109] });
    assert.deepEqual(upNext(g, 3), [2]);

    // Nobody finishes: same finalists, no new cards.
    play(state, 108, 0);
    play(state, 107, 0);
    assert.equal(g.round, 3);
    assert.deepEqual(g.seats, [1, 2]);
    assert.equal(g.suddenDeath, true);
    assert.deepEqual(g.hands, { 1: [106], 2: [104], 3: [109] });
    assert.deepEqual(g.draw, [100]);
    assert.deepEqual(g.discard, [103, 108, 107]);

    // Both finish: both draw again, the second from the reshuffled discard pile.
    play(state, 106, 3);
    play(state, 104, 2);
    assert.equal(state.phase, 'playing');
    assert.equal(g.round, 4);
    assert.deepEqual(g.seats, [1, 2]);
    assert.deepEqual(g.hands[1], [100]);
    assert.equal(g.hands[2].length, 1);
    assert.ok([103, 107, 108].includes(g.hands[2][0]));
    assert.deepEqual(g.discard, []);
    assert.equal(g.draw.length, 2);
    checkInvariants(state, 10);

    play(state, 100, 0);
    play(state, g.hands[2][0], wrongGap(g, g.hands[2][0]));
    assert.equal(state.phase, 'over');
    assert.deepEqual(g.winners, [1]);
    assert.deepEqual(g.out, { 3: 1 });
    // Player 2 lost the final round, so ranks ahead of player 3, out since round 1, with as many cards.
    const rows = standings(state);
    assert.deepEqual(rows.map((r) => [r.player.id, r.cards, r.rank, r.winner]), [[1, 0, 1, true], [2, 1, 2, false], [3, 1, 3, false]]);
  });

  test('several finishing in sudden death continue with just those', () => {
    const state = makeState(4, 1, 12);
    deal(state, seeded(1));
    rig(state, {
      hands: { 1: [101], 2: [102], 3: [103], 4: [104] }, timeline: [100],
      draw: [105, 106, 107, 108, 109, 110, 111], discard: []
    });
    const g = state.game;
    play(state, 101, 1);
    play(state, 102, 2);
    play(state, 103, 3);
    play(state, 104, 0);
    assert.deepEqual(g.seats, [1, 2, 3]);
    assert.deepEqual(g.hands, { 1: [110], 2: [109], 3: [108], 4: [111] });
    play(state, 110, g.timeline.length);
    play(state, 109, 0);
    play(state, 108, g.timeline.length - 1);
    assert.deepEqual(g.seats, [1, 3]);
    assert.deepEqual(g.out, { 2: 2, 4: 1 });
    assert.equal(g.round, 3);
    assert.equal(g.suddenDeath, true);
    assert.equal(g.hands[1].length, 1);
    assert.equal(g.hands[3].length, 1);
    assert.equal(g.hands[2].length, 1);
    assert.equal(activePlayer(g), 1);
    assert.deepEqual(upNext(g, 3), [3]);
    checkInvariants(state, 12);
  });

  test('sudden death seats follow the rotated seat order', () => {
    const state = makeState(3, 1, 10);
    deal(state, seeded(1));
    deal(state, seeded(1));
    rig(state, { hands: { 1: [101], 2: [102], 3: [103] }, timeline: [105], draw: [100, 104, 106, 107, 108, 109] });
    const g = state.game;
    assert.deepEqual(g.seats, [2, 3, 1]);
    play(state, 102, 0);
    play(state, 103, 1);
    play(state, 101, 0);
    assert.deepEqual(g.seats, [2, 3, 1]);
    assert.equal(g.suddenDeath, true);
    assert.deepEqual(g.hands, { 1: [107], 2: [109], 3: [108] });
  });

  test('finalists share the win when both piles are empty', () => {
    const state = makeState(2, 1, 3);
    deal(state, seeded(1));
    rig(state, { hands: { 1: [100], 2: [102] }, timeline: [101], draw: [], discard: [] });
    play(state, 100, 0);
    play(state, 102, 2);
    assert.equal(state.phase, 'over');
    assert.deepEqual(state.game.winners, [1, 2]);
    assert.equal(state.game.suddenDeath, false);
    const rows = standings(state);
    assert.deepEqual(rows.map((r) => [r.player.id, r.cards, r.rank, r.winner]), [[1, 0, 1, true], [2, 0, 1, true]]);
  });

  test('finalists share the win when there are fewer cards than finalists', () => {
    const state = makeState(4, 1, 7);
    deal(state, seeded(1));
    rig(state, { hands: { 1: [100], 2: [103], 3: [104], 4: [105] }, timeline: [101], draw: [106], discard: [102] });
    play(state, 100, 0);
    play(state, 103, 2);
    play(state, 104, 3);
    play(state, 105, 0);
    assert.equal(state.phase, 'over');
    assert.deepEqual(state.game.winners, [1, 2, 3]);
    const rows = standings(state);
    assert.deepEqual(rows.map((r) => [r.player.id, r.rank, r.winner]), [[1, 1, true], [2, 1, true], [3, 1, true], [4, 4, false]]);
  });

  test('finalists still draw when draw and discard together suffice', () => {
    const state = makeState(3, 1, 6);
    deal(state, seeded(1));
    rig(state, { hands: { 1: [100], 2: [103], 3: [104] }, timeline: [101], draw: [105], discard: [102] });
    play(state, 100, 0);
    play(state, 103, 2);
    play(state, 104, 0, seeded(9));
    const g = state.game;
    assert.equal(state.phase, 'playing');
    assert.deepEqual(g.seats, [1, 2]);
    assert.deepEqual(g.hands[3], [105]);
    assert.deepEqual([...g.hands[1], ...g.hands[2]].sort(), [102, 104]);
    assert.deepEqual(g.draw, []);
    assert.deepEqual(g.discard, []);
    checkInvariants(state, 6);
  });
});

describe('undo', () => {
  test('restores the game before the latest placement and keeps placementSeq', () => {
    const state = makeState(2, 2, 10);
    deal(state, seeded(1));
    rig(state, { hands: { 1: [101, 102], 2: [103, 104] }, timeline: [105], draw: [100, 106, 107, 108, 109] });
    const g = state.game;
    setPending(g, { cardId: 101, index: 1 });
    const before = withoutHistory(g);
    reveal(state, seeded(1));
    assert.equal(g.history.length, 1);
    assert.deepEqual(Object.keys(g.history[0]).sort(), [
      'discard', 'drawTop', 'drawUnder', 'finished', 'hands', 'number', 'out', 'pending', 'round', 'seats', 'suddenDeath',
      'timeline', 'turn', 'winners'
    ]);
    assert.deepEqual(g.history[0].drawTop, [107, 108, 109]);
    assert.equal(g.history[0].drawUnder, 2);
    assert.equal(undo(state), true);
    assert.deepEqual(withoutHistory(g), before);
    assert.deepEqual(g.pending, { cardId: 101, index: 1 });
    assert.deepEqual(g.history, []);
    assert.equal(state.placementSeq, 1);
    assert.equal(undo(state), false);
    setPending(g, { index: 0 });
    const p = reveal(state, seeded(1));
    assert.equal(p.id, 1);
    assert.equal(p.correct, true);
    assert.deepEqual(g.log.map((x) => x.id), [1]);
  });

  test('does nothing without a game or outside play', () => {
    const state = makeState(2, 2, 10);
    assert.equal(undo(state), false);
    deal(state, seeded(1));
    const g = state.game;
    play(state, g.hands[1][0], 0);
    state.phase = 'setup';
    assert.equal(undo(state), false);
    assert.equal(g.history.length, 1);
    state.phase = 'lobby';
    assert.equal(undo(state), false);
  });

  test('crosses round boundaries', () => {
    const state = makeState(2, 2, 10);
    deal(state, seeded(1));
    rig(state, { hands: { 1: [101, 102], 2: [103, 104] }, timeline: [105], draw: [100, 106, 107, 108, 109] });
    const g = state.game;
    play(state, 101, 1);
    setPending(g, { cardId: 104, index: 0 });
    const before = withoutHistory(g);
    reveal(state, seeded(1));
    assert.equal(g.round, 2);
    assert.equal(activePlayer(g), 1);
    undo(state);
    assert.deepEqual(withoutHistory(g), before);
    assert.equal(g.round, 1);
    assert.equal(g.turn, 1);
    assert.equal(activePlayer(g), 2);
    undo(state);
    assert.equal(activePlayer(g), 1);
    assert.deepEqual(g.hands, { 1: [101, 102], 2: [103, 104] });
    assert.deepEqual(g.draw, [100, 106, 107, 108, 109]);
    assert.deepEqual(g.discard, []);
    assert.deepEqual(g.log, []);
  });

  test('from over returns to playing, and out of sudden death restores seats and piles', () => {
    const state = makeState(3, 1, 10);
    deal(state, seeded(1));
    rig(state, { hands: { 1: [101], 2: [102], 3: [103] }, timeline: [105], draw: [100, 104, 106, 107, 108, 109] });
    const g = state.game;
    play(state, 101, 0);
    play(state, 102, 2);
    setPending(g, { cardId: 103, index: 2 });
    const beforeEnd = withoutHistory(g);
    play(state, 103, 2);
    assert.equal(state.phase, 'over');
    assert.equal(state.placementSeq, 3);
    assert.equal(undo(state), true);
    assert.equal(state.phase, 'playing');
    assert.deepEqual(withoutHistory(g), beforeEnd);
    assert.deepEqual(g.winners, []);
    assert.equal(activePlayer(g), 3);
    assert.deepEqual(g.pending, { cardId: 103, index: 2 });
    assert.equal(state.placementSeq, 3);

    // Placed correctly this time: two finish and sudden death starts.
    setPending(g, { index: 1 });
    const beforeSudden = withoutHistory(g);
    const p = reveal(state, seeded(1));
    assert.equal(p.id, 3);
    assert.equal(g.suddenDeath, true);
    assert.deepEqual(g.seats, [1, 3]);
    assert.deepEqual(g.out, { 2: 1 });
    assert.equal(undo(state), true);
    assert.deepEqual(withoutHistory(g), beforeSudden);
    assert.equal(g.suddenDeath, false);
    assert.deepEqual(g.seats, [1, 2, 3]);
    assert.deepEqual(g.out, {});
    assert.deepEqual(g.hands, { 1: [], 2: [109], 3: [103] });
    assert.deepEqual(g.log.map((x) => x.id), [0, 1]);
  });

  test('keeps at most 50 snapshots, newest last', () => {
    const state = makeState(1, 2, 10);
    deal(state, seeded(1));
    const g = state.game;
    const after = [];
    const placed = [];
    for (let i = 0; i < 60; i++) {
      const card = g.hands[1][0];
      placed.push(play(state, card, wrongGap(g, card), seeded(i)));
      after.push(withoutHistory(g));
    }
    assert.equal(g.history.length, 50);
    assert.equal(g.log.length, 60);
    const strip = { log: undefined, cards: undefined, pending: undefined, draw: undefined, drawTop: undefined, drawUnder: undefined };
    assert.deepEqual({ ...after[58], ...strip }, { ...g.history[49], ...strip });
    assert.deepEqual(after[58].draw.slice(g.history[49].drawUnder), g.history[49].drawTop);
    assert.equal(g.history[49].pending.cardId, g.log[59].cardId);
    for (let i = 0; i < 50; i++) assert.equal(undo(state), true);
    assert.equal(undo(state), false);
    assert.deepEqual({ ...withoutHistory(g), pending: after[9].pending }, after[9]);
    assert.deepEqual(g.pending, { cardId: placed[10].cardId, index: placed[10].index });
    assert.equal(g.log.length, 10);
    assert.equal(state.placementSeq, 60);
  });

  test('snapshots keep only the top of the draw pile, so their size does not follow the deck', () => {
    const state = makeState(3, 4, 3000);
    deal(state, seeded(5));
    const g = state.game;
    const before = [];
    for (let i = 0; i < 20; i++) {
      const card = g.hands[activePlayer(g)][0];
      setPending(g, { cardId: card, index: wrongGap(g, card) });
      before.push(withoutHistory(g));
      reveal(state, seeded(i));
    }
    g.history.forEach((snapshot) => assert.equal(snapshot.drawTop.length, g.seats.length + 1));
    assert.ok(JSON.stringify(g.history).length < 20 * 1000, 'history is ' + JSON.stringify(g.history).length + ' chars');
    for (let i = 19; i >= 0; i--) {
      assert.equal(undo(state), true);
      assert.deepEqual(withoutHistory(g), before[i]);
    }
  });

  test('survives a JSON round trip', () => {
    let state = makeState(3, 2, 20);
    deal(state, seeded(4));
    for (let i = 0; i < 4; i++) {
      const g = state.game;
      const card = g.hands[activePlayer(g)][0];
      play(state, card, correctGap(g, card));
      state = JSON.parse(JSON.stringify(state));
    }
    const before = state.game.log.length;
    assert.equal(undo(state), true);
    assert.equal(state.game.log.length, before - 1);
    const g = state.game;
    const card = g.hands[activePlayer(g)][0];
    play(state, card, correctGap(g, card));
    checkInvariants(state, 20);
  });
});

describe('upNext', () => {
  test('lists later seats, crossing into the next round while nobody has finished', () => {
    const state = makeState(4, 2, 20);
    deal(state, seeded(1));
    const g = state.game;
    assert.deepEqual(upNext(g, 2), [2, 3]);
    assert.deepEqual(upNext(g, 10), [2, 3, 4]);
    assert.deepEqual(upNext(g, 0), []);
    g.turn = 2;
    assert.deepEqual(upNext(g, 3), [4, 1, 2]);
    assert.deepEqual(upNext(g, 1), [4]);
    g.finished = [1];
    assert.deepEqual(upNext(g, 3), [4]);
    g.turn = 3;
    assert.deepEqual(upNext(g, 3), []);
  });

  test('is empty for one player, without a game, and once over', () => {
    const solo = makeState(1, 2, 10);
    deal(solo, seeded(1));
    assert.deepEqual(upNext(solo.game, 3), []);
    assert.deepEqual(upNext(null, 3), []);
    const two = makeState(2, 1, 10);
    deal(two, seeded(1));
    assert.deepEqual(upNext(two.game, 3), [2]);
    two.game.winners = [1];
    assert.deepEqual(upNext(two.game, 3), []);
  });
});

describe('standings', () => {
  test('ranks by cards in hand, ties sharing a rank in lobby seat order', () => {
    const state = makeState(5, 3, 30);
    deal(state, seeded(1));
    deal(state, seeded(1));
    const g = state.game;
    assert.deepEqual(g.seats, [2, 3, 4, 5, 1]);
    g.hands[1] = [100, 101, 102];
    g.hands[2] = [103];
    g.hands[3] = [104, 105, 106];
    g.hands[4] = [107];
    g.hands[5] = [];
    const rows = standings(state);
    assert.deepEqual(rows.map((r) => [r.player.name, r.cards, r.rank, r.winner]), [
      ['P5', 0, 1, false], ['P2', 1, 2, false], ['P4', 1, 2, false], ['P1', 3, 4, false], ['P3', 3, 4, false]
    ]);
    assert.equal(rows[0].player, state.players[4]);
  });

  test('puts winners first and is empty without a game', () => {
    const state = makeState(3, 1, 10);
    assert.deepEqual(standings(state), []);
    deal(state, seeded(1));
    state.game.winners = [3];
    state.game.hands[3] = [];
    state.game.hands[1] = [];
    const rows = standings(state);
    assert.deepEqual(rows.map((r) => [r.player.id, r.rank, r.winner]), [[3, 1, true], [1, 2, false], [2, 3, false]]);
  });

  test('ranks players knocked out later ahead of those knocked out earlier, then by cards', () => {
    const state = makeState(6, 3, 40);
    deal(state, seeded(1));
    const g = state.game;
    Object.assign(g, {
      round: 5, suddenDeath: true, seats: [2, 5], winners: [5], out: { 1: 2, 3: 4, 4: 2, 6: 4 },
      hands: { 1: [100], 2: [101, 102, 103], 3: [104, 105], 4: [106, 107], 5: [], 6: [108, 109] }
    });
    const rows = standings(state);
    assert.deepEqual(rows.map((r) => [r.player.id, r.cards, r.rank, r.winner]), [
      [5, 0, 1, true], [2, 3, 2, false], [3, 2, 3, false], [6, 2, 3, false], [1, 1, 5, false], [4, 2, 6, false]
    ]);
  });
});

// Drive a whole game with a seeded player who picks the right gap with probability pCorrect,
// checking every rule after each reveal and sometimes undoing.
function playOut(state, seed, pCorrect, opts = {}) {
  const r = seeded(seed);
  const total = Object.keys(state.game.cards).length;
  let steps = 0;
  let undos = 0;
  const stats = { suddenDeath: false, shared: false, reshuffles: 0, returns: 0, rounds: 0, undoneReshuffles: 0, undoneKnockouts: 0 };
  const pUndo = opts.pUndo ?? 0.1;
  const maxUndos = opts.maxUndos ?? 30;
  while (state.phase === 'playing') {
    assert.ok(++steps < 20000, 'game ends');
    const g = state.game;
    const pid = activePlayer(g);
    assert.ok(g.seats.includes(pid));
    const hand = g.hands[pid];
    assert.ok(hand.length > 0, 'active player holds cards');
    const size = hand.length;
    const cardId = hand[Math.floor(r() * size)];
    const right = r() < pCorrect;
    const index = right ? correctGap(g, cardId) : (wrongGap(g, cardId) ?? correctGap(g, cardId));
    setPending(g, { cardId, index });
    const before = withoutHistory(g);
    const lastTurn = g.turn === g.seats.length - 1;
    const seq = state.placementSeq;
    const expected = fits(g, cardId, index);
    const drawEmpty = g.draw.length === 0;

    const p = reveal(state, r);
    const after = state.game;
    assert.equal(p.id, seq);
    assert.equal(state.placementSeq, seq + 1);
    assert.equal(p.correct, expected);
    assert.equal(p.playerId, pid);
    assert.equal(p.round, before.round);
    assert.equal(p.year, g.cards[cardId].year);
    assert.deepEqual(after.log.at(-1), p);
    if (!p.correct) {
      assert.equal(after.hands[pid].length, size, 'a wrong guess never changes hand size');
      assert.ok(!after.timeline.includes(cardId));
      if (p.drawn === null) {
        stats.returns++;
        assert.ok(after.hands[pid].includes(cardId));
      } else {
        // Finalists entering sudden death reshuffle the whole discard pile, this card included.
        const finalistsDrew = lastTurn && before.finished.length > 1 && after.suddenDeath && after.round === before.round + 1;
        if (!after.discard.includes(cardId)) {
          assert.ok(finalistsDrew, 'wrong card stays in the discard pile');
          assert.ok(after.draw.includes(cardId) || after.seats.some((id) => after.hands[id].includes(cardId)));
        }
        assert.ok(after.hands[pid].includes(p.drawn));
        if (drawEmpty) {
          stats.reshuffles++;
          if (!finalistsDrew) assert.deepEqual(after.discard, [cardId]);
        }
      }
    } else {
      assert.equal(after.timeline[index], cardId);
      assert.equal(p.drawn, null);
    }
    const finishers = before.finished.concat(p.correct && size === 1 ? [pid] : []);
    if (!lastTurn) {
      assert.equal(after.turn, before.turn + 1);
      assert.deepEqual(after.finished, finishers);
    } else if (finishers.length === 0) {
      stats.rounds++;
      assert.equal(after.round, before.round + 1);
      assert.equal(after.turn, 0);
      assert.deepEqual(after.seats, before.seats);
      assert.equal(after.suddenDeath, before.suddenDeath);
    } else if (finishers.length === 1) {
      assert.equal(state.phase, 'over');
      assert.deepEqual(after.winners, finishers);
    } else if (state.phase === 'over') {
      stats.shared = true;
      assert.deepEqual(after.winners, before.seats.filter((id) => finishers.includes(id)));
      assert.ok(after.draw.length + after.discard.length < finishers.length);
    } else {
      stats.suddenDeath = true;
      assert.equal(after.suddenDeath, true);
      assert.deepEqual(after.seats, before.seats.filter((id) => finishers.includes(id)));
      after.seats.forEach((id) => assert.equal(after.hands[id].length, 1, 'finalists draw one card each'));
      assert.equal(after.round, before.round + 1);
      assert.equal(after.turn, 0);
      assert.deepEqual(after.finished, []);
    }
    if (state.phase === 'playing') checkInvariants(state, total);
    else {
      const ids = allIds(after);
      assert.equal(ids.length, total);
      assert.equal(new Set(ids).size, total);
    }

    if (undos < maxUndos && r() < pUndo) {
      undos++;
      // A reshuffle moves discard cards into the draw pile; a knockout shrinks the seats.
      if (before.discard.some((id) => !after.discard.includes(id))) stats.undoneReshuffles++;
      if (after.seats.length < before.seats.length) stats.undoneKnockouts++;
      assert.equal(undo(state), true);
      assert.equal(state.phase, 'playing');
      assert.deepEqual(withoutHistory(state.game), before);
      assert.equal(state.placementSeq, seq + 1);
    }
    if (opts.json) state = JSON.parse(JSON.stringify(state));
  }
  const g = state.game;
  assert.ok(g.winners.length >= 1);
  g.winners.forEach((id) => assert.equal(g.hands[id].length, 0, 'winners hold no cards'));
  Object.keys(g.hands).map(Number).filter((id) => !g.winners.includes(id))
    .forEach((id) => assert.ok(g.hands[id].length > 0, 'losers hold cards'));
  // Every seat plays once a round, so the log gives the last round each player took part in.
  const lastRound = (id) => Math.max(...g.log.filter((p) => p.playerId === id).map((p) => p.round));
  for (const id of Object.keys(g.hands).map(Number)) {
    assert.equal(g.out[id] ?? g.round, lastRound(id), 'out records the last round played');
  }
  const rows = standings(state);
  assert.equal(rows.length, state.players.length);
  rows.forEach((row, i) => {
    assert.equal(row.winner, i < g.winners.length);
    if (row.winner) assert.equal(row.rank, 1);
    const prev = rows[i - 1];
    if (!prev || prev.winner) return;
    const a = lastRound(prev.player.id);
    const b = lastRound(row.player.id);
    assert.ok(a > b || (a === b && prev.cards <= row.cards), 'later knockouts first, then fewest cards');
    assert.equal(row.rank === prev.rank, a === b && prev.cards === row.cards, 'equal rows share a rank');
  });
  assert.equal(activePlayer(g), null);
  assert.deepEqual(upNext(g, 3), []);
  if (g.winners.length > 1) stats.shared = true;
  return { state, stats };
}

describe('whole games', () => {
  test('every player count and hand size plays to a finish', () => {
    const seen = { suddenDeath: 0, shared: 0, reshuffles: 0, returns: 0, rounds: 0, games: 0 };
    for (let players = 1; players <= 8; players++) {
      for (let handSize = 1; handSize <= 8; handSize++) {
        for (const extra of [0, 3, 25]) {
          for (const pCorrect of [0.35, 0.8]) {
            for (const tieYears of [false, true]) {
              const seed = players * 1000 + handSize * 100 + extra * 3 + (pCorrect > 0.5 ? 1 : 0) + (tieYears ? 7 : 0);
              const count = players * handSize + 1 + extra;
              const years = Array.from({ length: count }, (_, i) => tieYears ? 1900 + (i % 6) : 1000 + 10 * i);
              let state = makeState(players, handSize, years);
              deal(state, seeded(seed));
              const result = playOut(state, seed, pCorrect, { json: seed % 3 === 0 });
              seen.games++;
              for (const key of ['suddenDeath', 'shared']) if (result.stats[key]) seen[key]++;
              for (const key of ['reshuffles', 'returns', 'rounds']) seen[key] += result.stats[key];
            }
          }
        }
      }
    }
    assert.equal(seen.games, 768);
    assert.ok(seen.suddenDeath > 20, 'sudden death reached: ' + seen.suddenDeath);
    assert.ok(seen.shared > 5, 'shared wins reached: ' + seen.shared);
    assert.ok(seen.reshuffles > 20, 'reshuffles reached: ' + seen.reshuffles);
    assert.ok(seen.returns > 20, 'returns to hand reached: ' + seen.returns);
    assert.ok(seen.rounds > 100, 'multi-round games: ' + seen.rounds);
  });

  test('undo is exact after reshuffles and knockouts', () => {
    const seen = { undoneReshuffles: 0, undoneKnockouts: 0, suddenDeath: 0 };
    for (let seed = 1; seed <= 400; seed++) {
      const players = 2 + (seed % 7);
      const handSize = 1 + (seed % 4);
      const state = makeState(players, handSize, players * handSize + 1 + (seed % 5));
      deal(state, seeded(seed));
      const { stats } = playOut(state, seed, 0.6, { pUndo: 0.5, maxUndos: 400, json: seed % 2 === 0 });
      seen.undoneReshuffles += stats.undoneReshuffles;
      seen.undoneKnockouts += stats.undoneKnockouts;
      if (stats.suddenDeath) seen.suddenDeath++;
    }
    assert.ok(seen.undoneReshuffles > 50, 'undone reshuffles: ' + seen.undoneReshuffles);
    assert.ok(seen.undoneKnockouts > 20, 'undone knockouts: ' + seen.undoneKnockouts);
    assert.ok(seen.suddenDeath > 20, 'sudden death reached: ' + seen.suddenDeath);
  });

  test('random decks with years clustered around 1 BC and AD 1 play to a finish', () => {
    const seen = { suddenDeath: 0, shared: 0, returns: 0 };
    for (let seed = 1; seed <= 200; seed++) {
      const r = seeded(seed);
      const players = 1 + Math.floor(r() * 8);
      const handSize = 1 + Math.floor(r() * 8);
      const count = players * handSize + 1 + Math.floor(r() * 6);
      // There is no year 0.
      const years = Array.from({ length: count }, () => Math.floor(r() * 40) - 20 || 1);
      const state = makeState(players, handSize, years);
      deal(state, r);
      const { stats } = playOut(state, seed, 0.2 + r() * 0.8, { pUndo: 0.2, json: seed % 2 === 0 });
      for (const key of ['suddenDeath', 'shared']) if (stats[key]) seen[key]++;
      seen.returns += stats.returns;
    }
    assert.ok(seen.suddenDeath > 10, 'sudden death reached: ' + seen.suddenDeath);
    assert.ok(seen.shared > 10, 'shared wins reached: ' + seen.shared);
    assert.ok(seen.returns > 10, 'returns to hand reached: ' + seen.returns);
  });

  test('a one-player game ends with that player winning', () => {
    const state = makeState(1, 4, 20);
    deal(state, seeded(11));
    const { state: end } = playOut(state, 11, 0.5);
    assert.deepEqual(end.game.winners, [1]);
    assert.ok(end.game.round >= 4);
  });

  test('an eight-player game plays several rounds to a finish', () => {
    const state = makeState(8, 4, 60);
    deal(state, seeded(12));
    const { state: end } = playOut(state, 12, 0.6);
    assert.equal(end.phase, 'over');
    assert.ok(end.game.round >= 4);
    assert.ok(end.game.log.length >= 8 * 4);
  });

  test('the same seeds replay the same game', () => {
    const a = makeState(5, 3, 30);
    const b = makeState(5, 3, 30);
    deal(a, seeded(99));
    deal(b, seeded(99));
    const x = playOut(a, 99, 0.5).state;
    const y = playOut(b, 99, 0.5).state;
    assert.deepEqual(x.game, y.game);
  });

  test('undo all the way back from over restores the deal', () => {
    let state = makeState(3, 2, 15);
    deal(state, seeded(21));
    const dealt = withoutHistory(state.game);
    const r = seeded(21);
    let count = 0;
    while (state.phase === 'playing' && count < 45) {
      const g = state.game;
      const card = g.hands[activePlayer(g)][0];
      play(state, card, r() < 0.6 ? correctGap(g, card) : (wrongGap(g, card) ?? correctGap(g, card)), r);
      count++;
    }
    assert.equal(state.phase, 'over');
    const seq = state.placementSeq;
    for (let i = 0; i < count; i++) assert.equal(undo(state), true);
    assert.equal(undo(state), false);
    assert.equal(state.phase, 'playing');
    assert.deepEqual({ ...withoutHistory(state.game), pending: dealt.pending }, dealt);
    assert.equal(state.placementSeq, seq);
  });
});
