// Clicks the studio through its visible controls: pick a source, type, Done,
// download, share, open the link. Gutenberg is stubbed so the run is offline.
import { test, expect } from '@playwright/test';

const BOOK = { id: 2701, title: 'Moby Dick; Or, The Whale', author: 'Herman Melville',
  text: 'Call me Ishmael. Some years ago—never mind how long precisely—' };

test.beforeEach(async ({ page }) => {
  await page.route('**/api/gutenberg/search?*', r => r.fulfill({ json: { results: [
    { id: BOOK.id, title: BOOK.title, author: BOOK.author }] } }));
  await page.route('**/api/gutenberg/text/2701', r => r.fulfill({ json: BOOK }));
});

async function typeSession(page) {
  const ta = page.getByPlaceholder('Type here. Recording starts with your first key.');
  await ta.click();
  await page.keyboard.type('Call me Ishmal', { delay: 40 });
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  await page.keyboard.type('ael.', { delay: 40 });
  await expect(page.getByRole('button', { name: 'Done' })).toBeEnabled();
  return ta;
}

test('find a Gutenberg book, type, Done plays it back', async ({ page }) => {
  await page.goto('/');
  await page.getByPlaceholder('title, author, or a gutenberg.org link').fill('moby');
  await page.getByRole('button', { name: 'Find' }).click();
  await page.getByRole('button', { name: /Moby Dick/ }).click();
  await expect(page.locator('#st-reftext')).toContainText('Call me Ishmael.');
  await expect(page.locator('#st-reftitle')).toHaveText('Moby Dick; Or, The Whale — Herman Melville');

  const ta = await typeSession(page);
  await expect(ta).toHaveValue('Call me Ishmael.');
  await page.getByRole('button', { name: 'Done' }).click();

  await expect(page.locator('#st-play')).toBeVisible();
  await expect(page.locator('#stats')).toContainText('keystrokes');
  await expect(page.locator('#play')).toHaveText(/pause/);           // playback started from the tap
  // diagnostic: the replay rebuilds exactly what was typed
  expect(await page.evaluate(() => stateAt(Infinity).text)).toBe('Call me Ishmael.');
});

test('a long source pages 500 words at a time', async ({ page }) => {
  const long = Array.from({ length: 1200 }, (_, i) => 'w' + (i + 1)).join(' ');
  await page.route('**/api/gutenberg/text/1342', r => r.fulfill({ json: { id: 1342, title: 'Long', author: '', text: long } }));
  await page.goto('/');
  await page.getByPlaceholder('title, author, or a gutenberg.org link').fill('1342');
  await page.getByRole('button', { name: 'Find' }).click();

  const text = page.locator('#st-reftext'), pos = page.locator('#st-refpos');
  const back = page.getByRole('button', { name: '‹ Back' }), next = page.getByRole('button', { name: 'Next ›' });
  await expect(pos).toHaveText('words 1–500 of 1,200');
  await expect(text).toHaveText(/^w1 .* w500 $/);
  await expect(back).toBeDisabled();
  await next.click();
  await expect(pos).toHaveText('words 501–1,000 of 1,200');
  await expect(text).toHaveText(/^w501 /);
  await next.click();
  await expect(pos).toHaveText('words 1,001–1,200 of 1,200');
  await expect(next).toBeDisabled();
  await back.click();
  await expect(pos).toHaveText('words 501–1,000 of 1,200');
});

test('a short source has no paging', async ({ page }) => {
  await page.goto('/');
  await page.getByPlaceholder('title, author, or a gutenberg.org link').fill('2701');
  await page.getByRole('button', { name: 'Find' }).click();
  await expect(page.locator('#st-reftext')).toContainText('Call me Ishmael.');
  await expect(page.locator('#st-refnav')).toBeHidden();
});

test('paste a passage as the source', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('tab', { name: 'Paste' }).click();
  await page.getByPlaceholder('Paste a passage, or your own draft').fill('My own draft.');
  await page.getByRole('button', { name: 'Use this text' }).click();
  await expect(page.locator('#st-reftext')).toHaveText('My own draft.');
  await page.getByRole('button', { name: '×' }).click();
  await expect(page.locator('#st-ref')).toBeHidden();
});

test('download JSONL and WAV', async ({ page }) => {
  await page.goto('/');
  await typeSession(page);
  await page.getByRole('button', { name: 'Done' }).click();

  const [jd] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '⬇ JSONL' }).click()]);
  expect(jd.suggestedFilename()).toMatch(/^writing-.*\.jsonl$/);
  const lines = (await (await jd.createReadStream()).toArray()).join('').trim().split('\n').map(JSON.parse);
  expect(lines[0].type).toBe('editstart');
  expect(lines.every(e => typeof e.t === 'number' && e.section === '1')).toBe(true);

  const [wd] = await Promise.all([page.waitForEvent('download', { timeout: 60_000 }),
    page.getByRole('button', { name: '⬇ WAV' }).click()]);
  expect(wd.suggestedFilename()).toMatch(/\.wav$/);
  expect(await page.evaluate(() => CONFIG.music.deleteFall && CONFIG.music.swell.on && CONFIG.music.fx.toneMove > 0)).toBe(true);
});

test('publish a share link and open it', async ({ page, context }) => {
  await page.goto('/');
  await page.getByPlaceholder('title, author, or a gutenberg.org link').fill('https://www.gutenberg.org/ebooks/2701');
  await page.getByRole('button', { name: 'Find' }).click();
  await expect(page.locator('#st-reftitle')).toContainText('Moby Dick');
  await typeSession(page);
  await page.getByRole('button', { name: 'Done' }).click();

  await page.getByRole('button', { name: 'Share link' }).click();
  await expect(page.locator('#st-sharemsg')).toContainText('publishes what you typed');
  await page.getByRole('button', { name: 'Publish' }).click();
  await expect(page.locator('#st-sharemsg')).toHaveText('Published. Anyone with this link can play it.');
  const url = await page.locator('#st-shareurl').inputValue();
  expect(url).toMatch(/\/s\/[A-Za-z0-9]{10}$/);

  const other = await context.newPage();
  await other.goto(url);
  await expect(other.locator('#st-sharedfrom')).toContainText('Typed from Moby Dick; Or, The Whale');
  await expect(other.locator('#st-write')).toBeHidden();
  await expect(other.locator('#stats')).toContainText('keystrokes');
  await other.locator('#play').click();
  await expect(other.locator('#play')).toHaveText(/pause/);
  expect(await other.evaluate(() => stateAt(Infinity).text)).toBe('Call me Ishmael.');
});

test('a bad share link says so', async ({ page }) => {
  await page.goto('/s/zzzzzzzzzz');
  await expect(page.locator('#st-sharedfrom')).toContainText('does not open a piece');
});

test('phone layout: no sideways scroll, dials in a drawer', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'phone only');
  await page.goto('/');
  await typeSession(page);
  await page.getByRole('button', { name: 'Done' }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.locator('#mscale')).toBeHidden();
  await page.getByRole('button', { name: 'Sound ▾' }).click();
  await expect(page.locator('#mscale')).toBeVisible();
});

// ------------------------------------------------------------ sound -------
async function openDials(page, isMobile) {
  if (isMobile) await page.getByRole('button', { name: 'Sound ▾' }).click();
}
async function typeAndDone(page, keys) {
  await page.goto('/');
  await page.getByPlaceholder('Type here. Recording starts with your first key.').click();
  for (const k of keys) {
    if (typeof k === 'number') await page.waitForTimeout(k);
    else if (k === 'Enter' || k === 'Backspace') await page.keyboard.press(k);
    else if (k.slow) await page.keyboard.type(k.slow, { delay: 650 });
    else await page.keyboard.type(k, { delay: 40 });
  }
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.locator('#st-play')).toBeVisible();
}

test('tone knob: stops, tap and keys jump straight to a value', async ({ page, isMobile }) => {
  await typeAndDone(page, ['Hello there.']);
  await openDials(page, isMobile);
  const knob = page.locator('#ktone');
  await page.getByRole('button', { name: 'bright' }).click();
  expect(await page.evaluate(() => CONFIG.music.fx.tone)).toBe(4800);
  await expect(knob).toHaveAttribute('aria-valuenow', '4800');
  await expect(page.getByRole('button', { name: 'bright' })).toHaveAttribute('aria-pressed', 'true');
  const box = await knob.boundingBox();
  await knob.click({ position: { x: box.width * 0.8, y: box.height / 2 } });   // 3 o'clock = 90°
  const tapped = +(await knob.getAttribute('aria-valuenow'));
  expect(tapped).toBeGreaterThan(6500);                                     // ≈6750 at exactly 90°
  expect(tapped).toBeLessThan(7000);
  await knob.press('ArrowDown');
  await expect(knob).toHaveAttribute('aria-valuenow', String(tapped - 200));
});

test('each piece gets its own sound; reroll changes it; a share link keeps it', async ({ page, context }) => {
  await typeAndDone(page, ['Call me Ishmael.']);
  const same = () => page.evaluate(n => JSON.stringify(CONFIG.music) === JSON.stringify(rollMusic(META.session, n, STUDIO_ON)), 0);
  expect(await same()).toBe(true);
  const first = await page.evaluate(() => JSON.stringify(CONFIG.music));
  await page.getByRole('button', { name: 'Another sound' }).click();
  const m1 = await page.evaluate(() => CONFIG.music);
  expect(m1.roll).toBe(1);
  expect(JSON.stringify(m1)).not.toBe(first);
  expect(await page.evaluate(() => JSON.stringify(CONFIG.music) === JSON.stringify(rollMusic(META.session, 1, STUDIO_ON)))).toBe(true);
  await expect(page.locator(`#st-sounds button[data-sound="${m1.sound}"]`)).toHaveAttribute('aria-pressed', 'true');

  await page.getByRole('button', { name: 'Share link' }).click();
  await page.getByRole('button', { name: 'Publish' }).click();
  await expect(page.locator('#st-sharemsg')).toHaveText('Published. Anyone with this link can play it.');
  const other = await context.newPage();
  await other.goto(await page.locator('#st-shareurl').inputValue());
  await expect(other.locator('#stats')).toContainText('keystrokes');
  const shared = await other.evaluate(() => CONFIG.music);
  for (const k of ['sound', 'roll', 'bpm', 'rootNote', 'paragraphKey', 'instrument', 'scale', 'deleteFall'])
    expect(shared[k], k).toEqual(m1[k]);
  expect(shared.fx.tone).toBe(m1.fx.tone);
});

test('a named sound sets instrument and scale together', async ({ page }) => {
  await typeAndDone(page, ['Hello.']);
  await page.locator('#st-sounds button[data-sound="night"]').click();
  const m = await page.evaluate(() => CONFIG.music);
  expect([m.sound, m.instrument, m.scale, m.deleteFall]).toEqual(['night', 'warm', 'minor', true]);
  await expect(page.locator('#minst')).toHaveValue('warm');
  await expect(page.locator('#st-sounds button[data-sound="night"]')).toHaveAttribute('aria-pressed', 'true');
});

test('a new paragraph moves the key', async ({ page }) => {
  await typeAndDone(page, ['ab', 'Enter', 'ab']);
  const r = await page.evaluate(() => {
    const as = RP.steps.filter(s => isIns(s.e) && s.e.data === 'a');
    const n = as.map(s => noteEventsFor(s.e, s).find(x => x.kind === 'note'));
    return { text: stateAt(Infinity).text, pk: CONFIG.music.paragraphKey, degs: n.map(x => x.deg), ratio: n[1].hz / n[0].hz, paras: as.map(s => s.para) };
  });
  expect(r.text).toBe('ab\nab');
  expect(r.paras).toEqual([0, 1]);
  expect(r.degs[0]).toBe(r.degs[1]);
  const fold = ((r.pk % 12) + 12) % 12 > 6 ? (r.pk % 12) - 12 : r.pk % 12;
  expect(r.ratio).toBeCloseTo(Math.pow(2, fold / 12), 6);
});

test('deletions fall through the letters erased', async ({ page }) => {
  await typeAndDone(page, ['Call me Ishmal', 'Backspace', 'Backspace', 'ael.']);
  const falls = await page.evaluate(() => RP.steps.filter(s => isDel(s.e))
    .map(s => noteEventsFor(s.e, s)).map(ns => ns.map(n => [n.kind, n.ch, n.hz])));
  expect(falls.map(f => f[0].slice(0, 2))).toEqual([['fall', 'l'], ['fall', 'a']]);
  expect(falls[1][0][2]).toBeLessThan(falls[0][0][2]);
});

test('a long pause swells', async ({ page }) => {
  await typeAndDone(page, ['ab', 2300, 'c']);
  const r = await page.evaluate(() => {
    const b = RP.steps.find(s => isIns(s.e) && s.e.data === 'b'), c = RP.steps.find(s => isIns(s.e) && s.e.data === 'c');
    const M = CONFIG.music, slot = 60000 / M.bpm / M.subdiv;
    return { kinds: noteEventsFor(b.e, b).map(n => n.kind), gap: c.vt - b.vt, slot, marks: document.querySelectorAll('.swellmk').length };
  });
  expect(r.kinds).toContain('swell');
  expect(r.gap).toBeGreaterThan(r.slot * 1.5);
  expect(r.marks).toBeGreaterThan(0);
});

test('typing speed moves the tone, drawn per note', async ({ page }) => {
  await typeAndDone(page, ['quick bursts', { slow: 'slowly' }]);
  const offs = await page.evaluate(() => [...document.querySelectorAll('.tonmove')].map(r => r.style.getPropertyValue('--tone-off')));
  expect(offs.length).toBeGreaterThan(5);
  expect(new Set(offs).size).toBeGreaterThan(2);
  expect(await page.evaluate(() => RP.steps.some(s => s.bright > 0) && RP.steps.some(s => s.bright < 0))).toBe(true);
});
