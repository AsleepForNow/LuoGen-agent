'use strict';
const $ = id => document.getElementById(id);
const roleEl=$('role'), roomEl=$('room'), statusEl=$('status');
let socket=null, pc=null, control=null, stream=null, agent=null;
let iceServers=[], pendingIce=[], statsTimer=null, controlAllowed=false, keyboardFocused=false;
function status(message){statusEl.textContent=message}
function randomRoom(){return Array.from(crypto.getRandomValues(new Uint8Array(16)),b=>b.toString(16).padStart(2,'0')).join('')}
function refreshMode(){
  $('hostOptions').hidden=roleEl.value!=='host';
  if(roleEl.value==='host'&&!roomEl.value)roomEl.value=randomRoom();
}
roleEl.addEventListener('change',refreshMode);
$('generate').addEventListener('click',()=>roomEl.value=randomRoom());
refreshMode();
const signal = m => {if(socket?.readyState===WebSocket.OPEN)socket.send(JSON.stringify(m))};
function cleanup(){
  clearInterval(statsTimer);statsTimer=null;
  controlAllowed=false;$('allowControl').checked=false;$('allowControl').disabled=true;
  if(control){try{control.close()}catch{};control=null}
  if(pc){pc.close();pc=null}
  if(socket){const old=socket;socket=null;old.close()}
  if(stream){stream.getTracks().forEach(t=>t.stop());stream=null}
  if(agent){agent.close();agent=null}
  $('remote').srcObject=null;$('start').disabled=false;$('stop').disabled=true;
  status('已断开');
}
$('stop').addEventListener('click',cleanup);
function makePC(){
  pendingIce=[];
  const p=new RTCPeerConnection({iceServers,bundlePolicy:'max-bundle'});
  pc=p;
  p.onicecandidate=e=>{if(e.candidate)signal({type:'candidate',candidate:e.candidate.toJSON()})};
  p.onconnectionstatechange=()=>{
    status('WebRTC: '+p.connectionState);
    if(p.connectionState==='connected') startStats();
  };
  p.ontrack=e=>{$('remote').srcObject=e.streams[0]||new MediaStream([e.track]);$('remote').play().catch(()=>{})};
  if(roleEl.value==='host'){
    for(const track of stream.getTracks())p.addTrack(track,stream);
    control=p.createDataChannel('input',{ordered:false,maxRetransmits:0});
    control.onmessage=onRemoteInput;
    control.onopen=()=>status('串流已连接；控制权默认关闭');
  } else {
    p.ondatachannel=e=>{if(e.channel.label==='input'){control=e.channel;control.onopen=()=>status('串流已连接；等待被控端授权输入')}};
  }
  return p;
}
async function flushIce(){for(const c of pendingIce.splice(0)){try{await pc.addIceCandidate(c)}catch(e){console.warn('ICE',e)}}}
async function handleSignal(msg){
  if(msg.type==='error'){status('错误：'+msg.message);return}
  if(msg.type==='joined'){iceServers=msg.iceServers||[];status('已加入信令房间，等待对端');return}
  if(msg.type==='bye'){
    controlAllowed=false;$('allowControl').checked=false;
    if(pc){pc.close();pc=null;control=null}
    $('remote').srcObject=null;status('对端已离开；会话等待重连');return;
  }
  if(msg.type==='peer-ready' && roleEl.value==='host'){
    if(pc)pc.close();
    const p=makePC();
    const offer=await p.createOffer();
    await p.setLocalDescription(offer);
    signal({type:'offer',description:p.localDescription});
  }
  if(msg.type==='offer'&&roleEl.value==='viewer'){
    if(pc)pc.close();
    const p=makePC();await p.setRemoteDescription(msg.description);await flushIce();
    const answer=await p.createAnswer();await p.setLocalDescription(answer);
    signal({type:'answer',description:p.localDescription});
  }
  if(msg.type==='answer'&&roleEl.value==='host'&&pc){
    await pc.setRemoteDescription(msg.description);await flushIce();
  }
  if(msg.type==='candidate'){
    if(!pc||!pc.remoteDescription)pendingIce.push(msg.candidate);
    else await pc.addIceCandidate(msg.candidate).catch(console.warn);
  }
}
$('start').addEventListener('click',async()=>{
  if(!/^[a-f0-9]{32}$/.test(roomEl.value)){status('需要 32 位十六进制会话密钥');return}
  $('start').disabled=true;
  try{
    if(roleEl.value==='host'){
      if(!navigator.mediaDevices?.getDisplayMedia)throw Error('需要 localhost 或 HTTPS 安全上下文');
      stream=await navigator.mediaDevices.getDisplayMedia({
        video:{frameRate:{ideal:30,max:60}},audio:false
      });
      stream.getVideoTracks()[0].addEventListener('ended',cleanup,{once:true});
      $('remote').srcObject=stream;
      $('remote').muted=true;
    } else {$('remote').muted=true}
    const url=(location.protocol==='https:'?'wss://':'ws://')+location.host+'/signal';
    socket=new WebSocket(url);
    socket.onopen=()=>signal({type:'join',role:roleEl.value,room:roomEl.value});
    socket.onmessage=e=>{try{handleSignal(JSON.parse(e.data)).catch(err=>status('协商错误：'+err.message))}catch{}};
    socket.onerror=()=>status('信令连接出错');
    socket.onclose=()=>{if($('stop').disabled===false)status('信令已断开，请重新启动')};
    $('stop').disabled=false;
    status('正在连接信令服务器…');
  }catch(err){cleanup();status('启动失败：'+err.message)}
});
function onRemoteInput(e){
  if(!controlAllowed || !agent || agent.readyState!==WebSocket.OPEN)return;
  if(typeof e.data!=='string'||e.data.length>512)return;
  try{
    const m=JSON.parse(e.data);
    if(!['move','button','wheel','key'].includes(m.kind))return;
    // Every input is relayed only after the local host explicitly opts in.
    agent.send(JSON.stringify(m));
  }catch{}
}
$('connectAgent').addEventListener('click',()=>{
  if(roleEl.value!=='host')return;
  const token=$('agentToken').value.trim();
  if(!/^[a-f0-9]{32}$/.test(token)){status('输入 Agent 窗口显示的 32 位 Token');return}
  if(agent)agent.close();
  // Agent accepts only loopback and an explicit per-launch token.
  agent=new WebSocket('ws://127.0.0.1:8765/agent?token='+token);
  agent.onopen=()=>{status('本机 Agent 已连接；仍需勾选控制授权');$('allowControl').disabled=false};
  agent.onclose=()=>{controlAllowed=false;$('allowControl').checked=false;$('allowControl').disabled=true;status('Agent 已断开')};
  agent.onerror=()=>status('无法连接本机 Agent；检查进程和浏览器 localhost 策略');
});
$('allowControl').addEventListener('change',e=>{
  controlAllowed=!!e.target.checked && agent?.readyState===WebSocket.OPEN;
  status(controlAllowed?'已授权远端操作（可随时撤销）':'已禁止远端输入');
});
function transmit(m){if(roleEl.value==='viewer'&&control?.readyState==='open')control.send(JSON.stringify(m))}
const video=$('remote');
function pointerPos(e){
  const bounds=video.getBoundingClientRect(), vw=video.videoWidth, vh=video.videoHeight;
  if(!vw||!vh)return null;
  const factor=Math.min(bounds.width/vw,bounds.height/vh);
  const width=vw*factor,height=vh*factor;
  const left=bounds.left+(bounds.width-width)/2,top=bounds.top+(bounds.height-height)/2;
  const x=(e.clientX-left)/width,y=(e.clientY-top)/height;
  if(x<0||x>1||y<0||y>1)return null;
  return {x:Math.max(0,Math.min(1,x)),y:Math.max(0,Math.min(1,y))};
}
let lastMove=0;
video.addEventListener('mousemove',e=>{
  const p=pointerPos(e);if(!p)return;
  const now=performance.now();if(now-lastMove<16)return;lastMove=now;
  transmit({kind:'move',...p});
});
video.addEventListener('mousedown',e=>{
  if(roleEl.value!=='viewer')return;
  const p=pointerPos(e);if(!p)return;
  keyboardFocused=true;video.focus();
  transmit({kind:'move',...p});transmit({kind:'button',button:e.button,down:true});
  e.preventDefault();
});
video.addEventListener('mouseup',e=>{if(roleEl.value==='viewer'){transmit({kind:'button',button:e.button,down:false});e.preventDefault()}});
video.addEventListener('contextmenu',e=>{if(roleEl.value==='viewer')e.preventDefault()});
video.addEventListener('wheel',e=>{if(roleEl.value==='viewer'){transmit({kind:'wheel',delta:Math.max(-120,Math.min(120,Math.round(-e.deltaY)))});e.preventDefault()}},{passive:false});
video.addEventListener('blur',()=>keyboardFocused=false);
window.addEventListener('keydown',e=>{
  if(e.key==='Escape'){keyboardFocused=false;video.blur();return}
  if(!keyboardFocused||roleEl.value!=='viewer')return;
  transmit({kind:'key',code:e.code,down:true});e.preventDefault();
});
window.addEventListener('keyup',e=>{
  if(!keyboardFocused||roleEl.value!=='viewer')return;
  transmit({kind:'key',code:e.code,down:false});e.preventDefault();
});
function startStats(){
  if(statsTimer)return;
  statsTimer=setInterval(async()=>{
    if(!pc||pc.connectionState!=='connected')return;
    try{
      const reports=await pc.getStats();
      let received=null,roundTrip=null,selected=null;
      reports.forEach(r=>{
        if(r.type==='inbound-rtp'&&r.kind==='video')received=r;
        if(r.type==='candidate-pair'&&r.state==='succeeded'&&r.nominated)selected=r;
      });
      if(selected&&Number.isFinite(selected.currentRoundTripTime))roundTrip=Math.round(selected.currentRoundTripTime*1000);
      $('metrics').textContent=roundTrip===null?'':'RTT '+roundTrip+'ms';
      if(roleEl.value==='viewer'&&received&&control?.readyState==='open'){
        const loss=(received.packetsLost||0)/Math.max(1,(received.packetsReceived||0)+(received.packetsLost||0));
        control.send(JSON.stringify({kind:'feedback',rtt:roundTrip,loss}));
      }
      if(roleEl.value==='host'&&pc){
        const sender=pc.getSenders().find(s=>s.track?.kind==='video');
        if(sender && sender.getParameters().encodings){
          const local=await sender.getStats();
          let outgoing;local.forEach(r=>{if(r.type==='outbound-rtp'&&r.kind==='video')outgoing=r});
          if(outgoing)$('metrics').textContent='编码帧 '+(outgoing.framesEncoded||0);
        }
      }
    }catch(e){console.warn(e)}
  },2000);
}
// Receiver feedback -> sender bitrate adaptation; separate from browser GCC.
let targetBitrate=3000000;
async function adapt(m){
  if(roleEl.value!=='host'||!pc||!m||m.kind!=='feedback')return;
  const loss=Number(m.loss)||0,rtt=Number(m.rtt)||0;
  if(loss>.05||rtt>180)targetBitrate=Math.max(500000,Math.round(targetBitrate*.75));
  else if(loss<.01&&rtt<100)targetBitrate=Math.min(8000000,targetBitrate+200000);
  const sender=pc.getSenders().find(s=>s.track?.kind==='video');
  if(!sender)return;
  const params=sender.getParameters();
  if(!params.encodings?.length)return;
  params.encodings[0].maxBitrate=targetBitrate;
  try{await sender.setParameters(params)}catch(e){console.warn('setParameters unsupported',e)}
}
// Host control handler also processes non-input feedback.
const originalHandler=onRemoteInput;
onRemoteInput=function(e){
  let m;try{m=JSON.parse(e.data)}catch{return}
  if(m.kind==='feedback'){adapt(m);return}
  originalHandler(e);
};
