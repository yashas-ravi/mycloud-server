import WebSocket from 'ws';
import wrtc from 'wrtc';
import os from "os";
import si from "systeminformation";
import fs from "fs";
import path from "path";
import { dir } from 'console';
import { json } from 'stream/consumers';

const SIGNALING_WS = 'ws://144.24.158.26:8080';
const SERVER_ID = 'myserver21';

let peerConnection = null;
let dataChannel = null;
let pendingCandidates = [];
let reconnecting = false;
let ws=null;

async function connectToRelay() {
return new Promise((resolve, reject) => {
ws = new WebSocket(SIGNALING_WS);

ws.on('open', () => {
  console.log('[WS] Connected to signaling server');
  ws.send(JSON.stringify({ type: 'register', id: SERVER_ID }));
  resolve();
});

ws.onerror = (err) => {
      console.error("[SIGNAL] Error:", err);
    };

ws.onclose = () => {
      console.log("🔌 All connections closed");
      resetConnection();
      restartServer();
};

ws.on('message', async (msg) => {
  const data = JSON.parse(msg);
  if (data.type !== 'signal') return;

  const payload = JSON.parse(data.payload);
  const from = data.from;

  // Handle incoming offer
  if (payload.type === 'offer') {

    console.log('[RTC] Offer received from', from);

    peerConnection = new wrtc.RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'turn:144.24.158.26:3478', username: 'mycloudturn', credential: '##mycloudturn@@oracle' }
      ]
    });

    // --- Handle ICE candidates ---
    peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        ws.send(JSON.stringify({
          type: 'signal',
          from: SERVER_ID,
          to: from,
          payload: JSON.stringify({
            type: 'candidate',
            candidate: event.candidate
          })
        }));
      }
    };

    // --- Detect connection state changes ---
    peerConnection.onconnectionstatechange = () => {
      if (!peerConnection) return;
      console.log(`[RTC] Connection state: ${peerConnection.connectionState}`);
      if (
        peerConnection.connectionState === 'disconnected' ||
        peerConnection.connectionState === 'failed' ||
        peerConnection.connectionState === 'closed'
      ) {
        console.log('[RTC] Client disconnected, resetting...');
         resetConnection();
         restartServer();
      }
    };

    // --- Data channel handler ---
    peerConnection.ondatachannel = (event) => {
      dataChannel = event.channel;
      console.log('[RTC] DataChannel opened:', dataChannel.label);

      dataChannel.onmessage = async (ev) => {
        const cmd = ev.data.trim();
        console.log('[RTC] Client says:', cmd);
        const output = await runNodeCommand(cmd);
       if (dataChannel && dataChannel.readyState === "open") {
        dataChannel.send(String(output));
      } else {
      console.warn("[RTC] Skipped sending — DataChannel is closed or null");
      }
      };

      dataChannel.onclose = () => {
        console.log('[RTC] DataChannel closed by client');
        resetConnection();
        restartServer();
      };
    };

    await peerConnection.setRemoteDescription({ type: 'offer', sdp: payload.sdp });
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);

    ws.send(JSON.stringify({
      type: 'signal',
      from: SERVER_ID,
      to: from,
      payload: JSON.stringify({
        type: 'answer',
        sdp: peerConnection.localDescription.sdp
      })
    }));

    console.log('[RTC] Answer sent to', from);

    // process buffered ICE candidates
    for (const c of pendingCandidates) {
      await peerConnection.addIceCandidate(c);
    }
    pendingCandidates = [];
  }

  // Handle ICE candidate from client
  else if (payload.type === 'candidate') {
    try {
      const candidate = payload.candidate;
      if (candidate && candidate.candidate) {
        if (peerConnection) {
          await peerConnection.addIceCandidate(candidate);
          console.log('[RTC] Added ICE candidate from', from);
        } else {
          pendingCandidates.push(candidate);
        }
      }
    } catch (err) {
      console.error('Candidate error:', err);
    }
  }
});
});
}

async function runNodeCommand(cmd) {

  if(cmd.startsWith("FILESYS.")) {
  const  dir = cmd.split(".")[1];
  try {
    const items = fs.readdirSync(dir, { withFileTypes: true });
    const files = items
      .filter(
        item =>
          !item.name.startsWith(".") && 
          !["proc", "sys", "dev", "root", "run"].includes(item.name)
      )
      .map(item => ({
        name: item.name,
        path: item.parentPath,
        type: item.isDirectory() ? "folder" : "file"
      }));
      return JSON.stringify(files);
    } catch (err) {
      return [{ name: "Permission Denied", type: "error" }];
    }
  }
  
  if(cmd.startsWith("FILESYS:")){
    const fil = cmd.split(":")[1];
    try {
       if (!fil || !fs.existsSync(fil)) {
          return JSON.stringify({ error: "File not found" });
        }
        const stat = fs.statSync(fil);
        if (stat.isDirectory()) {
          return JSON.stringify({ error: "Cannot download a directory" });
        }
      const data = fs.readFileSync(fil, { encoding: "base64" });
        return JSON.stringify({name:fil, size: stat.size, data});
    } catch (error) {
      return JSON.stringify({error:error.message }); 
    }
  }

  switch (cmd.toUpperCase()) {
    case "CPU": {
      const cpu = await si.currentLoad();
      return `${cpu.currentLoad.toFixed(2)} %`;
    }
    case "RAM": {
      const mem = await si.mem();
      return `${(mem.active / 1e9).toFixed(1)}/${(mem.total / 1e9).toFixed(1)} GB`;
    }
    case "STORAGE": {
    const disks = await si.fsSize();

    let totalUsed = 0;
    let totalSize = 0;

    for (const d of disks) {
      if (d.size > 0) {
        totalUsed += d.used;
        totalSize += d.size;
      }
    }

    const usedGB = (totalUsed / 1024 / 1024 / 1024).toFixed(2);
    const totalGB = (totalSize / 1024 / 1024 / 1024).toFixed(2);
    return `${usedGB}/${totalGB} GB`;
  }

  case "SYSTEMINFO" : {
  const os = await si.osInfo();
  const system = await si.system();
  return JSON.stringify({
    osName: os.distro,            
    hostname: os.hostname,        
    arch: os.arch,               
    model: system.model,          
    });
  }

  default:
      return `Unknown command: ${cmd}`;
  }

}

function resetConnection() {
  try{
  if (peerConnection) {
    peerConnection.onconnectionstatechange = null;
    peerConnection.onicecandidate = null; 
    peerConnection.ondatachannel = null;
    peerConnection.close();
    }
  } catch(e){console.log("error while closing peer",e);}

    try {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    } catch (e) {
      console.error("[RESET] Error closing WS:", e);
    }

  peerConnection = null;
  dataChannel = null;
  pendingCandidates = [];
  console.log("[RTC] Connection reset complete, ready for new client.");
}

async function restartServer() {
  if (reconnecting) return;
  reconnecting = true;

  console.log("🔁 Restarting server in 3s...");
  await new Promise((r) => setTimeout(r, 3000));

  reconnecting = false;
  await connectToRelay();
}
connectToRelay();