import * as Cesium from "cesium";

/**
 * Create a CustomHeightmapTerrainProvider that uses the DSM heightmap
 * within the DSM bounds and falls back to a constant elevation outside.
 *
 * Usage:
 *   const provider = await createDSMTerrainProvider();
 *   viewer.scene.terrainProvider = provider;
 */

const DSM_BIN_URL = "/data/dsm_heightmap.bin";
const DSM_META_URL = "/data/dsm_metadata.json";

const TILE_WIDTH = 64;
const TILE_HEIGHT = 64;

export async function createDSMTerrainProvider() {
  const [meta, buf] = await Promise.all([
    fetch(DSM_META_URL).then((r) => r.json()),
    fetch(DSM_BIN_URL).then((r) => r.arrayBuffer()),
  ]);

  const dsmData = new Float32Array(buf);
  const { ncols, nrows, wgs84_lon_min, wgs84_lon_max, wgs84_lat_min, wgs84_lat_max, elev_mean } = meta;
  const lonRange = wgs84_lon_max - wgs84_lon_min;
  const latRange = wgs84_lat_max - wgs84_lat_min;

  // Geoid undulation: DSM heights are orthometric (above geoid), but Cesium
  // expects ellipsoidal heights (above WGS84 ellipsoid).  For the Florence area
  // the offset is ~35m, empirically calibrated against the drone's known position.
  const GEOID_OFFSET = 35.34;

  // Empirical positional correction (metres, east/north positive)
  // Exposed as provider.dsmOffsetE / dsmOffsetN for interactive tuning.
  let dsmOffsetE = -7.5; // metres east (negative = west)
  let dsmOffsetN = -9.5; // metres north (negative = south)

  // Convert metre offsets to degrees at this latitude
  const DEG_PER_M_LON = 1.0 / (111320 * Math.cos(((wgs84_lat_min + wgs84_lat_max) / 2) * Math.PI / 180));
  const DEG_PER_M_LAT = 1.0 / 111320;

  // Bilinear DSM sampling in WGS84
  function sampleDSM(lon, lat) {
    const u = (lon + dsmOffsetE * DEG_PER_M_LON - wgs84_lon_min) / lonRange;
    const v = (lat + dsmOffsetN * DEG_PER_M_LAT - wgs84_lat_min) / latRange;

    if (u < 0 || u > 1 || v < 0 || v > 1) return elev_mean + GEOID_OFFSET;

    // Row 0 = north (top), so flip v
    const col = u * (ncols - 1);
    const row = (1 - v) * (nrows - 1);

    const c0 = Math.floor(col);
    const r0 = Math.floor(row);
    const c1 = Math.min(c0 + 1, ncols - 1);
    const r1 = Math.min(r0 + 1, nrows - 1);
    const fc = col - c0;
    const fr = row - r0;

    const h00 = dsmData[r0 * ncols + c0];
    const h10 = dsmData[r0 * ncols + c1];
    const h01 = dsmData[r1 * ncols + c0];
    const h11 = dsmData[r1 * ncols + c1];

    // Handle NODATA sentinel (-100)
    if (h00 < -99 || h10 < -99 || h01 < -99 || h11 < -99) return elev_mean + GEOID_OFFSET;

    const top = h00 + (h10 - h00) * fc;
    const bot = h01 + (h11 - h01) * fc;
    return top + (bot - top) * fr + GEOID_OFFSET;
  }

  // Blend DSM height with mean elevation near DSM edges to avoid hard seams.
  // Applies a smooth fade over a ~10m margin inside the DSM bounds.
  function sampleWithBlend(lon, lat) {
    const u = (lon + dsmOffsetE * DEG_PER_M_LON - wgs84_lon_min) / lonRange;
    const v = (lat + dsmOffsetN * DEG_PER_M_LAT - wgs84_lat_min) / latRange;

    if (u < -0.01 || u > 1.01 || v < -0.01 || v > 1.01) return elev_mean + GEOID_OFFSET;

    const margin = 0.02; // ~2% of DSM size ≈ 10m
    const fade = Math.min(
      smoothstep(0, margin, u),
      smoothstep(0, margin, 1 - u),
      smoothstep(0, margin, v),
      smoothstep(0, margin, 1 - v),
    );

    const dsmH = sampleDSM(lon, lat);
    return (elev_mean + GEOID_OFFSET) + (dsmH - (elev_mean + GEOID_OFFSET)) * fade;
  }

  const tilingScheme = new Cesium.GeographicTilingScheme();

  const provider = new Cesium.CustomHeightmapTerrainProvider({
    width: TILE_WIDTH,
    height: TILE_HEIGHT,
    tilingScheme,
    callback: (x, y, level) => {
      const rect = tilingScheme.tileXYToRectangle(x, y, level);
      const west = Cesium.Math.toDegrees(rect.west);
      const south = Cesium.Math.toDegrees(rect.south);
      const east = Cesium.Math.toDegrees(rect.east);
      const north = Cesium.Math.toDegrees(rect.north);

      const heights = new Float32Array(TILE_WIDTH * TILE_HEIGHT);

      // Check if tile intersects DSM bounds (with some padding)
      const pad = 0.001; // ~100m padding
      const intersects =
        east > wgs84_lon_min - pad && west < wgs84_lon_max + pad &&
        north > wgs84_lat_min - pad && south < wgs84_lat_max + pad;

      if (!intersects || level < 10) {
        // Outside DSM or very zoomed out: flat at mean elevation
        heights.fill(elev_mean + GEOID_OFFSET);
        return heights;
      }

      // Sample DSM for each grid point in this tile
      for (let row = 0; row < TILE_HEIGHT; row++) {
        for (let col = 0; col < TILE_WIDTH; col++) {
          const u = col / (TILE_WIDTH - 1);
          const v = row / (TILE_HEIGHT - 1);
          const lon = west + u * (east - west);
          // Tile rows go from north (row 0) to south (row H-1)
          const lat = north - v * (north - south);

          heights[row * TILE_WIDTH + col] = sampleWithBlend(lon, lat);
        }
      }

      return heights;
    },
  });

  console.log(
    `DSM terrain provider created: ${ncols}x${nrows} @ ${meta.cellsize_m}m, ` +
    `mean elev=${elev_mean.toFixed(1)}m`
  );

  return {
    provider,
    meta,
    get dsmOffsetE() { return dsmOffsetE; },
    set dsmOffsetE(v) { dsmOffsetE = v; },
    get dsmOffsetN() { return dsmOffsetN; },
    set dsmOffsetN(v) { dsmOffsetN = v; },
  };
}

function smoothstep(edge0, edge1, x) {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}
