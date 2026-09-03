const express=require('express');
const http=require('http');
const {Server}=require('socket.io');
const path=require('path');
const app=express(); const server=http.createServer(app);
const io=new Server(server,{pingTimeout:20000,pingInterval:25000,transports:['websocket','polling']});
app.use(express.json()); app.use(express.static(path.join(__dirname,'public')));

const ADMIN_PASSWORD=process.env.ADMIN_PASSWORD || '1234';
const rooms=new Map();
const modes=['sum','multiply','memory','size','parity','multiple'];
const now=()=>Date.now();
function roomCode(){let c; do{c=String(Math.floor(100000+Math.random()*900000));}while(rooms.has(c)); return c;}
function defaults(code){return {code,createdAt:now(),settings:{title:'數字大亂鬥',note:'',scheduledAt:'',boardSize:6,mode:'mixed',roundMode:'auto',roundSeconds:45,totalRounds:10,startCountdown:5,gameMinutes:10,finishType:'rounds',finishValue:10,teamMode:false,teamAssign:'auto',playerLimit:10,streak:true,allowJoinDuringGame:true},state:{phase:'waiting',round:0,currentMode:'sum',roundEndsAt:null,gameEndsAt:null,startedAt:null},players:{},scores:{},history:[],teams:{red:0,blue:0}}}
function publicRoom(r){return {code:r.code,settings:r.settings,state:r.state,scores:r.scores,history:r.history,teams:r.teams,playersList:Object.values(r.scores).map(x=>({playerId:x.playerId,name:x.name,team:x.team,online:x.online}))};}
function persistLeaderboard(r){
  r.history = Object.values(r.scores).sort((a,b)=>b.score-a.score||a.joinedAt-b.joinedAt).map((x,i)=>({...x,rank:i+1}));
}
function chooseMode(r){ if(r.settings.mode!=='mixed') return r.settings.mode; return modes[Math.floor(Math.random()*modes.length)]; }
function startRound(r){
  r.state.round += 1; r.state.currentMode=chooseMode(r); r.state.phase='playing';
  r.state.roundEndsAt = r.settings.roundMode==='auto' ? now()+Number(r.settings.roundSeconds||45)*1000 : null;
  io.to(r.code).emit('round:start',{state:r.state,settings:r.settings});
  if(r.settings.roundMode==='auto') setTimeout(()=>{ const rr=rooms.get(r.code); if(!rr||rr.state.phase!=='playing')return; if(rr.state.round!==r.state.round)return; endOrNext(rr); }, Number(r.settings.roundSeconds||45)*1000+100);
}
function finishGame(r){r.state.phase='finished';r.state.roundEndsAt=null;persistLeaderboard(r);io.to(r.code).emit('game:finished',publicRoom(r));}
function endOrNext(r){
  const maxRounds=Number(r.settings.totalRounds||10);
  if(r.settings.finishType==='rounds' && r.state.round>=maxRounds) return finishGame(r);
  if(r.state.gameEndsAt && now()>=r.state.gameEndsAt) return finishGame(r);
  startRound(r);
}
setInterval(()=>{ for(const r of rooms.values()){ if(r.state.phase==='playing'&&r.state.gameEndsAt&&now()>=r.state.gameEndsAt) finishGame(r); }},1000);

app.post('/api/admin/login',(req,res)=>res.json({ok:String(req.body.password||'')===ADMIN_PASSWORD}));
app.post('/api/rooms',(req,res)=>{if(String(req.body.password||'')!==ADMIN_PASSWORD)return res.status(401).json({ok:false}); const code=roomCode(); const r=defaults(code); rooms.set(code,r); res.json({ok:true,room:publicRoom(r)});});
app.get('/api/rooms/:code',(req,res)=>{const r=rooms.get(req.params.code); if(!r)return res.status(404).json({ok:false}); res.json({ok:true,room:publicRoom(r)});});
app.put('/api/rooms/:code',(req,res)=>{if(String(req.body.password||'')!==ADMIN_PASSWORD)return res.status(401).json({ok:false}); const r=rooms.get(req.params.code); if(!r)return res.status(404).json({ok:false}); r.settings={...r.settings,...req.body.settings,title:'數字大亂鬥'}; io.to(r.code).emit('room:update',publicRoom(r)); res.json({ok:true,room:publicRoom(r)});});
app.delete('/api/rooms/:code',(req,res)=>{if(String(req.body.password||'')!==ADMIN_PASSWORD)return res.status(401).json({ok:false}); const r=rooms.get(req.params.code); if(!r)return res.status(404).json({ok:false}); rooms.delete(req.params.code); io.to(req.params.code).emit('room:deleted'); res.json({ok:true});});

io.on('connection',socket=>{
  socket.on('room:join',({code,name,playerId,team})=>{
    const r=rooms.get(String(code||'')); if(!r)return socket.emit('join:error','找不到房間');
    if(r.state.phase==='playing'&&!r.settings.allowJoinDuringGame)return socket.emit('join:error','遊戲進行中，暫停加入');
    if(r.settings.teamMode&&r.settings.teamAssign==='self'&&!r.scores[playerId]){const limit=Math.max(2,Number(r.settings.playerLimit||10)), cap=Math.floor(limit/2);const vals=Object.values(r.scores);if(vals.length>=limit)return socket.emit('join:error','房間人數已滿');if(team==='red'&&vals.filter(x=>x.team==='red').length>=cap)return socket.emit('join:error','🔴 紅隊已滿，請選藍隊');if(team==='blue'&&vals.filter(x=>x.team==='blue').length>=cap)return socket.emit('join:error','🔵 藍隊已滿，請選紅隊');}
    const id=playerId||('p_'+Math.random().toString(36).slice(2,10)); const clean=(name||'玩家').trim().slice(0,10)||'玩家';
    socket.join(r.code); socket.data={code:r.code,playerId:id};
    if(!r.scores[id]){let assigned='red';if(r.settings.teamMode&&r.settings.teamAssign==='self'&&(team==='red'||team==='blue'))assigned=team;else{const vals=Object.values(r.scores),rc=vals.filter(x=>x.team==='red').length,bc=vals.filter(x=>x.team==='blue').length;assigned=rc<=bc?'red':'blue'}r.scores[id]={playerId:id,name:clean,score:0,streak:0,bestStreak:0,team:assigned,joinedAt:now(),online:true};}
    else {r.scores[id].name=clean;r.scores[id].online=true;}
    r.players[id]=socket.id; persistLeaderboard(r);
    socket.emit('join:ok',{playerId:id,room:publicRoom(r)}); io.to(r.code).emit('leaderboard',r.history);io.to(r.code).emit('room:update',publicRoom(r));
  });
  socket.on('score:add',({points=10,success=true})=>{
    const {code,playerId} = socket.data||{}; const r=rooms.get(code); if(!r||!r.scores[playerId]||r.state.phase!=='playing')return;
    const p=r.scores[playerId];
    if(success){p.streak=(p.streak||0)+1;p.bestStreak=Math.max(p.bestStreak||0,p.streak); const bonus=r.settings.streak?Math.min(20,(p.streak-1)*2):0; p.score += Math.max(0,Number(points)||0)+bonus;}
    else p.streak=0;
    if(r.settings.teamMode){r.teams.red=0;r.teams.blue=0;for(const s of Object.values(r.scores))r.teams[s.team]=(r.teams[s.team]||0)+s.score;}
    persistLeaderboard(r); io.to(r.code).emit('leaderboard',r.history); io.to(r.code).emit('teams',r.teams); if(r.settings.finishType==='score'&&p.score>=Number(r.settings.finishValue||100))finishGame(r);
  });
  socket.on('admin:start',({code,password})=>{const r=rooms.get(code);if(!r||String(password)!==ADMIN_PASSWORD)return; r.state.phase='countdown';r.state.round=0;r.state.startedAt=now();r.state.gameEndsAt=r.settings.finishType==='time'?now()+Math.max(1,Number(r.settings.gameMinutes||10))*60000:null; io.to(code).emit('game:countdown',{seconds:Number(r.settings.startCountdown||5)}); setTimeout(()=>{const rr=rooms.get(code);if(rr&&rr.state.phase==='countdown')startRound(rr);},Number(r.settings.startCountdown||5)*1000);});
  socket.on('admin:next',({code,password})=>{const r=rooms.get(code);if(r&&String(password)===ADMIN_PASSWORD)endOrNext(r);});
  socket.on('admin:end',({code,password})=>{const r=rooms.get(code);if(r&&String(password)===ADMIN_PASSWORD)finishGame(r);});
  socket.on('admin:setTeam',({code,password,playerId,team})=>{const r=rooms.get(code);if(!r||String(password)!==ADMIN_PASSWORD||!r.scores[playerId]||!['red','blue'].includes(team))return;r.scores[playerId].team=team;if(r.settings.teamMode){r.teams.red=0;r.teams.blue=0;for(const s of Object.values(r.scores))r.teams[s.team]=(r.teams[s.team]||0)+s.score;}persistLeaderboard(r);io.to(code).emit('leaderboard',r.history);io.to(code).emit('teams',r.teams);io.to(code).emit('room:update',publicRoom(r));});
  socket.on('disconnect',()=>{const {code,playerId}=socket.data||{};const r=rooms.get(code);if(r&&r.scores[playerId]){r.scores[playerId].online=false;delete r.players[playerId];persistLeaderboard(r);io.to(code).emit('leaderboard',r.history);io.to(code).emit('room:update',publicRoom(r));}});
});
server.listen(process.env.PORT||3000,()=>console.log('Number Battle V1.2.4 running on',process.env.PORT||3000));
