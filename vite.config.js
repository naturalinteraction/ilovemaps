import { defineConfig } from "vite";
import cesium from "vite-plugin-cesium";
import fs from "fs";
import path from "path";
import Anthropic from "@anthropic-ai/sdk";
import pg from "pg";

const pool = new pg.Pool({ database: "ilovemaps", host: "/var/run/postgresql" });

function settingsPlugin() {
  return {
    name: "settings",
    configureServer(server) {
      server.middlewares.use("/api/settings", (req, res) => {
        if (req.method === "GET") {
          pool.query("SELECT key, value FROM settings")
            .then(({ rows }) => {
              const obj = {};
              for (const row of rows) obj[row.key] = row.value;
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify(obj));
            })
            .catch((e) => {
              res.statusCode = 500;
              res.end(JSON.stringify({ error: e.message }));
            });
        } else if (req.method === "POST") {
          let body = "";
          req.on("data", (chunk) => (body += chunk));
          req.on("end", () => {
            try {
              const { key, value } = JSON.parse(body);
              pool.query("UPDATE settings SET value=$2 WHERE key=$1", [key, JSON.stringify(value)])
                .then(() => {
                  res.setHeader("Content-Type", "application/json");
                  res.end(JSON.stringify({ ok: true }));
                })
                .catch((e) => {
                  res.statusCode = 500;
                  res.end(JSON.stringify({ error: e.message }));
                });
            } catch (e) {
              res.statusCode = 400;
              res.end(JSON.stringify({ error: e.message }));
            }
          });
        } else {
          res.statusCode = 405;
          res.end("Method not allowed");
        }
      });
    },
  };
}

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

const MAP_TOOLS = [
  {
    name: "move_camera",
    description: "Fly the Cesium globe camera to a geographic location.",
    input_schema: {
      type: "object",
      properties: {
        lat:    { type: "number", description: "Latitude in degrees" },
        lon:    { type: "number", description: "Longitude in degrees" },
        height: { type: "number", description: "Camera height above ellipsoid in meters (e.g. 8000 for a city, 200000 for a country)" },
      },
      required: ["lat", "lon", "height"],
    },
  },
  {
    name: "get_entities",
    description: "Get all military units and saved routes currently on the map.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
];

function flattenUnits(node) {
  const { name, type, position } = node;
  const result = [{ name, type, lat: position.lat, lon: position.lon }];
  for (const child of node.children ?? []) result.push(...flattenUnits(child));
  return result;
}

function resolveToolResult(name) {
  if (name !== "get_entities") return "ok";
  const units = flattenUnits(JSON.parse(fs.readFileSync(path.resolve("data/military-units.json"), "utf-8")));
  const rawRoutes = JSON.parse(fs.readFileSync(path.resolve("data/waypoints.json"), "utf-8"));
  const routes = rawRoutes.map((wps) => {
    const letter = wps[0].name[0];
    const center = {
      lat: wps.reduce((s, w) => s + w.lat, 0) / wps.length,
      lon: wps.reduce((s, w) => s + w.lon, 0) / wps.length,
    };
    return { letter, center, waypoints: wps.map(({ name, lat, lon }) => ({ name, lat, lon })) };
  });
  return JSON.stringify({ units, routes });
}

function claudePlugin() {
  return {
    name: "claude-proxy",
    configureServer(server) {
      server.middlewares.use("/api/claude", (req, res) => {
        if (req.method !== "POST") { res.statusCode = 405; res.end(); return; }
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", async () => {
          try {
            const { prompt } = JSON.parse(body);
            const client = new Anthropic();
            const messages = [{ role: "user", content: prompt }];
            const commands = [];

            while (true) {
              const msg = await client.messages.create({
                model: "claude-haiku-4-5-20251001",
                max_tokens: 1024,
                tools: MAP_TOOLS,
                messages,
              });

              if (msg.stop_reason === "tool_use") {
                const toolUses = msg.content.filter(b => b.type === "tool_use");
                for (const tu of toolUses) {
                  if (tu.name !== "get_entities") commands.push({ name: tu.name, input: tu.input });
                }
                messages.push({ role: "assistant", content: msg.content });
                messages.push({
                  role: "user",
                  content: toolUses.map(tu => ({
                    type: "tool_result",
                    tool_use_id: tu.id,
                    content: resolveToolResult(tu.name),
                  })),
                });
              } else {
                const text = msg.content.find(b => b.type === "text")?.text ?? "";
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify({ text, commands }));
                break;
              }
            }
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
  plugins: [cesium(), settingsPlugin(), saveRoutePlugin(), claudePlugin()],
});
