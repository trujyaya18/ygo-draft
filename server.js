const express = require("express");
const http    = require("http");
const { WebSocketServer, WebSocket } = require("ws");
const fs      = require("fs");

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });
const PORT   = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static("public"));

// ── Card data ────────────────────────────────────────────────────────────────

const { sets } = JSON.parse(fs.readFileSync("./cards.json", "utf8"));
const setMap   = new Map(sets.map(s => [s.id, s]));

// ── Box / pack generation ────────────────────────────────────────────────────

const PACK_COMMONS = 7;
const BOX_SIZE     = 24;

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function pickRand(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function byRarity(cards, r) { return cards.filter(c => c.rarity === r); }
function fallback(a, b) { return a.length ? a : b; }

function generateBoxPacks(set, packCount) {
  const commons = byRarity(set.cards, "Common");
  const rares   = byRarity(set.cards, "Rare");
  const supers  = byRarity(set.cards, "Super Rare");
  const ultras  = byRarity(set.cards, "Ultra Rare");
  const secrets = byRarity(set.cards, "Secret Rare");

  const allPacks = [];
  let remaining  = packCount;

  while (remaining > 0) {
    const boxPacks = Math.min(remaining, BOX_SIZE);
    remaining -= boxPacks;
    const ratio = boxPacks / BOX_SIZE;

    const secretCount = Math.random() < ratio * 0.33 ? 1 : 0;
    const ultraCount  = Math.round(ratio * 1);
    const superCount  = Math.max(0, Math.round(ratio * 3));

    const foilSlots = [
      ...Array.from({ length: secretCount }, () => pickRand(fallback(secrets, fallback(ultras, rares)))),
      ...Array.from({ length: ultraCount  }, () => pickRand(fallback(ultras,  fallback(supers, rares)))),
      ...Array.from({ length: superCount  }, () => pickRand(fallback(supers,  fallback(ultras, rares)))),
    ];
    while (foilSlots.length < boxPacks)
      foilSlots.push(rares.length ? pickRand(rares) : pickRand(set.cards));

    const shuffledFoils = shuffle(foilSlots).slice(0, boxPacks);

    for (let p = 0; p < boxPacks; p++) {
      const pack = [];
      for (let i = 0; i < PACK_COMMONS; i++)
        pack.push(commons.length ? pickRand(commons) : pickRand(set.cards));
      if (rares.length) pack.push(pickRand(rares));
      pack.push(shuffledFoils[p]);
      allPacks.push(pack);
    }
  }
  return allPacks;
}

// ── Lobby state ──────────────────────────────────────────────────────────────
//
// Sealed/cube draft model: each player gets their own even slice of the
// combined box pool and independently opens + picks from their packs.
// Simple, works great for 1-N players on the same LAN or over a tunnel.
//
// lobbies: Map<code, Lobby>
//
// Lobby  { code, hostId, phase:"waiting"|"drafting"|"done", config, packPool, players }
// Player { id, name, ws, drafted[], myPacks[], myPackIdx, pendingPack }

const lobbies = new Map();

function makeCode(len = 6) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length: len }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}
function makePlayerId() { return makeCode(8); }

function makePlayer(id, name, ws) {
  return { id, name, ws, drafted: [], myPacks: [], myPackIdx: 0, pendingPack: null };
}

// ── WebSocket helpers ─────────────────────────────────────────────────────────

function send(ws, msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function lobbySnapshot(lobby) {
  return {
    type: "lobby_state",
    code: lobby.code,
    phase: lobby.phase,
    hostId: lobby.hostId,
    config: lobby.config,
    players: [...lobby.players.values()].map(p => ({
      id: p.id,
      name: p.name,
      drafted: p.drafted.length,
      packsLeft: Math.max(0, (p.myPacks.length || 0) - p.myPackIdx + (p.pendingPack ? 1 : 0)),
      online: p.ws && p.ws.readyState === WebSocket.OPEN,
    })),
  };
}

function broadcast(lobby, msg) {
  const raw = JSON.stringify(msg);
  for (const p of lobby.players.values())
    if (p.ws && p.ws.readyState === WebSocket.OPEN) p.ws.send(raw);
}

// ── Pack assignment & delivery ────────────────────────────────────────────────

function assignPacks(lobby) {
  const players   = [...lobby.players.values()];
  const pool      = shuffle(lobby.packPool);
  const perPlayer = Math.floor(pool.length / players.length);
  players.forEach((p, i) => {
    p.myPacks   = pool.slice(i * perPlayer, (i + 1) * perPlayer);
    p.myPackIdx = 0;
    p.pendingPack = null;
  });
}

function deliverNextPack(lobby, player) {
  if (player.myPackIdx >= player.myPacks.length) {
    player.pendingPack = null;
    send(player.ws, { type: "draft_done", drafted: player.drafted });
    const allDone = [...lobby.players.values()].every(
      p => !p.pendingPack && p.myPackIdx >= p.myPacks.length
    );
    if (allDone) {
      lobby.phase = "done";
      broadcast(lobby, lobbySnapshot(lobby));
    }
    return;
  }
  player.pendingPack = player.myPacks[player.myPackIdx++];
  send(player.ws, {
    type: "pack",
    pack: player.pendingPack,
    packNum: player.myPackIdx,
    totalPacks: player.myPacks.length,
  });
}

// ── WebSocket connection handler ──────────────────────────────────────────────

wss.on("connection", ws => {
  let playerId  = null;
  let lobbyCode = null;

  ws.on("message", raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // ── CREATE ───────────────────────────────────────────────────
    if (msg.type === "create_lobby") {
      playerId  = makePlayerId();
      const code = makeCode();
      lobbyCode  = code;
      const lobby = {
        code, hostId: playerId, phase: "waiting",
        config: [], packPool: [],
        players: new Map(),
      };
      lobby.players.set(playerId, makePlayer(playerId, (msg.name || "Host").trim().slice(0, 24), ws));
      lobbies.set(code, lobby);
      send(ws, { type: "created", code, playerId, isHost: true });
      broadcast(lobby, lobbySnapshot(lobby));
      return;
    }

    // ── JOIN ─────────────────────────────────────────────────────
    if (msg.type === "join_lobby") {
      const code  = (msg.code || "").toUpperCase().trim();
      const lobby = lobbies.get(code);
      if (!lobby)                  return send(ws, { type: "error", msg: "Lobby not found." });
      if (lobby.phase !== "waiting") return send(ws, { type: "error", msg: "Draft already started." });
      playerId  = makePlayerId();
      lobbyCode = code;
      lobby.players.set(playerId, makePlayer(playerId, (msg.name || "Player").trim().slice(0, 24), ws));
      send(ws, { type: "joined", code, playerId, isHost: false });
      broadcast(lobby, lobbySnapshot(lobby));
      return;
    }

    // Remaining messages require an active lobby + player
    const lobby  = lobbies.get(lobbyCode);
    const player = lobby?.players.get(playerId);
    if (!lobby || !player) return;

    // ── SET CONFIG (host) ────────────────────────────────────────
    if (msg.type === "set_config") {
      if (playerId !== lobby.hostId) return;
      lobby.config = Array.isArray(msg.config) ? msg.config : [];
      broadcast(lobby, lobbySnapshot(lobby));
      return;
    }

    // ── START DRAFT (host) ───────────────────────────────────────
    if (msg.type === "start_draft") {
      if (playerId !== lobby.hostId) return;
      if (!lobby.config.length) return send(ws, { type: "error", msg: "Add at least one set first." });

      lobby.packPool = [];
      for (const { set: setId, packs } of lobby.config) {
        const set = setMap.get(setId);
        if (!set) return send(ws, { type: "error", msg: `Unknown set: ${setId}` });
        if (!Number.isInteger(packs) || packs < 1)
          return send(ws, { type: "error", msg: `Invalid pack count for ${setId}` });
        lobby.packPool.push(...generateBoxPacks(set, packs));
      }

      lobby.phase = "drafting";
      assignPacks(lobby);
      broadcast(lobby, lobbySnapshot(lobby));
      for (const p of lobby.players.values()) deliverNextPack(lobby, p);
      return;
    }

    // ── PICK ─────────────────────────────────────────────────────
    if (msg.type === "pick") {
      if (lobby.phase !== "drafting" || !player.pendingPack) return;
      const card = msg.card;
      if (!card?.name) return;
      player.drafted.push(card);
      player.pendingPack = null;
      broadcast(lobby, lobbySnapshot(lobby));
      deliverNextPack(lobby, player);
      return;
    }
  });

  ws.on("close", () => {
    const lobby = lobbies.get(lobbyCode);
    if (!lobby) return;
    broadcast(lobby, lobbySnapshot(lobby)); // triggers online:false for this player
  });
});

// ── REST ──────────────────────────────────────────────────────────────────────

app.get("/api/sets", (_req, res) =>
  res.json(sets.map(s => ({ id: s.id, name: s.name || s.id })))
);

server.listen(PORT, () => console.log(`YGO Draft → http://localhost:${PORT}`));
