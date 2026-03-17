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
  const a=[...arr];
  for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];}
  return a;
}
function rnd(arr){ return arr[Math.floor(Math.random()*arr.length)]; }
function byR(cards,r){ return cards.filter(c=>c.rarity===r); }
function fb(a,b){ return a.length?a:b; }
const RARITY_VAL={'Secret Rare':10,'Ultra Rare':8,'Super Rare':6,'Rare':4,'Common':1};

function genPacks(set,count){
  const commons=byR(set.cards,'Common'),rares=byR(set.cards,'Rare'),
        supers=byR(set.cards,'Super Rare'),ultras=byR(set.cards,'Ultra Rare'),
        secrets=byR(set.cards,'Secret Rare'),base=set.cards;
  const all=[];let rem=count;
  while(rem>0){
    const bp=Math.min(rem,BOX_SIZE);rem-=bp;const ratio=bp/BOX_SIZE;
    const sc=Math.random()<ratio*.33?1:0,uc=Math.round(ratio),spc=Math.max(0,Math.round(ratio*3));
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

// ── AI pick logic ─────────────────────────────────────────────────────────────
function aiPickCard(drafted, pack){
  let best=null,bestScore=-1;
  for(const card of pack){
    const copies=drafted.filter(c=>c.name===card.name).length;
    if(copies>=3) continue;
    const score=(RARITY_VAL[card.rarity]||1)+Math.random()*1.5;
    if(score>bestScore){bestScore=score;best=card;}
  }
  return best||pack[0];
}

// ── Lobby ─────────────────────────────────────────────────────────────────────
//
// ASYNC INBOX DRAFT
// Every player (human or AI) has:
//   inbox[]       — packs queued up waiting to be picked from
//   currentPack   — the pack currently open in front of them (null if none)
//   drafted[]     — cards they've picked
//
// When a player picks from currentPack:
//   1. Remove the card from currentPack
//   2. Set currentPack = null
//   3. Pass the remainder to the next seat's inbox
//   4. Pull the next pack from own inbox into currentPack (if any)
//
// draft_done is sent when: currentPack===null AND inbox is empty AND no more
// packs can arrive (all packs have been fully picked around the table).
// We track this by counting total cards in the system — when 0, everyone is done.

const lobbies = new Map();

function makeCode(n=6){
  const c="ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({length:n},()=>c[Math.floor(Math.random()*c.length)]).join('');
}

function makeHumanPlayer(id,name,ws){
  return {id,name,ws,isAI:false,drafted:[],inbox:[],currentPack:null,done:false};
}
function makeAIPlayer(id,name){
  return {id,name,ws:null,isAI:true,drafted:[],inbox:[],currentPack:null,done:false};
}

function send(ws,msg){
  if(ws&&ws.readyState===WebSocket.OPEN) ws.send(JSON.stringify(msg));
}
function broadcast(lobby,msg){
  const raw=JSON.stringify(msg);
  for(const p of lobby.players.values())
    if(!p.isAI&&p.ws&&p.ws.readyState===WebSocket.OPEN) p.ws.send(raw);
}
function snap(lobby){
  return {
    type:'lobby_state',code:lobby.code,phase:lobby.phase,hostId:lobby.hostId,
    config:lobby.config,aiCount:lobby.aiCount||0,
    players:[...lobby.players.values()].map(p=>({
      id:p.id,name:p.name,isAI:p.isAI,
      drafted:p.drafted.length,
      packsLeft:(p.inbox.length)+(p.currentPack?1:0),
      online:p.isAI?true:(p.ws&&p.ws.readyState===WebSocket.OPEN),
    })),
  };
}

// ── Draft engine ──────────────────────────────────────────────────────────────

function startDraft(lobby){
  const players=[...lobby.players.values()];
  const N=players.length;
  lobby.seatOrder=players.map(p=>p.id);
  lobby.N=N;

  // Reset all players
  for(const p of players){
    p.inbox=[];p.currentPack=null;p.drafted=[];p.done=false;
  }

  // Deal packs round-robin
  const pool=shuffle(lobby.packPool);
  pool.forEach((pack,i)=> players[i%N].inbox.push([...pack]));

  // Track total picks remaining so we know when everyone is truly done
  // Each pack has (cards per pack) picks total, shared among all N players
  lobby.totalCardsInSystem = pool.reduce((s,p)=>s+p.length,0);

  lobby.phase='drafting';
  broadcast(lobby,snap(lobby));

  // Kick off each player's first pack
  for(const p of players) advancePlayer(lobby,p);
}

function seatIndex(lobby,playerId){
  return lobby.seatOrder.indexOf(playerId);
}

// Give the player their next pack from inbox (if they don't have one open)
function advancePlayer(lobby,player){
  if(player.currentPack!==null) return; // already has a pack
  if(player.inbox.length===0){
    // Nothing to do right now — they'll get a pack when one is passed to them
    // Check if we should mark them done
    checkDone(lobby,player);
    return;
  }
  player.currentPack=[...player.inbox.shift()];
  if(player.isAI){
    // AI picks immediately
    processAIPick(lobby,player);
  } else {
    send(player.ws,{
      type:'pack',
      pack:player.currentPack,
      packNum:player.drafted.length+1,  // pick number for display
      cardsLeft:player.currentPack.length,
    });
  }
}

function processAIPick(lobby,player){
  if(!player.currentPack||player.currentPack.length===0) return;
  const pick=aiPickCard(player.drafted,player.currentPack);
  player.drafted.push(pick);
  lobby.totalCardsInSystem--;
  player.currentPack=player.currentPack.filter(c=>!(c.name===pick.name&&c.rarity===pick.rarity));
  const remainder=[...player.currentPack];
  player.currentPack=null;
  passToNext(lobby,player.id,remainder);
  advancePlayer(lobby,player);
}

function passToNext(lobby,fromId,remainder){
  if(remainder.length===0) return;
  const idx=seatIndex(lobby,fromId);
  const nextId=lobby.seatOrder[(idx+1)%lobby.N];
  const next=lobby.players.get(nextId);
  if(!next) return;
  next.inbox.push([...remainder]);
  // If they're not currently holding a pack, give them this one now
  if(next.currentPack===null) advancePlayer(lobby,next);
}

function checkDone(lobby,player){
  // A player is done when they have no currentPack, empty inbox,
  // AND there are no cards left in the system for them to receive
  // We approximate: if totalCardsInSystem===0, everyone is done
  if(lobby.totalCardsInSystem<=0){
    for(const p of lobby.players.values()) p.done=true;
    lobby.phase='done';
    broadcast(lobby,snap(lobby));
    // Send draft_done to all human players
    for(const p of lobby.players.values()){
      if(!p.isAI) send(p.ws,{type:'draft_done',drafted:p.drafted});
    }
  }
}

function humanPick(lobby,player,card){
  if(!player.currentPack) return;
  const idx=player.currentPack.findIndex(c=>c.name===card.name&&c.rarity===card.rarity);
  if(idx===-1) return;
  player.drafted.push(card);
  lobby.totalCardsInSystem--;
  player.currentPack.splice(idx,1);
  const remainder=[...player.currentPack];
  player.currentPack=null;
  broadcast(lobby,snap(lobby));
  passToNext(lobby,player.id,remainder);
  advancePlayer(lobby,player);
  if(lobby.totalCardsInSystem<=0) checkDone(lobby,player);
}

// ── WebSocket handler ─────────────────────────────────────────────────────────

wss.on('connection',ws=>{
  let playerId=null,lobbyCode=null;

  ws.on('message',raw=>{
    let msg;try{msg=JSON.parse(raw);}catch{return;}

    if(msg.type==='create_lobby'){
      playerId=makeCode(8);
      const code=makeCode();lobbyCode=code;
      const lobby={
        code,hostId:playerId,phase:'waiting',
        config:[],packPool:[],aiCount:0,
        players:new Map(),seatOrder:[],N:0,totalCardsInSystem:0,
      };
      lobby.players.set(playerId,makeHumanPlayer(playerId,(msg.name||'Host').trim().slice(0,24),ws));
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
      playerId=makeCode(8);lobbyCode=code;
      lobby.players.set(playerId,makeHumanPlayer(playerId,(msg.name||'Player').trim().slice(0,24),ws));
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
      // Add/remove AI players to match requested count
      const aiCount=Math.max(0,Math.min(7,parseInt(msg.aiCount)||0));
      lobby.aiCount=aiCount;
      // Remove old AI players
      for(const [id,p] of lobby.players) if(p.isAI) lobby.players.delete(id);
      // Add new AI players
      for(let i=0;i<aiCount;i++){
        const aiId='AI_'+makeCode(4);
        lobby.players.set(aiId,makeAIPlayer(aiId,`AI ${i+1}`));
      }
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
      if(lobby.phase!=='drafting') return;
      if(!player.currentPack) return;
      humanPick(lobby,player,msg.card);
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
