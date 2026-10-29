// Screen-shared scoreboard: renders the public view of game state and animates placements as they land.
// Read-only. It never shows the year of a card in a hand, including the pending card.

import { load, subscribe } from './store.js';
import { dealable, activePlayer, upNext, standings } from './game.js';
import { formatYear } from './years.js';
import { $, fmt, icon, fromTemplate } from './dom.js';

const CORRECT_MS = 2400;
const WRONG_MS = 3200;
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const plural = new Intl.PluralRules('en-US');
const ordinal = new Intl.PluralRules('en-US', { type: 'ordinal' });
const ORDINAL_SUFFIX = { one: 'st', two: 'nd', few: 'rd', other: 'th' };
const list = new Intl.ListFormat('en-US');

// Placement id → performance.now() when this window first saw it. Placements present at load never animate.
// Cleared when the game changes, because a reset state numbers placements from 0 again.
const landed = new Map();
let landedGame = null;
let firstRender = true;
let resultTimer = 0;
// The first scroll after the strip appears jumps; later ones glide.
let stripShown = false;
// The strip element last centered, kept so a resize can center it again at the new scale.
let centered = null;

function cardCount(n) {
  return fmt.format(n) + (plural.select(n) === 'one' ? ' card' : ' cards');
}

function playerName(state, id) {
  const player = state.players.find(function (p) { return p.id === id; });
  return player ? player.name : '?';
}

function markEl(iconName, text) {
  const mark = document.createElement('mark');
  mark.append(icon(iconName), ' ' + text);
  return mark;
}

function setMark(el, iconName, text) {
  const mark = markEl(iconName, text);
  el.replaceChildren(mark);
  return mark;
}

function render() {
  const state = load();
  const game = state.phase === 'playing' || state.phase === 'over' ? state.game : null;
  const now = performance.now();
  if ((game ? game.number : null) !== landedGame) {
    landed.clear();
    landedGame = game ? game.number : null;
  }
  if (game) {
    game.log.forEach(function (placement) {
      if (!landed.has(placement.id)) landed.set(placement.id, firstRender ? -Infinity : now);
    });
  }
  firstRender = false;

  // Only the latest placement animates; the next one replaces it.
  const last = game && game.log.length ? game.log[game.log.length - 1] : null;
  const age = last ? now - landed.get(last.id) : Infinity;
  const showFor = last && last.correct ? CORRECT_MS : WRONG_MS;
  const fresh = age < showFor ? last : null;
  clearTimeout(resultTimer);
  // Re-render once the result ends so the card settles or leaves.
  if (fresh) resultTimer = setTimeout(render, showFor - age + 50);

  renderBanner(state, game);
  renderWaiting(state, !game);
  renderTimeline(game, last, fresh, age);
  renderStatus(state, game, last);
  renderTurn(state, game);
  renderPlayers(state, game);
  renderStandings(state, game);
}

function renderBanner(state, game) {
  $('sb-goal').textContent = game ? 'first to play every card wins' : 'put history in order';
  $('sb-round').replaceChildren();
  $('sb-draw').replaceChildren();
  if (!game) return;
  if (state.phase === 'over') setMark($('sb-round'), 'flag-checkered', 'GAME OVER');
  else if (game.suddenDeath) setMark($('sb-round'), 'fire-flame-curved', 'SUDDEN DEATH');
  else $('sb-round').append(icon('flag'), ' ROUND ' + game.round);
  $('sb-draw').append(icon('layer-group'), ' ' + cardCount(game.draw.length) + ' to draw');
}

function renderWaiting(state, show) {
  $('sb-wait').hidden = !show;
  if (!show) return;
  const setup = state.phase === 'setup';
  $('sb-wait-title').textContent = setup ? 'Building the deck…' : 'Waiting for the host';
  const ready = dealable(state).cards.length;
  let detail = ready ? cardCount(ready) + ' in the deck' : 'No cards in the deck yet';
  if (setup) detail += ' · ' + cardCount(state.settings.handSize) + ' each';
  $('sb-wait-detail').replaceChildren(icon('layer-group'), ' ' + detail);
}

// A card's face: its label, its description when it has one, and yearText in the footer.
function cardEl(card, yearText) {
  const el = fromTemplate('tpl-card');
  el.querySelector('p').textContent = card ? card.label : '';
  const about = el.querySelector('small');
  if (card && card.description) about.textContent = card.description;
  else about.remove();
  el.querySelector('strong').textContent = yearText;
  return el;
}

function yearCard(card) {
  return cardEl(card, formatYear(card.year));
}

function resultMark(el, correct) {
  el.dataset.result = correct ? 'correct' : 'wrong';
  const mark = correct ? markEl('check', 'CORRECT') : markEl('xmark', 'WRONG');
  el.prepend(mark);
  return mark;
}

function renderTimeline(game, last, fresh, age) {
  const strip = $('sb-timeline');
  strip.hidden = !game;
  centered = null;
  if (!game) {
    stripShown = false;
    return;
  }
  const pending = game.pending;
  const slots = [];
  let ghost = null;
  let wrong = null;
  let placed = null;
  for (let gap = 0; gap <= game.timeline.length; gap++) {
    if (fresh && !fresh.correct && fresh.index === gap) {
      wrong = yearCard(game.cards[fresh.cardId]);
      slots.push(wrong);
    }
    if (pending.index === gap) {
      ghost = cardEl(pending.cardId === null ? null : game.cards[pending.cardId], '?');
      ghost.dataset.ghost = '';
      slots.push(ghost);
    }
    if (gap < game.timeline.length) {
      const card = game.cards[game.timeline[gap]];
      const el = yearCard(card);
      if (last && last.correct && last.cardId === card.id) placed = el;
      slots.push(el);
    }
  }
  strip.replaceChildren(...slots);
  strip.style.setProperty('--chars', Math.max(4, ...slots.map(function (el) {
    return el.querySelector('strong').textContent.length;
  })));

  if (fresh && placed) animateCorrect(placed, resultMark(placed, true), age);
  if (wrong) animateWrong(strip, wrong, resultMark(wrong, false), age);

  // Once a wrong card has left, the card right of its gap stands in for it, or the last card at the end.
  let target = ghost || wrong || placed;
  if (!target && last) target = slots[Math.min(last.index, slots.length - 1)];
  if (target) center(target, stripShown && !reducedMotion.matches ? 'smooth' : 'instant');
}

// Uses scrollTo on the strip, because scrollIntoView would also scroll the stage.
function center(el, behavior) {
  const strip = $('sb-timeline');
  strip.scrollTo({ left: el.offsetLeft + el.offsetWidth / 2 - strip.clientWidth / 2, behavior: behavior });
  stripShown = true;
  centered = el;
}

function blink(mark, duration, age) {
  const anim = mark.animate(
    [{ opacity: 0 }, { opacity: 1 }, { opacity: 0.2 }, { opacity: 1 }, { opacity: 0.2 }, { opacity: 1 }],
    { duration: duration, easing: 'ease-out' }
  );
  anim.currentTime = age;
}

// The card flips face up in the gap the ghost held, then pops.
function animateCorrect(el, mark, age) {
  if (reducedMotion.matches) return;
  const flip = el.animate([
    { transform: 'perspective(40rem) rotateY(90deg)', easing: 'ease-out' },
    { transform: 'none', offset: 0.15, easing: 'ease-in-out' },
    { transform: 'scale(1.08)', offset: 0.25, easing: 'ease-in-out' },
    { transform: 'none', offset: 0.35 },
    { transform: 'none' }
  ], CORRECT_MS);
  flip.currentTime = age;
  blink(mark, CORRECT_MS, age);
}

// The card flips face up, holds, then falls out while its neighbors close the gap.
// fill keeps it collapsed until the follow-up render removes it.
function animateWrong(strip, el, mark, age) {
  if (reducedMotion.matches) return;
  const close = -(el.offsetWidth + parseFloat(getComputedStyle(strip).columnGap || 0)) + 'px';
  const leave = el.animate([
    { transform: 'perspective(40rem) rotateY(90deg)', opacity: 1, marginRight: '0px', easing: 'ease-out' },
    { transform: 'none', opacity: 1, marginRight: '0px', offset: 0.12 },
    { transform: 'none', opacity: 1, marginRight: '0px', offset: 0.7, easing: 'ease-in' },
    { transform: 'translateY(6rem) rotate(10deg)', opacity: 0, marginRight: close }
  ], { duration: WRONG_MS, fill: 'forwards' });
  leave.currentTime = age;
  blink(mark, WRONG_MS * 0.7, age);
}

function renderStatus(state, game, last) {
  const status = $('sb-status');
  status.hidden = !game;
  if (!game) return;
  if (!last) {
    status.replaceChildren(icon('arrows-left-right'), ' Before or after? Place each card where it belongs in time.');
    return;
  }
  const card = game.cards[last.cardId];
  const name = playerName(state, last.playerId);
  const label = document.createElement('strong');
  label.textContent = card.label;
  const mark = setMark(status, last.correct ? 'check' : 'xmark',
    (last.correct ? 'CORRECT · ' : 'WRONG · ') + formatYear(last.year));
  mark.dataset.result = last.correct ? 'correct' : 'wrong';
  if (last.correct) {
    status.append(' ' + name + ' placed ', label);
  } else {
    status.append(' ' + name + ' misplaced ', label,
      last.drawn === null ? ' and takes it back.' : ' and draws a new card.');
  }
}

function renderTurn(state, game) {
  const playerId = activePlayer(game);
  $('sb-turn').hidden = playerId === null;
  if (playerId === null) return;
  const hand = game.hands[playerId];
  const count = document.createElement('small');
  count.textContent = ' · ' + cardCount(hand.length) + ' to play';
  $('sb-player').replaceChildren(icon('hand-point-right'), ' ' + playerName(state, playerId), count);
  $('sb-hand').replaceChildren(...hand.map(function (id) {
    const el = cardEl(game.cards[id], '?');
    if (id === game.pending.cardId) el.setAttribute('aria-current', 'true');
    return el;
  }));
}

// Lobby and setup list everyone; play lists the others in turn order after the active player,
// then anyone sudden death left out.
function renderPlayers(state, game) {
  let chips = [];
  if (!game) {
    chips = state.players.map(function (player) { return playerChip(player.name); });
  } else if (state.phase === 'playing') {
    const seated = game.seats.slice(game.turn + 1).concat(game.seats.slice(0, game.turn));
    const next = upNext(game, 1)[0];
    chips = seated.map(function (id) {
      const chip = playerChip(playerName(state, id), game.hands[id].length);
      if (game.finished.includes(id)) {
        chip.dataset.finished = '';
        chip.prepend(markEl('flag-checkered', 'FINISHED'));
      } else if (id === next) {
        chip.dataset.next = '';
        chip.prepend(markEl('angles-right', 'UP NEXT'));
      }
      return chip;
    });
    state.players.forEach(function (player) {
      if (!game.hands[player.id] || game.seats.includes(player.id)) return;
      const chip = playerChip(player.name, game.hands[player.id].length);
      chip.dataset.out = '';
      chip.lastElementChild.prepend('out · ');
      chips.push(chip);
    });
  }
  $('sb-players').hidden = !chips.length;
  $('sb-players').replaceChildren(...chips);
}

// Lobby chips pass no count and show only the name.
function playerChip(name, count) {
  const chip = fromTemplate('tpl-player');
  chip.firstElementChild.append(icon('user'), ' ' + name);
  if (count !== undefined) chip.lastElementChild.textContent = count ? cardCount(count) + ' left' : 'no cards left';
  return chip;
}

function renderStandings(state, game) {
  const show = !!game && state.phase === 'over';
  $('sb-standings').hidden = !show;
  if (!show) return;
  // Past two winners the heading gives a count, so long names cannot push standings rows off the stage.
  const winners = game.winners.map(function (id) { return playerName(state, id); });
  let heading = winners[0] + ' wins!';
  if (winners.length > 2) heading = fmt.format(winners.length) + ' players share the win!';
  else if (winners.length > 1) heading = list.format(winners) + ' share the win!';
  $('sb-winner').replaceChildren(icon('crown'), ' ' + heading);
  const rows = standings(state).map(function (row) {
    const tr = fromTemplate('tpl-standing');
    tr.cells[0].textContent = row.rank + ORDINAL_SUFFIX[ordinal.select(row.rank)];
    if (row.winner) setMark(tr.cells[1], 'crown', row.player.name);
    else tr.cells[1].textContent = row.player.name;
    tr.cells[2].textContent = row.cards ? cardCount(row.cards) + ' left' : 'no cards left';
    return tr;
  });
  $('sb-standings-body').replaceChildren(...rows);
  $('sb-standings-body').closest('div').style.setProperty('--rows', rows.length);
}

subscribe(render);
// Card sizes follow the window, so a resize leaves the old scroll offset off center.
window.addEventListener('resize', function () {
  if (centered) center(centered, 'instant');
});
render();
