(function () {
  'use strict';
  const V = window.TrayVision, G = window.TrayGeom;
  const $ = id => document.getElementById(id);
  const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const BED = 256; // P1S build plate, mm
  const PPM = 4;   // rectified raster, px per mm

  let M = null; // manifold wasm
  const S = {
    tab: 'photo',
    img: null,          // {canvas, w, h, f35exif}
    quad: null, paperMode: 'auto', paper: null, dims: null, Hm: null, pose: null, aspect: null,
    f35: 26, sens: 0.28, minArea: 150,
    tools: [], sel: null, nextId: 1,
    paint: [], pmode: 'corners', brush: 12,
    tray: { mode: 'hug', W: 200, D: 120, H: 30, floor: 2, wall: 8, web: 3, clearance: 0.6, smooth: 1.5, outerChamfer: 0.8, lipChamfer: 0.8, floorChamfer: 0.4 },
    name: 'kit-tray',
    build: null,
  };

  // ---------------------------------------------------------------- utils
  const deg = r => r * 180 / Math.PI, rad = d => d * Math.PI / 180;
  const fmt = (v, d = 1) => (Math.round(v * 10 ** d) / 10 ** d).toFixed(d);
  function centroid(p) {
    let a = 0, cx = 0, cy = 0;
    for (let i = 0; i < p.length; i++) {
      const [x0, y0] = p[i], [x1, y1] = p[(i + 1) % p.length];
      const c = x0 * y1 - x1 * y0; a += c; cx += (x0 + x1) * c; cy += (y0 + y1) * c;
    }
    a /= 2; return Math.abs(a) < 1e-9 ? p[0] : [cx / (6 * a), cy / (6 * a)];
  }
  function pcaAngle(p) {
    const [cx, cy] = centroid(p);
    let sxx = 0, syy = 0, sxy = 0;
    p.forEach(([x, y]) => { sxx += (x - cx) ** 2; syy += (y - cy) ** 2; sxy += (x - cx) * (y - cy); });
    return 0.5 * Math.atan2(2 * sxy, sxx - syy);
  }
  function bounds(polys) {
    let a = [Infinity, Infinity], b = [-Infinity, -Infinity];
    polys.forEach(p => p.forEach(([x, y]) => { a = [Math.min(a[0], x), Math.min(a[1], y)]; b = [Math.max(b[0], x), Math.max(b[1], y)]; }));
    return { x0: a[0], y0: a[1], x1: b[0], y1: b[1], w: b[0] - a[0], h: b[1] - a[1] };
  }
  function pip(pt, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i], [xj, yj] = poly[j];
      if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < (xj - xi) * (pt[1] - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  const rot = ([x, y], a) => [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)];
  let toastT;
  function toast(msg) {
    let el = document.querySelector('.toast');
    if (!el) { el = document.createElement('div'); el.className = 'toast'; el.setAttribute('role', 'status'); document.body.appendChild(el); }
    el.textContent = msg; el.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => (el.hidden = true), 3200);
  }

  // ---------------------------------------------------------------- tool geometry
  // Local outline: parallax-corrected, centred on its own centroid, y flipped to tray (y-up) frame.
  function localPoly(t) {
    const cor = V.parallaxCorrect(t.raw, S.pose, t.h);
    const [cx, cy] = centroid(cor);
    return cor.map(([x, y]) => [x - cx, -(y - cy)]);
  }
  function worldPoly(t) { const a = rad(t.rot); return localPoly(t).map(p => { const r = rot(p, a); return [r[0] + t.x, r[1] + t.y]; }); }
  const clr = t => (t.clr != null ? t.clr : S.tray.clearance);
  const smo = t => (t.sm != null ? t.sm : S.tray.smooth);
  function worldScoops(t) {
    const a = rad(t.rot);
    return t.scoops.map(s => { const r = rot([s.u, s.v], a); return { id: s.id, x: r[0] + t.x, y: r[1] + t.y, angle: s.a + t.rot, length: s.len, radius: s.r }; });
  }
  // Top-face footprint of a scoop: a stadium (straight sides, round ends).
  function scoopRect(s) {
    const { half } = G.scoopGeom(s, S.tray.H, S.tray.floor);
    const a = rad(s.angle), e = Math.max(0.05, s.length / 2 - s.radius), out = [];
    for (let i = 0; i <= 16; i++) { const t = -Math.PI / 2 + Math.PI * i / 16; out.push([e + half * Math.cos(t), half * Math.sin(t)]); }
    for (let i = 0; i <= 16; i++) { const t = Math.PI / 2 + Math.PI * i / 16; out.push([-e + half * Math.cos(t), half * Math.sin(t)]); }
    return out.map(p => { const r = rot(p, a); return [r[0] + s.x, r[1] + s.y]; });
  }
  const secCache = new Map();
  function toolSection(t) {
    const wp = worldPoly(t);
    const key = t.id + '|' + clr(t) + '|' + smo(t) + '|' + wp.length + '|' + wp[0][0].toFixed(3) + ',' + wp[0][1].toFixed(3) + '|' + wp[1][0].toFixed(3);
    if (secCache.has(key)) return secCache.get(key);
    const polys = M ? G.sectionPolys(M, wp, clr(t), smo(t)) : [wp];
    if (secCache.size > 400) secCache.clear();
    secCache.set(key, polys);
    return polys;
  }
  function toolFootprint(t) { return toolSection(t).concat(worldScoops(t).map(scoopRect)); }
  function toolDims(t) { const b = bounds([worldPoly(t)]); return [b.w, b.h]; }

  // ---------------------------------------------------------------- image intake
  async function loadFile(file) {
    if (!file) return;
    busy('Reading photo');
    try {
      const buf = await file.arrayBuffer();
      const f35 = V.exifFocal35(buf);
      const bmp = await createImageBitmap(new Blob([buf], { type: file.type || 'image/jpeg' }));
      setImage(bmp, bmp.width, bmp.height, f35, file.name);
      bmp.close && bmp.close();
    } catch (e) {
      toast('That file could not be read as an image. Try a JPEG or PNG.');
    }
    busy('');
  }
  function setImage(src, w, h, f35, name) {
    S.paint = []; S.tools = [];
    const k = Math.min(1, 2400 / Math.max(w, h));
    const c = document.createElement('canvas');
    c.width = Math.round(w * k); c.height = Math.round(h * k);
    c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
    S.img = { canvas: c, w: c.width, h: c.height, data: c.getContext('2d').getImageData(0, 0, c.width, c.height), f35exif: f35, name };
    if (f35) { S.f35 = f35; $('f35').value = f35; }
    $('srcNote').innerHTML = name ? `<b>${esc(name)}</b> · ${w}×${h}px${f35 ? ` · EXIF lens ${f35} mm` : ' · no lens data, using the lens field'}` : '';
    detect();
  }
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function detect() {
    const { canvas, w, h } = S.img;
    const k = Math.min(1, 900 / Math.max(w, h));
    const c = document.createElement('canvas');
    c.width = Math.round(w * k); c.height = Math.round(h * k);
    const ctx = c.getContext('2d'); ctx.drawImage(canvas, 0, 0, c.width, c.height);
    const q = V.detectPaper(ctx.getImageData(0, 0, c.width, c.height));
    if (q) S.quad = q.map(([x, y]) => [x / k, y / k]);
    else {
      S.quad = [[w * .15, h * .15], [w * .85, h * .15], [w * .85, h * .85], [w * .15, h * .85]];
      toast('Couldn\'t find the sheet. Drag the four corners onto it.');
    }
    retrace();
  }

  // Paper fit + rectify + trace. Keeps tray settings; replaces tools.
  function retrace() {
    if (!S.img || !S.quad) return;
    busy('Tracing');
    const { w, h } = S.img;
    const g = V.guessPaper(S.quad, w, h, S.f35);
    S.aspect = g;
    const key = S.paperMode === 'auto' ? g.key : S.paperMode;
    S.paper = { key, landscape: g.landscape };
    S.dims = V.paperDims(key, g.landscape);
    const rect = V.rectify(S.img.data, S.quad, S.dims, PPM);
    S.Hm = rect.Hm;
    const fpx = Math.max(w, h) / 2 * S.f35 / 18;
    S.pose = V.cameraPose(S.Hm, [w / 2, h / 2], fpx);
    S.Hinv = V.homography(S.quad, [[0, 0], [S.dims.w, 0], [S.dims.w, S.dims.h], [0, S.dims.h]]);
    const res = V.traceTools(rect, { ppm: PPM, sens: S.sens, minArea: S.minArea, marginMm: 3, paint: S.paint });
    const old = S.tools;
    S.tools = res.tools.map((r, i) => {
      const prev = old[i];
      const t = { id: S.nextId++, name: prev ? prev.name : 'Tool ' + (i + 1), raw: r.poly, h: prev ? prev.h : 0, clr: prev ? prev.clr : null, sm: prev ? prev.sm : null, x: 0, y: 0, rot: 0, scoops: [] };
      t.rot = -deg(pcaAngle(localPoly(t)));       // long axis horizontal
      return t;
    });
    if (S.sampleNames) { S.tools.forEach((t, i) => Object.assign(t, S.sampleNames[i] || {})); S.sampleNames = null; }
    S.sel = S.tools.length ? S.tools[0].id : null;
    arrange();
    busy('');
    renderAll();
  }

  // ---------------------------------------------------------------- arrange / sizing
  // Rotation giving the smallest bounding box of a tool's outline, long side along X.
  function bestRot(t) {
    const lp = localPoly(t);
    let best = 0, bestA = Infinity;
    for (let d = 0; d < 180; d += 1) {
      const a = rad(d), c = Math.cos(a), sn = Math.sin(a);
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const [x, y] of lp) { const X = x * c - y * sn, Y = x * sn + y * c; if (X < x0) x0 = X; if (X > x1) x1 = X; if (Y < y0) y0 = Y; if (Y > y1) y1 = Y; }
      const ar = (x1 - x0) * (y1 - y0) + ((x1 - x0) < (y1 - y0) ? 1e9 : 0);  // long side horizontal
      if (ar < bestA - 1e-6) { bestA = ar; best = d; }
    }
    return normDeg(best);
  }

  // Shelf pack at a given usable width. Returns the packed size; positions written to tools.
  function shelfPack(items, maxW, gap) {
    let x = 0, y = 0, rowH = 0, usedW = 0;
    items.forEach(it => {
      const b = it.b;
      if (x > 0 && x + b.w > maxW + 0.01) { x = 0; y += rowH + gap; rowH = 0; }
      it.px = x - b.x0; it.py = y - b.y0;
      x += b.w + gap; rowH = Math.max(rowH, b.h); usedW = Math.max(usedW, x - gap);
    });
    return { w: usedW, h: y + rowH };
  }

  // Auto-arrange: square each tool up (min bounding box, long side along X), then shelf-pack.
  // Hug mode tries a range of shelf widths and keeps the smallest tray that fits the plate.
  function arrange() {
    const T = S.tray, gap = Math.max(T.web, 1);
    S.tools.forEach(t => { t.rot = bestRot(t); t.x = 0; t.y = 0; });
    const meas = () => S.tools.map(t => ({ t, b: bounds(toolFootprint(t)) })).sort((a, b) => b.b.h - a.b.h || b.b.w - a.b.w);
    let items = meas();
    if (!items.length) return normalize(true);
    if (T.mode === 'fixed') {
      const maxW = T.W - 2 * T.wall;
      let flipped = false;
      items.forEach(({ t, b }) => { if (b.w > maxW && b.h <= maxW) { t.rot = normDeg(t.rot + 90); flipped = true; } });
      if (flipped) items = meas();
      shelfPack(items, maxW, gap);
    } else {
      const widest = Math.max(...items.map(i => i.b.w));
      const total = items.reduce((s, i) => s + i.b.w + gap, 0);
      let best = null;
      for (let w = widest; w <= total + 0.01; w += Math.max(2, (total - widest) / 60)) {
        const r = shelfPack(items, w, gap);
        const W = r.w + 2 * T.wall, D = r.h + 2 * T.wall;
        const score = W * D * (W > BED || D > BED ? 4 : 1) * (1 + 0.04 * Math.max(W / D, D / W));
        if (!best || score < best.score) best = { score, w };
      }
      shelfPack(items, best.w, gap);
    }
    items.forEach(it => { it.t.x = it.px; it.t.y = it.py; });
    normalize(true);
  }
  // Hug: shift everything so the margin is uniform and resize. Fixed: centre the group once after arrange.
  function normalize(center) {
    const T = S.tray;
    if (!S.tools.length) { if (T.mode === 'hug') { T.W = 120; T.D = 80; } return; }
    const b = bounds(S.tools.flatMap(toolFootprint));
    let dx, dy;
    if (T.mode === 'hug') {
      dx = T.wall - b.x0; dy = T.wall - b.y0;
      T.W = Math.ceil((b.w + 2 * T.wall) * 2) / 2; T.D = Math.ceil((b.h + 2 * T.wall) * 2) / 2;
    } else if (center) {
      dx = (T.W - b.w) / 2 - b.x0; dy = (T.D - b.h) / 2 - b.y0;
    } else return;
    S.tools.forEach(t => { t.x += dx; t.y += dy; });
  }

  // ---------------------------------------------------------------- checks
  function checks() {
    const T = S.tray, out = [];
    const depth = T.H - T.floor;
    if (depth < 1) out.push(['bad', 'Height leaves no pocket depth']);
    if (T.W > BED || T.D > BED) out.push(['bad', `${fmt(T.W, 0)}×${fmt(T.D, 0)} exceeds the 256 mm P1S plate`]);
    else out.push(['ok', `Fits P1S plate`]);
    const bad = new Set();
    S.tools.forEach(t => {
      const b = bounds(toolFootprint(t));
      if (b.x0 < T.web || b.y0 < T.web || b.x1 > T.W - T.web || b.y1 > T.D - T.web) bad.add(t.id);
      if (t.h && depth < t.h - 0.5) out.push(['warn', `${t.name} stands ${fmt(t.h - depth)} mm proud`]);
    });
    if (bad.size) out.push(['bad', `${bad.size} pocket${bad.size > 1 ? 's' : ''} closer than ${T.web} mm to the edge`]);
    for (let i = 0; i < S.tools.length; i++) for (let j = i + 1; j < S.tools.length; j++) {
      const a = S.tools[i], b = S.tools[j];
      const A = bounds(toolSection(a)), B = bounds(toolSection(b));
      if (A.x1 < B.x0 || B.x1 < A.x0 || A.y1 < B.y0 || B.y1 < A.y0) continue;
      if (M && G.overlapArea(M, toolSection(a), toolSection(b)) > 0.5) { out.push(['warn', `${a.name} and ${b.name} pockets merge`]); bad.add(a.id); bad.add(b.id); }
    }
    return { list: out, bad };
  }

  // ---------------------------------------------------------------- photo view
  const photo = { cv: $('cv-photo'), view: null, drag: -1 };
  function drawPhoto() {
    const cv = photo.cv, r = cv.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    if (!r.width) return;
    cv.width = r.width * dpr; cv.height = r.height * dpr;
    const ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, r.width, r.height);
    if (!S.img) return;
    // keep the photo clear of the floating bars at the top and the chips at the bottom
    const tip = $('photoTip'), padT = tip.offsetTop + tip.offsetHeight + 8, padB = 52, pad = 12;
    // frame the sheet, not the whole floor: quad bounds + 12% (whole image while dragging a corner)
    let fx0 = 0, fy0 = 0, fx1 = S.img.w, fy1 = S.img.h;
    if (S.quad && photo.drag < 0) {
      const b = bounds([S.quad]), m = Math.max(b.w, b.h) * 0.12;
      if (photo.frame && photo.stroke) ({ fx0, fy0, fx1, fy1 } = photo.frame);   // hold still while painting
      else { fx0 = Math.max(0, b.x0 - m); fy0 = Math.max(0, b.y0 - m); fx1 = Math.min(S.img.w, b.x1 + m); fy1 = Math.min(S.img.h, b.y1 + m); }
    } else if (photo.frame && photo.drag >= 0) ({ fx0, fy0, fx1, fy1 } = photo.frame);
    photo.frame = { fx0, fy0, fx1, fy1 };
    const k = Math.min((r.width - 2 * pad) / (fx1 - fx0), (r.height - padT - padB) / (fy1 - fy0));
    const ox = (r.width - (fx1 - fx0) * k) / 2 - fx0 * k, oy = padT + (r.height - padT - padB - (fy1 - fy0) * k) / 2 - fy0 * k;
    photo.view = { k, ox, oy };
    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, r.width, r.height); ctx.clip();
    ctx.drawImage(S.img.canvas, ox, oy, S.img.w * k, S.img.h * k);
    ctx.restore();
    const P = ([x, y]) => [ox + x * k, oy + y * k];
    const accent = css('--dykem');
    // traced outlines, mapped back into the photo
    if (S.Hm) {
      S.tools.forEach(t => {
        ctx.beginPath();
        t.raw.forEach((p, i) => { const q = P(V.applyH(S.Hm, p[0], p[1])); i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]); });
        ctx.closePath();
        ctx.fillStyle = 'rgba(255,170,40,.22)'; ctx.fill();
        ctx.lineWidth = 2; ctx.strokeStyle = '#FFAA28'; ctx.stroke();
        const c = P(V.applyH(S.Hm, ...centroid(t.raw)));
        ctx.font = '600 13px ' + css('--f-ui'); ctx.textAlign = 'center';
        ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,.6)'; ctx.strokeText(t.name, c[0], c[1]);
        ctx.fillStyle = '#fff'; ctx.fillText(t.name, c[0], c[1]);
      });
      // camera nadir
      if (S.pose) {
        const n = S.pose.nadir;
        if (n[0] > -50 && n[0] < S.dims.w + 50 && n[1] > -50 && n[1] < S.dims.h + 50) {
          const q = P(V.applyH(S.Hm, n[0], n[1]));
          ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5;
          ctx.beginPath(); ctx.moveTo(q[0] - 8, q[1]); ctx.lineTo(q[0] + 8, q[1]); ctx.moveTo(q[0], q[1] - 8); ctx.lineTo(q[0], q[1] + 8); ctx.stroke();
        }
      }
    }
    // brush strokes (stored in paper mm)
    if (S.Hm) {
      const strokes = S.paint.concat(photo.stroke ? [photo.stroke] : []);
      strokes.forEach(st => {
        const pts = st.pts.map(p => P(V.applyH(S.Hm, p[0], p[1])));
        const a = P(V.applyH(S.Hm, st.pts[0][0], st.pts[0][1])), b = P(V.applyH(S.Hm, st.pts[0][0] + st.r, st.pts[0][1]));
        const rpx = Math.hypot(b[0] - a[0], b[1] - a[1]);
        ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.lineWidth = 2 * rpx;
        ctx.strokeStyle = st.mode === 'add' ? 'rgba(40,190,90,.45)' : 'rgba(225,40,60,.42)';
        ctx.fillStyle = ctx.strokeStyle;
        if (pts.length === 1) { ctx.beginPath(); ctx.arc(pts[0][0], pts[0][1], rpx, 0, Math.PI * 2); ctx.fill(); }
        else { ctx.beginPath(); pts.forEach((q, i) => (i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]))); ctx.stroke(); }
      });
      ctx.lineCap = 'butt'; ctx.lineJoin = 'miter';
    }
    // sheet quad + handles
    if (S.quad) {
      ctx.beginPath(); S.quad.forEach((p, i) => { const q = P(p); i ? ctx.lineTo(...q) : ctx.moveTo(...q); }); ctx.closePath();
      ctx.lineWidth = 2; ctx.strokeStyle = accent; ctx.setLineDash([7, 5]); ctx.stroke(); ctx.setLineDash([]);
      S.quad.forEach((p, i) => {
        const q = P(p);
        ctx.beginPath(); ctx.arc(q[0], q[1], 11, 0, Math.PI * 2);
        ctx.fillStyle = photo.drag === i ? accent : 'rgba(255,255,255,.9)'; ctx.fill();
        ctx.lineWidth = 2; ctx.strokeStyle = accent; ctx.stroke();
      });
    }
  }
  function photoPt(e) { const r = photo.cv.getBoundingClientRect(), v = photo.view; return [(e.clientX - r.left - v.ox) / v.k, (e.clientY - r.top - v.oy) / v.k]; }
  const toMm = p => V.applyH(S.Hinv, p[0], p[1]);
  photo.cv.addEventListener('pointerdown', e => {
    if (!S.quad || !photo.view) return;
    const p = photoPt(e);
    if (S.pmode !== 'corners' && S.Hinv) {
      photo.stroke = { mode: S.pmode, r: S.brush / 2, pts: [toMm(p)] };
      photo.cv.setPointerCapture(e.pointerId); drawPhoto(); return;
    }
    const tol = 26 / photo.view.k;
    let best = -1, bd = Infinity;
    S.quad.forEach((q, i) => { const d = Math.hypot(q[0] - p[0], q[1] - p[1]); if (d < tol && d < bd) { bd = d; best = i; } });
    if (best >= 0) { photo.drag = best; photo.cv.setPointerCapture(e.pointerId); drawPhoto(); }
  });
  photo.cv.addEventListener('pointermove', e => {
    if (photo.stroke) {
      const q = toMm(photoPt(e)), last = photo.stroke.pts[photo.stroke.pts.length - 1];
      if (Math.hypot(q[0] - last[0], q[1] - last[1]) > 0.8) { photo.stroke.pts.push(q); drawPhoto(); }
      return;
    }
    if (photo.drag < 0) return;
    const p = photoPt(e);
    S.quad[photo.drag] = [Math.max(0, Math.min(S.img.w, p[0])), Math.max(0, Math.min(S.img.h, p[1]))];
    drawPhoto();
  });
  const endPhotoDrag = () => {
    if (photo.stroke) { S.paint.push(photo.stroke); photo.stroke = null; retrace(); return; }
    if (photo.drag >= 0) { photo.drag = -1; S.quad = V.orderQuad(S.quad); retrace(); }
  };
  photo.cv.addEventListener('pointerup', endPhotoDrag);
  photo.cv.addEventListener('pointercancel', endPhotoDrag);

  function setPmode(m) {
    S.pmode = m;
    document.querySelectorAll('[data-pmode]').forEach(b => b.setAttribute('aria-pressed', b.dataset.pmode === m));
    $('photoTip').textContent = m === 'corners' ? 'Drag the blue handles onto the sheet corners if detection missed.'
      : m === 'erase' ? 'Paint over shadows or marks that got traced as tool.' : 'Paint over tool parts the trace missed (light metal, glare).';
  }
  document.querySelectorAll('[data-pmode]').forEach(b => b.addEventListener('click', () => setPmode(b.dataset.pmode)));
  const setBrush = d => { S.brush = Math.max(2, Math.min(40, d)); $('brushV').textContent = S.brush + ' mm'; };
  $('brushDn').addEventListener('click', () => setBrush(S.brush - (S.brush > 10 ? 4 : 2)));
  $('brushUp').addEventListener('click', () => setBrush(S.brush + (S.brush >= 10 ? 4 : 2)));
  $('strokeUndo').addEventListener('click', () => { if (S.paint.length) { S.paint.pop(); retrace(); } });
  $('strokeClear').addEventListener('click', () => { if (S.paint.length) { S.paint = []; retrace(); } });

  // ---------------------------------------------------------------- layout view
  const lay = { cv: $('cv-layout'), view: null, drag: null };
  function drawLayout() {
    const cv = lay.cv, r = cv.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    if (!r.width) return;
    cv.width = r.width * dpr; cv.height = r.height * dpr;
    const ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, r.width, r.height);
    const T = S.tray;
    const padL = 48, padB = 54, padT = 46, padR = 28;
    const k = Math.min((r.width - padL - padR) / T.W, (r.height - padT - padB) / T.D);
    const ox = padL + (r.width - padL - padR - T.W * k) / 2, oy = r.height - padB - (r.height - padT - padB - T.D * k) / 2;
    lay.view = { k, ox, oy };
    const P = ([x, y]) => [ox + x * k, oy - y * k];
    const ink = css('--ink'), muted = css('--muted'), accent = css('--dykem'), bad = css('--bad');
    const numFont = '500 12px ' + css('--f-num');

    // 10 mm grid inside the tray
    ctx.save();
    ctx.beginPath(); ctx.rect(ox, oy - T.D * k, T.W * k, T.D * k); ctx.clip();
    ctx.fillStyle = css('--raise'); ctx.fillRect(ox, oy - T.D * k, T.W * k, T.D * k);
    ctx.strokeStyle = css('--grid'); ctx.lineWidth = 1;
    for (let x = 10; x < T.W; x += 10) { ctx.beginPath(); ctx.moveTo(ox + x * k, oy); ctx.lineTo(ox + x * k, oy - T.D * k); ctx.stroke(); }
    for (let y = 10; y < T.D; y += 10) { ctx.beginPath(); ctx.moveTo(ox, oy - y * k); ctx.lineTo(ox + T.W * k, oy - y * k); ctx.stroke(); }
    ctx.restore();
    // tray outline + chamfer line
    ctx.strokeStyle = ink; ctx.lineWidth = 1.5; ctx.strokeRect(ox, oy - T.D * k, T.W * k, T.D * k);
    const c = T.outerChamfer * k;
    if (c > 1.5) { ctx.lineWidth = 0.75; ctx.strokeStyle = muted; ctx.strokeRect(ox + c, oy - T.D * k + c, T.W * k - 2 * c, T.D * k - 2 * c); }

    const { bad: badSet } = S._checks || { bad: new Set() };
    const path = poly => { ctx.beginPath(); poly.forEach((p, i) => { const q = P(p); i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]); }); ctx.closePath(); };
    S.tools.forEach(t => {
      const sel = t.id === S.sel, isBad = badSet.has(t.id);
      worldScoops(t).forEach(s => { path(scoopRect(s)); ctx.fillStyle = css('--scoop'); ctx.fill(); });
      toolSection(t).forEach(poly => {
        path(poly); ctx.fillStyle = css('--dykem-soft'); ctx.fill();
        ctx.lineWidth = sel ? 2.25 : 1.25; ctx.strokeStyle = isBad ? bad : accent; ctx.stroke();
      });
      path(worldPoly(t)); ctx.setLineDash([3, 3]); ctx.lineWidth = 1; ctx.strokeStyle = muted; ctx.stroke(); ctx.setLineDash([]);
      const q = P([t.x, t.y]);
      ctx.font = '600 12px ' + css('--f-ui'); ctx.textAlign = 'center'; ctx.fillStyle = ink;
      ctx.fillText(t.name, q[0], q[1] + 4);
      if (sel) {
        const kn = knob(t), c0 = P([t.x, t.y]);
        ctx.strokeStyle = accent; ctx.lineWidth = 1.25; ctx.setLineDash([4, 3]);
        ctx.beginPath(); ctx.moveTo(c0[0], c0[1]); ctx.lineTo(kn.sx, kn.sy); ctx.stroke(); ctx.setLineDash([]);
        ctx.beginPath(); ctx.arc(kn.sx, kn.sy, 12, 0, Math.PI * 2); ctx.fillStyle = accent; ctx.fill();
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.75;
        ctx.beginPath(); ctx.arc(kn.sx, kn.sy, 5.5, -Math.PI * 0.9, Math.PI * 0.45); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(kn.sx + 5.5 * Math.cos(Math.PI * 0.45) - 3, kn.sy + 5.5 * Math.sin(Math.PI * 0.45)); ctx.lineTo(kn.sx + 5.5 * Math.cos(Math.PI * 0.45) + 1, kn.sy + 5.5 * Math.sin(Math.PI * 0.45) + 3); ctx.stroke();
      }
      if (sel) worldScoops(t).forEach(s => {
        // resize handles: square at each end (length + angle), diamond on the side (radius)
        const hs = scoopHandles(s);
        ctx.lineWidth = 2; ctx.strokeStyle = accent; ctx.fillStyle = css('--raise');
        [hs.e1, hs.e2].forEach(([x, y]) => { const q = P([x, y]); ctx.beginPath(); ctx.rect(q[0] - 6.5, q[1] - 6.5, 13, 13); ctx.fill(); ctx.stroke(); });
        const qs = P(hs.side);
        ctx.beginPath(); ctx.moveTo(qs[0], qs[1] - 8); ctx.lineTo(qs[0] + 8, qs[1]); ctx.lineTo(qs[0], qs[1] + 8); ctx.lineTo(qs[0] - 8, qs[1]); ctx.closePath(); ctx.fill(); ctx.stroke();
        const h = P([s.x, s.y]);
        ctx.beginPath(); ctx.arc(h[0], h[1], 9, 0, Math.PI * 2); ctx.fillStyle = css('--raise'); ctx.fill();
        ctx.lineWidth = 2; ctx.strokeStyle = accent; ctx.stroke();
        ctx.beginPath(); ctx.arc(h[0], h[1], 3, 0, Math.PI * 2); ctx.fillStyle = accent; ctx.fill();
      });
    });

    // dimension lines, drawing-style
    ctx.strokeStyle = ink; ctx.fillStyle = ink; ctx.lineWidth = 1; ctx.font = numFont;
    const arrow = (x, y, a) => { ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - 8 * Math.cos(a - .32), y - 8 * Math.sin(a - .32)); ctx.lineTo(x - 8 * Math.cos(a + .32), y - 8 * Math.sin(a + .32)); ctx.closePath(); ctx.fill(); };
    const yb = oy + 26;
    ctx.beginPath(); ctx.moveTo(ox, oy + 6); ctx.lineTo(ox, yb + 6); ctx.moveTo(ox + T.W * k, oy + 6); ctx.lineTo(ox + T.W * k, yb + 6); ctx.moveTo(ox, yb); ctx.lineTo(ox + T.W * k, yb); ctx.stroke();
    arrow(ox, yb, Math.PI); arrow(ox + T.W * k, yb, 0);
    const wl = fmt(T.W, T.W % 1 ? 1 : 0); ctx.textAlign = 'center';
    const tw = ctx.measureText(wl).width + 10;
    ctx.fillStyle = css('--stage'); ctx.fillRect(ox + T.W * k / 2 - tw / 2, yb - 8, tw, 16); ctx.fillStyle = ink; ctx.fillText(wl, ox + T.W * k / 2, yb + 4);
    const xl = ox - 26;
    ctx.beginPath(); ctx.moveTo(ox - 6, oy); ctx.lineTo(xl - 6, oy); ctx.moveTo(ox - 6, oy - T.D * k); ctx.lineTo(xl - 6, oy - T.D * k); ctx.moveTo(xl, oy); ctx.lineTo(xl, oy - T.D * k); ctx.stroke();
    arrow(xl, oy, Math.PI / 2); arrow(xl, oy - T.D * k, -Math.PI / 2);
    ctx.save(); ctx.translate(xl, oy - T.D * k / 2); ctx.rotate(-Math.PI / 2);
    const dl = fmt(T.D, T.D % 1 ? 1 : 0); const dw = ctx.measureText(dl).width + 10;
    ctx.fillStyle = css('--stage'); ctx.fillRect(-dw / 2, -8, dw, 16); ctx.fillStyle = ink; ctx.fillText(dl, 0, 4); ctx.restore();
    // title block
    ctx.textAlign = 'left'; ctx.fillStyle = muted; ctx.font = numFont;
    syncRotbar();
    ctx.fillText(`H ${fmt(T.H)} · FLOOR ${fmt(T.floor)} · POCKET ${fmt(T.H - T.floor)} · CLR ${fmt(T.clearance, 2)}  (mm)`, ox, oy - T.D * k - 12);
  }
  // Rotate knob: on the tool's local +X axis, just past its outline (screen px).
  function knob(t) {
    const v = lay.view, a = rad(t.rot);
    const ext = Math.max(...localPoly(t).map(p => p[0])) + clr(t);
    const sxC = v.ox + t.x * v.k, syC = v.oy - t.y * v.k;
    const r = ext * v.k + 26;
    return { sx: sxC + r * Math.cos(a), sy: syC - r * Math.sin(a), cx: sxC, cy: syC };
  }
  // Handle points of a scoop in tray mm: both ends of its axis and the side (radius).
  function scoopHandles(s) {
    const a = rad(s.angle), ux = Math.cos(a), uy = Math.sin(a), L = s.length / 2;
    const { half } = G.scoopGeom(s, S.tray.H, S.tray.floor);
    const w = Math.max(half, 2);
    return { e1: [s.x + ux * L, s.y + uy * L], e2: [s.x - ux * L, s.y - uy * L], side: [s.x - uy * w, s.y + ux * w], ux, uy };
  }
  const normDeg = d => ((d % 360) + 540) % 360 - 180;
  function syncRotbar() {
    const t = S.tools.find(t => t.id === S.sel);
    $('rotbar').hidden = !t; $('layHint').hidden = !!t;
    $('scoopTip').hidden = !(t && t.scoops.length);
    if (t) { $('rbName').textContent = t.name; $('rbAng').textContent = fmt(normDeg(t.rot), 0) + '°'; }
    $('smoothPill').hidden = !t;
    if (t) {
      if (document.activeElement !== $('tSmooth2')) $('tSmooth2').value = smo(t);
      $('tSmoothV').textContent = fmt(smo(t), 1) + ' mm' + (t.sm == null ? '' : ' ·');
    }
  }
  let smT;
  $('tSmooth2').addEventListener('input', e => {
    const t = S.tools.find(t => t.id === S.sel); if (!t) return;
    t.sm = +e.target.value; drawLayout();
    clearTimeout(smT); smT = setTimeout(() => { normalize(false); changed(); }, 220);
  });
  let rotT;
  function rotateBy(t, d) {
    t.rot = normDeg(t.rot + d);
    drawLayout(); renderTools();
    clearTimeout(rotT); rotT = setTimeout(() => { normalize(false); changed(); }, 250);
  }
  function addScoop(t) {
    const lp = localPoly(t), a = pcaAngle(lp) + Math.PI / 2;
    const ext = lp.map(p => p[0] * Math.cos(a) + p[1] * Math.sin(a));
    t.scoops.push({ id: S.nextId++, u: 0, v: 0, a: deg(a), len: Math.round(Math.max(...ext) - Math.min(...ext) + 30), r: 12 });
    normalize(false); changed();
  }
  $('rbScoop').addEventListener('click', () => { const t = S.tools.find(t => t.id === S.sel); if (t) addScoop(t); });
  $('rotbar').addEventListener('click', e => {
    const b = e.target.closest('[data-rot]'); const t = S.tools.find(t => t.id === S.sel);
    if (b && t) rotateBy(t, +b.dataset.rot);
  });
  function layPt(e) { const r = lay.cv.getBoundingClientRect(), v = lay.view; return [(e.clientX - r.left - v.ox) / v.k, (v.oy - (e.clientY - r.top)) / v.k]; }
  lay.cv.addEventListener('pointerdown', e => {
    if (!lay.view) return;
    const p = layPt(e);
    const selT = S.tools.find(t => t.id === S.sel);
    if (selT) {
      const kn = knob(selT), r = lay.cv.getBoundingClientRect();
      if (Math.hypot(e.clientX - r.left - kn.sx, e.clientY - r.top - kn.sy) < 22) {
        lay.drag = { kind: 'rotate', t: selT, moved: false }; lay.cv.setPointerCapture(e.pointerId); return;
      }
      const tol = 16 / lay.view.k;
      const near = (q, px) => Math.hypot(q[0] - p[0], q[1] - p[1]) < px / lay.view.k;
      for (const ws of worldScoops(selT)) {
        const hs = scoopHandles(ws);
        let part = near(hs.e1, 18) ? 'e1' : near(hs.e2, 18) ? 'e2' : near(hs.side, 18) ? 'side' : null;
        if (part) { lay.drag = { kind: 'scoopsize', part, t: selT, id: ws.id, moved: false }; lay.cv.setPointerCapture(e.pointerId); return; }
      }
      const hit = worldScoops(selT).find(s => Math.hypot(s.x - p[0], s.y - p[1]) < tol);
      if (hit) { lay.drag = { kind: 'scoop', t: selT, id: hit.id, off: [hit.x - p[0], hit.y - p[1]] }; lay.cv.setPointerCapture(e.pointerId); return; }
    }
    const t = S.tools.slice().reverse().find(t => toolSection(t).some(poly => pip(p, poly)));
    if (t) {
      S.sel = t.id; lay.drag = { kind: 'tool', t, off: [t.x - p[0], t.y - p[1]], moved: false };
      lay.cv.setPointerCapture(e.pointerId);
    } else S.sel = null;
    renderPanel(); drawLayout();
  });
  lay.cv.addEventListener('pointermove', e => {
    const d = lay.drag; if (!d) return;
    const p = layPt(e);
    if (d.kind === 'tool') { d.t.x = p[0] + d.off[0]; d.t.y = p[1] + d.off[1]; d.moved = true; }
    else if (d.kind === 'rotate') {
      let a = deg(Math.atan2(p[1] - d.t.y, p[0] - d.t.x));
      if (!e.altKey) a = Math.round(a);                    // whole degrees; hold Alt for free rotation
      for (const s of [0, 90, -90, 180, -180]) if (Math.abs(a - s) < 2.5) a = s;   // detents at the square angles
      d.t.rot = normDeg(a); d.moved = true; renderTools();
    }
    else if (d.kind === 'scoopsize') {
      const s = d.t.scoops.find(s => s.id === d.id);
      const ws = worldScoops(d.t).find(w => w.id === d.id);
      const v = [p[0] - ws.x, p[1] - ws.y];
      if (d.part === 'side') {
        const a = rad(ws.angle);
        s.r = Math.max(3, Math.min(40, Math.round(Math.abs(-v[0] * Math.sin(a) + v[1] * Math.cos(a)) * 2) / 2));
        if (s.len < 2 * s.r) s.len = 2 * s.r;
      } else {
        const dir = d.part === 'e1' ? v : [-v[0], -v[1]];
        let a = deg(Math.atan2(dir[1], dir[0])) - d.t.rot;
        for (const k of [0, 90, -90, 180, -180, 270, -270]) if (Math.abs(normDeg(a) - normDeg(k)) < 3) a = k;
        s.a = normDeg(a);
        s.len = Math.max(5, Math.round(2 * Math.hypot(v[0], v[1])));
      }
      d.moved = true; renderTools();
    }
    else {
      const s = d.t.scoops.find(s => s.id === d.id);
      const w = [p[0] + d.off[0] - d.t.x, p[1] + d.off[1] - d.t.y];
      const l = rot(w, -rad(d.t.rot)); s.u = l[0]; s.v = l[1]; d.moved = true;
    }
    drawLayout();
  });
  const endLay = () => { if (lay.drag) { const m = lay.drag.moved; lay.drag = null; if (m) { normalize(false); changed(); } } };
  lay.cv.addEventListener('pointerup', endLay);
  lay.cv.addEventListener('pointercancel', endLay);

  // ---------------------------------------------------------------- 3D view
  const three = { ready: false };
  function initThree() {
    if (three.ready || !window.THREE) return;
    const el = $('three');
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    el.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    const cam = new THREE.PerspectiveCamera(35, 1, 1, 5000);
    cam.up.set(0, 0, 1);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x445055, 0.85));
    const sun = new THREE.DirectionalLight(0xffffff, 0.75); sun.position.set(-300, -500, 700); scene.add(sun);
    const fill = new THREE.DirectionalLight(0xffffff, 0.25); fill.position.set(400, 300, 200); scene.add(fill);
    const controls = THREE.OrbitControls ? new THREE.OrbitControls(cam, renderer.domElement) : null;
    if (controls) { controls.enableDamping = true; controls.dampingFactor = 0.12; }
    Object.assign(three, { ready: true, renderer, scene, cam, controls, mesh: null, bed: null, el });
    const loop = () => { requestAnimationFrame(loop); if (S.tab !== '3d') return; controls && controls.update(); renderer.render(scene, cam); };
    loop();
  }
  function sizeThree() {
    if (!three.ready) return;
    const r = three.el.getBoundingClientRect(); if (!r.width) return;
    three.renderer.setSize(r.width, r.height, false);
    three.renderer.domElement.style.width = '100%'; three.renderer.domElement.style.height = '100%';
    three.cam.aspect = r.width / r.height; three.cam.updateProjectionMatrix();
  }
  function showMesh(fit) {
    initThree(); if (!three.ready || !S.build) return;
    const { pos, idx } = S.build.mesh;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setIndex(new THREE.BufferAttribute(new Uint32Array(idx), 1));
    const flat = g.toNonIndexed(); flat.computeVertexNormals(); g.dispose();
    if (three.mesh) { three.scene.remove(three.mesh); three.mesh.geometry.dispose(); }
    const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color(css('--part')), roughness: 0.75, metalness: 0.0 });
    three.mesh = new THREE.Mesh(flat, mat);
    three.scene.add(three.mesh);
    // P1S plate outline
    if (three.bed) three.scene.remove(three.bed);
    const T = S.tray, bx = (T.W - BED) / 2, by = (T.D - BED) / 2;
    const bg = new THREE.BufferGeometry().setFromPoints([[bx, by], [bx + BED, by], [bx + BED, by + BED], [bx, by + BED], [bx, by]].map(([x, y]) => new THREE.Vector3(x, y, -0.2)));
    three.bed = new THREE.Line(bg, new THREE.LineDashedMaterial({ color: new THREE.Color(css('--muted')), dashSize: 6, gapSize: 4 }));
    three.bed.computeLineDistances(); three.scene.add(three.bed);
    if (fit || !three.fitted) {
      const R = Math.hypot(T.W, T.D, T.H) * 0.5;
      const ctr = new THREE.Vector3(T.W / 2, T.D / 2, T.H / 2);
      three.cam.position.set(ctr.x - R * 0.9, ctr.y - R * 2.2, ctr.z + R * 1.9);
      if (three.controls) { three.controls.target.copy(ctr); three.controls.update(); } else three.cam.lookAt(ctr);
      three.fitted = true;
    }
  }

  // ---------------------------------------------------------------- build
  let buildT = null, lastFitKey = '';
  // ---------------------------------------------------------------- undo / redo
  const hist = { stack: [], i: -1, quiet: false };
  function snap() {
    return { tray: { ...S.tray }, sel: S.sel, tools: S.tools.map(t => ({ id: t.id, name: t.name, raw: t.raw, h: t.h, clr: t.clr, sm: t.sm, x: t.x, y: t.y, rot: t.rot, scoops: t.scoops.map(s => ({ ...s })) })) };
  }
  const snapKey = sn => JSON.stringify([sn.tray, sn.tools.map(t => [t.id, t.raw.length, t.h, t.clr, t.sm, +t.x.toFixed(3), +t.y.toFixed(3), +t.rot.toFixed(3), t.scoops])]);
  function commit() {
    if (hist.quiet) return;
    const sn = snap(), k = snapKey(sn);
    if (hist.i >= 0 && hist.stack[hist.i].k === k) return;
    hist.stack.splice(hist.i + 1);
    hist.stack.push({ sn, k });
    if (hist.stack.length > 120) hist.stack.shift();
    hist.i = hist.stack.length - 1;
    syncUndo();
  }
  function restore(step) {
    const j = hist.i + step;
    if (j < 0 || j >= hist.stack.length) return;
    hist.i = j;
    const sn = hist.stack[j].sn;
    S.tray = { ...sn.tray }; S.sel = sn.sel;
    S.tools = sn.tools.map(t => ({ ...t, scoops: t.scoops.map(s => ({ ...s })) }));
    hist.quiet = true; changed(); hist.quiet = false;
    syncUndo();
  }
  function syncUndo() {
    const u = $('btnUndo'), r = $('btnRedo');
    if (u) u.disabled = hist.i <= 0;
    if (r) r.disabled = hist.i >= hist.stack.length - 1;
  }
  $('btnUndo').addEventListener('click', () => restore(-1));
  $('btnRedo').addEventListener('click', () => restore(1));
  document.addEventListener('keydown', e => {
    if (!(e.ctrlKey || e.metaKey) || e.target.matches('input, textarea, select')) return;
    const k = e.key.toLowerCase();
    if (k === 'z' && !e.shiftKey) { e.preventDefault(); restore(-1); }
    else if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); restore(1); }
  });

  // ---------------------------------------------------------------- full screen
  function setFocus(on) {
    document.body.classList.toggle('focus', on);
    $('btnFull').setAttribute('aria-pressed', on);
    $('btnFull').querySelector('span').textContent = on ? 'Exit' : 'Full screen';
    const st = $('stage');
    try {
      if (on && st.requestFullscreen && !document.fullscreenElement) st.requestFullscreen().catch(() => {});
      if (!on && document.fullscreenElement) document.exitFullscreen().catch(() => {});
    } catch (e) { /* the page fills the window instead */ }
  }
  $('btnFull').addEventListener('click', () => setFocus(!document.body.classList.contains('focus')));
  document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && document.body.classList.contains('focus')) setFocus(false); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && document.body.classList.contains('focus')) setFocus(false); });

  function changed() {
    commit();
    S._checks = checks();
    renderHud(); renderPanel(); drawLayout();
    clearTimeout(buildT); buildT = setTimeout(rebuild, 140);
  }
  function geomTools() {
    return S.tools.map(t => ({ poly: worldPoly(t), clearance: clr(t), smooth: smo(t), scoops: worldScoops(t) }));
  }
  function rebuild() {
    if (!M) return;
    const T = S.tray;
    try {
      S.build = G.buildMesh(M, T, geomTools());
    } catch (e) { S.build = null; toast('Geometry failed: ' + (e.message || e)); return; }
    const fk = `${T.W}|${T.D}|${T.H}`;
    if (S.tab === '3d') { showMesh(fk !== lastFitKey); lastFitKey = fk; } else three.dirty = true;
    renderPart();
  }

  // ---------------------------------------------------------------- export
  async function exportPart(kind) {
    if (!M) return toast('Geometry engine is still loading.');
    clearTimeout(buildT); rebuild();
    if (!S.build) return;
    const base = (S.name || 'kit-tray').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'kit-tray';
    const inArtifact = !!window.claude;
    const dl = inArtifact ? await window.claude.use('downloads') : null;
    try {
      if (dl) {
        // The viewer only saves a fixed list of types; .3mf/.stl ride inside a zip.
        const files = [];
        if (kind !== 'stl') files.push({ name: base + '.3mf', data: G.to3MF(S.build.mesh, base) });
        if (kind !== '3mf') files.push({ name: base + '.stl', data: G.toSTL(S.build.mesh, base) });
        const zip = G.zipStore(files);
        await dl.save({ filename: base + '.zip', data: new Blob([zip]) });
        toast('Saved ' + base + '.zip');
      } else if (!inArtifact) {
        const data = kind === 'stl' ? G.toSTL(S.build.mesh, base) : G.to3MF(S.build.mesh, base);
        const blob = new Blob([data], { type: kind === 'stl' ? 'model/stl' : 'model/3mf' });
        const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = base + '.' + kind;
        document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      } else toast('Saving files isn\'t available in this view.');
    } catch (e) {
      if (e && e.code === 'declined') return;
      toast('Save failed: ' + (e && (e.message || e.code) || e));
    }
  }
  function renderExportButtons() {
    const inArtifact = !!window.claude;
    const html = inArtifact
      ? `<button class="btn primary" data-exp="both">Export 3MF + STL</button>`
      : `<button class="btn primary" data-exp="3mf">Export 3MF</button><button class="btn" data-exp="stl">STL</button>`;
    $('exportBtns').innerHTML = html; $('exportBtns2').innerHTML = html;
    $('exportNote').textContent = inArtifact
      ? 'Arrives as a .zip holding the .3mf and .stl (the Claude viewer only saves a fixed set of file types). Hosted on its own, this page saves .3mf and .stl directly.'
      : 'Millimetres, Z up, tray on the plate at the origin.';
  }
  document.addEventListener('click', e => { const b = e.target.closest('[data-exp]'); if (b) exportPart(b.dataset.exp); });

  // ---------------------------------------------------------------- panel
  function busy(msg) { $('busy').textContent = msg ? msg + '…' : ''; }
  function setTab(tab) {
    S.tab = tab;
    document.querySelectorAll('[data-tab]').forEach(b => b.setAttribute('aria-selected', b.dataset.tab === tab));
    ['photo', 'layout', '3d'].forEach(k => { $('v-' + k).hidden = k !== tab; document.querySelector(`[data-for="${k}"]`).hidden = k !== tab; });
    requestAnimationFrame(() => {
      if (tab === 'photo') drawPhoto();
      if (tab === 'layout') drawLayout();
      if (tab === '3d') { initThree(); sizeThree(); if (three.dirty || !three.mesh) { showMesh(true); three.dirty = false; } }
      renderHud();
    });
  }
  document.querySelectorAll('[data-tab]').forEach(b => b.addEventListener('click', () => setTab(b.dataset.tab)));

  function renderHud() {
    const hud = $('hud'); const chips = [];
    if (S.tab === 'photo') {
      if (S.dims) chips.push(['', `${S.dims.name} ${S.paper.landscape ? 'landscape' : 'portrait'}`]);
      chips.push(['', `${S.tools.length} tool${S.tools.length === 1 ? '' : 's'} traced`]);
    } else {
      (S._checks || checks()).list.forEach(c => chips.push(c));
    }
    hud.innerHTML = chips.map(([k, t]) => `<span class="chip ${k}">${esc(t)}</span>`).join('');
  }

  function renderPhotoPanel() {
    $('sensV').textContent = S.sens.toFixed(2);
    const rows = [];
    if (S.aspect) rows.push(['Sheet aspect (corrected)', S.aspect.ratio.toFixed(3) + (S.paperMode === 'auto' ? ` → ${S.dims.name}` : '')]);
    if (S.pose) {
      rows.push(['Camera height', fmt(S.pose.height, 0) + ' mm']);
    }
    $('camReadout').innerHTML = rows.map(([a, b]) => `<dt>${a}</dt><dd>${b}</dd>`).join('');
    $('traceReadout').innerHTML = S.tools.map(t => { const b = bounds([t.raw]); return `<dt>${esc(t.name)}</dt><dd>${fmt(Math.max(b.w, b.h))} × ${fmt(Math.min(b.w, b.h))}</dd>`; }).join('') || '<dt>No tools found</dt><dd></dd>';
  }

  const trayFields = ['W', 'D', 'H', 'floor', 'wall', 'web', 'clearance', 'smooth', 'outerChamfer', 'lipChamfer', 'floorChamfer'];
  function renderTrayPanel() {
    const T = S.tray, ae = document.activeElement;
    trayFields.forEach(k => { const el = $(k); if (el !== ae) el.value = +fmt(T[k], 2); });
    $('W').readOnly = $('D').readOnly = T.mode === 'hug';
    $('pdepth').value = fmt(T.H - T.floor, 1);
    $('modeHug').setAttribute('aria-pressed', T.mode === 'hug'); $('modeFixed').setAttribute('aria-pressed', T.mode === 'fixed');
    $('wallF').querySelector('label').textContent = T.mode === 'hug' ? 'Edge margin' : 'Arrange margin';
  }

  function renderTools() {
    const list = $('toolList');
    list.innerHTML = S.tools.length ? S.tools.map(t => {
      const [a, b] = toolDims(t);
      return `<button class="tool" data-tool="${t.id}" aria-pressed="${t.id === S.sel}"><span class="dot"></span><span class="nm">${esc(t.name)}</span><span class="dm">${fmt(a, 0)}×${fmt(b, 0)}</span></button>`;
    }).join('') : '<div class="empty">No tools yet. Trace a photo first.</div>';
    const t = S.tools.find(t => t.id === S.sel);
    const det = $('toolDetail');
    if (!t) { det.innerHTML = ''; return; }
    const ae = document.activeElement && document.activeElement.id;
    det.innerHTML = `<div class="detail">
      <div class="f"><label for="tName">Name</label><input type="text" id="tName" value="${esc(t.name)}"></div>
      <div class="f"><label for="tRot">Rotation <span style="font-family:var(--f-num)">${fmt(((t.rot % 360) + 540) % 360 - 180, 0)}°</span></label>
        <input type="range" id="tRot" min="-180" max="180" step="1" value="${fmt(((t.rot % 360) + 540) % 360 - 180, 0)}"></div>
      <div class="row"><button class="btn small" data-rot="-90">−90°</button><button class="btn small" data-rot="90">+90°</button><button class="btn small" data-rot="180">180°</button><button class="btn small" data-rot="-1">−1°</button><button class="btn small" data-rot="1">+1°</button></div>
      <div class="grid3">
        <div class="f"><label for="tH">Silhouette height</label><div class="unit" data-u="mm"><input type="number" id="tH" step="0.5" min="0" value="${t.h}"></div></div>
        <div class="f"><label for="tSm">Smoothing</label><div class="unit" data-u="mm"><input type="number" id="tSm" step="0.5" min="0" placeholder="${S.tray.smooth}" value="${t.sm != null ? t.sm : ''}"></div></div>
        <div class="f"><label for="tClr">Clearance</label><div class="unit" data-u="mm"><input type="number" id="tClr" step="0.1" min="0" placeholder="${S.tray.clearance}" value="${t.clr != null ? t.clr : ''}"></div></div>
      </div>
      <div class="note">Silhouette height is how far above the paper the tool's widest edge sits. It pulls the trace in to cancel camera parallax${S.pose ? ` (camera ${fmt(S.pose.height, 0)} mm up)` : ''}. Blank smoothing or clearance uses the tray value.</div>
      <div class="row" style="justify-content:space-between"><span class="lab" style="font-size:12px;color:var(--muted)">Finger scoops</span><button class="btn small" id="addScoop">Add scoop</button></div>
      ${t.scoops.map(s => `<div class="scoop" data-scoop="${s.id}">
        <div class="f"><label for="sl${s.id}">Length</label><input type="number" id="sl${s.id}" data-k="len" step="1" min="5" value="${fmt(s.len, 0)}"></div>
        <div class="f"><label for="sr${s.id}">Radius</label><input type="number" id="sr${s.id}" data-k="r" step="0.5" min="3" value="${fmt(s.r, 1)}"></div>
        <div class="f"><label for="sa${s.id}">Angle °</label><input type="number" id="sa${s.id}" data-k="a" step="5" value="${fmt(s.a, 0)}"></div>
        <button class="btn small" data-delscoop="${s.id}" aria-label="Remove scoop">✕</button></div>`).join('')}
      <button class="btn small" id="delTool" style="justify-self:start;color:var(--bad)">Remove tool</button>
    </div>`;
    if (ae && $(ae)) { const el = $(ae); el.focus(); if (el.setSelectionRange && el.type === 'text') el.setSelectionRange(el.value.length, el.value.length); }
  }

  function renderPart() {
    const T = S.tray, b = S.build;
    const rows = [
      ['Envelope', `${fmt(T.W, 1)} × ${fmt(T.D, 1)} × ${fmt(T.H, 1)}`],
      ['Pocket depth', fmt(T.H - T.floor, 1)],
      ['Tools', S.tools.length],
    ];
    if (b) {
      rows.push(['Solid volume', fmt(b.volume / 1000, 1) + ' cm³']);
      rows.push(['PLA at 100 %', '≈ ' + fmt(b.volume / 1000 * 1.24, 0) + ' g']);
      rows.push(['Triangles', b.tris.toLocaleString()]);
    }
    $('partReadout').innerHTML = rows.map(([a, v]) => `<dt>${a}</dt><dd>${v}</dd>`).join('');
  }

  function renderPanel() {
    if (S.tab === 'photo') renderPhotoPanel();
    renderTrayPanel(); renderTools(); renderPart();
  }
  function renderAll() {
    commit();
    S._checks = checks();
    renderPanel(); renderHud();
    if (S.tab === 'photo') drawPhoto(); else if (S.tab === 'layout') drawLayout();
    clearTimeout(buildT); buildT = setTimeout(rebuild, 60);
  }

  // ---------------------------------------------------------------- wiring
  ['fileCam', 'fileAny'].forEach(id => $(id).addEventListener('change', e => { loadFile(e.target.files[0]); e.target.value = ''; }));
  const drop = $('drop');
  ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('on'); }));
  ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('on'); }));
  drop.addEventListener('drop', e => { const f = e.dataTransfer.files[0]; if (f) loadFile(f); });
  document.addEventListener('paste', e => { const f = [...(e.clipboardData || {}).files || []].find(f => f.type.startsWith('image/')); if (f) loadFile(f); });
  $('btnSample').addEventListener('click', loadSample);
  $('paper').addEventListener('change', e => { S.paperMode = e.target.value; retrace(); });
  $('f35').addEventListener('change', e => { const v = +e.target.value; if (v > 5) { S.f35 = v; retrace(); } });
  let sensT;
  ['sens', 'sens2'].forEach(id => $(id).addEventListener('input', e => {
    S.sens = +e.target.value; $('sens').value = $('sens2').value = S.sens;
    $('sensV').textContent = $('sensV2').textContent = S.sens.toFixed(2);
    clearTimeout(sensT); sensT = setTimeout(retrace, 180);
  }));
  $('minArea').addEventListener('change', e => { S.minArea = Math.max(10, +e.target.value || 150); retrace(); });
  $('btnRedetect').addEventListener('click', () => S.img && detect());
  $('btnToLayout').addEventListener('click', () => setTab('layout'));

  trayFields.forEach(k => $(k).addEventListener('change', e => {
    const v = parseFloat(e.target.value); if (!isFinite(v)) return renderTrayPanel();
    const T = S.tray;
    const lim = { W: [20, 600], D: [20, 600], H: [3, 200], floor: [0.4, 50], wall: [1, 60], web: [0.8, 30], clearance: [0, 5], smooth: [0, 15], outerChamfer: [0, 5], lipChamfer: [0, 5], floorChamfer: [0, 5] }[k];
    T[k] = Math.max(lim[0], Math.min(lim[1], v));
    if (T.floor > T.H - 0.6) T.floor = Math.max(0.4, T.H - 0.6);
    if (k === 'clearance' || k === 'smooth' || k === 'wall' || k === 'web') normalize(false);
    changed();
  }));
  $('modeHug').addEventListener('click', () => { S.tray.mode = 'hug'; normalize(false); changed(); });
  $('modeFixed').addEventListener('click', () => { S.tray.mode = 'fixed'; changed(); });
  $('btnArrange').addEventListener('click', () => { arrange(); changed(); });
  $('fname').addEventListener('input', e => { S.name = e.target.value; });

  const panel = $('panel');
  panel.addEventListener('click', e => {
    const tb = e.target.closest('[data-tool]');
    if (tb) { S.sel = +tb.dataset.tool; renderTools(); drawLayout(); return; }
    const t = S.tools.find(t => t.id === S.sel); if (!t) return;
    const rb = e.target.closest('[data-rot]');
    if (rb) { t.rot += +rb.dataset.rot; normalize(false); changed(); return; }
    if (e.target.id === 'addScoop') { addScoop(t); return; }
    const ds = e.target.closest('[data-delscoop]');
    if (ds) { t.scoops = t.scoops.filter(s => s.id !== +ds.dataset.delscoop); normalize(false); changed(); return; }
    if (e.target.id === 'delTool') { S.tools = S.tools.filter(x => x !== t); S.sel = S.tools[0] ? S.tools[0].id : null; normalize(false); changed(); }
  });
  panel.addEventListener('input', e => {
    const t = S.tools.find(t => t.id === S.sel); if (!t) return;
    if (e.target.id === 'tName') { t.name = e.target.value || 'Tool'; drawLayout(); const nm = panel.querySelector(`[data-tool="${t.id}"] .nm`); if (nm) nm.textContent = t.name; }
    if (e.target.id === 'tRot') { t.rot = +e.target.value; drawLayout(); clearTimeout(t._rt); t._rt = setTimeout(() => { normalize(false); changed(); }, 120); }
  });
  panel.addEventListener('change', e => {
    const t = S.tools.find(t => t.id === S.sel); if (!t) return;
    if (e.target.id === 'tH') { t.h = Math.max(0, +e.target.value || 0); normalize(false); changed(); }
    if (e.target.id === 'tSm') { t.sm = e.target.value === '' ? null : Math.max(0, Math.min(15, +e.target.value)); normalize(false); changed(); }
    if (e.target.id === 'tClr') { t.clr = e.target.value === '' ? null : Math.max(0, +e.target.value); normalize(false); changed(); }
    const sc = e.target.closest('[data-scoop]');
    if (sc) {
      const s = t.scoops.find(s => s.id === +sc.dataset.scoop), k = e.target.dataset.k, v = +e.target.value;
      if (s && isFinite(v)) { s[k] = k === 'len' ? Math.max(5, v) : k === 'r' ? Math.max(3, v) : v; normalize(false); changed(); }
    }
  });

  new ResizeObserver(() => { if (S.tab === 'photo') drawPhoto(); else if (S.tab === 'layout') drawLayout(); else sizeThree(); }).observe($('stage'));

  // ---------------------------------------------------------------- sample photo
  // A Letter sheet shot from ~33 cm with 12° of tilt: a 10 mm combination wrench and a screwdriver.
  function loadSample() {
    const PW = 1800, PH = 1350;
    const sheetPPM = 5, sw = Math.round(279.4 * sheetPPM), sh = Math.round(215.9 * sheetPPM);
    const sc = document.createElement('canvas'); sc.width = sw; sc.height = sh;
    const c = sc.getContext('2d');
    c.fillStyle = '#F2F0EA'; c.fillRect(0, 0, sw, sh);
    const mm = v => v * sheetPPM;
    const wrench = (ctx) => {
      ctx.beginPath(); ctx.rect(mm(42), mm(80), mm(130), mm(11)); ctx.fill();
      ctx.beginPath(); ctx.arc(mm(40), mm(85.5), mm(13), 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.moveTo(mm(168), mm(79)); ctx.lineTo(mm(186), mm(70)); ctx.lineTo(mm(200), mm(76)); ctx.lineTo(mm(190), mm(83)); ctx.lineTo(mm(198), mm(91)); ctx.lineTo(mm(185), mm(100)); ctx.lineTo(mm(168), mm(92)); ctx.closePath(); ctx.fill();
    };
    const driver = (ctx, handle, shaft) => {
      ctx.fillStyle = handle; ctx.beginPath(); ctx.roundRect ? ctx.roundRect(mm(48), mm(140), mm(100), mm(28), mm(10)) : ctx.rect(mm(48), mm(140), mm(100), mm(28)); ctx.fill();
      ctx.fillStyle = shaft; ctx.fillRect(mm(148), mm(151.5), mm(82), mm(5)); ctx.fillRect(mm(230), mm(152.5), mm(4), mm(3));
    };
    c.save(); c.filter = 'blur(6px)'; c.globalAlpha = 0.35; c.fillStyle = '#000'; c.translate(mm(2.5), mm(2.5)); wrench(c); driver(c, '#000', '#000'); c.restore();
    c.fillStyle = '#3B3F44'; wrench(c);
    c.fillStyle = '#F2F0EA'; c.beginPath(); c.arc(mm(40), mm(85.5), mm(6.5), 0, Math.PI * 2); c.fill();
    driver(c, '#C2412E', '#9DA2A8');
    const grad = c.createLinearGradient(0, 0, sw, sh); grad.addColorStop(0, 'rgba(0,0,0,0)'); grad.addColorStop(1, 'rgba(40,30,10,.16)');
    c.fillStyle = grad; c.fillRect(0, 0, sw, sh);
    const sheet = c.getImageData(0, 0, sw, sh).data;

    // project into a photo through the pinhole model
    const quad = [[462.7, 281.9], [1605.6, 355.0], [1623.1, 1293.0], [314.8, 1196.9]].map(([x, y]) => [x * PW / 2000, y * PH / 1500]);
    const Hinv = V.homography(quad, [[0, 0], [279.4, 0], [279.4, 215.9], [0, 215.9]]);
    const pc = document.createElement('canvas'); pc.width = PW; pc.height = PH;
    const pctx = pc.getContext('2d');
    const out = pctx.createImageData(PW, PH), o = out.data;
    for (let y = 0; y < PH; y++) for (let x = 0; x < PW; x++) {
      const i = (y * PW + x) * 4;
      const [u, v] = V.applyH(Hinv, x + 0.5, y + 0.5);
      if (u >= 0 && v >= 0 && u < 279.4 && v < 215.9) {
        const j = ((Math.floor(v * sheetPPM)) * sw + Math.floor(u * sheetPPM)) * 4;
        o[i] = sheet[j]; o[i + 1] = sheet[j + 1]; o[i + 2] = sheet[j + 2];
      } else {
        const n = ((x * 13 + y * 7) % 23) - 11, grain = Math.sin(y * 0.05 + Math.sin(x * 0.004) * 6) * 6;
        o[i] = 74 + n + grain; o[i + 1] = 55 + n * 0.8 + grain * 0.7; o[i + 2] = 42 + n * 0.6 + grain * 0.5;
      }
      o[i + 3] = 255;
    }
    pctx.putImageData(out, 0, 0);
    S.sampleNames = [{ name: 'Screwdriver', h: 24 }, { name: '10 mm wrench', h: 6 }];
    S.f35 = 26; $('f35').value = 26;
    setImage(pc, PW, PH, null, 'Sample photo (synthetic)');
    // a starter scoop on the screwdriver so the feature shows
    const drv = S.tools.find(t => t.name === 'Screwdriver');
    if (drv) {
      const lp = localPoly(drv), a = pcaAngle(lp) + Math.PI / 2;
      drv.scoops.push({ id: S.nextId++, u: -12, v: 0, a: deg(a), len: 44, r: 12 });
      normalize(false); changed();
    }
  }

  // ---------------------------------------------------------------- boot
  async function bootGeometry() {
    busy('Loading geometry engine');
    try {
      const b64 = document.getElementById('mfwasm').textContent.trim();
      const bin = Uint8Array.from(atob(b64), ch => ch.charCodeAt(0));
      M = await window.ManifoldModule({ wasmBinary: bin, locateFile: () => 'manifold.wasm' });
      M.setup();
      secCache.clear();
      busy('');
      normalize(false);
      renderAll();
    } catch (e) {
      busy(''); toast('Geometry engine failed to load: ' + (e.message || e));
    }
  }
  window.__kitbench = S;
  renderExportButtons();
  loadSample();
  setTab('photo');
  bootGeometry();
})();
