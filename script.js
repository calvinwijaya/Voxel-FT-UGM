// --- 1. SETUP DEFAULT COLORS & UI ---
const defaultColors = {
    ground: '#8D6E63', river: '#29B6F6', building: '#E0E0E0',
    building_roof: '#D32F2F', tree_low: '#8BC34A', tree_high: '#2E7D32',
    background: '#FFFFFF'
};

const labels = {
    ground: 'Ground Terrain', river: 'River Area', tree_low: 'Low Vegetation', 
    tree_high: 'High Vegetation', building: 'Building Wall', building_roof: 'Building Roof'
};

const controlsContainer = document.getElementById('controls-container');
Object.keys(labels).forEach(key => {
    controlsContainer.innerHTML += `
        <div class="legend-item">
            <input type="checkbox" id="visibility-${key}" checked onchange="toggleVisibility('${key}', this.checked)">
            <input type="color" id="color-${key}" value="${defaultColors[key]}" onchange="updateColor('${key}', this.value)">
            <label for="visibility-${key}">${labels[key]}</label>
            <button class="btn-default" onclick="resetColor('${key}')">Reset</button>
        </div>
    `;
});

// --- FUNGSI TOGGLE SIDEBAR ---
window.toggleSidebar = function() {
    const container = document.getElementById('sidebar-container');
    const btn = document.getElementById('toggle-btn');
    container.classList.toggle('collapsed');
    btn.innerHTML = container.classList.contains('collapsed') ? '❯' : '❮';
}

// --- 2. THREE.JS SCENE SETUP ---
const scene = new THREE.Scene();
scene.background = new THREE.Color(defaultColors.background);
scene.fog = new THREE.Fog(defaultColors.background, 200, 1500);

const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 5000);

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

const controls = new THREE.OrbitControls(camera, renderer.domElement);
controls.enableDamping = true; 
controls.dampingFactor = 0.05;
controls.maxPolarAngle = Math.PI / 2 - 0.05; 

// Pencahayaan
const ambient = new THREE.AmbientLight(0xffffff, 0.55);
scene.add(ambient);
const sun = new THREE.DirectionalLight(0xffffff, 0.8);
sun.position.set(500, 1000, 500);
sun.castShadow = true;
sun.shadow.camera.left = -500; sun.shadow.camera.right = 500;
sun.shadow.camera.top = 500; sun.shadow.camera.bottom = -500;
sun.shadow.camera.far = 3000; sun.shadow.bias = -0.001;
scene.add(sun);

const VOXEL_SIZE = 2; 

const materials = {
    ground: new THREE.MeshLambertMaterial({ color: defaultColors.ground }),
    river: new THREE.MeshLambertMaterial({ color: defaultColors.river }),
    building: new THREE.MeshLambertMaterial({ color: defaultColors.building }),
    building_roof: new THREE.MeshLambertMaterial({ color: defaultColors.building_roof }),
    tree_low: new THREE.MeshLambertMaterial({ color: defaultColors.tree_low }),
    tree_high: new THREE.MeshLambertMaterial({ color: defaultColors.tree_high })
};

const geometry = new THREE.BoxGeometry(VOXEL_SIZE * 0.98, VOXEL_SIZE * 0.98, VOXEL_SIZE * 0.98);

// Objek untuk menyimpan referensi mesh agar bisa di-hide/unhide
const layerMeshes = {};

// --- 3. FETCH DATA & AUTO CENTER ---
fetch('./environment_blocks2.json')
    .then(res => res.json())
    .then(blocks => {
        const categorizedBlocks = { ground: [], river: [], building: [], building_roof: [], tree_low: [], tree_high: [] };
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
        let minRiverY = Infinity;

        blocks.forEach(b => {
            if(categorizedBlocks[b.type]) {
                categorizedBlocks[b.type].push(b);
                
                if (b.x < minX) minX = b.x; if (b.x > maxX) maxX = b.x;
                if (b.y < minY) minY = b.y; if (b.y > maxY) maxY = b.y;
                if (b.z < minZ) minZ = b.z; if (b.z > maxZ) maxZ = b.z;

                if (b.type === 'river' && b.y < minRiverY) {
                    minRiverY = b.y;
                }
            }
        });

        Object.keys(categorizedBlocks).forEach(type => {
            const data = categorizedBlocks[type];
            if (data.length === 0) return;

            const mesh = new THREE.InstancedMesh(geometry, materials[type], data.length);
            mesh.castShadow = true;
            mesh.receiveShadow = true;

            const dummy = new THREE.Object3D();
            data.forEach((pos, i) => {
                dummy.position.set(pos.x * VOXEL_SIZE, pos.y * VOXEL_SIZE, pos.z * VOXEL_SIZE);
                dummy.updateMatrix();
                mesh.setMatrixAt(i, dummy.matrix);
            });

            scene.add(mesh);
            layerMeshes[type] = mesh; 
        });

        const centerX = ((minX + maxX) / 2) * VOXEL_SIZE;
        const centerY = minY * VOXEL_SIZE; 
        const centerZ = ((minZ + maxZ) / 2) * VOXEL_SIZE;

        controls.target.set(centerX, centerY, centerZ);
        const areaWidth = (maxX - minX) * VOXEL_SIZE;

        // --- SETUP BIDANG AIR (FLOOD PLANE) ---
        const waterGeo = new THREE.PlaneGeometry(areaWidth * 1.5, areaWidth * 1.5);
        const waterMat = new THREE.MeshLambertMaterial({ 
            color: 0x1E90FF, 
            transparent: true, 
            opacity: 0.65,   
            side: THREE.DoubleSide,
            depthWrite: false 
        });
        
        window.waterMesh = new THREE.Mesh(waterGeo, waterMat);
        window.waterMesh.rotation.x = -Math.PI / 2; 
        window.waterMesh.visible = false; 
        
        const baseElevationY = (minRiverY !== Infinity) ? minRiverY : minY;
        window.baseRiverY = (baseElevationY * VOXEL_SIZE) + (VOXEL_SIZE / 2); 
        
        window.waterMesh.position.set(centerX, window.baseRiverY, centerZ);
        scene.add(window.waterMesh);

        camera.position.set(centerX + areaWidth*0.5, centerY + areaWidth*0.3, centerZ + areaWidth*0.5);
        controls.update();

        document.getElementById('loading').style.display = 'none';
    })
    .catch(err => {
        console.error(err);
        document.getElementById('loading').innerText = "Failed to load voxel data.";
    });

// --- 4. FUNGSI INTERAKSI ---
window.updateColor = function(type, hex) {
    if (type === 'background') {
        scene.background.set(hex);
        scene.fog.color.set(hex);
    } else if (materials[type]) {
        materials[type].color.set(hex);
    }
};

window.resetColor = function(type) {
    const hex = defaultColors[type];
    document.getElementById('color-' + type).value = hex;
    updateColor(type, hex);
};

window.toggleVisibility = function(type, isVisible) {
    if (layerMeshes[type]) {
        layerMeshes[type].visible = isVisible;
    }
};

window.toggleAllLayers = function(show) {
    Object.keys(layerMeshes).forEach(type => {
        if (layerMeshes[type]) {
            layerMeshes[type].visible = show;
        }
        const checkbox = document.getElementById('visibility-' + type);
        if (checkbox) {
            checkbox.checked = show;
        }
    });
};

// --- LOGIKA MATAHARI & ANIMASI LOOP PLAY ---
const timeSlider = document.getElementById('time-slider');
const playBtn = document.getElementById('play-btn');
const timeLabel = document.getElementById('current-time-label');

let isPlaying = false;
let playInterval = null;

function updateSunPosition(hour) {
    timeLabel.innerText = `${String(hour).padStart(2, '0')}:00`;
    
    const angle = ((hour - 6) / 12) * Math.PI;
    const sunRadius = 1500;
    const sunX = Math.cos(angle) * -sunRadius; 
    const sunY = Math.sin(angle) * sunRadius;
    
    sun.position.set(sunX, Math.max(sunY, 10), 500);
    
    const intensity = Math.sin(angle); 
    sun.intensity = intensity * 0.8 + 0.2;     
    ambient.intensity = intensity * 0.4 + 0.3; 
    
    const currentBgColor = '#' + scene.background.getHexString();
    if (currentBgColor === 'ffffff' || currentBgColor === 'ffa07a' || currentBgColor === '87ceeb') {
        if (hour <= 7 || hour >= 17) {
            scene.background.set('#FFA07A'); 
            scene.fog.color.set('#FFA07A');
        } else {
            scene.background.set('#ffffff'); 
            scene.fog.color.set('#ffffff');
        }
    }
}

timeSlider.addEventListener('input', (e) => {
    if (isPlaying) stopLoop(); 
    updateSunPosition(parseInt(e.target.value));
});

function startLoop() {
    isPlaying = true;
    playBtn.innerText = "Pause";
    playBtn.style.backgroundColor = "#ef4444"; 
    
    playInterval = setInterval(() => {
        let currentHour = parseInt(timeSlider.value);
        currentHour++;
        
        if (currentHour > 18) currentHour = 6; 
        
        timeSlider.value = currentHour;
        updateSunPosition(currentHour);
    }, 800); 
}

function stopLoop() {
    isPlaying = false;
    playBtn.innerText = "Play";
    playBtn.style.backgroundColor = "#3b82f6";
    clearInterval(playInterval);
}

playBtn.addEventListener('click', () => {
    if (isPlaying) {
        stopLoop();
    } else {
        startLoop();
    }
});

updateSunPosition(12);

// --- LOGIKA SIMULASI BANJIR ---
const floodSlider = document.getElementById('flood-slider');
const floodLabel = document.getElementById('flood-label');

floodSlider.addEventListener('input', (e) => {
    const floodLevel = parseFloat(e.target.value);
    
    floodLabel.innerText = (floodLevel > 0 ? "+" : "") + floodLevel + " m";

    if (floodLevel === 0) {
        window.waterMesh.visible = false;
    } else {
        window.waterMesh.visible = true;
        window.waterMesh.position.y = window.baseRiverY + floodLevel;
    }
});

// --- 5. RENDER LOOP & RESIZE ---
function animate() {
    requestAnimationFrame(animate);
    controls.update();

    const azimuthalAngle = controls.getAzimuthalAngle();
    document.getElementById('compass').style.transform = `rotate(${-(azimuthalAngle * 180 / Math.PI)}deg)`;

    renderer.render(scene, camera);
}
animate();

window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});