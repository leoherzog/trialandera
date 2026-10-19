// DOM helpers shared by the host console and the scoreboard: element lookup, template cloning, number formatting,
// and Font Awesome icons.

export const fmt = new Intl.NumberFormat('en-US');

export function $(id) {
  return document.getElementById(id);
}

/**
 * A live copy of a <template>'s first element child.
 * @param {string} id the template's id
 * @returns {Element}
 */
export function fromTemplate(id) {
  // importNode, not cloneNode: a clone stays in the template's inert document, where animations never run.
  return document.importNode($(id).content.firstElementChild, true);
}

/**
 * A decorative Font Awesome icon; the Font Awesome script swaps the span for an inline SVG.
 * @param {string} name Font Awesome name without the fa- prefix
 * @returns {HTMLSpanElement}
 */
export function icon(name) {
  const span = document.createElement('span');
  span.className = 'fa-solid fa-' + name;
  span.setAttribute('aria-hidden', 'true');
  return span;
}
