// =====================================================================
//  VoxelGrid — dense Uint8 grid, binary loader, DDA ray casting
// =====================================================================
class VoxelGrid {
    constructor(nx, ny, nz, x0, y0, z0, types, data) {
        Object.assign(this, { nx, ny, nz, x0, y0, z0, types, data });
        this.N = data.length;
        this.VS = CONFIG.VOXEL_SIZE;
        this.code = {};                       // type name -> code (1-based)
        types.forEach((t, i) => this.code[t] = i + 1);
    }

    // ---------- loading ----------
    static async load() {
        const supportsGzip = typeof DecompressionStream !== 'undefined';
        if (supportsGzip) {
            try {
                const res = await fetch(CONFIG.DATA_URL);
                if (!res.ok) throw new Error('HTTP ' + res.status);
                const stream = res.body.pipeThrough(new DecompressionStream('gzip'));
                const buf = await new Response(stream).arrayBuffer();
                return VoxelGrid.fromBinary(buf);
            } catch (e) {
                console.warn('Binary voxel load failed, falling back to JSON:', e);
            }
        }
        const blocks = await (await fetch(CONFIG.JSON_FALLBACK_URL)).json();
        return VoxelGrid.fromBlocks(blocks);
    }

    static fromBinary(buf) {
        const dv = new DataView(buf);
        const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
        if (magic !== 'VXL1') throw new Error('Not a VXL1 file');
        const nx = dv.getUint16(4, true), ny = dv.getUint16(6, true), nz = dv.getUint16(8, true);
        const x0 = dv.getInt16(10, true), y0 = dv.getInt16(12, true), z0 = dv.getInt16(14, true);
        const nTypes = dv.getUint8(16);
        let p = 17; const types = [];
        for (let t = 0; t < nTypes; t++) {
            const len = dv.getUint8(p++); let s = '';
            for (let k = 0; k < len; k++) s += String.fromCharCode(dv.getUint8(p++));
            types.push(s);
        }
        const data = new Uint8Array(buf, p, nx * ny * nz);
        return new VoxelGrid(nx, ny, nz, x0, y0, z0, types, data);
    }

    static fromBlocks(blocks) {
        const types = ['ground', 'river', 'building', 'building_roof', 'tree_low', 'tree_high'];
        let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
        for (const b of blocks) {
            if (!types.includes(b.type)) types.push(b.type);
            if (b.x < minX) minX = b.x; if (b.x > maxX) maxX = b.x;
            if (b.y < minY) minY = b.y; if (b.y > maxY) maxY = b.y;
            if (b.z < minZ) minZ = b.z; if (b.z > maxZ) maxZ = b.z;
        }
        const nx = maxX - minX + 1, ny = maxY - minY + 1, nz = maxZ - minZ + 1;
        const data = new Uint8Array(nx * ny * nz);
        for (const b of blocks) {
            data[((b.x - minX) * nz + (b.z - minZ)) * ny + (b.y - minY)] = types.indexOf(b.type) + 1;
        }
        return new VoxelGrid(nx, ny, nz, minX, minY, minZ, types, data);
    }

    // ---------- indexing ----------
    idx(lx, ly, lz) { return (lx * this.nz + lz) * this.ny + ly; }
    inside(lx, ly, lz) { return lx >= 0 && ly >= 0 && lz >= 0 && lx < this.nx && ly < this.ny && lz < this.nz; }
    get(lx, ly, lz) { return this.inside(lx, ly, lz) ? this.data[this.idx(lx, ly, lz)] : 0; }
    unpack(i) {
        const ly = i % this.ny; const r = (i - ly) / this.ny;
        const lz = r % this.nz; const lx = (r - lz) / this.nz;
        return [lx, ly, lz];
    }
    typeName(code) { return code ? this.types[code - 1] : null; }

    // world <-> local cell
    cellX(wx) { return Math.floor(wx / this.VS + 0.5) - this.x0; }
    cellY(wy) { return Math.floor(wy / this.VS + 0.5) - this.y0; }
    cellZ(wz) { return Math.floor(wz / this.VS + 0.5) - this.z0; }
    worldX(lx) { return (lx + this.x0) * this.VS; }
    worldY(ly) { return (ly + this.y0) * this.VS; }
    worldZ(lz) { return (lz + this.z0) * this.VS; }

    /** Highest cell in column (lx,lz) satisfying pred(code, i). Returns ly or -1 */
    topWhere(lx, lz, pred) {
        if (lx < 0 || lz < 0 || lx >= this.nx || lz >= this.nz) return -1;
        const base = (lx * this.nz + lz) * this.ny;
        for (let ly = this.ny - 1; ly >= 0; ly--) {
            const c = this.data[base + ly];
            if (c && pred(c, base + ly)) return ly;
        }
        return -1;
    }

    /**
     * Amanatides & Woo voxel traversal. Origin/dir in world units (dir normalised).
     * pred(i, code) decides what counts as a hit. Returns {i,lx,ly,lz,nx,ny,nz,dist} or null.
     */
    raycast(o, d, maxDist, pred) {
        const VS = this.VS;
        let gx = o.x / VS + 0.5 - this.x0, gy = o.y / VS + 0.5 - this.y0, gz = o.z / VS + 0.5 - this.z0;
        let ix = Math.floor(gx), iy = Math.floor(gy), iz = Math.floor(gz);
        const sx = d.x > 0 ? 1 : -1, sy = d.y > 0 ? 1 : -1, sz = d.z > 0 ? 1 : -1;
        const tdx = d.x !== 0 ? Math.abs(1 / d.x) : Infinity;
        const tdy = d.y !== 0 ? Math.abs(1 / d.y) : Infinity;
        const tdz = d.z !== 0 ? Math.abs(1 / d.z) : Infinity;
        let tmx = d.x !== 0 ? (d.x > 0 ? ix + 1 - gx : gx - ix) * tdx : Infinity;
        let tmy = d.y !== 0 ? (d.y > 0 ? iy + 1 - gy : gy - iy) * tdy : Infinity;
        let tmz = d.z !== 0 ? (d.z > 0 ? iz + 1 - gz : gz - iz) * tdz : Infinity;
        const tMax = maxDist / VS;
        let t = 0, nX = 0, nY = 0, nZ = 0;
        while (t <= tMax) {
            if (this.inside(ix, iy, iz)) {
                const i = this.idx(ix, iy, iz), c = this.data[i];
                if (c && pred(i, c)) return { i, lx: ix, ly: iy, lz: iz, nx: nX, ny: nY, nz: nZ, dist: t * VS };
            }
            if (tmx < tmy && tmx < tmz) { ix += sx; t = tmx; tmx += tdx; nX = -sx; nY = 0; nZ = 0; }
            else if (tmy < tmz) { iy += sy; t = tmy; tmy += tdy; nX = 0; nY = -sy; nZ = 0; }
            else { iz += sz; t = tmz; tmz += tdz; nX = 0; nY = 0; nZ = -sz; }
        }
        return null;
    }
}
window.VoxelGrid = VoxelGrid;
