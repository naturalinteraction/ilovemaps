import { defineConfig } from "vite";
import cesium from "vite-plugin-cesium";
import fs from "fs";
import path from "path";

function saveRoutePlugin() {
  return {
    name: "save-route",
    configureServer(server) {
      server.middlewares.use("/api/save-route", (req, res) => {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.end("Method not allowed");
          return;
        }
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          try {
            const newRoute = JSON.parse(body);
            const filePath = path.resolve("data/waypoints.json");
            const routes = JSON.parse(fs.readFileSync(filePath, "utf-8"));
            routes.push(newRoute);
            fs.writeFileSync(filePath, JSON.stringify(routes, null, 2) + "\n");
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ ok: true }));
          } catch (e) {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: e.message }));
          }
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [cesium(), saveRoutePlugin()],
});
