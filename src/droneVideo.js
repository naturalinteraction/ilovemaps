import * as Cesium from "cesium";
import drapeShaderGLSL from "./drapeShader.glsl?raw";

// ---------------------------------------------------------------------------
// Hardcoded 6-DOF pose 
// ---------------------------------------------------------------------------

const DRONE_POSE_3 = {
  lat: 46.3285,       // degrees
  lon: 10.3228,        // degrees
  alt: 1276.5,        // metres above ellipsoid
  heading: 191.5,         // degrees, 0 = North, clockwise
  pitch: 33.5,       // degrees, 0 = horizontal, positive = looking down, 90 = straight down
  roll: 0,          // degrees
  hFovDeg: 60.20,      // horizontal field of view
  aspectRatio: 1.0,
};

const DRONE_POSE_2 = {
  lat: 46.33074181,       // degrees
  lon: 10.32905519,        // degrees
  alt: 1074.6,        // metres above ellipsoid
  heading: 200,       // degrees, 0 = North, clockwise
  pitch: 51,       // degrees, 0 = horizontal, positive = looking down, 90 = straight down
  roll: 6,          // degrees
  hFovDeg: 71.20,      // horizontal field of view
  aspectRatio: 1.0,
};

const DRONE_FRAMES = [
  { pose: DRONE_POSE_2, url: "/data/drone_frame_2b.png" },
  { pose: DRONE_POSE_3, url: "/data/drone_frame_3b.png" },
];
let currentFrameIndex = 0;
let DRONE_POSE = { ...DRONE_FRAMES[0].pose };

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
  const far     = 300.0;
  const f       = 1.0 / Math.tan(vFovRad / 2.0);
  const nf      = 1.0 / (near - far);

  // Standard OpenGL perspective (column-major):
  //   col0 = (f/a, 0,  0,                0)
  //   col1 = (0,   f,  0,                0)
  //   col2 = (0,   0,  (far+near)*nf,   −1)
  //   col3 = (0,   0,  2·far·near·nf,    0)
  // Cesium.Matrix4 constructor takes row-major args:
  //   (col0row0, col1row0, col2row0, col3row0, col0row1, ...)
  // OpenGL perspective: -1 goes at col2row3 (row3, col2 in row-major layout)
  const projMatrix = new Cesium.Matrix4(
    f / aspect, 0,  0,                     0,
    0,          f,  0,                     0,
    0,          0,  (far + near) * nf,     2.0 * far * near * nf,
    0,          0, -1,                     0,
  );

  const matrix = Cesium.Matrix4.multiply(projMatrix, viewMatrix, new Cesium.Matrix4());
  const inverseMatrix = Cesium.Matrix4.inverse(matrix, new Cesium.Matrix4());

  return {
    ecef: droneEcef,
    forward,
    matrix,
    inverseMatrix,
  };
}

// Compute the 4 frustum corner rays extended from drone position.
// Corners in NDC: (-1,-1), (1,-1), (1,1), (-1,1) → image corners.
const FRUSTUM_RAY_LENGTH = 1500; // metres
const CORNER_NDC = [
  new Cesium.Cartesian4(-1, -1, -1, 1),
  new Cesium.Cartesian4( 1, -1, -1, 1),
  new Cesium.Cartesian4( 1,  1, -1, 1),
  new Cesium.Cartesian4(-1,  1, -1, 1),
];

function computeFrustumCorners(droneResult) {
  return CORNER_NDC.map((ndc) => {
    const rtc = Cesium.Matrix4.multiplyByVector(droneResult.inverseMatrix, ndc, new Cesium.Cartesian4());
    const dir = new Cesium.Cartesian3(rtc.x / rtc.w, rtc.y / rtc.w, rtc.z / rtc.w);
    Cesium.Cartesian3.normalize(dir, dir);
    const tip = Cesium.Cartesian3.multiplyByScalar(dir, FRUSTUM_RAY_LENGTH, new Cesium.Cartesian3());
    return Cesium.Cartesian3.add(droneResult.ecef, tip, new Cesium.Cartesian3());
  });
}

// Length of the look-direction arrow in metres
const ARROW_LENGTH = 40;
const MOVE_STEP = 0.0000225; // degrees ~2.5m at equator

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
export async function setupDroneVideoLayer(viewer) {
  // Preload all frame textures
  const textures = await Promise.all(
    DRONE_FRAMES.map(async (f) => {
      const img = await Cesium.Resource.fetchImage({ url: f.url });
      return new Cesium.Texture({ context: viewer.scene.context, source: img });
    }),
  );
  let drone = computeDroneCameraMatrix(DRONE_POSE);
  let droneAlpha = 1.0;

  // One post-process stage per drone frame, all visible simultaneously
  const droneStates = DRONE_FRAMES.map((frame, i) => {
    const cam = computeDroneCameraMatrix(frame.pose);
    const state = { cam, alpha: droneAlpha };
    const stage = new Cesium.PostProcessStage({
      fragmentShader: drapeShaderGLSL,
      uniforms: {
        videoTexture:      () => textures[i],
        droneEcefPosition: () => state.cam.ecef,
        droneCameraMatrix: () => state.cam.matrix,
        videoAlpha:        () => state.alpha,
      },
    });
    viewer.scene.postProcessStages.add(stage);
    return state;
  });

  // --- 2D overlay of current drone frame -----------------------------------
  const overlay = document.createElement("img");
  overlay.src = DRONE_FRAMES[0].url;
  overlay.style.cssText = "position:absolute;top:0;left:0;width:100%;height:100%;opacity:0.0;pointer-events:none;z-index:10";
  viewer.container.appendChild(overlay);
  let overlayVisible = true;

  // --- 3D drone indicator: sphere + look-direction arrow -------------------

  function arrowTip(ecef, fwd) {
    return Cesium.Cartesian3.add(
      ecef,
      Cesium.Cartesian3.multiplyByScalar(fwd, ARROW_LENGTH, new Cesium.Cartesian3()),
      new Cesium.Cartesian3(),
    );
  }

  function poseLabel() {
    return `${DRONE_POSE.lat.toFixed(4)}, ${DRONE_POSE.lon.toFixed(4)}, ${DRONE_POSE.alt.toFixed(1)}m\nH:${DRONE_POSE.heading.toFixed(1)}° P:${DRONE_POSE.pitch.toFixed(1)}° R:${DRONE_POSE.roll.toFixed(1)}° FOV:${DRONE_POSE.hFovDeg.toFixed(1)}° AR:${DRONE_POSE.aspectRatio.toFixed(2)}`;
  }

  // HTML overlay for pose info (always visible regardless of camera)
  const poseOverlay = document.createElement("div");
  poseOverlay.style.cssText = "position:absolute;top:10px;right:10px;padding:8px 12px;background:rgba(0,0,0,0.7);color:#fff;font:16px monospace;white-space:pre;border-radius:4px;pointer-events:none;z-index:10";
  poseOverlay.textContent = poseLabel();
  viewer.container.appendChild(poseOverlay);

  // --- Per-frame 3D indicators (dot + arrow + frustum lines) ----------------
  const INDICATOR_COLORS = [Cesium.Color.YELLOW, Cesium.Color.LIME];
  const indicators = DRONE_FRAMES.map((frame, i) => {
    const cam = droneStates[i].cam;
    let arrowPos = [cam.ecef, arrowTip(cam.ecef, cam.forward)];
    let corners = computeFrustumCorners(cam);
    let frustumPos = corners.map((c) => [cam.ecef, c]);

    const dot = viewer.entities.add({
      position: cam.ecef,
      point: {
        pixelSize: 14,
        color: INDICATOR_COLORS[i],
        outlineColor: Cesium.Color.ORANGE,
        outlineWidth: 2,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });

    const arrow = viewer.entities.add({
      polyline: {
        positions: new Cesium.CallbackProperty(() => arrowPos, false),
        width: 16,
        material: new Cesium.PolylineArrowMaterialProperty(Cesium.Color.RED),
        arcType: Cesium.ArcType.NONE,
      },
    });

    const frustumLines = frustumPos.map((_, j) =>
      viewer.entities.add({
        polyline: {
          positions: new Cesium.CallbackProperty(() => frustumPos[j], false),
          width: 2,
          material: INDICATOR_COLORS[i].withAlpha(0.7),
          arcType: Cesium.ArcType.NONE,
        },
      }),
    );

    return {
      dot, arrow, frustumLines,
      get arrowPos() { return arrowPos; },
      set arrowPos(v) { arrowPos = v; },
      get frustumPos() { return frustumPos; },
      set frustumPos(v) { frustumPos = v; },
    };
  });

  function refreshIndicator() {
    const ind = indicators[currentFrameIndex];
    ind.dot.position = drone.ecef;
    ind.arrowPos = [drone.ecef, arrowTip(drone.ecef, drone.forward)];
    const corners = computeFrustumCorners(drone);
    ind.frustumPos = corners.map((c) => [drone.ecef, c]);
    poseOverlay.textContent = poseLabel();
    droneStates[currentFrameIndex].cam = drone;
  }

  // -------------------------------------------------------------------------

  function lookThroughDrone() {
    viewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(DRONE_POSE.lon, DRONE_POSE.lat, DRONE_POSE.alt),
      orientation: {
        heading: Cesium.Math.toRadians(DRONE_POSE.heading),
        pitch: Cesium.Math.toRadians(-DRONE_POSE.pitch),
        roll: Cesium.Math.toRadians(DRONE_POSE.roll),
      },
    });
    const hFovRad = Cesium.Math.toRadians(DRONE_POSE.hFovDeg);
    viewer.camera.frustum.fov = 2.0 * Math.atan(Math.tan(hFovRad / 2.0) / DRONE_POSE.aspectRatio);
    viewer.camera.frustum.aspectRatio = DRONE_POSE.aspectRatio;
  }

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
      lookThroughDrone();
    } else if (e.key === "ArrowDown") {
      DRONE_POSE.lat -= MOVE_STEP * Math.cos(headRad);
      DRONE_POSE.lon -= MOVE_STEP * Math.sin(headRad);
      drone = computeDroneCameraMatrix(DRONE_POSE);
      refreshIndicator();
      lookThroughDrone();
    } else if (e.key === "ArrowLeft") {
      DRONE_POSE.lat += MOVE_STEP * Math.sin(headRad);
      DRONE_POSE.lon -= MOVE_STEP * Math.cos(headRad);
      drone = computeDroneCameraMatrix(DRONE_POSE);
      refreshIndicator();
      lookThroughDrone();
    } else if (e.key === "ArrowRight") {
      DRONE_POSE.lat -= MOVE_STEP * Math.sin(headRad);
      DRONE_POSE.lon += MOVE_STEP * Math.cos(headRad);
      drone = computeDroneCameraMatrix(DRONE_POSE);
      refreshIndicator();
      lookThroughDrone();
    } else if (e.key === "a") {
      DRONE_POSE.heading -= 0.5;
      drone = computeDroneCameraMatrix(DRONE_POSE);
      refreshIndicator();
      lookThroughDrone();
    } else if (e.key === "d") {
      DRONE_POSE.heading += 0.5;
      drone = computeDroneCameraMatrix(DRONE_POSE);
      refreshIndicator();
      lookThroughDrone();
    } else if (e.key === "w") {
      DRONE_POSE.pitch += 0.5;
      drone = computeDroneCameraMatrix(DRONE_POSE);
      refreshIndicator();
      lookThroughDrone();
    } else if (e.key === "s") {
      DRONE_POSE.pitch -= 0.5;
      drone = computeDroneCameraMatrix(DRONE_POSE);
      refreshIndicator();
      lookThroughDrone();
    } else if (e.key === "q") {
      DRONE_POSE.roll += 0.5;
      drone = computeDroneCameraMatrix(DRONE_POSE);
      refreshIndicator();
      lookThroughDrone();
    } else if (e.key === "e") {
      DRONE_POSE.roll -= 0.5;
      drone = computeDroneCameraMatrix(DRONE_POSE);
      refreshIndicator();
      lookThroughDrone();
    } else if (e.key === "i") {
      DRONE_POSE.alt += 0.5;
      drone = computeDroneCameraMatrix(DRONE_POSE);
      refreshIndicator();
      lookThroughDrone();
    } else if (e.key === "k") {
      DRONE_POSE.alt -= 0.5;
      drone = computeDroneCameraMatrix(DRONE_POSE);
      refreshIndicator();
      lookThroughDrone();
    } else if (e.key === "b" || e.key === "B") {
      currentFrameIndex = (currentFrameIndex + 1) % DRONE_FRAMES.length;
      const frame = DRONE_FRAMES[currentFrameIndex];
      currentTexture = textures[currentFrameIndex];
      Object.assign(DRONE_POSE, frame.pose);
      drone = computeDroneCameraMatrix(DRONE_POSE);
      refreshIndicator();
      overlay.src = frame.url;
      console.log("Switched to frame", currentFrameIndex + 2);
      lookThroughDrone();
    } else if (e.key === "g" || e.key === "G") {
      lookThroughDrone();
    } else if (e.key === "o" || e.key === "O") {
      const cur = parseFloat(overlay.style.opacity);
      overlay.style.opacity = cur < 0.01 ? "0.5" : cur < 0.6 ? "1.0" : "0.0";
    } else if (e.key === "t" || e.key === "T") {
      droneAlpha = droneAlpha < 0.1 ? 0.5 : droneAlpha < 0.6 ? 1.0 : 0.0;
      for (const s of droneStates) s.alpha = droneAlpha;
    } else if (e.key === "f" || e.key === "F") {
      const scene = viewer.scene;
      if (scene.terrainProvider instanceof Cesium.EllipsoidTerrainProvider) {
        scene.setTerrain(Cesium.Terrain.fromWorldTerrain({ requestWaterMask: true }));
        DRONE_POSE.alt += 800;
        scene.globe.depthTestAgainstTerrain = true;
      } else {
        scene.terrainProvider = new Cesium.EllipsoidTerrainProvider();
        DRONE_POSE.alt -= 800;
        scene.globe.depthTestAgainstTerrain = false;
      }
      drone = computeDroneCameraMatrix(DRONE_POSE);
      refreshIndicator();
      lookThroughDrone();
    } else if (e.key === "-") {
      DRONE_POSE.hFovDeg -= 0.5;
      drone = computeDroneCameraMatrix(DRONE_POSE);
      refreshIndicator();
      lookThroughDrone();
    } else if (e.key === "=") {
      DRONE_POSE.hFovDeg += 0.5;
      drone = computeDroneCameraMatrix(DRONE_POSE);
      refreshIndicator();
      lookThroughDrone();
    } else if (e.key === "[") {
      DRONE_POSE.aspectRatio -= 0.0125;
      drone = computeDroneCameraMatrix(DRONE_POSE);
      refreshIndicator();
      lookThroughDrone();
    } else if (e.key === "]") {
      DRONE_POSE.aspectRatio += 0.0125;
      drone = computeDroneCameraMatrix(DRONE_POSE);
      refreshIndicator();
      lookThroughDrone();
    } else if (e.key === "x" || e.key === "X") {
      const layers = viewer.imageryLayers;
      const current = layers.get(0).imageryProvider;
      layers.removeAll();
      if (current instanceof Cesium.UrlTemplateImageryProvider) {
        // Currently Google, switch to Bing
        layers.addImageryProvider(new Cesium.BingMapsImageryProvider({
          url: "https://dev.virtualearth.net",
          key: Cesium.BingMapsApi.defaultKey,
          mapStyle: Cesium.BingMapsStyle.AERIAL,
        }));
        console.log("Switched to Bing Maps");
      } else {
        // Currently Bing, switch to Google
        layers.addImageryProvider(new Cesium.UrlTemplateImageryProvider({
          url: "https://mt1.google.com/vt/lyrs=s&x={x}&y={y}&z={z}",
          maximumLevel: 20,
          credit: "Google Maps",
        }));
        console.log("Switched to Google Maps");
      }
    }
  });

  lookThroughDrone();
  return droneStates;
}
