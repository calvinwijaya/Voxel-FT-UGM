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

    // ---------- geo helpers (local tangent plane; fine for < ~5 km) ----------
    function worldToLL(wx, wz) {
        const b = APP.bounds, r = G.rotationDeg * Math.PI / 180;
        const e = wx - b.cx; let n = -(wz - b.cz); if (G.flipZ) n = -n;
        const E = e * Math.cos(r) + n * Math.sin(r) + G.offsetE;
        const N = -e * Math.sin(r) + n * Math.cos(r) + G.offsetN;
        const lat = G.lat + N / 111320;
        const lon = G.lon + E / (111320 * Math.cos(G.lat * Math.PI / 180));
        return [lat, lon];
    }
    APP.worldToLL = worldToLL;
    const mercX = (lon, z) => (lon + 180) / 360 * 256 * Math.pow(2, z);
    const mercY = (lat, z) => { const s = Math.sin(lat * Math.PI / 180); return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 256 * Math.pow(2, z); };

    async function build() {
        const token = ++buildToken;
        const src = CONFIG.BASEMAPS[current];
        $('attribution').textContent = src ? src.attribution : '';
        if (!src) { if (plane) plane.visible = false; applyGroundColors(); return; }

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
        const geo = new THREE.PlaneGeometry(size, size, 48, 48);
        const pos = geo.attributes.position, uv = geo.attributes.uv;
        for (let k = 0; k < pos.count; k++) {
            const wx = b.cx + pos.getX(k), wz = b.cz - pos.getY(k);   // rotation.x = -90°
            const [lat, lon] = worldToLL(wx, wz);
            uv.setXY(k, (mercX(lon, z) - view.ox) / view.w, 1 - (mercY(lat, z) - view.oy) / view.h);
        }
        uv.needsUpdate = true;
        const tex = new THREE.CanvasTexture(canvas);
        tex.anisotropy = APP.renderer.capabilities.getMaxAnisotropy();
        plane = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ map: tex }));
        plane.rotation.x = -Math.PI / 2;
        plane.position.set(b.cx, APP.minGroundTop - VS / 2, b.cz);
        plane.receiveShadow = true;
        APP.scene.add(plane);
        APP.shadowDirty = true;
        applyGroundColors();
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
    let deb;
    const rebuildSoon = () => { clearTimeout(deb); deb = setTimeout(build, 250); };
    $('basemap-select').onchange = e => { current = e.target.value; build(); };
    $('basemap-ground').onchange = e => { colorGround = e.target.checked; applyGroundColors(); };
    const bindGeo = (id, key, fmt) => {
        const el = $(id); el.value = G[key];
        const lab = $(id + '-label');
        const sync = () => lab && (lab.textContent = fmt(G[key]));
        sync();
        el.addEventListener('input', () => { G[key] = parseFloat(el.value); sync(); rebuildSoon(); });
    };
    bindGeo('geo-e', 'offsetE', v => `${v} m`);
    bindGeo('geo-n', 'offsetN', v => `${v} m`);
    bindGeo('geo-rot', 'rotationDeg', v => `${v}°`);
    $('geo-flip').checked = G.flipZ;
    $('geo-flip').onchange = e => { G.flipZ = e.target.checked; rebuildSoon(); };
    $('geo-copy').onclick = () => {
        const txt = 'GEOREF: ' + JSON.stringify(G, null, 4);
        (navigator.clipboard ? navigator.clipboard.writeText(txt) : Promise.reject()).then(
            () => APP.flash('Georef copied — paste into js/config.js'),
            () => { console.log(txt); APP.flash('Georef printed to the console'); });
    };

    document.addEventListener('voxels-ready', () => { $('basemap-select').value = current; build(); });
    document.addEventListener('layers-built', () => { if (colorGround) applyGroundColors(); });
    const groundPicker = document.getElementById('color-ground');
    if (groundPicker) groundPicker.addEventListener('input', () => { if (colorGround) { colorGround = false; $('basemap-ground').checked = false; } });
})();
