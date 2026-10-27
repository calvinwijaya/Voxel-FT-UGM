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
    document.getElementById('toggle-btn').innerHTML = c.classList.contains('collapsed') ? '❯' : '❮';
};

// --------------------------------------------------------------------
// 2. Three.js scene
// --------------------------------------------------------------------
const scene = APP.scene = new THREE.Scene();
scene.background = new THREE.Color(CONFIG.COLORS.background);
scene.fog = new THREE.Fog(CONFIG.COLORS.background, 300, 2200);

const camera = APP.camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 6000);
const renderer = APP.renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
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
sun.shadow.mapSize.set(Math.min(4096, maxTex), Math.min(4096, maxTex));
sun.shadow.bias = -0.001;
scene.add(sun, sun.target);

const materials = APP.materials = {};
Object.keys(CONFIG.LABELS).forEach(t => materials[t] = new THREE.MeshLambertMaterial({ color: CONFIG.COLORS[t] }));
const boxGeo = APP.boxGeo = new THREE.BoxGeometry(VS * 0.98, VS * 0.98, VS * 0.98);

// --------------------------------------------------------------------
// 3. VoxelLayers — one InstancedMesh per class, only EXPOSED voxels drawn.
//    Hidden voxels are added on demand when a neighbour burns away.
// --------------------------------------------------------------------
class VoxelLayers {
    constructor(grid) {
        this.grid = grid;
        this.meshes = {};          // name -> InstancedMesh
        this.cellOf = {};          // code -> Int32Array(instance -> cell)
        this.instOf = new Int32Array(grid.N);
        this.removed = new Uint8Array(grid.N);
        this._m = new THREE.Matrix4();
        this._zero = new THREE.Matrix4().makeScale(0, 0, 0);
        this._white = new THREE.Color(1, 1, 1);
        this.build();
    }

    isExposed(lx, ly, lz) {
        const g = this.grid, d = g.data, rm = this.removed;
        const occ = (x, y, z) => { if (!g.inside(x, y, z)) return false; const i = g.idx(x, y, z); return d[i] && !rm[i]; };
        return !(occ(lx + 1, ly, lz) && occ(lx - 1, ly, lz) && occ(lx, ly + 1, lz) &&
                 occ(lx, ly - 1, lz) && occ(lx, ly, lz + 1) && occ(lx, ly, lz - 1));
    }

    build() {
        const g = this.grid;
        Object.values(this.meshes).forEach(m => { APP.scene.remove(m); m.dispose(); });
        this.meshes = {}; this.cellOf = {};
        this.instOf.fill(-1); this.removed.fill(0);

        const totals = new Int32Array(g.types.length + 1);
        for (let i = 0; i < g.N; i++) totals[g.data[i]]++;

        g.types.forEach((name, k) => {
            const code = k + 1;
            if (!totals[code] || !materials[name]) return;
            const mesh = new THREE.InstancedMesh(boxGeo, materials[name], totals[code]);
            // initialise instanceColor BEFORE first render (shader define) and BEFORE
            // shrinking .count (setColorAt sizes the buffer from .count in r128)
            for (let j = 0; j < totals[code]; j++) mesh.setColorAt(j, this._white);
            mesh.count = 0;
            mesh.frustumCulled = false;
            const terrain = name === 'ground' || name === 'river';
            mesh.castShadow = !terrain;
            mesh.receiveShadow = terrain;
            mesh.userData.type = name;
            this.meshes[name] = mesh;
            this.cellOf[code] = new Int32Array(totals[code]);
            APP.scene.add(mesh);
            const lbl = document.getElementById('count-' + name);
            if (lbl) lbl.textContent = totals[code].toLocaleString();
        });

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
        Object.keys(this.meshes).forEach(t => {
            const cb = document.getElementById('visibility-' + t);
            if (cb) this.meshes[t].visible = cb.checked;
        });
        APP.shadowDirty = true;
        document.dispatchEvent(new CustomEvent('layers-built'));
    }

    addInstance(i, lx, ly, lz) {
        const g = this.grid, code = g.data[i], mesh = this.meshes[g.typeName(code)];
        if (!mesh || this.instOf[i] >= 0) return;
        if (lx === undefined) [lx, ly, lz] = g.unpack(i);
        const k = mesh.count++;
        this.cellOf[code][k] = i;
        this.instOf[i] = k;
        this._m.makeTranslation(g.worldX(lx), g.worldY(ly), g.worldZ(lz));
        mesh.setMatrixAt(k, this._m);
        const fireTint = APP.fire && APP.fire.tintOf ? APP.fire.tintOf(i) : null;
        mesh.setColorAt(k, fireTint || this._white);
        mesh.instanceMatrix.needsUpdate = true;
        mesh.instanceColor.needsUpdate = true;
    }

    /** voxel consumed (e.g. burnt tree): hide it and reveal hidden neighbours */
    remove(i) {
        const g = this.grid; if (this.removed[i]) return;
        this.removed[i] = 1;
        const k = this.instOf[i], mesh = this.meshes[g.typeName(g.data[i])];
        if (k >= 0 && mesh) { mesh.setMatrixAt(k, this._zero); mesh.instanceMatrix.needsUpdate = true; }
        const [lx, ly, lz] = g.unpack(i);
        [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]].forEach(([dx, dy, dz]) => {
            const x = lx + dx, y = ly + dy, z = lz + dz;
            if (!g.inside(x, y, z)) return;
            const n = g.idx(x, y, z);
            if (g.data[n] && !this.removed[n] && this.instOf[n] < 0) this.addInstance(n, x, y, z);
        });
        APP.shadowDirty = true;
    }

    tint(i, color) {
        const k = this.instOf[i], mesh = this.meshes[this.grid.typeName(this.grid.data[i])];
        if (k < 0 || !mesh) return;
        mesh.setColorAt(k, color); mesh.instanceColor.needsUpdate = true;
    }

    occupied(i) { return this.grid.data[i] !== 0 && !this.removed[i]; }
    visibleType(code) { const m = this.meshes[this.grid.typeName(code)]; return m && m.visible; }
}
APP.VoxelLayers = VoxelLayers;

// --------------------------------------------------------------------
// 4. Load data
// --------------------------------------------------------------------
const loadingEl = document.getElementById('loading');
VoxelGrid.load().then(grid => {
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
    camera.position.set(b.cx + b.width * 0.5, b.minY + b.width * 0.3, b.cz + b.width * 0.5);
    controls.update();

    updateSunPosition(parseInt(timeSlider.value));
    document.getElementById('stat-voxels').textContent =
        `${grid.data.reduce((a, c) => a + (c ? 1 : 0), 0).toLocaleString()} voxels · ${APP.layers.drawn.toLocaleString()} drawn (hidden interior culled)`;

    loadingEl.style.display = 'none';
    document.dispatchEvent(new CustomEvent('voxels-ready', { detail: grid }));
}).catch(err => {
    console.error(err);
    loadingEl.innerText = 'Failed to load voxel data.';
});

// --------------------------------------------------------------------
// 5. Layer / colour interaction
// --------------------------------------------------------------------
window.updateColor = function (type, hex) {
    if (type === 'background') { scene.background.set(hex); scene.fog.color.set(hex); }
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

// --------------------------------------------------------------------
// 6. Sun / time of day
// --------------------------------------------------------------------
const timeSlider = document.getElementById('time-slider');
const playBtn = document.getElementById('play-btn');
const timeLabel = document.getElementById('current-time-label');
let isPlaying = false, playInterval = null;

function updateSunPosition(hour) {
    timeLabel.innerText = `${String(hour).padStart(2, '0')}:00`;
    const angle = ((hour - 6) / 12) * Math.PI;
    const R = 1500, c = APP.bounds || { cx: 0, cz: 0, minY: 0 };
    // 06:00 → +X (East), 18:00 → -X (West); slight tilt to the North (-Z) for Yogyakarta
    sun.position.set(c.cx + Math.cos(angle) * R, c.minY + Math.max(Math.sin(angle) * R, 10), c.cz - 500);
    const k = Math.sin(angle);
    sun.intensity = k * 0.8 + 0.2;
    ambient.intensity = k * 0.4 + 0.3;
    const bg = '#' + scene.background.getHexString();
    if (bg === '#ffffff' || bg === '#ffa07a' || bg === '#87ceeb') {
        const col = (hour <= 7 || hour >= 17) ? '#FFA07A' : '#ffffff';
        scene.background.set(col); scene.fog.color.set(col);
    }
    APP.shadowDirty = true;
}
APP.updateSunPosition = updateSunPosition;

timeSlider.addEventListener('input', e => { if (isPlaying) stopLoop(); updateSunPosition(parseInt(e.target.value)); });
function startLoop() {
    isPlaying = true; playBtn.innerText = 'Pause'; playBtn.style.backgroundColor = '#ef4444';
    playInterval = setInterval(() => {
        let h = parseInt(timeSlider.value) + 1; if (h > 18) h = 6;
        timeSlider.value = h; updateSunPosition(h);
    }, 800);
}
function stopLoop() {
    isPlaying = false; playBtn.innerText = 'Play'; playBtn.style.backgroundColor = '#3b82f6';
    clearInterval(playInterval);
}
playBtn.addEventListener('click', () => isPlaying ? stopLoop() : startLoop());

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
