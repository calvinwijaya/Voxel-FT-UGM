// =====================================================================
//  BASEMAP — XYZ web tiles stitched to a canvas and draped on a plane
//  under the voxel model (keeps three.js as the engine; no MapLibre needed).
//  Optional: colour terrain voxels from the imagery (orthophoto look).
// =====================================================================
(function () {
    const $ = id => document.getElementById(id);
    const VS = CONFIG.VOXEL_SIZE;
    let plane = null, canvas = null, ctx = null, view = null, current = 'satellite', colorGround = false, buildToken = 0;
    const G = CONFIG.GEOREF;

    const worldToLL = (x, z) => APP.worldToLL(x, z);     // js/geo.js
    const mercX = (lon, z) => (lon + 180) / 360 * 256 * Math.pow(2, z);
    const mercY = (lat, z) => { const s = Math.sin(lat * Math.PI / 180); return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 256 * Math.pow(2, z); };

    async function build() {
        const token = ++buildToken;
        const src = CONFIG.BASEMAPS[current];
        $('attribution').textContent = src ? src.attribution : '';
        if (!src) { if (plane) plane.visible = false; APP.basemap = null; document.dispatchEvent(new CustomEvent('basemap-ready')); applyGroundColors(); return; }

        const b = APP.bounds, size = Math.max(b.width, b.depth) * CONFIG.BASEMAP_EXTENT;
        const half = size / 2;
        let z = CONFIG.BASEMAP_ZOOM, px0, py0, px1, py1;
        // pick zoom so the canvas stays <= 4096 px
        for (; z > 10; z--) {
            const cs = [[-half, -half], [half, -half], [half, half], [-half, half]].map(([dx, dz]) => worldToLL(b.cx + dx, b.cz + dz));
            const xs = cs.map(c => mercX(c[1], z)), ys = cs.map(c => mercY(c[0], z));
            px0 = Math.min(...xs); px1 = Math.max(...xs); py0 = Math.min(...ys); py1 = Math.max(...ys);
            if ((Math.floor(px1 / 256) - Math.floor(px0 / 256) + 1) * 256 <= 4096 &&
                (Math.floor(py1 / 256) - Math.floor(py0 / 256) + 1) * 256 <= 4096) break;
        }
        const tx0 = Math.floor(px0 / 256), tx1 = Math.floor(px1 / 256), ty0 = Math.floor(py0 / 256), ty1 = Math.floor(py1 / 256);
        canvas = document.createElement('canvas');
        canvas.width = (tx1 - tx0 + 1) * 256; canvas.height = (ty1 - ty0 + 1) * 256;
        ctx = canvas.getContext('2d');
        ctx.fillStyle = '#d4d4d8'; ctx.fillRect(0, 0, canvas.width, canvas.height);
        view = { z, ox: tx0 * 256, oy: ty0 * 256, w: canvas.width, h: canvas.height };

        $('basemap-status').textContent = `Loading ${(tx1 - tx0 + 1) * (ty1 - ty0 + 1)} tiles (z${z})…`;
        let failed = 0;
        const jobs = [];
        for (let tx = tx0; tx <= tx1; tx++) for (let ty = ty0; ty <= ty1; ty++) {
            jobs.push(new Promise(res => {
                const img = new Image(); img.crossOrigin = 'anonymous';
                img.onload = () => { if (token === buildToken) ctx.drawImage(img, (tx - tx0) * 256, (ty - ty0) * 256); res(); };
                img.onerror = () => { failed++; res(); };
                img.src = src.url.replace('{z}', z).replace('{x}', tx).replace('{y}', ty);
            }));
        }
        await Promise.all(jobs);
        if (token !== buildToken) return;
        $('basemap-status').textContent = failed ? `${failed} tile(s) failed to load (offline or CORS)` : '';

        // plane with per-vertex UVs computed through the geo transform (handles rotation exactly)
        if (plane) { APP.scene.remove(plane); plane.geometry.dispose(); plane.material.map.dispose(); plane.material.dispose(); }
        const SEG = APP.isTouch ? 110 : 160;
        const geo = new THREE.PlaneGeometry(size, size, SEG, SEG);
        const pos = geo.attributes.position, uv = geo.attributes.uv;
        const heights = terrainHeights(SEG, size);
        for (let k = 0; k < pos.count; k++) {
            const wx = b.cx + pos.getX(k), wz = b.cz - pos.getY(k);   // rotation.x = -90°
            const [lat, lon] = worldToLL(wx, wz);
            uv.setXY(k, (mercX(lon, z) - view.ox) / view.w, 1 - (mercY(lat, z) - view.oy) / view.h);
            pos.setZ(k, heights[k]);                                  // local +Z = world up
        }
        uv.needsUpdate = true; pos.needsUpdate = true;
        geo.computeVertexNormals();
        const tex = new THREE.CanvasTexture(canvas);
        tex.anisotropy = APP.renderer.capabilities.getMaxAnisotropy();
        plane = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ map: tex }));
        plane.rotation.x = -Math.PI / 2;
        plane.position.set(b.cx, 0, b.cz);
        plane.receiveShadow = true;
        APP.scene.add(plane);
        APP.shadowDirty = true;
        APP.basemap = { canvas, view, mercX, mercY };
        document.dispatchEvent(new CustomEvent('basemap-ready'));
        applyGroundColors();
    }

    /**
     * Heights for the basemap mesh so it hugs the LiDAR terrain instead of floating flat:
     *  • under the voxels: lowest voxel bottom of the surrounding columns (min-pooled, so the
     *    surface always stays just below the voxels and never pokes through them)
     *  • outside: harmonic in-painting (nearest value + smoothing) continuing the terrain edge
     */
    function terrainHeights(SEG, size) {
        const grid = APP.grid, b = APP.bounds, n = SEG + 1, step = size / SEG;
        // lowest occupied voxel per column
        const bottom = new Float32Array(grid.nx * grid.nz).fill(NaN);
        for (let lx = 0; lx < grid.nx; lx++) for (let lz = 0; lz < grid.nz; lz++) {
            const base = (lx * grid.nz + lz) * grid.ny;
            for (let ly = 0; ly < grid.ny; ly++) if (grid.data[base + ly]) { bottom[lx * grid.nz + lz] = grid.worldY(ly) - VS / 2; break; }
        }
        const win = Math.ceil(step / VS);
        const h = new Float32Array(n * n), known = new Uint8Array(n * n);
        for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
            // PlaneGeometry vertex order: rows from +Y (north, -Z) to -Y, columns from -X to +X
            const wx = b.cx - size / 2 + c * step, wz = b.cz - size / 2 + r * step;
            const cx = grid.cellX(wx), cz = grid.cellZ(wz);
            let m = Infinity;
            for (let dx = -win; dx <= win; dx++) for (let dz = -win; dz <= win; dz++) {
                const x = cx + dx, z = cz + dz;
                if (x < 0 || z < 0 || x >= grid.nx || z >= grid.nz) continue;
                const v = bottom[x * grid.nz + z]; if (v < m) m = v;
            }
            if (m < Infinity) { h[r * n + c] = m - 0.15; known[r * n + c] = 1; }
        }
        // nearest known value (BFS) …
        const queue = []; for (let k = 0; k < n * n; k++) if (known[k]) queue.push(k);
        const seen = known.slice();
        for (let q = 0; q < queue.length; q++) {
            const k = queue[q], r = (k / n) | 0, c = k % n;
            [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(([dr, dc]) => {
                const rr = r + dr, cc = c + dc; if (rr < 0 || cc < 0 || rr >= n || cc >= n) return;
                const kk = rr * n + cc; if (seen[kk]) return;
                seen[kk] = 1; h[kk] = h[k]; queue.push(kk);
            });
        }
        if (!queue.length) h.fill(APP.minGroundTop - VS);
        // … then smooth the in-painted part (known cells stay fixed)
        const tmp = new Float32Array(n * n);
        for (let it = 0; it < 80; it++) {
            for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
                const k = r * n + c;
                if (known[k]) { tmp[k] = h[k]; continue; }
                let s = 0, w = 0;
                if (r > 0) { s += h[k - n]; w++; } if (r < n - 1) { s += h[k + n]; w++; }
                if (c > 0) { s += h[k - 1]; w++; } if (c < n - 1) { s += h[k + 1]; w++; }
                tmp[k] = s / w;
            }
            h.set(tmp);
        }
        return h;
    }

    /** paint terrain voxels with the imagery colour under them */
    function applyGroundColors() {
        const layers = APP.layers, grid = APP.grid; if (!layers) return;
        const code = grid.code.ground, mesh = layers.meshes.ground; if (!mesh) return;
        const on = colorGround && canvas && CONFIG.BASEMAPS[current];
        APP.materials.ground.color.set(on ? '#ffffff' : $('color-ground').value);
        const c = new THREE.Color(1, 1, 1);
        let img = null;
        if (on) { try { img = ctx.getImageData(0, 0, canvas.width, canvas.height).data; } catch (e) { $('basemap-status').textContent = 'Imagery is not CORS-enabled; cannot colour voxels'; } }
        const cells = layers.cellOf[code];
        for (let k = 0; k < mesh.count; k++) {
            if (img) {
                const [lx, ly, lz] = grid.unpack(cells[k]);
                const [lat, lon] = worldToLL(grid.worldX(lx), grid.worldZ(lz));
                const px = Math.floor(mercX(lon, view.z) - view.ox), py = Math.floor(mercY(lat, view.z) - view.oy);
                if (px >= 0 && py >= 0 && px < view.w && py < view.h) {
                    const o = (py * view.w + px) * 4;
                    c.setRGB(img[o] / 255, img[o + 1] / 255, img[o + 2] / 255);
                } else c.setRGB(1, 1, 1);
            } else c.setRGB(1, 1, 1);
            mesh.setColorAt(k, c);
        }
        mesh.instanceColor.needsUpdate = true;
    }

    // ---------- UI ----------
    $('basemap-select').onchange = e => { current = e.target.value; build(); };
    $('basemap-ground').onchange = e => { colorGround = e.target.checked; applyGroundColors(); };
    document.addEventListener('voxels-ready', () => { $('basemap-select').value = current; build(); });
    document.addEventListener('layers-built', () => { if (colorGround) applyGroundColors(); });
    const groundPicker = document.getElementById('color-ground');
    if (groundPicker) groundPicker.addEventListener('input', () => { if (colorGround) { colorGround = false; $('basemap-ground').checked = false; } });
})();
