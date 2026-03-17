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

const { sets } = JSON.parse(fs.readFileSync("./cards.json", "utf8"));
const setMap   = new Map(sets.map(s => [s.id, s]));

// ── Pack generation ───────────────────────────────────────────────────────────

const PACK_COMMONS = 7, BOX_SIZE = 24;

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length-1; i > 0; i--) {
    const j = Math.floor(Math.random()*(i+1));
    [a[i],a[j]]=[a[j],a[i]];
  }
  return a;
}
function rnd(arr){ return arr[Math.floor(Math.random()*arr.length)]; }
function byR(cards,r){ return cards.filter(c=>c.rarity===r); }
function fb(a,b){ return a.length?a:b; }

function genPacks(set, count) {
  const commons=byR(set.cards,'Common'), rares=byR(set.cards,'Rare'),
        supers=byR(set.cards,'Super Rare'), ultras=byR(set.cards,'Ultra Rare'),
        secrets=byR(set.cards,'Secret Rare'), base=set.cards;
  const all=[]; let rem=count;
  while(rem>0){
    const bp=Math.min(rem,BOX_SIZE); rem-=bp; const ratio=bp/BOX_SIZE;
    const sc=Math.random()<ratio*.33?1:0, uc=Math.round(ratio), spc=Math.max(0,Math.round(ratio*3));
    const foils=[
      ...Array.from({length:sc},()=>rnd(fb(secrets,fb(ultras,fb(rares,base))))),
      ...Array.from({length:uc},()=>rnd(fb(ultras,fb(supers,fb(rares,base))))),
      ...Array.from({length:spc},()=>rnd(fb(supers,fb(ultras,fb(rares,base))))),
    ];
    while(foils.length<bp) foils.push(rares.length?rnd(rares):rnd(base));
    const sf=shuffle(foils).slice(0,bp);
    for(let p=0;p<bp;p++){
      const pack=[];
      for(let i=0;i<PACK_COMMONS;i++) pack.push(commons.length?rnd(commons):rnd(base));
      if(rares.length) pack.push(rnd(rares));
      pack.push(sf[p]);
      all.push(pack);
    }
  }
  return all;
}

// ── Lobby ─────────────────────────────────────────────────────────────────────
//
// ASYNC PASSING DRAFT — no player ever waits for others.
//
// Each player has a personal queue of packs (inbox).
// When a player picks from a pack, the remainder is pushed into the next
// player's inbox. Players work through their inbox independently.
// This mirrors real-life draft tables where you can pick as fast as you want
// and packs pile up in front of you if you're slow.
//
// Player {
//   id, name, ws, drafted[],
//   inbox: Card[][]   — packs waiting to be picked from, in order
//   totalPacks: number — how many packs this player will see total
// }

const lobbies = new Map();

function makeCode(n=6){
  const c="ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({length:n},()=>c[Math.floor(Math.random()*c.length)]).join('');
}
function makePlayer(id,name,ws){
  return {id,name,ws,drafted:[],inbox:[],totalPacks:0,pickedFrom:0};
}

function send(ws,msg){
  if(ws&&ws.readyState===WebSocket.OPEN) ws.send(JSON.stringify(msg));
}
function broadcast(lobby,msg){
  const raw=JSON.stringify(msg);
  for(const p of lobby.players.values())
    if(p.ws&&p.ws.readyState===WebSocket.OPEN) p.ws.send(raw);
}
function snap(lobby){
  return {
    type:'lobby_state', code:lobby.code, phase:lobby.phase, hostId:lobby.hostId,
    config:lobby.config,
    players:[...lobby.players.values()].map(p=>({
      id:p.id, name:p.name, drafted:p.drafted.length,
      packsLeft:p.inbox.length,
      online:p.ws&&p.ws.readyState===WebSocket.OPEN,
    })),
  };
}

// ── Draft logic ───────────────────────────────────────────────────────────────

function startDraft(lobby){
  const players=[...lobby.players.values()];
  const N=players.length;

  // Build full pack pool and deal round-robin into player inboxes
  const pool=shuffle(lobby.packPool);
  players.forEach(p=>{ p.inbox=[]; p.drafted=[]; p.pickedFrom=0; });
  pool.forEach((pack,i)=> players[i%N].inbox.push([...pack]));

  // totalPacks = how many packs each player will eventually see
  // Each pack travels all the way around the table (N players pick from it)
  // but each player's inbox starts with pool.length/N packs and grows as
  // picked packs arrive. totalPacks = cards per pack (since you pick 1 per pack visit)
  // For display we track packs opened
  const perPlayer = Math.ceil(pool.length / N);
  players.forEach(p=>{ p.totalPacks = perPlayer * (pool.length > 0 ? 1 : 0); });

  lobby.phase='drafting';
  lobby.seatOrder=players.map(p=>p.id);
  lobby.N=N;

  broadcast(lobby, snap(lobby));

  // Send each player their first pack
  for(const p of players) deliverNext(lobby, p);
}

function playerIdx(lobby, playerId){
  return lobby.seatOrder.indexOf(playerId);
}

// Send the next pack in a player's inbox if they have one and aren't currently holding one
function deliverNext(lobby, player){
  if(player.currentPack) return; // already has a pack open
  if(player.inbox.length===0){
    // No more packs — this player is done
    send(player.ws,{type:'draft_done', drafted:player.drafted});
    checkAllDone(lobby);
    return;
  }
  player.currentPack=[...player.inbox.shift()];
  player.pickedFrom++;
  send(player.ws,{
    type:'pack',
    pack:player.currentPack,
    packNum:player.pickedFrom,
    cardsLeft:player.currentPack.length,
  });
}

function checkAllDone(lobby){
  const allDone=[...lobby.players.values()].every(p=>!p.currentPack&&p.inbox.length===0);
  if(allDone){
    lobby.phase='done';
    broadcast(lobby,snap(lobby));
  }
}

// After a player picks, pass the remainder to the next seat
function passPackLeft(lobby, fromPlayerId, remainingPack){
  if(remainingPack.length===0) return; // pack exhausted, nothing to pass
  const N=lobby.N;
  const idx=playerIdx(lobby,fromPlayerId);
  const nextIdx=(idx+1)%N;
  const nextId=lobby.seatOrder[nextIdx];
  const nextPlayer=lobby.players.get(nextId);
  if(!nextPlayer) return;
  nextPlayer.inbox.push([...remainingPack]);
  // If the next player has no current pack, deliver immediately
  if(!nextPlayer.currentPack) deliverNext(lobby, nextPlayer);
}

// ── WebSocket handler ─────────────────────────────────────────────────────────

wss.on('connection', ws=>{
  let playerId=null, lobbyCode=null;

  ws.on('message', raw=>{
    let msg; try{msg=JSON.parse(raw);}catch{return;}

    if(msg.type==='create_lobby'){
      playerId=makeCode(8);
      const code=makeCode(); lobbyCode=code;
      const lobby={
        code,hostId:playerId,phase:'waiting',
        config:[],packPool:[],
        players:new Map(),seatOrder:[],N:0,
      };
      lobby.players.set(playerId,makePlayer(playerId,(msg.name||'Host').trim().slice(0,24),ws));
      lobbies.set(code,lobby);
      send(ws,{type:'created',code,playerId,isHost:true});
      broadcast(lobby,snap(lobby));
      return;
    }

    if(msg.type==='join_lobby'){
      const code=(msg.code||'').toUpperCase().trim();
      const lobby=lobbies.get(code);
      if(!lobby) return send(ws,{type:'error',msg:'Lobby not found.'});
      if(lobby.phase!=='waiting') return send(ws,{type:'error',msg:'Draft already started.'});
      playerId=makeCode(8); lobbyCode=code;
      lobby.players.set(playerId,makePlayer(playerId,(msg.name||'Player').trim().slice(0,24),ws));
      send(ws,{type:'joined',code,playerId,isHost:false});
      broadcast(lobby,snap(lobby));
      return;
    }

    const lobby=lobbies.get(lobbyCode);
    const player=lobby?.players.get(playerId);
    if(!lobby||!player) return;

    if(msg.type==='set_config'){
      if(playerId!==lobby.hostId) return;
      lobby.config=Array.isArray(msg.config)?msg.config:[];
      broadcast(lobby,snap(lobby));
      return;
    }

    if(msg.type==='start_draft'){
      if(playerId!==lobby.hostId) return;
      if(!lobby.config.length) return send(ws,{type:'error',msg:'Add at least one set first.'});
      lobby.packPool=[];
      for(const {set:setId,packs} of lobby.config){
        const set=setMap.get(setId);
        if(!set) return send(ws,{type:'error',msg:`Unknown set: ${setId}`});
        lobby.packPool.push(...genPacks(set,packs));
      }
      startDraft(lobby);
      return;
    }

    if(msg.type==='pick'){
      if(lobby.phase!=='drafting'||!player.currentPack) return;
      const card=msg.card;
      if(!card?.name) return;
      // Verify card is in current pack
      const idx=player.currentPack.findIndex(c=>c.name===card.name&&c.rarity===card.rarity);
      if(idx===-1) return;
      player.drafted.push(card);
      player.currentPack.splice(idx,1);
      const remainder=[...player.currentPack];
      player.currentPack=null; // pack is no longer in hand
      broadcast(lobby,snap(lobby));
      // Pass remainder to next player
      passPackLeft(lobby,playerId,remainder);
      // Give this player their next pack from inbox
      deliverNext(lobby,player);
      return;
    }
  });

  ws.on('close',()=>{
    const lobby=lobbies.get(lobbyCode);
    if(!lobby) return;
    broadcast(lobby,snap(lobby));
  });
});

app.get('/api/sets',(_,res)=>res.json(sets.map(s=>({id:s.id,name:s.name||s.id}))));
server.listen(PORT,()=>console.log(`YGO Draft → http://localhost:${PORT}`));
