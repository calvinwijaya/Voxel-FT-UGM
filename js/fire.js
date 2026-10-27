// =====================================================================
//  FIRE — 3D cellular automaton on the voxel grid
//  Spread probability to a neighbour (after Alexandridis et al., 2008):
//     p = p_h · flam(fuel) · moisture · p_wind · p_vertical / distance
//     p_wind = exp(c1·V) · exp(c2·V·(cosθ − 1))   θ = angle(spread dir, wind dir)
//  + ember spotting downwind from burning canopy in strong wind.
//  Cells under the flood water level cannot burn.
// =====================================================================
(function () {
    const F = APP.fire = { running: false, steps: 0, armed: false };
    const C = CONFIG.FIRE, VS = CONFIG.VOXEL_SIZE;
    const $ = id => document.getElementById(id);

    let grid, layers, state, timer, burning = [], burntCol, burntArea = 0;
    let flam, burnSteps, consumed, burntByType, flames, smoke, hover;
    const OFFS = [];
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
        if (!dx && !dy && !dz) continue;
        const hl = Math.hypot(dx, dz);
        OFFS.push({ dx, dy, dz, dist: Math.hypot(dx, dy, dz), hx: hl ? dx / hl : 0, hz: hl ? dz / hl : 0, hl });
    }
    const CHAR = new THREE.Color(0.16, 0.14, 0.13), EMBER = new THREE.Color(1.0, 0.45, 0.2);

    // ---------------- controls ----------------
    let humidity = 60, bldgFactor = 1, stepsPerSec = 4, humidityTouched = false;
    const humEl = $('fire-humidity'), bldEl = $('fire-bldg'), spdEl = $('fire-speed');
    const syncLabels = () => {
        $('fire-humidity-label').textContent = humidity + '%';
        $('fire-bldg-label').textContent = Math.round(bldgFactor * 100) + '%';
        $('fire-speed-label').textContent = stepsPerSec + ' steps/s';
    };
    humEl.oninput = e => { humidity = +e.target.value; humidityTouched = true; syncLabels(); };
    bldEl.oninput = e => { bldgFactor = +e.target.value / 100; syncLabels(); rebuildTables(); };
    spdEl.oninput = e => { stepsPerSec = +e.target.value; syncLabels(); };
    document.addEventListener('humidity-live', e => {
        if (!humidityTouched) { humidity = Math.round(e.detail); humEl.value = humidity; syncLabels(); }
    });
    syncLabels();

    $('fire-arm').onclick = () => setArmed(!F.armed);
    $('fire-play').onclick = () => setRunning(!F.running);
    $('fire-step').onclick = () => { step(); updateStats(); };
    $('fire-reset').onclick = reset;

    function setArmed(on) {
        F.armed = on;
        $('fire-arm').classList.toggle('active', on);
        $('fire-arm').textContent = on ? 'Click on the model to ignite… (ON)' : 'Place ignition point';
        document.body.classList.toggle('igniting', on && APP.mode === 'orbit');
        if (hover) hover.visible = false;
    }
    F.setArmed = setArmed;
    function setRunning(on) {
        F.running = on;
        $('fire-play').textContent = on ? 'Pause' : 'Run';
        $('fire-play').classList.toggle('danger', on);
    }

    // ---------------- init ----------------
    document.addEventListener('voxels-ready', () => {
        grid = APP.grid; layers = APP.layers;
        state = new Uint8Array(grid.N); timer = new Uint8Array(grid.N);
        burntCol = new Uint8Array(grid.nx * grid.nz);
        rebuildTables();

        // flames: small emissive cubes, flickering
        flames = new THREE.InstancedMesh(new THREE.BoxGeometry(VS * 0.75, VS * 0.75, VS * 0.75),
            new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, fog: false }), 40000);
        for (let k = 0; k < 40000; k++) flames.setColorAt(k, EMBER);   // before .count = 0 (buffer sized from count)
        flames.count = 0; flames.frustumCulled = false;
        APP.scene.add(flames);

        // smoke particles drifting with the wind
        const SN = 4000, sp = new Float32Array(SN * 3).fill(-1e5);
        const sg = new THREE.BufferGeometry(); sg.setAttribute('position', new THREE.BufferAttribute(sp, 3));
        smoke = new THREE.Points(sg, new THREE.PointsMaterial({
            size: 7, map: softDot(), color: 0x4b4b4b, transparent: true, opacity: 0.32, depthWrite: false
        }));
        smoke.frustumCulled = false;
        smoke.userData = { vel: new Float32Array(SN * 3), life: new Float32Array(SN), next: 0, n: SN };
        APP.scene.add(smoke);

        // hover cube for ignition placement
        hover = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(VS * 1.05, VS * 1.05, VS * 1.05)),
            new THREE.LineBasicMaterial({ color: 0xff3d00 }));
        hover.visible = false; APP.scene.add(hover);

        APP.updaters.push(update);
        updateStats();
    });

    function softDot() {
        const c = document.createElement('canvas'); c.width = c.height = 64;
        const g = c.getContext('2d'), gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
        gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
        return new THREE.CanvasTexture(c);
    }

    function rebuildTables() {
        if (!grid) return;
        const n = grid.types.length + 1;
        flam = new Float32Array(n); burnSteps = new Uint8Array(n); consumed = new Uint8Array(n);
        grid.types.forEach((t, k) => {
            let f = C.flammability[t] ?? 0;
            if (t === 'building' || t === 'building_roof') f *= bldgFactor;
            flam[k + 1] = f;
            burnSteps[k + 1] = C.burnSteps[t] ?? 5;
            consumed[k + 1] = C.consumed[t] ? 1 : 0;
        });
        burntByType = burntByType || new Int32Array(n);
    }

    F.tintOf = i => !state ? null : state[i] === 1 ? EMBER : state[i] === 2 ? CHAR : null;

    const underWater = ly => grid.worldY(ly) + VS / 2 <= APP.waterLevel;

    function ignite(i) {
        const c = grid.data[i];
        if (!c || state[i] || layers.removed[i] || !flam[c]) return false;
        if (underWater(i % grid.ny)) return false;
        state[i] = 1; timer[i] = burnSteps[c]; burning.push(i);
        layers.tint(i, EMBER);
        return true;
    }

    /** ignite around a picked cell (brush). Returns number of cells ignited. */
    F.igniteAt = function (lx, ly, lz) {
        let n = 0;
        for (let r = 1; r <= 3 && n === 0; r++) {
            for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) for (let dz = -r; dz <= r; dz++) {
                if (dx * dx + dy * dy + dz * dz > r * r + 1) continue;
                const x = lx + dx, y = ly + dy, z = lz + dz;
                if (grid.inside(x, y, z) && ignite(grid.idx(x, y, z))) n++;
            }
        }
        if (n) { setRunning(true); flash(`🔥 Ignited ${n} voxel${n > 1 ? 's' : ''}`); }
        else flash('Nothing flammable here (ground / water / under flood). Try vegetation or a building.');
        updateStats();
        return n;
    };

    function step() {
        if (!burning.length) return;
        F.steps++;
        const V = APP.wind.speed, wd = APP.wind.toDir();
        const moist = Math.max(0.15, Math.min(1.2, 1.25 - humidity / 100 * 0.9));
        const eW = Math.exp(C.windC1 * V);
        const next = [], nx = grid.nx, ny = grid.ny, nz = grid.nz, data = grid.data, rm = layers.removed;

        for (let b = 0; b < burning.length; b++) {
            const i = burning[b];
            if (state[i] !== 1) continue;
            const ly = i % ny, r = (i - ly) / ny, lz = r % nz, lx = (r - lz) / nz;
            if (underWater(ly)) { state[i] = 0; layers.tint(i, new THREE.Color(1, 1, 1)); continue; }

            for (let k = 0; k < OFFS.length; k++) {
                const o = OFFS[k], x = lx + o.dx, y = ly + o.dy, z = lz + o.dz;
                if (x < 0 || y < 0 || z < 0 || x >= nx || y >= ny || z >= nz) continue;
                const n = (x * nz + z) * ny + y, c = data[n];
                if (!c || state[n] || rm[n]) continue;
                const f = flam[c]; if (!f) continue;
                let pw = 1;
                if (o.hl) pw = eW * Math.exp(C.windC2 * V * (o.hx * wd.x + o.hz * wd.z - 1));
                const pv = o.dy > 0 ? C.upwardFactor : (o.dy < 0 ? C.downwardFactor : 1);
                const p = Math.min(0.95, C.baseProbability * f * moist * pw * pv / o.dist);
                if (Math.random() < p && !underWater(y)) {
                    state[n] = 1; timer[n] = burnSteps[c]; next.push(n); layers.tint(n, EMBER);
                }
            }

            // embers carried downwind from burning canopy
            const c0 = data[i];
            if (V > C.emberMinWind && grid.typeName(c0) === 'tree_high' &&
                Math.random() < C.emberChance * (V / C.emberMinWind) * moist) {
                const d = 3 + Math.random() * V * 0.8, lat = (Math.random() - 0.5) * d * 0.5;
                const tx = Math.round(lx + wd.x * d - wd.z * lat), tz = Math.round(lz + wd.z * d + wd.x * lat);
                const ty = grid.topWhere(tx, tz, (cc, idx) => !rm[idx]);
                if (ty >= 0) { const t = grid.idx(tx, ty, tz); if (ignite(t)) next.push(burning.pop()); }
            }

            if (--timer[i] === 0) {
                state[i] = 2;
                const c = data[i];
                burntByType[c]++;
                const col = lx * nz + lz; if (!burntCol[col]) { burntCol[col] = 1; burntArea += VS * VS; }
                if (consumed[c]) layers.remove(i); else layers.tint(i, CHAR);
            } else next.push(i);
        }
        burning = next;
        APP.shadowDirty = true;
        if (!burning.length) { setRunning(false); flash('Fire burnt out'); }
    }

    function reset() {
        if (!grid) return;
        setRunning(false);
        state.fill(0); timer.fill(0); burntCol.fill(0); burntByType.fill(0);
        burning = []; burntArea = 0; F.steps = 0;
        layers.build();
        flames.count = 0;
        const sp = smoke.geometry.attributes.position.array; sp.fill(-1e5); smoke.geometry.attributes.position.needsUpdate = true;
        smoke.userData.life.fill(0);
        updateStats();
    }
    F.reset = reset;

    // ---------------- per-frame ----------------
    let acc = 0, statT = 0, t = 0;
    const m4 = new THREE.Matrix4(), col = new THREE.Color();
    function update(dt) {
        t += dt;
        if (F.running && burning.length) {
            acc += dt;
            const iv = 1 / stepsPerSec;
            let guard = 0;
            while (acc >= iv && guard++ < 5) { step(); acc -= iv; }
        }
        // flames
        const n = Math.min(burning.length, 40000);
        for (let k = 0; k < n; k++) {
            const i = burning[k], [lx, ly, lz] = grid.unpack(i);
            const f = 0.55 + 0.45 * Math.abs(Math.sin(t * 9 + i * 0.37));
            m4.makeScale(f, f * 1.3, f).setPosition(grid.worldX(lx), grid.worldY(ly) + VS * 0.35 * f, grid.worldZ(lz));
            flames.setMatrixAt(k, m4);
            col.setRGB(1, 0.35 + 0.5 * f, 0.05 * f); flames.setColorAt(k, col);
        }
        if (flames) {
            flames.count = n;
            flames.instanceMatrix.needsUpdate = true;
            if (flames.instanceColor) flames.instanceColor.needsUpdate = true;
        }
        updateSmoke(dt);
        statT += dt; if (statT > 0.25) { statT = 0; updateStats(); }
    }

    function updateSmoke(dt) {
        if (!smoke) return;
        const u = smoke.userData, P = smoke.geometry.attributes.position.array;
        const V = APP.wind.speed, wd = APP.wind.toDir();
        // emit
        const emit = burning.length ? Math.min(60, 4 + burning.length * 0.05) : 0;
        for (let e = 0; e < emit; e++) {
            const i = burning[(Math.random() * burning.length) | 0], [lx, ly, lz] = grid.unpack(i);
            const k = u.next; u.next = (u.next + 1) % u.n;
            P[k * 3] = grid.worldX(lx) + (Math.random() - 0.5) * VS;
            P[k * 3 + 1] = grid.worldY(ly) + VS;
            P[k * 3 + 2] = grid.worldZ(lz) + (Math.random() - 0.5) * VS;
            u.vel[k * 3] = wd.x * V * 0.9 + (Math.random() - 0.5);
            u.vel[k * 3 + 1] = 2.5 + Math.random() * 2;
            u.vel[k * 3 + 2] = wd.z * V * 0.9 + (Math.random() - 0.5);
            u.life[k] = 6 + Math.random() * 6;
        }
        for (let k = 0; k < u.n; k++) {
            if (u.life[k] <= 0) continue;
            u.life[k] -= dt;
            if (u.life[k] <= 0) { P[k * 3 + 1] = -1e5; continue; }
            P[k * 3] += u.vel[k * 3] * dt * 3; P[k * 3 + 1] += u.vel[k * 3 + 1] * dt * 3; P[k * 3 + 2] += u.vel[k * 3 + 2] * dt * 3;
        }
        smoke.geometry.attributes.position.needsUpdate = true;
    }

    function updateStats() {
        if (!grid) return;
        const rows = grid.types.map((t, k) => burntByType[k + 1] ? `<span>${CONFIG.LABELS[t] || t}</span><b>${burntByType[k + 1].toLocaleString()}</b>` : '').join('');
        $('fire-stats').innerHTML =
            `<span>Step</span><b>${F.steps}</b><span>Burning voxels</span><b class="hot">${burning.length.toLocaleString()}</b>` +
            `<span>Burnt footprint</span><b>${(burntArea / 10000).toFixed(2)} ha (${burntArea.toLocaleString()} m²)</b>` + rows;
    }

    // ---------------- picking ----------------
    const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
    F.pick = function (clientX, clientY) {
        if (!grid) return null;
        const r = APP.renderer.domElement.getBoundingClientRect();
        ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
        ray.setFromCamera(ndc, APP.camera);
        return pickRay(ray.ray.origin, ray.ray.direction);
    };
    function pickRay(o, d) {
        return grid.raycast(o, d, 4000, (i, c) => !layers.removed[i] && layers.visibleType(c) && layers.instOf[i] >= 0);
    }
    F.pickRay = pickRay;

    const cv = APP.renderer.domElement;
    let down = null;
    cv.addEventListener('pointerdown', e => { if (APP.mode === 'orbit' && F.armed) down = { x: e.clientX, y: e.clientY }; });
    cv.addEventListener('pointerup', e => {
        if (!down) return;
        const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y); down = null;
        if (moved > 5) return;   // it was a drag (orbit), not a click
        const h = F.pick(e.clientX, e.clientY);
        if (h) F.igniteAt(h.lx, h.ly, h.lz);
    });
    let lastMove = 0;
    cv.addEventListener('pointermove', e => {
        if (!F.armed || APP.mode !== 'orbit' || !hover) return;
        const now = performance.now(); if (now - lastMove < 40) return; lastMove = now;
        const h = F.pick(e.clientX, e.clientY);
        hover.visible = !!h;
        if (h) hover.position.set(grid.worldX(h.lx), grid.worldY(h.ly), grid.worldZ(h.lz));
    });

    let flashT;
    function flash(msg) {
        const el = $('toast'); el.textContent = msg; el.classList.add('show');
        clearTimeout(flashT); flashT = setTimeout(() => el.classList.remove('show'), 2600);
    }
    APP.flash = flash;
})();
