// =====================================================================
//  GEO — scene <-> WGS84 (local tangent plane; accurate for a few km)
//  Scene: +X East, -Z North (before CONFIG.GEOREF rotation / flip).
// =====================================================================
(function () {
    const G = CONFIG.GEOREF, M = 111320;
    const cosLat = () => Math.cos(G.lat * Math.PI / 180);

    APP.worldToLL = function (wx, wz) {
        const b = APP.bounds, r = G.rotationDeg * Math.PI / 180;
        const e = wx - b.cx; let n = -(wz - b.cz); if (G.flipZ) n = -n;
        const E = e * Math.cos(r) + n * Math.sin(r) + G.offsetE;
        const N = -e * Math.sin(r) + n * Math.cos(r) + G.offsetN;
        return [G.lat + N / M, G.lon + E / (M * cosLat())];
    };

    APP.llToWorld = function (lat, lon) {
        const b = APP.bounds, r = G.rotationDeg * Math.PI / 180;
        const E = (lon - G.lon) * M * cosLat() - G.offsetE;
        const N = (lat - G.lat) * M - G.offsetN;
        const e = E * Math.cos(r) - N * Math.sin(r);
        let n = E * Math.sin(r) + N * Math.cos(r);
        if (G.flipZ) n = -n;
        return [b.cx + e, b.cz - n];
    };
})();
