// =====================================================================
//  CONFIG — everything you may want to tune lives here
// =====================================================================
window.CONFIG = {
    // ---- Grid resolutions ----
    // Each entry is one compressed file made with tools/compress_voxels.py.
    // The page loads the one chosen with the "Grid size" buttons (stored in the URL, e.g. ?res=1m).
    DATASETS: {
        '2m':  { label: '2 m',   size: 2,   url: 'environment_blocks.vxl.gz',     json: 'environment_blocks.json' },
    },
    DEFAULT_RES: '2m',

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

    // ---- Walk modes ----
    PLAYER: {
        spawn: { lat: -7.7656513224346515, lon: 110.37309213763143, headingDeg: 270 },   // heading: 0 = north, 90 = east, null = face the campus centre
        fpEyeHeight: 1.6,        // human eye height in first person (m)
        jumpHeight: 2.8          // m — clears a 2 m voxel with margin
    },

    // ---- Sky / time ----
    TIMEZONE_OFFSET_H: 7,        // WIB (UTC+7), Yogyakarta has no daylight saving
    SKY: { day: '#e6f0fa', golden: '#ffb58a', twilight: '#3b4372', night: '#070b1f', overcast: '#9aa3ad' },

    // ---- Weather & air quality (Open-Meteo, free, no key) ----
    WEATHER: {
        refreshMinutes: 15,
        forecastURL: 'https://api.open-meteo.com/v1/forecast',
        airURL: 'https://air-quality-api.open-meteo.com/v1/air-quality',
        // Optional: a free WAQI token (https://aqicn.org/data-platform/token/) adds the nearest
        // monitoring-station reading next to the model estimate. Leave '' to skip.
        waqiToken: '',
        rainDrops: 7000
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

// ---- pick the dataset (before any other script reads VOXEL_SIZE) ----
(function () {
    const C = window.CONFIG;
    let res = new URLSearchParams(location.search).get('res') || C.DEFAULT_RES;
    if (!C.DATASETS[res]) res = C.DEFAULT_RES;
    const d = C.DATASETS[res];
    C.RES = res;
    C.VOXEL_SIZE = d.size;                 // metres per voxel (render units = metres)
    C.DATA_URL = d.url;
    C.JSON_FALLBACK_URL = d.json || null;  // the 1 m / 0.5 m JSON files are far too big to load in a browser
})();
