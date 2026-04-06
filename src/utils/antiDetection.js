'use strict';

/**
 * Anti-Detection Utilities
 * Every function makes browser actions statistically look human.
 * Exports both the spec-required API and the existing helpers used by worker.js.
 */

const logger = require('../utils/logger');

// ─────────────────────────────────────────────────────────────────────────────
// Core timing helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Promise resolving after random ms between min and max.
 * @param {number} min
 * @param {number} max
 */
async function humanDelay(min = 1000, max = 3000) {
  const ms = Math.floor(Math.random() * (max - min + 1)) + min;
  logger.debug(`[AntiDetect] humanDelay ${ms}ms`);
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Alias kept for backward compatibility with existing worker code. */
const randomDelay = humanDelay;

// ─────────────────────────────────────────────────────────────────────────────
// Typing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Click field and type each character with 50-180ms random delay.
 * 5% chance per char: wrong char → 200ms pause → backspace → retype.
 * @param {import('playwright').Page} page
 * @param {string} selector
 * @param {string} text
 */
async function humanType(page, selector, text) {
  await page.click(selector);
  for (const char of text) {
    // 5% typo chance
    if (Math.random() < 0.05) {
      const wrongChar = String.fromCharCode(char.charCodeAt(0) + (Math.random() > 0.5 ? 1 : -1));
      await page.keyboard.type(wrongChar, { delay: Math.floor(Math.random() * 130) + 50 });
      await humanDelay(150, 300);
      await page.keyboard.press('Backspace');
      await humanDelay(80, 150);
    }
    await page.keyboard.type(char, { delay: Math.floor(Math.random() * 130) + 50 });
  }
}

/**
 * @deprecated Use humanType — kept for backward compat with formFiller.js.
 */
async function humanTypeCompat(page, selector, text, _clearFirst = true) {
  const element = page.locator(selector).first();
  await element.click();
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Delete');
  await humanDelay(100, 250);
  for (const char of text) {
    await page.keyboard.type(char, { delay: Math.floor(Math.random() * 100) + 40 });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Mouse movement
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Move mouse to 3-5 random positions with cubic bezier interpolation,
 * using 8-12 intermediate points per move.
 * @param {import('playwright').Page} page
 */
async function randomMouseMove(page) {
  const stops = Math.floor(Math.random() * 3) + 3; // 3-5 random stops
  try {
    const { w, h } = await page.evaluate(() => ({
      w: window.innerWidth  || 1366,
      h: window.innerHeight || 768,
    }));

    let curX = Math.floor(Math.random() * w);
    let curY = Math.floor(Math.random() * h);

    for (let s = 0; s < stops; s++) {
      const targetX = Math.floor(Math.random() * w);
      const targetY = Math.floor(Math.random() * h);
      const steps   = Math.floor(Math.random() * 5) + 8; // 8-12 intermediate points

      // Cubic bezier control points
      const cp1x = curX + (targetX - curX) * 0.3 + (Math.random() - 0.5) * 100;
      const cp1y = curY + (targetY - curY) * 0.3 + (Math.random() - 0.5) * 100;
      const cp2x = curX + (targetX - curX) * 0.7 + (Math.random() - 0.5) * 80;
      const cp2y = curY + (targetY - curY) * 0.7 + (Math.random() - 0.5) * 80;

      for (let i = 0; i <= steps; i++) {
        const t   = i / steps;
        const mt  = 1 - t;
        const x   = Math.round(mt*mt*mt*curX + 3*mt*mt*t*cp1x + 3*mt*t*t*cp2x + t*t*t*targetX);
        const y   = Math.round(mt*mt*mt*curY + 3*mt*mt*t*cp1y + 3*mt*t*t*cp2y + t*t*t*targetY);
        await page.mouse.move(x, y);
        await new Promise(r => setTimeout(r, Math.random() * 8 + 2));
      }

      curX = targetX;
      curY = targetY;
      await humanDelay(30, 120);
    }
  } catch (err) {
    logger.debug(`[AntiDetect] randomMouseMove skipped: ${err.message}`);
  }
}

/** @deprecated - alias kept for worker.js callers */
async function humanMouseMove(page, targetX, targetY, steps = 25) {
  try {
    const { innerWidth, innerHeight } = await page.evaluate(() => ({
      innerWidth: window.innerWidth, innerHeight: window.innerHeight,
    }));
    const startX = Math.floor(Math.random() * innerWidth  * 0.7) + 50;
    const startY = Math.floor(Math.random() * innerHeight * 0.7) + 50;
    const cp1x = startX + (targetX - startX) * 0.3 + (Math.random() - 0.5) * 100;
    const cp1y = startY + (targetY - startY) * 0.3 + (Math.random() - 0.5) * 100;
    const cp2x = startX + (targetX - startX) * 0.7 + (Math.random() - 0.5) * 80;
    const cp2y = startY + (targetY - startY) * 0.7 + (Math.random() - 0.5) * 80;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps; const mt = 1 - t;
      const x = Math.round(mt*mt*mt*startX + 3*mt*mt*t*cp1x + 3*mt*t*t*cp2x + t*t*t*targetX);
      const y = Math.round(mt*mt*mt*startY + 3*mt*mt*t*cp1y + 3*mt*t*t*cp2y + t*t*t*targetY);
      await page.mouse.move(x, y);
      await new Promise(r => setTimeout(r, Math.random() * 8 + 2));
    }
  } catch (err) {
    logger.debug('humanMouseMove skipped', { err: err.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Scrolling
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Scroll page by random 100-400px, weighted 70% down / 30% up.
 * @param {import('playwright').Page} page
 */
async function randomScroll(page) {
  try {
    const amount    = Math.floor(Math.random() * 300) + 100; // 100-400px
    const direction = Math.random() > 0.3 ? amount : -Math.floor(amount * 0.4);
    await page.mouse.wheel(0, direction);
    await humanDelay(300, 700);
  } catch (err) {
    logger.debug(`[AntiDetect] randomScroll skipped: ${err.message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Safe interactions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Wait for selector → scroll into view → random mouse move → delay → click.
 * @param {import('playwright').Page} page
 * @param {string} selector
 * @param {number} timeout
 * @returns {Promise<boolean>}
 */
async function safeClick(page, selector, timeout = 8000) {
  try {
    const el = await page.waitForSelector(selector, { timeout });
    await el.scrollIntoViewIfNeeded();
    await randomMouseMove(page);
    await humanDelay(100, 300);
    await el.click();
    return true;
  } catch (err) {
    logger.warn(`[AntiDetect] safeClick failed for "${selector}": ${err.message}`);
    return false;
  }
}

/**
 * Wait for selector → triple-click to select all → humanType the new text.
 * @param {import('playwright').Page} page
 * @param {string} selector
 * @param {string} text
 * @param {number} timeout
 * @returns {Promise<boolean>}
 */
async function safeType(page, selector, text, timeout = 8000) {
  try {
    await page.waitForSelector(selector, { timeout });
    await page.click(selector, { clickCount: 3 }); // triple-click selects all
    await humanDelay(80, 150);
    await humanType(page, selector, text);
    return true;
  } catch (err) {
    logger.warn(`[AntiDetect] safeType failed for "${selector}": ${err.message}`);
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Browser stealth patch
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Inject stealth overrides into a page via addInitScript.
 * Must be called before any navigation.
 * @param {import('playwright').Page} page
 */
async function patchBrowser(page) {
  await page.addInitScript(() => {
    // Remove the webdriver flag
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });

    // Fake a realistic plugins list
    Object.defineProperty(navigator, 'plugins', {
      get: () => {
        const arr = [
          { name: 'Chrome PDF Plugin',    filename: 'internal-pdf-viewer' },
          { name: 'Chrome PDF Viewer',    filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai' },
          { name: 'Native Client',        filename: 'internal-nacl-plugin' },
        ];
        arr.item   = i => arr[i];
        arr.namedItem = n => arr.find(p => p.name === n) || null;
        Object.setPrototypeOf(arr, PluginArray.prototype);
        return arr;
      },
    });

    // Override languages
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });

    // Fake chrome runtime to satisfy bot-detection checks
    window.chrome = { runtime: {} };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Extra helpers (kept from original — used by worker.js / formFiller.js)
// ─────────────────────────────────────────────────────────────────────────────

async function readingPause(page) {
  await randomScroll(page);
  await humanDelay(800, 2200);
}

async function backoff(attempt, baseMs = 2000, maxMs = 30000) {
  const delay = Math.min(baseMs * Math.pow(2, attempt), maxMs);
  const jitter = delay * 0.2 * Math.random();
  const total = Math.floor(delay + jitter);
  logger.debug(`[AntiDetect] Backoff: ${total}ms (attempt ${attempt})`);
  await new Promise(resolve => setTimeout(resolve, total));
}

async function highlightElement(page, target, label = '', color = '#ff4444', holdMs = 900) {
  try {
    const handle = typeof target.elementHandle === 'function'
      ? await target.elementHandle() : target;
    if (!handle) return;
    await page.evaluate(([el, col, lbl, hold]) => {
      if (!el) return;
      const ANIM_ID = '__aa_pulse_anim__';
      if (!document.getElementById(ANIM_ID)) {
        const style = document.createElement('style');
        style.id = ANIM_ID;
        style.textContent = `@keyframes __aa_pulse {
          0%  { box-shadow: 0 0 0 0  ${col}aa; outline-color: ${col}; }
          50% { box-shadow: 0 0 0 8px ${col}44; outline-color: ${col}cc; }
          100%{ box-shadow: 0 0 0 0  ${col}aa; outline-color: ${col}; }
        }`.replace(/\$\{col\}/g, col);
        document.head.appendChild(style);
      }
      const prevOutline = el.style.outline, prevBoxShadow = el.style.boxShadow,
            prevAnimation = el.style.animation, prevZIndex = el.style.zIndex;
      el.style.outline   = `3px solid ${col}`;
      el.style.boxShadow = `0 0 0 4px ${col}55`;
      el.style.animation = `__aa_pulse 0.6s ease-in-out infinite`;
      el.style.zIndex    = '9999';
      let badge = null;
      if (lbl) {
        badge = document.createElement('div');
        badge.textContent = lbl;
        Object.assign(badge.style, {
          position:'fixed', background:col, color:'#fff', fontSize:'11px',
          fontWeight:'700', fontFamily:'monospace', padding:'3px 8px',
          borderRadius:'4px', zIndex:'99999', pointerEvents:'none',
          boxShadow:'0 2px 8px rgba(0,0,0,0.4)',
        });
        const rect = el.getBoundingClientRect();
        badge.style.top  = `${Math.max(rect.top - 28, 4)}px`;
        badge.style.left = `${Math.min(rect.left, window.innerWidth - 200)}px`;
        document.body.appendChild(badge);
      }
      setTimeout(() => {
        el.style.outline = prevOutline; el.style.boxShadow = prevBoxShadow;
        el.style.animation = prevAnimation; el.style.zIndex = prevZIndex;
        if (badge && badge.parentNode) badge.parentNode.removeChild(badge);
      }, hold);
    }, [handle, color, label, holdMs]);
    await new Promise(r => setTimeout(r, Math.min(holdMs, 250)));
  } catch (err) {
    logger.debug(`[Highlight] skipped: ${err.message}`);
  }
}

async function highlightAndClick(page, locator, label = '', clickOpts = {}) {
  try {
    await highlightElement(page, locator, label || 'Click', '#ff4444', 500);
    await locator.click(clickOpts);
  } catch (err) {
    logger.debug(`[Highlight] click fallback: ${err.message}`);
    await locator.click(clickOpts);
  }
}

async function humanClick(page, selector, options = {}) {
  const element = await page.locator(selector).first();
  const box = await element.boundingBox();
  if (box) {
    const targetX = box.x + box.width / 2 + (Math.random() - 0.5) * 10;
    const targetY = box.y + box.height / 2 + (Math.random() - 0.5) * 5;
    await humanMouseMove(page, targetX, targetY);
    await humanDelay(80, 200);
  }
  await element.click(options);
}

// ─────────────────────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  // ── Spec API ──
  humanDelay,
  humanType,
  randomMouseMove,
  randomScroll,
  safeClick,
  safeType,
  patchBrowser,

  // ── Legacy aliases (worker.js / formFiller.js callers) ──
  randomDelay,        // alias for humanDelay
  humanMouseMove,
  humanClick,
  readingPause,
  backoff,
  highlightElement,
  highlightAndClick,
};
