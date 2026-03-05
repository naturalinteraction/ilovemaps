#!/usr/bin/env python3
"""Convert an ESRI ASCII Grid (.ASC) DSM to a binary float32 heightmap + JSON metadata.

Usage: python3 convert_dsm.py <input.ASC> [output_dir]

Outputs:
  <output_dir>/dsm_heightmap.bin  — raw float32, row-major (top row first), NODATA → NaN
  <output_dir>/dsm_metadata.json  — grid dimensions, WGS84 bounding box, cell size
"""
import sys, os, json, struct
import numpy as np
from pyproj import Transformer

def parse_asc(path):
    header = {}
    header_lines = 0
    with open(path) as f:
        for line in f:
            parts = line.strip().split()
            if len(parts) == 2 and parts[0].upper() in (
                'NCOLS', 'NROWS', 'XLLCENTER', 'YLLCENTER',
                'XLLCORNER', 'YLLCORNER', 'CELLSIZE', 'NODATA_VALUE',
            ):
                key = parts[0].upper()
                header[key] = float(parts[1]) if '.' in parts[1] else int(parts[1])
                header_lines += 1
            else:
                break

    ncols = int(header['NCOLS'])
    nrows = int(header['NROWS'])
    cellsize = float(header['CELLSIZE'])
    nodata = float(header.get('NODATA_VALUE', -9999))

    # Determine lower-left origin
    if 'XLLCENTER' in header:
        xll = float(header['XLLCENTER'])
        yll = float(header['YLLCENTER'])
    else:
        xll = float(header['XLLCORNER']) + cellsize / 2
        yll = float(header['YLLCORNER']) + cellsize / 2

    # Read elevation data
    data = np.loadtxt(path, skiprows=header_lines, dtype=np.float32)
    assert data.shape == (nrows, ncols), f"Expected ({nrows},{ncols}), got {data.shape}"

    # Replace NODATA with NaN
    data[data == nodata] = np.nan

    return data, ncols, nrows, cellsize, xll, yll, nodata

def main():
    if len(sys.argv) < 2:
        print(f"Usage: {sys.argv[0]} <input.ASC> [output_dir] [--cellsize N]")
        sys.exit(1)

    asc_path = sys.argv[1]
    out_dir = sys.argv[2] if len(sys.argv) > 2 and not sys.argv[2].startswith('--') else os.path.dirname(asc_path) or '.'

    data, ncols, nrows, cellsize, xll, yll, nodata = parse_asc(asc_path)

    # Optional cellsize override (e.g. file says 0.5 but data is actually 1.0m)
    for i, arg in enumerate(sys.argv):
        if arg == '--cellsize' and i + 1 < len(sys.argv):
            cellsize = float(sys.argv[i + 1])
            print(f"Overriding cellsize to {cellsize}m")

    # Compute UTM bounding box (cell centers)
    x_min = xll
    x_max = xll + (ncols - 1) * cellsize
    y_min = yll
    y_max = yll + (nrows - 1) * cellsize

    # Detect UTM zone from filename or default to 32
    basename = os.path.basename(asc_path)
    parts = basename.replace('.ASC', '').replace('.asc', '').split('_')
    utm_zone = int(parts[0]) if parts[0].isdigit() else 32

    # Convert UTM corners to WGS84
    transformer = Transformer.from_crs(f"EPSG:326{utm_zone:02d}", "EPSG:4326", always_xy=True)
    lon_min, lat_min = transformer.transform(x_min, y_min)
    lon_max, lat_max = transformer.transform(x_max, y_max)

    # Elevation stats (excluding NaN)
    valid = data[~np.isnan(data)]
    elev_min = float(np.min(valid))
    elev_max = float(np.max(valid))
    elev_mean = float(np.mean(valid))

    print(f"Grid: {ncols}x{nrows}, cell={cellsize}m")
    print(f"UTM Zone {utm_zone}N: E[{x_min:.1f}, {x_max:.1f}] N[{y_min:.1f}, {y_max:.1f}]")
    print(f"WGS84: lon[{lon_min:.6f}, {lon_max:.6f}] lat[{lat_min:.6f}, {lat_max:.6f}]")
    print(f"Elevation: [{elev_min:.1f}, {elev_max:.1f}], mean={elev_mean:.1f}")
    print(f"NODATA pixels: {np.sum(np.isnan(data))} / {ncols * nrows}")

    # Write binary float32 (row-major, top row = north)
    bin_path = os.path.join(out_dir, 'dsm_heightmap.bin')
    data.tofile(bin_path)
    print(f"Wrote {bin_path} ({os.path.getsize(bin_path)} bytes)")

    # Write metadata
    meta = {
        'ncols': ncols,
        'nrows': nrows,
        'cellsize_m': cellsize,
        'utm_zone': utm_zone,
        'utm_xmin': x_min,
        'utm_xmax': x_max,
        'utm_ymin': y_min,
        'utm_ymax': y_max,
        'wgs84_lon_min': lon_min,
        'wgs84_lon_max': lon_max,
        'wgs84_lat_min': lat_min,
        'wgs84_lat_max': lat_max,
        'elev_min': elev_min,
        'elev_max': elev_max,
        'elev_mean': elev_mean,
        'width_m': (ncols - 1) * cellsize,
        'height_m': (nrows - 1) * cellsize,
    }
    json_path = os.path.join(out_dir, 'dsm_metadata.json')
    with open(json_path, 'w') as f:
        json.dump(meta, f, indent=2)
    print(f"Wrote {json_path}")

if __name__ == '__main__':
    main()
