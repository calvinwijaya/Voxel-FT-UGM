// =====================================================================
//  MAIN — scene, voxel layers, environment (sun, flood), app loop
// =====================================================================
const APP = window.APP = {
    mode: 'orbit',          // 'orbit' | 'fp' | 'tp'
    waterLevel: -Infinity,  // world Y of flood surface (or -Infinity)
    shadowDirty: true,
    updaters: []            // functions(dt) called every frame
};
const VS = CONFIG.VOXEL_SIZE;
APP.isTouch = matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0 && matchMedia('(max-width: 900px)').matches;
APP.isSmall = () => matchMedia('(max-width: 768px)').matches;
if (APP.isTouch) document.body.classList.add('touch');
if (APP.isTouch) CONFIG.WIND.particles = Math.round(CONFIG.WIND.particles * 0.5);

// --------------------------------------------------------------------
// 1. Sidebar: layer legend
// --------------------------------------------------------------------
const controlsContainer = document.getElementById('controls-container');
Object.keys(CONFIG.LABELS).forEach(key => {
    controlsContainer.insertAdjacentHTML('beforeend', `
        <div class="legend-item">
            <input type="checkbox" id="visibility-${key}" checked onchange="toggleVisibility('${key}', this.checked)">
            <input type="color" id="color-${key}" value="${CONFIG.COLORS[key]}" onchange="updateColor('${key}', this.value)">
            <label for="visibility-${key}">${CONFIG.LABELS[key]}</label>
            <span class="count" id="count-${key}"></span>
            <button class="btn-default" onclick="resetColor('${key}')">Reset</button>
        </div>`);
});

window.toggleSidebar = function () {
    const c = document.getElementById('sidebar-container');
    c.classList.toggle('collapsed');
    syncToggle();
};
function syncToggle() {
    const c = document.getElementById('sidebar-container'), col = c.classList.contains('collapsed');
    document.getElementById('toggle-btn').innerHTML = APP.isSmall() ? (col ? '▲ Controls' : '▼ Hide') : (col ? '❯' : '❮');
}

// phones: start with the panel folded away so the 3D view is visible
if (APP.isSmall() || (APP.isTouch && innerHeight < 500)) document.getElementById('sidebar-container').classList.add('collapsed');
syncToggle();
matchMedia('(max-width: 768px)').addEventListener('change', syncToggle);
new MutationObserver(syncToggle).observe(document.getElementById('sidebar-container'), { attributes: true, attributeFilter: ['class'] });

// --------------------------------------------------------------------
// 2. Three.js scene
// --------------------------------------------------------------------
const scene = APP.scene = new THREE.Scene();
scene.background = new THREE.Color(CONFIG.COLORS.background);
scene.fog = new THREE.Fog(CONFIG.COLORS.background, 300, 2200);

const camera = APP.camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 6000);
const renderer = APP.renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, APP.isTouch ? 1.25 : 1.5));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.BasicShadowMap;
renderer.shadowMap.autoUpdate = false;
document.body.appendChild(renderer.domElement);

const controls = APP.controls = new THREE.OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.05;
controls.maxPolarAngle = Math.PI / 2 - 0.05;

const ambient = new THREE.AmbientLight(0xffffff, 0.55);
scene.add(ambient);
const sun = new THREE.DirectionalLight(0xffffff, 0.8);
sun.castShadow = true;
const maxTex = renderer.capabilities.maxTextureSize;
const shadowRes = Math.min(APP.isTouch ? 2048 : 4096, maxTex);
sun.shadow.mapSize.set(shadowRes, shadowRes);
sun.shadow.bias = -0.001;
scene.add(sun, sun.target);
APP.sun = sun; APP.ambient = ambient;

const materials = APP.materials = {};
Object.keys(CONFIG.LABELS).forEach(t => materials[t] = new THREE.MeshLambertMaterial({ color: CONFIG.COLORS[t] }));
const boxGeo = APP.boxGeo = new THREE.BoxGeometry(VS * 0.98, VS * 0.98, VS * 0.98);

// --------------------------------------------------------------------
// 3. VoxelLayers — one InstancedMesh per class, only EXPOSED voxels drawn.
//    Hidden voxels are added on demand when a neighbour burns away.
// --------------------------------------------------------------------
/** Open-addressing int -> int hash map (cell index -> instance index). Far smaller than an
 *  Int32Array over every cell, which matters for 1 m / 0.5 m grids (hundreds of millions of cells). */
class IntMap {
    constructor(cap = 1 << 16) { this._alloc(cap); }
    _alloc(cap) {
        let c = 1; while (c < cap * 2) c <<= 1;
        this.mask = c - 1; this.keys = new Int32Array(c).fill(-1); this.vals = new Int32Array(c); this.size = 0;
    }
    _slot(k) { let h = Math.imul(k, 0x9E3779B1) & this.mask; while (this.keys[h] !== -1 && this.keys[h] !== k) h = (h + 1) & this.mask; return h; }
    get(k) { const h = this._slot(k); return this.keys[h] === k ? this.vals[h] : -1; }
    set(k, v) {
        if ((this.size + 1) * 2 > this.mask) {                       // keep load factor < 0.5
            const ok = this.keys, ov = this.vals; this._alloc(this.size * 2 + 16);
            for (let q = 0; q < ok.length; q++) if (ok[q] !== -1) this.set(ok[q], ov[q]);
        }
        const h = this._slot(k); if (this.keys[h] === -1) { this.keys[h] = k; this.size++; } this.vals[h] = v;
    }
}

class VoxelLayers {
    constructor(grid) {
        this.grid = grid;
        this.meshes = {};          // name -> InstancedMesh
        this.cellOf = {};          // code -> Int32Array(instance -> cell)
        this.instOf = new IntMap();
        this.removedBits = new Uint8Array((grid.N + 7) >> 3);   // 1 bit per cell
        this.dirtyCols = [];       // columns whose top changed (minimap)
        this._m = new THREE.Matrix4();
        this._zero = new THREE.Matrix4().makeScale(0, 0, 0);
        this._white = new THREE.Color(1, 1, 1);
        this.build();
    }

    isRemoved(i) { return (this.removedBits[i >> 3] >> (i & 7)) & 1; }
    occupied(i) { return this.grid.data[i] !== 0 && !this.isRemoved(i); }

    isExposed(lx, ly, lz) {
        const g = this.grid, d = g.data, ny = g.ny, nz = g.nz;
        if (lx === 0 || ly === 0 || lz === 0 || lx === g.nx - 1 || ly === ny - 1 || lz === nz - 1) return true;
        const i = (lx * nz + lz) * ny + ly, sx = nz * ny;
        const occ = n => d[n] && !this.isRemoved(n);
        return !(occ(i + 1) && occ(i - 1) && occ(i + ny) && occ(i - ny) && occ(i + sx) && occ(i - sx));
    }

    _makeMesh(name, code, cap) {
        const mesh = new THREE.InstancedMesh(boxGeo, materials[name], cap);
        // colour buffer created up front (r128 compiles the shader with/without it on first render)
        mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3).fill(1), 3);
        mesh.count = 0;
        mesh.frustumCulled = false;
        const terrain = name === 'ground' || name === 'river';
        mesh.castShadow = !terrain;
        mesh.receiveShadow = terrain;
        mesh.userData.type = name;
        const cb = document.getElementById('visibility-' + name);
        mesh.visible = cb ? cb.checked : true;
        return mesh;
    }

    /** enlarge a layer when fire uncovers more voxels than it was sized for */
    _grow(code) {
        const name = this.grid.typeName(code), old = this.meshes[name];
        const cap = Math.ceil(old.instanceMatrix.count * 1.5) + 1024;
        const mesh = this._makeMesh(name, code, cap);
        mesh.instanceMatrix.array.set(old.instanceMatrix.array);
        mesh.instanceColor.array.set(old.instanceColor.array);
        mesh.count = old.count; mesh.visible = old.visible;
        const cells = new Int32Array(cap); cells.set(this.cellOf[code]); this.cellOf[code] = cells;
        APP.scene.remove(old); old.dispose(); APP.scene.add(mesh);
        this.meshes[name] = mesh;
        return mesh;
    }

    build() {
        const g = this.grid;
        Object.values(this.meshes).forEach(m => { APP.scene.remove(m); m.dispose(); });
        this.meshes = {}; this.cellOf = {};
        this.instOf = new IntMap(1 << 16); this.removedBits.fill(0); this.dirtyCols = [];

        // pass 1: count all voxels and the exposed ones per class
        const totals = new Float64Array(g.types.length + 1), exposed = new Float64Array(g.types.length + 1);
        for (let lx = 0; lx < g.nx; lx++) for (let lz = 0; lz < g.nz; lz++) {
            const base = (lx * g.nz + lz) * g.ny;
            for (let ly = 0; ly < g.ny; ly++) {
                const c = g.data[base + ly]; if (!c) continue;
                totals[c]++;
                if (this.isExposed(lx, ly, lz)) exposed[c]++;
            }
        }
        let expTotal = 0;
        g.types.forEach((name, k) => {
            const code = k + 1;
            const lbl = document.getElementById('count-' + name);
            if (lbl) lbl.textContent = totals[code].toLocaleString();
            if (!totals[code] || !materials[name]) return;
            expTotal += exposed[code];
            const cap = Math.ceil(exposed[code] * 1.1) + 1024;     // only what is visible (+ headroom for fire)
            const mesh = this._makeMesh(name, code, cap);
            this.meshes[name] = mesh;
            this.cellOf[code] = new Int32Array(cap);
            APP.scene.add(mesh);
        });
        this.instOf = new IntMap(expTotal + 1024);

        // pass 2: place exposed voxels
        let drawn = 0;
        for (let lx = 0; lx < g.nx; lx++) for (let lz = 0; lz < g.nz; lz++) {
            const base = (lx * g.nz + lz) * g.ny;
            for (let ly = 0; ly < g.ny; ly++) {
                const c = g.data[base + ly];
                if (c && this.isExposed(lx, ly, lz)) { this.addInstance(base + ly, lx, ly, lz); drawn++; }
            }
        }
        Object.values(this.meshes).forEach(m => { m.instanceMatrix.needsUpdate = true; m.instanceColor.needsUpdate = true; });
        this.drawn = drawn;
        APP.shadowDirty = true;
        document.dispatchEvent(new CustomEvent('layers-built'));
    }

    addInstance(i, lx, ly, lz) {
        const g = this.grid, code = g.data[i];
        let mesh = this.meshes[g.typeName(code)];
        if (!mesh || this.instOf.get(i) >= 0) return;
        if (mesh.count >= mesh.instanceMatrix.count) mesh = this._grow(code);
        if (lx === undefined) [lx, ly, lz] = g.unpack(i);
        const k = mesh.count++;
        this.cellOf[code][k] = i;
        this.instOf.set(i, k);
        this._m.makeTranslation(g.worldX(lx), g.worldY(ly), g.worldZ(lz));
        mesh.setMatrixAt(k, this._m);
        const fireTint = APP.fire && APP.fire.tintOf ? APP.fire.tintOf(i) : null;
        mesh.setColorAt(k, fireTint || this._white);
        mesh.instanceMatrix.needsUpdate = true;
        mesh.instanceColor.needsUpdate = true;
    }

    /** voxel consumed (e.g. burnt tree): hide it and reveal hidden neighbours */
    remove(i) {
        const g = this.grid; if (this.isRemoved(i)) return;
        this.removedBits[i >> 3] |= 1 << (i & 7);
        const k = this.instOf.get(i), mesh = this.meshes[g.typeName(g.data[i])];
        if (k >= 0 && mesh) { mesh.setMatrixAt(k, this._zero); mesh.instanceMatrix.needsUpdate = true; }
        const [lx, ly, lz] = g.unpack(i);
        this.dirtyCols.push(lx * g.nz + lz);
        [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]].forEach(([dx, dy, dz]) => {
            const x = lx + dx, y = ly + dy, z = lz + dz;
            if (!g.inside(x, y, z)) return;
            const n = g.idx(x, y, z);
            if (g.data[n] && !this.isRemoved(n) && this.instOf.get(n) < 0) this.addInstance(n, x, y, z);
        });
        APP.shadowDirty = true;
    }

    tint(i, color) {
        const k = this.instOf.get(i), mesh = this.meshes[this.grid.typeName(this.grid.data[i])];
        if (k < 0 || !mesh) return;
        mesh.setColorAt(k, color); mesh.instanceColor.needsUpdate = true;
    }

    visibleType(code) { const m = this.meshes[this.grid.typeName(code)]; return m && m.visible; }
}
APP.VoxelLayers = VoxelLayers;

// --------------------------------------------------------------------
// 4. Load data
// --------------------------------------------------------------------
const loadingEl = document.getElementById('loading');
function countVoxels(g) { let n = 0; const d = g.data; for (let i = 0; i < d.length; i++) if (d[i]) n++; return n; }
loadingEl.textContent = `Loading ${CONFIG.DATASETS[CONFIG.RES].label} voxel data…`;
VoxelGrid.load(t => loadingEl.textContent = t).then(grid => {
    APP.grid = grid;
    APP.layers = new VoxelLayers(grid);

    // bounds in world units
    const b = APP.bounds = {
        minX: grid.worldX(0), maxX: grid.worldX(grid.nx - 1),
        minY: grid.worldY(0), maxY: grid.worldY(grid.ny - 1),
        minZ: grid.worldZ(0), maxZ: grid.worldZ(grid.nz - 1)
    };
    b.cx = (b.minX + b.maxX) / 2; b.cz = (b.minZ + b.maxZ) / 2;
    b.width = b.maxX - b.minX; b.depth = b.maxZ - b.minZ;

    // lowest river / ground cell for flood base
    let minRiver = Infinity, minGround = Infinity;
    const cRiver = grid.code.river, cGround = grid.code.ground;
    for (let i = 0; i < grid.N; i++) {
        const c = grid.data[i]; if (!c) continue;
        const ly = i % grid.ny;
        if (c === cRiver && ly < minRiver) minRiver = ly;
        if (c === cGround && ly < minGround) minGround = ly;
    }
    APP.minGroundTop = grid.worldY(isFinite(minGround) ? minGround : 0) + VS / 2;
    APP.baseRiverY = grid.worldY(isFinite(minRiver) ? minRiver : (isFinite(minGround) ? minGround : 0)) + VS / 2;

    // shadow frustum fitted to the model
    const half = Math.max(b.width, b.depth) * 0.6;
    Object.assign(sun.shadow.camera, { left: -half, right: half, top: half, bottom: -half, near: 1, far: 5000 });
    sun.shadow.camera.updateProjectionMatrix();
    sun.target.position.set(b.cx, b.minY, b.cz);

    // flood plane
    const waterGeo = new THREE.PlaneGeometry(b.width * 1.5, b.depth * 1.5 + b.width * 0.5);
    const waterMat = new THREE.MeshLambertMaterial({ color: 0x1E90FF, transparent: true, opacity: 0.65, side: THREE.DoubleSide, depthWrite: false });
    APP.waterMesh = new THREE.Mesh(waterGeo, waterMat);
    APP.waterMesh.rotation.x = -Math.PI / 2;
    APP.waterMesh.visible = false;
    APP.waterMesh.position.set(b.cx, APP.baseRiverY, b.cz);
    scene.add(APP.waterMesh);

    // camera
    controls.target.set(b.cx, b.minY, b.cz);
    const zoomOut = camera.aspect < 1 ? 1.9 : 1;           // portrait phones need more distance
    camera.position.set(b.cx + b.width * 0.5 * zoomOut, b.minY + b.width * 0.3 * zoomOut, b.cz + b.width * 0.5 * zoomOut);
    controls.update();

    document.getElementById('stat-voxels').textContent =
        `${CONFIG.VOXEL_SIZE} m grid · ${countVoxels(grid).toLocaleString()} voxels · ${APP.layers.drawn.toLocaleString()} drawn (hidden interior culled)`;

    loadingEl.style.display = 'none';
    document.dispatchEvent(new CustomEvent('voxels-ready', { detail: grid }));
}).catch(err => {
    console.error(err);
    loadingEl.innerHTML = `Could not load <b>${CONFIG.DATA_URL}</b><br><small>${err.message}</small>` +
        (CONFIG.RES !== CONFIG.DEFAULT_RES ? `<br><br>Make it with <code>tools/compress_voxels.py</code> and upload it next to index.html.<br><a href="?res=${CONFIG.DEFAULT_RES}">Back to the 2 m grid</a>` : '');
});

// --------------------------------------------------------------------
// 5. Layer / colour interaction
// --------------------------------------------------------------------
window.updateColor = function (type, hex) {
    if (type === 'background') {
        // a custom colour pins the sky; "Default" hands it back to the day/night cycle
        APP.userSky = hex.toLowerCase() === CONFIG.COLORS.background.toLowerCase() ? null : hex;
        if (APP.sky) APP.sky.apply(); else { scene.background.set(hex); scene.fog.color.set(hex); }
    }
    else if (materials[type]) materials[type].color.set(hex);
};
window.resetColor = function (type) {
    const hex = CONFIG.COLORS[type];
    document.getElementById('color-' + type).value = hex;
    updateColor(type, hex);
};
window.toggleVisibility = function (type, on) {
    if (APP.layers && APP.layers.meshes[type]) { APP.layers.meshes[type].visible = on; APP.shadowDirty = true; }
};
window.toggleAllLayers = function (show) {
    Object.keys(CONFIG.LABELS).forEach(type => {
        const cb = document.getElementById('visibility-' + type);
        if (cb) cb.checked = show;
        toggleVisibility(type, show);
    });
};

// 6. Sun / time of day → js/sky.js

// --------------------------------------------------------------------
// 7. Flood
// --------------------------------------------------------------------
const floodSlider = document.getElementById('flood-slider');
const floodLabel = document.getElementById('flood-label');
floodSlider.addEventListener('input', e => {
    const lvl = parseFloat(e.target.value);
    floodLabel.innerText = (lvl > 0 ? '+' : '') + lvl + ' m';
    if (!APP.waterMesh) return;
    APP.waterMesh.visible = lvl > 0;
    APP.waterMesh.position.y = APP.baseRiverY + lvl;
    APP.waterLevel = lvl > 0 ? APP.baseRiverY + lvl : -Infinity;
});

// --------------------------------------------------------------------
// 8. Render loop
// --------------------------------------------------------------------
const clock = new THREE.Clock();
const compassEl = document.getElementById('compass');
const _dir = new THREE.Vector3();
let shadowTimer = 0;

function animate() {
    requestAnimationFrame(animate);
    const dt = Math.min(clock.getDelta(), 0.1);
    if (APP.mode === 'orbit') controls.update();
    APP.updaters.forEach(fn => fn(dt));

    // compass: heading of the camera (works in every view mode)
    camera.getWorldDirection(_dir);
    const az = Math.atan2(-_dir.x, -_dir.z);
    compassEl.style.transform = `rotate(${az * 180 / Math.PI}deg)`;

    shadowTimer += dt;
    if (APP.shadowDirty && shadowTimer > 0.5) { renderer.shadowMap.needsUpdate = true; APP.shadowDirty = false; shadowTimer = 0; }
    renderer.render(scene, camera);
}
animate();

addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
});
