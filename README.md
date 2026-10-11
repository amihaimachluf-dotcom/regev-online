# רגב Online (multiplayer)
Local: `npm install && npm start` -> http://localhost:3000/?room=CODE&name=YOU
Render: New > Blueprint (uses render.yaml) or New > Web Service: build `npm install`, start `npm start`.
Room state (block edits, chests, seed, time) is saved to data/rooms.json every 20 s (set DATA_DIR to change; Render free disk is wiped on redeploy/restart).
The first player in a room is the host: runs mobs, items, fluids, crops, time and weather; host passes to the next player when they leave.
Host migrates automatically if the host tab is hidden or stops sending heartbeats for ~3.5 s.
Synced: players (pos/health/riding), blocks (all causes), mobs, items, boats & mounts, butterflies, chests, signs, merchant stock, taming/feeding/shearing/breeding, time & weather, particles/explosions/thunder.
Server checks: per-event rate limits; non-host block/sign edits must be within 16 blocks of the sender.
