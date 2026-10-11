// two socket.io clients in one room: join/host/state/edits/chests/env/relay/leave + host re-election
const { io } = require('socket.io-client'); const U = process.argv[2] || 'http://localhost:3000';
const room = 't' + Date.now(), got = {}, ok = (k, v) => { got[k] = v === undefined ? true : v; };
const a = io(U, { transports: ['websocket'] }), b = io(U, { transports: ['websocket'] });
a.on('connect', () => a.emit('join', { room, name: 'A' }));
a.on('joined', (d) => { ok('aIsHost', d.host === a.id); a.emit('world', { seed: 1234 }); a.emit('chestSet', { k: 99, arr: [[5, 3, -1]] }); a.emit('env', { t: 0.4, day: 3, w: { rain: 1 } }); setTimeout(() => b.emit('join', { room, name: 'B' }), 200); });
b.on('connect', () => {});
b.on('joined', (d) => { ok('bSeed', d.seed); ok('bChest', JSON.stringify(d.chests)); ok('bEnv', d.env && d.env.t); ok('bHost=A', d.host === a.id);
  b.emit('state', { x: 1, y: 2, z: 3, yaw: 0.5, pitch: 0, hp: 17 }); b.emit('edits', [{ x: 5, y: 4, z: 5, id: 3, m: 0 }, { x: 500, y: 4, z: 5, id: 3, m: 0 }]); b.emit('sign', { x: 2, y: 3, z: 3, text: 'shalom' }); b.emit('relay', { to: 'host', t: 'mobHurt', nid: 'n1', amt: 4 }); b.emit('chestGet', 99); });
b.on('chestData', (d) => ok('bChestGet', JSON.stringify(d.arr)));
a.on('pjoin', p => ok('aSawJoin', p.name));
b.on('rejected', n => ok('farEditRejected', n));
a.on('sign', v => ok('aGotSign', v.text));
a.on('state', d => ok('aGotState', d.x + ',' + d.y + ',' + d.z + ' hp' + d.hp));
a.on('edits', e => { ok('aGotEdit', JSON.stringify(e)); a.emit('snap', { l: [['n1', 'Gazelle', 1, 2, 3, 0, 10, 0, 0]] }); a.emit('env', { t: 0.5, day: 3, w: {} }); });
a.on('relay', m => ok('aGotRelay', m.t + ' from B=' + (m.from === b.id)));
b.on('snap', d => ok('bGotSnap', d.l[0][1]));
b.on('env', d => { if (got.bGotEnv) return; ok('bGotEnv', d.t); setInterval(() => b.emit('hb', { hidden: false }), 500); setTimeout(() => a.emit('hb', { hidden: true }), 300); });  // host tab hidden -> migrate
b.on('host', d => { ok('bBecameHost(hidden host)', d.id === b.id); console.log(JSON.stringify(got, null, 1)); b.close(); process.exit(Object.keys(got).length >= 15 ? 0 : 1); });
setTimeout(() => { console.log('TIMEOUT', JSON.stringify(got, null, 1)); process.exit(1); }, 8000);
