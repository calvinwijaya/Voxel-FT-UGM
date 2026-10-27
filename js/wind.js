// =====================================================================
//  WIND — live data (Open-Meteo, no API key) or manual, plus particles
//  Direction convention: meteorological, the direction the wind comes FROM,
//  degrees clockwise from north. Scene: +X East, -Z North.
// =====================================================================
(function () {
    const W = APP.wind = {
        speed: 2, dirFrom: 90, gust: null, temp: null, rh: null, time: null,
        source: 'manual', liveWanted: true, showParticles: true,
        /** unit vector the wind blows TOWARDS, in scene XZ */
        toDir() {
            const a = this.dirFrom * Math.PI / 180;
            return { x: -Math.sin(a), z: Math.cos(a) };
        }
    };

    const $ = id => document.getElementById(id);
    const speedEl = $('wind-speed'), dirEl = $('wind-dir');
    const BEAUFORT = [[0.5, 'Calm'], [1.6, 'Light air'], [3.4, 'Light breeze'], [5.5, 'Gentle breeze'],
        [8, 'Moderate breeze'], [10.8, 'Fresh breeze'], [13.9, 'Strong breeze'], [17.2, 'Near gale'],
        [20.8, 'Gale'], [24.5, 'Strong gale'], [Infinity, 'Storm']];
    const COMPASS16 = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
    const cardinal = d => COMPASS16[Math.round(((d % 360) + 360) % 360 / 22.5) % 16];

    function refreshUI() {
        speedEl.value = W.speed; dirEl.value = Math.round(W.dirFrom);
        $('wind-speed-label').textContent = `${W.speed.toFixed(1)} m/s · ${(W.speed * 3.6).toFixed(0)} km/h`;
        $('wind-dir-label').textContent = `${Math.round(W.dirFrom)}° (${cardinal(W.dirFrom)})`;
        $('wind-beaufort').textContent = BEAUFORT.find(b => W.speed < b[0])[1];
        $('wind-live-btn').classList.toggle('active', W.source === 'live');
        $('wind-manual-btn').classList.toggle('active', W.source === 'manual');
        const arrow = $('wind-arrow');
        arrow.style.transform = `translate(-50%,-50%) rotate(${W.dirFrom + 180}deg)`;
        arrow.style.opacity = W.speed < 0.2 ? 0 : 1;
        const meta = [];
        if (W.gust != null) meta.push(`Gust ${W.gust.toFixed(1)} m/s`);
        if (W.temp != null) meta.push(`${W.temp.toFixed(1)} °C`);
        if (W.rh != null) meta.push(`RH ${W.rh}%`);
        $('wind-meta').textContent = meta.join(' · ');
        document.dispatchEvent(new CustomEvent('wind-changed'));
    }
    W.refreshUI = refreshUI;

    function setStatus(txt, cls) { const s = $('wind-status'); s.textContent = txt; s.className = 'status ' + (cls || ''); }

    async function fetchLive() {
        const { lat, lon } = CONFIG.GEOREF;
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
            `&current=temperature_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m,wind_gusts_10m` +
            `&wind_speed_unit=ms&timezone=auto`;
        setStatus('Fetching live wind…');
        try {
            const res = await fetch(url);
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const j = await res.json(), c = j.current;
            W.time = c.time;
            W.gust = c.wind_gusts_10m; W.temp = c.temperature_2m; W.rh = c.relative_humidity_2m;
            if (W.liveWanted) {
                W.speed = c.wind_speed_10m; W.dirFrom = c.wind_direction_10m; W.source = 'live';
            }
            setStatus(`Live · Open-Meteo · obs. ${c.time.replace('T', ' ')} (local)`, 'ok');
            if (W.rh != null) document.dispatchEvent(new CustomEvent('humidity-live', { detail: W.rh }));
        } catch (e) {
            console.warn('Live wind failed', e);
            W.source = 'manual';
            setStatus('Live wind unavailable — using manual values', 'warn');
        }
        refreshUI();
    }
    W.fetchLive = fetchLive;

    // ---- UI wiring ----
    $('wind-live-btn').onclick = () => { W.liveWanted = true; fetchLive(); };
    $('wind-manual-btn').onclick = () => { W.liveWanted = false; W.source = 'manual'; setStatus('Manual wind'); refreshUI(); };
    $('wind-refresh').onclick = () => { W.liveWanted = true; fetchLive(); };
    const manual = () => {
        W.liveWanted = false; W.source = 'manual';
        W.speed = parseFloat(speedEl.value); W.dirFrom = parseFloat(dirEl.value);
        setStatus('Manual wind'); refreshUI();
    };
    speedEl.addEventListener('input', manual);
    dirEl.addEventListener('input', manual);
    $('wind-show').addEventListener('change', e => { W.showParticles = e.target.checked; if (lines) lines.visible = e.target.checked; });

    setInterval(() => { if (W.liveWanted) fetchLive(); }, CONFIG.WIND.refreshMinutes * 60000);
    refreshUI();
    fetchLive();

    // =================================================================
    //  Particle streaks — advect with a log wind profile, lift over obstacles
    // =================================================================
    let lines, pos, st, N, grid, terrainTop, surfTop;
    const VS = CONFIG.VOXEL_SIZE, Z0 = CONFIG.WIND.roughnessZ0;
    const logRef = Math.log(10 / Z0);
    const VIS = 4; // visual time acceleration

    document.addEventListener('voxels-ready', () => {
        grid = APP.grid;
        N = CONFIG.WIND.particles;
        // height maps (world Y of the top face)
        terrainTop = new Float32Array(grid.nx * grid.nz);
        surfTop = new Float32Array(grid.nx * grid.nz);
        const cg = grid.code.ground, cr = grid.code.river;
        for (let lx = 0; lx < grid.nx; lx++) for (let lz = 0; lz < grid.nz; lz++) {
            const t = grid.topWhere(lx, lz, c => c === cg || c === cr);
            const s = grid.topWhere(lx, lz, () => true);
            terrainTop[lx * grid.nz + lz] = t >= 0 ? grid.worldY(t) + VS / 2 : APP.minGroundTop;
            surfTop[lx * grid.nz + lz] = s >= 0 ? grid.worldY(s) + VS / 2 : APP.minGroundTop;
        }
        APP.terrainTopAt = (wx, wz) => {
            const lx = grid.cellX(wx), lz = grid.cellZ(wz);
            if (lx < 0 || lz < 0 || lx >= grid.nx || lz >= grid.nz) return APP.minGroundTop;
            return terrainTop[lx * grid.nz + lz];
        };

        pos = new Float32Array(N * 6);
        st = new Float32Array(N * 5);     // x, y, z, heightAboveTerrain, life
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        lines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({
            color: 0x0369a1, transparent: true, opacity: 0.55, depthWrite: false
        }));
        lines.frustumCulled = false;
        lines.visible = W.showParticles;
        APP.scene.add(lines);
        for (let p = 0; p < N; p++) spawn(p, true);
        APP.updaters.push(update);
    });

    function spawn(p, anywhere) {
        const b = APP.bounds, d = W.toDir();
        let x = b.minX + Math.random() * b.width, z = b.minZ + Math.random() * b.depth;
        if (!anywhere) { // enter from the upwind edge
            const L = b.width + b.depth;
            x = Math.min(b.maxX, Math.max(b.minX, x - d.x * L));
            z = Math.min(b.maxZ, Math.max(b.minZ, z - d.z * L));
        }
        const h = 2 + Math.pow(Math.random(), 1.8) * 45;   // more particles near the ground
        const ground = APP.terrainTopAt(x, z);
        const surf = surfTop[grid.cellX(x) * grid.nz + grid.cellZ(z)] || ground;
        const y = Math.max(ground + h, surf + 1.5 * Math.random());
        const o = p * 5;
        st[o] = x; st[o + 1] = y; st[o + 2] = z; st[o + 3] = h; st[o + 4] = 4 + Math.random() * 10;
    }

    let tAcc = 0;
    function update(dt) {
        if (!lines || !lines.visible) return;
        tAcc += dt;
        const V = W.speed, d = W.toDir(), b = APP.bounds;
        if (V < 0.2) { lines.material.opacity = 0; return; }
        lines.material.opacity = 0.55;
        for (let p = 0; p < N; p++) {
            const o = p * 5;
            let x = st[o], y = st[o + 1], z = st[o + 2];
            const ground = APP.terrainTopAt(x, z);
            const hAG = Math.max(y - ground, Z0 * 1.5);
            const u = Math.min(V * Math.log(hAG / Z0) / logRef, V * 1.8);   // log wind profile
            // gentle turbulence perpendicular to the flow
            const wob = Math.sin(tAcc * 1.7 + p * 12.9898) * 0.25 * u;
            let vx = d.x * u - d.z * wob, vz = d.z * u + d.x * wob, vy = 0;
            let nx = x + vx * dt * VIS, nz = z + vz * dt * VIS, ny = y;

            // obstacle: something solid ahead → flow goes up and slows
            const lx = grid.cellX(nx), ly = grid.cellY(ny), lz = grid.cellZ(nz);
            if (grid.inside(lx, ly, lz) && APP.layers.occupied(grid.idx(lx, ly, lz))) {
                ny = y + Math.max(u * dt * VIS, 0.5) * 1.2;
                nx = x + vx * dt * VIS * 0.3; nz = z + vz * dt * VIS * 0.3; vy = u;
            } else if (y - ground > st[o + 3] + 0.5) {
                ny = y - 0.3 * u * dt * VIS * 0.25;  // settle back to its stream height
            }
            st[o] = nx; st[o + 1] = ny; st[o + 2] = nz;
            st[o + 4] -= dt;
            if (nx < b.minX || nx > b.maxX || nz < b.minZ || nz > b.maxZ || st[o + 4] <= 0) {
                spawn(p, st[o + 4] <= 0 && Math.random() < 0.7);
                const q = p * 5; nx = st[q]; ny = st[q + 1]; nz = st[q + 2]; vx = 0; vz = 0; vy = 0;
            }
            const sp = Math.hypot(vx, vy, vz) || 1, tail = 1.5 + u * 0.8;
            const k = p * 6;
            pos[k] = nx; pos[k + 1] = ny; pos[k + 2] = nz;
            pos[k + 3] = nx - vx / sp * tail; pos[k + 4] = ny - vy / sp * tail; pos[k + 5] = nz - vz / sp * tail;
        }
        lines.geometry.attributes.position.needsUpdate = true;
    }
})();
