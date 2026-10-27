# Voxel Visualization – Faculty of Engineering, UGM (v2)

Lightweight three.js voxel city for urban simulation: shadows, flood, **live wind**, **fire spread**, and **Minecraft-style first/third-person** exploration on a web basemap.

## Files
```
index.html                  UI
style.css
js/config.js                all tunables (voxel size, georef, fire & wind parameters, basemaps)
js/voxel-grid.js            binary loader + dense grid + DDA ray casting
js/main.js                  scene, voxel layers (hidden-interior culling), sun, flood, loop
js/wind.js                  Open-Meteo live wind / manual wind + streamlines
js/fire.js                  cellular-automaton fire spread, ignition picking, smoke
js/player.js                first/third person, collision, fly mode, avatar
js/basemap.js               XYZ tiles draped under the model, georef alignment
environment_blocks.vxl.gz   voxel data, 50 KB (generated)
environment_blocks.json     original data, used only as a fallback
tools/compress_voxels.py    JSON -> .vxl.gz converter
```

## Data format
Regenerate the binary after changing the voxels:
```
python tools/compress_voxels.py environment_blocks.json environment_blocks.vxl.gz
```
A dense `uint8` grid (0 = empty, k = class k-1) stored column by column, then gzipped.
13.8 MB JSON → 50 KB. The browser decompresses it with the native `DecompressionStream`.

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
Set `CONFIG.GEOREF` to the true lat/lon of the grid centre (and rotation / flip if needed),
or align visually in the **Basemap** panel and press **Copy georef**.

## Run locally
Any static server, e.g. `python -m http.server`, then open http://localhost:8000.
