import WebSocket from 'ws';
import wrtc from 'wrtc';
import os from "os";
import si from "systeminformation";
import fs from "fs";
import path from "path";
import { dir } from 'console';
import { json } from 'stream/consumers';
import express from "express";
import http from "http";

const app = express();
const webServer = http.createServer(app);

let connectedClient = "None";
let filePermission = true;

const SIGNALING_WS = 'ws://144.24.158.26:8080';
const SERVER_ID = 'myserver-'+(Math.floor(Math.random() * 900000) + 100000).toString();

let peerConnection = null;
let dataChannel = null;
let pendingCandidates = [];
let reconnecting = false;
let ws=null;

const UPLOAD_DIR = "/home/yashas/Documents/mycloud/";
// Ensure directory exists
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}
/*
function uploadfile(fileName,data){
  try{
    const base64Data = data;
    const filename = fileName;
    await FileSystem.writeAsStringAsync(
      UPLOAD_DIR,
      base64Data,
      { encoding: FileSystem.EncodingType.Base64 }
    );
    console.log('File saved successfully!');
    return JSON.stringify("File uploaded Successfully");
  }catch(err){
    console.log("Error while downloading file",err);
    return JSON.stringify({error:error.message });
  }
}*/

async function connectToRelay() {
  return new Promise((resolve, reject) => {
    ws = new WebSocket(SIGNALING_WS);
    console.log(SERVER_ID);
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
          if (peerConnection.connectionState === "connected") {
            connectedClient = from;
          }
          if (peerConnection.connectionState === "disconnected" || peerConnection.connectionState === "failed") {
            connectedClient = "None";
          }
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
      if(!filePermission){
        return JSON.stringify({ error: "Permission Denied" });
      }
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
      if(!filePermission){
        return JSON.stringify({ error: "Permission Denied" });
      }
      const stat = fs.statSync(fil);
      if (stat.isDirectory()) {
        return JSON.stringify({ error: "Cannot download a directory" });
      }
      const data = fs.readFileSync(fil, { encoding: "base64" });
      return JSON.stringify({name:fil, size: stat.size, data:data});
    } catch (error) {
      return JSON.stringify({error:error.message });
    }
  }

  if(cmd.startsWith("UPLOAD:")){
    const raw = cmd.split(":")[1];
    const filename = raw.split("}")[0];
    const filedata = raw.split("}")[1];
    try {
      uploadfile(filename,filedata);
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

app.get("/", (req, res) => {
  res.send(`
  <html>
  <head>
  <title>MyCloud Server</title>
  <style>
  *{
    box-sizing:border-box;
    margin:0;
    padding:0;
  }
  body {
    font-family: Arial;
    background: #0d1117;
    color: #fff;
    text-align: center;
    padding: 5px;
    width: 100%;
    height:100%;
  }
  .header{
    display:flex;
    flex-direction:row;
    width:100%;
    height:100px;
    padding:10px 30px;
    background-color:blue;
    align-items:center;
    justify-content:space-between;
  }
  h1 {
    color: #4cc2ff;
  }
  button {
    padding: 10px 20px;
    border: none;
    border-radius: 8px;
    cursor: pointer;
    font-weight: bold;
  }
  .container{
    padding-top:5vh;
    display:flex;
    flex-direction:column;
    align-items:center;
    row-gap:10px;
  }
  .stop {
    background:#ff4d4d;
  }
  .toggle {
    background:yellow;
    padding:5px 5px;
  }
  .netstat{
    display:flex;
    flex-direction:row;
    align-items:center;
  }
  </style>
  </head>
  <body>
  <div class="header">
  <h1>MyCloud Server</h1>
  <p><b>Server ID:</b> ${SERVER_ID}</p>
  <button class="stop" onclick="fetch('/stop').then(() => location.reload())">Stop Server</button>
  </div>
  <div class="container">
  <p><b>Connected Client:</b> ${connectedClient}</p>
  <p><b>File Permission:</b> ${filePermission ? "Enabled" : "Disabled"}</p>
  <button class="toggle" onclick="fetch('/toggle-permission').then(() => location.reload())">${filePermission ? "Disable" : "Enable"}</button>
  </div>
  </body>
  </html>
  `);
});

app.get("/stop", (req, res) => {
  res.send("Stopping...");
  console.log("🛑 Stop requested from dashboard");
  process.exit(0);
});

// Toggle file permission
app.get("/toggle-permission", (req, res) => {
  filePermission = !filePermission;
  res.send(`Permission: ${filePermission}`);
  console.log("✔ Permission changed:", filePermission);
});

webServer.listen(8085, () => {
  console.log(`🌐 Web Interface: http://0.0.0.0:8085`);
  connectToRelay();
});
