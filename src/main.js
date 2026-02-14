import * as Cesium from "cesium";
import "cesium/Build/Cesium/Widgets/widgets.css";

// Token Cesium Ion (registrarsi su cesium.com/ion per ottenerne uno)
// Il globo funziona anche senza token, ma senza terrain 3D
// Per vedere il terrain 3D occorre anche selezionare Cesium 3D Terrain nell'interfaccia grafica
Cesium.Ion.defaultAccessToken = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJqdGkiOiI4NjI4NDI4Mi1jM2I2LTRiYzgtOTcwMy1mYWY1OTFjYmZiMzEiLCJpZCI6Mzg5OTAwLCJpYXQiOjE3NzA4ODE0ODd9.mPlDG2N5Kct-2CMb5olZ4eZeI5kzJOq3UNOOKPlCI-Y";

const viewer = new Cesium.Viewer("cesiumContainer", {
  terrain: Cesium.Terrain.fromWorldTerrain({
    requestWaterMask: true,
  }),
});

const waypointEntities = [];

async function loadWaypoints() {
  // Remove previously loaded waypoint entities
  for (const e of waypointEntities) {
    viewer.entities.remove(e);
  }
  waypointEntities.length = 0;

  const response = await fetch("/data/waypoints.json");
  const routes = await response.json();

  for (const waypoints of routes) {
    const positions = [];

    for (const wp of waypoints) {
      const position = Cesium.Cartesian3.fromDegrees(wp.lon, wp.lat, wp.alt + 50);
      positions.push(position);

      waypointEntities.push(viewer.entities.add({
        name: wp.name,
        position,
        point: {
          pixelSize: 10,
          color: Cesium.Color.BLACK,
          outlineColor: Cesium.Color.WHITE,
          outlineWidth: 2,
        },
        label: {
          text: wp.name,
          font: "14px sans-serif",
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          outlineWidth: 2,
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
          pixelOffset: new Cesium.Cartesian2(0, -15),
        },
        polyline: {
          positions: Cesium.Cartesian3.fromDegreesArrayHeights([
            wp.lon, wp.lat, wp.alt + 50,
            wp.lon, wp.lat, wp.alt - 500
          ]),
          width: 1,
          material: Cesium.Color.WHITE,
        },
      }));
    }

    waypointEntities.push(viewer.entities.add({
      polyline: {
        positions,
        width: 3,
        material: Cesium.Color.WHITE,
        clampToGround: true,
      },
    }));
  }

  currentRouteLetter = routes.length < 26 ? String.fromCharCode(65 + routes.length) : "?";
}

loadWaypoints();

async function loadCameraView() {
  try {
    const response = await fetch("/data/camera.json");
    if (!response.ok) return;
    const cameraData = await response.json();
    viewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(
        cameraData.lon,
        cameraData.lat,
        cameraData.height
      ),
      orientation: {
        heading: Cesium.Math.toRadians(cameraData.heading),
        pitch: Cesium.Math.toRadians(cameraData.pitch),
        roll: Cesium.Math.toRadians(cameraData.roll),
      },
    });
  } catch (e) {
    // camera.json not found, use default view
  }
}

loadCameraView();

let currentRouteLetter = "?";

const clickedGroundPositions = [];
const clickedEntities = [];
const clickedWaypointData = [];
const clickedPathEntity = viewer.entities.add({
  polyline: {
    positions: new Cesium.CallbackProperty(() => clickedGroundPositions, false),
    width: 3,
    material: Cesium.Color.WHITE,
    clampToGround: true,
  },
});

const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
handler.setInputAction((click) => {
  const cartesian = viewer.scene.pickPosition(click.position);
  if (cartesian) {
    const carto = Cesium.Cartographic.fromCartesian(cartesian);
    const lat = Cesium.Math.toDegrees(carto.latitude);
    const lon = Cesium.Math.toDegrees(carto.longitude);
    console.log(`lat: ${lat.toFixed(6)}, lon: ${lon.toFixed(6)}, height: ${carto.height.toFixed(6)}`);
    const elevatedPosition = Cesium.Cartesian3.fromDegrees(lon, lat, carto.height + 50);
    clickedGroundPositions.push(Cesium.Cartesian3.fromDegrees(lon, lat));

    // Compute cumulative distance, D+ and D-
    let totalDist = 0;
    let dPlus = 0;
    let dMinus = 0;
    const allPts = [...clickedWaypointData, { lat, lon, alt: carto.height }];
    for (let i = 1; i < allPts.length; i++) {
      const a = allPts[i - 1], b = allPts[i];
      totalDist += Cesium.Cartesian3.distance(
        Cesium.Cartesian3.fromDegrees(a.lon, a.lat, a.alt),
        Cesium.Cartesian3.fromDegrees(b.lon, b.lat, b.alt),
      );
      const dh = b.alt - a.alt;
      if (dh > 0) dPlus += dh; else dMinus += dh;
    }
    const wpNum = clickedWaypointData.length + 1;
    const labelText = wpNum === 1
      ? `${currentRouteLetter}${wpNum}`
      : `${currentRouteLetter}${wpNum} (${Math.round(totalDist)}m +${Math.round(dPlus)} -${Math.round(Math.abs(dMinus))})`;

    const entity = viewer.entities.add({
      position: elevatedPosition,
      point: {
        pixelSize: 10,
        color: Cesium.Color.RED,
        outlineColor: Cesium.Color.WHITE,
        outlineWidth: 2,
      },
      label: {
        text: labelText,
        font: "12px sans-serif",
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        outlineWidth: 2,
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        pixelOffset: new Cesium.Cartesian2(0, -15),
      },
      polyline: {
        positions: Cesium.Cartesian3.fromDegreesArrayHeights([
          lon, lat, carto.height + 50,
          lon, lat, carto.height - 500,
        ]),
        width: 1,
        material: Cesium.Color.WHITE,
      },
    });
    clickedEntities.push(entity);
    clickedWaypointData.push({ lat, lon, alt: carto.height });
  }
}, Cesium.ScreenSpaceEventType.LEFT_CLICK);

document.addEventListener("keydown", (event) => {
  if (event.key === "Delete" && clickedEntities.length > 0) {
    viewer.entities.remove(clickedEntities.pop());
    clickedGroundPositions.pop();
    clickedWaypointData.pop();
  } else if (event.key === "s" || event.key === "S") {
    if (clickedWaypointData.length === 0) return;
    fetch("/data/waypoints.json").then(r => r.json()).then((routes) => {
      if (routes.length >= 26) {
        console.warn("Maximum 26 routes (A-Z) reached, cannot save more");
        return;
      }
      const letter = String.fromCharCode(65 + routes.length);
      const route = clickedWaypointData.map((wp, i) => ({
        name: `${letter}${i + 1}`,
        lat: parseFloat(wp.lat.toFixed(6)),
        lon: parseFloat(wp.lon.toFixed(6)),
        alt: parseFloat(wp.alt.toFixed(6)),
      }));
      return fetch("/api/save-route", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(route),
      });
    }).then((res) => {
      if (!res || !res.ok) return;
      console.log("Route saved");
      // Clear clicked points
      for (const e of clickedEntities) viewer.entities.remove(e);
      clickedEntities.length = 0;
      clickedGroundPositions.length = 0;
      clickedWaypointData.length = 0;
      // Reload saved routes
      loadWaypoints();
    }).catch((e) => console.error("Save error:", e));
  } else if (event.key === "c" || event.key === "C") {
    const cartographic = Cesium.Cartographic.fromCartesian(viewer.camera.position);
    const cameraData = {
      lat: Cesium.Math.toDegrees(cartographic.latitude),
      lon: Cesium.Math.toDegrees(cartographic.longitude),
      height: cartographic.height,
      heading: Cesium.Math.toDegrees(viewer.camera.heading),
      pitch: Cesium.Math.toDegrees(viewer.camera.pitch),
      roll: Cesium.Math.toDegrees(viewer.camera.roll),
    };
    console.log("Camera view saved:", cameraData);
  }
});
