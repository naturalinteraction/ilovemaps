import * as Cesium from "cesium";
import drapeShaderGLSL from "./drapeShader.glsl?raw";

// ---------------------------------------------------------------------------
// Hardcoded 6-DOF pose (matches data/drone_pose.json)
// ---------------------------------------------------------------------------
const DRONE_POSE = {
  lat: 46.22,       // degrees
  lon: 8.8,        // degrees
  alt: 2700,        // metres above ellipsoid
  heading: 0,       // degrees, 0 = North, clockwise
  pitch: 0,       // degrees, 0 = horizontal, positive = looking down, 90 = straight down
  roll: 0,          // degrees
  hFovDeg: 30,      // horizontal field of view
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


  const hpr = Cesium.HeadingPitchRoll.fromDegrees(pose.heading, pose.pitch, pose.roll)
  //const hpr = new Cesium.HeadingPitchRoll(
  //  Cesium.Math.toRadians(pose.heading),
  //  Cesium.Math.toRadians(pose.pitch),
  //  Cesium.Math.toRadians(pose.roll),
  //);


var quaternion = Cesium.Transforms.headingPitchRollQuaternion(droneEcef, hpr);

// 3. Convert Quaternion to a 3x3 Rotation Matrix
var rotMat = Cesium.Matrix3.fromQuaternion(quaternion);

// 4. Extract Local Axis Vectors
// Column 0: Right (X)
// Column 1: Forward (Y) - Depends on convention, often used as Right
// Column 2: Up (Z)
var right = new Cesium.Cartesian3();
var forward = new Cesium.Cartesian3();
var up = new Cesium.Cartesian3();

Cesium.Matrix3.getColumn(rotMat, 0, right);
Cesium.Matrix3.getColumn(rotMat, 1, forward);
Cesium.Matrix3.getColumn(rotMat, 2, up);



  // localFrame columns: [right | forward | up | pos]  (4×4, column-major)
  //const localFrame = Cesium.Transforms.headingPitchRollToFixedFrame(droneEcef, hpr);

  // Extract the three axes from the column-major flat array
  //const right   = new Cesium.Cartesian3(localFrame[0], localFrame[1], localFrame[2]);
  //const forward = new Cesium.Cartesian3(localFrame[4], localFrame[5], localFrame[6]);
  //const up      = new Cesium.Cartesian3(localFrame[8], localFrame[9], localFrame[10]);

  // forward is the unit look-at direction in ECEF — exposed for the 3D indicator

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
  const far     = 5000.0;
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
    forward,
    matrix: Cesium.Matrix4.multiply(projMatrix, viewMatrix, new Cesium.Matrix4()),
  };
}

// Length of the look-direction arrow in metres
const ARROW_LENGTH = 400;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
export async function setupDroneVideoLayer(viewer) {
  const image = await Cesium.Resource.fetchImage({ url: "/data/drone_frame.jpg" });

  const texture = new Cesium.Texture({
    context: viewer.scene.context,
    source: image,
  });

  let drone = computeDroneCameraMatrix(DRONE_POSE);

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

  // --- 3D drone indicator: sphere + look-direction arrow -------------------

  function arrowTip(ecef, fwd) {
    return Cesium.Cartesian3.add(
      ecef,
      Cesium.Cartesian3.multiplyByScalar(fwd, ARROW_LENGTH, new Cesium.Cartesian3()),
      new Cesium.Cartesian3(),
    );
  }

  // Sphere: store entity ref so we can reassign .position when pose changes.
  // Use a direct Cartesian3 (wrapped to ConstantPositionProperty internally)
  // rather than CallbackProperty, which can have issues with ellipsoid graphics.
  const sphereEntity = viewer.entities.add({
    position: drone.ecef,
    ellipsoid: {
      radii: new Cesium.Cartesian3(200, 200, 200),
      material: Cesium.Color.YELLOW,
      outline: true,
      outlineColor: Cesium.Color.ORANGE,
      outlineWidth: 2,
    },
  });

  function poseLabel() {
    return `H:${DRONE_POSE.heading.toFixed(1)}° P:${DRONE_POSE.pitch.toFixed(1)}° R:${DRONE_POSE.roll.toFixed(1)}°`;
  }

  // Always-visible point + label at the drone location.
  const dotEntity = viewer.entities.add({
    position: drone.ecef,
    point: {
      pixelSize: 14,
      color: Cesium.Color.YELLOW,
      outlineColor: Cesium.Color.ORANGE,
      outlineWidth: 2,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
    label: {
      text: poseLabel(),
      font: "28px monospace",
      style: Cesium.LabelStyle.FILL_AND_OUTLINE,
      outlineWidth: 2,
      fillColor: Cesium.Color.WHITE,
      outlineColor: Cesium.Color.BLACK,
      verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
      pixelOffset: new Cesium.Cartesian2(0, -20),
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
  });

  // Arrow positions are mutable; CallbackProperty is fine for polyline positions.
  let arrowPositions = [drone.ecef, arrowTip(drone.ecef, drone.forward)];

  const arrowEntity = viewer.entities.add({
    polyline: {
      positions: new Cesium.CallbackProperty(() => arrowPositions, false),
      width: 16,
      material: new Cesium.PolylineArrowMaterialProperty(Cesium.Color.RED),
      arcType: Cesium.ArcType.NONE,
    },
  });

  function refreshIndicator() {
    sphereEntity.position = drone.ecef;
    dotEntity.position = drone.ecef;
    dotEntity.label.text = poseLabel();
    arrowPositions = [drone.ecef, arrowTip(drone.ecef, drone.forward)];
  }

  // -------------------------------------------------------------------------

  window.addEventListener("keydown", (e) => {
    if (e.key === "a") {
      DRONE_POSE.heading -= 2;
      drone = computeDroneCameraMatrix(DRONE_POSE);
      refreshIndicator();
    } else if (e.key === "d") {
      DRONE_POSE.heading += 2;
      drone = computeDroneCameraMatrix(DRONE_POSE);
      refreshIndicator();
    } else if (e.key === "w") {
      DRONE_POSE.pitch += 2;
      drone = computeDroneCameraMatrix(DRONE_POSE);
      refreshIndicator();
    } else if (e.key === "s") {
      DRONE_POSE.pitch -= 2;
      drone = computeDroneCameraMatrix(DRONE_POSE);
      refreshIndicator();
    } else if (e.key === "q") {
      DRONE_POSE.roll += 2;
      drone = computeDroneCameraMatrix(DRONE_POSE);
      refreshIndicator();
    } else if (e.key === "e") {
      DRONE_POSE.roll -= 2;
      drone = computeDroneCameraMatrix(DRONE_POSE);
      refreshIndicator();
    }
  });

  return stage;
}
