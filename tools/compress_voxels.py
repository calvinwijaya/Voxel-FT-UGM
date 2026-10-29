#!/usr/bin/env python3
"""
Convert a voxel JSON file  [{"x":..,"y":..,"z":..,"type":".."}, ...]
into the compact binary used by the web viewer (.vxl.gz).

Works on very large files (hundreds of MB): the JSON is read in chunks with a
streaming parser, so it is never loaded into memory as Python objects.

Usage
  python tools/compress_voxels.py INPUT.json OUTPUT.vxl.gz --size VOXEL_SIZE_M

Examples
  python tools/compress_voxels.py environment_blocks.json     environment_blocks.vxl.gz     --size 2
  python tools/compress_voxels.py environment_blocks_1m.json  environment_blocks_1m.vxl.gz  --size 1
  python tools/compress_voxels.py environment_blocks_05m.json environment_blocks_05m.vxl.gz --size 0.5

Install numpy (pip install numpy) for a faster run; it also works without it.

File format "VXL2" (little-endian), whole file gzip-compressed:
   0  4  magic  b"VXL2"
   4 12  nx, ny, nz          uint32   grid size (X, Y = height, Z)
  16 12  x0, y0, z0          int32    index offset: real index = local index + offset
  28  4  voxel size (m)      float32
  32  1  nTypes              uint8
  33 ..  per type: uint8 length + ASCII name
  ..     nx*nz*ny bytes, 0 = empty, k = type k-1,
         index = (x * nz + z) * ny + y   (vertical columns contiguous → compresses very well)
The viewer also still reads the older "VXL1" files.
"""
import argparse
import gzip
import os
import re
import struct
import sys
import time
from array import array

TYPES = ["ground", "river", "building", "building_roof", "tree_low", "tree_high"]
CHUNK = 32 * 1024 * 1024

# the common shape {"x":1,"y":2,"z":3,"type":"ground"} (any whitespace)…
FAST = re.compile(rb'\{\s*"x"\s*:\s*(-?\d+)\s*,\s*"y"\s*:\s*(-?\d+)\s*,\s*"z"\s*:\s*(-?\d+)\s*,\s*"type"\s*:\s*"([^"]*)"\s*\}')
# …and a generic fallback for other key orders / extra keys
OBJ = re.compile(rb'\{[^{}]*\}')
FIELD = re.compile(rb'"(x|y|z|type)"\s*:\s*(?:"([^"]*)"|(-?\d+(?:\.\d+)?))')


def objects(path):
    """yield (x, y, z, type_bytes) for every voxel, streaming the file"""
    size = os.path.getsize(path)
    done, t0, tail = 0, time.time(), b""
    with open(path, "rb") as f:
        while True:
            chunk = f.read(CHUNK)
            if not chunk and not tail:
                break
            buf = tail + chunk
            cut = buf.rfind(b"}") + 1 if chunk else len(buf)     # never split an object
            body, tail = buf[:cut], buf[cut:]
            n_fast = 0
            for m in FAST.finditer(body):
                n_fast += 1
                yield int(m.group(1)), int(m.group(2)), int(m.group(3)), m.group(4)
            if n_fast == 0 or n_fast < body.count(b"{") - 1:      # unusual layout → generic parser
                if n_fast:
                    raise SystemExit("Mixed key layouts in one file are not supported; please export consistently.")
                for o in OBJ.finditer(body):
                    d = {k: (s or v) for k, s, v in FIELD.findall(o.group(0))}
                    if b"x" in d and b"type" in d:
                        yield int(float(d[b"x"])), int(float(d[b"y"])), int(float(d[b"z"])), d[b"type"]
            done += len(chunk)
            if chunk:
                el = time.time() - t0
                sys.stderr.write(f"\r  reading {done / size * 100:5.1f}%  ({done / 1e6:,.0f} / {size / 1e6:,.0f} MB, {el:,.0f} s)")
                sys.stderr.flush()
            if not chunk:
                break
    sys.stderr.write("\n")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("src")
    ap.add_argument("dst")
    ap.add_argument("--size", type=float, required=True, help="voxel size in metres (2, 1, 0.5 …)")
    ap.add_argument("--level", type=int, default=9, help="gzip level 1-9 (default 9)")
    a = ap.parse_args()

    t0 = time.time()
    print(f"Input : {a.src}  ({os.path.getsize(a.src) / 1e6:,.1f} MB)")
    types = list(TYPES)
    tindex = {t.encode(): i + 1 for i, t in enumerate(types)}
    xs, ys, zs, cs = array("i"), array("i"), array("i"), array("B")
    for x, y, z, t in objects(a.src):
        c = tindex.get(t)
        if c is None:
            types.append(t.decode("ascii"))
            if len(types) > 255:
                raise SystemExit("More than 255 voxel types are not supported")
            c = tindex[t] = len(types)
        xs.append(x); ys.append(y); zs.append(z); cs.append(c)
    n = len(xs)
    if not n:
        raise SystemExit("No voxels found — is this the right file?")

    x0, y0, z0 = min(xs), min(ys), min(zs)
    nx, ny, nz = max(xs) - x0 + 1, max(ys) - y0 + 1, max(zs) - z0 + 1
    cells = nx * ny * nz
    print(f"Voxels: {n:,}  ·  grid {nx} × {ny} × {nz} = {cells / 1e6:,.1f} M cells  ·  types {types}")
    if cells > 600e6:
        print("WARNING: this grid needs > 600 MB in the browser; most devices will not cope.")

    try:
        import numpy as np
        X = np.frombuffer(xs, dtype=np.int32) - x0
        Y = np.frombuffer(ys, dtype=np.int32) - y0
        Z = np.frombuffer(zs, dtype=np.int32) - z0
        grid = np.zeros(cells, dtype=np.uint8)
        grid[(X.astype(np.int64) * nz + Z) * ny + Y] = np.frombuffer(cs, dtype=np.uint8)
        payload = grid.tobytes()
    except ImportError:
        print("  (numpy not installed — using the slower pure-Python path)")
        grid = bytearray(cells)
        for k in range(n):
            grid[((xs[k] - x0) * nz + (zs[k] - z0)) * ny + (ys[k] - y0)] = cs[k]
        payload = bytes(grid)
    del xs, ys, zs, cs

    header = b"VXL2" + struct.pack("<IIIiiifB", nx, ny, nz, x0, y0, z0, a.size, len(types))
    for t in types:
        e = t.encode("ascii")
        header += struct.pack("<B", len(e)) + e

    print(f"  compressing (gzip level {a.level}) …")
    with gzip.open(a.dst, "wb", compresslevel=a.level) as f:
        f.write(header)
        step = 64 * 1024 * 1024
        for i in range(0, len(payload), step):
            f.write(payload[i:i + step])
    out = os.path.getsize(a.dst)
    print(f"Output: {a.dst}  ({out / 1e6:,.2f} MB, {os.path.getsize(a.src) / out:,.0f}× smaller)  in {time.time() - t0:,.0f} s")
    print(f"Browser memory for this grid: about {cells / 1e6:,.0f} MB for the voxel cells + rendering.")


if __name__ == "__main__":
    main()
