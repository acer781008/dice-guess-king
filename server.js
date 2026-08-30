const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true, credentials: true } });
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '1234';

app.use(express.static('public', { etag: false, maxAge: 0 }));
app.get('/health', (_req,res)=>res.json({ok:true,time:new Date().toISOString()}));

const rooms = new Map();

function roomId() {
  let id;
  do id = String(Math.floor(100000 + Math.random()*900000)); while (rooms.has(id));
  return id;
}
function token(){ return crypto.randomBytes(18).toString('hex'); }
function defaults(id, adminToken){
  return {
    id, adminToken,
    settings: { mode:'猜總點數', diceCount:3, totalRounds:10, startAt:'', preSeconds:10, answerSeconds:10, betweenSeconds:5, numberPoint:10, note:'' },
    status:'waiting', phase:'等待開始', round:0, remaining:0, paused:false, dice:[], result:'', players:new Map(), createdAt:Date.now(), phaseDeadline:null
  };
}
function publicState(r){
  const players=[...r.players.values()].map(p=>({name:p.name,score:p.score,answered:p.answered,lastGain:p.lastGain,online:p.online}));
  return { room:r.id, settings:r.settings, status:r.status, phase:r.phase, round:r.round, remaining:r.remaining, paused:r.paused, dice:r.dice, result:r.result, players };
}
function adminState(r){ return publicState(r); }
function emitRoom(r){ io.to(`room:${r.id}`).emit('room:state', publicState(r)); io.to(`admin:${r.id}`).emit('admin:state', adminState(r)); }
function getAdminRoom(socket, payload={}){
  const id=payload.room || socket.data.adminRoom;
  const r=rooms.get(String(id||''));
  if(!r) return null;
  const t=payload.adminToken || socket.data.adminToken;
  if(t!==r.adminToken) return null;
  return r;
}
function sanitizeSettings(s){
  const modes=['猜總點數','猜大小','猜單雙','猜號碼・不看順序','猜號碼・看順序'];
  return {
    mode:modes.includes(s.mode)?s.mode:'猜總點數',
    diceCount:Math.min(5,Math.max(1,Number(s.diceCount)||3)),
    totalRounds:[5,10,15,20].includes(Number(s.totalRounds))?Number(s.totalRounds):10,
    startAt:String(s.startAt||''),
    preSeconds:Math.min(60,Math.max(5,Number(s.preSeconds)||10)),
    answerSeconds:Math.min(15,Math.max(1,Number(s.answerSeconds)||10)),
    betweenSeconds:[3,5,10,15].includes(Number(s.betweenSeconds))?Number(s.betweenSeconds):5,
    numberPoint:Math.min(999,Math.max(1,Number(s.numberPoint)||10)),
    note:String(s.note||'').slice(0,120)
  };
}
function setPhase(r, phase, seconds){ r.phase=phase; r.remaining=seconds; r.phaseDeadline=Date.now()+seconds*1000; emitRoom(r); }
function beginPre(r){
  if(r.status!=='waiting') return;
  r.status='countdown'; r.round=0; r.dice=[]; r.result='';
  for(const p of r.players.values()){p.score=0;p.answer=null;p.answered=false;p.lastGain=0;}
  setPhase(r,'開賽倒數（仍可加入）',r.settings.preSeconds);
}
function startRound(r,n){
  if(n>r.settings.totalRounds) return endGame(r);
  r.status='playing'; r.round=n; r.dice=[]; r.result='';
  for(const p of r.players.values()){p.answer=null;p.answered=false;p.lastGain=0;}
  setPhase(r,'玩家作答中',r.settings.answerSeconds);
}
function roll(r){
  const dice=Array.from({length:r.settings.diceCount},()=>1+Math.floor(Math.random()*6));
  const sum=dice.reduce((a,b)=>a+b,0); let result='';
  if(r.settings.mode==='猜總點數') result=String(sum);
  else if(r.settings.mode==='猜大小') result=sum >= 4*r.settings.diceCount ? '大':'小';
  else if(r.settings.mode==='猜單雙') result=sum%2 ? '單':'雙';
  else result=dice.join(' ＞ ');
  return {dice,result};
}
function scoreRound(r){
  const {dice,result}=roll(r); r.dice=dice; r.result=result;
  for(const p of r.players.values()){
    let gain=0;
    if(r.settings.mode==='猜號碼・不看順序'){
      const pool=[...dice], a=Array.isArray(p.answer)?p.answer.map(Number):[];
      for(const x of a){ const j=pool.indexOf(x); if(j>=0){gain+=r.settings.numberPoint;pool.splice(j,1);} }
    } else if(r.settings.mode==='猜號碼・看順序'){
      const a=Array.isArray(p.answer)?p.answer.map(Number):[];
      for(let i=0;i<dice.length;i++) if(a[i]===dice[i]) gain+=r.settings.numberPoint;
    } else if(String(p.answer)===String(result)) gain=10;
    p.lastGain=gain; p.score+=gain;
  }
  setPhase(r,'公布答案',3);
}
function nextWait(r){ setPhase(r,'下一回合倒數',r.settings.betweenSeconds); }
function endGame(r){ r.status='ended'; r.phase='🏁 遊戲結束'; r.remaining=0; r.phaseDeadline=null; emitRoom(r); }

setInterval(()=>{
  const now=Date.now();
  for(const r of rooms.values()){
    if(r.status==='waiting' && r.settings.startAt){
      const t=new Date(r.settings.startAt).getTime(); if(Number.isFinite(t)&&now>=t) beginPre(r);
    }
    if(r.paused || !r.phaseDeadline) continue;
    const left=Math.max(0,Math.ceil((r.phaseDeadline-now)/1000));
    if(left!==r.remaining){r.remaining=left;emitRoom(r);}
    if(now<r.phaseDeadline) continue;
    r.phaseDeadline=null;
    if(r.phase==='開賽倒數（仍可加入）') startRound(r,1);
    else if(r.phase==='玩家作答中') scoreRound(r);
    else if(r.phase==='公布答案') nextWait(r);
    else if(r.phase==='下一回合倒數') startRound(r,r.round+1);
  }
},250);

io.on('connection', socket=>{
  socket.on('admin:login', ({password, room, adminToken}={}, cb=()=>{})=>{
    if(password!==ADMIN_PASSWORD) return cb({ok:false,error:'管理員密碼錯誤'});
    let r = room && adminToken ? rooms.get(String(room)) : null;
    if(!r || r.adminToken!==adminToken){ const id=roomId(); const at=token(); r=defaults(id,at); rooms.set(id,r); }
    socket.data.adminRoom=r.id; socket.data.adminToken=r.adminToken; socket.join(`room:${r.id}`);socket.join(`admin:${r.id}`);
    cb({ok:true,room:r.id,adminToken:r.adminToken,state:adminState(r)}); emitRoom(r);
  });
  socket.on('admin:new-room', (payload={},cb=()=>{})=>{
    const old=getAdminRoom(socket,payload); if(!old) return cb({ok:false,error:'主控驗證失敗'});
    const id=roomId(), at=token(), r=defaults(id,at); r.settings={...old.settings,startAt:''}; rooms.set(id,r);
    socket.leave(`room:${old.id}`);socket.leave(`admin:${old.id}`);socket.join(`room:${id}`);socket.join(`admin:${id}`);
    socket.data.adminRoom=id;socket.data.adminToken=at; cb({ok:true,room:id,adminToken:at,state:adminState(r)});emitRoom(r);
  });
  socket.on('admin:update-settings',(payload={},cb=()=>{})=>{
    const r=getAdminRoom(socket,payload);if(!r)return cb({ok:false,error:'主控驗證失敗'});if(r.status!=='waiting')return cb({ok:false,error:'遊戲進行中無法修改設定'});
    r.settings=sanitizeSettings(payload.settings||{});emitRoom(r);cb({ok:true});
  });
  socket.on('admin:start',(payload={},cb=()=>{})=>{const r=getAdminRoom(socket,payload);if(!r)return cb({ok:false,error:'主控驗證失敗'});if(r.status!=='waiting')return cb({ok:false,error:'遊戲已經開始'});beginPre(r);cb({ok:true});});
  socket.on('admin:pause',(payload={},cb=()=>{})=>{const r=getAdminRoom(socket,payload);if(!r)return cb({ok:false,error:'主控驗證失敗'});if(!['countdown','playing'].includes(r.status))return cb({ok:false,error:'目前沒有進行中的遊戲'});r.paused=!r.paused;if(!r.paused&&r.remaining>0)r.phaseDeadline=Date.now()+r.remaining*1000;else if(r.paused)r.phaseDeadline=null;emitRoom(r);cb({ok:true,paused:r.paused});});
  socket.on('admin:end',(payload={},cb=()=>{})=>{const r=getAdminRoom(socket,payload);if(!r)return cb({ok:false,error:'主控驗證失敗'});endGame(r);cb({ok:true});});
  socket.on('player:peek',({room}={},cb=()=>{})=>{const r=rooms.get(String(room||''));if(!r)return cb({ok:false,error:'找不到遊戲房間'});cb({ok:true,state:publicState(r)});});
  socket.on('player:join',({room,name,playerToken}={},cb=()=>{})=>{
    const r=rooms.get(String(room||''));if(!r)return cb({ok:false,error:'找不到遊戲房間'});
    if(r.status==='playing'||r.status==='ended')return cb({ok:false,error:'🔒 本場遊戲已開始或已結束，已停止加入玩家。'});
    name=String(name||'').trim().slice(0,16);if(!name)return cb({ok:false,error:'請輸入遊戲名稱'});
    let p=null;
    if(playerToken){p=[...r.players.values()].find(x=>x.token===playerToken);}
    if(p){p.online=true;p.socketId=socket.id;name=p.name;}
    else {if([...r.players.values()].some(x=>x.name===name))return cb({ok:false,error:'此遊戲名已有人使用'});p={token:token(),name,score:0,answer:null,answered:false,lastGain:0,online:true,socketId:socket.id};r.players.set(p.token,p);}
    socket.data.playerRoom=r.id;socket.data.playerToken=p.token;socket.join(`room:${r.id}`);cb({ok:true,playerToken:p.token,name:p.name,state:publicState(r)});emitRoom(r);
  });
  socket.on('player:submit',({room,playerToken,answer}={},cb=()=>{})=>{
    const r=rooms.get(String(room||''));if(!r)return cb({ok:false,error:'找不到遊戲房間'});const p=r.players.get(playerToken);if(!p)return cb({ok:false,error:'玩家身分失效'});
    if(r.status!=='playing'||r.phase!=='玩家作答中')return cb({ok:false,error:'目前不是作答時間'});if(p.answered)return cb({ok:false,error:'本回合已提交答案'});
    if(r.settings.mode.startsWith('猜號碼')){if(!Array.isArray(answer)||answer.length!==r.settings.diceCount||answer.some(v=>Number(v)<1||Number(v)>6))return cb({ok:false,error:'答案格式錯誤'});p.answer=answer.map(Number);}else p.answer=String(answer);
    p.answered=true;emitRoom(r);cb({ok:true});
  });
  socket.on('disconnect',()=>{const r=rooms.get(String(socket.data.playerRoom||''));if(r&&socket.data.playerToken&&r.players.has(socket.data.playerToken)){r.players.get(socket.data.playerToken).online=false;emitRoom(r);}});
});

server.listen(PORT,()=>console.log(`Dice Guess King online server running on port ${PORT}`));
