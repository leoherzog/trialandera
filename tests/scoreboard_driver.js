// Driver page script for test_scoreboard.py: builds game states with js/game.js and saves them with js/store.js,
// so an open scoreboard hears each one as a storage event. Exposed as window.T.
import * as game from '/js/game.js';
import * as store from '/js/store.js';

const POOL = [
  ['End of the last glacial period', -10000],
  ['Wheel', -3500, 'Rotating component turning on an axle'],
  ['Cuneiform writing', -3200, 'Writing system of the ancient Near East'],
  ['Great Pyramid of Giza completed', -2560],
  ['Code of Hammurabi', -1754, 'Babylonian legal text'],
  ['First recorded Olympic Games', -776],
  ['Founding of Rome', -753],
  ['Battle of Marathon', -490],
  ['Parthenon completed', -432],
  ['Death of Alexander the Great', -323],
  ['Great Wall of China begun under Qin Shi Huang', -221],
  ['Antikythera mechanism, an ancient Greek hand-powered orrery used to predict astronomical positions and eclipses decades in advance', -100, 'Ancient Greek analogue computer used to predict astronomical positions and eclipses'],
  ['Assassination of Julius Caesar', -44],
  ['Eruption of Mount Vesuvius destroys Pompeii', 79],
  ['Paper', 105, 'Thin sheet material'],
  ['Hagia Sophia completed', 537],
  ['Gunpowder', 850, 'Explosive'],
  ['Magna Carta', 1215],
  ['Mechanical clock', 1283],
  ['Printing press', 1440, 'Machine that presses inked type onto paper or cloth'],
  ['Columbus reaches the Americas', 1492],
  ['Mona Lisa', 1503, 'Painting by Leonardo da Vinci'],
  ['Microscope', 1590],
  ['Telescope', 1608],
  ['Publication of Isaac Newton\'s Philosophiæ Naturalis Principia Mathematica, laying the foundations of classical mechanics', 1687, 'Book by Isaac Newton that set out the laws of motion and universal gravitation'],
  ['Newcomen steam engine', 1712],
  ['Declaration of Independence', 1776],
  ['Voltaic pile', 1800],
  ['Steam locomotive', 1804],
  ['Photography', 1826],
  ['Electrical telegraph', 1837],
  ['Telephone', 1876, 'Telecommunications device'],
  ['Phonograph', 1877],
  ['Incandescent light bulb', 1879],
  ['Benz Patent-Motorwagen', 1885],
  ['Radio', 1895],
  ['X-rays', 1895],
  ['The first successful powered, controlled and sustained heavier-than-air human flight by the Wright brothers at Kitty Hawk', 1903, 'Aviation milestone by Orville and Wilbur Wright on the Outer Banks of North Carolina'],
  ['Special relativity', 1905],
  ['Sinking of the Titanic', 1912],
  ['Television', 1927],
  ['Penicillin', 1928],
  ['Jet engine', 1937],
  ['Chicago Pile-1', 1942],
  ['ENIAC', 1945],
  ['Transistor', 1947],
  ['Structure of DNA', 1953],
  ['Sputnik 1', 1957],
  ['Laser', 1960],
  ['Supercalifragilisticexpialidocious', 1964, 'Song from Mary Poppins'],
  ['Apollo 11 Moon landing', 1969],
  ['Intel 4004 microprocessor', 1971],
  ['First handheld mobile phone call', 1973],
  ['Apple II', 1977],
  ['World Wide Web', 1989],
  ['Fall of the Berlin Wall', 1989],
  ['DVD', 1995],
  ['Google', 1998, 'American search engine'],
  ['Wikipedia', 2001],
  ['iPhone', 2007, 'Line of smartphones by Apple'],
  ['Bitcoin', 2009, 'Decentralized digital currency'],
  ['Higgs boson discovered', 2012],
  ['First image of a black hole', 2019],
  ['ChatGPT', 2022, 'Chatbot developed by OpenAI'],
  ['Domestication of the horse', -3500],
  ['Bronze Age collapse', -1177],
  ['Library of Alexandria founded', -285],
  ['Compass', 1040],
  ['Gutenberg Bible', 1455],
  ['Steam turbine', 1884],
  ['Insulin isolated', 1921],
  ['Polio vaccine', 1955],
  ['Internet (ARPANET)', 1969],
  ['Human Genome Project completed', 2003],
  ['YouTube', 2005],
  ['Large Hadron Collider', 2008]
];

const NAMES = ['Alice', 'Bob', 'Carmen', 'Dmitri', 'Evangeline Montgomery-Smythe', 'Farah', 'Gustavo', 'Hiroko'];

function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function base(players, handSize, deckSize, phase) {
  const state = store.defaultState();
  state.settings.handSize = handSize;
  for (let i = 0; i < players; i++) state.players.push({ id: state.nextId++, name: NAMES[i] });
  POOL.slice(0, deckSize).forEach(function ([label, year, description = '']) {
    state.deck.cards.push({
      id: state.deck.nextCardId++, source: 'Typed', title: null, linkLabel: label, textLabel: label, label: label,
      labelEdited: false, year: year, yearFrom: 'typed', description: description, context: '', include: true,
      flags: []
    });
  });
  state.deck.sources.push({ name: 'Typed', title: null, labelMode: 'text' });
  state.phase = phase;
  return state;
}

function dealt(players, handSize, deckSize, seed = 1) {
  const state = base(players, handSize, deckSize, 'setup');
  game.deal(state, rng(seed));
  return state;
}

function fittingGap(g, cardId) {
  for (let i = 0; i <= g.timeline.length; i++) if (game.fits(g, cardId, i)) return i;
  return -1;
}

function wrongGap(g, cardId) {
  for (let i = 0; i <= g.timeline.length; i++) if (!game.fits(g, cardId, i)) return i;
  return -1;
}

// Plays the active player's first card that can go wrong (when correct is false) or into its fitting gap.
function play(state, correct, r = rng(7)) {
  const g = state.game;
  const hand = g.hands[game.activePlayer(g)];
  for (const id of hand) {
    const gap = correct ? fittingGap(g, id) : wrongGap(g, id);
    if (gap >= 0) {
      game.setPending(g, { cardId: id, index: gap });
      return game.reveal(state, r);
    }
  }
  throw new Error('no move');
}

function save(state) {
  store.save(state);
  return state;
}

window.T = {
  game, store, rng, base, dealt, play, save, fittingGap, wrongGap,
  lobbyEmpty() { return save(base(3, 4, 0, 'lobby')); },
  lobby() { return save(base(5, 4, 42, 'lobby')); },
  setup() { return save(base(4, 4, 42, 'setup')); },
  fresh() { return save(dealt(4, 4, 42)); },
  pending(which) {
    const state = dealt(4, 4, 42);
    play(state, true); play(state, false); play(state, true);
    const g = state.game;
    const hand = g.hands[game.activePlayer(g)];
    if (which === 'card' || which === 'both') game.setPending(g, { cardId: hand[1] });
    if (which === 'gap' || which === 'both') game.setPending(g, { index: 1 });
    return save(state);
  },
  // Sets up a pending choice that is correct or wrong, so the caller can reveal it live.
  choose(correct) {
    const state = store.load();
    const g = state.game;
    const hand = g.hands[game.activePlayer(g)];
    for (const id of hand) {
      const gap = correct ? fittingGap(g, id) : wrongGap(g, id);
      if (gap >= 0) { game.setPending(g, { cardId: id, index: gap }); break; }
    }
    return save(state);
  },
  reveal() {
    const state = store.load();
    const p = game.reveal(state, rng(3));
    save(state);
    return p;
  },
  undo() {
    const state = store.load();
    const ok = game.undo(state);
    save(state);
    return ok;
  },
  suddenDeath() {
    // Everyone plays correctly; with hand 2 every player finishes in round 2, so sudden death starts.
    const state = dealt(3, 2, 30);
    while (!state.game.suddenDeath) play(state, true);
    return save(state);
  },
  overOne() {
    const state = dealt(4, 3, 42, 2);
    while (state.phase !== 'over') {
      const first = game.activePlayer(state.game) === state.game.seats[0];
      play(state, first);
    }
    return save(state);
  },
  overShared() {
    // A deck exactly the deal size leaves nothing to draw, so players who finish together share the win.
    const state = dealt(3, 3, 10, 4);
    while (state.phase !== 'over') {
      const id = game.activePlayer(state.game);
      play(state, id !== state.game.seats[2]);
    }
    return save(state);
  },
  eight() {
    const state = dealt(8, 8, 76, 5);
    play(state, true); play(state, false);
    const g = state.game;
    const hand = g.hands[game.activePlayer(g)];
    game.setPending(g, { cardId: hand[3], index: 1 });
    return save(state);
  },
  forty(pendingGap) {
    const state = dealt(8, 8, 76, 6);
    while (state.game.timeline.length < 41) play(state, true);
    const g = state.game;
    const hand = g.hands[game.activePlayer(g)];
    game.setPending(g, { cardId: hand[0], index: pendingGap === undefined ? null : pendingGap });
    return save(state);
  },
  finishedMidRound() {
    const state = dealt(4, 1, 30, 9);
    play(state, true);
    play(state, false);
    return save(state);
  },
  suddenOut() {
    // Two of three finish round 1, so the third sits out sudden death.
    const state = dealt(3, 1, 30, 10);
    play(state, true); play(state, true); play(state, false);
    const g = state.game;
    game.setPending(g, { cardId: g.hands[game.activePlayer(g)][0], index: 0 });
    return save(state);
  },
  // The last seat has one card left and the next reveal ends the round and wins the game.
  nearWin() {
    const state = dealt(3, 2, 30, 12);
    play(state, false); play(state, false); play(state, true);
    play(state, false); play(state, false);
    const g = state.game;
    const id = g.hands[game.activePlayer(g)][0];
    game.setPending(g, { cardId: id, index: fittingGap(g, id) });
    return save(state);
  },
  // One player with eight cards, two of them placed.
  solo() {
    const state = dealt(1, 8, 20, 8);
    play(state, true); play(state, true);
    return save(state);
  }
};
window.dispatchEvent(new Event('driver-ready'));
