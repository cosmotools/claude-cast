/// <reference lib="dom" />
// Runs inside the page, in cast's own isolated world (Page.createIsolatedWorld): page scripts share the
// DOM with it but not its variables, prototypes or listeners. Sent as `inkPage.toString()`, so it must not
// use anything from outside the function.
export function inkPage() {
    const scope = window;
    if (scope.__castInk)
        return;
    const NOTE_SIZE = 24;
    const NOTE_WIDTH = 300;
    const HALO = 'rgba(255,255,255,0.92)';
    const STROKE_MS = 380;
    let host;
    let canvas;
    let button;
    let drawn = [];
    let font = { em: 1, glyphs: {} };
    let color = '#e5383b';
    let shown = false;
    let erasedBy;
    let frame = 0;
    let lastKey = '';
    /** The page's modal dialog (or fullscreen element), looked up when one may have opened, not every frame. */
    let modal = null;
    const paths = new Map();
    const set = (el, styles) => {
        // CSSOM properties, not a <style> element or attribute: nothing for the page's CSP to block.
        for (const [k, v] of Object.entries(styles))
            el.style.setProperty(k, v, 'important');
    };
    const findModal = () => {
        try {
            return document.querySelector(':modal');
        }
        catch {
            return null;
        }
    };
    /** Checked every frame: a dialog removed while open changes no attribute. */
    const modalOpen = () => !!modal?.isConnected && modal.matches(':modal');
    // ---- the layer -------------------------------------------------------------------------------
    const build = () => {
        host = document.createElement('div');
        host.popover = 'manual';
        host.setAttribute('aria-hidden', 'true');
        set(host, {
            position: 'fixed', inset: '0', width: '100vw', height: '100vh', 'max-width': 'none', 'max-height': 'none',
            margin: '0', padding: '0', border: '0', background: 'transparent', overflow: 'visible', 'pointer-events': 'none',
            display: 'block', opacity: '1', visibility: 'visible', transform: 'none', filter: 'none', 'z-index': '2147483647',
        });
        const root = host.attachShadow({ mode: 'closed' });
        canvas = document.createElement('canvas');
        set(canvas, { position: 'fixed', left: '0', top: '0', width: '100vw', height: '100vh', 'pointer-events': 'none' });
        button = document.createElement('div');
        button.setAttribute('role', 'button');
        button.textContent = '';
        set(button, {
            position: 'fixed', right: '16px', bottom: '16px', padding: '6px 12px', background: '#fff', color,
            border: `1.5px solid ${color}`, 'border-radius': '999px', font: '13px/1.2 system-ui, sans-serif',
            'box-shadow': '0 1px 4px rgba(0,0,0,0.25)', cursor: 'pointer', 'pointer-events': 'auto', 'user-select': 'none',
        });
        root.append(canvas, button);
    };
    const attach = () => {
        if (!host)
            return;
        if (!host.isConnected)
            document.documentElement.appendChild(host);
        try {
            if (host.matches(':popover-open'))
                host.hidePopover();
            host.showPopover();
        }
        catch {
            // Not in a document that can show popovers; the layer still draws in place.
        }
    };
    // A page dialog or popover opened later goes above us in the top layer: come back on top.
    const raise = () => {
        modal = findModal();
        if (shown)
            attach();
    };
    const observer = new MutationObserver(raise);
    // ---- dismissal -------------------------------------------------------------------------------
    // cast erases the marks itself before Claude clicks or types, so input here is the person's.
    const onPointer = (e) => {
        // Events from the closed shadow root arrive retargeted to the host, and only the button takes pointer events.
        if (shown)
            stop(host && e.target === host ? 'button' : 'click');
    };
    const onKey = (e) => {
        // Esc also closes a page dialog; leave it to the page then.
        if (shown && e.key === 'Escape' && !findModal())
            stop('escape');
    };
    const onToggle = (e) => {
        if (e.target !== host && e.newState === 'open')
            raise();
    };
    const listeners = [
        [window, 'pointerdown', onPointer], [window, 'keydown', onKey], [document, 'toggle', onToggle], [document, 'fullscreenchange', raise],
    ];
    /** Listeners and the observer are on the page only while marks are shown. */
    const listen = (on) => {
        for (const [target, type, f] of listeners) {
            if (on)
                target.addEventListener(type, f, true);
            else
                target.removeEventListener(type, f, true);
        }
        if (on)
            observer.observe(document, { subtree: true, attributes: true, attributeFilter: ['open'] });
        else
            observer.disconnect();
    };
    const stop = (by) => {
        if (shown)
            listen(false);
        shown = false;
        erasedBy = by;
        cancelAnimationFrame(frame);
        host?.remove();
        host = canvas = button = undefined;
        drawn = [];
        modal = null;
    };
    // ---- geometry --------------------------------------------------------------------------------
    const random = (seed) => () => {
        seed = (seed * 16807) % 2147483647;
        return seed / 2147483647;
    };
    const overlap = (a, b) => Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
        * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
    const grow = (b, dx, dy = dx) => ({ x: b.x - dx, y: b.y - dy, width: b.width + 2 * dx, height: b.height + 2 * dy });
    /** What a mark covers: its element and the points of its strokes, grown by half a stroke with its halo. */
    const area = (d, b) => {
        let x0 = b.x, y0 = b.y, x1 = b.x + b.width, y1 = b.y + b.height;
        for (const [pts] of shapeStrokes(d, b)) {
            for (const [x, y] of pts) {
                x0 = Math.min(x0, x);
                y0 = Math.min(y0, y);
                x1 = Math.max(x1, x);
                y1 = Math.max(y1, y);
            }
        }
        return grow({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, 4);
    };
    /**
     * The element under the box, so the mark follows it when the page or a container scrolls. An element
     * inside an iframe anchors to the iframe; a box nothing matches stays at its place in the document.
     */
    const anchorFor = (b) => {
        const base = { dx: 0, dy: 0, dw: 0, dh: 0, scrollX, scrollY };
        const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
        if (cx < 0 || cy < 0 || cx > innerWidth || cy > innerHeight)
            return base;
        let best, bestScore = 0, container;
        for (const el of document.elementsFromPoint(cx, cy)) {
            if (el === host || el === document.documentElement || el === document.body)
                continue;
            const r = el.getBoundingClientRect();
            const inter = overlap(r, b);
            const score = inter / (r.width * r.height + b.width * b.height - inter || 1);
            if (score > bestScore)
                [best, bestScore] = [el, score];
            if (!container && r.x <= b.x + 2 && r.y <= b.y + 2 && r.right >= b.x + b.width - 2 && r.bottom >= b.y + b.height - 2)
                container = el;
        }
        const el = bestScore > 0.6 ? best : container;
        if (!el)
            return base;
        const r = el.getBoundingClientRect();
        return { el, dx: b.x - r.x, dy: b.y - r.y, dw: b.width - r.width, dh: b.height - r.height, scrollX: 0, scrollY: 0 };
    };
    /** Where the marked element is now, or undefined when it is gone or hidden. */
    const boxNow = (d) => {
        const a = d.anchor;
        if (!a.el)
            return { ...d.mark.box, x: d.mark.box.x - (scrollX - a.scrollX), y: d.mark.box.y - (scrollY - a.scrollY) };
        if (!a.el.isConnected)
            return undefined;
        const r = a.el.getBoundingClientRect();
        if (!r.width && !r.height)
            return undefined;
        return { x: r.x + a.dx, y: r.y + a.dy, width: r.width + a.dw, height: r.height + a.dh };
    };
    // ---- notes -----------------------------------------------------------------------------------
    const advance = (ch, size, ctx) => {
        const g = font.glyphs[ch];
        if (g)
            return (g[0] * size) / font.em;
        ctx.font = `${size * 0.8}px cursive`;
        return ctx.measureText(ch).width;
    };
    /** Hebrew, Arabic, Syriac, Thaana, N'Ko and their presentation forms. */
    const RTL = /[\u0590-\u07ff\u0860-\u08ff\ufb1d-\ufdff\ufe70-\ufeff]/;
    /**
     * Word-wrapped lines of runs; characters missing from the outlines fall back to a system font. A note
     * the outlines do not cover well (right to left, most characters missing, or a word mixing both) is
     * drawn whole in the system font: the browser orders, joins and shapes it, and one note has one font.
     */
    const layout = (text, ctx) => {
        const size = NOTE_SIZE;
        const missing = (ch) => !font.glyphs[ch];
        const chars = [...text].filter(ch => ch.trim());
        const rtl = RTL.test(text);
        const whole = rtl || chars.filter(missing).length * 2 > chars.length
            || text.split(/\s+/).some(w => [...w].some(missing) && [...w].some(ch => !missing(ch)));
        const measure = (word) => {
            if (!whole)
                return [...word].reduce((s, ch) => s + advance(ch, size, ctx), 0);
            ctx.font = `${size * 0.8}px cursive`;
            return ctx.measureText(word).width;
        };
        const lines = [];
        let width = 0;
        for (const para of text.split('\n')) {
            let line = [], x = 0;
            // A word wider than a note breaks between characters: Chinese and Japanese have no spaces.
            const words = para.split(/(\s+)/).flatMap(w => measure(w) > NOTE_WIDTH ? [...w] : [w]);
            for (const word of words) {
                const w = measure(word);
                if (x + w > NOTE_WIDTH && x > 0 && word.trim()) {
                    lines.push(line);
                    width = Math.max(width, x);
                    line = [];
                    x = 0;
                }
                if (!line.length && !word.trim())
                    continue;
                if (whole) {
                    if (line.length)
                        line[0].text += word;
                    else
                        line.push({ text: word, glyph: false, x: 0 });
                    x += w;
                    continue;
                }
                for (const ch of word) {
                    const glyph = !!font.glyphs[ch];
                    const last = line[line.length - 1];
                    if (last && last.glyph === glyph)
                        last.text += ch;
                    else
                        line.push({ text: ch, glyph, x });
                    x += advance(ch, size, ctx);
                }
            }
            lines.push(line);
            width = Math.max(width, x);
        }
        return { lines, width, height: lines.length * size * 1.1, size, ox: 0, oy: 0, tilt: 0, rtl };
    };
    /** The outlines are SVG path data. */
    const glyphPath = (ch) => {
        let p = paths.get(ch);
        if (!p)
            paths.set(ch, p = new Path2D(font.glyphs[ch][1]));
        return p;
    };
    const drawLabel = (ctx, l, x, y, alpha) => {
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.translate(x, y);
        ctx.rotate(l.tilt);
        const k = l.size / font.em;
        l.lines.forEach((line, i) => {
            const base = (i + 0.8) * l.size * 1.1;
            for (const run of line) {
                if (run.glyph) {
                    let pen = run.x;
                    for (const ch of run.text) {
                        ctx.save();
                        ctx.translate(pen, base);
                        ctx.scale(k, k);
                        const p = glyphPath(ch);
                        // A white halo first, so the note reads over any content.
                        ctx.lineJoin = 'round';
                        ctx.strokeStyle = HALO;
                        ctx.lineWidth = font.em * 0.16;
                        ctx.stroke(p);
                        ctx.fillStyle = color;
                        ctx.fill(p);
                        ctx.restore();
                        pen += advance(ch, l.size, ctx);
                    }
                }
                else {
                    ctx.font = `${l.size * 0.8}px cursive`;
                    // A right-to-left line is drawn from the note's right edge.
                    ctx.direction = l.rtl ? 'rtl' : 'ltr';
                    ctx.textAlign = l.rtl ? 'right' : 'left';
                    const x = l.rtl ? l.width - run.x : run.x;
                    ctx.lineJoin = 'round';
                    ctx.strokeStyle = HALO;
                    ctx.lineWidth = 4;
                    ctx.strokeText(run.text, x, base);
                    ctx.fillStyle = color;
                    ctx.fillText(run.text, x, base);
                }
            }
        });
        ctx.restore();
    };
    const CONTROLS = 'a, button, input, select, textarea, label, img, svg, video, canvas, iframe, [role], [contenteditable]';
    const inside = (x, y, r) => x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height;
    /**
     * Boxes of the text and controls in view, for points on a modal dialog's backdrop: hit testing does not
     * reach the page under it (the page is inert), but the person still sees it there, dimmed.
     */
    let dimmed;
    const dimmedBoxes = () => {
        if (dimmed)
            return dimmed;
        dimmed = [];
        const seen = (r) => r.width && r.height && r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight;
        for (const el of document.querySelectorAll(CONTROLS)) {
            const r = el.getBoundingClientRect();
            if (seen(r))
                dimmed.push(r);
        }
        const walker = document.createTreeWalker(document.body ?? document.documentElement, NodeFilter.SHOW_TEXT);
        const range = document.createRange();
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            if (!node.textContent?.trim())
                continue;
            range.selectNodeContents(node);
            for (const r of range.getClientRects())
                if (seen(r))
                    dimmed.push(r);
        }
        return dimmed;
    };
    /** Is there text or a control at this point of the page? Notes avoid covering them. */
    const busy = (x, y) => {
        const el = document.elementFromPoint(x, y);
        if (!el || el === host || el === document.documentElement || el === document.body)
            return false;
        if (el instanceof HTMLDialogElement && el.matches(':modal') && !inside(x, y, el.getBoundingClientRect())) {
            return dimmedBoxes().some(r => inside(x, y, r));
        }
        if (el.matches(CONTROLS))
            return true;
        for (const node of el.childNodes) {
            if (node.nodeType !== Node.TEXT_NODE || !node.textContent?.trim())
                continue;
            const range = document.createRange();
            range.selectNodeContents(node);
            for (const r of range.getClientRects())
                if (inside(x, y, r))
                    return true;
        }
        return false;
    };
    /**
     * Picks a place for each note next to its mark: inside the window, away from other marks and notes,
     * and covering as little of the page's text and controls as it can. A far place gets an arrow.
     */
    const place = (items) => {
        dimmed = undefined;
        const view = { x: 4, y: 4, width: innerWidth - 8, height: innerHeight - 8 };
        const taken = items.map(d => area(d, d.mark.box));
        const own = button?.getBoundingClientRect();
        if (own?.width)
            taken.push(grow(own, 8));
        for (const d of items) {
            const l = d.label;
            if (!l)
                continue;
            const b = d.mark.box;
            const o = area(d, b);
            const w = l.width, h = l.height;
            const spots = [];
            // An arrow needs room to be seen.
            for (const gap of d.mark.shape === 'arrow' ? [56, 110, 160] : [10, 56, 110]) {
                const cy = o.y + o.height / 2 - h / 2, cx = o.x + o.width / 2 - w / 2;
                spots.push([o.x + o.width + gap, cy, gap], [o.x - gap - w, cy, gap], [Math.max(o.x, cx), o.y + o.height + gap, gap], [Math.max(o.x, cx), o.y - gap - h, gap], [o.x + o.width + gap * 0.7, o.y - gap * 0.7 - h, gap], [o.x + o.width + gap * 0.7, o.y + o.height + gap * 0.7, gap], [o.x - gap * 0.7 - w, o.y - gap * 0.7 - h, gap], [o.x - gap * 0.7 - w, o.y + o.height + gap * 0.7, gap]);
            }
            // A spot's cost, lowest wins. The weights were tuned by eye on the scenes of `npm run shots`:
            // - 60 per px² outside the window: a note cut off is unreadable, so this outweighs the rest;
            // - 1500 per point where the arrow crosses text or another mark (7 points along it): a crossed arrow
            //   is hard to follow;
            // - 25 per px² over another mark, its note or the button: notes must not cover each other;
            // - up to 6 per px² over the page's text and controls (the share of sampled points that hit some):
            //   covering the page is allowed when there is no free room;
            // - 3 per px of distance: nearer is better when all else is equal.
            let best = spots[0], bestScore = Infinity;
            for (const s of spots) {
                const r = { x: s[0], y: s[1], width: w, height: h };
                const area = w * h;
                let score = s[2] * 3 + (area - overlap(r, view)) * 60;
                for (const t of taken)
                    score += overlap(r, t) * 25;
                if (score >= bestScore)
                    continue;
                // Points over the note and a margin around it, edges included: the tilt, the halo and glyphs wider
                // than their advance reach past the box, and a note touching a line of text is hard to read.
                let hits = 0;
                for (let i = 0; i <= 6; i++)
                    for (let j = 0; j <= 2; j++)
                        if (busy(r.x - 8 + ((w + 16) * i) / 6, r.y - 8 + ((h + 16) * j) / 2))
                            hits++;
                score += (hits / 21) * area * 6;
                if (s[2] > 10) {
                    // The arrow should not cross text, other marks or their notes either.
                    const ax = r.x + w / 2, ay = r.y + h / 2, bx = b.x + b.width / 2, by = b.y + b.height / 2;
                    let crossed = 0;
                    for (let i = 1; i < 8; i++) {
                        const x = ax + ((bx - ax) * i) / 8, y = ay + ((by - ay) * i) / 8;
                        if (!inside(x, y, o) && (busy(x, y) || taken.some(t => inside(x, y, t))))
                            crossed++;
                    }
                    score += crossed * 1500;
                }
                if (score < bestScore)
                    [best, bestScore] = [s, score];
            }
            l.ox = best[0] - b.x;
            l.oy = best[1] - b.y;
            d.arrow = d.mark.shape === 'arrow' || best[2] > 10;
            taken.push(grow({ x: best[0], y: best[1], width: w, height: h }, 4));
        }
    };
    const stroke = (ctx, pts, width, progress) => {
        const n = Math.max(2, Math.ceil(pts.length * progress));
        ctx.beginPath();
        pts.slice(0, n).forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
        ctx.lineWidth = width + 3;
        ctx.strokeStyle = HALO;
        ctx.globalAlpha = 0.5;
        ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.lineWidth = width;
        ctx.strokeStyle = color;
        ctx.stroke();
    };
    const shapeStrokes = (d, b) => {
        const r = d.rnd;
        const j = (i, amp) => (r[i % r.length] - 0.5) * 2 * amp;
        const out = [];
        if (d.mark.shape === 'circle') {
            const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
            const rx = b.width / 2 * 1.25 + 10, ry = b.height / 2 * 1.3 + 10;
            for (let pass = 0; pass < 2; pass++) {
                const pts = [];
                const start = r[pass] * 6.28, turn = 6.28 + 0.45 + r[pass + 2] * 0.4;
                for (let i = 0; i <= 50; i++) {
                    const t = i / 50, a = start + t * turn, k = 1 + j(i + pass * 50, 0.035) + t * 0.05;
                    pts.push([cx + Math.cos(a) * rx * k, cy + Math.sin(a) * ry * k]);
                }
                out.push([pts, 3 - pass]);
            }
        }
        else if (d.mark.shape === 'box') {
            const o = grow(b, 7);
            const corners = [[o.x, o.y], [o.x + o.width, o.y], [o.x + o.width, o.y + o.height], [o.x, o.y + o.height]];
            const pts = [];
            for (let s = 0; s < 4; s++) {
                const [ax, ay] = corners[s], [bx, by] = corners[(s + 1) % 4];
                for (let i = 0; i <= 12; i++) {
                    // Each side starts a little before its corner and runs a little past the next one, like a pen.
                    const t = -0.04 + (i / 12) * 1.08;
                    pts.push([ax + (bx - ax) * t + j(s * 13 + i, 1.2), ay + (by - ay) * t + j(s * 13 + i + 7, 1.2)]);
                }
            }
            out.push([pts, 2.6]);
        }
        else if (d.mark.shape === 'underline') {
            const pts = [];
            const y = b.y + b.height + 4;
            const steps = Math.max(8, Math.round(b.width / 5));
            for (let i = 0; i <= steps; i++) {
                const x = b.x - 4 + ((b.width + 10) * i) / steps;
                pts.push([x, y + Math.sin(x / 6) * 2 + j(i, 0.8)]);
            }
            out.push([pts, 2.6]);
        }
        return out;
    };
    /** A curved arrow from the note to the nearest point of the mark. */
    const arrowStrokes = (d, b, l) => {
        const o = area(d, b);
        const lc = [l.x + l.width / 2, l.y + l.height / 2];
        const tx = Math.min(Math.max(lc[0], o.x), o.x + o.width), ty = Math.min(Math.max(lc[1], o.y), o.y + o.height);
        // Leave from the note's edge facing the target.
        const fx = Math.min(Math.max(tx, l.x - 4), l.x + l.width + 4), fy = tx >= l.x - 4 && tx <= l.x + l.width + 4
            ? (ty < l.y ? l.y - 6 : l.y + l.height + 6) : Math.min(Math.max(ty, l.y), l.y + l.height);
        const len = Math.hypot(tx - fx, ty - fy);
        if (len < 12)
            return [];
        const nx = -(ty - fy) / len, ny = (tx - fx) / len;
        const mx = (fx + tx) / 2 + nx * len * d.bend, my = (fy + ty) / 2 + ny * len * d.bend;
        const pts = [];
        for (let i = 0; i <= 24; i++) {
            const t = i / 24;
            pts.push([(1 - t) ** 2 * fx + 2 * (1 - t) * t * mx + t * t * tx, (1 - t) ** 2 * fy + 2 * (1 - t) * t * my + t * t * ty]);
        }
        const [px, py] = pts[pts.length - 4];
        const a = Math.atan2(ty - py, tx - px);
        const head = [[tx - 13 * Math.cos(a - 0.45), ty - 13 * Math.sin(a - 0.45)], [tx, ty], [tx - 13 * Math.cos(a + 0.45), ty - 13 * Math.sin(a + 0.45)]];
        return [[pts, 2.6], [head, 2.6]];
    };
    // ---- drawing loop ----------------------------------------------------------------------------
    const render = (now) => {
        if (!shown || !canvas || !button)
            return;
        if (!host?.isConnected)
            attach();
        button.style.setProperty('display', modalOpen() ? 'none' : 'block', 'important');
        const boxes = drawn.map(boxNow);
        if (drawn.length && boxes.every(b => !b)) {
            // Every marked element is gone: the page changed under the marks.
            stop('page');
            return;
        }
        const dpr = devicePixelRatio || 1;
        const animating = drawn.some(d => now - d.start < STROKE_MS * 2);
        const key = `${innerWidth}x${innerHeight}@${dpr}:` + boxes.map(b => b ? `${b.x | 0},${b.y | 0},${b.width | 0},${b.height | 0}` : '-').join(';');
        if (key !== lastKey || animating) {
            lastKey = key;
            if (canvas.width !== Math.round(innerWidth * dpr) || canvas.height !== Math.round(innerHeight * dpr)) {
                canvas.width = Math.round(innerWidth * dpr);
                canvas.height = Math.round(innerHeight * dpr);
            }
            const ctx = canvas.getContext('2d');
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.clearRect(0, 0, innerWidth, innerHeight);
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            drawn.forEach((d, i) => {
                const b = boxes[i];
                if (!b)
                    return;
                const p = Math.min(1, Math.max(0, (now - d.start) / STROKE_MS));
                if (p <= 0)
                    return;
                for (const [pts, w] of shapeStrokes(d, b))
                    stroke(ctx, pts, w, p);
                if (!d.label) {
                    if (d.mark.shape === 'arrow') {
                        // An arrow without a note comes from the upper left.
                        const from = { x: b.x - 70, y: b.y - 50, width: 1, height: 1 };
                        for (const [pts, w] of arrowStrokes(d, b, from))
                            stroke(ctx, pts, w, p);
                    }
                    return;
                }
                const l = { x: b.x + d.label.ox, y: b.y + d.label.oy, width: d.label.width, height: d.label.height };
                if (d.arrow)
                    for (const [pts, w] of arrowStrokes(d, b, l))
                        stroke(ctx, pts, w, p);
                drawLabel(ctx, d.label, l.x, l.y, p);
            });
        }
        frame = requestAnimationFrame(render);
    };
    const show = (marks, f, options) => {
        stop();
        font = f;
        color = options.color;
        paths.clear();
        build();
        button.textContent = options.button;
        attach();
        const ctx = canvas.getContext('2d');
        const now = performance.now();
        drawn = marks.map((mark, i) => {
            const next = random(i * 7919 + 17);
            const rnd = Array.from({ length: 120 }, next);
            const label = mark.note?.trim() ? layout(mark.note.trim(), ctx) : undefined;
            if (label)
                label.tilt = (rnd[5] - 0.6) * 0.06;
            return { mark, anchor: anchorFor(mark.box), label, rnd, arrow: false, bend: (rnd[9] - 0.5) * 0.5, start: now + i * 220 };
        });
        modal = findModal();
        place(drawn);
        shown = true;
        listen(true);
        erasedBy = undefined;
        lastKey = '';
        frame = requestAnimationFrame(render);
        return drawn.length;
    };
    scope.__castInk = {
        show,
        erase: () => stop(),
        state: () => ({ shown, ...(erasedBy ? { erasedBy } : {}) }),
    };
}
