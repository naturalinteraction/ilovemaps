import * as Cesium from "cesium";
import drapeShaderGLSL from "./drapeShader.glsl?raw";

// ---------------------------------------------------------------------------
// Hardcoded 6-DOF pose 
// ---------------------------------------------------------------------------

const DRONE_POSE_3 = {
  lat: 46.3267,       // degrees
  lon: 10.3244,        // degrees
  alt: 1078.0,        // metres above ellipsoid
  heading: 201,         // degrees, 0 = North, clockwise
  pitch: 43,       // degrees, 0 = horizontal, positive = looking down, 90 = straight down
  roll: -2,          // degrees
  hFovDeg: 59.60,      // horizontal field of view
  aspectRatio: 4 / 3,
};

const DRONE_POSE_2 = {
  lat: 46.3301,       // degrees
  lon: 10.3289,        // degrees
  alt: 1004.0,        // metres above ellipsoid
  heading: 208,       // degrees, 0 = North, clockwise
  pitch: 51,       // degrees, 0 = horizontal, positive = looking down, 90 = straight down
  roll: 0,          // degrees
  hFovDeg: 59.60,      // horizontal field of view
  aspectRatio: 4 / 3,
};

const DRONE_POSE = DRONE_POSE_3
const DRONE_FRAME_URL = "/data/drone_frame_3.png"

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


  // Build body rotation manually in ENU frame (East-North-Up).
  // ENU axes: X = East (right), Y = North (forward), Z = Up.
  //
  // Cesium's fromHeadingPitchRoll uses order Z·Y·X which couples roll into
  // the forward direction.  We need Z·X·Y (heading · pitch · roll) so that
  // roll — the innermost rotation about the forward/Y axis — never changes
  // where the camera points.
  //
  // Sign conventions:
  //   heading: 0 = North, positive = clockwise  →  −heading about Z
  //   pitch:   positive = looking down           →  −pitch about X
  //   roll:    standard right-hand about Y
  const headRad  = Cesium.Math.toRadians(pose.heading);
  const pitchRad = Cesium.Math.toRadians(pose.pitch);
  const rollRad  = Cesium.Math.toRadians(pose.roll);

  const rollQ  = Cesium.Quaternion.fromAxisAngle(Cesium.Cartesian3.UNIT_Y, rollRad);
  const pitchQ = Cesium.Quaternion.fromAxisAngle(Cesium.Cartesian3.UNIT_X, -pitchRad);
  const headQ  = Cesium.Quaternion.fromAxisAngle(Cesium.Cartesian3.UNIT_Z, -headRad);

  // Combined in ENU: heading * pitch * roll  (applied right-to-left)
  let bodyQ = Cesium.Quaternion.multiply(pitchQ, rollQ, new Cesium.Quaternion());
  bodyQ = Cesium.Quaternion.multiply(headQ, bodyQ, bodyQ);

  const bodyRot = Cesium.Matrix3.fromQuaternion(bodyQ);

  // ENU-to-ECEF rotation (from the local frame at the drone position)
  const enuToEcef4 = Cesium.Transforms.eastNorthUpToFixedFrame(droneEcef);
  const enuRot = Cesium.Matrix4.getMatrix3(enuToEcef4, new Cesium.Matrix3());

  // Full rotation: ENU-to-ECEF * body-in-ENU  →  body axes in ECEF
  const fullRot = Cesium.Matrix3.multiply(enuRot, bodyRot, new Cesium.Matrix3());

  // Extract axes (columns of the body-to-ECEF rotation)
  // Column 0: right (East), Column 1: forward (North), Column 2: up
  const right   = Cesium.Matrix3.getColumn(fullRot, 0, new Cesium.Cartesian3());
  const forward = Cesium.Matrix3.getColumn(fullRot, 1, new Cesium.Cartesian3());
  const up      = Cesium.Matrix3.getColumn(fullRot, 2, new Cesium.Cartesian3());


  // View matrix: world → camera, no translation (RTC origin = drone position)
  // OpenGL camera: +X = right, +Y = up, −Z = forward
  // Each ROW is a camera axis (dot-product projects world coords onto that axis)
  // Cesium.Matrix4 constructor args: column0Row0, column1Row0, ... (row by row)
  const viewMatrix = new Cesium.Matrix4(
    right.x,      right.y,      right.z,      0,
    up.x,         up.y,         up.z,         0,
   -forward.x,   -forward.y,   -forward.z,    0,
    0,            0,             0,            1,
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
const ARROW_LENGTH = 20;
const MOVE_STEP = 0.00009; // degrees ~10m at equator

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
export async function setupDroneVideoLayer(viewer) {
  const image = await Cesium.Resource.fetchImage({ url: DRONE_FRAME_URL });

  const texture = new Cesium.Texture({
    context: viewer.scene.context,
    source: image,
  });

  let drone = computeDroneCameraMatrix(DRONE_POSE);
  let droneAlpha = 0.7;

  const stage = new Cesium.PostProcessStage({
    fragmentShader: drapeShaderGLSL,
    uniforms: {
      videoTexture:      () => texture,
      droneEcefPosition: () => drone.ecef,
      droneCameraMatrix: () => drone.matrix,
      videoAlpha:        () => droneAlpha,
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
      radii: new Cesium.Cartesian3(2, 2, 2),
      material: Cesium.Color.YELLOW,
      outline: true,
      outlineColor: Cesium.Color.ORANGE,
      outlineWidth: 2,
    },
  });

  function poseLabel() {
    return `${DRONE_POSE.lat.toFixed(4)}, ${DRONE_POSE.lon.toFixed(4)}, ${DRONE_POSE.alt.toFixed(1)}m\nH:${DRONE_POSE.heading.toFixed(1)}° P:${DRONE_POSE.pitch.toFixed(1)}° R:${DRONE_POSE.roll.toFixed(1)}°`;
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
    const headRad = Cesium.Math.toRadians(DRONE_POSE.heading);
    if (e.key === "v" || e.key === "V") {
      viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(DRONE_POSE.lon, DRONE_POSE.lat, DRONE_POSE.alt + 500),
        orientation: {
          heading: Cesium.Math.toRadians(DRONE_POSE.heading),
          pitch: Cesium.Math.toRadians(-DRONE_POSE.pitch),
          roll: 0,
        },
      });
    } else if (e.key === "r" || e.key === "R") {
      viewer.camera.flyTo({ destination: Cesium.Cartesian3.fromDegrees(8.82, 46.23, 5000) });
    } else if (e.key === "u" || e.key === "U") {
      viewer.camera.flyTo({ destination: Cesium.Cartesian3.fromDegrees(7.97, 46.55, 8000) });
    } else if (e.key === "ArrowUp") {
      DRONE_POSE.lat += MOVE_STEP * Math.cos(headRad);
      DRONE_POSE.lon += MOVE_STEP * Math.sin(headRad);
      drone = computeDroneCameraMatrix(DRONE_POSE);
      refreshIndicator();
    } else if (e.key === "ArrowDown") {
      DRONE_POSE.lat -= MOVE_STEP * Math.cos(headRad);
      DRONE_POSE.lon -= MOVE_STEP * Math.sin(headRad);
      drone = computeDroneCameraMatrix(DRONE_POSE);
      refreshIndicator();
    } else if (e.key === "ArrowLeft") {
      DRONE_POSE.lat += MOVE_STEP * Math.sin(headRad);
      DRONE_POSE.lon -= MOVE_STEP * Math.cos(headRad);
      drone = computeDroneCameraMatrix(DRONE_POSE);
      refreshIndicator();
    } else if (e.key === "ArrowRight") {
      DRONE_POSE.lat -= MOVE_STEP * Math.sin(headRad);
      DRONE_POSE.lon += MOVE_STEP * Math.cos(headRad);
      drone = computeDroneCameraMatrix(DRONE_POSE);
      refreshIndicator();
    } else if (e.key === "a") {
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
    } else if (e.key === "i") {
      DRONE_POSE.alt += 2;
      drone = computeDroneCameraMatrix(DRONE_POSE);
      refreshIndicator();
    } else if (e.key === "k") {
      DRONE_POSE.alt -= 2;
      drone = computeDroneCameraMatrix(DRONE_POSE);
      refreshIndicator();
    } else if (e.key === "t" || e.key === "T") {
      droneAlpha = droneAlpha < 0.1 ? 0.5 : droneAlpha < 0.6 ? 1.0 : 0.0;
    }
  });

  return stage;
}
