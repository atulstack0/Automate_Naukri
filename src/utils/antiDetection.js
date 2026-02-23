'use strict';

const logger = require('../utils/logger');

/**
 * Sleep for a random duration between min and max ms.
 */
async function randomDelay(min = 1000, max = 3000) {
  const ms = Math.floor(Math.random() * (max - min + 1)) + min;
  logger.debug(`Anti-detect delay: ${ms}ms`);
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Move mouse along a bezier curve to mimic human movement.
 */
async function humanMouseMove(page, targetX, targetY, steps = 25) {
  try {
    const { innerWidth, innerHeight } = await page.evaluate(() => ({
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
    }));

    // Start from a random position
    const startX = Math.floor(Math.random() * innerWidth * 0.7) + 50;
    const startY = Math.floor(Math.random() * innerHeight * 0.7) + 50;

    // Control points for cubic bezier
    const cp1x = startX + (targetX - startX) * 0.3 + (Math.random() - 0.5) * 100;
    const cp1y = startY + (targetY - startY) * 0.3 + (Math.random() - 0.5) * 100;
    const cp2x = startX + (targetX - startX) * 0.7 + (Math.random() - 0.5) * 80;
    const cp2y = startY + (targetY - startY) * 0.7 + (Math.random() - 0.5) * 80;

    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const mt = 1 - t;
      const x = Math.round(
        mt * mt * mt * startX +
        3 * mt * mt * t * cp1x +
        3 * mt * t * t * cp2x +
        t * t * t * targetX
      );
      const y = Math.round(
        mt * mt * mt * startY +
        3 * mt * mt * t * cp1y +
        3 * mt * t * t * cp2y +
        t * t * t * targetY
      );
      await page.mouse.move(x, y);
      await new Promise(r => setTimeout(r, Math.random() * 8 + 2));
    }
  } catch (err) {
    logger.debug('humanMouseMove skipped', { err: err.message });
  }
}

/**
 * Click an element after moving mouse to it naturally.
 */
async function humanClick(page, selector, options = {}) {
  const element = await page.locator(selector).first();
  const box = await element.boundingBox();
  if (box) {
    const targetX = box.x + box.width / 2 + (Math.random() - 0.5) * 10;
    const targetY = box.y + box.height / 2 + (Math.random() - 0.5) * 5;
    await humanMouseMove(page, targetX, targetY);
    await randomDelay(80, 200);
  }
  await element.click(options);
}

/**
 * Type text character by character with varied delays.
 */
async function humanType(page, selector, text, clearFirst = true) {
  const element = page.locator(selector).first();
  await element.click();
  if (clearFirst) {
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Delete');
    await randomDelay(100, 250);
  }
  for (const char of text) {
    await page.keyboard.type(char, { delay: Math.floor(Math.random() * 100) + 40 });
  }
}

/**
 * Scroll the page randomly to simulate reading.
 */
async function randomScroll(page, scrollAmount = null) {
  try {
    const amount = scrollAmount || Math.floor(Math.random() * 400) + 100;
    const direction = Math.random() > 0.3 ? amount : -Math.floor(amount * 0.4);
    await page.mouse.wheel(0, direction);
    await randomDelay(300, 700);
  } catch (err) {
    logger.debug('randomScroll skipped', { err: err.message });
  }
}

/**
 * Wait in a human-realistic pause pattern.
 */
async function readingPause(page) {
  // Small scroll, then pause as if reading
  await randomScroll(page, Math.floor(Math.random() * 200) + 50);
  await randomDelay(800, 2200);
}

/**
 * Exponential backoff utility.
 */
async function backoff(attempt, baseMs = 2000, maxMs = 30000) {
  const delay = Math.min(baseMs * Math.pow(2, attempt), maxMs);
  const jitter = delay * 0.2 * Math.random();
  const total = Math.floor(delay + jitter);
  logger.debug(`Backoff delay: ${total}ms (attempt ${attempt})`);
  await new Promise(resolve => setTimeout(resolve, total));
}

/**
 * Draw a visible pulsing outline + floating label on an element so the
 * user can watch exactly what the bot is clicking/filling.
 *
 * @param {import('playwright').Page} page
 * @param {import('playwright').Locator|import('playwright').ElementHandle} target
 * @param {string} label  - Short text shown in the badge (e.g. "Click: Submit")
 * @param {string} color  - Border color, default vivid red-orange
 * @param {number} holdMs - How long to show the highlight before it fades
 */
async function highlightElement(page, target, label = '', color = '#ff4444', holdMs = 900) {
  try {
    // Resolve to a plain JS element handle so we can pass it to evaluate
    const handle = typeof target.elementHandle === 'function'
      ? await target.elementHandle()
      : target;
    if (!handle) return;

    await page.evaluate(([el, col, lbl, hold]) => {
      if (!el) return;

      // Inject animation keyframes once
      const ANIM_ID = '__aa_pulse_anim__';
      if (!document.getElementById(ANIM_ID)) {
        const style = document.createElement('style');
        style.id = ANIM_ID;
        style.textContent = `
          @keyframes __aa_pulse {
            0%   { box-shadow: 0 0 0 0  ${col}aa; outline-color: ${col}; }
            50%  { box-shadow: 0 0 0 8px ${col}44; outline-color: ${col}cc; }
            100% { box-shadow: 0 0 0 0  ${col}aa; outline-color: ${col}; }
          }
        `.replace(/\$\{col\}/g, col);
        document.head.appendChild(style);
      }

      // Save original styles
      const prevOutline    = el.style.outline;
      const prevBoxShadow  = el.style.boxShadow;
      const prevAnimation  = el.style.animation;
      const prevPosition   = el.style.position;
      const prevZIndex     = el.style.zIndex;

      // Apply highlight
      el.style.outline        = `3px solid ${col}`;
      el.style.boxShadow      = `0 0 0 4px ${col}55`;
      el.style.animation      = `__aa_pulse 0.6s ease-in-out infinite`;
      el.style.position       = el.style.position || 'relative';
      el.style.zIndex         = '9999';

      // Floating label badge
      let badge = null;
      if (lbl) {
        badge = document.createElement('div');
        badge.textContent = lbl;
        Object.assign(badge.style, {
          position:        'fixed',
          background:      col,
          color:           '#fff',
          fontSize:        '11px',
          fontWeight:      '700',
          fontFamily:      'monospace',
          padding:         '3px 8px',
          borderRadius:    '4px',
          zIndex:          '99999',
          pointerEvents:   'none',
          boxShadow:       '0 2px 8px rgba(0,0,0,0.4)',
          letterSpacing:   '0.5px',
        });
        // Position badge near top of element
        const rect = el.getBoundingClientRect();
        badge.style.top  = `${Math.max(rect.top - 28, 4)}px`;
        badge.style.left = `${Math.min(rect.left, window.innerWidth - 200)}px`;
        document.body.appendChild(badge);
      }

      // Clean up after hold period
      setTimeout(() => {
        el.style.outline    = prevOutline;
        el.style.boxShadow  = prevBoxShadow;
        el.style.animation  = prevAnimation;
        el.style.position   = prevPosition;
        el.style.zIndex     = prevZIndex;
        if (badge && badge.parentNode) badge.parentNode.removeChild(badge);
      }, hold);

    }, [handle, color, label, holdMs]);

    // Brief pause so user can actually see the highlight
    await new Promise(r => setTimeout(r, Math.min(holdMs, 250)));

  } catch (err) {
    logger.debug(`[Highlight] skipped: ${err.message}`);
  }
}

/**
 * Highlight then click a locator. Replaces direct .click() calls when you
 * want visual confirmation of what the bot is interacting with.
 *
 * @param {import('playwright').Page}    page
 * @param {import('playwright').Locator} locator
 * @param {string} label   - Badge text, e.g. "Click: Apply"
 * @param {object} clickOpts - Playwright click options
 */
async function highlightAndClick(page, locator, label = '', clickOpts = {}) {
  try {
    await highlightElement(page, locator, label || 'Click', '#ff4444', 500);
    await locator.click(clickOpts);
  } catch (err) {
    // Try clicking without highlight on failure
    logger.debug(`[Highlight] click fallback: ${err.message}`);
    await locator.click(clickOpts);
  }
}

module.exports = {
  randomDelay,
  humanMouseMove,
  humanClick,
  humanType,
  randomScroll,
  readingPause,
  backoff,
  highlightElement,
  highlightAndClick,
};

