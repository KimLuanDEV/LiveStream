// server.js
const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const { v4: uuidv4 } = require("uuid");

const app = express();
app.use(express.static("public"));
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

let broadcaster = null;           // socket của broadcaster
const viewers = new Map();        // viewerId -> socket

function send(ws, msg) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

wss.on("connection", (ws) => {
  ws.id = uuidv4();

  ws.on("message", (raw) => {
    let msg = {};
    try { msg = JSON.parse(raw); } catch { return; }

    // 1) Broadcaster báo “sẵn sàng”
    if (msg.type === "broadcaster-ready") {
      broadcaster = ws;
      send(ws, { type: "ack", role: "broadcaster" });
      return;
    }

    // 2) Viewer xin xem
    if (msg.type === "viewer-join") {
      const viewerId = uuidv4();
      viewers.set(viewerId, ws);
      ws.viewerId = viewerId;
      send(ws, { type: "ack", role: "viewer", viewerId });
      // Yêu cầu broadcaster tạo offer cho viewer này
      if (broadcaster) send(broadcaster, { type: "viewer-join", viewerId });
      return;
    }

    // 3) Relay SDP/candidate giữa broadcaster <-> viewer
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
    }
  });

  ws.on("close", () => {
    // nếu broadcaster thoát
    if (ws === broadcaster) {
      broadcaster = null;
      // báo tất cả viewer
      for (const [id, v] of viewers.entries()) {
        send(v, { type: "end" });
      }
    }
    // nếu viewer thoát
    if (ws.viewerId && viewers.has(ws.viewerId)) {
      viewers.delete(ws.viewerId);
      if (broadcaster) send(broadcaster, { type: "viewer-left", viewerId: ws.viewerId });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`http://localhost:${PORT}`);
});
