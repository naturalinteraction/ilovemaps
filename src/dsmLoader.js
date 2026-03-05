import * as Cesium from "cesium";

/**
 * Load a DSM heightmap (binary float32) and its JSON metadata,
 * and prepare GPU texture + uniforms for the drape shader.
 *
 * The shader needs to convert an RTC position (relative to the drone)
 * into DSM texture UV.  We build a local ENU frame at the DSM center
 * and express everything in that frame so the GPU never touches large
 * ECEF numbers.
 *
 * Exports:
 *   loadDSM(viewer, droneEcef) → { texture, uniforms }
 */

const DSM_BIN_URL = "/data/dsm_heightmap.bin";
const DSM_META_URL = "/data/dsm_metadata.json";

export async function loadDSM(viewer) {
  // Load metadata and binary heightmap in parallel
  const [meta, buf] = await Promise.all([
    fetch(DSM_META_URL).then((r) => r.json()),
    fetch(DSM_BIN_URL).then((r) => r.arrayBuffer()),
  ]);

  const { ncols, nrows, wgs84_lon_min, wgs84_lon_max, wgs84_lat_min, wgs84_lat_max } = meta;

  // DSM center in WGS84
  const centerLon = (wgs84_lon_min + wgs84_lon_max) / 2;
  const centerLat = (wgs84_lat_min + wgs84_lat_max) / 2;
  const centerAlt = 0; // elevations in the texture are absolute

  // DSM center in ECEF (64-bit)
  const centerEcef = Cesium.Cartesian3.fromDegrees(centerLon, centerLat, centerAlt);

  // ENU-to-ECEF rotation at DSM center
  const enuToEcef4 = Cesium.Transforms.eastNorthUpToFixedFrame(centerEcef);
  const enuToEcef = Cesium.Matrix4.getMatrix3(enuToEcef4, new Cesium.Matrix3());
  // ECEF-to-ENU = transpose (it's an orthonormal rotation)
  const ecefToEnu = Cesium.Matrix3.transpose(enuToEcef, new Cesium.Matrix3());

  // DSM bounding box corners in ECEF, then in ENU relative to center
  const llEcef = Cesium.Cartesian3.fromDegrees(wgs84_lon_min, wgs84_lat_min, 0);
  const urEcef = Cesium.Cartesian3.fromDegrees(wgs84_lon_max, wgs84_lat_max, 0);

  const llOffset = Cesium.Cartesian3.subtract(llEcef, centerEcef, new Cesium.Cartesian3());
  const urOffset = Cesium.Cartesian3.subtract(urEcef, centerEcef, new Cesium.Cartesian3());

  const llEnu = Cesium.Matrix3.multiplyByVector(ecefToEnu, llOffset, new Cesium.Cartesian3());
  const urEnu = Cesium.Matrix3.multiplyByVector(ecefToEnu, urOffset, new Cesium.Cartesian3());

  // ENU min/max (East, North)
  const enuMinE = llEnu.x;
  const enuMinN = llEnu.y;
  const enuSizeE = urEnu.x - llEnu.x;
  const enuSizeN = urEnu.y - llEnu.y;

  // Create float32 texture (R32F)
  const floatData = new Float32Array(buf);

  // Replace NaN with a below-ground sentinel so texture filtering doesn't break
  const sentinel = -100.0;
  for (let i = 0; i < floatData.length; i++) {
    if (isNaN(floatData[i])) floatData[i] = sentinel;
  }

  const texture = new Cesium.Texture({
    context: viewer.scene.context,
    pixelFormat: Cesium.PixelFormat.RED,
    pixelDatatype: Cesium.PixelDatatype.FLOAT,
    source: {
      width: ncols,
      height: nrows,
      arrayBufferView: floatData,
    },
    sampler: new Cesium.Sampler({
      minificationFilter: Cesium.TextureMinificationFilter.LINEAR,
      magnificationFilter: Cesium.TextureMagnificationFilter.LINEAR,
      wrapS: Cesium.TextureWrap.CLAMP_TO_EDGE,
      wrapT: Cesium.TextureWrap.CLAMP_TO_EDGE,
    }),
  });

  console.log(
    `DSM loaded: ${ncols}x${nrows}, ` +
    `lon[${wgs84_lon_min.toFixed(4)},${wgs84_lon_max.toFixed(4)}] ` +
    `lat[${wgs84_lat_min.toFixed(4)},${wgs84_lat_max.toFixed(4)}] ` +
    `elev[${meta.elev_min.toFixed(1)},${meta.elev_max.toFixed(1)}]`
  );

  return {
    texture,
    meta,
    centerEcef,
    ecefToEnu,

    /**
     * Build per-frame shader uniforms given the current drone ECEF position.
     * All offsets are relative to droneEcef (RTC origin) and computed in
     * 64-bit JS to avoid GPU float32 precision loss.
     */
    getUniforms(droneEcef) {
      // DSM center offset from drone (64-bit subtraction)
      const dsmCenterOffset = new Cesium.Cartesian3(
        centerEcef.x - droneEcef.x,
        centerEcef.y - droneEcef.y,
        centerEcef.z - droneEcef.z,
      );

      return {
        dsmTexture: texture,
        // DSM center position relative to drone (RTC), computed in 64-bit JS
        dsmCenterOffset,
        // ECEF-to-ENU rotation matrix (3x3, row-major for Cesium.Matrix3)
        dsmEcefToEnu: ecefToEnu,
        // ENU bounding box: min East/North and size East/North
        dsmEnuMin: new Cesium.Cartesian2(enuMinE, enuMinN),
        dsmEnuSize: new Cesium.Cartesian2(enuSizeE, enuSizeN),
        // Mean elevation for fallback when outside DSM
        dsmMeanElev: meta.elev_mean,
      };
    },
  };
}
