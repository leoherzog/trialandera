// Rules of play: dealing, placement, turns, rounds, sudden death, undo, and standings.
// Pure functions over the state described in README.md, shared by the host console and the scoreboard.
// Functions that change state mutate the object they are given; none touch the DOM or storage.

const MAX_PLAYERS = 8;
const MAX_HAND = 8;
const HISTORY_LIMIT = 50;

/**
 * Cards a deal can use, and how many it needs: a hand for each player plus the starting card.
 * @param {object} state
 * @returns {{cards: Array<object>, needed: number}} cards are the included deck cards with a year
 */
export function dealable(state) {
  const cards = state.deck.cards.filter(function (card) { return card.include && Number.isInteger(card.year); });
  return { cards: cards, needed: state.players.length * state.settings.handSize + 1 };
}

// Fisher-Yates, in place.
function shuffle(ids, rng) {
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  return ids;
}

/**
 * Deal a new game from the dealable cards and move to 'playing'. Game n starts with seat (n − 1) mod players.
 * Throws, leaving state untouched, when the players, hand size or deck cannot make a game.
 * @param {object} state
 * @param {function(): number} rng uniform in [0, 1), used for every shuffle
 */
export function deal(state, rng = Math.random) {
  const count = state.players.length;
  const handSize = state.settings.handSize;
  if (count < 1 || count > MAX_PLAYERS) throw new Error('A game needs 1 to ' + MAX_PLAYERS + ' players, not ' + count);
  if (!Number.isInteger(handSize) || handSize < 1 || handSize > MAX_HAND) {
    throw new Error('Hand size must be a whole number from 1 to ' + MAX_HAND + ', not ' + handSize);
  }
  const ready = dealable(state);
  if (ready.cards.length < ready.needed) {
    throw new Error('Dealing needs ' + ready.needed + ' cards with a year, and the deck has ' + ready.cards.length);
  }

  state.gameNumber += 1;
  const ids = state.players.map(function (p) { return p.id; });
  const first = (state.gameNumber - 1) % count;
  const seats = ids.slice(first).concat(ids.slice(0, first));
  const cards = {};
  ready.cards.forEach(function (card) {
    cards[card.id] = { id: card.id, label: card.label, year: card.year };
  });
  const draw = shuffle(ready.cards.map(function (card) { return card.id; }), rng);
  const hands = {};
  seats.forEach(function (id) { hands[id] = []; });
  for (let i = 0; i < handSize; i++) {
    seats.forEach(function (id) { hands[id].push(draw.pop()); });
  }
  const start = draw.pop();
  state.game = {
    number: state.gameNumber,
    cards: cards,
    draw: draw,
    discard: [],
    timeline: [start],
    hands: hands,
    seats: seats,
    turn: 0,
    round: 1,
    suddenDeath: false,
    finished: [],
    pending: { cardId: null, index: null },
    log: [],
    winners: [],
    out: {},
    history: []
  };
  state.phase = 'playing';
}

/**
 * @param {object|null} game
 * @returns {number|null} the player whose turn it is, or null when there is no game or it is over
 */
export function activePlayer(game) {
  if (!game || game.winners.length) return null;
  return game.seats[game.turn] ?? null;
}

function checkCard(game, playerId, cardId) {
  if (!game.hands[playerId].includes(cardId)) {
    throw new Error('Card ' + cardId + ' is not in the hand of player ' + playerId);
  }
}

function checkGap(game, index) {
  if (!Number.isInteger(index) || index < 0 || index > game.timeline.length) {
    throw new Error('Gap ' + index + ' is outside 0 to ' + game.timeline.length);
  }
}

/**
 * Update the host's tentative choice. Null clears a field; an omitted field keeps its value.
 * Throws when the card is not in the active player's hand or the gap is out of range.
 * @param {object} game
 * @param {{cardId?: number|null, index?: number|null}} patch
 */
export function setPending(game, patch) {
  const playerId = activePlayer(game);
  if (playerId === null) throw new Error('No turn is in progress');
  const cardId = patch.cardId === undefined ? game.pending.cardId : patch.cardId;
  const index = patch.index === undefined ? game.pending.index : patch.index;
  if (cardId !== null) checkCard(game, playerId, cardId);
  if (index !== null) checkGap(game, index);
  game.pending = { cardId: cardId, index: index };
}

/**
 * Whether a card belongs in a gap: its year is at least its left neighbor's and at most its right neighbor's.
 * @param {object} game
 * @param {number} cardId
 * @param {number} index gap, 0..timeline.length
 * @returns {boolean}
 */
export function fits(game, cardId, index) {
  const card = game.cards[cardId];
  if (!card) throw new Error('Card ' + cardId + ' is not in this game');
  checkGap(game, index);
  const left = game.timeline[index - 1];
  const right = game.timeline[index];
  return (left === undefined || game.cards[left].year <= card.year) &&
    (right === undefined || card.year <= game.cards[right].year);
}

// Snapshots leave out cards, which never change, history itself, and log, which undo pops instead.
// A reveal draws at most one card per seat plus one and reshuffles only an emptied pile, so a snapshot keeps that
// many cards from the top of the draw pile; the drawUnder cards beneath stay in place until undo.
function remember(game) {
  const { cards, history, log, draw, ...rest } = game;
  const under = Math.max(0, draw.length - game.seats.length - 1);
  history.push(structuredClone({ ...rest, drawTop: draw.slice(under), drawUnder: under }));
  if (history.length > HISTORY_LIMIT) history.shift();
}

/**
 * Take the top of the draw pile. An empty draw pile is first refilled by shuffling in the discard pile,
 * except `keep`, which stays behind as the discard pile's only card.
 * @returns {number|null} card id, or null when both piles are empty
 */
function drawCard(game, rng, keep) {
  if (!game.draw.length) {
    game.draw = shuffle(game.discard.filter(function (id) { return id !== keep; }), rng);
    game.discard = game.discard.filter(function (id) { return id === keep; });
  }
  return game.draw.length ? game.draw.pop() : null;
}

function endGame(state, winners) {
  state.game.winners = winners.slice();
  state.phase = 'over';
}

// After a turn: the next seat, or at the end of a round a new round, sudden death, or the end of the game.
function advance(state, rng) {
  const game = state.game;
  game.turn += 1;
  if (game.turn < game.seats.length) return;
  if (game.finished.length === 1) {
    endGame(state, game.finished);
    return;
  }
  if (game.finished.length > 1) {
    const finalists = game.seats.filter(function (id) { return game.finished.includes(id); });
    if (game.draw.length + game.discard.length < finalists.length) {
      endGame(state, finalists);
      return;
    }
    finalists.forEach(function (id) { game.hands[id].push(drawCard(game, rng)); });
    game.seats.forEach(function (id) {
      if (!finalists.includes(id)) game.out[id] = game.round;
    });
    game.seats = finalists;
    game.suddenDeath = true;
  }
  game.finished = [];
  game.turn = 0;
  game.round += 1;
}

/**
 * Resolve the pending choice for the active player, then advance the turn, round, sudden death or end of game.
 * Throws, leaving state untouched, when no game is in play or the choice is incomplete or invalid.
 * @param {object} state
 * @param {function(): number} rng uniform in [0, 1), used to reshuffle the discard pile
 * @returns {object} the Placement, also appended to game.log
 */
export function reveal(state, rng = Math.random) {
  const game = state.game;
  const playerId = state.phase === 'playing' ? activePlayer(game) : null;
  if (playerId === null) throw new Error('No game is in play');
  const cardId = game.pending.cardId;
  const index = game.pending.index;
  if (cardId === null || index === null) throw new Error('Pick a card and a gap before revealing');
  checkCard(game, playerId, cardId);
  checkGap(game, index);

  remember(game);
  const correct = fits(game, cardId, index);
  const hand = game.hands[playerId];
  const at = hand.indexOf(cardId);
  hand.splice(at, 1);
  let drawn = null;
  if (correct) {
    game.timeline.splice(index, 0, cardId);
    if (!hand.length) game.finished.push(playerId);
  } else {
    game.discard.push(cardId);
    drawn = drawCard(game, rng, cardId);
    if (drawn === null) {
      game.discard = game.discard.filter(function (id) { return id !== cardId; });
      hand.splice(at, 0, cardId);
    } else {
      hand.push(drawn);
    }
  }

  const placement = {
    id: state.placementSeq,
    round: game.round,
    playerId: playerId,
    cardId: cardId,
    index: index,
    correct: correct,
    year: game.cards[cardId].year,
    drawn: drawn
  };
  state.placementSeq += 1;
  game.log.push(placement);
  game.pending = { cardId: null, index: null };
  advance(state, rng);
  return placement;
}

/**
 * Revert the latest placement, restoring the choice that was revealed. From 'over' this returns to 'playing'.
 * placementSeq is kept, so a placement made again gets a new id.
 * @param {object} state
 * @returns {boolean} false when there is nothing to undo
 */
export function undo(state) {
  const game = state.game;
  if (!game || (state.phase !== 'playing' && state.phase !== 'over')) return false;
  const snapshot = game.history.pop();
  if (!snapshot) return false;
  const { drawTop, drawUnder, ...rest } = snapshot;
  Object.assign(game, rest, { draw: game.draw.slice(0, drawUnder).concat(drawTop) });
  game.log.pop();
  state.phase = 'playing';
  return true;
}

/**
 * The players due after the active one, without repeats. The list crosses into the next round only while
 * nobody has finished this one, because a finish ends the game or starts sudden death.
 * @param {object|null} game
 * @param {number} n
 * @returns {Array<number>} player ids
 */
export function upNext(game, n) {
  if (activePlayer(game) === null) return [];
  const later = game.seats.slice(game.turn + 1);
  const nextRound = game.finished.length ? [] : game.seats.slice(0, game.turn);
  return later.concat(nextRound).slice(0, Math.max(0, n));
}

/**
 * Standings for the players in the game: winners first, then those knocked out of sudden death later before
 * those knocked out earlier, then fewest cards in hand. Equal rows share a rank and keep lobby seat order.
 * @param {object} state
 * @returns {Array<{player: object, cards: number, rank: number, winner: boolean}>}
 */
export function standings(state) {
  const game = state.game;
  if (!game) return [];
  const rows = state.players.filter(function (player) { return game.hands[player.id]; }).map(function (player) {
    return { player: player, cards: game.hands[player.id].length, rank: 0, winner: game.winners.includes(player.id) };
  });
  function lastRound(row) {
    return game.out[row.player.id] ?? game.round;
  }
  function compare(a, b) {
    return (b.winner - a.winner) || (lastRound(b) - lastRound(a)) || (a.cards - b.cards);
  }
  rows.sort(compare);
  rows.forEach(function (row, i) {
    const prev = rows[i - 1];
    row.rank = prev && !compare(prev, row) ? prev.rank : i + 1;
  });
  return rows;
}
