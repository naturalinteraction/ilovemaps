import * as Cesium from "cesium";
import drapeShaderGLSL from "./drapeShader.glsl?raw";

// ---------------------------------------------------------------------------
// Hardcoded 6-DOF pose (matches data/drone_pose.json)
// ---------------------------------------------------------------------------
const DRONE_POSE = {
  lat: 46.22,       // degrees
  lon: 8.82,        // degrees
  alt: 1500,        // metres above ellipsoid
  heading: 0,       // degrees, 0 = North, clockwise
  pitch: -85,       // degrees, 0 = horizontal, negative = looking down
  roll: 0,          // degrees
  hFovDeg: 60,      // horizontal field of view
  aspectRatio: 16 / 9,
};

// ---------------------------------------------------------------------------
// Build drone camera matrix (projection * view) in RTC frame
//
// Cesium.Transforms.headingPitchRollToFixedFrame gives a 4×4 matrix whose
// columns are [right, forward, up, position] in ECEF.
//
// OpenGL camera convention: +X = right, +Y = up, −Z = forward.
// View matrix rows are therefore: right, up, −forward (no translation because
// the drone is our RTC origin).
// ---------------------------------------------------------------------------
function computeDroneCameraMatrix(pose) {
  const droneEcef = Cesium.Cartesian3.fromDegrees(pose.lon, pose.lat, pose.alt);

  const hpr = new Cesium.HeadingPitchRoll(
    Cesium.Math.toRadians(pose.heading),
    Cesium.Math.toRadians(pose.pitch),
    Cesium.Math.toRadians(pose.roll),
  );

  // localFrame columns: [right | forward | up | pos]  (4×4, column-major)
  const localFrame = Cesium.Transforms.headingPitchRollToFixedFrame(droneEcef, hpr);

  // Extract the three axes from the column-major flat array
  const right   = new Cesium.Cartesian3(localFrame[0], localFrame[1], localFrame[2]);
  const forward = new Cesium.Cartesian3(localFrame[4], localFrame[5], localFrame[6]);
  const up      = new Cesium.Cartesian3(localFrame[8], localFrame[9], localFrame[10]);

  // View matrix: world → camera, no translation (RTC origin = drone position)
  // Cesium.Matrix4 constructor args: column0Row0, column0Row1, ... (column-major)
  // Row 0 = right, Row 1 = up, Row 2 = −forward
  //   ↓ stored column by column:
  //   col0 = (r.x, u.x, −f.x, 0)
  //   col1 = (r.y, u.y, −f.y, 0)
  //   col2 = (r.z, u.z, −f.z, 0)
  //   col3 = (0,   0,   0,    1)
  const viewMatrix = new Cesium.Matrix4(
    right.x,      up.x,      -forward.x, 0,
    right.y,      up.y,      -forward.y, 0,
    right.z,      up.z,      -forward.z, 0,
    0,            0,          0,          1,
  );

  // Projection matrix from horizontal FOV + aspect ratio
  const hFovRad = Cesium.Math.toRadians(pose.hFovDeg);
  const aspect  = pose.aspectRatio;
  const vFovRad = 2.0 * Math.atan(Math.tan(hFovRad / 2.0) / aspect);
  const near    = 1.0;
  const far     = 50000.0;
  const f       = 1.0 / Math.tan(vFovRad / 2.0);
  const nf      = 1.0 / (near - far);

  // Standard OpenGL perspective (column-major):
  //   col0 = (f/a, 0,  0,                0)
  //   col1 = (0,   f,  0,                0)
  //   col2 = (0,   0,  (far+near)*nf,   −1)
  //   col3 = (0,   0,  2·far·near·nf,    0)
  const projMatrix = new Cesium.Matrix4(
    f / aspect, 0, 0,                    0,
    0,          f, 0,                    0,
    0,          0, (far + near) * nf,   -1,
    0,          0, 2.0 * far * near * nf, 0,
  );

  return {
    ecef: droneEcef,
    matrix: Cesium.Matrix4.multiply(projMatrix, viewMatrix, new Cesium.Matrix4()),
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
export async function setupDroneVideoLayer(viewer) {
  const image = await Cesium.Resource.fetchImage({ url: "/data/drone_frame.jpg" });

  const texture = new Cesium.Texture({
    context: viewer.scene.context,
    source: image,
  });

  const drone = computeDroneCameraMatrix(DRONE_POSE);

  const stage = new Cesium.PostProcessStage({
    fragmentShader: drapeShaderGLSL,
    uniforms: {
      videoTexture:      () => texture,
      droneEcefPosition: () => drone.ecef,
      droneCameraMatrix: () => drone.matrix,
      videoAlpha:        () => 0.8,
    },
  });

  viewer.scene.postProcessStages.add(stage);
  return stage;
}
