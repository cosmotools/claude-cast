// Screenshots of cast_draw's marks on the test site, to look at after changing how marks are drawn or placed.
// Tests check where the marks are; these show how they look (legibility, overlaps).
//   npm run shots [output dir]
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

process.env.CAST_TEST_HEADLESS = '1';
const { Gateway } = await import('../dist/src/gateway.js');
const { startSite } = await import('../dist/test/helpers.js');

const out = resolve(process.argv[2] ?? join(tmpdir(), 'cast-ink-shots'));
mkdirSync(out, { recursive: true });
const dir = mkdtempSync(join(tmpdir(), 'cast-shots-'));
const site = await startSite();
const gateway = new Gateway();
const profile = { name: 'shots', dir: join(dir, 'chrome'), outputDir: join(dir, 'out') };
const text = r => r.content.map(c => c.text ?? '').join('\n');

const shot = async name => {
  // Strokes are animated in over about a second.
  await new Promise(r => setTimeout(r, 1500));
  const r = text(await gateway.call(profile, 'browser_run_code_unsafe', { code: 'async (page) => (await page.screenshot({ scale: "css" })).toString("base64")' }));
  writeFileSync(join(out, `${name}.png`), Buffer.from(JSON.parse(/### Result\n(.+)/.exec(r)[1]), 'base64'));
  console.log(join(out, `${name}.png`));
};
const scene = (query = '') => gateway.call(profile, 'browser_navigate', { url: `${site.url}/marks-scene${query}` });

try {
  await scene();
  const approve = /button "Approve" \[ref=(f\d+e\d+)\]/.exec(text(await gateway.call(profile, 'browser_snapshot', {})))[1];
  await gateway.draw(profile, [{ target: '#total', note: 'Should be $42' }]);
  await shot('1-note-beside-text');

  await gateway.draw(profile, [
    { target: '#total', shape: 'box', note: 'Итог неверный' },
    { target: '#gone', shape: 'underline', note: 'Underlined, with a note' },
    { target: approve, shape: 'arrow', note: 'In an iframe' },
  ]);
  await shot('2-shapes-latin-cyrillic');

  await gateway.draw(profile, [{ target: '#gone', note: 'A longer note that has to wrap onto a second line — and 日本 falls back' }]);
  await shot('3-long-note-fallback');

  await gateway.call(profile, 'browser_evaluate', { function: '() => document.getElementById("dialog").showModal()' });
  await gateway.draw(profile, [{ target: '#total', note: 'Above the dialog' }]);
  await shot('4-above-dialog');

  await scene();
  await gateway.draw(profile, [{ target: '#far', shape: 'box', note: 'Scrolled into view' }]);
  await shot('5-below-the-fold');

  await scene('?dark');
  await gateway.draw(profile, [
    { target: '#total', note: 'On a dark page' },
    { target: '#gone', shape: 'underline', note: 'Подчёркнуто' },
  ]);
  await shot('6-dark-page');

  await scene();
  await gateway.draw(profile, [
    { target: '#total', note: 'סך הכול שגוי' },
    { target: '#gone', note: 'Tổng tiền sai' },
    { target: '#wide', note: 'Ґанок · 合计应为四十二元，这一行太长了需要换行' },
  ]);
  await shot('7-languages');
} finally {
  await gateway.closeAll();
  await site.close();
  rmSync(dir, { recursive: true, force: true });
}
