// =====================================================================
//  RAIN & CLOUDS — driven by APP.weather.effect (live or manual override)
//   • blocky clouds (Minecraft style) that drift with the wind
//   • rain streaks around whatever the camera looks at, slanted by the wind
//   • lightning flash + bolt during thunderstorms
// =====================================================================
(function () {
    const CELL = 20, FIELD = 1800, NC = Math.ceil(FIELD / CELL);
    let clouds, rain, bolt, b, cloudY;
    let ox = 0, oz = 0, lastIX = null, lastIZ = null, lastCover = -1;
    const eff = () => APP.weather.effect;

    // ---------- value noise ----------
    const P = 256, lattice = new Float32Array(P * P).map(() => Math.random());
    const lat = (x, z) => lattice[((x % P + P) % P) * P + ((z % P + P) % P)];
    function vnoise(x, z) {
        const ix = Math.floor(x), iz = Math.floor(z), fx = x - ix, fz = z - iz;
        const sx = fx * fx * (3 - 2 * fx), sz = fz * fz * (3 - 2 * fz);
        const a = lat(ix, iz), b2 = lat(ix + 1, iz), c = lat(ix, iz + 1), d = lat(ix + 1, iz + 1);
        return a + (b2 - a) * sx + (c - a) * sz + (a - b2 - c + d) * sx * sz;
    }
    const cloudNoise = (x, z) => vnoise(x / 7, z / 7) * 0.65 + vnoise(x / 2.5 + 50, z / 2.5) * 0.35;

    document.addEventListener('voxels-ready', () => {
        b = APP.bounds;
        cloudY = b.maxY + 220;

        // clouds
        const geo = new THREE.BoxGeometry(CELL, 8, CELL);
        const mat = new THREE.MeshLambertMaterial({ color: 0xffffff, transparent: true, opacity: 0.82, depthWrite: false });
        clouds = new THREE.InstancedMesh(geo, mat, NC * NC * 3);   // up to 3 blocks per cell
        clouds.count = 0; clouds.frustumCulled = false; clouds.renderOrder = 2;
        APP.scene.add(clouds);

        // rain
        const N = APP.isTouch ? Math.round(CONFIG.WEATHER.rainDrops * 0.45) : CONFIG.WEATHER.rainDrops;
        const pos = new Float32Array(N * 6);
        const rg = new THREE.BufferGeometry(); rg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        rain = new THREE.LineSegments(rg, new THREE.LineBasicMaterial({ color: 0xc9d6e6, transparent: true, opacity: 0.5, depthWrite: false }));
        rain.frustumCulled = false; rain.visible = false;
        rain.userData = { N, st: new Float32Array(N * 3), init: false };
        APP.scene.add(rain);

        // lightning bolt
        const bg = new THREE.BufferGeometry(); bg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(14 * 3), 3));
        bolt = new THREE.Line(bg, new THREE.LineBasicMaterial({ color: 0xeef2ff, fog: false }));
        bolt.visible = false; bolt.frustumCulled = false;
        APP.scene.add(bolt);

        APP.updaters.push(update);
    });

    // ---------- clouds ----------
    const m4 = new THREE.Matrix4();
    function buildClouds(ix, iz, cover) {
        const thr = 0.8 - 0.62 * cover;
        let k = 0;
        const half = NC / 2, R2 = half * half;
        for (let i = 0; i < NC; i++) for (let j = 0; j < NC; j++) {
            const di = i - half, dj = j - half;
            if (di * di + dj * dj > R2) continue;                       // round field, no square edge
            const n = cloudNoise(i + ix, j + iz);
            if (n < thr) continue;
            const x = b.cx + di * CELL, z = b.cz + dj * CELL;
            m4.makeTranslation(x, cloudY, z); clouds.setMatrixAt(k++, m4);
            if (n > thr + 0.12) { m4.makeTranslation(x, cloudY + 8, z); clouds.setMatrixAt(k++, m4); }   // thicker core
            if (n > thr + 0.2) { m4.makeTranslation(x, cloudY - 8, z); clouds.setMatrixAt(k++, m4); }
        }
        clouds.count = k;
        clouds.instanceMatrix.needsUpdate = true;
    }

    // ---------- rain ----------
    const focus = new THREE.Vector3();
    function rainBox() {
        const cam = APP.camera;
        if (APP.mode === 'orbit') {
            focus.copy(APP.controls.target);
            const d = cam.position.distanceTo(focus);
            return { S: Math.min(700, Math.max(60, d * 0.75)), top: focus.y + Math.min(400, Math.max(50, d * 0.6)) };
        }
        focus.copy(cam.position);
        return { S: 45, top: cam.position.y + 35 };
    }
    const groundAt = (x, z) => APP.terrainTopAt ? APP.terrainTopAt(x, z) : APP.minGroundTop;
    function respawnDrop(st, i, box, anyHeight) {
        st[i * 3] = focus.x + (Math.random() * 2 - 1) * box.S;
        st[i * 3 + 2] = focus.z + (Math.random() * 2 - 1) * box.S;
        const g = groundAt(st[i * 3], st[i * 3 + 2]);
        st[i * 3 + 1] = anyHeight ? g + Math.random() * (box.top - g) : box.top + Math.random() * 10;
    }

    // ---------- lightning ----------
    let nextStrike = 4, flashSeq = [];
    function strike() {
        const p = bolt.geometry.attributes.position.array;
        let x = b.cx + (Math.random() - 0.5) * b.width, z = b.cz + (Math.random() - 0.5) * b.depth;
        const g = groundAt(x, z), n = p.length / 3;
        for (let k = 0; k < n; k++) {
            const t = k / (n - 1);
            if (k) { x += (Math.random() - 0.5) * 18; z += (Math.random() - 0.5) * 18; }
            p[k * 3] = x; p[k * 3 + 1] = cloudY - (cloudY - g) * t; p[k * 3 + 2] = z;
        }
        bolt.geometry.attributes.position.needsUpdate = true;
        flashSeq = [0, 0.09, 0.22];     // double flicker
    }

    // ---------- per frame ----------
    let tFlash = 0;
    function update(dt) {
        const e = eff(), W = APP.wind, d = W.toDir();
        // clouds: drift with (stronger) upper-level wind
        const cover = e.cloud;
        clouds.visible = cover > 0.04;
        if (clouds.visible) {
            const v = Math.max(1.5, W.speed * 2) * 3;                  // visual acceleration ×3
            ox += d.x * v * dt / CELL; oz += d.z * v * dt / CELL;
            const ix = Math.floor(-ox), iz = Math.floor(-oz);
            if (ix !== lastIX || iz !== lastIZ || Math.abs(cover - lastCover) > 0.01) {
                buildClouds(ix, iz, cover); lastIX = ix; lastIZ = iz; lastCover = cover;
            }
            clouds.position.set((ox + ix) * CELL, 0, (oz + iz) * CELL);
            const night = APP.sky ? APP.sky.night : 0;
            const shade = 1 - 0.45 * Math.min(1, e.rain * 1.3) - 0.5 * night;
            clouds.material.color.setScalar(Math.max(0.25, shade) + (APP.sky ? APP.sky.flash * 0.6 : 0));
            const above = APP.camera.position.y > cloudY;              // looking down through them
            clouds.material.opacity = (above ? 0.35 : 0.82) * Math.min(1, cover * 1.6 + 0.2);
        }

        // rain
        rain.visible = e.rain > 0.01;
        if (rain.visible) {
            const u = rain.userData, st = u.st, pos = rain.geometry.attributes.position.array;
            const box = rainBox();
            const active = Math.round(u.N * Math.min(1, 0.25 + e.rain * 0.75));
            const fall = 9 * (1 + box.S / 160), len = 0.7 + box.S * 0.018;
            const wx = d.x * W.speed * 0.8, wz = d.z * W.speed * 0.8;
            const sp = Math.hypot(wx, fall, wz);
            if (!u.init) { for (let i = 0; i < u.N; i++) respawnDrop(st, i, box, true); u.init = true; }
            for (let i = 0; i < active; i++) {
                const o = i * 3;
                st[o] += wx * dt; st[o + 1] -= fall * dt; st[o + 2] += wz * dt;
                if (st[o + 1] < groundAt(st[o], st[o + 2]) || Math.abs(st[o] - focus.x) > box.S || Math.abs(st[o + 2] - focus.z) > box.S)
                    respawnDrop(st, i, box, st[o + 1] > box.top + 50 || Math.abs(st[o] - focus.x) > box.S * 1.5);
                const k = i * 6;
                pos[k] = st[o]; pos[k + 1] = st[o + 1]; pos[k + 2] = st[o + 2];
                pos[k + 3] = st[o] - wx / sp * len; pos[k + 4] = st[o + 1] + fall / sp * len; pos[k + 5] = st[o + 2] - wz / sp * len;
            }
            rain.geometry.setDrawRange(0, active * 2);
            rain.geometry.attributes.position.needsUpdate = true;
            const night = APP.sky ? APP.sky.night : 0;
            rain.material.opacity = (0.3 + 0.35 * e.rain) * (1 - 0.4 * night);
        }

        // lightning
        if (e.storm) {
            nextStrike -= dt;
            if (nextStrike <= 0) { strike(); nextStrike = 3 + Math.random() * 9; tFlash = 0; }
        }
        if (flashSeq.length) {
            tFlash += dt;
            const on = flashSeq.some(s => tFlash >= s && tFlash < s + 0.07);
            APP.sky.flash = on ? 1 : Math.max(0, APP.sky.flash - dt * 8);
            bolt.visible = on;
            if (tFlash > 0.4) { flashSeq = []; bolt.visible = false; }
        } else if (APP.sky && APP.sky.flash > 0) APP.sky.flash = Math.max(0, APP.sky.flash - dt * 8);
    }
})();
