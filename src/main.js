import * as Cesium from "cesium";
import "cesium/Build/Cesium/Widgets/widgets.css";

// Token Cesium Ion (registrarsi su cesium.com/ion per ottenerne uno)
// Il globo funziona anche senza token, ma senza terrain 3D
// Cesium.Ion.defaultAccessToken = "IL_TUO_TOKEN";

const viewer = new Cesium.Viewer("cesiumContainer", {
  terrain: undefined,
});

async function loadWaypoints() {
  const response = await fetch("/data/waypoints.json");
  const waypoints = await response.json();

  const positions = [];

  for (const wp of waypoints) {
    const position = Cesium.Cartesian3.fromDegrees(wp.lon, wp.lat, wp.alt);
    positions.push(position);

    viewer.entities.add({
      name: wp.name,
      position,
      point: {
        pixelSize: 10,
        color: Cesium.Color.RED,
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
    });
  }

  viewer.entities.add({
    polyline: {
      positions,
      width: 3,
      material: Cesium.Color.CYAN,
      clampToGround: true,
    },
  });

  viewer.zoomTo(viewer.entities);
}

loadWaypoints();
