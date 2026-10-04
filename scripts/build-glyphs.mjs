// Builds assets/handwriting.json: glyph outlines of the Caveat font (SIL OFL 1.1, assets/OFL.txt) that
// cast_draw writes notes with. Notes are drawn as canvas paths, so no font is loaded into the page
// (its Content-Security-Policy could block it). Run only when changing the character set:
//   mkdir /tmp/glyphs && cd /tmp/glyphs && npm install opentype.js@2 @fontsource/caveat@5
//   node scripts/build-glyphs.mjs /tmp/glyphs
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const require = createRequire(join(process.argv[2] ?? '.', 'package.json'));
const opentype = require('opentype.js');
const files = join(require.resolve('@fontsource/caveat/package.json'), '..', 'files');
const fonts = ['latin', 'latin-ext', 'cyrillic', 'cyrillic-ext'].map(s => opentype.parse(readFileSync(join(files, `caveat-${s}-600-normal.woff`)).buffer));

const chars = [];
for (let c = 0x20; c < 0x7f; c++) chars.push(String.fromCharCode(c));
for (let c = 0xa0; c <= 0x17f; c++) chars.push(String.fromCharCode(c));
for (let c = 0x400; c <= 0x45f; c++) chars.push(String.fromCharCode(c));
chars.push('Ґ', 'ґ');
chars.push('—', '–', '‘', '’', '“', '”', '„', '«', '»', '…', '•', '№', '€');

// 1/8 of the font's units: 125 per em, plenty for notes of 16-40 px.
const scale = 8;
const em = fonts[0].unitsPerEm / scale;
const glyphs = {};
for (const ch of chars) {
  const font = fonts.find(f => f.charToGlyphIndex(ch) > 0);
  if (!font) continue;
  const g = font.charToGlyph(ch);
  let px = 0, py = 0, sx = 0, sy = 0;
  // SVG path data with relative integer coordinates: "m dx dy", "l dx dy", "q dx1 dy1 dx dy", "c …", "z".
  const d = g.getPath(0, 0, em).commands.map(c => {
    if (c.type === 'Z') {
      // As in SVG, the pen goes back to where the contour started.
      [px, py] = [sx, sy];
      return 'z';
    }
    const rel = (x, y) => [Math.round(x) - px, Math.round(y) - py];
    const pts = [];
    if (c.type === 'Q' || c.type === 'C') pts.push(...rel(c.x1, c.y1));
    if (c.type === 'C') pts.push(...rel(c.x2, c.y2));
    pts.push(...rel(c.x, c.y));
    px = Math.round(c.x);
    py = Math.round(c.y);
    if (c.type === 'M') [sx, sy] = [px, py];
    return c.type.toLowerCase() + pts.join(' ').replace(/ -/g, '-');
  }).join('');
  glyphs[ch] = [Math.round(g.advanceWidth / scale), d];
}
writeFileSync(new URL('../assets/handwriting.json', import.meta.url), JSON.stringify({ font: 'Caveat SemiBold', em, glyphs }));
console.log(`${Object.keys(glyphs).length} glyphs`);
