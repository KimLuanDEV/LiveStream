// server.js (Twilio ICE dynamic)
import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import { v4 as uuidv4 } from "uuid";
import twilio from "twilio";

const app = express();
app.use(express.static("public"));
const server = http.createServer(app);

// Render/proxy friendly timeouts
server.keepAliveTimeout = 65000;
server.headersTimeout   = 66000;

// ===== /ice endpoint (Twilio Network Traversal) =====
app.get("/ice", async (req, res) => {
  try {
    const client = twilio(
      process.env.TWILIO_API_KEY_SID,
      process.env.TWILIO_API_KEY_SECRET,
      { accountSid: process.env.TWILIO_ACCOUNT_SID }
    );
    const token = await client.tokens.create();
    res.json({ iceServers: token.iceServers });
  } catch (e) {
    console.error("Twilio /ice error:", e.message);
    res.status(500).json({ error: "Cannot fetch ICE servers" });
  }
});

const wss = new WebSocketServer({ server });

let broadcaster = null;           // socket of broadcaster
const viewers = new Map();        // viewerId -> socket

function send(ws, msg) {
  try {
    if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  } catch {}
}

// Heartbeat keep-alive
function heartbeat() { this.isAlive = true; }
wss.on("connection", (ws) => {
  ws.id = uuidv4();
  ws.isAlive = true;
  ws.on("pong", heartbeat);

  ws.on("message", (raw) => {
    let msg = {};
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === "broadcaster-ready") {
      broadcaster = ws;
      send(ws, { type: "ack", role: "broadcaster" });
      return;
    }

    if (msg.type === "viewer-join") {
      const viewerId = uuidv4();
      viewers.set(viewerId, ws);
      ws.viewerId = viewerId;
      send(ws, { type: "ack", role: "viewer", viewerId });
      if (broadcaster) send(broadcaster, { type: "viewer-join", viewerId });
      return;
    }

    if (msg.type === "offer" && msg.viewerId) {
      const v = viewers.get(msg.viewerId);
      if (v) send(v, { type: "offer", sdp: msg.sdp, viewerId: msg.viewerId });
      return;
    }

    if (msg.type === "answer" && msg.viewerId) {
      if (broadcaster) send(broadcaster, { type: "answer", sdp: msg.sdp, viewerId: msg.viewerId });
      return;
    }

    if (msg.type === "ice-candidate" && msg.viewerId) {
      if (msg.from === "broadcaster") {
        const v = viewers.get(msg.viewerId);
        if (v) send(v, { type: "ice-candidate", candidate: msg.candidate, viewerId: msg.viewerId });
      } else if (msg.from === "viewer") {
        if (broadcaster) send(broadcaster, { type: "ice-candidate", candidate: msg.candidate, viewerId: msg.viewerId });
      }
      return;
    }
  });

  ws.on("close", () => {
    if (ws === broadcaster) {
      broadcaster = null;
      for (const [, v] of viewers.entries()) send(v, { type: "end" });
    }
    if (ws.viewerId && viewers.has(ws.viewerId)) {
      viewers.delete(ws.viewerId);
      if (broadcaster) send(broadcaster, { type: "viewer-left", viewerId: ws.viewerId });
    }
  });
});

const interval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  });
}, 30000);
wss.on("close", () => clearInterval(interval));

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`listening on http://localhost:${PORT}`);
});
