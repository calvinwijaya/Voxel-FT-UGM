// =====================================================================
//  CONFIG — everything you may want to tune lives here
// =====================================================================
window.CONFIG = {
    VOXEL_SIZE: 2,                       // metres per voxel (render units = metres)

    // Data: binary first (≈50 KB), JSON as fallback for old browsers
    DATA_URL: 'environment_blocks.vxl.gz',
    JSON_FALLBACK_URL: 'environment_blocks.json',

    // Scene orientation used everywhere (sun, compass, wind, basemap):
    //   +X = East,  -Z = North,  +Y = Up
    // Geo-reference of the CENTRE of the voxel grid. Replace with the exact
    // values from your LiDAR pipeline (or align with the Basemap panel and
    // press "Copy georef").
    GEOREF: {
        lat: -7.7652,           // approx. centre of FT UGM (estimate)
        lon: 110.3725,
        rotationDeg: 0,         // grid north vs true north, clockwise
        offsetE: 0,             // fine shift in metres
        offsetN: 0,
        flipZ: false            // set true if your z index grows northwards
    },

    COLORS: {
        ground: '#8D6E63', river: '#29B6F6', building: '#E0E0E0',
        building_roof: '#D32F2F', tree_low: '#8BC34A', tree_high: '#2E7D32',
        background: '#FFFFFF'
    },
    LABELS: {
        ground: 'Ground Terrain', river: 'River Area', tree_low: 'Low Vegetation',
        tree_high: 'High Vegetation', building: 'Building Wall', building_roof: 'Building Roof'
    },

    // ---- Fire model (cellular automaton, Alexandridis et al. 2008 style) ----
    FIRE: {
        flammability: {          // relative ignition probability
            tree_high: 1.0, tree_low: 0.85, building_roof: 0.35,
            building: 0.15, ground: 0.0, river: 0.0
        },
        burnSteps: {             // how many steps a voxel keeps burning
            tree_high: 8, tree_low: 3, building_roof: 12, building: 18, ground: 2, river: 0
        },
        consumed: { tree_high: true, tree_low: true },  // burnt voxels disappear
        baseProbability: 0.22,   // p_h: ignition prob. per step to a face neighbour
        windC1: 0.045,           // wind constants (Alexandridis): p_w = e^(c1 V) e^(c2 V (cosθ-1))
        windC2: 0.131,
        upwardFactor: 2.2,       // flames climb faster than they descend
        downwardFactor: 0.35,
        emberMinWind: 5,         // m/s — above this, burning canopy throws embers downwind
        emberChance: 0.015
    },

    // ---- Live wind ----
    WIND: {
        refreshMinutes: 15,      // Open-Meteo "current" data updates every 15 min
        particles: 2500,
        roughnessZ0: 1.0         // aerodynamic roughness (m), urban ≈ 1
    },

    // ---- Basemap ----
    BASEMAPS: {
        none: null,
        satellite: { url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', attribution: 'Imagery © Esri, Maxar, Earthstar Geographics' },
        osm: { url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', attribution: '© OpenStreetMap contributors' },
        light: { url: 'https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png', attribution: '© OpenStreetMap contributors © CARTO' },
        dark: { url: 'https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png', attribution: '© OpenStreetMap contributors © CARTO' }
    },
    BASEMAP_ZOOM: 17,
    BASEMAP_EXTENT: 3.0           // basemap plane size relative to the voxel area
};
