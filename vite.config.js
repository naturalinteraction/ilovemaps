import { defineConfig } from "vite";
import cesium from "vite-plugin-cesium";
import fs from "fs";
import path from "path";
import Anthropic from "@anthropic-ai/sdk";

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
];

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
                for (const tu of toolUses) commands.push({ name: tu.name, input: tu.input });
                messages.push({ role: "assistant", content: msg.content });
                messages.push({
                  role: "user",
                  content: toolUses.map(tu => ({
                    type: "tool_result",
                    tool_use_id: tu.id,
                    content: "ok",
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
  plugins: [cesium(), saveRoutePlugin(), claudePlugin()],
});
