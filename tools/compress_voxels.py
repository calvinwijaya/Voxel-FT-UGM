#!/usr/bin/env python3
"""
Convert environment_blocks.json  ->  environment_blocks.vxl.gz

Format "VXL1" (little-endian), whole file gzip-compressed:
  0   4  magic  b"VXL1"
  4   2  nx (uint16)   grid size along X
  6   2  ny (uint16)   grid size along Y (height)
  8   2  nz (uint16)   grid size along Z
 10   2  x0 (int16)    index offset: real x = local x + x0
 12   2  y0 (int16)
 14   2  z0 (int16)
 16   1  nTypes (uint8)
 17   .. for each type: uint8 length + ASCII name
 ..   nx*nz*ny bytes  dense grid, 0 = empty, k = type k-1
      byte order: index = (x * nz + z) * ny + y   (vertical columns are contiguous,
      which is what makes gzip so effective on terrain/buildings)

Usage:
  python tools/compress_voxels.py environment_blocks.json environment_blocks.vxl.gz
"""
import gzip
import json
import struct
import sys

TYPES = ["ground", "river", "building", "building_roof", "tree_low", "tree_high"]


def main(src, dst):
    with open(src, "r", encoding="utf-8") as f:
        blocks = json.load(f)

    types = list(TYPES)
    for b in blocks:  # keep any extra classes you add later
        if b["type"] not in types:
            types.append(b["type"])

    xs = [b["x"] for b in blocks]; ys = [b["y"] for b in blocks]; zs = [b["z"] for b in blocks]
    x0, y0, z0 = min(xs), min(ys), min(zs)
    nx, ny, nz = max(xs) - x0 + 1, max(ys) - y0 + 1, max(zs) - z0 + 1

    grid = bytearray(nx * ny * nz)
    for b in blocks:
        i = ((b["x"] - x0) * nz + (b["z"] - z0)) * ny + (b["y"] - y0)
        grid[i] = types.index(b["type"]) + 1

    header = b"VXL1" + struct.pack("<HHHhhhB", nx, ny, nz, x0, y0, z0, len(types))
    for t in types:
        enc = t.encode("ascii")
        header += struct.pack("<B", len(enc)) + enc

    data = gzip.compress(header + bytes(grid), compresslevel=9)
    with open(dst, "wb") as f:
        f.write(data)

    print(f"{len(blocks):,} voxels, grid {nx}x{ny}x{nz}")
    import os
    print(f"Input : {src}  ({os.path.getsize(src):,} bytes)")
    print(f"Output: {dst}  ({len(data):,} bytes)")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print(__doc__)
        sys.exit(1)
    main(sys.argv[1], sys.argv[2])
