# WebRTC Remote Desktop Demo (MVP)

A consent-first, **experimental** Windows remote desktop prototype: WebRTC video + data channel, WebSocket signaling, optional STUN/coturn, explicit host-side control approval, and a local Windows `SendInput` helper. **Not production-ready**.

> This repository's source lives in the `remote-desktop-demo/` folder of the independent `demo/webrtc-remote-desktop-20261120` branch. The original default branch is untouched.

## Implemented vs. planned

| Capability | Status |
| --- | --- |
| Browser host screen share (`getDisplayMedia`) | Implemented, requires user consent |
| Browser peer-to-peer WebRTC media / input data channel | Implemented |
| WebSocket signaling room (128-bit shareable secret) | Implemented, one host + one viewer |
| STUN + optional coturn with short-lived HMAC REST credentials | Implemented in signaling |
| Basic sender bitrate adaptation using feedback | Implemented, heuristic, not verified under packet loss |
| Windows `SendInput` mouse/keyboard | Implemented as opt-in .NET 8 local agent |
| Optional coturn Docker deployment scaffold | Included, must configure TLS/DNS/firewall |
| Direct DXGI Desktop Duplication capture | **Not implemented** |
| Explicit NVENC encoder pipeline | **Not implemented**; browser chooses capture/codec/hardware acceleration |
| UIAccess, secure desktop/UAC control | **Not implemented** |
| File transfer, clipboard sync, audio, multi-monitor mapping | **Not implemented** |
| Full identity authentication, authorization, audit, production security | **Not implemented** |
| End-to-end Windows/pubic WAN validation | **Not yet run** |

## Architecture

```
Host Chrome/Edge                    Viewer Chrome/Edge
   getDisplayMedia()  ---- SRTP ----> <video>
   RTCPeerConnection <--- DataChannel input ---- mouse/key
           |                     |
           +---- WSS signaling --+
                     |
        Node.js server (rooms only)
                     |
         optional STUN/coturn TURN
Host Chrome -- ws://127.0.0.1:8765 --> Windows .NET agent
              host approves input     SendInput (current user)
```

The signaling server does **not** carry video by default. When ICE cannot establish P2P, coturn relays encrypted media. TURN traffic then incurs server egress charges. Browsers decide capture backend and hardware codec; DXGI/NVENC require a future native host.

## Run locally (fastest smoke test)

Requirements: Node.js 20+, Chrome or Edge; for mouse/keyboard control on host use Windows 10/11 and .NET 8 SDK.

```powershell
cd remote-desktop-demo
npm install
npm run check
npm start
```

1. On **Windows host**, open `http://localhost:3000`, keep mode **被控端**, click **启动**, explicitly choose a display in the browser prompt.
2. Copy the 32-hex-character session key from host to viewer. Open another browser window (or another computer over an HTTPS deployment), set mode **控制端**, paste the key, click **启动**.
3. Video should appear in the viewer. **No input is accepted until the host starts and explicitly authorizes the agent.**
4. For input control, start a separate terminal on the Windows host:

```powershell
dotnet run --project windows-agent/RemoteInputAgent.csproj
```

5. Copy the one-time token printed locally into **Windows Agent Token** on the host browser, click **连接本机 Agent**, then check **允许远端鼠标与键盘操作**. Viewer clicks video to focus and uses mouse/keyboard; Esc releases viewer keyboard focus.
6. Uncheck host authorization or click **断开** to revoke control. Stop the agent process to close the input socket.

**Local network note:** `getDisplayMedia` needs a secure browser context. For cross-device use, put the signaling app behind **HTTPS/WSS** with a valid certificate. A plain `http://192.168.x.x:3000` URL will not meet browser secure-context requirements.

**Windows agent origin:** Agent permits `http://localhost:3000` and `http://127.0.0.1:3000` by default. For a hosted HTTPS application, start agent with `AGENT_ALLOWED_ORIGIN=https://remote.example.com` (your actual origin). The agent binds only to `127.0.0.1:8765`.

## Public deployment / coturn

You need a DNS hostname and valid TLS termination for the signaling website (e.g. Caddy or nginx reverse proxy to `127.0.0.1:3000`). Recommended: separate TURN node(s) by region.

```bash
cd remote-desktop-demo/deploy
cp turnserver.conf.example turnserver.conf
# Replace realm, shared secret, external-ip and certificates.
# The same random shared secret MUST go into deploy/.env:
# TURN_SECRET=<long random value>
docker compose up -d --build
```

Edit `docker-compose.yml` to replace `your-domain.example` with your actual TURN hostname. coturn's relay port range `49160-49200/udp` is **small for a demo only**; increase for concurrent sessions. Allow `3478/udp`, `3478/tcp`, your configured `5349/tcp` (with certificate), and UDP relay range in the server firewall. Supply real TLS cert/key inside the coturn container if advertising `turns:`; the example config does not include them or mount them automatically. If TLS is not configured, remove the `turns:` URL rather than advertising a broken endpoint. On NAT'd virtual machines configure `external-ip` correctly.

Because coturn is run with `network_mode: host`, this example is intended for a Linux server; do not expect the same port topology under Docker Desktop on Windows. The web service is intentionally bound to `127.0.0.1` for reverse-proxy-only access.

TURN auth is **time-bound HMAC**: Node derives usernames/credentials from `TURN_SECRET` so there is no permanent TURN user in source. Production should authenticate device/account identity before issuing TURN credentials, rate-limit issuance and set traffic quotas to prevent third-party relay abuse.

## Weak network and cost policy

- P2P first with ICE/STUN, TURN on failure. For production, deploy separate regional coturn nodes with measured RTT/region steering, rather than always returning one global TURN URL.
- Browser WebRTC implements congestion control and retransmission. The demo additionally adjusts `RTCRtpSender.maxBitrate` from viewer feedback (loss/RTT); it is a **simple heuristic**, not verified GCC replacement.
- Keep buffers low; drop stale frames rather than queue them. For production measure 95th percentile glass-to-glass latency, packet-loss bursts, frame freezes, relay ratio and relay GB/session.
- Reduce host frame rate/quality when static; consider dirty-region encoding and hardware NVENC in a future native host.
- TURN egress cost can dominate; log ICE candidate pair relay status, enforce account quotas, and expose cost per active minute.

## Security limitations (read before internet exposure)

- This demo uses a random room secret as possession-based session access, **not** account authentication, mTLS, device binding or durable permission records.
- A person with the room secret can view the session. The host must not share it publicly.
- Signaling runs plain HTTP locally; use authenticated HTTPS/WSS, reverse-proxy limits and abuse protection for any non-local deployment.
- The Windows helper accepts connections only from localhost, checks browser origin and a launch-scoped random token, and has a host-side explicit allow-control checkbox. **This does not constitute a full hardened security boundary.**
- Browser `SendInput` remote control only targets the current interactive desktop session at normal user integrity. No UAC secure desktop, no anti-cheat circumvention, no HID kernel driver.
- The prototype maps video coordinates onto the *whole virtual desktop*. Multi-monitor selection / aspect ratio mapping requires development before production use.
- Agent and browser can become inconsistent if a connection is interrupted; do not use on mission-critical hosts.
- Deploy first to a controlled test environment, not directly as an unattended remote-access service.

## Next engineering milestones

1. Native Windows capture service: DXGI Desktop Duplication + WGC fallback, robust display-change recovery and cursor composition.
2. D3D11 GPU texture -> NVENC H.264/HEVC via native encoder -> WebRTC video frame adapter, with codec negotiation and hardware decode.
3. Authenticated device enrollment, short-lived signed sessions, host confirmation, replay prevention, per-device ACL and session audit.
4. Windows helper running in user session with safe UIAccess model where justified; define secure desktop behavior explicitly instead of bypassing UAC.
5. Adaptive bitrate with interval packet loss, jitter, RTT, frame timing, keyframe recovery, PLI/NACK and network emulator tests.
6. Regional TURN steering, relayed bandwidth quotas and load testing.

License: no license granted by this demo folder; choose a license before redistribution.
