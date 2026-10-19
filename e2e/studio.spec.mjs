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
