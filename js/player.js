// =====================================================================
//  PLAYER — Minecraft-style first-person / third-person exploration
//  Third person = an orange tabby cat (it grows wings in fly mode).
//  WASD move · Mouse look · Space jump · Shift run · G fly · V switch view
//  F ignite at crosshair · R respawn · Esc release mouse (Esc again = orbit)
// =====================================================================
(function () {
    const VS = CONFIG.VOXEL_SIZE, PC = CONFIG.PLAYER;
    // collision boxes: a person in first person, the cat in third person
    const BODY = {
        fp: { R: 0.3, H: 1.75, eye: PC.fpEyeHeight },
        tp: { R: 0.45, H: 1.2, eye: 1.05 }
    };
    const GRAV = 22, WALK = 4.5, RUN = 9, FLY = 18;
    const JUMP = Math.sqrt(2 * GRAV * PC.jumpHeight);          // apex = jumpHeight (> 1 voxel)
    const $ = id => document.getElementById(id);
    const cam = APP.camera, cv = APP.renderer.domElement;

    const P = APP.player = {
        pos: new THREE.Vector3(), vel: new THREE.Vector3(),
        yaw: 0, pitch: 0, onGround: false, fly: false, tpDist: 6, spawned: false,
        analog: { x: 0, y: 0 }          // virtual joystick (touch), -1..1
    };
    const keys = {};
    let grid, layers, solidCode, stepCode, saved = null, eyeOffset = 0, walkPhase = 0, facing = 0, t = 0;
    const box = () => BODY[APP.mode === 'tp' ? 'tp' : 'fp'];

    document.addEventListener('voxels-ready', () => {
        grid = APP.grid; layers = APP.layers;
        const n = grid.types.length + 1;
        solidCode = new Uint8Array(n); stepCode = new Uint8Array(n);
        // everything is solid now, vegetation included
        ['ground', 'river', 'building', 'building_roof', 'tree_low', 'tree_high'].forEach(t => { if (grid.code[t]) solidCode[grid.code[t]] = 1; });
        // single-voxel ledges of these are climbed automatically (no jump needed)
        ['ground', 'river', 'tree_low'].forEach(t => { if (grid.code[t]) stepCode[grid.code[t]] = 1; });
        APP.scene.add(cat);
        APP.updaters.push(update);
    });

    // =================================================================
    //  The cat (local forward = -Z, feet at y = 0)
    // =================================================================
    const cat = new THREE.Group();
    let head, legs, tail, wings;
    // the avatar comes from js/cats.js (chosen in the "Cat Avatar" panel)
    function setCat(id) {
        const def = CATS.find(c => c.id === id) || CATS[0];
        const wasFlying = wings && wings[0].userData.grow;
        ({ head, legs, tail, wings } = buildCat(cat, def));
        if (wasFlying) wings.forEach(w => w.userData.grow = wasFlying);
        APP.catDef = def;
    }
    setCat(window.CAT_CHOICE);
    APP.setCat = setCat;
    cat.visible = false;
    APP.cat = cat;

    function animateCat(dt, hs) {
        t += dt;
        const moving = Math.min(1, hs / 4);
        // legs: trot (diagonal pairs), tucked while airborne
        const ph = Math.sin(walkPhase * 1.3) * 0.75 * moving;
        if (P.onGround || P.fly) {
            const tuck = P.fly ? 0.9 : 0;
            legs[0].rotation.x = ph + tuck; legs[3].rotation.x = ph - tuck;
            legs[1].rotation.x = -ph + tuck; legs[2].rotation.x = -ph - tuck;
        } else {
            legs[0].rotation.x = legs[1].rotation.x = -0.6;       // reach forward when jumping
            legs[2].rotation.x = legs[3].rotation.x = 0.7;
        }
        // tail: curls up, sways
        tail.forEach((g, k) => {
            g.rotation.x = k === 0 ? -0.9 + 0.15 * moving : -0.15 - 0.04 * k;
            g.rotation.y = Math.sin(t * 2.2 - k * 0.6) * (0.12 + 0.05 * k) * (P.fly ? 0.4 : 1);
        });
        head.rotation.x = Math.max(-0.4, Math.min(0.35, -P.pitch * 0.35));
        // wings
        wings.forEach(w => {
            const u = w.userData;
            u.grow += ((P.fly ? 1 : 0) - u.grow) * Math.min(1, dt * 6);
            w.visible = u.grow > 0.02;
            w.scale.setScalar(u.grow);
            const flap = Math.sin(t * (hs > 2 || Math.abs(P.vel.y) > 1 ? 11 : 6)) * 0.55;
            u.arm.rotation.z = u.s * (0.15 + flap);
            u.arm.rotation.y = u.s * 0.15;
        });
        // bank slightly while flying
        cat.rotation.z = P.fly ? Math.max(-0.25, Math.min(0.25, (P.analog.x || 0) * -0.25)) : 0;
    }

    // =================================================================
    //  Collision
    // =================================================================
    function solidAt(lx, ly, lz) {
        if (ly < 0) return true;                                        // floor below the dataset
        if (lx < 0 || lz < 0 || lx >= grid.nx || lz >= grid.nz) return !P.fly; // invisible wall
        if (ly >= grid.ny) return false;
        const i = grid.idx(lx, ly, lz), c = grid.data[i];
        return c && solidCode[c] && !layers.isRemoved(i) && layers.visibleType(c);  // hidden layers can be walked through
    }
    /** returns { top, stepOnly } of the blocking cells, or null */
    function collide(px, py, pz, b = box()) {
        const x0 = grid.cellX(px - b.R), x1 = grid.cellX(px + b.R - 1e-4);
        const y0 = grid.cellY(py), y1 = grid.cellY(py + b.H - 1e-4);
        const z0 = grid.cellZ(pz - b.R), z1 = grid.cellZ(pz + b.R - 1e-4);
        let hit = null;
        for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) {
            if (!solidAt(x, y, z)) continue;
            const step = y >= 0 && grid.inside(x, y, z) && stepCode[grid.data[grid.idx(x, y, z)]];
            if (!hit) hit = { top: y, stepOnly: !!step };
            else { hit.top = Math.max(hit.top, y); hit.stepOnly = hit.stepOnly && !!step; }
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
        // auto step-up one voxel of terrain / low vegetation
        const lift = cellTop(hit.top) - p.y;
        if (!P.fly && P.onGround && hit.stepOnly && lift > 0 && lift <= VS + 0.05 && !collide(p.x, p.y + lift, p.z)) {
            p.y += lift; eyeOffset -= lift;
            return;
        }
        p[axis] -= d;
        P.vel[axis] = 0;
    }

    // =================================================================
    //  Spawn — fixed location (CONFIG.PLAYER.spawn)
    // =================================================================
    function standable(lx, lz, b) {
        // lowest free gap above a solid cell, scanning upwards from the bottom of the column
        for (let ly = 0; ly < grid.ny; ly++) {
            if (!solidAt(lx, ly, lz) || solidAt(lx, ly + 1, lz)) continue;
            const y = cellTop(ly);
            if (!collide(grid.worldX(lx), y, grid.worldZ(lz), b)) return y;
        }
        return null;
    }
    function spawn(b = box()) {
        const [wx, wz] = APP.llToWorld(PC.spawn.lat, PC.spawn.lon);
        const cx = grid.cellX(wx), cz = grid.cellZ(wz);
        let found = null;
        for (let r = 0; r < 60 && !found; r++) {
            for (let dx = -r; dx <= r && !found; dx++) for (let dz = -r; dz <= r && !found; dz++) {
                if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
                const y = standable(cx + dx, cz + dz, b);
                if (y !== null) found = [cx + dx, y, cz + dz];
            }
        }
        if (!found) return false;
        if (found[0] !== cx || found[2] !== cz) console.info('Spawn moved to nearest open cell', found);
        P.pos.set(grid.worldX(found[0]), found[1], grid.worldZ(found[2]));
        P.vel.set(0, 0, 0); P.spawned = true;
        const hd = PC.spawn.headingDeg;
        if (hd == null) P.yaw = Math.atan2(-(APP.bounds.cx - P.pos.x), -(APP.bounds.cz - P.pos.z)); // face the campus
        else P.yaw = -hd * Math.PI / 180;     // compass heading → yaw (0 = north)
        P.pitch = 0;
        // turn toward open space so the third-person camera is not pressed against a wall
        const clear = yaw => {
            const o = new THREE.Vector3(P.pos.x, P.pos.y + 1.75, P.pos.z), d = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
            const h = grid.raycast(o, d, 8, (i, c) => !layers.isRemoved(i) && layers.visibleType(c));
            return h ? h.dist : 8;
        };
        let best = P.yaw, bestD = clear(P.yaw);
        for (let k = 1; k < 8 && bestD < 6; k++) {
            const y = P.yaw + k * Math.PI / 4, d = clear(y);
            if (d > bestD + 0.5) { best = y; bestD = d; }
        }
        P.yaw = best; facing = P.yaw;
        return true;
    }
    APP.spawnPlayer = spawn;

    // =================================================================
    //  Mode switching
    // =================================================================
    function enter(mode) {
        if (!grid) return;
        if (APP.mode === 'orbit') {
            saved = { pos: cam.position.clone(), target: APP.controls.target.clone() };
            if (!spawn(BODY[mode])) { APP.flash && APP.flash('Spawn point not found — check CONFIG.PLAYER.spawn'); return; }
        } else if (mode === 'fp' && APP.mode === 'tp' && collide(P.pos.x, P.pos.y, P.pos.z, BODY.fp)) {
            APP.flash && APP.flash('Not enough headroom here for first person');
            return;
        }
        APP.mode = mode;
        if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); // Space must not re-click buttons
        APP.controls.enabled = false;
        cam.rotation.order = 'YXZ';
        cat.visible = mode === 'tp';
        document.body.classList.add('walking');
        document.body.classList.remove('igniting');
        if (APP.isTouch) document.getElementById('sidebar-container').classList.add('collapsed');
        syncButtons();
        lock();
    }
    function exit() {
        if (APP.mode === 'orbit') return;
        APP.mode = 'orbit';
        cat.visible = false;
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

    // =================================================================
    //  Input
    // =================================================================
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
        P.pitch = Math.max(-1.45, Math.min(1.45, P.pitch - dy * 0.0022));
    }
    cv.addEventListener('wheel', e => { if (APP.mode === 'tp') { P.tpDist = Math.max(2.5, Math.min(30, P.tpDist + e.deltaY * 0.01)); e.preventDefault(); } }, { passive: false });

    addEventListener('keydown', e => {
        if (APP.mode === 'orbit' || e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
        keys[e.code] = true;
        if (e.code === 'Escape' && !document.pointerLockElement) exit();
        if (e.code === 'KeyV' && !e.repeat) { enter(APP.mode === 'fp' ? 'tp' : 'fp'); }
        if (e.code === 'KeyG' && !e.repeat) {
            P.fly = !P.fly; P.vel.y = P.fly ? 4 : 0; syncButtons();
            APP.flash && APP.flash(P.fly ? (APP.mode === 'tp' ? '🪽 Wings out! Space up · C down' : 'Fly mode ON (Space up · C down)') : 'Fly mode OFF');
        }
        if (e.code === 'KeyR' && !e.repeat) spawn();
        if (e.code === 'KeyF' && !e.repeat) igniteAtCrosshair();
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

    // =================================================================
    //  Per frame
    // =================================================================
    const target = new THREE.Vector3(), back = new THREE.Vector3();
    function update(dt) {
        if (APP.mode === 'orbit') return;
        const b = box();
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
            P.vel.y += (vy * sp * 0.6 - P.vel.y) * k;
        } else {
            if (keys.Space && P.onGround) { P.vel.y = JUMP; P.onGround = false; }
            P.vel.y -= GRAV * dt;
            if (P.pos.y + 0.8 < APP.waterLevel) P.vel.y = Math.max(P.vel.y, keys.Space ? 3 : -1.5);   // float in floods
        }

        // integrate with sub-steps (no tunnelling)
        const maxD = Math.max(Math.abs(P.vel.x), Math.abs(P.vel.y), Math.abs(P.vel.z)) * dt;
        const n = Math.max(1, Math.ceil(maxD / 0.3));
        const wasGround = P.onGround;
        P.onGround = false;
        for (let s = 0; s < n; s++) {
            moveAxis('x', P.vel.x * dt / n);
            moveAxis('z', P.vel.z * dt / n);
            moveAxis('y', P.vel.y * dt / n);
        }
        if (!P.onGround && wasGround && P.vel.y <= 0 && !P.fly && collide(P.pos.x, P.pos.y - 0.05, P.pos.z)) P.onGround = true;
        if (P.pos.y < APP.bounds.minY - 60) spawn();

        eyeOffset += (0 - eyeOffset) * Math.min(1, dt * 10);
        const hs = Math.hypot(P.vel.x, P.vel.z);
        walkPhase += hs * dt * 2.2;

        if (APP.mode === 'fp') {
            cam.position.set(P.pos.x, P.pos.y + b.eye + eyeOffset, P.pos.z);
            cam.rotation.set(P.pitch, P.yaw, 0, 'YXZ');
        } else {
            if (hs > 0.3) {
                const want = Math.atan2(-P.vel.x, -P.vel.z);
                let d = want - facing; d = Math.atan2(Math.sin(d), Math.cos(d));
                facing += d * Math.min(1, dt * 10);
            }
            cat.position.set(P.pos.x, P.pos.y + eyeOffset, P.pos.z);
            cat.rotation.y = facing;
            animateCat(dt, hs);
            // camera boom; stops at anything visible so it never ends up inside a block
            target.set(P.pos.x, P.pos.y + 1.75 + eyeOffset, P.pos.z);
            back.set(Math.sin(P.yaw) * Math.cos(P.pitch), -Math.sin(P.pitch), Math.cos(P.yaw) * Math.cos(P.pitch));
            const hit = grid.raycast(target, back, P.tpDist, (i, c) => !layers.isRemoved(i) && layers.visibleType(c));
            const d = hit ? Math.max(0.8, hit.dist - 0.4) : P.tpDist;
            cam.position.copy(target).addScaledVector(back, d);
            cat.visible = d > 1.6;                                    // camera squeezed against a wall: hide the cat
            // look along the yaw/pitch (stable) instead of lookAt (which flips near vertical)
            cam.rotation.set(P.pitch - 0.16, P.yaw, 0, 'YXZ');
        }
        $('underwater').style.opacity = cam.position.y < APP.waterLevel ? 1 : 0;
        $('hud-pos').textContent = `${(P.pos.y).toFixed(0)} m elev.`;
    }
})();
