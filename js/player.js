// =====================================================================
//  PLAYER — Minecraft-style first-person / third-person exploration
//  WASD move · Mouse look · Space jump · Shift run · G fly · V switch view
//  F ignite at crosshair · R respawn · Esc release mouse (Esc again = orbit)
// =====================================================================
(function () {
    const VS = CONFIG.VOXEL_SIZE;
    const R = 0.3, H = 1.75, EYE = 1.62;            // player box (metres)
    const GRAV = 22, JUMP = 9.6, WALK = 4.5, RUN = 9, FLY = 18;
    const $ = id => document.getElementById(id);
    const cam = APP.camera, cv = APP.renderer.domElement;

    const P = APP.player = {
        pos: new THREE.Vector3(), vel: new THREE.Vector3(),
        yaw: 0, pitch: 0, onGround: false, fly: false, tpDist: 6, spawned: false,
        analog: { x: 0, y: 0 }          // virtual joystick (touch), -1..1
    };
    const keys = {};
    let grid, layers, solidCode, terrainCode, saved = null, eyeOffset = 0, walkPhase = 0, facing = 0;

    document.addEventListener('voxels-ready', () => {
        grid = APP.grid; layers = APP.layers;
        const n = grid.types.length + 1;
        solidCode = new Uint8Array(n); terrainCode = new Uint8Array(n);
        ['ground', 'river', 'building', 'building_roof'].forEach(t => { if (grid.code[t]) solidCode[grid.code[t]] = 1; });
        ['ground', 'river'].forEach(t => { if (grid.code[t]) terrainCode[grid.code[t]] = 1; });
        APP.scene.add(avatar);
        APP.updaters.push(update);
    });

    // ---------------- avatar (blocky person) ----------------
    const avatar = new THREE.Group();
    const mat = c => new THREE.MeshLambertMaterial({ color: c });
    const box = (w, h, d, m) => { const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m); b.castShadow = true; return b; };
    const skin = mat(0xe0ac69), shirt = mat(0x2563eb), pants = mat(0x1f2937), hair = mat(0x1c1917);
    const legL = new THREE.Group(), legR = new THREE.Group(), armL = new THREE.Group(), armR = new THREE.Group();
    [[legL, -0.13], [legR, 0.13]].forEach(([g, x]) => { const m = box(0.24, 0.85, 0.26, pants); m.position.y = -0.42; g.add(m); g.position.set(x, 0.85, 0); avatar.add(g); });
    const body = box(0.55, 0.65, 0.3, shirt); body.position.y = 1.18; avatar.add(body);
    [[armL, -0.38], [armR, 0.38]].forEach(([g, x]) => { const m = box(0.2, 0.62, 0.22, shirt); m.position.y = -0.28; g.add(m); const h = box(0.2, 0.12, 0.22, skin); h.position.y = -0.64; g.add(h); g.position.set(x, 1.48, 0); avatar.add(g); });
    const head = box(0.38, 0.38, 0.38, skin); head.position.y = 1.72; avatar.add(head);
    const hairM = box(0.4, 0.12, 0.4, hair); hairM.position.y = 1.92; avatar.add(hairM);
    avatar.visible = false;

    // ---------------- collision helpers ----------------
    function solidAt(lx, ly, lz) {
        if (ly < 0) return true;                                        // floor below the dataset
        if (lx < 0 || lz < 0 || lx >= grid.nx || lz >= grid.nz) return !P.fly; // invisible wall
        if (ly >= grid.ny) return false;
        const i = grid.idx(lx, ly, lz), c = grid.data[i];
        return c && solidCode[c] && !layers.removed[i];
    }
    /** returns highest blocking cell Y and whether all blockers are terrain, or null */
    function collide(px, py, pz) {
        const x0 = grid.cellX(px - R), x1 = grid.cellX(px + R - 1e-4);
        const y0 = grid.cellY(py), y1 = grid.cellY(py + H - 1e-4);
        const z0 = grid.cellZ(pz - R), z1 = grid.cellZ(pz + R - 1e-4);
        let hit = null;
        for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) {
            if (solidAt(x, y, z)) {
                const inside = grid.inside(x, Math.max(0, y), z);
                const terr = inside && y >= 0 && terrainCode[grid.data[grid.idx(x, y, z)]];
                if (!hit) hit = { top: y, terrainOnly: !!terr };
                else { hit.top = Math.max(hit.top, y); hit.terrainOnly = hit.terrainOnly && !!terr; }
            }
        }
        return hit;
    }
    const cellTop = ly => grid.worldY(ly) + VS / 2;

    function moveAxis(axis, d) {
        const p = P.pos;
        p[axis] += d;
        const hit = collide(p.x, p.y, p.z);
        if (!hit) return;
        if (axis === 'y') {
            if (d < 0) { p.y = cellTop(grid.cellY(p.y)); P.onGround = true; }
            else p.y -= d;
            P.vel.y = 0;
            return;
        }
        // auto step-up one voxel of terrain (Minecraft auto-jump feel)
        const lift = cellTop(hit.top) - p.y;
        if (!P.fly && P.onGround && hit.terrainOnly && lift > 0 && lift <= VS + 0.05 && !collide(p.x, p.y + lift, p.z)) {
            p.y += lift; eyeOffset -= lift;
            return;
        }
        p[axis] -= d;
        P.vel[axis] = 0;
    }

    // ---------------- spawn ----------------
    function spawn() {
        const t = APP.controls.target;
        const cx = grid.cellX(t.x), cz = grid.cellZ(t.z);
        for (let r = 0; r < 120; r++) {
            for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
                if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
                const lx = cx + dx, lz = cz + dz;
                const ty = grid.topWhere(lx, lz, (c, i) => solidCode[c] && !layers.removed[i]);
                if (ty < 0 || !terrainCode[grid.get(lx, ty, lz)]) continue;
                P.pos.set(grid.worldX(lx), cellTop(ty), grid.worldZ(lz));
                if (collide(P.pos.x, P.pos.y, P.pos.z)) continue;
                P.vel.set(0, 0, 0); P.spawned = true;
                // face the direction the orbit camera was looking
                const d = new THREE.Vector3(); cam.getWorldDirection(d);
                P.yaw = Math.atan2(-d.x, -d.z); P.pitch = 0; facing = P.yaw;
                return true;
            }
        }
        return false;
    }

    // ---------------- mode switching ----------------
    function enter(mode) {
        if (!grid) return;
        if (APP.mode === 'orbit') {
            saved = { pos: cam.position.clone(), target: APP.controls.target.clone() };
            if (!spawn()) { APP.flash && APP.flash('No open ground found near the view centre'); return; }
        }
        APP.mode = mode;
        if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); // Space must not re-click buttons
        APP.controls.enabled = false;
        cam.rotation.order = 'YXZ';
        avatar.visible = mode === 'tp';
        document.body.classList.add('walking');
        document.body.classList.remove('igniting');
        if (APP.isTouch) document.getElementById('sidebar-container').classList.add('collapsed');
        syncButtons();
        lock();
    }
    function exit() {
        if (APP.mode === 'orbit') return;
        APP.mode = 'orbit';
        avatar.visible = false;
        cam.rotation.order = 'XYZ';
        if (document.pointerLockElement) document.exitPointerLock();
        if (saved) { cam.position.copy(saved.pos); APP.controls.target.copy(saved.target); }
        APP.controls.enabled = true; APP.controls.update();
        document.body.classList.remove('walking');
        if (APP.fire && APP.fire.armed) document.body.classList.add('igniting');
        $('underwater').style.opacity = 0;
        syncButtons();
    }
    APP.enterMode = m => m === 'orbit' ? exit() : enter(m);

    function syncButtons() {
        ['orbit', 'fp', 'tp'].forEach(m => $('view-' + m).classList.toggle('active', APP.mode === m));
        $('hud-mode').textContent = APP.mode === 'fp' ? 'First person' : APP.mode === 'tp' ? 'Third person' : '';
        $('hud-fly').style.display = P.fly ? 'inline-block' : 'none';
        document.body.classList.toggle('flying', P.fly);
    }
    $('view-orbit').onclick = () => exit();
    $('view-fp').onclick = () => enter('fp');
    $('view-tp').onclick = () => enter('tp');

    // ---------------- input ----------------
    const lock = () => { if (APP.isTouch) return; if (cv.requestPointerLock) try { const r = cv.requestPointerLock(); if (r && r.catch) r.catch(() => {}); } catch (e) { } };
    cv.addEventListener('click', () => { if (APP.mode !== 'orbit' && !document.pointerLockElement) lock(); });
    document.addEventListener('pointerlockchange', () => {
        $('hud-unlocked').style.display = (APP.mode !== 'orbit' && !document.pointerLockElement) ? 'block' : 'none';
    });
    document.addEventListener('mousemove', e => {
        if (APP.mode === 'orbit' || !document.pointerLockElement) return;
        look(e.movementX, e.movementY);
    });
    // drag-to-look fallback (touch / no pointer lock)
    let drag = null;
    cv.addEventListener('pointerdown', e => {
        if (APP.mode !== 'orbit' && !document.pointerLockElement && !drag) drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
    });
    const endDrag = e => { if (drag && e.pointerId === drag.id) drag = null; };
    addEventListener('pointerup', endDrag);
    addEventListener('pointercancel', endDrag);
    addEventListener('pointermove', e => {
        if (!drag || e.pointerId !== drag.id) return;   // ignore the joystick finger
        const k = e.pointerType === 'touch' ? 1.8 : 1.5;
        look((e.clientX - drag.x) * k, (e.clientY - drag.y) * k); drag.x = e.clientX; drag.y = e.clientY;
    });
    function look(dx, dy) {
        P.yaw -= dx * 0.0022;
        P.pitch = Math.max(-1.5, Math.min(1.5, P.pitch - dy * 0.0022));
    }
    cv.addEventListener('wheel', e => { if (APP.mode === 'tp') { P.tpDist = Math.max(2, Math.min(30, P.tpDist + e.deltaY * 0.01)); e.preventDefault(); } }, { passive: false });

    addEventListener('keydown', e => {
        if (APP.mode === 'orbit' || e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
        keys[e.code] = true;
        if (e.code === 'Escape' && !document.pointerLockElement) exit();
        if (e.code === 'KeyV') { enter(APP.mode === 'fp' ? 'tp' : 'fp'); }
        if (e.code === 'KeyG') { P.fly = !P.fly; P.vel.y = 0; syncButtons(); APP.flash && APP.flash(P.fly ? 'Fly mode ON (Space up · C down)' : 'Fly mode OFF'); }
        if (e.code === 'KeyR') spawn();
        if (e.code === 'KeyF') igniteAtCrosshair();
        if (e.code === 'Space') e.preventDefault();
    });
    addEventListener('keyup', e => { keys[e.code] = false; });
    addEventListener('blur', () => Object.keys(keys).forEach(k => keys[k] = false));

    const _fwd = new THREE.Vector3();
    function igniteAtCrosshair() {
        cam.getWorldDirection(_fwd);
        const h = APP.fire.pickRay(cam.position, _fwd);
        if (h && h.dist < 300) APP.fire.igniteAt(h.lx, h.ly, h.lz);
        else APP.flash('Aim at vegetation or a building (closer than 300 m)');
    }

    // ---------------- per-frame ----------------
    const target = new THREE.Vector3(), back = new THREE.Vector3();
    function update(dt) {
        if (APP.mode === 'orbit') return;
        const fwdX = -Math.sin(P.yaw), fwdZ = -Math.cos(P.yaw);
        const rgtX = Math.cos(P.yaw), rgtZ = -Math.sin(P.yaw);
        let ix = 0, iz = 0;
        if (keys.KeyW || keys.ArrowUp) { ix += fwdX; iz += fwdZ; }
        if (keys.KeyS || keys.ArrowDown) { ix -= fwdX; iz -= fwdZ; }
        if (keys.KeyD || keys.ArrowRight) { ix += rgtX; iz += rgtZ; }
        if (keys.KeyA || keys.ArrowLeft) { ix -= rgtX; iz -= rgtZ; }
        const a = P.analog, am = Math.hypot(a.x, a.y);
        if (am > 0.08) { ix += fwdX * -a.y + rgtX * a.x; iz += fwdZ * -a.y + rgtZ * a.x; }
        const il = Math.hypot(ix, iz); if (il > 1) { ix /= il; iz /= il; }   // analog keeps partial speed
        const run = keys.ShiftLeft || keys.ShiftRight || am > 0.92;
        const sp = P.fly ? FLY * (run ? 3 : 1) : (run ? RUN : WALK);

        const k = Math.min(1, dt * (P.onGround || P.fly ? 12 : 3));
        P.vel.x += (ix * sp - P.vel.x) * k;
        P.vel.z += (iz * sp - P.vel.z) * k;
        if (P.fly) {
            const vy = (keys.Space ? 1 : 0) - (keys.KeyC || keys.ControlLeft ? 1 : 0);
            P.vel.y += (vy * sp - P.vel.y) * k;
        } else {
            if (keys.Space && P.onGround) { P.vel.y = JUMP; P.onGround = false; }
            P.vel.y -= GRAV * dt;
            // floating if under flood water
            if (P.pos.y + 1.0 < APP.waterLevel) P.vel.y = Math.max(P.vel.y, keys.Space ? 3 : -1.5);
        }

        // integrate with sub-steps (no tunnelling)
        const maxD = Math.max(Math.abs(P.vel.x), Math.abs(P.vel.y), Math.abs(P.vel.z)) * dt;
        const n = Math.max(1, Math.ceil(maxD / 0.4));
        const wasGround = P.onGround;
        P.onGround = false;
        for (let s = 0; s < n; s++) {
            moveAxis('x', P.vel.x * dt / n);
            moveAxis('z', P.vel.z * dt / n);
            moveAxis('y', P.vel.y * dt / n);
        }
        if (!P.onGround && wasGround && P.vel.y <= 0 && !P.fly) {
            // keep ground contact when walking down a 1-voxel step
            if (collide(P.pos.x, P.pos.y - 0.05, P.pos.z)) P.onGround = true;
        }
        if (P.pos.y < APP.bounds.minY - 60) spawn();

        eyeOffset += (0 - eyeOffset) * Math.min(1, dt * 10);
        const hs = Math.hypot(P.vel.x, P.vel.z);
        walkPhase += hs * dt * 2.2;

        if (APP.mode === 'fp') {
            cam.position.set(P.pos.x, P.pos.y + EYE + eyeOffset, P.pos.z);
            cam.rotation.set(P.pitch, P.yaw, 0, 'YXZ');
        } else {
            // avatar
            if (hs > 0.3) {
                const want = Math.atan2(-P.vel.x, -P.vel.z);
                let d = want - facing; d = Math.atan2(Math.sin(d), Math.cos(d));
                facing += d * Math.min(1, dt * 10);
            }
            avatar.position.set(P.pos.x, P.pos.y + eyeOffset, P.pos.z);
            avatar.rotation.y = facing;
            const sw = P.onGround ? Math.sin(walkPhase) * Math.min(1, hs / 4) * 0.8 : 0.3;
            legL.rotation.x = sw; legR.rotation.x = -sw; armL.rotation.x = -sw; armR.rotation.x = sw;
            // camera boom with collision
            target.set(P.pos.x, P.pos.y + 1.6 + eyeOffset, P.pos.z);
            back.set(Math.sin(P.yaw) * Math.cos(P.pitch), -Math.sin(P.pitch), Math.cos(P.yaw) * Math.cos(P.pitch));
            const hit = grid.raycast(target, back, P.tpDist, (i, c) => !layers.removed[i] && layers.visibleType(c)); // trees too, so the view never sits inside a canopy
            const d = hit ? Math.max(0.6, hit.dist - 0.3) : P.tpDist;
            cam.position.copy(target).addScaledVector(back, d);
            target.y += 0.6;          // look slightly over the head so the crosshair is free
            cam.lookAt(target);
        }
        $('underwater').style.opacity = cam.position.y < APP.waterLevel ? 1 : 0;
        $('hud-pos').textContent = `${(P.pos.y).toFixed(0)} m elev.`;
    }
})();
