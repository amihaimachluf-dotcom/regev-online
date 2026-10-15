// Multiplayer layer for רגב (added). Host-authoritative simulation; silently falls back to single-player.
(function () {
  const qs = new URLSearchParams(location.search);
  const room = (qs.get('room') || 'main').slice(0, 32);
  let name = qs.get('name') || localStorage.getItem('mp_name');
  if (!name) { name = (prompt('שם שחקן (Player name):') || '').trim() || ('שחקן' + Math.floor(Math.random() * 1000)); }
  name = name.slice(0, 16); try { localStorage.setItem('mp_name', name); } catch (e) {}
  const MP = window.__mp = { room, name, socket: null, connected: false, isHost: false, hostId: null, roomSeed: null, ghosts: new Map(),
    pending: [], out: [], local: 0, sim: 0, applying: false, swapping: 0, lastEnv: null, envApplied: false, proxies: new Map(), rideMap: new Map(), noSpawn: 0, fxIn: false, nidN: 0, chestLast: {} };
  const online = () => MP.connected;
  const hostSim = () => !MP.connected || MP.isHost;   // run the simulation locally?

  function boot() {
    const game = window.__regev;
    if (!game || typeof io === 'undefined' || !window.__cls) { console.warn('[mp] single-player mode'); return; }
    const C = window.__cls, { Game, Player, World, Renderer, UI, Spawner, ItemEntity, PrimedTNT, makeStack, packPos, uid } = C;
    const s = MP.socket = io({ reconnectionAttempts: 10, timeout: 5000 });
    const relay = (to, msg) => { if (online()) s.emit('relay', Object.assign({ to }, msg)); };

    // ---------- HUD ----------
    const hud = document.createElement('div');
    hud.style.cssText = 'position:fixed;top:4px;left:4px;z-index:9999;font:12px sans-serif;color:#fff;background:rgba(0,0,0,.45);padding:3px 6px;border-radius:4px;pointer-events:none;direction:ltr';
    hud.id = 'mpHud'; document.body.appendChild(hud);
    const labels = document.createElement('div'); labels.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:9998'; document.body.appendChild(labels);
    const setHud = () => { hud.textContent = MP.connected ? `Online · room "${room}" · ${MP.ghosts.size + 1} players${MP.isHost ? ' · host' : ''}` : 'Offline (single-player)'; };
    setHud();

    // ---------- connection ----------
    s.on('connect', () => { MP.connected = true; s.emit('join', { room, name }); setHud(); });
    s.on('disconnect', () => { MP.connected = false; becomeHost(false, true); setHud(); });
    s.on('full', () => { hud.textContent = 'Room full (max 10) – single-player'; s.disconnect(); });
    s.on('joined', (d) => {
      MP.roomSeed = d.seed; MP.pending.push(...d.edits);
      for (const p of d.players) addGhost(p);
      for (const k in d.chests || {}) applyChest(+k, d.chests[k]);
      if (d.env) { MP.lastEnv = d.env; MP.envApplied = false; }
      if (game.world && d.seed == null) s.emit('world', { seed: game.world.seed });
      setHost(d.host); setHud();
    });
    s.on('host', (d) => { if (d.env) MP.lastEnv = d.env; setHost(d.id); setHud(); });
    s.on('seed', (seed) => { if (MP.roomSeed == null) MP.roomSeed = seed; });
    s.on('pjoin', (p) => { addGhost(p); setHud(); game.ui && game.ui.toast && game.ui.toast(p.name + ' הצטרף/ה'); });
    s.on('pleave', (id) => { const g = MP.ghosts.get(id); if (g) { g.label.remove(); MP.ghosts.delete(id); } setHud(); });
    s.on('state', (d) => { const g = MP.ghosts.get(d.id); if (g) Object.assign(g.t, d); });
    s.on('edits', (arr) => { for (const e of arr) MP.pending.push(e); });
    s.on('chest', (d) => applyChest(d.k, d.arr));
    s.on('env', (d) => { MP.lastEnv = d; if (!MP.isHost) applyEnv(d); });
    s.on('snap', onSnap);
    s.on('relay', onRelay);

    function setHost(id) {
      MP.hostId = id;
      becomeHost(id === s.id);
    }
    function becomeHost(h, offline) {
      const was = MP.isHost; MP.isHost = !!h;
      if (MP.isHost || offline) {
        // proxies become real, locally simulated entities
        for (const e of MP.proxies.values()) { delete e.update; delete e.damage; e._remote = false; e.tx = undefined; }
        MP.proxies.clear();
        if (game.weather && game.weather.timer > 1e8) game.weather.timer = 120;
        if (game.weather && game.weather.khamsinT > 1e8) game.weather.khamsinT = 200;
        if (MP.isHost && !was && MP.lastEnv && !MP.envApplied && game.world) { applyEnv(MP.lastEnv, true); MP.envApplied = true; }
      }
    }

    // ---------- ghosts (other players) ----------
    function addGhost(p) {
      if (MP.ghosts.has(p.id)) return;
      const e = Object.create(Player.prototype);
      const id = p.id;
      Object.assign(e, { game, world: game.world, _ghost: id, kind: 'mob', type: 'mp', x: isFinite(p.x) ? p.x : 0, y: isFinite(p.y) ? p.y : -999, z: isFinite(p.z) ? p.z : 0, yaw: p.yaw || 0, pitch: p.pitch || 0,
        vx: 0, vy: 0, vz: 0, hw: 0.3, h: 1.8, eye: 1.62, bobPhase: 0, bobAmount: 0, swingTime: 0, swingDur: 0.28, swingKind: 'hit', sneaking: false, eatT: 0, bowCharge: 0,
        riding: null, effects: {}, hurtTime: 0, invuln: 0, dead: false, health: 20, maxHealth: 20, onGround: true, inWater: false, headInWater: false, air: 10, food: 20, spawn: { x: 0, y: 80, z: 0 },
        inventory: { armor: [null, null, null, null, null], held: null, slots: [], add(iid, n, dur) { relay(id, { t: 'give', id: iid, n, dur }); return 0; }, consumeHeld() {}, wearHeld() {}, count() { return 0; }, has() { return false; }, on() {} } });
      e.hurt = function (amt, sx, sz, src, cause) { if (this.dead || amt <= 0 || this.invuln > 0) return; this.invuln = 0.5; this.hurtTime = 0.3; relay(id, { t: 'hurt', amt, sx, sz, cause: cause || null }); };
      e.damage = function (amt, sx, sz, knock) { if (this.dead || this.invuln > 0) return false; this.invuln = 0.45; this.hurtTime = 0.3; relay(id, { t: 'hurt', amt, sx, sz, cause: 'player', knock }); return true; };
      const label = document.createElement('div');
      label.style.cssText = 'position:absolute;transform:translate(-50%,-100%);font:bold 13px sans-serif;color:#fff;background:rgba(0,0,0,.5);padding:1px 5px;border-radius:3px;white-space:nowrap;display:none;direction:rtl';
      labels.appendChild(label);
      MP.ghosts.set(id, { e, t: Object.assign({}, p), label, name: p.name });
    }
    const liveGhosts = () => [...MP.ghosts.values()].map((g) => g.e).filter((e) => e.y > -500 && !e.dead && isFinite(e.x) && e.world === game.world);

    // ---------- world seed shared per room ----------
    const origStart = Game.prototype.startWorld;
    Game.prototype.startWorld = function (meta, mods, isNew) {
      if (MP.connected && MP.roomSeed != null && meta.seed !== MP.roomSeed) {
        meta = Object.assign({}, meta, { id: uid(), name: (meta.name || 'world') + ' [' + room + ']', seed: MP.roomSeed, seedText: String(MP.roomSeed), player: null, containers: null, signs: null, mapdata: null, waypoints: null });
        mods = {}; isNew = true;
      }
      MP.proxies.clear(); MP.envApplied = false;
      const r = origStart.call(this, meta, mods, isNew);
      if (MP.connected && MP.roomSeed == null) { MP.roomSeed = meta.seed; s.emit('world', { seed: meta.seed }); }
      return r;
    };

    // ---------- block edits (every cause) ----------
    for (const m of ['handleActions', 'use', 'breakBlock', 'useHive', 'interactMob', 'update']) {
      const f = Player.prototype[m]; if (typeof f !== 'function') continue;
      Player.prototype[m] = function () { MP.local++; try { return f.apply(this, arguments); } finally { MP.local--; } };
    }
    const origUpdate = Game.prototype.update;
    Game.prototype.update = function (dt) { MP.sim++; try { return origUpdate.call(this, dt); } finally { MP.sim--; } };
    const origSet = World.prototype.setBlock;
    World.prototype.setBlock = function (x, y, z, id, meta, opts) {
      const r = origSet.call(this, x, y, z, id, meta, opts);
      if (r !== false && online() && !MP.applying && this === game.world && (MP.local > 0 || (MP.isHost && MP.sim > 0))) MP.out.push({ x, y, z, id, m: meta || 0 });
      return r;
    };
    // simulation (fluids, random ticks/crops, spawning) runs only on the host
    for (const m of ['fluidTick', 'randomTick']) {
      const f = World.prototype[m];
      World.prototype[m] = function () { if (!hostSim()) return; return f.apply(this, arguments); };
    }
    const origSpawn = Spawner.prototype.update;
    Spawner.prototype.update = function (dt) {
      if (!hostSim()) return;
      const g = this.game, t0 = this.timer, real = g.player;
      origSpawn.call(this, dt);
      if (MP.isHost && t0 - dt <= 0) {   // a spawn round just ran: also spawn around the other players
        for (const gh of liveGhosts()) { const keep = this.timer; this.timer = 0; g.player = gh; try { origSpawn.call(this, 0); } catch (e) {} finally { g.player = real; this.timer = keep; } }
      }
    };

    // host: each entity "sees" its nearest player, so mobs chase/attack and items get picked up by anyone
    const wrapUpdate = (Cls) => {
      if (!Cls || !Object.prototype.hasOwnProperty.call(Cls.prototype, 'update')) return;
      const f = Cls.prototype.update;
      Cls.prototype.update = function (dt) {
        if (MP.isHost && this._nid && !MP.swapping) {
          const gh = MP.rideMap.get(this._nid);
          if (gh) { const r = gh.t.ride, ox = this.x, oz = this.z; this.x = r.x; this.y = r.y; this.z = r.z; this.yaw = r.yaw; this.vx = (this.x - ox) / (dt || 0.016); this.vz = (this.z - oz) / (dt || 0.016); this.rider = gh.e; gh.e.riding = this; this.age = (this.age || 0) + dt; return; }
          if (this.rider && this.rider._ghost) this.rider = null;
        }
        if (!MP.isHost || MP.swapping || !MP.ghosts.size) return f.call(this, dt);
        const g = this.game, real = g.player; let best = real, bd = real ? (real.x - this.x) ** 2 + (real.z - this.z) ** 2 : 1e18;
        if (real && real.dead) bd = 1e18;
        for (const gh of liveGhosts()) { const d = (gh.x - this.x) ** 2 + (gh.z - this.z) ** 2; if (d < bd) { bd = d; best = gh; } }
        if (best === real) return f.call(this, dt);
        MP.swapping++; g.player = best;
        try { return f.call(this, dt); } catch (e) { if (!MP._warned) { MP._warned = 1; console.warn('[mp] entity update w/ ghost', e); } } finally { g.player = real; MP.swapping--; }
      };
    };
    for (const k in C) { const v = C[k]; if (typeof v === 'function' && v.prototype && (v.prototype instanceof C.Entity) && k !== 'Player') wrapUpdate(v); }
    if (game.ui && game.ui.notePickup) { const np = game.ui.notePickup.bind(game.ui); game.ui.notePickup = function () { if (!MP.swapping) return np.apply(null, arguments); }; }
    if (game.audio && game.audio.pickup) { const ap = game.audio.pickup.bind(game.audio); game.audio.pickup = function () { if (!MP.swapping) return ap.apply(null, arguments); }; }

    // non-host: mobs / items / TNT are created by the host
    const isMob = (e) => e && e.kind === 'mob' && !e._ghost;
    const origAdd = Game.prototype.addEntity;
    Game.prototype.addEntity = function (e) {
      if (!hostSim() && !e._remote && (isMob(e) || e.kind === 'item' || e.kind === 'boat' || e.kind === 'butterfly' || e instanceof PrimedTNT)) {
        if (e.kind === 'butterfly') return;
        relay('host', { t: 'spawn', cls: e.constructor.name, x: e.x, y: e.y, z: e.z, yaw: e.yaw, fuse: e.fuse, byPlayer: e.byPlayer, tamed: e.tamed, baby: e.baby, ci: ciOf(e) || undefined });
        return;
      }
      return origAdd.call(this, e);
    };
    const origItem = Game.prototype.spawnItem;
    Game.prototype.spawnItem = function (x, y, z, id, n, pop, dur) {
      if (hostSim()) return origItem.call(this, x, y, z, id, n, pop, dur);
      relay('host', { t: 'item', x, y, z, id, n, dur, pop: !!pop });
      return new ItemEntity(this, x, y, z, makeStack(id, n, dur));   // detached dummy
    };
    const origDrop = Game.prototype.dropStack;
    Game.prototype.dropStack = function (stack) {
      if (hostSim() || !stack || !this.player) return origDrop.call(this, stack);
      const p = this.player, d = p.lookDir();
      relay('host', { t: 'item', x: p.x + d[0] * 0.4, y: p.eyeY - 0.3, z: p.z + d[2] * 0.4, id: stack.id, n: stack.n, dur: stack.dur, vx: d[0] * 4.5, vy: d[1] * 4.5 + 2, vz: d[2] * 4.5, pd: 1.6 });
    };
    // PvP: other players can be targeted and hit like mobs
    const origTarget = Player.prototype.updateTarget;
    Player.prototype.updateTarget = function () {
      const g = this.game;
      if (this._ghost || !MP.ghosts.size || this !== g.player) return origTarget.call(this);
      const saved = g.entities; g.entities = saved.concat(liveGhosts());
      try { return origTarget.call(this); } finally { g.entities = saved; }
    };

    function onRelay(m) {
      const g = game;
      if (!g.world || !g.player) return;
      if (m.t === 'hurt') { const p = g.player; if (p.dead) return; p.hurt(m.amt, m.sx, m.sz, null, m.cause === 'player' ? undefined : (m.cause || undefined)); if (m.knock) { const dx = p.x - m.sx, dz = p.z - m.sz, d = Math.hypot(dx, dz) || 1; p.vx += dx / d * 4 * m.knock; p.vz += dz / d * 4 * m.knock; p.vy = Math.max(p.vy, 4); } }
      else if (m.t === 'give') { const left = g.player.inventory.add(m.id, m.n, m.dur == null ? undefined : m.dur); if (left < m.n) { g.audio.pickup(); g.ui.notePickup(m.id, m.n - left); } if (left > 0) g.spawnItem(g.player.x, g.player.y + 0.5, g.player.z, m.id, left, true, m.dur == null ? undefined : m.dur); }
      if (!MP.isHost) return;
      if (m.t === 'item') {
        const e = origItem.call(g, m.x, m.y, m.z, m.id, m.n, m.pop, m.dur == null ? undefined : m.dur);
        if (m.vx !== undefined) { e.vx = m.vx; e.vy = m.vy; e.vz = m.vz; } if (m.pd) e.pickupDelay = m.pd;
      } else if (m.t === 'spawn') {
        const K = C[m.cls]; if (!K) return;
        try { const e = m.cls === 'PrimedTNT' ? new K(g, m.x, m.y, m.z, m.fuse, m.byPlayer) : (m.ci ? new K(g, m.x, m.y, m.z, m.ci) : m.cls === 'Boat' ? new K(g, m.x, m.y, m.z, m.yaw) : new K(g, m.x, m.y, m.z)); if (m.tamed) e.tamed = m.tamed; if (m.baby) e.baby = m.baby; origAdd.call(g, e); } catch (er) { console.warn(er); }
      } else if (m.t === 'mobHurt') {
        const e = g.entities.find((x) => x._nid === m.nid);
        if (e && e.damage && !e.dead) { e.damage(m.amt, m.sx, m.sz, m.knock); e.hpBarT = 4; }
      }
    }

    // constructor info needed to re-create Villager / Dragon on other clients (their constructors crash or misbehave without it)
    const ciOf = (e) => {
      const n = e.constructor.name;
      if (n === 'Villager') return { village: e.village, idx: e.idx, prof: e.prof, female: !!e.female, person: e.person, seed: e.seed, home: e.home, plaza: e.plaza };
      if (n === 'Dragon') return { color: e.color, grow: e.grow, wild: !!e.wild };
      return 0;
    };
    // ---------- host snapshots ----------
    const SKIP = new Set(['x', 'y', 'z', 'yaw', 'vx', 'vy', 'vz', 'remove', '_nid', '_remote', 'tx', 'ty', 'tz', 'tyaw', 'kind', 'age', 'invuln']);
    const synced = (e) => (e.kind === 'mob' && !e._ghost) || e.kind === 'item' || e.kind === 'boat' || e.kind === 'butterfly' || e.kind === 'fireball';
    let snapN = 0;
    function sendSnap() {
      const g = game; if (!g.world || !g.entities) return;
      const full = (snapN++ % 20) === 0, list = [], props = full ? {} : null;
      for (const e of g.entities) {
        if (!synced(e) || e.remove) continue;
        if (!e._nid) e._nid = s.id.slice(0, 6) + (++MP.nidN).toString(36);
        const r = [e._nid, e.constructor.name, +e.x.toFixed(2), +e.y.toFixed(2), +e.z.toFixed(2), +(e.yaw || 0).toFixed(2), e.health === undefined ? 0 : +(+e.health).toFixed(1), e.dead ? 1 : 0, e.hurtTime > 0 ? 1 : 0];
        if (e.kind === 'item') r.push(e.stack.id, e.stack.n, e.stack.dur === undefined ? -1 : e.stack.dur);
        else { const ci = ciOf(e); if (ci) r.push(ci); }
        list.push(r);
        if (full) { const o = {}; if (e.offers) o.offers = JSON.parse(JSON.stringify(e.offers)); if (e.colorIdx !== undefined) o.colorIdx = e.colorIdx; for (const k in e) { const v = e[k]; if (!SKIP.has(k) && (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string')) o[k] = v; } props[e._nid] = o; }
        if (list.length >= 250) break;
      }
      const rb = {}; for (const e of g.entities) if (e._nid && e.rider) rb[e._nid] = e.rider === g.player ? s.id : e.rider._ghost;
      s.emit('snap', { l: list, p: props, rb });
    }
    function proxyUpdate(dt) {
      const k = Math.min(1, dt * 10);
      if (this.rider && this.rider === game.player) { this.age = (this.age || 0) + dt; return; }   // I drive it locally
      if (this.tx !== undefined) {
        const ox = this.x, oz = this.z;
        this.x += (this.tx - this.x) * k; this.y += (this.ty - this.y) * k; this.z += (this.tz - this.z) * k;
        let dy = this.tyaw - this.yaw; dy = Math.atan2(Math.sin(dy), Math.cos(dy)); this.yaw += dy * k;
        const sp = Math.hypot(this.x - ox, this.z - oz) / (dt || 0.016);
        this.vx = (this.x - ox) / (dt || 0.016); this.vz = (this.z - oz) / (dt || 0.016);
        if (this.walkPhase !== undefined) { this.walkAmt = Math.min(1, sp / 2.5); this.walkPhase += sp * dt * 3.5; }
      }
      this.age = (this.age || 0) + dt;
      if (this.hurtTime > 0) this.hurtTime -= dt;
      if (this.dead) this.deathTime = (this.deathTime || 0) + dt;
    }
    function proxyDamage(amt, sx, sz, knock) {
      if (this.dead) return false;
      relay('host', { t: 'mobHurt', nid: this._nid, amt, sx, sz, knock }); this.hurtTime = 0.3;
      try { this.game.audio.mobHurt(this); } catch (e) {}
      return true;
    }
    function onSnap(d) {
      const g = game; if (MP.isHost || !g.world || !g.entities || g.state === 'loading') return;
      // drop anything we simulated locally before we knew we were not the host
      for (let i = g.entities.length - 1; i >= 0; i--) { const e = g.entities[i]; if (synced(e) && !e._remote) g.entities.splice(i, 1); }
      const seen = new Set();
      for (const r of d.l) {
        const [nid, cls, x, y, z, yaw, hp, dead, hurt] = r; seen.add(nid);
        let e = MP.proxies.get(nid);
        if (!e) {
          try {
            if (cls === 'ItemEntity') e = new ItemEntity(g, x, y, z, makeStack(r[9], r[10], r[11] >= 0 ? r[11] : undefined));
            else { const K = C[cls] || (C.MOB_TYPES && Object.values(C.MOB_TYPES).find((k) => k.name === cls)); if (!K) continue; e = r[9] && typeof r[9] === 'object' ? new K(g, x, y, z, r[9]) : new K(g, x, y, z); }
          } catch (er) { continue; }
          e._nid = nid; e._remote = true; e.yaw = yaw; e.update = proxyUpdate; if (e.kind === 'mob' || e.kind === 'boat') e.damage = proxyDamage;
          MP.proxies.set(nid, e); g.entities.push(e);
        }
        e.tx = x; e.ty = y; e.tz = z; e.tyaw = yaw;
        if (e.kind === 'mob') { e.health = hp; if (dead && !e.dead) { e.dead = true; e.deathTime = 0; } if (hurt && !(e.hurtTime > 0)) e.hurtTime = 0.25; }
        else if (e.stack) { e.stack.id = r[9]; e.stack.n = r[10]; }
        if (d.p && d.p[nid]) { const keepRider = e.rider; Object.assign(e, d.p[nid], { kind: e.kind }); e.rider = keepRider; if (game.ui && game.ui.tradeWith === e) try { game.ui.renderTrade(); } catch (er) {} }
        // riders (snapshot says who sits on it)
        const rb = d.rb && d.rb[nid];
        if (rb) { if (rb === s.id) e.rider = game.player; else { const gh = MP.ghosts.get(rb); e.rider = gh ? gh.e : { _ghost: rb }; if (game.player.riding === e) game.player.dismount(); } }
        else if (e.rider && e.rider !== game.player) e.rider = null;
      }
      for (const [nid, e] of MP.proxies) if (!seen.has(nid)) { e.remove = true; const i = g.entities.indexOf(e); if (i >= 0) g.entities.splice(i, 1); MP.proxies.delete(nid); }
    }

    // ---------- time & weather ----------
    const WKEYS = ['rain', 'target', 'storm', 'khamsin', 'dustDir', 'wind'];
    function envNow() { const W = game.weather || {}, w = {}; for (const k of WKEYS) if (W[k] !== undefined) w[k] = W[k]; return { t: game.timeOfDay, day: game.day, w }; }
    function applyEnv(d, asHost) {
      if (!game.world || !d) return;
      if (isFinite(d.t)) game.timeOfDay = d.t; if (isFinite(d.day)) game.day = d.day;
      if (d.w && game.weather) { Object.assign(game.weather, d.w); if (!asHost) { game.weather.timer = 1e9; game.weather.khamsinT = 1e9; } }
    }

    // ---------- chests ----------
    const serArr = (arr) => arr.map((st) => (st ? [st.id, st.n, st.dur === undefined ? -1 : st.dur] : null));
    function applyChest(k, data) {
      const w = game.world; if (!data) return;
      if (!w) { (MP.chestQ = MP.chestQ || {})[k] = data; return; }
      let arr = w.containers.get(k); if (!arr) { arr = new Array(27).fill(null); w.containers.set(k, arr); }
      for (let i = 0; i < 27; i++) { const v = data[i]; arr[i] = v ? makeStack(v[0], v[1], v[2] >= 0 ? v[2] : undefined) : null; }
      MP.chestLast[k] = JSON.stringify(serArr(arr));
      const ch = game.ui && game.ui.chest; if (ch && packPos(ch.x, ch.y, ch.z) === k && ch.arr === arr) { try { game.ui.renderInventory(); } catch (e) {} }
    }
    const origOpen = UI.prototype.openChest;
    UI.prototype.openChest = function (x, y, z) {
      const r = origOpen.call(this, x, y, z);
      if (this.chest && online()) { const k = packPos(x, y, z); MP.chestLast[k] = JSON.stringify(serArr(this.chest.arr)); s.emit('chestGet', k); }
      return r;
    };
    const origTake = World.prototype.takeContainer;
    World.prototype.takeContainer = function (x, y, z) {
      const r = origTake.call(this, x, y, z);
      if (online() && this === game.world) { const k = packPos(x, y, z); delete MP.chestLast[k]; s.emit('chestSet', { k, arr: null }); }
      return r;
    };
    s.on('chestData', (d) => { if (d.arr) applyChest(d.k, d.arr); else { const ch = game.ui.chest; if (ch && packPos(ch.x, ch.y, ch.z) === d.k) s.emit('chestSet', { k: d.k, arr: serArr(ch.arr) }); } });
    let openCh = null;
    function checkChest(ch) {
      if (!ch || !online()) return; const k = packPos(ch.x, ch.y, ch.z), j = JSON.stringify(serArr(ch.arr));
      if (MP.chestLast[k] !== j) { MP.chestLast[k] = j; s.emit('chestSet', { k, arr: serArr(ch.arr) }); }
    }

    // ---------- periodic network ----------
    setInterval(() => {
      const p = game.player; if (!MP.connected || !p || !game.world || game.state === 'loading' || !isFinite(p.x)) return;
      s.emit('state', { x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2), yaw: +p.yaw.toFixed(3), pitch: +p.pitch.toFixed(3), sn: !!p.sneaking, sw: p.swingTime > 0, hp: Math.max(0, Math.ceil(p.health)), dead: !!p.dead, rd: !!p.riding, hl: C.heldLightOf ? C.heldLightOf(p) : 0, hi: p.inventory && p.inventory.held ? p.inventory.held.id : -1, oi: p.inventory && p.inventory.armor && p.inventory.armor[4] ? p.inventory.armor[4].id : -1,
        ride: (p.riding && p.riding._remote && p.riding._nid) ? { nid: p.riding._nid, x: +p.riding.x.toFixed(2), y: +p.riding.y.toFixed(2), z: +p.riding.z.toFixed(2), yaw: +(p.riding.yaw || 0).toFixed(3) } : null });
      if (MP.out.length) { s.emit('edits', MP.out.splice(0, 3000)); }
      if (MP.isHost) sendSnap();
      const ch = game.ui && game.ui.chest; if (openCh && openCh !== ch) checkChest(openCh); openCh = ch || null; checkChest(ch);
    }, 90);
    setInterval(() => { if (MP.connected && MP.isHost && game.world && game.state !== 'loading') s.emit('env', envNow()); }, 1000);

    // ---------- render ghosts ----------
    const origDraw = Renderer.prototype.drawEntities;
    Renderer.prototype.drawEntities = function (g, env) {
      if (!MP.ghosts.size) return origDraw.call(this, g, env);
      const saved = g.entities;
      g.entities = saved.concat([...MP.ghosts.values()].map((x) => x.e).filter((e) => e.y > -500));
      try { return origDraw.call(this, g, env); } finally { g.entities = saved; }
    };

    let last = 0, tickAcc = 0;
    function tick(now) {
      requestAnimationFrame(tick);
      const dt = Math.min(0.1, (now - last) / 1000); last = now;
      const p = game.player, w = game.world;
      if (!p || !w || game.state === 'loading') { for (const g of MP.ghosts.values()) g.label.style.display = 'none'; return; }
      // remote held lights (torch/lantern/lava bucket...): same 0-15 level as local hand light, emitted from the ghost
      { const rl = []; const k = Math.min(1, dt * 8);
        for (const g of MP.ghosts.values()) { const e = g.e, t = g.t;
          const hi = t.hi >= 0 && C.ITEMS && C.ITEMS[t.hi] ? t.hi : -1, oi = t.oi >= 0 && C.ITEMS && C.ITEMS[t.oi] ? t.oi : -1;
          if ((e.inventory.held ? e.inventory.held.id : -1) !== hi) e.inventory.held = hi >= 0 ? makeStack(hi, 1) : null;
          if ((e.inventory.armor[4] ? e.inventory.armor[4].id : -1) !== oi) e.inventory.armor[4] = oi >= 0 ? makeStack(oi, 1) : null;
          const target = (t.dead || e.y < -500) ? 0 : Math.max(0, Math.min(15, +t.hl || 0)) / 15;
          g.light = (g.light || 0) + (target - (g.light || 0)) * k;
          if (g.light > 0.01 && Math.abs(e.x - p.x) < 64 && Math.abs(e.z - p.z) < 64) rl.push({ x: e.x, y: e.y + 1.2, z: e.z, l: g.light, d: (e.x - p.x) ** 2 + (e.z - p.z) ** 2 });
        }
        rl.sort((a, b) => a.d - b.d); if (game.renderer) game.renderer.remoteLights = rl.slice(0, 10); }
      MP.rideMap = new Map(); for (const g of MP.ghosts.values()) if (g.t.ride && g.t.ride.nid) MP.rideMap.set(g.t.ride.nid, g);
      if (MP.chestQ) { const q = MP.chestQ; MP.chestQ = null; for (const k in q) applyChest(+k, q[k]); }
      if (MP.lastEnv && !MP.envApplied) { applyEnv(MP.lastEnv, MP.isHost); MP.envApplied = true; }
      if (MP.pending.length && (!MP.roomSeed || w.seed === MP.roomSeed)) {
        const keep = []; MP.applying = true;
        for (const e of MP.pending) { if (w.getChunk(e.x >> 4, e.z >> 4)) { try { w.setBlock(e.x, e.y, e.z, e.id, e.m, { urgent: true }); } catch (er) {} } else keep.push(e); }
        MP.applying = false; MP.pending = keep.length > 60000 ? keep.slice(-60000) : keep;
      }
      // host: crops/random ticks also happen around the other players
      if (MP.isHost && game.state !== 'paused' && (tickAcc += dt) >= 0.05) { tickAcc = 0; MP.sim++; try { for (const gh of liveGhosts()) if (Math.hypot(gh.x - p.x, gh.z - p.z) > 48) w.randomTick(gh.x, gh.z, Math.random); } catch (e) {} finally { MP.sim--; } }
      const cam = game.camera, fov = (game.renderer && game.renderer.curFov) || 1.3, W = innerWidth, H = innerHeight, f = 1 / Math.tan(fov / 2);
      const cp = Math.cos(cam.pitch), fw = [-Math.sin(cam.yaw) * cp, Math.sin(cam.pitch), -Math.cos(cam.yaw) * cp], rt = [Math.cos(cam.yaw), 0, -Math.sin(cam.yaw)];
      const up = [rt[1] * fw[2] - rt[2] * fw[1], rt[2] * fw[0] - rt[0] * fw[2], rt[0] * fw[1] - rt[1] * fw[0]];
      for (const g of MP.ghosts.values()) {
        const e = g.e, t = g.t, k = Math.min(1, dt * 12);
        e.world = w; if (e.invuln > 0) e.invuln -= dt; if (e.hurtTime > 0) e.hurtTime -= dt;
        if (!isFinite(t.x) || !isFinite(t.y) || !isFinite(t.z)) { g.label.style.display = 'none'; continue; }
        const ox = e.x, oz = e.z;
        if (e.y < -500) { e.x = t.x; e.y = t.y; e.z = t.z; }
        e.x += (t.x - e.x) * k; e.y += (t.y - e.y) * k; e.z += (t.z - e.z) * k;
        let dy = (t.yaw || 0) - e.yaw; dy = Math.atan2(Math.sin(dy), Math.cos(dy)); e.yaw += dy * k; e.pitch = t.pitch || 0;
        e.vx = (e.x - ox) / (dt || 0.016); e.vz = (e.z - oz) / (dt || 0.016); e.bobPhase += Math.hypot(e.vx, e.vz) * dt * 2.2;
        if (t.rd) { if (!e.riding || e.riding._nid !== (t.ride && t.ride.nid)) e.riding = (t.ride && game.entities.find((x) => x._nid === t.ride.nid)) || { _nid: null }; } else e.riding = null;
        e.sneaking = !!t.sn; e.swingTime = t.sw ? 0.14 : 0; e.dead = !!t.dead; if (isFinite(t.hp)) e.health = t.hp;
        const txt = g.name + '  ❤' + (isFinite(t.hp) ? t.hp : 20) + (t.dead ? ' ☠' : ''); if (g.label.textContent !== txt) g.label.textContent = txt;
        const d = [e.x - cam.x, e.y + 2.1 - cam.y, e.z - cam.z], zc = d[0] * fw[0] + d[1] * fw[1] + d[2] * fw[2];
        if (zc < 0.2 || zc > 120) { g.label.style.display = 'none'; continue; }
        const xc = d[0] * rt[0] + d[1] * rt[1] + d[2] * rt[2], yc = d[0] * up[0] + d[1] * up[1] + d[2] * up[2];
        g.label.style.display = 'block'; g.label.style.left = (W / 2 + xc / zc * f * H / 2) + 'px'; g.label.style.top = (H / 2 - yc / zc * f * H / 2) + 'px';
      }
    }
    requestAnimationFrame(tick);
    extras(game, C, s, relay, origItem);
  }
  // ======== v3: riding/interactions/trades/signs/fx/ambient/chunks/heartbeat ========
  function extras(game, C, s, relay, origItem) {
    const { Game, Player, World, UI, makeStack, packPos } = C;
    const inRange = (x, z, r) => { const p = game.player; return p && Math.hypot(p.x - x, p.z - z) < r; };

    // ---- interactions with host-owned mobs (feed/tame/shear/breed/milk/sit) ----
    const origInteract = Player.prototype.interactMob;
    Player.prototype.interactMob = function (e) {
      if (!e || !e._remote || hostSim() || this !== game.player) return origInteract.call(this, e);
      const held = this.inventory.held, hid = held ? held.id : null;
      MP.noSpawn++; let r;
      try { r = origInteract.call(this, e); } finally { MP.noSpawn--; }   // local inventory effects & feedback
      if (r && e.kind === 'mob' && e.type !== 'merchant' && this.riding !== e) relay('host', { t: 'interact', nid: e._nid, held: hid });
      return r;
    };
    const origSpawnItem = Game.prototype.spawnItem;
    Game.prototype.spawnItem = function (x, y, z, id, n, pop, dur) {
      if (MP.noSpawn) return new C.ItemEntity(this, x, y, z, makeStack(id, n, dur));   // host will create the real drop
      return origSpawnItem.call(this, x, y, z, id, n, pop, dur);
    };
    function hostInteract(m) {
      const g = game, e = g.entities.find((x) => x._nid === m.nid), gh = MP.ghosts.get(m.from);
      if (!e || e.dead) return;
      const fa = Object.create(Player.prototype);
      Object.assign(fa, { game: g, world: g.world, x: gh ? gh.e.x : e.x, y: gh ? gh.e.y : e.y, z: gh ? gh.e.z : e.z, yaw: 0, pitch: 0, riding: null, effects: {}, dead: false,
        swingTime: 0, swingDur: 0.28, _ghost: m.from,
        inventory: { held: m.held != null ? makeStack(m.held, 2) : null, slots: [], selected: 0, armor: [], consumeHeld() {}, wearHeld() {}, add() { return 0; }, changed() {}, count() { return 99; }, remove() {} } });
      fa.inventory.slots[0] = fa.inventory.held; fa.swing = () => {}; fa.mount = () => {};
      const toast = g.ui.toast, ach = g.achieve; g.ui.toast = () => {}; g.achieve = () => {};
      try { origInteract.call(fa, e); } catch (er) { console.warn('[mp] interact', er); } finally { g.ui.toast = toast; g.achieve = ach; }
    }

    // ---- merchant trades: host decides stock ----
    const origTrade = UI.prototype.doTrade;
    const pendingTrade = new Map();
    UI.prototype.doTrade = function (o) {
      const m = this.tradeWith;
      if (!m || !m._remote || hostSim()) return origTrade.call(this, o);
      const inv = game.player.inventory, idx = m.offers.indexOf(o);
      if (o.left <= 0 || !o.give.every(([id, n]) => inv.count(id) >= n) || idx < 0) return;
      pendingTrade.set(m._nid + ':' + idx, o); relay('host', { t: 'trade', nid: m._nid, idx });
    };
    function hostTrade(m) {
      const e = game.entities.find((x) => x._nid === m.nid), o = e && e.offers && e.offers[m.idx];
      const ok = !!(o && o.left > 0); if (ok) { o.left--; if (e.type === 'villager' && e.rec) try { const rc = e.rec(); rc.u[o.i] = (rc.u[o.i] || 0) + 1; rc.t++; } catch (er) {} }
      relay(m.from, { t: 'tradeRes', nid: m.nid, idx: m.idx, ok, left: o ? o.left : 0 });
      if (game.ui.tradeWith === e) try { game.ui.renderTrade(); } catch (er) {}
    }
    function tradeRes(m) {
      const key = m.nid + ':' + m.idx, o = pendingTrade.get(key); pendingTrade.delete(key);
      const ui = game.ui, me = ui.tradeWith;
      if (!o) return;
      if (m.ok) { o.left = Math.max(1, o.left); origTrade.call(ui, o); o.left = m.left; } else { o.left = 0; ui.toast && ui.toast('אזל אצל הרוכל', 1.6); }
      if (me) try { ui.renderTrade(); } catch (er) {}
    }

    // ---- signs ----
    const origSign = World.prototype.setSign;
    World.prototype.setSign = function (x, y, z, text) {
      const r = origSign.call(this, x, y, z, text);
      if (online() && !MP.applying && this === game.world) s.emit('sign', { x, y, z, text: String(text || '').slice(0, 60) });
      return r;
    };
    const applySign = (d) => { const w = game.world; if (!w) { (MP.signQ = MP.signQ || []).push(d); return; } MP.applying = true; try { origSign.call(w, d.x, d.y, d.z, d.text); const c = w.getChunk(d.x >> 4, d.z >> 4); if (c && w.dirtySet) { c.urgent = true; w.dirtySet.add(c); } } catch (e) {} finally { MP.applying = false; } };
    s.on('sign', applySign);
    s.on('joined', (d) => { for (const v of d.signs || []) applySign(v); });

    // ---- visual effects broadcast ----
    const FX = ['blockParticles', 'hitParticles', 'smoke', 'splash', 'fizzAt'];
    const fxOut = [];
    for (const name of FX) {
      const f = Game.prototype[name]; if (typeof f !== 'function') continue;
      Game.prototype[name] = function () {
        if (online() && !MP.fxIn && !MP.swapping && fxOut.length < 40) fxOut.push([name, ...Array.prototype.map.call(arguments, (a) => (typeof a === 'number' ? +a.toFixed(2) : a))]);
        return f.apply(this, arguments);
      };
    }
    const origHearts = Game.prototype.hearts;
    if (origHearts) Game.prototype.hearts = function (e, n) { if (online() && !MP.fxIn && e) fxOut.push(['hearts', +e.x.toFixed(2), +e.y.toFixed(2), +e.z.toFixed(2), e.h || 1, n]); return origHearts.call(this, e, n); };
    const origBoom = Game.prototype.explode;
    Game.prototype.explode = function (x, y, z, r, byPlayer) {
      const res = origBoom.call(this, x, y, z, r, byPlayer);
      if (online()) {
        fxOut.push(['boom', x, y, z]);
        for (const g of MP.ghosts.values()) { const e = g.e; if (e.dead || e.y < -500) continue; const ex = e.x - x, ey = e.y + 0.9 - y, ez = e.z - z, d = Math.hypot(ex, ey, ez); if (d > r * 2) continue; const k = 1 - d / (r * 2); relay(g.e._ghost, { t: 'hurt', amt: Math.round(k * 15), sx: x, sz: z, cause: 'explosion', knock: k * 2 }); }
      }
      return res;
    };
    const origLight = Game.prototype.lightning;
    if (origLight) Game.prototype.lightning = function () { const r = origLight.apply(this, arguments); if (online()) fxOut.push(['thunder']); return r; };
    setInterval(() => { if (fxOut.length && online()) s.emit('fx', fxOut.splice(0, 40)); }, 100);
    s.on('fx', (list) => {
      const g = game; if (!g.world || !g.player || g.state === 'loading') return;
      MP.fxIn = true;
      try {
        for (const a of list) {
          const [name, x, y, z] = a;
          if (name === 'thunder') { g.flash = 1; g.audio.thunder(40); continue; }
          if (!inRange(x, z, 80)) continue;
          if (name === 'boom') { for (let i = 0; i < 6; i++) g.smoke(x + (Math.random() - 0.5) * 2, y + Math.random(), z + (Math.random() - 0.5) * 2); g.audio.explode(x, y, z); const p = g.player; g.shake = Math.max(g.shake || 0, Math.max(0, Math.min(1, 1.2 - Math.hypot(p.x - x, p.y - y, p.z - z) / 25))); continue; }
          if (name === 'hearts') { origHearts.call(g, { x, y, z, h: a[4] }, a[5]); continue; }
          const f = Game.prototype[name]; if (f) f.apply(g, a.slice(1));
        }
      } catch (e) {} finally { MP.fxIn = false; }
    });

    // ---- ambient: butterflies are host entities (around everyone); fireflies seeded from world seed + time + place ----
    const origBut = Game.prototype.butterflies;
    Game.prototype.butterflies = function () {
      if (!hostSim()) return;
      origBut.call(this);
      if (MP.isHost) { const real = this.player; for (const gh of [...MP.ghosts.values()].map((g) => g.e)) { if (gh.dead || gh.y < -500) continue; this.player = gh; try { origBut.call(this); } catch (e) {} finally { this.player = real; } } }
    };
    const origFire = Game.prototype.fireflies;
    function mulberry(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
    Game.prototype.fireflies = function () {
      if (!online()) return origFire.call(this);
      const p = this.player, cx = Math.floor(p.x / 16), cz = Math.floor(p.z / 16), tb = Math.floor(((this.day || 1) * 1 + (this.timeOfDay || 0)) * 6000);
      const rnd = mulberry((this.world.seed | 0) ^ Math.imul(cx, 73856093) ^ Math.imul(cz, 19349663) ^ Math.imul(tb, 83492791));
      const R = Math.random, ox = p.x, oz = p.z; Math.random = rnd; p.x = cx * 16 + 8; p.z = cz * 16 + 8;
      try { return origFire.call(this); } finally { Math.random = R; p.x = ox; p.z = oz; }
    };

    // ---- host keeps chunks loaded around every player, so fluids/crops/spawning work everywhere ----
    const origUnload = World.prototype.unloadChunk;
    World.prototype.unloadChunk = function (c) {
      if (MP.isHost && this === game.world) { const R = (game.renderer.settings.renderDistance || 6) + 3; for (const g of MP.ghosts.values()) { const e = g.e; if (e.y < -500) continue; const dx = c.cx - (Math.floor(e.x) >> 4), dz = c.cz - (Math.floor(e.z) >> 4); if (dx * dx + dz * dz <= R * R) return; } }
      return origUnload.call(this, c);
    };
    const origChunks = Game.prototype.updateChunks;
    Game.prototype.updateChunks = function (budget) {
      const r = origChunks.call(this, budget);
      if (MP.isHost && MP.ghosts.size && this.world) {
        const w = this.world, t0 = performance.now(), G = 3;
        outer: for (const g of MP.ghosts.values()) {
          const e = g.e; if (e.y < -500 || !isFinite(e.x)) continue;
          const pcx = Math.floor(e.x) >> 4, pcz = Math.floor(e.z) >> 4;
          for (let dz = -G; dz <= G; dz++) for (let dx = -G; dx <= G; dx++) {
            if (performance.now() - t0 > 3) break outer;
            const k = C.ckey ? C.ckey(pcx + dx, pcz + dz) : null;
            if (k !== null ? !w.chunks.has(k) : !w.getChunk(pcx + dx, pcz + dz)) { try { w.generateChunk(pcx + dx, pcz + dz); } catch (er) {} }
          }
        }
      }
      return r;
    };

    // ---- heartbeat / visibility (server migrates host away from inactive or hidden tabs) ----
    const beat = () => { if (online()) s.emit('hb', { hidden: !!document.hidden }); };
    setInterval(beat, 1000); document.addEventListener('visibilitychange', beat);

    // ---- relays handled here ----
    s.on('relay', (m) => {
      if (m.t === 'tradeRes') return tradeRes(m);
      if (!MP.isHost) return;
      if (m.t === 'interact') hostInteract(m);
      else if (m.t === 'trade') hostTrade(m);
    });
    setInterval(() => { if (MP.signQ && game.world) { const q = MP.signQ; MP.signQ = null; q.forEach(applySign); } }, 500);
  }

  if (document.readyState === 'complete') setTimeout(boot, 0); else addEventListener('load', () => setTimeout(boot, 0));
})();
