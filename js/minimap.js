// =====================================================================
//  MINIMAP — game-style map for first / third person (heading-up)
//   • voxel roof-top colours (respects layer colours / visibility, burnt voxels)
//   • basemap imagery around the model
//   • player arrow, view cone, north marker, live fire
//   +/− buttons or the  =  /  -  keys zoom.
// =====================================================================
(function () {
    const $ = id => document.getElementById(id);
    const wrap = $('minimap'), cv = $('minimap-canvas'), ctx = cv.getContext('2d');
    const ZOOMS = [30, 60, 120, 240, 480];              // view radius in metres
    let zi = 2, grid, b, tops, topCode, vox, vctx, vimg, geo, pxM, ox, oz, margin = 150, dirty = true, voxDirty = true;

    // ---------------- column tops ----------------
    function computeTops(cols) {
        const g = grid, L = APP.layers, ny = g.ny, nz = g.nz, d = g.data;
        const visible = new Uint8Array(g.types.length + 1);
        g.types.forEach((t, k) => visible[k + 1] = L.visibleType(k + 1) ? 1 : 0);
        const doCol = col => {
            const base = col * ny; let ly = ny - 1;
            for (; ly >= 0; ly--) { const c = d[base + ly]; if (c && visible[c] && !L.isRemoved(base + ly)) break; }
            tops[col] = ly; topCode[col] = ly >= 0 ? d[base + ly] : 0;
        };
        if (cols) cols.forEach(doCol); else for (let c = 0; c < g.nx * g.nz; c++) doCol(c);
    }

    function paintVoxels() {
        const g = grid, nz = g.nz, nx = g.nx, px = vimg.data;
        const cols = g.types.map(t => APP.materials[t] ? APP.materials[t].color : new THREE.Color(1, 1, 1));
        let lo = Infinity, hi = -Infinity;
        for (let c = 0; c < nx * nz; c++) if (tops[c] >= 0) { if (tops[c] < lo) lo = tops[c]; if (tops[c] > hi) hi = tops[c]; }
        const span = Math.max(1, hi - lo), relief = 2 / g.VS;            // ~1 shade step per 2 m
        for (let lx = 0; lx < nx; lx++) for (let lz = 0; lz < nz; lz++) {
            const c = lx * nz + lz, o = (lz * nx + lx) * 4;               // image: x → right, z → down (north up)
            const t = tops[c];
            if (t < 0) { px[o + 3] = 0; continue; }
            const col = cols[topCode[c] - 1];
            // height tint + simple hillshade from the north-west neighbour
            const nwT = (lx > 0 && lz > 0) ? tops[(lx - 1) * nz + lz - 1] : t;
            const hs = Math.max(-0.25, Math.min(0.25, (t - (nwT < 0 ? t : nwT)) / relief * 0.08));
            const k = (0.8 + 0.3 * (t - lo) / span) * (1 + hs);
            px[o] = Math.min(255, col.r * 255 * k); px[o + 1] = Math.min(255, col.g * 255 * k); px[o + 2] = Math.min(255, col.b * 255 * k);
            px[o + 3] = 255;
        }
        vctx.putImageData(vimg, 0, 0);
        voxDirty = false;
    }

    // ---------------- imagery under / around the model ----------------
    function paintGeo() {
        const W = Math.round((b.width + 2 * margin) * pxM), H = Math.round((b.depth + 2 * margin) * pxM);
        geo.width = W; geo.height = H;
        const g = geo.getContext('2d');
        g.fillStyle = '#3f3f46'; g.fillRect(0, 0, W, H);
        const bm = APP.basemap;
        if (!bm) return;
        const toM = (x, z) => { const [lat, lon] = APP.worldToLL(x, z); return [bm.mercX(lon, bm.view.z) - bm.view.ox, bm.mercY(lat, bm.view.z) - bm.view.oy]; };
        const L = 100, x0 = ox, z0 = oz;
        const m0 = toM(x0, z0), m1 = toM(x0 + L, z0), m2 = toM(x0, z0 + L);
        // affine (u,v) → (mx,my), then invert it for drawImage
        const a = (m1[0] - m0[0]) / (L * pxM), bb = (m1[1] - m0[1]) / (L * pxM);
        const c = (m2[0] - m0[0]) / (L * pxM), d = (m2[1] - m0[1]) / (L * pxM);
        const e = m0[0], f = m0[1], det = a * d - bb * c;
        g.setTransform(d / det, -bb / det, -c / det, a / det, (c * f - d * e) / det, (bb * e - a * f) / det);
        g.drawImage(bm.canvas, 0, 0);
        g.setTransform(1, 0, 0, 1, 0, 0);
        g.fillStyle = 'rgba(0,0,0,0.18)'; g.fillRect(0, 0, W, H);       // slightly darker so the voxels pop
    }

    function init() {
        grid = APP.grid; b = APP.bounds;
        tops = new Int16Array(grid.nx * grid.nz); topCode = new Uint8Array(grid.nx * grid.nz);
        vox = document.createElement('canvas'); vox.width = grid.nx; vox.height = grid.nz;
        vctx = vox.getContext('2d'); vimg = vctx.createImageData(grid.nx, grid.nz);
        geo = document.createElement('canvas');
        pxM = Math.min(1 / Math.max(grid.VS, 0.5), 2400 / (b.width + 2 * margin));
        ox = b.minX - grid.VS / 2 - margin; oz = b.minZ - grid.VS / 2 - margin;
        computeTops(); paintGeo(); dirty = true;
        APP.updaters.push(update);
    }
    document.addEventListener('voxels-ready', init);
    document.addEventListener('basemap-ready', () => { if (geo) paintGeo(); });
    document.addEventListener('layers-built', () => { if (tops) { computeTops(); voxDirty = true; } });
    // layer visibility / colour changes
    document.getElementById('controls-container').addEventListener('change', () => { if (tops) { computeTops(); voxDirty = true; } });

    // ---------------- drawing ----------------
    let acc = 0;
    const CS = cv.width, R = CS / 2 - 4;
    function update(dt) {
        if (APP.mode === 'orbit') return;
        acc += dt; if (acc < 1 / 24) return; acc = 0;            // ~24 fps is plenty
        const L = APP.layers;
        if (L.dirtyCols.length) { computeTops(L.dirtyCols.splice(0)); voxDirty = true; }
        if (voxDirty) paintVoxels();

        const P = APP.player, yaw = P.yaw, rM = ZOOMS[zi], s = R / rM;
        ctx.clearRect(0, 0, CS, CS);
        ctx.save();
        ctx.beginPath(); ctx.arc(CS / 2, CS / 2, R, 0, Math.PI * 2); ctx.clip();
        ctx.fillStyle = '#27272a'; ctx.fillRect(0, 0, CS, CS);
        ctx.translate(CS / 2, CS / 2);
        ctx.rotate(yaw);                                          // heading-up
        ctx.scale(s, s);
        ctx.translate(-P.pos.x, -P.pos.z);
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(geo, ox, oz, geo.width / pxM, geo.height / pxM);
        ctx.imageSmoothingEnabled = false;                        // crisp voxel pixels
        const VS = grid.VS;
        ctx.drawImage(vox, grid.worldX(0) - VS / 2, grid.worldZ(0) - VS / 2, grid.nx * VS, grid.nz * VS);
        // flood
        if (APP.waterLevel > -Infinity) { ctx.fillStyle = 'rgba(30,144,255,0.35)'; ctx.fillRect(ox, oz, geo.width / pxM, geo.height / pxM); }
        // fire
        const burning = APP.fire && APP.fire.burningCells ? APP.fire.burningCells() : [];
        if (burning.length) {
            ctx.fillStyle = '#ff5a1f';
            const step = Math.max(1, Math.floor(burning.length / 4000));
            for (let k = 0; k < burning.length; k += step) {
                const [lx, , lz] = grid.unpack(burning[k]);
                ctx.fillRect(grid.worldX(lx) - VS, grid.worldZ(lz) - VS, VS * 2, VS * 2);
            }
        }
        ctx.restore();

        // view cone + player arrow (always pointing up)
        ctx.save(); ctx.translate(CS / 2, CS / 2);
        const fov = APP.camera.fov * Math.PI / 180 * APP.camera.aspect / 2;
        const cone = ctx.createRadialGradient(0, 0, 4, 0, 0, R * 0.8);
        cone.addColorStop(0, 'rgba(255,255,255,0.35)'); cone.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = cone;
        ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, R * 0.8, -Math.PI / 2 - Math.min(fov, 1.2), -Math.PI / 2 + Math.min(fov, 1.2)); ctx.closePath(); ctx.fill();
        ctx.fillStyle = APP.mode === 'tp' ? (APP.catDef ? APP.catDef.ui : '#fb923c') : '#38bdf8';
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.moveTo(0, -15); ctx.lineTo(10, 11); ctx.lineTo(0, 5); ctx.lineTo(-10, 11); ctx.closePath();
        ctx.stroke(); ctx.fill();
        ctx.restore();

        // ring + north marker
        ctx.strokeStyle = 'rgba(255,255,255,0.75)'; ctx.lineWidth = 4;
        ctx.beginPath(); ctx.arc(CS / 2, CS / 2, R, 0, Math.PI * 2); ctx.stroke();
        const nx = CS / 2 + Math.sin(yaw) * (R - 2), ny = CS / 2 - Math.cos(yaw) * (R - 2);
        ctx.fillStyle = '#ef4444'; ctx.beginPath(); ctx.arc(nx, ny, 17, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#fff'; ctx.font = 'bold 20px Segoe UI, Roboto, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('N', nx, ny + 1);
        // scale label
        ctx.fillStyle = 'rgba(24,24,27,.75)'; ctx.fillRect(CS / 2 - 34, CS - 46, 68, 24);
        ctx.fillStyle = '#e4e4e7'; ctx.font = '600 15px Segoe UI, Roboto, sans-serif';
        ctx.fillText(`${rM * 2} m`, CS / 2, CS - 33);
    }

    const zoom = d => { zi = Math.max(0, Math.min(ZOOMS.length - 1, zi + d)); };
    $('mm-in').onclick = () => zoom(-1);
    $('mm-out').onclick = () => zoom(1);
    addEventListener('keydown', e => {
        if (APP.mode === 'orbit' || e.target.tagName === 'INPUT') return;
        if (e.key === '=' || e.key === '+') zoom(-1);
        if (e.key === '-' || e.key === '_') zoom(1);
    });
})();
