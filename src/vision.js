// Photo → paper quad → rectified mm raster → tool outlines (mm, paper plane, y down).
// Pure functions over ImageData-like objects {data, width, height}.
(function (root) {
  'use strict';

  const PAPERS = {
    letter: { name: 'Letter', long: 279.4, short: 215.9 },
    a4: { name: 'A4', long: 297.0, short: 210.0 },
  };

  function toGray(img) {
    const { data, width: w, height: h } = img;
    const g = new Float32Array(w * h);
    for (let i = 0, j = 0; i < g.length; i++, j += 4) g[i] = 0.299 * data[j] + 0.587 * data[j + 1] + 0.114 * data[j + 2];
    return g;
  }

  function otsu(g) {
    const hist = new Float64Array(256);
    for (let i = 0; i < g.length; i++) hist[Math.max(0, Math.min(255, g[i] | 0))]++;
    let sum = 0; for (let t = 0; t < 256; t++) sum += t * hist[t];
    let sB = 0, wB = 0, best = 0, thr = 128;
    for (let t = 0; t < 256; t++) {
      wB += hist[t]; if (!wB) continue;
      const wF = g.length - wB; if (!wF) break;
      sB += t * hist[t];
      const mB = sB / wB, mF = (sum - sB) / wF;
      const v = wB * wF * (mB - mF) * (mB - mF);
      if (v > best) { best = v; thr = t; }
    }
    return thr;
  }

  // Label connected components of mask (4-connected). Returns {labels, areas}.
  function components(mask, w, h) {
    const labels = new Int32Array(w * h);
    const areas = [0];
    const stack = new Int32Array(w * h);
    let next = 1;
    for (let i = 0; i < w * h; i++) {
      if (!mask[i] || labels[i]) continue;
      let sp = 0, area = 0;
      stack[sp++] = i; labels[i] = next;
      while (sp) {
        const p = stack[--sp]; area++;
        const x = p % w, y = (p / w) | 0;
        if (x > 0 && mask[p - 1] && !labels[p - 1]) { labels[p - 1] = next; stack[sp++] = p - 1; }
        if (x < w - 1 && mask[p + 1] && !labels[p + 1]) { labels[p + 1] = next; stack[sp++] = p + 1; }
        if (y > 0 && mask[p - w] && !labels[p - w]) { labels[p - w] = next; stack[sp++] = p - w; }
        if (y < h - 1 && mask[p + w] && !labels[p + w]) { labels[p + w] = next; stack[sp++] = p + w; }
      }
      areas.push(area); next++;
    }
    return { labels, areas };
  }

  function convexHull(pts) {
    pts = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lo = [], up = [];
    for (const p of pts) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
    for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
    up.pop(); lo.pop();
    return lo.concat(up);
  }

  // Order 4 points TL, TR, BR, BL (image coords, y down).
  function orderQuad(q) {
    const cx = q.reduce((a, p) => a + p[0], 0) / 4, cy = q.reduce((a, p) => a + p[1], 0) / 4;
    const s = q.slice().sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx));
    // atan2 order starts near -pi (left), goes up (TL), right (TR)... rotate so first is the one with min x+y
    let k = 0, best = Infinity;
    s.forEach((p, i) => { if (p[0] + p[1] < best) { best = p[0] + p[1]; k = i; } });
    return [0, 1, 2, 3].map(i => s[(k + i) % 4]);
  }

  function quadFromHull(hull) {
    const cx = hull.reduce((s, p) => s + p[0], 0) / hull.length, cy = hull.reduce((s, p) => s + p[1], 0) / hull.length;
    const far = (from) => hull.reduce((m, p) => (Math.hypot(p[0] - from[0], p[1] - from[1]) > Math.hypot(m[0] - from[0], m[1] - from[1]) ? p : m), hull[0]);
    const p1 = far([cx, cy]), p2 = far(p1);
    let p3 = null, p4 = null, d3 = 0, d4 = 0;
    for (const p of hull) {
      const d = ((p2[0] - p1[0]) * (p[1] - p1[1]) - (p2[1] - p1[1]) * (p[0] - p1[0]));
      if (d > d3) { d3 = d; p3 = p; } if (d < d4) { d4 = d; p4 = p; }
    }
    if (!p3 || !p4) return null;
    return orderQuad([p1, p3, p2, p4]);
  }
  const polyAreaAbs = p => Math.abs(polyArea(p));

  // Find the sheet. Light floors (concrete, wood) can be nearly as bright as paper, so try a
  // ladder of thresholds and keep the bright blob that is most sheet-like: big, clear of the
  // image border, and well described by four corners.
  function detectPaper(img) {
    const { width: w, height: h, data } = img;
    // "Whiteness": darkest channel minus a colour-cast penalty. Paper is bright in all three
    // channels and neutral; concrete, wood and cardboard are warm, so their blue channel drops.
    const g = new Float32Array(w * h);
    for (let i = 0, j = 0; i < g.length; i++, j += 4) {
      const r = data[j], gg = data[j + 1], b = data[j + 2];
      const mx = Math.max(r, gg, b), mn = Math.min(r, gg, b);
      g[i] = mn - 0.5 * (mx - mn);
    }
    const sorted = Float32Array.from(g).sort();
    const pct = q => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
    const ts = [otsu(g)];
    for (const q of [0.5, 0.6, 0.7, 0.78, 0.85, 0.9, 0.94]) ts.push(pct(q));
    let best = null;
    for (const t of ts) {
      const mask = new Uint8Array(w * h);
      for (let i = 0; i < g.length; i++) mask[i] = g[i] > t ? 1 : 0;
      const { labels, areas } = components(mask, w, h);
      const border = new Int32Array(areas.length);
      for (let x = 0; x < w; x++) { border[labels[x]]++; border[labels[(h - 1) * w + x]]++; }
      for (let y = 0; y < h; y++) { border[labels[y * w]]++; border[labels[y * w + w - 1]]++; }
      // candidate components: the 4 largest
      const idx = []; for (let L = 1; L < areas.length; L++) if (areas[L] > w * h * 0.03) idx.push(L);
      idx.sort((a, b) => areas[b] - areas[a]);
      for (const L of idx.slice(0, 4)) {
        if (border[L] > (w + h) * 0.04) continue;          // floods out to the image edge: floor, not paper
        const pts = [];
        for (let y = 0; y < h; y++) {
          let a = -1, b = -1;
          for (let x = 0; x < w; x++) if (labels[y * w + x] === L) { if (a < 0) a = x; b = x; }
          if (a >= 0) { pts.push([a, y]); pts.push([b + 1, y]); }
        }
        const hull = convexHull(pts);
        const q = quadFromHull(hull);
        if (!q) continue;
        const qa = polyAreaAbs(q), ha = polyAreaAbs(hull);
        const fit = qa / ha;                                 // ~1 for a clean rectangle
        const fill = areas[L] / ha;                          // tools on the sheet lower this; floor speckle lowers it a lot
        if (fit < 0.9 || fill < 0.12) continue;           // tools can cover most of the sheet
        const score = ha * Math.pow(fit, 4);
        if (!best || score > best.score) best = { score, q };
      }
    }
    return best ? best.q : null;
  }

  // True aspect of the photographed rectangle (Zhang & He, whiteboard rectification).
  // Undoes perspective so a tilted Letter sheet isn't mistaken for A4.
  // q: TL,TR,BR,BL in image px. pp: principal point. fpx: fallback focal length in px.
  function rectAspect(q, pp, fpx) {
    const h = p => [p[0] - pp[0], p[1] - pp[1], 1];
    const m1 = h(q[0]), m2 = h(q[1]), m3 = h(q[3]), m4 = h(q[2]);
    const cr = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const k2 = dot(cr(m1, m4), m3) / dot(cr(m2, m4), m3);
    const k3 = dot(cr(m1, m4), m2) / dot(cr(m3, m4), m2);
    const n2 = [k2 * m2[0] - m1[0], k2 * m2[1] - m1[1], k2 - 1];
    const n3 = [k3 * m3[0] - m1[0], k3 * m3[1] - m1[1], k3 - 1];
    let f2 = -(n2[0] * n3[0] + n2[1] * n3[1]) / (n2[2] * n3[2]);
    const fb = fpx * fpx;
    // Near-frontal shots make f unobservable; fall back to the lens estimate.
    if (!isFinite(f2) || f2 <= 0 || Math.abs(n2[2] * n3[2]) < 1e-6 || f2 < fb * 0.25 || f2 > fb * 4) f2 = fb;
    const a = (n2[0] * n2[0] + n2[1] * n2[1]) / f2 + n2[2] * n2[2];
    const b = (n3[0] * n3[0] + n3[1] * n3[1]) / f2 + n3[2] * n3[2];
    return Math.sqrt(a / b); // width / height
  }

  // Letter vs A4 + orientation from the perspective-corrected aspect.
  function guessPaper(q, imgW, imgH, f35) {
    const fpx = Math.max(imgW, imgH) / 2 * (f35 || 26) / 18;
    const wh = rectAspect(q, [imgW / 2, imgH / 2], fpx);
    const landscape = wh >= 1;
    const ratio = landscape ? wh : 1 / wh;
    return { key: ratio < 1.354 ? 'letter' : 'a4', landscape, ratio };
  }

  // Homography solving dst = H * src for 4 point pairs.
  function homography(src, dst) {
    const A = [], b = [];
    for (let i = 0; i < 4; i++) {
      const [x, y] = src[i], [u, v] = dst[i];
      A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
      A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
    }
    const n = 8;
    for (let c = 0; c < n; c++) {
      let piv = c; for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
      [A[c], A[piv]] = [A[piv], A[c]]; [b[c], b[piv]] = [b[piv], b[c]];
      for (let r = 0; r < n; r++) {
        if (r === c) continue;
        const f = A[r][c] / A[c][c];
        for (let k = c; k < n; k++) A[r][k] -= f * A[c][k];
        b[r] -= f * b[c];
      }
    }
    const hh = b.map((v, i) => v / A[i][i]);
    return [hh[0], hh[1], hh[2], hh[3], hh[4], hh[5], hh[6], hh[7], 1];
  }
  function applyH(H, x, y) {
    const w = H[6] * x + H[7] * y + H[8];
    return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
  }

  // Camera height above the sheet and the point directly beneath the lens (paper mm),
  // from the mm→px homography and an assumed pinhole K. Drives parallax correction.
  function cameraPose(Hm, pp, fpx) {
    const col = c => [(Hm[c] - pp[0] * Hm[6 + c]) / fpx, (Hm[3 + c] - pp[1] * Hm[6 + c]) / fpx, Hm[6 + c]];
    const c1 = col(0), c2 = col(1), c3 = col(2);
    const n = v => Math.hypot(v[0], v[1], v[2]);
    let lam = 2 / (n(c1) + n(c2));
    if (c3[2] * lam < 0) lam = -lam;
    const r1 = c1.map(v => v * lam), r2 = c2.map(v => v * lam), t = c3.map(v => v * lam);
    const r3 = [r1[1] * r2[2] - r1[2] * r2[1], r1[2] * r2[0] - r1[0] * r2[2], r1[0] * r2[1] - r1[1] * r2[0]];
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    return { height: Math.abs(dot(r3, t)), nadir: [-dot(r1, t), -dot(r2, t)] };
  }

  // Move an outline traced at the paper plane back to the true footprint of an edge h mm up.
  function parallaxCorrect(poly, pose, h) {
    if (!h || !pose || pose.height <= h + 5) return poly;
    const s = (pose.height - h) / pose.height, [nx, ny] = pose.nadir;
    return poly.map(([x, y]) => [nx + (x - nx) * s, ny + (y - ny) * s]);
  }

  function paperDims(key, landscape) {
    const p = PAPERS[key];
    return landscape ? { w: p.long, h: p.short, name: p.name } : { w: p.short, h: p.long, name: p.name };
  }

  // Warp source image into a mm-scaled raster of the sheet.
  function rectify(img, quad, dims, ppm) {
    const W = Math.round(dims.w * ppm), Hh = Math.round(dims.h * ppm);
    const Hm = homography([[0, 0], [dims.w, 0], [dims.w, dims.h], [0, dims.h]], quad); // mm -> image px
    const out = new Uint8ClampedArray(W * Hh * 4);
    const { data, width: sw, height: sh } = img;
    for (let y = 0; y < Hh; y++) {
      for (let x = 0; x < W; x++) {
        const [u, v] = applyH(Hm, (x + 0.5) / ppm, (y + 0.5) / ppm);
        const x0 = Math.floor(u - 0.5), y0 = Math.floor(v - 0.5);
        const fx = u - 0.5 - x0, fy = v - 0.5 - y0;
        const o = (y * W + x) * 4;
        if (x0 < 0 || y0 < 0 || x0 + 1 >= sw || y0 + 1 >= sh) { out[o] = out[o + 1] = out[o + 2] = 255; out[o + 3] = 255; continue; }
        const i00 = (y0 * sw + x0) * 4, i10 = i00 + 4, i01 = i00 + sw * 4, i11 = i01 + 4;
        for (let c = 0; c < 3; c++) {
          out[o + c] = (data[i00 + c] * (1 - fx) + data[i10 + c] * fx) * (1 - fy) + (data[i01 + c] * (1 - fx) + data[i11 + c] * fx) * fy;
        }
        out[o + 3] = 255;
      }
    }
    return { data: out, width: W, height: Hh, Hm };
  }

  // Paper illumination map from block maxima, so shading across the sheet doesn't read as a tool.
  function illumination(g, w, h, block) {
    const bw = Math.ceil(w / block), bh = Math.ceil(h / block);
    const B = new Float32Array(bw * bh);
    for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
      const vals = [];
      for (let y = by * block; y < Math.min(h, (by + 1) * block); y += 2)
        for (let x = bx * block; x < Math.min(w, (bx + 1) * block); x += 2) vals.push(g[y * w + x]);
      vals.sort((a, b) => a - b);
      B[by * bw + bx] = vals[Math.floor(vals.length * 0.9)] || 0;
    }
    const sorted = Array.from(B).sort((a, b) => a - b);
    const med = sorted[sorted.length >> 1];
    const ok = new Uint8Array(bw * bh);
    for (let i = 0; i < B.length; i++) ok[i] = B[i] > med * 0.8 ? 1 : 0;
    // Fill blocks covered by tools from good neighbours.
    for (let pass = 0; pass < 40; pass++) {
      let changed = 0;
      const nB = B.slice(), nOk = ok.slice();
      for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
        const i = by * bw + bx; if (ok[i]) continue;
        let s = 0, c = 0;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
          const X = bx + dx, Y = by + dy;
          if (X < 0 || Y < 0 || X >= bw || Y >= bh) continue;
          const j = Y * bw + X; if (ok[j]) { s += B[j]; c++; }
        }
        if (c) { nB[i] = s / c; nOk[i] = 1; changed++; }
      }
      B.set(nB); ok.set(nOk);
      if (!changed) break;
    }
    for (let i = 0; i < B.length; i++) if (!ok[i]) B[i] = med;
    const bg = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      const fy = Math.min(bh - 1.0001, Math.max(0, (y + 0.5) / block - 0.5)), y0 = Math.floor(fy), ty = fy - y0, y1 = Math.min(bh - 1, y0 + 1);
      for (let x = 0; x < w; x++) {
        const fx = Math.min(bw - 1.0001, Math.max(0, (x + 0.5) / block - 0.5)), x0 = Math.floor(fx), tx = fx - x0, x1 = Math.min(bw - 1, x0 + 1);
        bg[y * w + x] = (B[y0 * bw + x0] * (1 - tx) + B[y0 * bw + x1] * tx) * (1 - ty) + (B[y1 * bw + x0] * (1 - tx) + B[y1 * bw + x1] * tx) * ty;
      }
    }
    return bg;
  }

  // Binary morphology with a square window via prefix sums. mode: 'dilate' | 'erode'
  function morph(mask, w, h, r, mode) {
    if (r < 1) return mask;
    const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h);
    const win = 2 * r + 1;
    const row = new Int32Array(w + 1);
    for (let y = 0; y < h; y++) {
      row[0] = 0;
      for (let x = 0; x < w; x++) row[x + 1] = row[x] + mask[y * w + x];
      for (let x = 0; x < w; x++) {
        const a = Math.max(0, x - r), b = Math.min(w, x + r + 1);
        const s = row[b] - row[a];
        tmp[y * w + x] = mode === 'dilate' ? (s > 0 ? 1 : 0) : (s === b - a && b - a === win ? 1 : 0);
      }
    }
    const col = new Int32Array(h + 1);
    for (let x = 0; x < w; x++) {
      col[0] = 0;
      for (let y = 0; y < h; y++) col[y + 1] = col[y] + tmp[y * w + x];
      for (let y = 0; y < h; y++) {
        const a = Math.max(0, y - r), b = Math.min(h, y + r + 1);
        const s = col[b] - col[a];
        out[y * w + x] = mode === 'dilate' ? (s > 0 ? 1 : 0) : (s === b - a && b - a === win ? 1 : 0);
      }
    }
    return out;
  }

  function fillHoles(mask, w, h) {
    const outside = new Uint8Array(w * h);
    const stack = [];
    const push = i => { if (!mask[i] && !outside[i]) { outside[i] = 1; stack.push(i); } };
    for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
    for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
    while (stack.length) {
      const p = stack.pop(), x = p % w, y = (p / w) | 0;
      if (x > 0) push(p - 1); if (x < w - 1) push(p + 1); if (y > 0) push(p - w); if (y < h - 1) push(p + w);
    }
    const out = new Uint8Array(w * h);
    for (let i = 0; i < out.length; i++) out[i] = outside[i] ? 0 : 1;
    return out;
  }

  // Moore-neighbour boundary trace of component L starting at its first raster pixel.
  function traceBoundary(labels, w, h, L, start) {
    const D = [[-1, 0], [-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1]];
    const at = (x, y) => x >= 0 && y >= 0 && x < w && y < h && labels[y * w + x] === L;
    const sx = start % w, sy = (start / w) | 0;
    const pts = [[sx, sy]];
    let cx = sx, cy = sy, bdir = 0; // backtrack is West of start
    const startB = 0;
    for (let guard = 0; guard < w * h * 2; guard++) {
      let found = false;
      for (let k = 1; k <= 8; k++) {
        const d = (bdir + k) % 8;
        const nx = cx + D[d][0], ny = cy + D[d][1];
        if (at(nx, ny)) {
          const pd = (bdir + k - 1) % 8;           // last background neighbour checked
          const bx = cx + D[pd][0], by = cy + D[pd][1];
          cx = nx; cy = ny;
          // new backtrack direction, relative to new current
          const rdx = bx - cx, rdy = by - cy;
          bdir = D.findIndex(v => v[0] === rdx && v[1] === rdy);
          found = true; break;
        }
      }
      if (!found) break;                            // isolated pixel
      if (cx === sx && cy === sy && bdir === startB) break;
      if (cx === sx && cy === sy && pts.length > 2) break;
      pts.push([cx, cy]);
    }
    return pts;
  }

  function rdp(pts, eps) {
    if (pts.length < 4) return pts;
    const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
    const stack = [[0, pts.length - 1]];
    while (stack.length) {
      const [a, b] = stack.pop();
      const [ax, ay] = pts[a], [bx, by] = pts[b];
      const L = Math.hypot(bx - ax, by - ay) || 1e-9;
      let md = 0, mi = -1;
      for (let i = a + 1; i < b; i++) {
        const d = Math.abs((bx - ax) * (ay - pts[i][1]) - (ax - pts[i][0]) * (by - ay)) / L;
        if (d > md) { md = d; mi = i; }
      }
      if (md > eps && mi > 0) { keep[mi] = 1; stack.push([a, mi], [mi, b]); }
    }
    return pts.filter((_, i) => keep[i]);
  }
  function rdpClosed(pts, eps) {
    // split at the point farthest from the first, simplify both halves
    let fi = 0, fd = 0;
    pts.forEach((p, i) => { const d = Math.hypot(p[0] - pts[0][0], p[1] - pts[0][1]); if (d > fd) { fd = d; fi = i; } });
    const a = rdp(pts.slice(0, fi + 1), eps), b = rdp(pts.slice(fi).concat([pts[0]]), eps);
    return a.slice(0, -1).concat(b.slice(0, -1));
  }

  function polyArea(p) { let s = 0; for (let i = 0; i < p.length; i++) { const a = p[i], b = p[(i + 1) % p.length]; s += a[0] * b[1] - b[0] * a[1]; } return s / 2; }

  // Segment tools on the rectified sheet. opts: {ppm, sens (0..1), minArea mm², marginMm}
  function traceTools(rect, opts) {
    const { width: w, height: h, data } = rect;
    const ppm = opts.ppm;
    const g = toGray(rect);
    const bg = illumination(g, w, h, Math.round(8 * ppm));
    const thr = opts.sens;                                     // relative darkness vs local paper
    const m = Math.round((opts.marginMm || 3) * ppm);
    // Normalised darkness and colour saturation per pixel.
    const D = new Float32Array(w * h), SAT = new Float32Array(w * h);
    for (let i = 0, j = 0; i < w * h; i++, j += 4) {
      D[i] = 1 - g[i] / Math.max(1, bg[i]);
      const mx = Math.max(data[j], data[j + 1], data[j + 2]), mn = Math.min(data[j], data[j + 1], data[j + 2]);
      SAT[i] = mx ? (mx - mn) / mx : 0;
    }
    let mask = new Uint8Array(w * h);
    for (let y = m; y < h - m; y++) for (let x = m; x < w - m; x++) {
      const i = y * w + x;
      mask[i] = D[i] > thr || (SAT[i] > 0.32 && D[i] > 0.04) ? 1 : 0;
    }
    // Brush strokes (paper mm): "add" forces tool, "erase" forces paper (shadows, glare, stray marks).
    const addM = new Uint8Array(w * h), eraseM = new Uint8Array(w * h);
    let painted = false;
    (opts.paint || []).forEach(st => {
      const tgt = st.mode === 'add' ? addM : eraseM, rp = st.r * ppm;
      const stamp = (cx, cy) => {
        const x0 = Math.max(0, Math.floor(cx - rp)), x1 = Math.min(w - 1, Math.ceil(cx + rp));
        const y0 = Math.max(0, Math.floor(cy - rp)), y1 = Math.min(h - 1, Math.ceil(cy + rp));
        for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if ((x - cx) ** 2 + (y - cy) ** 2 <= rp * rp) tgt[y * w + x] = 1;
      };
      const P = st.pts.map(([x, y]) => [x * ppm, y * ppm]);
      P.forEach((p, i) => {
        if (!i) return stamp(p[0], p[1]);
        const q = P[i - 1], n = Math.max(1, Math.ceil(Math.hypot(p[0] - q[0], p[1] - q[1]) / Math.max(1, rp / 2)));
        for (let k = 1; k <= n; k++) stamp(q[0] + (p[0] - q[0]) * k / n, q[1] + (p[1] - q[1]) * k / n);
      });
      painted = true;
    });
    const applyPaint = () => { if (painted) for (let i = 0; i < w * h; i++) { if (addM[i]) mask[i] = 1; if (eraseM[i]) mask[i] = 0; } };
    applyPaint();
    const rc = Math.max(1, Math.round(1.5 * ppm)), ro = Math.max(1, Math.round(0.6 * ppm));
    mask = morph(morph(mask, w, h, rc, 'dilate'), w, h, rc, 'erode');   // close
    mask = morph(morph(mask, w, h, ro, 'erode'), w, h, ro, 'dilate');   // open
    mask = fillHoles(mask, w, h);
    applyPaint();                                                         // erase wins over hole fill
    const { labels, areas } = components(mask, w, h);
    const minPx = (opts.minArea || 150) * ppm * ppm;
    const firstPx = new Int32Array(areas.length).fill(-1);
    for (let i = 0; i < labels.length; i++) { const L = labels[i]; if (L && firstPx[L] < 0) firstPx[L] = i; }
    const out = [];
    for (let L = 1; L < areas.length; L++) {
      if (areas[L] < minPx) continue;
      const px = traceBoundary(labels, w, h, L, firstPx[L]);
      if (px.length < 8) continue;
      let poly = rdpClosed(px, 0.3 * ppm).map(([x, y]) => [(x + 0.5) / ppm, (y + 0.5) / ppm]);
      if (poly.length < 3) continue;
      if (polyArea(poly) < 0) poly.reverse();
      out.push({ poly, areaMm2: areas[L] / (ppm * ppm) });
    }
    out.sort((a, b) => b.areaMm2 - a.areaMm2);
    return { tools: out, mask, w, h };
  }

  // Minimal EXIF read: 35 mm-equivalent focal length (tag 0xA405), else null.
  function exifFocal35(buf) {
    try {
      const dv = new DataView(buf);
      if (dv.getUint16(0) !== 0xFFD8) return null;
      let o = 2;
      while (o < dv.byteLength - 4) {
        const mk = dv.getUint16(o), len = dv.getUint16(o + 2);
        if (mk === 0xFFE1 && dv.getUint32(o + 4) === 0x45786966) {
          const t = o + 10, le = dv.getUint16(t) === 0x4949;
          const u16 = p => dv.getUint16(t + p, le), u32 = p => dv.getUint32(t + p, le);
          // offsets below are relative to the TIFF header at t
          const find = (ifd, want) => {
            const n = u16(ifd);
            for (let i = 0; i < n; i++) { const e = ifd + 2 + i * 12; if (u16(e) === want) return e; }
            return -1;
          };
          const e1 = find(u32(4), 0x8769); if (e1 < 0) return null;
          const exif = u32(e1 + 8);
          const e2 = find(exif, 0xA405);
          if (e2 >= 0) { const v = u16(e2 + 8); return v > 8 && v < 300 ? v : null; }
          return null;
        }
        if ((mk & 0xFF00) !== 0xFF00) break;
        o += 2 + len;
      }
    } catch (e) { /* no exif */ }
    return null;
  }

  root.TrayVision = { cameraPose, parallaxCorrect, PAPERS, detectPaper, guessPaper, homography, applyH, paperDims, rectify, traceTools, polyArea, exifFocal35, orderQuad };
})(typeof window !== 'undefined' ? window : globalThis);
