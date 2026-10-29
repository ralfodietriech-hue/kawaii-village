# Kawaii Village 3D – Multiplayer

A tiny Node.js + Socket.io server that lets friends join each other's world with a 5-letter code.
It syncs **position (X, Y, Z), rotation, animation, look, chat and emotes** in real time.
Everyone keeps their own save file (money, items, home) – only presence is shared.

## What you have to do

### 1. Run it on your own PC
1. Install Node.js 18 or newer from https://nodejs.org
2. Open a terminal in this folder and run:
   ```
   npm install
   npm start
   ```
3. Open http://localhost:3000 in your browser.
4. Main menu → start the game → **Menu → 🌐 Multiplayer → Create room**. You get a code like `K7M2Q`.
5. A friend opens the same address and uses **Join with code**.

### 2. Friends on the same Wi-Fi
Find your PC's local IP (`ipconfig` / `ifconfig`, e.g. `192.168.1.23`). Friends open
`http://192.168.1.23:3000`. (Allow Node through your firewall if asked.)

### 3. Friends over the internet (pick one)
- **Quick test:** `npx cloudflared tunnel --url http://localhost:3000` (or `ngrok http 3000`) and
  share the https address it prints.
- **Permanent:** deploy this folder to Render, Railway, Fly.io or any VPS that runs Node.
  Start command: `npm start`. The host provides `PORT` automatically.
- If the game page is hosted somewhere else (e.g. you open `index.html` from a file or another site),
  set `ALLOWED_ORIGIN=https://your-game-site` on the server, and in the game's Multiplayer panel type
  the server address into the **Server URL** box.

## In game
- **T** – chat, 8 emote buttons, player list with **Go to** (teleport next to a friend), **Leave**.
- You see other players only when you are in the same place (same city, outdoors / same building).
  Homes and jail are private.
- Up to 8 players per room. Rooms disappear when empty.

## How it works
- `server.js` – static file server for `public/` + Socket.io rooms. Clients send `state`
  (x, y, z, rotation, move/anim flags) ~15 times per second; the server validates and rate-limits it,
  then broadcasts one batched `tick` per room every 66 ms. Other players are interpolated on the client.
- Events: `room:create`, `room:join`, `room:leave`, `state`, `look`, `chat`, `emote`;
  server → client: `peer:join`, `peer:leave`, `peer:look`, `chat`, `emote`, `tick`.
- Client code lives in the game file (module "p19 multiplayer").

## Limits (be aware)
- Positions are client-authoritative, so a determined cheater could fake movement. Fine for friends,
  not for a competitive game.
- Money, items, quests and time of day are not shared.
- Test status: the game client and server logic were tested end-to-end with two browsers, but
  against a stand-in for the socket.io package (the build sandbox could not download the real one).
  `npm install` pulls the real `socket.io ^4.7`; if anything misbehaves on your first run, tell me the
  console message and I'll fix it.
