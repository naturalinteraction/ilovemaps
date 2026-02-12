import * as Cesium from "cesium";
import "cesium/Build/Cesium/Widgets/widgets.css";

// Token Cesium Ion (registrarsi su cesium.com/ion per ottenerne uno)
// Il globo funziona anche senza token, ma senza terrain 3D
// Per vedere il terrain 3D occorre anche selezionare Cesium 3D Terrain nell'interfaccia grafica
Cesium.Ion.defaultAccessToken = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJqdGkiOiI4NjI4NDI4Mi1jM2I2LTRiYzgtOTcwMy1mYWY1OTFjYmZiMzEiLCJpZCI6Mzg5OTAwLCJpYXQiOjE3NzA4ODE0ODd9.mPlDG2N5Kct-2CMb5olZ4eZeI5kzJOq3UNOOKPlCI-Y";

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
    });
  }

  viewer.entities.add({
    polyline: {
      positions,
      width: 3,
      material: Cesium.Color.WHITE,
      clampToGround: true,
    },
  });

  viewer.zoomTo(viewer.entities);
}

loadWaypoints();

const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
handler.setInputAction((click) => {
  const cartesian = viewer.scene.pickPosition(click.position);
  if (cartesian) {
    const carto = Cesium.Cartographic.fromCartesian(cartesian);
    const lat = Cesium.Math.toDegrees(carto.latitude);
    const lon = Cesium.Math.toDegrees(carto.longitude);
    console.log(`lat: ${lat.toFixed(6)}, lon: ${lon.toFixed(6)}`);

    viewer.entities.add({
      position: Cesium.Cartesian3.fromDegrees(lon, lat),
      point: {
        pixelSize: 10,
        color: Cesium.Color.RED,
        outlineColor: Cesium.Color.WHITE,
        outlineWidth: 2,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
      },
      label: {
        text: `${lat.toFixed(4)}, ${lon.toFixed(4)}`,
        font: "12px sans-serif",
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        outlineWidth: 2,
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        pixelOffset: new Cesium.Cartesian2(0, -15),
      },
    });
  }
}, Cesium.ScreenSpaceEventType.LEFT_CLICK);
