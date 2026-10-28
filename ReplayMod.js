// ==UserScript==
// @name         Narrow.one - Battle Log (Replays) + Free cam + Rename + Export
// @namespace    local
// @version      1.1
// @description  Records matches and replays them. Free cam (F), pause (P), previous/next player POV (, and .), rename, export to .n1replay, import / watch from file. You can see yourself playing the match and view the POV of other players. This script is made by Claude based on 5 scripts made by Aspect, debugged by Grok, checked by Aspect.
// @author       Claude / Grok / EF Aspect
// @match        https://narrow.one/*
// @run-at       document-start
// @grant        none
// ==/UserScript==
(() => {
  'use strict';
  const BOOT = Symbol.for('narrowReplayBoot');
  if (window[BOOT]) return;
  window[BOOT] = true;

  const MAX_REPLAYS = 30;
  const MIN_DURATION_MS = 15000;
  const AUTOSAVE_MS = 90000; // less frequent full packs while playing
  const MAX_NAME_LEN = 40;
  const SKIP_WHEN_RECORDING = new Set([20, 24, 55]);
  // 9 keepalive (client would answer), 20 reconnect token, 23 coins, 24 guest account, 27/28 squad,
  // 55 server code, 61 forced logout: a replay file must never trigger any of these
  const SKIP_WHEN_REPLAYING = new Set([9, 20, 23, 24, 27, 28, 55, 61]);

  // Replay feed budget (kept light; lag report was recording-only)
  const FEED_BUDGET_MS = 4;
  const FEED_MAX = 80;

  // ------------------------------------------------------------------ main instance
  // The game's Main instance is module-private. Its constructor calls this.vsyncLoop.bind(this),
  // so we catch the instance there (the hook is installed at document-start, before the game loads).
  let mainRef = null;
  const nativeBind = Function.prototype.bind;
  Function.prototype.bind = function (thisArg, ...args) {
    try {
      if (!mainRef && thisArg && thisArg.gameManager && thisArg.network && thisArg.cam && thisArg.mainMenu) {
        mainRef = thisArg;
      }
    } catch {}
    return nativeBind.call(this, thisArg, ...args);
  };

  function getMain() {
    if (mainRef && mainRef.gameManager) return mainRef;
    try {
      if (typeof po === 'function') {
        const m = po();
        if (m && m.gameManager) return (mainRef = m);
      }
    } catch {}
    try {
      if (typeof globalThis.__getMain === 'function') {
        const m = globalThis.__getMain();
        if (m && m.gameManager) return (mainRef = m);
      }
    } catch {}
    return null;
  }

  const $ = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  const p2 = (n) => String(n).padStart(2, '0');
  const fmtDate = (ts) => {
    const d = new Date(ts);
    return `${p2(d.getDate())}/${p2(d.getMonth() + 1)}/${p2(d.getFullYear() % 100)} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
  };
  const fmtDur = (ms) => {
    const s = Math.max(0, Math.round(ms / 1000));
    return `${Math.floor(s / 60)}:${p2(s % 60)}`;
  };
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const alertBox = (title, text) => {
    const main = getMain();
    try {
      main.dialogManager.showAlert({ title, text });
    } catch {
      alert(title + '\n' + text);
    }
  };

  /** Fast copy; ArrayBuffer.slice is enough for WS buffers. */
  function copyBuf(src) {
    if (src instanceof ArrayBuffer) return src.slice(0);
    if (ArrayBuffer.isView(src)) {
      const out = new ArrayBuffer(src.byteLength);
      new Uint8Array(out).set(
        new Uint8Array(src.buffer, src.byteOffset, src.byteLength)
      );
      return out;
    }
    return null;
  }

  const readStr = (buf, off) => {
    try {
      const len = new DataView(buf).getUint32(off, true);
      return new TextDecoder().decode(new Uint8Array(buf, off + 4, len));
    } catch {
      return null;
    }
  };

  const mapNameFor = (hash) => {
    try {
      return getMain().config.mapsConfig.getListedMapConfigByHash(hash)?.name || 'Unknown map';
    } catch {
      return 'Unknown map';
    }
  };

  const replayTitle = (m) => m.name || fmtDate(m.startedAt);

  // ------------------------------------------------------------------ storage
  const dbp = new Promise((res, rej) => {
    const r = indexedDB.open('narrowReplays', 1);
    r.onupgradeneeded = () => {
      r.result.createObjectStore('meta', { keyPath: 'id' });
      r.result.createObjectStore('data');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  const reqP = (r) =>
    new Promise((res, rej) => {
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  const idb = {
    async put(meta, data) {
      const db = await dbp;
      await new Promise((res, rej) => {
        const t = db.transaction(['meta', 'data'], 'readwrite');
        t.objectStore('meta').put(meta);
        t.objectStore('data').put(data, meta.id);
        t.oncomplete = res;
        t.onerror = t.onabort = () => rej(t.error);
      });
    },
    async putMeta(meta) {
      const db = await dbp;
      await new Promise((res, rej) => {
        const t = db.transaction('meta', 'readwrite');
        t.objectStore('meta').put(meta);
        t.oncomplete = res;
        t.onerror = t.onabort = () => rej(t.error);
      });
    },
    async getMeta(id) {
      const db = await dbp;
      return reqP(db.transaction('meta').objectStore('meta').get(id));
    },
    async list() {
      const db = await dbp;
      return reqP(db.transaction('meta').objectStore('meta').getAll());
    },
    async get(id) {
      const db = await dbp;
      return reqP(db.transaction('data').objectStore('data').get(id));
    },
    async del(id) {
      const db = await dbp;
      await new Promise((res, rej) => {
        const t = db.transaction(['meta', 'data'], 'readwrite');
        t.objectStore('meta').delete(id);
        t.objectStore('data').delete(id);
        t.oncomplete = res;
        t.onerror = t.onabort = () => rej(t.error);
      });
    },
  };

  async function prune() {
    // newest saved first (id = when it was recorded or imported)
    const all = (await idb.list()).sort((a, b) => b.id - a.id);
    for (const m of all.slice(MAX_REPLAYS)) await idb.del(m.id);
  }

  function pack(messages) {
    let total = 0;
    for (let i = 0; i < messages.length; i++) total += 12 + messages[i].buf.byteLength;
    const out = new ArrayBuffer(total);
    const dv = new DataView(out);
    const u8 = new Uint8Array(out);
    let o = 0;
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      dv.setFloat64(o, m.t, true);
      dv.setUint32(o + 8, m.buf.byteLength, true);
      u8.set(new Uint8Array(m.buf), o + 12);
      o += 12 + m.buf.byteLength;
    }
    return out;
  }

  function unpack(data) {
    const dv = new DataView(data);
    const msgs = [];
    let o = 0;
    while (o + 12 <= data.byteLength) {
      const t = dv.getFloat64(o, true);
      const len = dv.getUint32(o + 8, true);
      msgs.push({ t, buf: data.slice(o + 12, o + 12 + len) });
      o += 12 + len;
    }
    return msgs;
  }

  // ------------------------------------------------------------------ .n1replay files
  // Layout: "N1RP" | version u8 | flags u8 (bit0 = payload gzipped) | 2 reserved | metaLen u32 | meta JSON | payload
  const FILE_MAGIC = 'N1RP';
  const FILE_VERSION = 1;
  const MAX_META_BYTES = 64 * 1024;
  const MAX_DATA_BYTES = 300 * 1024 * 1024;
  const MAX_MSG_BYTES = 1024 * 1024;
  const MAX_MSGS = 3000000;

  async function streamToBuffer(stream, cap) {
    const reader = stream.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > cap) {
        try { await reader.cancel(); } catch {}
        throw new Error('The replay is too large');
      }
      chunks.push(value);
    }
    const out = new Uint8Array(total);
    let o = 0;
    for (const c of chunks) {
      out.set(c, o);
      o += c.byteLength;
    }
    return out.buffer;
  }

  async function gzip(buf) {
    if (typeof CompressionStream !== 'function') return null;
    try {
      return await streamToBuffer(new Blob([buf]).stream().pipeThrough(new CompressionStream('gzip')), MAX_DATA_BYTES);
    } catch {
      return null;
    }
  }

  async function gunzip(buf) {
    if (typeof DecompressionStream !== 'function') {
      throw new Error('This browser cannot open compressed replay files');
    }
    return streamToBuffer(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip')), MAX_DATA_BYTES);
  }

  /** Strict check of the packed messages: sizes, order, and that it really starts like a match. */
  function validateMessages(data) {
    const dv = new DataView(data);
    let o = 0;
    let count = 0;
    let lastT = 0;
    while (o < data.byteLength) {
      if (o + 12 > data.byteLength) throw new Error('Replay file is damaged');
      const t = dv.getFloat64(o, true);
      const len = dv.getUint32(o + 8, true);
      if (!Number.isFinite(t) || t < lastT) throw new Error('Replay file is damaged');
      if (len < 4 || len > MAX_MSG_BYTES || o + 12 + len > data.byteLength) throw new Error('Replay file is damaged');
      if (count === 0 && dv.getUint32(o + 12, true) !== 0) throw new Error('This is not a match replay');
      lastT = t;
      count++;
      if (count > MAX_MSGS) throw new Error('The replay is too large');
      o += 12 + len;
    }
    if (count === 0) throw new Error('The replay is empty');
    return { count, lastT };
  }

  async function buildReplayFile(meta, data) {
    const packed = await gzip(data);
    const payload = packed || data;
    const info = {
      name: meta.name || undefined,
      startedAt: meta.startedAt,
      durationMs: meta.durationMs,
      mapHash: meta.mapHash,
      mapName: meta.mapName,
      myId: meta.myId,
      flags: meta.flags,
      kills: meta.kills,
      deaths: meta.deaths,
      score: meta.score,
      ended: !!meta.ended,
      selfMoves: !!meta.selfMoves,
    };
    const metaBytes = new TextEncoder().encode(JSON.stringify(info));
    const head = new ArrayBuffer(12);
    const hv = new DataView(head);
    new Uint8Array(head).set([0x4e, 0x31, 0x52, 0x50]); // "N1RP"
    hv.setUint8(4, FILE_VERSION);
    hv.setUint8(5, packed ? 1 : 0);
    hv.setUint32(8, metaBytes.length, true);
    return new Blob([head, metaBytes, payload], { type: 'application/octet-stream' });
  }

  async function parseReplayFile(file) {
    if (file.size > MAX_DATA_BYTES) throw new Error('The replay is too large');
    const buf = await file.arrayBuffer();
    if (buf.byteLength < 12) throw new Error('This is not a .n1replay file');
    const dv = new DataView(buf);
    const magic = String.fromCharCode(...new Uint8Array(buf, 0, 4));
    if (magic !== FILE_MAGIC) throw new Error('This is not a .n1replay file');
    if (dv.getUint8(4) !== FILE_VERSION) throw new Error('This replay file version is not supported');
    const flags = dv.getUint8(5);
    const metaLen = dv.getUint32(8, true);
    if (metaLen > MAX_META_BYTES || 12 + metaLen > buf.byteLength) throw new Error('Replay file is damaged');
    let raw;
    try {
      raw = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 12, metaLen)));
    } catch {
      throw new Error('Replay file is damaged');
    }
    if (!raw || typeof raw !== 'object') throw new Error('Replay file is damaged');
    let data = buf.slice(12 + metaLen);
    if (flags & 1) data = await gunzip(data);
    const info = validateMessages(data);

    const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
    const num = (v) => (Number.isFinite(v) ? v : 0);
    const mapHash = str(raw.mapHash, 200);
    if (!mapHash) throw new Error('Replay file is damaged');
    const meta = {
      id: 0,
      startedAt: num(raw.startedAt) || Date.now(),
      durationMs: info.lastT,
      mapHash,
      mapName: str(raw.mapName, 80) || 'Unknown map',
      myId: Number.isInteger(raw.myId) ? raw.myId : null,
      flags: num(raw.flags),
      kills: num(raw.kills),
      deaths: num(raw.deaths),
      score: num(raw.score),
      bytes: data.byteLength,
      ended: !!raw.ended,
      selfMoves: !!raw.selfMoves,
      imported: true,
    };
    const nm = (str(raw.name, MAX_NAME_LEN) || file.name.replace(/\.n1replay$/i, '').slice(0, MAX_NAME_LEN)).trim();
    if (nm) meta.name = nm;
    return { meta, data };
  }

  async function saveImported(meta, data) {
    const used = new Set((await idb.list()).map((m) => m.id));
    let id = Date.now();
    while (used.has(id)) id++;
    meta.id = id;
    await idb.put(meta, data);
    await prune();
  }

  function fileNameFor(m) {
    const base = replayTitle(m)
      .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 60);
    return (base || 'replay') + '.n1replay';
  }

  function downloadBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 15000);
  }

  // ------------------------------------------------------------------ recording (FPS-sensitive)
  let activeRec = null;

  /**
   * The server never sends you your own movement, so it is not in what we receive. To be able to watch yourself,
   * the few packets the client sends about its own player are stored in the same format the server uses
   * for other players (position/look, arrows, actions, class and weapon changes).
   */
  function convertOutgoing(op, src) {
    const len = src.byteLength;
    if (op === 2 && len >= 16) {
      // my position + look direction -> a "player positions" packet with one entry
      const out = new ArrayBuffer(18);
      const o = new DataView(out);
      const s = new DataView(src);
      o.setUint32(0, 4, true);
      o.setUint16(4, 0, true);
      for (let i = 0; i < 6; i++) o.setUint16(6 + i * 2, s.getUint16(4 + i * 2, true), true);
      return out;
    }
    if (op === 3 && len >= 22) {
      // my arrow -> "arrow created" (same layout, different opcode)
      const out = src.slice(0, 22);
      new DataView(out).setUint32(0, 5, true);
      return out;
    }
    if ((op === 9 || op === 10 || op === 26) && len >= 12) {
      // jump / fire / die, class change, weapon type -> what the server tells others
      const out = src.slice(0, 12);
      new DataView(out).setUint32(0, op === 9 ? 15 : op === 10 ? 18 : 37, true);
      return out;
    }
    return null;
  }

  function scheduleSave(rec, urgent) {
    if (!rec || rec.saveQueued) return;
    rec.saveQueued = true;
    const run = () => {
      rec.saveQueued = false;
      saveRec(rec);
    };
    if (urgent) {
      // tab closing — still async but sooner
      setTimeout(run, 0);
      return;
    }
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(run, { timeout: 5000 });
    } else {
      setTimeout(run, 0);
    }
  }

  async function saveRec(rec) {
    if (!rec.mapHash || !rec.messages.length) return;
    if (rec.saving) {
      rec.again = true;
      return;
    }
    // Skip if nothing new since last successful save (big FPS win while playing)
    if (
      rec.messages.length === rec.lastSavedLen &&
      rec.ended === rec.lastSavedEnded
    ) {
      return;
    }
    const duration = rec.messages[rec.messages.length - 1].t;
    if (duration < MIN_DURATION_MS && !rec.ended) return;

    rec.saving = true;
    try {
      const sc = rec.scores.get(rec.myId) || [0, 0, 0, 0];
      // Pack can be large — we only reach here from idle / timer / leave
      const data = pack(rec.messages);
      const meta = {
        id: rec.startedAt,
        startedAt: rec.startedAt,
        durationMs: duration,
        mapHash: rec.mapHash,
        mapName: mapNameFor(rec.mapHash),
        myId: rec.myId,
        flags: sc[0],
        kills: sc[1],
        deaths: sc[2],
        score: sc[3],
        bytes: data.byteLength,
        ended: rec.ended,
        selfMoves: rec.selfMoves || rec.serverSendsSelf,
      };
      try {
        const old = await idb.getMeta(rec.startedAt);
        if (old && old.name) meta.name = old.name;
      } catch {}
      await idb.put(meta, data);
      rec.lastSavedLen = rec.messages.length;
      rec.lastSavedEnded = rec.ended;
      await prune();
    } catch (e) {
      console.warn('[replay] save failed', e);
    } finally {
      rec.saving = false;
      if (rec.again) {
        rec.again = false;
        scheduleSave(rec, false);
      }
    }
  }

  function attachRecorder(ws) {
    let rec = null;

    // Hot path: minimize work per packet
    ws.addEventListener('message', (e) => {
      if (R.active) return;
      const raw = e.data;
      if (typeof raw === 'string') return;
      if (!(raw instanceof ArrayBuffer)) {
        // Blob path is rare for game socket; handle off-tick
        if (raw instanceof Blob) {
          raw.arrayBuffer().then((ab) => onPacket(ab)).catch(() => {});
        }
        return;
      }
      onPacket(raw);
    });

    function onPacket(buf0) {
      // Op only — 4 bytes — before full copy when skipping
      if (buf0.byteLength < 4) return;
      const op = new DataView(buf0).getUint32(0, true);

      if (op === 0) {
        if (rec) scheduleSave(rec, true);
        rec = {
          startedAt: Date.now(),
          t0: performance.now(),
          messages: [],
          scores: new Map(),
          mapHash: null,
          myId: null,
          ended: false,
          saving: false,
          again: false,
          saveQueued: false,
          lastSavedLen: 0,
          lastSavedEnded: false,
          selfMoves: false,
          serverSendsSelf: false,
          selfDecided: false,
          selfChecks: 0,
        };
        activeRec = rec;
      }

      if (!rec || SKIP_WHEN_RECORDING.has(op)) return;

      const buf = copyBuf(buf0);
      if (!buf) return;

      // push only — no object alloc beyond {t,buf}
      rec.messages.push({ t: performance.now() - rec.t0, buf });

      // Meta updates only for rare ops
      if (op === 14) {
        try {
          rec.mapHash = readStr(buf, 4);
        } catch {}
      } else if (op === 3 && buf.byteLength >= 12) {
        const id = new DataView(buf).getUint32(4, true);
        const own = new DataView(buf).getUint32(8, true);
        if (own === 1) rec.myId = id;
      } else if (op === 17 && buf.byteLength >= 24) {
        const dv = new DataView(buf);
        const id = dv.getUint32(4, true);
        rec.scores.set(id, [
          dv.getUint32(8, true),
          dv.getUint32(12, true),
          dv.getUint32(16, true),
          dv.getUint32(20, true),
        ]);
      } else if (op === 11) {
        rec.ended = true;
        scheduleSave(rec, true);
      } else if (op === 4 && !rec.selfDecided && rec.myId != null) {
        // does the server already send my own position? (then we must not add our own copy)
        const dv = new DataView(buf);
        for (let o = 6; o + 12 <= buf.byteLength; o += 12) {
          if (dv.getUint16(o, true) === rec.myId) {
            rec.serverSendsSelf = true;
            rec.selfDecided = true;
            break;
          }
        }
        if (!rec.selfDecided && ++rec.selfChecks >= 200) rec.selfDecided = true;
      }
    }

    // what the client sends about its own player (see convertOutgoing)
    const origSend = ws.send;
    ws.send = function (data) {
      try {
        if (rec && !R.active) {
          let src = null;
          if (data instanceof ArrayBuffer) src = data;
          else if (ArrayBuffer.isView(data)) src = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
          if (src && src.byteLength >= 12) {
            const op = new DataView(src).getUint32(0, true);
            if (!(op === 2 && rec.serverSendsSelf)) {
              const out = convertOutgoing(op, src);
              if (out) {
                if (op === 2) rec.selfMoves = true;
                rec.messages.push({ t: performance.now() - rec.t0, buf: out });
              }
            }
          }
        }
      } catch {}
      return origSend.apply(this, arguments);
    };

    ws.addEventListener('close', () => {
      if (rec) {
        scheduleSave(rec, true);
        if (activeRec === rec) activeRec = null;
        rec = null;
      }
    });
  }

  const NativeWS = window.WebSocket;
  window.WebSocket = new Proxy(NativeWS, {
    construct(target, args) {
      const ws = Reflect.construct(target, args);
      try {
        attachRecorder(ws);
      } catch (e) {
        console.warn('[replay] hook failed', e);
      }
      return ws;
    },
  });

  setInterval(() => {
    if (activeRec) scheduleSave(activeRec, false);
  }, AUTOSAVE_MS);

  window.addEventListener('pagehide', () => {
    if (activeRec) scheduleSave(activeRec, true);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && activeRec) {
      scheduleSave(activeRec, true);
    }
  });

  // ------------------------------------------------------------------ replay engine
  const R = {
    active: false,
    msgs: [],
    idx: 0,
    vt: 0,
    total: 0,
    speed: 1,
    paused: false,
    last: 0,
    raf: 0,
    game: null,
    target: null,
    lastTeam: -1,
    lastIcons: 0,
    lastHud: 0,
    hud: null,
    meta: null,
    giveOwnership: false,
    view: 0,
  };
  const SPEEDS = [1, 2, 4, 0.5];
  const VIEWS = ['back', 'front', 'none']; // behind / in front / first person

  // ------------------------------------------------------------------ input lock
  // While a replay runs, the game's own controls (walk, jump, fire, weapons, chat, Y view toggle...) are switched
  // off, so nothing you press can move or shoot a player. The keys are restored when the replay ends.
  const LOCKED_KEYS = [
    'left', 'right', 'up', 'down', 'flyUp', 'flyDown', 'jump', 'fire',
    'prevWeapon', 'nextWeapon', 'toggleWeapon', 'toggleThirdPerson', 'chat',
  ];
  let savedKeys = null;

  function lockGameInput() {
    if (savedKeys) return;
    const main = getMain();
    const keys = main?.input?.keys;
    if (!keys) return;
    savedKeys = [];
    for (const name of LOCKED_KEYS) {
      const k = keys.get(name);
      if (!k) continue;
      savedKeys.push({ k, keyCodes: k.keyCodes, mouseButtons: k.mouseButtons, gamepadButtons: k.gamepadButtons });
      k.keyCodes = [];
      k.mouseButtons = [];
      k.gamepadButtons = [];
      try { k.setKeyPressed(false, true); } catch {}
    }
    try { main.input.updateAxisInputs(); } catch {}
  }

  function unlockGameInput() {
    if (!savedKeys) return;
    for (const s of savedKeys) {
      s.k.keyCodes = s.keyCodes;
      s.k.mouseButtons = s.mouseButtons;
      s.k.gamepadButtons = s.gamepadButtons;
    }
    savedKeys = null;
    try { getMain().input.updateAxisInputs(); } catch {}
  }

  async function startReplay(meta, dataOverride) {
    const main = getMain();
    if (!main) return alertBox('Replay', 'Game not ready yet — wait a second on the menu and try again.');
    if (R.active) return alertBox('Replay running', 'Exit the current replay first.');
    if (main.gameManager.getOnlineGame()) {
      return alertBox('You are in a match', 'Leave your current match before watching a replay.');
    }
    try {
      const mc = main.config.mapsConfig;
      if (mc.loadedConfigData && !mc.getListedMapConfigByHash(meta.mapHash)) {
        return alertBox('Map not available', 'This replay was recorded on a map that your game no longer lists (the map was removed or updated).');
      }
    } catch {}
    const data = dataOverride || (await idb.get(meta.id));
    if (!data) return alertBox('Replay missing', 'The data for this replay could not be found.');

    R.msgs = unpack(data);
    R.total = meta.durationMs;
    R.idx = 0;
    R.vt = 0;
    R.speed = 1;
    R.paused = false;
    R.game = null;
    R.target = meta.myId;
    R.lastTeam = -1;
    R.lastIcons = 0;
    R.lastHud = 0;
    R.meta = meta;
    // New replays contain your own movement, so you are shown like every other player.
    // Old replays do not, there the game keeps its own (standing) player as before.
    R.giveOwnership = !meta.selfMoves;
    R.view = 0;
    R.active = true;
    R.last = performance.now();
    lockGameInput();
    installWrappers(main);
    closeOverlay();
    showHud();
    R.raf = requestAnimationFrame(tick);
  }

  function setupGame() {
    const main = getMain();
    if (!main) return;
    const gm = main.gameManager;
    let g = gm.loadingBackgroundGame;
    if (g) {
      try {
        gm.destroyCurrentGame();
      } catch {}
      gm.activeGame = g;
      gm.loadingBackgroundGame = null;
      try {
        g.becameForegroundGame();
      } catch {}
      try {
        gm.fireCurrentGameChangeCbs();
      } catch {}
    } else {
      g = gm.activeGame;
    }
    R.game = g;
    if (!g) return;
    g.getMyPlayer = () => g.players.get(R.target) || null;
    try {
      g.weaponSelectionDialog.setPlayerVisibility(false);
    } catch {}
    try {
      main.cam.setThirdPersonMode(VIEWS[R.view]);
    } catch {}
    try {
      main.mainMenu.setJoinState('joined');
      gm.setJoinedOnce();
      main.mainMenu.toggledVisibilityState = false;
      main.mainMenu.updateVisibility();
    } catch {}
  }

  function feed(m) {
    const main = getMain();
    if (!main?.network) return;
    const buf = m.buf;
    if (!buf || buf.byteLength < 4) return;
    const op = new DataView(buf).getUint32(0, true);
    if (SKIP_WHEN_REPLAYING.has(op)) return;
    if (op === 3 && buf.byteLength >= 12) {
      const u = new DataView(buf);
      if (u.getUint32(8, true) === 1) {
        R.target = u.getUint32(4, true);
        // do not hand your player to the local input: it is shown from the recorded movement instead
        if (!R.giveOwnership) return;
      }
    }
    try {
      main.network.onMessage(new Uint8Array(buf));
      if (op === 0) setupGame();
    } catch (e) {
      console.warn('[replay] message', op, e);
    }
  }

  function tick(now) {
    if (!R.active) return;
    R.raf = requestAnimationFrame(tick);
    const main = getMain();
    if (!main) return;
    const dt = Math.min(now - R.last, 100);
    R.last = now;

    if (R.game && main.gameManager.getOnlineGame() !== R.game && main.gameManager.activeGame !== R.game) {
      return stopReplay(true);
    }

    if (!R.paused) R.vt = Math.min(R.vt + dt * R.speed, R.total + 2000);

    {
      const t0 = performance.now();
      let n = 0;
      while (
        R.idx < R.msgs.length &&
        R.msgs[R.idx].t <= R.vt &&
        n < FEED_MAX &&
        performance.now() - t0 < FEED_BUDGET_MS
      ) {
        feed(R.msgs[R.idx++]);
        n++;
      }
    }

    const g = R.game;
    if (g) {
      const p = g.getMyPlayer?.();
      if (p && p.teamId !== R.lastTeam) {
        R.lastTeam = p.teamId;
        try {
          g.updateMyTeamColor();
          g.playersListDialog.updateTeamsOrder(p.teamId);
        } catch {}
      }
      if (now - R.lastIcons > 1000) {
        R.lastIcons = now;
        try {
          g.updatePlayerIconVisibilities();
        } catch {}
      }
    }
    if (now - R.lastHud > 100) {
      R.lastHud = now;
      updateHud();
    }
  }

  function stopReplay(alreadyClosed) {
    if (!R.active) return;
    R.active = false;
    cancelAnimationFrame(R.raf);
    disableFreecam();
    removeWrappers();
    unlockGameInput();
    hideHud();
    const main = getMain();
    try {
      if (!alreadyClosed) main?.network?.closeCurrentConnection?.();
      main?.cam?.setThirdPersonMode?.('none');
      main?.mainMenu?.makeMainMenuVisibleFromUserGesture?.();
    } catch (e) {
      console.warn('[replay] exit', e);
    }
    R.msgs = [];
    R.game = null;
    R.target = null;
  }

  /** Take over the POV of the previous (-1) / next (+1) player. Leaves free cam if it was on. */
  function cycleTarget(dir) {
    if (!R.game?.players) return;
    const ids = [...R.game.players.keys()].sort((a, b) => a - b);
    if (!ids.length) return;
    if (FC.on) disableFreecam();
    let i = ids.indexOf(R.target);
    if (i < 0) i = dir > 0 ? -1 : 0;
    i = (i + dir + ids.length) % ids.length;
    R.target = ids[i];
    R.lastTeam = -1;
    try {
      getMain().cam.thirdPersonPhysicsNeedsReset = true;
    } catch {}
  }

  /** Back to the player you recorded (yourself). */
  function viewMyself() {
    if (R.meta && R.meta.myId != null && R.game?.players?.has(R.meta.myId)) {
      R.target = R.meta.myId;
      R.lastTeam = -1;
      disableFreecam();
      try {
        getMain().cam.thirdPersonPhysicsNeedsReset = true;
      } catch {}
    }
  }

  /** Behind -> in front -> first person of the player you follow. */
  function cycleView() {
    R.view = (R.view + 1) % VIEWS.length;
    try {
      const cam = getMain().cam;
      cam.setThirdPersonMode(VIEWS[R.view]);
      cam.thirdPersonPhysicsNeedsReset = true;
    } catch {}
  }

  const togglePause = () => {
    R.paused = !R.paused;
  };
  const cycleSpeed = () => {
    R.speed = SPEEDS[(SPEEDS.indexOf(R.speed) + 1) % SPEEDS.length];
  };
  const skip = (ms) => {
    R.vt = Math.min(R.vt + ms, R.total + 2000);
  };

  // ------------------------------------------------------------------ free cam
  // WASD moves flat over the ground (looking up/down does not change your height).
  // Height only changes with Space / E (up) and Q / Shift (down). X = fast, wheel = speed, F = back to following.
  const FC = {
    on: false,
    wrapped: false,
    restore: null,
    x: 0,
    y: 0,
    z: 0,
    yaw: 0,
    pitch: 0,
    speed: 14,
    keys: new Set(),
    look: [0, 0],
    last: 0,
    _lastDraw: 0,
  };
  const FC_KEYS = new Set([
    'KeyW',
    'KeyA',
    'KeyS',
    'KeyD',
    'KeyE',
    'KeyQ',
    'KeyX',
    'Space',
    'ShiftLeft',
    'ShiftRight',
  ]);

  window.addEventListener(
    'keydown',
    (e) => {
      if (!FC.on) return;
      const tag = e.target && e.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (FC_KEYS.has(e.code)) {
        FC.keys.add(e.code);
        e.stopImmediatePropagation();
        e.preventDefault();
      }
    },
    true
  );
  window.addEventListener(
    'keyup',
    (e) => {
      FC.keys.delete(e.code);
    },
    true
  );
  window.addEventListener('blur', () => FC.keys.clear());
  window.addEventListener(
    'wheel',
    (e) => {
      if (!FC.on) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      FC.speed = clamp(FC.speed * (e.deltaY < 0 ? 1.15 : 1 / 1.15), 1, 150);
    },
    { capture: true, passive: false }
  );

  // Wrappers live for the whole replay: they cancel any walking input (so no player can be moved from the
  // keyboard / gamepad / touch) and, while free cam is on, they turn the mouse into free cam rotation and
  // put the camera at the free cam position.
  function installWrappers(main) {
    if (FC.wrapped) return;
    const input = main.input;
    const cam = main.cam;
    const origInputLoop = input.loop.bind(input);
    const origCamLoop = cam.loop.bind(cam);
    input.loop = function (...args) {
      const r = origInputLoop(...args);
      if (R.active) {
        if (FC.on) {
          FC.look[0] += this.lookInput.x;
          FC.look[1] += this.lookInput.y;
        }
        this.lookInput.set(0, 0);
        this.walkInput.set(0, 0);
      }
      return r;
    };
    cam.loop = function (...args) {
      const r = origCamLoop(...args);
      if (FC.on) applyFreecam(this);
      return r;
    };
    FC.restore = () => {
      input.loop = origInputLoop;
      cam.loop = origCamLoop;
    };
    FC.wrapped = true;
  }

  function removeWrappers() {
    if (FC.restore) {
      try {
        FC.restore();
      } catch {}
    }
    FC.restore = null;
    FC.wrapped = false;
  }

  function applyFreecam(camMgr) {
    const now = performance.now();
    const dt = Math.min((now - FC.last) / 1000, 0.1);
    FC.last = now;
    FC.yaw -= FC.look[0] * 0.002;
    FC.pitch = clamp(FC.pitch - FC.look[1] * 0.002, -1.55, 1.55);
    FC.look[0] = 0;
    FC.look[1] = 0;
    const k = FC.keys;
    const fwd = (k.has('KeyW') ? 1 : 0) - (k.has('KeyS') ? 1 : 0);
    const right = (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0);
    const up =
      (k.has('Space') || k.has('KeyE') ? 1 : 0) -
      (k.has('KeyQ') || k.has('ShiftLeft') || k.has('ShiftRight') ? 1 : 0);
    const fast = k.has('KeyX') ? 3 : 1;
    const v = FC.speed * fast * dt;
    const sy = Math.sin(FC.yaw);
    const cy = Math.cos(FC.yaw);
    // flat movement: only the yaw matters for W/A/S/D, height is changed by `up` alone
    FC.x += (-sy * fwd + cy * right) * v;
    FC.z += (-cy * fwd - sy * right) * v;
    FC.y += up * v;
    const c = camMgr.cam;
    c.position.set(FC.x, FC.y, FC.z);
    c.rotation.order = 'YXZ';
    c.rotation.set(FC.pitch, FC.yaw, 0);
    c.updateMatrixWorld();
    if (now - FC._lastDraw > 50) {
      FC._lastDraw = now;
      try {
        getMain().renderer.renderWorthyEventHappened();
      } catch {}
    }
  }

  function enableFreecam() {
    const main = getMain();
    if (!R.active || !main?.cam?.cam || !main.input) return;
    const e = main.cam.cam.matrixWorld.elements;
    FC.x = e[12];
    FC.y = e[13];
    FC.z = e[14];
    const fx = -e[8],
      fy = -e[9],
      fz = -e[10];
    FC.yaw = Math.atan2(-fx, -fz);
    FC.pitch = Math.asin(clamp(fy, -1, 1));
    FC.keys.clear();
    FC.look = [0, 0];
    FC.last = performance.now();
    FC.on = true;
    installWrappers(main);
  }

  function disableFreecam() {
    if (!FC.on) return;
    FC.on = false;
    FC.keys.clear();
    try {
      getMain().cam.thirdPersonPhysicsNeedsReset = true;
    } catch {}
  }

  const toggleFreecam = () => (FC.on ? disableFreecam() : enableFreecam());

  // Keys:  P pause · F free cam · , previous player POV · . next player POV · M back to yourself
  //        V view (behind / front / first person) · O speed · L +30s · Esc exit
  //        (B / N also work as previous / next player)
  function onKey(e) {
    if (!R.active) return;
    const tag = e.target && e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    if (e.code === 'Escape') return stopReplay(false);
    if (e.repeat) return;
    if (e.code === 'KeyP') togglePause();
    else if (e.code === 'Comma' || e.code === 'KeyB') cycleTarget(-1);
    else if (e.code === 'Period' || e.code === 'KeyN') cycleTarget(1);
    else if (e.code === 'KeyF') toggleFreecam();
    else if (e.code === 'KeyM') viewMyself();
    else if (e.code === 'KeyV') cycleView();
    else if (e.code === 'KeyO') cycleSpeed();
    else if (e.code === 'KeyL') skip(30000);
  }
  window.addEventListener('keydown', onKey, true);

  // ------------------------------------------------------------------ HUD
  function showHud() {
    hideHud();
    const root = $('div');
    root.id = 'tcReplayHud';
    const btn = (label, title, fn) => {
      const b = $('button', 'tc-btn', label);
      b.title = title;
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        fn();
        b.blur();
      });
      return b;
    };
    const title = $('span', 'tc-hud-title', 'REPLAY ' + replayTitle(R.meta));
    const pause = btn('Pause', 'P', togglePause);
    const speed = btn('1x', 'O', cycleSpeed);
    const fwd = btn('+30s', 'L', () => skip(30000));
    const me = btn('Me', 'M — follow yourself', viewMyself);
    const prev = btn('<', ', — previous player POV', () => cycleTarget(-1));
    const name = $('span', 'tc-hud-name', '-');
    const next = btn('>', '. — next player POV', () => cycleTarget(1));
    const view = btn('View', 'V — behind / in front / first person', cycleView);
    const free = btn('Free cam', 'F — WASD move, Space/E up, Q/Shift down, X fast, wheel = speed', toggleFreecam);
    const time = $('span', 'tc-hud-time', '0:00');
    const exit = btn('Exit', 'Esc', () => stopReplay(false));
    exit.classList.add('tc-danger');
    root.append(title, pause, speed, fwd, me, prev, name, next, view, free, time, exit);
    document.body.appendChild(root);
    R.hud = { root, pause, speed, name, time, free };
  }

  function updateHud() {
    const h = R.hud;
    if (!h) return;
    h.pause.textContent = R.paused ? 'Play' : 'Pause';
    h.speed.textContent = R.speed + 'x';
    h.free.textContent = FC.on ? 'Free cam: ON' : 'Free cam';
    h.free.classList.toggle('tc-on', FC.on);
    if (FC.on) {
      h.name.textContent = `FREE CAM · speed ${FC.speed.toFixed(0)}`;
    } else {
      const p = R.game && R.game.players.get(R.target);
      const label = p ? p.playerName || 'Player ' + p.id : '-';
      h.name.textContent = p && R.meta && p.id === R.meta.myId ? label + ' (you)' : label;
    }
    const done = R.idx >= R.msgs.length && R.vt >= R.total;
    h.time.textContent = done
      ? 'Replay finished'
      : `${fmtDur(R.vt)} / ${fmtDur(R.total)}`;
  }

  function hideHud() {
    if (R.hud) R.hud.root.remove();
    R.hud = null;
  }

  // ------------------------------------------------------------------ list UI
  function closeOverlay() {
    document.getElementById('tcReplayOverlay')?.remove();
  }

  function startRename(m, titleEl) {
    const input = $('input', 'tc-input');
    input.type = 'text';
    input.maxLength = MAX_NAME_LEN;
    input.value = m.name || '';
    input.placeholder = fmtDate(m.startedAt);
    titleEl.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = async (save) => {
      if (done) return;
      done = true;
      if (save) {
        const v = input.value.trim().slice(0, MAX_NAME_LEN);
        if (v) m.name = v;
        else delete m.name;
        try {
          await idb.putMeta(m);
        } catch (e) {
          console.warn('[replay] rename failed', e);
        }
      }
      titleEl.textContent = replayTitle(m);
      input.replaceWith(titleEl);
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') finish(true);
      else if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
  }

  async function openList() {
    closeOverlay();
    const ov = $('div', 'tc-overlay');
    ov.id = 'tcReplayOverlay';
    ov.addEventListener('mousedown', (e) => {
      if (e.target === ov) closeOverlay();
    });
    const panel = $('div', 'tc-panel');
    panel.appendChild($('h2', 'blueNight tc-title', 'Battle Log'));
    if (activeRec) {
      panel.appendChild($('div', 'tc-note', 'Recording current match…'));
    }

    // open a .n1replay file: watch it right away or save it to the list
    const bar = $('div', 'tc-bar');
    const openFile = $('button', 'tc-btn', 'Open .n1replay file…');
    const fileInput = $('input');
    fileInput.type = 'file';
    fileInput.accept = '.n1replay,application/octet-stream';
    fileInput.style.display = 'none';
    openFile.addEventListener('click', () => fileInput.click());
    bar.append(openFile, fileInput);
    panel.appendChild(bar);
    const cardHost = $('div', 'tc-cardhost');
    panel.appendChild(cardHost);

    const list = $('div', 'tc-list');
    panel.appendChild(list);
    const close = $('button', 'tc-btn', 'Close');
    close.addEventListener('click', closeOverlay);
    panel.appendChild(close);
    ov.appendChild(panel);
    document.body.appendChild(ov);

    const showError = (msg) => {
      cardHost.textContent = '';
      cardHost.appendChild($('div', 'tc-err', msg));
    };
    const showImportCard = (meta, data) => {
      cardHost.textContent = '';
      const card = $('div', 'tc-card');
      const info = $('div', 'tc-info');
      info.appendChild($('div', 'tc-date', replayTitle(meta)));
      info.appendChild(
        $('div', 'tc-sub', `${meta.mapName} · ${fmtDur(meta.durationMs)} · K/D ${meta.kills}/${meta.deaths} · Flags ${meta.flags} · ${(meta.bytes / 1024).toFixed(0)} KB`)
      );
      const watch = $('button', 'tc-btn', 'Watch');
      watch.addEventListener('click', () => startReplay(meta, data));
      const save = $('button', 'tc-btn', 'Save to list');
      save.addEventListener('click', async () => {
        save.disabled = true;
        try {
          await saveImported(meta, data);
          openList();
        } catch (e) {
          showError('Could not save the replay: ' + (e && e.message ? e.message : e));
        }
      });
      const cancel = $('button', 'tc-btn', 'Cancel');
      cancel.addEventListener('click', () => {
        cardHost.textContent = '';
      });
      card.append(info, watch, save, cancel);
      cardHost.appendChild(card);
    };
    fileInput.addEventListener('change', async () => {
      const f = fileInput.files && fileInput.files[0];
      fileInput.value = '';
      if (!f) return;
      cardHost.textContent = '';
      cardHost.appendChild($('div', 'tc-note', 'Reading file…'));
      try {
        const { meta, data } = await parseReplayFile(f);
        showImportCard(meta, data);
      } catch (e) {
        showError('Could not open this file: ' + (e && e.message ? e.message : e));
      }
    });

    let metas = [];
    try {
      metas = (await idb.list()).sort((a, b) => b.id - a.id);
    } catch {}
    if (!metas.length) {
      list.appendChild(
        $('div', 'tc-note', 'No battles yet. Play a match longer than 15s, or open a .n1replay file.')
      );
      return;
    }
    for (const m of metas) {
      const row = $('div', 'tc-row');
      const info = $('div', 'tc-info');
      const titleEl = $('div', 'tc-date', replayTitle(m));
      info.appendChild(titleEl);
      info.appendChild(
        $(
          'div',
          'tc-sub',
          `${m.name ? fmtDate(m.startedAt) + ' · ' : ''}${m.mapName || 'Unknown'} · ${fmtDur(m.durationMs)} · K/D ${m.kills}/${m.deaths} · Flags ${m.flags} · Score ${m.score} · ${(m.bytes / 1024).toFixed(0)} KB${m.ended ? '' : ' · incomplete'}${m.imported ? ' · imported' : ''}`
        )
      );
      const actions = $('div', 'tc-actions');
      const watch = $('button', 'tc-btn', 'Watch');
      watch.addEventListener('click', () => startReplay(m));
      const rename = $('button', 'tc-btn', 'Rename');
      rename.addEventListener('click', () =>
        startRename(m, row.querySelector('.tc-date') || titleEl)
      );
      const exp = $('button', 'tc-btn', 'Export');
      exp.addEventListener('click', async () => {
        exp.disabled = true;
        exp.textContent = '…';
        let ok = false;
        try {
          const data = await idb.get(m.id);
          if (!data) throw new Error('data missing');
          downloadBlob(await buildReplayFile(m, data), fileNameFor(m));
          ok = true;
        } catch (e) {
          console.warn('[replay] export failed', e);
        }
        exp.textContent = ok ? 'Export' : 'Failed';
        setTimeout(() => {
          exp.disabled = false;
          exp.textContent = 'Export';
        }, ok ? 0 : 2000);
      });
      const del = $('button', 'tc-btn tc-danger', 'Delete');
      let armed = false;
      del.addEventListener('click', async () => {
        if (!armed) {
          armed = true;
          del.textContent = 'Sure?';
          setTimeout(() => {
            armed = false;
            del.textContent = 'Delete';
          }, 3000);
          return;
        }
        await idb.del(m.id);
        row.remove();
      });
      actions.append(watch, rename, exp, del);
      row.append(info, actions);
      list.appendChild(row);
    }
  }

  const CSS = `
    #tcReplayOverlay{position:fixed;inset:0;z-index:2000;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center}
    .tc-panel{background:var(--default-ui-bg-color,#fff);color:var(--default-text-color,#000);padding:24px;border-radius:14px;
      width:min(720px,94vw);max-height:84vh;display:flex;flex-direction:column;gap:12px;filter:var(--default-drop-shadow)}
    .tc-title{margin:0;font-size:38px}
    .tc-bar{display:flex;gap:8px}
    .tc-list{overflow-y:auto;display:flex;flex-direction:column;gap:8px;min-height:60px}
    .tc-row,.tc-card{display:flex;align-items:center;gap:8px;background:var(--container-ui-bg-color,#eee);padding:10px 12px;border-radius:10px}
    .tc-card{border:2px solid var(--default-wrinkled-paper-border-color,#353535)}
    .tc-info{flex:1;min-width:0}
    .tc-actions{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}
    .tc-date{font-weight:bold;font-size:18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .tc-sub{font-size:12px;opacity:.75}
    .tc-note{opacity:.75;padding:6px 2px}
    .tc-err{color:#d22;padding:6px 2px}
    .tc-input{width:100%;box-sizing:border-box;font:inherit;font-weight:bold;font-size:18px;padding:2px 6px;border-radius:6px;
      border:2px solid var(--default-wrinkled-paper-border-color,#353535);background:var(--default-ui-bg-color,#fff);color:var(--default-text-color,#000)}
    .tc-btn{cursor:pointer;border:2px solid var(--default-wrinkled-paper-border-color,#353535);background:var(--default-ui-bg-color,#fff);
      color:var(--default-text-color,#000);border-radius:8px;padding:6px 12px;font-size:14px}
    .tc-btn:hover{filter:brightness(.9)}
    .tc-btn:disabled{opacity:.5;cursor:default}
    .tc-danger{color:#d22}
    .tc-on{background:#2a8a3a !important;color:#fff !important}
    #tcReplayHud{position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:900;display:flex;align-items:center;gap:8px;
      background:rgba(0,0,0,.6);color:#fff;padding:6px 10px;border-radius:10px;font-size:14px;white-space:nowrap}
    #tcReplayHud .tc-hud-title{font-weight:bold;margin-right:4px;max-width:180px;overflow:hidden;text-overflow:ellipsis}
    #tcReplayHud .tc-hud-name{min-width:90px;text-align:center}
    #tcReplayHud .tc-hud-time{min-width:90px;text-align:center}
  `;

  // The Replays button is added to every menu button container (start screen and Esc menu).
  function makeReplayButton() {
    const wrap = $('div', 'main-menu-button-container tc-replay-btn');
    const btn = $('button', 'wrinkledPaper main-menu-button');
    btn.style.cssText = `--wrinkled-paper-seed:${1 + Math.floor(Math.random() * 99999)}`;
    btn.setAttribute('aria-label', 'Replays');
    btn.addEventListener('click', openList);
    const icon = $('div', 'buttonImage');
    icon.style.cssText =
      'background:var(--default-text-color);clip-path:polygon(35% 25%,35% 75%,75% 50%);';
    btn.appendChild(icon);
    wrap.append(btn, $('div', 'main-menu-button-text whiteBigText blueNight', 'Replays'));
    return wrap;
  }

  function ensureUi() {
    if (!document.getElementById('tcReplayStyle') && document.head) {
      const s = $('style');
      s.id = 'tcReplayStyle';
      s.textContent = CSS;
      document.head.appendChild(s);
    }
    for (const cont of document.querySelectorAll('.menu-buttons-container')) {
      if (!cont.querySelector('.tc-replay-btn')) cont.appendChild(makeReplayButton());
    }
  }
  setInterval(ensureUi, 500);

  console.log('[replay] v1.5 — input lock during replays, free cam, , / . player POV, P pause, F free cam');
})();
