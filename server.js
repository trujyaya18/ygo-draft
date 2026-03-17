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
// TRUE passing booster draft:
//   - Players sit in a circle. Seat 0, 1, 2, ...
//   - Each round: every player picks 1 card from the pack at their seat.
//   - Then all packs rotate one seat to the left.
//   - When all packs in the current batch are empty, everyone opens the next pack.
//   - Draft ends when all packs are exhausted.
//
// Server drives the round:
//   - Sends each player their current pack via { type:"pack" }
//   - Waits for every player to send { type:"pick" }
//   - Once all picks are in, rotates packs and sends the next round
//
// Lobby {
//   code, hostId, phase, config
//   players: Map<id, Player>
//   seats: Card[][]          — seat[i] is the live pack at player i's seat
//   packStacks: Card[][][]   — packStacks[i] is player i's remaining unopened packs
//   packNum: number
//   totalPacks: number
//   seatOrder: string[]      — player ids in seat order
// }
//
// Player { id, name, ws, drafted[], pickedThisRound: bool }

const lobbies = new Map();

function makeCode(len = 6) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length: len }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}

function makePlayer(id, name, ws) {
  return { id, name, ws, drafted: [], pickedThisRound: false };
}

// ── WebSocket helpers ─────────────────────────────────────────────────────────

function send(ws, msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function lobbySnapshot(lobby) {
  const players = [...lobby.players.values()].map(p => ({
    id: p.id,
    name: p.name,
    drafted: p.drafted.length,
    packsLeft: lobby.packStacks
      ? (lobby.packStacks[lobby.seatOrder?.indexOf(p.id)] || []).length
      : 0,
    online: p.ws && p.ws.readyState === WebSocket.OPEN,
  }));
  return {
    type: "lobby_state",
    code: lobby.code,
    phase: lobby.phase,
    hostId: lobby.hostId,
    config: lobby.config,
    players,
  };
}

function broadcast(lobby, msg) {
  const raw = JSON.stringify(msg);
  for (const p of lobby.players.values())
    if (p.ws && p.ws.readyState === WebSocket.OPEN) p.ws.send(raw);
}

// ── Draft engine ──────────────────────────────────────────────────────────────

function removeCard(pack, card) {
  const idx = pack.findIndex(c => c.name === card.name && c.rarity === card.rarity);
  if (idx !== -1) pack.splice(idx, 1);
}

function startDraft(lobby) {
  const playerList = [...lobby.players.values()];
  const N = playerList.length;

  // Deal packs round-robin into each player's stack
  lobby.seatOrder  = playerList.map(p => p.id);
  lobby.packStacks = Array.from({ length: N }, () => []);
  shuffle(lobby.packPool).forEach((pack, i) => {
    lobby.packStacks[i % N].push([...pack]);
  });

  lobby.totalPacks = Math.max(...lobby.packStacks.map(s => s.length));
  lobby.packNum    = 0;
  lobby.seats      = Array(N).fill(null).map(() => []);

  openNextPacks(lobby);
}

function openNextPacks(lobby) {
  const N = lobby.seatOrder.length;
  const anyLeft = lobby.packStacks.some(s => s.length > 0);

  if (!anyLeft) {
    // Draft complete
    lobby.phase = "done";
    broadcast(lobby, lobbySnapshot(lobby));
    for (const p of lobby.players.values()) {
      send(p.ws, { type: "draft_done", drafted: p.drafted });
    }
    return;
  }

  lobby.packNum++;
  for (let i = 0; i < N; i++) {
    lobby.seats[i] = lobby.packStacks[i].length > 0
      ? [...lobby.packStacks[i].shift()]
      : [];
  }

  sendPacksToPlayers(lobby);
}

function sendPacksToPlayers(lobby) {
  // Reset pick flags
  for (const p of lobby.players.values()) p.pickedThisRound = false;

  const N = lobby.seatOrder.length;

  // Check if any seat has cards — if not, rotate and open next
  const anyCards = lobby.seats.some(s => s.length > 0);
  if (!anyCards) {
    openNextPacks(lobby);
    return;
  }

  broadcast(lobby, lobbySnapshot(lobby));

  // Send each player their current pack
  for (let i = 0; i < N; i++) {
    const playerId = lobby.seatOrder[i];
    const player   = lobby.players.get(playerId);
    const pack     = lobby.seats[i];

    if (!player) continue;

    if (pack.length === 0) {
      // This player has nothing to pick this round — mark as auto-picked
      player.pickedThisRound = true;
      send(player.ws, { type: "waiting_for_others" });
    } else {
      send(player.ws, {
        type: "pack",
        pack,
        packNum: lobby.packNum,
        totalPacks: lobby.totalPacks,
        cardsLeft: pack.length,
      });
    }
  }

  // If everyone was auto-skipped (all empty), advance
  checkRoundComplete(lobby);
}

function checkRoundComplete(lobby) {
  const allPicked = [...lobby.players.values()].every(p => p.pickedThisRound);
  if (!allPicked) return;

  // Rotate packs left: seat[i] gets what was at seat[(i-1+N)%N]
  const N    = lobby.seatOrder.length;
  const tmp  = lobby.seats.map(s => [...s]);
  for (let i = 0; i < N; i++) {
    lobby.seats[i] = tmp[(i - 1 + N + N) % N];
  }

  sendPacksToPlayers(lobby);
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
      playerId  = makeCode(8);
      const code = makeCode();
      lobbyCode  = code;
      const lobby = {
        code, hostId: playerId, phase: "waiting",
        config: [], packPool: [],
        players: new Map(),
        seats: [], packStacks: [], seatOrder: [],
        packNum: 0, totalPacks: 0,
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
      if (!lobby)                    return send(ws, { type: "error", msg: "Lobby not found." });
      if (lobby.phase !== "waiting") return send(ws, { type: "error", msg: "Draft already started." });
      playerId  = makeCode(8);
      lobbyCode = code;
      lobby.players.set(playerId, makePlayer(playerId, (msg.name || "Player").trim().slice(0, 24), ws));
      send(ws, { type: "joined", code, playerId, isHost: false });
      broadcast(lobby, lobbySnapshot(lobby));
      return;
    }

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
      startDraft(lobby);
      return;
    }

    // ── PICK ─────────────────────────────────────────────────────
    if (msg.type === "pick") {
      if (lobby.phase !== "drafting") return;
      if (player.pickedThisRound)     return; // ignore duplicate picks
      const card = msg.card;
      if (!card?.name) return;

      const seatIdx = lobby.seatOrder.indexOf(playerId);
      const pack    = lobby.seats[seatIdx];
      if (!pack || pack.length === 0) return;

      // Verify the card is actually in the pack
      const cardIdx = pack.findIndex(c => c.name === card.name && c.rarity === card.rarity);
      if (cardIdx === -1) return;

      player.drafted.push(card);
      pack.splice(cardIdx, 1);
      player.pickedThisRound = true;

      broadcast(lobby, lobbySnapshot(lobby));
      checkRoundComplete(lobby);
      return;
    }
  });

  ws.on("close", () => {
    const lobby = lobbies.get(lobbyCode);
    if (!lobby) return;
    broadcast(lobby, lobbySnapshot(lobby));

    // If it's the host and draft hasn't started, clean up after a delay
    if (playerId === lobby.hostId && lobby.phase === "waiting") {
      setTimeout(() => {
        if (lobbies.get(lobbyCode) === lobby) lobbies.delete(lobbyCode);
      }, 30000);
    }
  });
});

// ── REST ──────────────────────────────────────────────────────────────────────

app.get("/api/sets", (_req, res) =>
  res.json(sets.map(s => ({ id: s.id, name: s.name || s.id })))
);

server.listen(PORT, () => console.log(`YGO Draft → http://localhost:${PORT}`));
