# Voxel Visualization – Faculty of Engineering, UGM (v5)

Lightweight three.js voxel city for urban simulation: shadows, flood, **live wind**, **fire spread**, and **Minecraft-style first/third-person** exploration on a web basemap.

## Files
```
index.html                  UI
style.css
js/config.js                all tunables (voxel size, georef, fire & wind parameters, basemaps)
js/voxel-grid.js            binary loader + dense grid + DDA ray casting
js/main.js                  scene, voxel layers (hidden-interior culling), sun, flood, loop
js/geo.js                   scene <-> lat/lon
js/sky.js                   real-time sun position (WIB), night sky, stars
js/weather.js               Open-Meteo weather + air quality (15-min refresh)
js/rain.js                  clouds, rain, lightning from live/manual weather
js/wind.js                  live (from weather.js) / manual wind + streamlines
js/fire.js                  cellular-automaton fire spread, ignition picking, smoke
js/player.js                first person / third person (cat with wings in fly mode), collision, fixed spawn
js/cats.js                  six cat avatars (coat + facial expression) and the Cat Avatar panel
js/touch.js                 on-screen joystick & buttons for phones
js/minimap.js               heading-up minimap in first / third person
js/basemap.js               XYZ tiles draped on a terrain-following surface
favicon.svg / .ico          tab icon (+ apple-touch-icon.png)
environment_blocks.vxl.gz   2 m voxel data, 50 KB (generated)
environment_blocks.json     original 2 m data, used only as a fallback
tools/compress_voxels.py    JSON -> .vxl.gz converter (streams huge files)
```

## Data format & grid sizes
Convert each JSON once (needs Python 3; `pip install numpy` makes it faster):
```
python tools/compress_voxels.py environment_blocks.json     environment_blocks.vxl.gz     --size 2
python tools/compress_voxels.py environment_blocks_1m.json  environment_blocks_1m.vxl.gz  --size 1
python tools/compress_voxels.py environment_blocks_05m.json environment_blocks_05m.vxl.gz --size 0.5
```
Upload the `.vxl.gz` files next to `index.html` (the big JSON files are not needed on the website).
The page loads the 2 m grid (`CONFIG.DATASETS` in js/config.js); finer grids can be added back
there, but 1 m / 0.5 m proved too heavy for most browsers. Format: dense `uint8` grid (0 = empty, k = class k-1) stored column by
column, gzipped; the header records the voxel size ("VXL2"). The browser decompresses it natively.


## Wind
Default source is [Open-Meteo](https://open-meteo.com/) `current` weather (free, no key, CORS, 15-min updates):
10 m wind speed/direction, gusts, temperature and humidity at `CONFIG.GEOREF.lat/lon`.
Streamline speed follows a logarithmic wind profile (z0 = 1 m) and particles are lifted over obstacles.

## Fire model
3D cellular automaton on the voxel grid (after Alexandridis et al., 2008):
`p = p_h · flammability · moisture · e^(c1·V) · e^(c2·V·(cosθ−1)) · vertical / distance`,
plus ember spotting downwind for V > 5 m/s. Vegetation is consumed, buildings char.
Voxels under the flood level cannot burn. Parameters are in `CONFIG.FIRE`. This is an
illustrative model, not calibrated against observed fires.

## Georeferencing
`CONFIG.GEOREF` holds the lat/lon of the grid centre (plus rotation / flip if ever needed).
The walk-mode spawn point is `CONFIG.PLAYER.spawn`.

## Run locally
Any static server, e.g. `python -m http.server`, then open http://localhost:8000.
