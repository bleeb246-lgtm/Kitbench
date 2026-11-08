// Tray geometry — pure functions over a Manifold wasm instance.
// Units: mm. Tray sits on Z=0, origin at the front-left corner, +X width, +Y depth, +Z height.
(function (root) {
  'use strict';

  // Every wasm object goes in the bin and is freed after the mesh is copied out.
  function chamferBox(M, K, W, D, H, c) {
    const { Manifold } = M;
    c = Math.max(0, Math.min(c, W / 2 - 0.01, D / 2 - 0.01, H / 2 - 0.01));
    if (c < 0.05) return K(Manifold.cube([W, D, H]));
    const a = K(K(Manifold.cube([W, D - 2 * c, H - 2 * c])).translate([0, c, c]));
    const b = K(K(Manifold.cube([W - 2 * c, D, H - 2 * c])).translate([c, 0, c]));
    const d = K(K(Manifold.cube([W - 2 * c, D - 2 * c, H])).translate([c, c, 0]));
    return K(Manifold.hull([a, b, d]));
  }

  // Pocket outline for one tool: traced polygon grown by clearance.
  function signedArea(p) { let a = 0; for (let i = 0; i < p.length; i++) { const q = p[i], r = p[(i + 1) % p.length]; a += q[0] * r[1] - r[0] * q[1]; } return a / 2; }

  // Resample a closed polygon at a fixed arc-length step.
  function resample(p, step) {
    const out = [];
    let carry = 0;
    for (let i = 0; i < p.length; i++) {
      const a = p[i], b = p[(i + 1) % p.length];
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      let t = carry;
      while (t < L) { out.push([a[0] + (b[0] - a[0]) * t / L, a[1] + (b[1] - a[1]) * t / L]); t += step; }
      carry = t - L;
    }
    return out.length >= 3 ? out : p;
  }

  // Gaussian filter along the outline (sigma in mm of arc length).
  function gaussSmooth(p, sigma, step) {
    const n = p.length, r = Math.min(Math.floor(n / 2) - 1, Math.ceil(3 * sigma / step));
    if (r < 1) return p;
    const w = []; let ws = 0;
    for (let k = -r; k <= r; k++) { const v = Math.exp(-0.5 * (k * step / sigma) ** 2); w.push(v); ws += v; }
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      let x = 0, y = 0;
      for (let k = -r; k <= r; k++) { const q = p[(i + k + n) % n], v = w[k + r]; x += q[0] * v; y += q[1] * v; }
      out[i] = [x / ws, y / ws];
    }
    return out;
  }

  // Smoothing, in four steps, never cutting into the tool by more than `tol`:
  //   1. close (grow s, shrink s): fills notches and stair-steps narrower than 2·s;
  //   2. Gaussian-filter the outline (sigma ≈ 0.6·s): irons out bumps and wobble;
  //   3. union with the trace inset by tol: anywhere the filter cut deeper than tol, the tool wins;
  //   4. a small round close to blend those seams.
  // tol is kept under the clearance, so the tool still drops in.
  function toolSection(M, K, poly, clearance, smooth) {
    const { CrossSection } = M;
    const base = K(CrossSection.ofPolygons([poly], 'NonZero'));
    let cs = base;
    if (smooth > 0.05) {
      cs = K(K(cs.offset(smooth, 'Round', 2, 48)).offset(-smooth, 'Round', 2, 48));
      let outer = cs.toPolygons().filter(p => signedArea(p) > 0);   // drop pinched-off islands
      if (outer.length) {
        const step = Math.max(0.25, Math.min(1, smooth / 8));
        const sm = outer.map(p => gaussSmooth(resample(p, step), 0.6 * smooth, step));
        cs = K(CrossSection.ofPolygons(sm, 'NonZero'));
        const tol = Math.min(0.6, Math.max(0, clearance) * 0.75);
        const floorShape = K(base.offset(-tol, 'Round', 2, 48));
        cs = K(CrossSection.union([cs, floorShape]));
        const rb = Math.min(2, smooth * 0.3);
        cs = K(K(cs.offset(rb, 'Round', 2, 48)).offset(-rb, 'Round', 2, 48));
        outer = cs.toPolygons().filter(p => signedArea(p) > 0);
        if (outer.length) cs = K(CrossSection.ofPolygons(outer, 'NonZero'));
      }
    }
    return K(K(cs.offset(clearance, 'Round', 2, 48)).simplify(0.02));
  }

  // Finger scoop = a horizontal slot with a round bottom: hull of two cylinders, the lower one
  // sitting 0.4 mm above the pocket floor, the upper one at the top face. Reaches full depth.
  function scoopGeom(s, H, floor) {
    const R = s.radius;
    const zb = floor + R + 0.4, zt = Math.max(zb, H);
    const dz = zb - H;
    return { zb, zt, half: zt > zb ? R : (dz >= R ? 0 : Math.sqrt(R * R - dz * dz)) };
  }

  // Hull of four spheres: round-bottomed, and a stadium (rounded ends) seen from above.
  function scoopSolid(M, K, s, H, floor) {
    const { Manifold } = M;
    const { zb, zt } = scoopGeom(s, H, floor);
    const R = s.radius, e = Math.max(0.05, s.length / 2 - R);
    const sph = (x, z) => K(K(Manifold.sphere(R, 48)).translate([x, 0, z]));
    const pts = [sph(-e, zb), sph(e, zb)];
    if (zt > zb + 0.01) pts.push(sph(-e, zt), sph(e, zt));
    let m = K(Manifold.hull(pts));
    m = K(m.rotate([0, 0, s.angle]));
    return K(m.translate([s.x, s.y, 0]));
  }

  function buildTray(M, K, p, tools) {
    const { Manifold, CrossSection } = M;
    const H = p.H, floor = p.floor;
    const depth = H - floor;
    const base = chamferBox(M, K, p.W, p.D, H, p.outerChamfer);
    if (!tools.length || depth <= 0.2) return { solid: base, pocketArea: 0 };

    const sections = tools.map(t => toolSection(M, K, t.poly, t.clearance, t.smooth || 0));
    const pockets = K(CrossSection.union(sections));
    const ext = (cs, h, z) => K(K(cs.extrude(h)).translate([0, 0, z]));
    const fc = Math.min(p.floorChamfer || 0, depth * 0.4);
    const cuts = [ext(pockets, depth + 1 - Math.max(0, fc), floor + Math.max(0, fc))];

    // Lip chamfer: thin stepped offsets, ~0.12 mm per step — below print-layer resolution.
    // Thin slices (not full-height columns) avoid coincident-vertex pinches at sharp tips.
    const lip = Math.min(p.lipChamfer, depth * 0.5);
    if (lip > 0.05) {
      const n = Math.max(2, Math.ceil(lip / 0.12));
      for (let k = 1; k <= n; k++) {
        const z0 = H - lip + lip * (k - 1) / n;
        const z1 = k === n ? H + 1 : z0 + lip / n + 0.003;
        const cs = K(K(pockets.offset(lip * (k - 0.5) / n, 'Round', 2, 48)).simplify(0.01));
        cuts.push(ext(cs, z1 - z0, z0));
      }
    }

    // Pocket-floor edge chamfer: stepped inset slices over the bottom fc mm.
    if (fc > 0.05) {
      const n = Math.max(2, Math.ceil(fc / 0.12));
      for (let k = 1; k <= n; k++) {
        const z0 = floor + fc * (k - 1) / n;
        const cs = K(K(pockets.offset(-fc * (1 - (k - 0.5) / n), 'Round', 2, 48)).simplify(0.01));
        if (!cs.isEmpty()) cuts.push(ext(cs, fc / n + 0.003, z0));
      }
    }

    tools.forEach(t => (t.scoops || []).forEach(s => cuts.push(scoopSolid(M, K, s, H, floor))));
    const solid = K(base.subtract(K(Manifold.union(cuts))));
    return { solid, pocketArea: pockets.area() };
  }

  // Build, copy the mesh out of wasm, free everything.
  function buildMesh(M, p, tools) {
    const bin = [];
    const K = o => (bin.push(o), o);
    try {
      const r = buildTray(M, K, p, tools);
      const mesh = meshArrays(r.solid);
      return { mesh, volume: r.solid.volume(), pocketArea: r.pocketArea, status: r.solid.status(), tris: mesh.idx.length / 3 };
    } finally {
      bin.forEach(o => { try { o.delete(); } catch (e) { /* already freed */ } });
    }
  }

  // Polygons of one tool's pocket outline (for 2-D drawing and checks).
  function sectionPolys(M, poly, clearance, smooth) {
    const bin = [];
    const K = o => (bin.push(o), o);
    try { return toolSection(M, K, poly, clearance, smooth || 0).toPolygons(); }
    finally { bin.forEach(o => o.delete()); }
  }

  // Area where two outlines overlap, mm².
  function overlapArea(M, a, b) {
    const { CrossSection } = M;
    const bin = []; const K = o => (bin.push(o), o);
    try {
      const A = K(CrossSection.ofPolygons(a, 'NonZero')), B = K(CrossSection.ofPolygons(b, 'NonZero'));
      return K(A.intersect(B)).area();
    } finally { bin.forEach(o => o.delete()); }
  }

  function meshArrays(solid) {
    const m = solid.getMesh();
    const np = m.numProp;
    const nv = m.vertProperties.length / np;
    const pos = new Float32Array(nv * 3);
    for (let i = 0; i < nv; i++) {
      pos[i * 3] = m.vertProperties[i * np];
      pos[i * 3 + 1] = m.vertProperties[i * np + 1];
      pos[i * 3 + 2] = m.vertProperties[i * np + 2];
    }
    return { pos, idx: m.triVerts };
  }

  function toSTL(mesh, name) {
    const { pos, idx } = mesh;
    const nt = idx.length / 3;
    const buf = new ArrayBuffer(84 + nt * 50);
    const dv = new DataView(buf);
    const hdr = ('binary STL ' + (name || '')).slice(0, 79);
    for (let i = 0; i < hdr.length; i++) dv.setUint8(i, hdr.charCodeAt(i));
    dv.setUint32(80, nt, true);
    let o = 84;
    for (let t = 0; t < nt; t++) {
      const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3;
      const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
      const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const l = Math.hypot(nx, ny, nz) || 1;
      dv.setFloat32(o, nx / l, true); dv.setFloat32(o + 4, ny / l, true); dv.setFloat32(o + 8, nz / l, true);
      o += 12;
      for (const v of [a, b, c]) {
        dv.setFloat32(o, pos[v], true); dv.setFloat32(o + 4, pos[v + 1], true); dv.setFloat32(o + 8, pos[v + 2], true);
        o += 12;
      }
      o += 2;
    }
    return new Uint8Array(buf);
  }

  // ---- 3MF (core spec, one object, millimeters) inside a stored zip ----
  function model3MF(mesh, name) {
    const { pos, idx } = mesh;
    const parts = [];
    parts.push('<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">\n');
    parts.push(`<metadata name="Title">${xmlEsc(name)}</metadata>\n<metadata name="Application">Tray Forge</metadata>\n`);
    parts.push('<resources>\n<object id="1" type="model" name="' + xmlEsc(name) + '">\n<mesh>\n<vertices>\n');
    const f = v => (Math.round(v * 10000) / 10000).toString();
    let chunk = '';
    for (let i = 0; i < pos.length; i += 3) {
      chunk += `<vertex x="${f(pos[i])}" y="${f(pos[i + 1])}" z="${f(pos[i + 2])}"/>\n`;
      if (chunk.length > 1e6) { parts.push(chunk); chunk = ''; }
    }
    parts.push(chunk); chunk = '';
    parts.push('</vertices>\n<triangles>\n');
    for (let i = 0; i < idx.length; i += 3) {
      chunk += `<triangle v1="${idx[i]}" v2="${idx[i + 1]}" v3="${idx[i + 2]}"/>\n`;
      if (chunk.length > 1e6) { parts.push(chunk); chunk = ''; }
    }
    parts.push(chunk);
    parts.push('</triangles>\n</mesh>\n</object>\n</resources>\n<build>\n<item objectid="1"/>\n</build>\n</model>\n');
    return parts.join('');
  }
  function xmlEsc(s) { return String(s).replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c])); }

  const CT = '<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>';
  const RELS = '<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>';

  function to3MF(mesh, name) {
    const enc = new TextEncoder();
    return zipStore([
      { name: '[Content_Types].xml', data: enc.encode(CT) },
      { name: '_rels/.rels', data: enc.encode(RELS) },
      { name: '3D/3dmodel.model', data: enc.encode(model3MF(mesh, name)) },
    ]);
  }

  let CRC_T = null;
  function crc32(u8) {
    if (!CRC_T) {
      CRC_T = new Uint32Array(256);
      for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; CRC_T[n] = c >>> 0; }
    }
    let c = 0xFFFFFFFF;
    for (let i = 0; i < u8.length; i++) c = CRC_T[(c ^ u8[i]) & 255] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  // Minimal zip writer, store method (3MF readers accept stored entries).
  function zipStore(files) {
    const enc = new TextEncoder();
    const locals = [], centrals = [];
    let offset = 0;
    for (const f of files) {
      const nm = enc.encode(f.name), crc = crc32(f.data), sz = f.data.length;
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true);
      lh.setUint16(8, 0, true); lh.setUint16(10, 0, true); lh.setUint16(12, 0x21, true);
      lh.setUint32(14, crc, true); lh.setUint32(18, sz, true); lh.setUint32(22, sz, true);
      lh.setUint16(26, nm.length, true); lh.setUint16(28, 0, true);
      locals.push(new Uint8Array(lh.buffer), nm, f.data);
      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true);
      ch.setUint16(10, 0, true); ch.setUint16(12, 0, true); ch.setUint16(14, 0x21, true);
      ch.setUint32(16, crc, true); ch.setUint32(20, sz, true); ch.setUint32(24, sz, true);
      ch.setUint16(28, nm.length, true); ch.setUint32(42, offset, true);
      centrals.push(new Uint8Array(ch.buffer), nm);
      offset += 30 + nm.length + sz;
    }
    const cdSize = centrals.reduce((a, b) => a + b.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
    end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
    const all = [...locals, ...centrals, new Uint8Array(end.buffer)];
    const out = new Uint8Array(all.reduce((a, b) => a + b.length, 0));
    let p = 0; for (const a of all) { out.set(a, p); p += a.length; }
    return out;
  }

  root.TrayGeom = { buildMesh, sectionPolys, overlapArea, scoopGeom, meshArrays, toSTL, to3MF, zipStore, crc32 };
})(typeof window !== 'undefined' ? window : globalThis);
