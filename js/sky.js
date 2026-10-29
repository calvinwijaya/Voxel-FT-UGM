// =====================================================================
//  SKY — real-time sun position, day/night, stars, weather dimming
//  Live mode follows the clock in WIB (UTC+7). Sun position is computed
//  astronomically for the campus coordinates (NOAA low-precision formulas).
// =====================================================================
(function () {
    const $ = id => document.getElementById(id);
    const TZ = CONFIG.TIMEZONE_OFFSET_H * 3600e3;
    const C = k => new THREE.Color(CONFIG.SKY[k]);
    const SKY = { day: C('day'), golden: C('golden'), twilight: C('twilight'), night: C('night'), overcast: C('overcast') };
    const rad = Math.PI / 180;

    const S = APP.sky = {
        live: true, playing: false,
        date: new Date(),            // simulated instant (UTC based)
        sunAz: 0, sunEl: 0, night: 0,
        flash: 0,                    // lightning (set by rain.js)
        apply
    };

    // ---------- astronomy ----------
    function solar(date, lat, lon) {
        const n = date.getTime() / 86400000 + 2440587.5 - 2451545.0;          // days since J2000
        const L = (280.460 + 0.9856474 * n) % 360;
        const g = ((357.528 + 0.9856003 * n) % 360) * rad;
        const lam = (L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * rad;
        const eps = (23.439 - 0.0000004 * n) * rad;
        const ra = Math.atan2(Math.cos(eps) * Math.sin(lam), Math.cos(lam));
        const dec = Math.asin(Math.sin(eps) * Math.sin(lam));
        const gmst = ((18.697374558 + 24.06570982441908 * n) % 24 + 24) % 24;
        const ha = (gmst * 15 + lon) * rad - ra;
        const la = lat * rad;
        const el = Math.asin(Math.sin(la) * Math.sin(dec) + Math.cos(la) * Math.cos(dec) * Math.cos(ha));
        const az = Math.atan2(-Math.sin(ha), Math.tan(dec) * Math.cos(la) - Math.sin(la) * Math.cos(ha));
        return { az: (az / rad + 360) % 360, el: el / rad };
    }
    S.solar = solar;

    // ---------- local (WIB) helpers ----------
    const local = d => new Date(d.getTime() + TZ);                 // read with getUTC*
    const fmtTime = d => { const l = local(d); return `${String(l.getUTCHours()).padStart(2, '0')}:${String(l.getUTCMinutes()).padStart(2, '0')}`; };
    const fmtDate = d => local(d).toISOString().slice(0, 10);
    const minutesOfDay = d => { const l = local(d); return l.getUTCHours() * 60 + l.getUTCMinutes(); };
    function setMinutes(m) {          // keep the simulated calendar day, change the clock time
        const l = local(S.date); l.setUTCHours(0, Math.round(m), 0, 0);
        S.date = new Date(l.getTime() - TZ);
    }
    S.fmtTime = fmtTime;

    // ---------- stars ----------
    const starGeo = new THREE.BufferGeometry(), NS = 1600, sp = new Float32Array(NS * 3);
    for (let i = 0; i < NS; i++) {
        const u = Math.random(), v = Math.random() * 0.95 + 0.05;           // upper hemisphere
        const th = u * Math.PI * 2, y = v, r = Math.sqrt(1 - y * y);
        sp[i * 3] = Math.cos(th) * r * 3000; sp[i * 3 + 1] = y * 3000; sp[i * 3 + 2] = Math.sin(th) * r * 3000;
    }
    starGeo.setAttribute('position', new THREE.BufferAttribute(sp, 3));
    const stars = new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0xffffff, size: 1.6, sizeAttenuation: false, transparent: true, opacity: 0, fog: false, depthWrite: false }));
    stars.frustumCulled = false; stars.renderOrder = -1;
    APP.scene.add(stars);
    APP.camera.far = Math.max(APP.camera.far, 6500); APP.camera.updateProjectionMatrix();

    // ---------- apply lighting ----------
    const tmp = new THREE.Color(), sunCol = new THREE.Color(), dir = new THREE.Vector3();
    const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
    let lastAz = null, lastEl = null;

    function apply() {
        const { lat, lon } = CONFIG.GEOREF;
        const p = solar(S.date, lat, lon);
        S.sunAz = p.az; S.sunEl = p.el;
        const el = p.el;
        const wx = APP.weather ? APP.weather.effect : { cloud: 0, rain: 0 };
        const overcast = Math.min(1, wx.cloud * 0.55 + wx.rain * 0.45);

        // sky colour by sun elevation
        if (el >= 8) tmp.copy(SKY.day);
        else if (el >= 0) tmp.copy(SKY.golden).lerp(SKY.day, el / 8);
        else if (el >= -6) tmp.copy(SKY.twilight).lerp(SKY.golden, (el + 6) / 6);
        else if (el >= -12) tmp.copy(SKY.night).lerp(SKY.twilight, (el + 12) / 6);
        else tmp.copy(SKY.night);
        const dayK = smooth(-6, 6, el);
        tmp.lerp(SKY.overcast.clone().multiplyScalar(0.25 + 0.75 * dayK), overcast * 0.85);
        if (S.flash > 0) tmp.lerp(new THREE.Color(0xdfe6ff), S.flash * 0.8);
        if (!APP.userSky) { APP.scene.background.copy(tmp); APP.scene.fog.color.copy(tmp); }
        else { APP.scene.background.set(APP.userSky); APP.scene.fog.color.set(APP.userSky); }

        // sun or moon
        const sunUp = el > -3;
        S.night = 1 - dayK;
        const b = APP.bounds || { cx: 0, cz: 0, minY: 0 };
        let az = p.az, e = Math.max(el, 2);
        if (!sunUp) { az = (p.az + 180) % 360; e = 55; }                     // simple moon opposite the sun
        dir.set(Math.sin(az * rad) * Math.cos(e * rad), Math.sin(e * rad), -Math.cos(az * rad) * Math.cos(e * rad));
        APP.sun.position.set(b.cx + dir.x * 1500, b.minY + dir.y * 1500, b.cz + dir.z * 1500);
        APP.sun.target.position.set(b.cx, b.minY, b.cz);

        if (sunUp) {
            const k = smooth(-3, 12, el);
            sunCol.setRGB(1, 0.72 + 0.28 * smooth(0, 15, el), 0.5 + 0.5 * smooth(0, 20, el));
            APP.sun.color.copy(sunCol);
            APP.sun.intensity = 0.85 * k * (1 - 0.7 * overcast);
        } else {
            APP.sun.color.set(0x9db4ff);
            APP.sun.intensity = 0.22 * (1 - 0.5 * overcast);
        }
        APP.ambient.color.setRGB(1, 1, 1).lerp(new THREE.Color(0x7a88c8), S.night);
        APP.ambient.intensity = (0.34 + 0.28 * dayK) * (1 - 0.12 * overcast) + S.flash * 1.2;
        stars.material.opacity = Math.max(0, S.night - overcast * 0.9) * 0.9;
        stars.position.set(b.cx, b.minY, b.cz);
        APP.scene.fog.near = 300 - 150 * overcast; APP.scene.fog.far = 2200 - 1200 * overcast * Math.max(wx.rain, 0.3);

        // shadows only need refreshing if the light really moved
        if (lastAz === null || Math.abs(az - lastAz) > 0.15 || Math.abs(e - lastEl) > 0.15) { APP.shadowDirty = true; lastAz = az; lastEl = e; }
        updateUI();
    }

    // ---------- UI ----------
    const slider = $('time-slider'), dateEl = $('date-input');
    function updateUI() {
        slider.value = minutesOfDay(S.date);
        $('current-time-label').textContent = `${fmtTime(S.date)} WIB · sun ${S.sunEl >= 0 ? S.sunEl.toFixed(0) + '° up' : 'below horizon'}`;
        if (document.activeElement !== dateEl) dateEl.value = fmtDate(S.date);
        $('time-live').classList.toggle('active', S.live);
        $('play-btn').textContent = S.playing ? 'Pause' : 'Play';
        $('play-btn').classList.toggle('danger', S.playing);
        const chip = $('chip-time'); if (chip) chip.textContent = (S.sunEl > -3 ? '☀️ ' : '🌙 ') + fmtTime(S.date) + (S.live ? '' : ' (sim)');
    }
    slider.addEventListener('input', () => { S.live = false; S.playing = false; setMinutes(+slider.value); apply(); });
    dateEl.addEventListener('change', () => {
        if (!dateEl.value) return;
        const m = minutesOfDay(S.date);
        S.date = new Date(Date.parse(dateEl.value + 'T00:00:00Z') - TZ); setMinutes(m);
        S.live = false; apply();
    });
    $('time-live').onclick = () => { S.live = true; S.playing = false; S.date = new Date(); apply(); };
    $('play-btn').onclick = () => { S.playing = !S.playing; if (S.playing) S.live = false; updateUI(); };

    // ---------- loop ----------
    let acc = 0;
    APP.updaters.push(dt => {
        if (S.playing) {                 // 1 simulated hour every 2 s
            S.date = new Date(S.date.getTime() + dt * 1800e3);
            apply();
            return;
        }
        acc += dt;
        if (S.flash > 0 || acc > (S.live ? 20 : 1e9)) {
            if (S.live && acc > 20) { S.date = new Date(); acc = 0; }
            apply();
        }
    });
    document.addEventListener('voxels-ready', apply);
    document.addEventListener('weather-effect', apply);
    apply();
})();
