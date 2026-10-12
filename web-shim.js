/*
  Web shim — loaded before the tracker's own script in the installable web app
  (phones, tablets, any browser). The desktop application has a shim of its own.

  A phone has no MEGA folder on a disk, so here "the sync folder" is a folder
  in the MEGA cloud itself, reached directly over the internet. The tracker
  asks for a folder through the browser's folder API (showDirectoryPicker and
  the handles it returns); this file answers with the same API on top of a
  MEGA connection, so the tracker's code runs unchanged and writes the very
  same files the computers do. The computers see them arrive through the MEGA
  desktop app; the phone sees theirs here.

  What is kept on the device: the MEGA session (never the MEGA password) and
  which folder was chosen. Everything sent to MEGA is already sealed with the
  office key by the tracker before it reaches this file.
*/
(function () {
  'use strict';

  if (window.daxilDesktop) return;

  var MARK = '__daxilMegaHandle';
  var KEY_FILE = 'daxil-key.json';
  var TEMP_PREFIX = '.~';             // MEGA's desktop app leaves dot-files alone, so a half-sent file is never synced
  var REFRESH_MS = 45000;             // how old the folder listing may get before it is fetched again
  var STALE_TEMP_MS = 5 * 60 * 1000;

  window.daxilWeb = { isWeb: true };

  function domError(name, message) {
    return new DOMException(message || name, name);
  }

  /* ---------------- a small store of our own: the saved MEGA session ---------------- */

  function kvOpen() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open('daxil-web', 1);
      req.onupgradeneeded = function () { req.result.createObjectStore('kv'); };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function kvGet(key) {
    return kvOpen().then(function (db) {
      return new Promise(function (resolve, reject) {
        var req = db.transaction('kv', 'readonly').objectStore('kv').get(key);
        req.onsuccess = function () { resolve(req.result === undefined ? null : req.result); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  function kvSet(key, value) {
    return kvOpen().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction('kv', 'readwrite');
        if (value === null) tx.objectStore('kv').delete(key);
        else tx.objectStore('kv').put(value, key);
        tx.oncomplete = function () { resolve(true); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  /* ---------------- the MEGA connection ---------------- */

  var storage = null;          // the library's Storage object, once connected
  var lastRefresh = 0;
  var connecting = null;
  var hasSession = false;
  var sessionKnown = kvGet('megaSession').then(function (s) { hasSession = !!s; }, function () { hasSession = false; });

  function library() {
    if (!window.mega || !window.mega.Storage) throw domError('NotSupportedError', 'The MEGA library did not load.');
    return window.mega;
  }

  function sessionLost() {
    storage = null;
    hasSession = false;
    kvSet('megaSession', null).catch(function () {});
  }

  /* MEGA's own error text, turned into the names the tracker already understands */
  function translate(e) {
    if (e instanceof DOMException) return e;
    var msg = (e && e.message) ? e.message : String(e);
    if (/ESID|\(-15\)/.test(msg)) { sessionLost(); return domError('NotAllowedError', msg); }
    if (/ENOENT|\(-9\)/.test(msg)) return domError('NotFoundError', msg);
    if (/EOVERQUOTA|\(-17\)/.test(msg)) return domError('QuotaExceededError', 'MEGA storage is full.');
    // no connection, a busy server, anything else: the tracker treats this as "busy, try again"
    return domError('NotReadableError', msg);
  }

  /*
    The library only ever adds to its picture of the account, so a fresh
    picture is fetched whole: files replaced or deleted by the computers
    disappear, new ones appear.
  */
  async function refreshTree() {
    storage.api.removeAllListeners('sc');
    storage.files = {};
    storage.root = null;
    await storage.reload(true);
    lastRefresh = Date.now();
  }

  function connect() {
    if (storage) return Promise.resolve(storage);
    if (!connecting) {
      connecting = (async function () {
        var saved = await kvGet('megaSession');
        if (!saved) { hasSession = false; throw domError('NotAllowedError', 'Not connected to MEGA.'); }
        var st = library().Storage.fromJSON({
          key: saved.key, sid: saved.sid, name: saved.name, user: saved.user,
          options: { keepalive: false }
        });
        storage = st;
        try { await refreshTree(); }
        catch (e) { storage = null; throw e; }
        return st;
      })();
      connecting.then(function () { connecting = null; }, function () { connecting = null; });
    }
    return connecting;
  }

  async function freshTree(maxAge) {
    await connect();
    if (Date.now() - lastRefresh > maxAge) await refreshTree();
  }

  function forget(node) {
    try {
      if (node.parent && node.parent.children) {
        var i = node.parent.children.indexOf(node);
        if (i !== -1) node.parent.children.splice(i, 1);
      }
      delete storage.files[node.nodeId];
    } catch (e) { /* the next refresh puts it right */ }
  }

  function isTemp(name) {
    return typeof name === 'string' && name.indexOf(TEMP_PREFIX) === 0 && /\.tmp$/.test(name);
  }

  /* MEGA allows two files of one name; the newest is the one that counts */
  function named(dir, name, wantDir) {
    return (dir.children || []).filter(function (c) {
      return c.name === name && !!c.directory === !!wantDir;
    }).sort(function (a, b) { return (b.timestamp || 0) - (a.timestamp || 0); });
  }

  /*
    MEGA's own apps attach a "fingerprint" to every file they upload: a short
    checksum of the contents plus the file's date. MEGA's desktop app will not
    download a file that has none — it stops and shows "File fingerprint
    missing" until someone presses Solve. So every file sent from here carries
    one, built exactly as MEGA builds it (FileFingerprint in MEGA's SDK):

      up to 16 bytes     the bytes themselves, padded with zeros
      up to 8192 bytes   four CRC-32s, one over each quarter of the file
      larger             four CRC-32s, each over 32 blocks of 64 bytes spread
                         evenly through the file
      then the date in seconds: a count byte and that many bytes, lowest first
      all of it in MEGA's base64 (URL-safe, no padding)
  */
  var CRC_TABLE = (function () {
    var table = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crcAdd(state, bytes, start, end) {
    for (var i = start; i < end; i++) state = CRC_TABLE[(state ^ bytes[i]) & 0xFF] ^ (state >>> 8);
    return state >>> 0;
  }

  function megaFingerprint(bytes, mtimeSeconds) {
    var size = bytes.length;
    var crc = new Uint8Array(16);
    var put = function (lane, state) {
      var v = (state ^ 0xFFFFFFFF) >>> 0;          // highest byte first
      crc[lane * 4] = v >>> 24; crc[lane * 4 + 1] = (v >>> 16) & 0xFF;
      crc[lane * 4 + 2] = (v >>> 8) & 0xFF; crc[lane * 4 + 3] = v & 0xFF;
    };

    if (size <= 16) {
      crc.set(bytes);
    } else if (size <= 8192) {
      for (var i = 0; i < 4; i++) {
        put(i, crcAdd(0xFFFFFFFF, bytes, Math.floor(i * size / 4), Math.floor((i + 1) * size / 4)));
      }
    } else {
      for (var lane = 0; lane < 4; lane++) {
        var state = 0xFFFFFFFF;
        for (var j = 0; j < 32; j++) {
          var offset = Math.floor((size - 64) * (lane * 32 + j) / 127);
          state = crcAdd(state, bytes, offset, offset + 64);
        }
        put(lane, state);
      }
    }

    var date = [];
    for (var v = Math.max(0, Math.floor(mtimeSeconds)); v > 0; v = Math.floor(v / 256)) date.push(v % 256);
    var all = new Uint8Array(16 + 1 + date.length);
    all.set(crc, 0);
    all[16] = date.length;
    all.set(date, 17);

    var bin = '';
    for (var b = 0; b < all.length; b++) bin += String.fromCharCode(all[b]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  // MEGA dates files to the second; the node's own id keeps two versions within a second apart
  function stampOf(node) {
    var h = 0;
    var id = String(node.nodeId || '');
    for (var i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 1000;
    return (node.timestamp || 0) * 1000 + h;
  }

  async function resolveDir(handle, maxAge) {
    await freshTree(maxAge === undefined ? REFRESH_MS : maxAge);
    var node = storage.files[handle.folderId];
    if (!node || !node.directory) throw domError('NotFoundError', 'The MEGA folder is no longer there.');
    for (var i = 0; i < handle.parts.length; i++) {
      node = named(node, handle.parts[i], true)[0];
      if (!node) throw domError('NotFoundError', 'Folder not found.');
    }
    return node;
  }

  function checkName(name) {
    if (typeof name !== 'string' || !name || name === '.' || name === '..' || /[\\/]/.test(name)) {
      throw new TypeError('Name is not allowed.');
    }
  }

  /* ---------------- files ---------------- */

  function MegaFile(node) {
    this.name = node.name;
    this.size = node.size || 0;
    this.lastModified = stampOf(node);
    this.type = /\.json$/i.test(node.name || '') ? 'application/json' : '';
    this.webkitRelativePath = '';
    Object.defineProperty(this, '_node', { value: node });
  }
  MegaFile.prototype.arrayBuffer = async function () {
    try {
      var buf = await this._node.downloadBuffer({});
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    } catch (e) { throw translate(e); }
  };
  MegaFile.prototype.text = async function () {
    return new TextDecoder().decode(await this.arrayBuffer());
  };

  async function toBytes(chunk) {
    if (typeof chunk === 'string') return new TextEncoder().encode(chunk);
    if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
    if (ArrayBuffer.isView(chunk)) return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    if (typeof Blob !== 'undefined' && chunk instanceof Blob) return new Uint8Array(await chunk.arrayBuffer());
    return new TextEncoder().encode(String(chunk));
  }

  // everything is gathered first and sent in one piece on close()
  function MegaWritable(handle) {
    this._h = handle;
    this._chunks = [];
    this._closed = false;
  }
  MegaWritable.prototype.write = async function (data) {
    if (this._closed) throw new TypeError('The stream is closed.');
    if (data && typeof data === 'object' && !(data instanceof ArrayBuffer) && !ArrayBuffer.isView(data) &&
        !(typeof Blob !== 'undefined' && data instanceof Blob) && 'type' in data) {
      if (data.type === 'truncate') { if (!data.size) this._chunks = []; return; }
      if (data.type !== 'write') return;
      data = data.data;
    }
    if (data == null) return;
    this._chunks.push(await toBytes(data));
  };
  MegaWritable.prototype.truncate = async function (size) { if (!size) this._chunks = []; };
  MegaWritable.prototype.seek = async function () {};
  MegaWritable.prototype.abort = async function () { this._closed = true; this._chunks = []; };
  MegaWritable.prototype.close = async function () {
    if (this._closed) throw new TypeError('The stream is closed.');
    this._closed = true;
    var total = 0;
    this._chunks.forEach(function (c) { total += c.byteLength; });
    var bytes = new Uint8Array(total);
    var at = 0;
    this._chunks.forEach(function (c) { bytes.set(c, at); at += c.byteLength; });
    this._chunks = [];

    var h = this._h;
    try {
      var dir = await resolveDir(h.dir);
      var name = h.name;

      // leftovers of a send that was cut off (the app closed mid-way)
      var now = Date.now() / 1000;
      (dir.children || []).slice().forEach(function (c) {
        if (isTemp(c.name) && c.name.indexOf(TEMP_PREFIX + name + '.') === 0 &&
            now - (c.timestamp || 0) > STALE_TEMP_MS / 1000) {
          c.delete(true).then(function () { forget(c); }, function () {});
        }
      });

      /*
        The new contents go up under a temporary name first. Only when they
        are safely there is the old file removed and the new one given its
        name — so the name is never missing for more than an instant, and two
        files never carry it at once (which MEGA's desktop app treats as a
        conflict it will not sync).
      */
      // sealed files are plain ASCII text, and text is the form the library documents for uploads;
      // anything else goes up as bytes
      var ascii = true;
      for (var b = 0; b < bytes.length; b++) { if (bytes[b] > 127) { ascii = false; break; } }
      var payload = ascii ? new TextDecoder().decode(bytes) : bytes;
      var tempName = TEMP_PREFIX + name + '.' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7) + '.tmp';
      var sent = await dir.upload({
        name: tempName,
        size: bytes.byteLength,
        // without this MEGA's desktop app refuses to download the file
        attributes: { c: megaFingerprint(bytes, Date.now() / 1000) }
      }, payload).complete;

      var old = named(dir, name, false);
      for (var i = 0; i < old.length; i++) {
        // already gone (removed from another device meanwhile) is as good as removed
        try { await old[i].delete(true); }
        catch (e) { if (translate(e).name !== 'NotFoundError') throw e; }
        forget(old[i]);
      }
      await sent.rename(name);
      sent.name = name;
    } catch (e) { throw translate(e); }
  };

  /* ---------------- handles ---------------- */

  /*
    Only plain data lives on a handle (which MEGA folder, which names inside
    it), so the tracker can keep one in IndexedDB as it always has; the
    behaviour is put back when it is read out again — see the end of the file.
  */
  function MegaFileHandle(dir, name) {
    this.kind = 'file';
    this.name = name;
    this.folderId = dir.folderId;
    this.parts = dir.parts.slice();
    this[MARK] = 'file';
    Object.defineProperty(this, 'dir', { value: dir });
  }
  MegaFileHandle.prototype.getFile = async function () {
    try {
      var dir = await resolveDir(this.dir);
      var node = named(dir, this.name, false)[0];
      if (!node) throw domError('NotFoundError', 'File not found.');
      return new MegaFile(node);
    } catch (e) { throw translate(e); }
  };
  MegaFileHandle.prototype.createWritable = async function () {
    return new MegaWritable(this);
  };

  function MegaDirectoryHandle(folderId, parts, name) {
    this.kind = 'directory';
    this.name = name;
    this.folderId = folderId;
    this.parts = parts;
    this[MARK] = 'directory';
  }
  MegaDirectoryHandle.prototype.getFileHandle = async function (name, options) {
    checkName(name);
    try {
      var dir = await resolveDir(this);
      var found = named(dir, name, false)[0];
      if (!found && lastRefresh && Date.now() - lastRefresh > 4000) {
        // "not there" must be a recent answer — the office key file is looked for this way
        dir = await resolveDir(this, 0);
        found = named(dir, name, false)[0];
      }
      if (!found) {
        if (named(dir, name, true)[0]) throw domError('TypeMismatchError', 'Not a file.');
        if (!(options && options.create)) throw domError('NotFoundError', 'File not found.');
        // nothing is created until the first write
      }
      return new MegaFileHandle(this, name);
    } catch (e) { throw translate(e); }
  };
  MegaDirectoryHandle.prototype.getDirectoryHandle = async function (name, options) {
    checkName(name);
    try {
      var dir = await resolveDir(this);
      if (!named(dir, name, true)[0]) {
        if (named(dir, name, false)[0]) throw domError('TypeMismatchError', 'Not a folder.');
        if (!(options && options.create)) throw domError('NotFoundError', 'Folder not found.');
        await dir.mkdir(name);
      }
      return new MegaDirectoryHandle(this.folderId, this.parts.concat(name), name);
    } catch (e) { throw translate(e); }
  };
  MegaDirectoryHandle.prototype.removeEntry = async function (name, options) {
    checkName(name);
    try {
      var dir = await resolveDir(this);
      var doomed = named(dir, name, false);
      if (options && options.recursive) doomed = doomed.concat(named(dir, name, true));
      if (!doomed.length) throw domError('NotFoundError', 'Not found.');
      for (var i = 0; i < doomed.length; i++) {
        await doomed[i].delete(true);
        forget(doomed[i]);
      }
    } catch (e) { throw translate(e); }
  };
  MegaDirectoryHandle.prototype._children = async function () {
    var self = this;
    try {
      var dir = await resolveDir(this);
      var seen = {};
      var out = [];
      (dir.children || []).slice().sort(function (a, b) { return (b.timestamp || 0) - (a.timestamp || 0); })
        .forEach(function (c) {
          if (!c.name || isTemp(c.name)) return;
          var id = (c.directory ? 'd:' : 'f:') + c.name;
          if (seen[id]) return;            // an older file of the same name
          seen[id] = true;
          out.push(c.directory
            ? new MegaDirectoryHandle(self.folderId, self.parts.concat(c.name), c.name)
            : new MegaFileHandle(self, c.name));
        });
      return out;
    } catch (e) { throw translate(e); }
  };
  MegaDirectoryHandle.prototype.values = async function* () {
    var list = await this._children();
    for (var i = 0; i < list.length; i++) yield list[i];
  };
  MegaDirectoryHandle.prototype.keys = async function* () {
    var list = await this._children();
    for (var i = 0; i < list.length; i++) yield list[i].name;
  };
  MegaDirectoryHandle.prototype.entries = async function* () {
    var list = await this._children();
    for (var i = 0; i < list.length; i++) yield [list[i].name, list[i]];
  };
  MegaDirectoryHandle.prototype[Symbol.asyncIterator] = MegaDirectoryHandle.prototype.entries;

  [MegaFileHandle, MegaDirectoryHandle].forEach(function (Handle) {
    // "permission" here means: is this device signed in to MEGA
    Handle.prototype.queryPermission = async function () {
      await sessionKnown;
      return hasSession ? 'granted' : 'prompt';
    };
    Handle.prototype.requestPermission = async function () {
      await sessionKnown;
      if (hasSession) return 'granted';
      return (await signInDialog()) ? 'granted' : 'denied';
    };
    Handle.prototype.isSameEntry = async function (other) {
      return !!other && other.folderId === this.folderId && other.kind === this.kind &&
        other.name === this.name && (other.parts || []).join('/') === this.parts.join('/');
    };
  });

  /* ---------------- the "connect to MEGA" window ---------------- */

  var TEXT = {
    title: 'پەیوەستبوون بە MEGA',
    intro: 'ئیمەیڵ و وشەی نهێنی هەژماری MEGA ی نووسینگە بنووسە. وشەی نهێنییەکە لەسەر ئەم ئامێرە هەڵناگیرێت؛ ' +
           'تەنها پەیوەندییەکە هەڵدەگیرێت بۆ ئەوەی جاری داهاتوو پێویست نەکات.',
    email: 'ئیمەیڵی MEGA',
    password: 'وشەی نهێنی MEGA',
    code: 'کۆدی دوو-هەنگاوی (تەنها ئەگەر چالاکت کردووە)',
    connect: 'پەیوەستبوون',
    cancel: 'پاشگەزبوونەوە',
    wait: 'چاوەڕێ بکە...',
    wrong: 'ئیمەیڵ یان وشەی نهێنی هەڵەیە.',
    needCode: 'ئەم هەژمارە کۆدی دوو-هەنگاوی پێویستە.',
    offline: 'نەتوانرا پەیوەندی بە MEGA بکرێت. ئینتەرنێتەکەت بپشکنە و دووبارە هەوڵ بدەرەوە.',
    folderTitle: 'فۆڵدەری هاوکاتکردن',
    folderFound: 'ئەم فۆڵدەرانە پێشتر بۆ هاوکاتکردن بەکارهاتوون. یەکێکیان هەڵبژێرە:',
    folderNone: 'هیچ فۆڵدەرێکی هاوکاتکردن لەم هەژمارەدا نەدۆزرایەوە. ئەگەر کۆمپیوتەرەکانی نووسینگە پێشتر هاوکات دەکەن، ' +
                'هەمان ئەو فۆڵدەرە هەڵبژێرە کە ئەوان بەکاریدەهێنن. ئەگینا فۆڵدەرێکی نوێ دروست بکە.',
    folderNew: 'دروستکردنی فۆڵدەری نوێ بەم ناوە:',
    choose: 'هەڵبژاردن',
    otherAccount: 'بەکارهێنانی هەژمارێکی تری MEGA',
    signedInAs: 'پەیوەستە بە: '
  };

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'text') node.textContent = attrs[k];
      else if (k === 'style') node.style.cssText = attrs[k];
      else node.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) { node.appendChild(c); });
    return node;
  }

  function openWindow(title) {
    var modal = el('div', { class: 'modal', style: 'max-width:460px;' }, [el('h2', { text: title })]);
    var overlay = el('div', { class: 'overlay open', style: 'z-index:70;' }, [modal]);
    document.body.appendChild(overlay);
    return { overlay: overlay, modal: modal, close: function () { overlay.remove(); } };
  }

  function field(label, input) {
    return el('div', { class: 'field' }, [el('label', { text: label }), input]);
  }

  function loginMessage(e) {
    var msg = (e && e.message) ? e.message : String(e);
    if (/EMFAREQUIRED|\(-26\)/.test(msg)) return TEXT.needCode;
    if (/ENOENT|\(-9\)|EKEY|\(-14\)|EFAILED|\(-5\)/.test(msg)) return TEXT.wrong;
    if (/fetch|network|Failed|timeout/i.test(msg)) return TEXT.offline;
    return msg;
  }

  /* asks for the MEGA account; resolves true once this device is signed in */
  function signInDialog() {
    return new Promise(function (resolve) {
      var w = openWindow(TEXT.title);
      var email = el('input', { type: 'email', autocomplete: 'username', dir: 'ltr', inputmode: 'email', autocapitalize: 'off', style: 'width:100%;' });
      var pass = el('input', { type: 'password', autocomplete: 'current-password', dir: 'ltr', style: 'width:100%;' });
      var code = el('input', { type: 'text', autocomplete: 'one-time-code', inputmode: 'numeric', dir: 'ltr', style: 'width:100%;' });
      var err = el('div', { class: 'login-error', style: 'display:none;' });
      var ok = el('button', { type: 'button', text: TEXT.connect });
      var cancel = el('button', { type: 'button', class: 'ghost', text: TEXT.cancel });
      w.modal.appendChild(el('p', { class: 'vault-text', text: TEXT.intro }));
      w.modal.appendChild(field(TEXT.email, email));
      w.modal.appendChild(field(TEXT.password, pass));
      w.modal.appendChild(field(TEXT.code, code));
      w.modal.appendChild(err);
      w.modal.appendChild(el('div', { class: 'modal-actions' }, [ok, cancel]));

      var busy = false;
      var finish = function (result) { w.close(); resolve(result); };
      var go = async function () {
        if (busy || !email.value.trim() || !pass.value) return;
        busy = true; ok.disabled = true; ok.textContent = TEXT.wait; err.style.display = 'none';
        try {
          var options = { email: email.value.trim(), password: pass.value, keepalive: false };
          if (code.value.trim()) options.secondFactorCode = code.value.trim();
          var st = new (library().Storage)(options);
          await st.ready;
          var session = st.toJSON();
          // the library keeps the typed password among its options; it is deliberately not saved
          await kvSet('megaSession', { key: session.key, sid: session.sid, name: session.name, user: session.user });
          st.options = { keepalive: false };
          storage = st;
          lastRefresh = Date.now();
          hasSession = true;
          pass.value = '';
          finish(true);
          return;
        } catch (e) {
          err.textContent = loginMessage(e);
          err.style.display = 'block';
        }
        busy = false; ok.disabled = false; ok.textContent = TEXT.connect;
      };
      ok.addEventListener('click', go);
      cancel.addEventListener('click', function () { if (!busy) finish(false); });
      w.overlay.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); go(); }
      });
      setTimeout(function () { email.focus(); }, 60);
    });
  }

  function pathOf(node) {
    var parts = [];
    for (var n = node; n && n !== storage.root; n = n.parent) parts.unshift(n.name || '?');
    return '/' + parts.join('/');
  }

  /* which MEGA folder holds the office's files; resolves a folder node, or null if cancelled */
  async function folderDialog() {
    await freshTree(0);
    var root = storage.root;
    if (!root) throw domError('NotReadableError', 'MEGA did not return the cloud drive.');

    // a folder already used for sync is recognised by the office key file inside it
    var used = [];
    root.filter(function (f) { return !f.directory && f.name === KEY_FILE; }, true).forEach(function (f) {
      if (f.parent && f.parent !== root && used.indexOf(f.parent) === -1) used.push(f.parent);
    });
    if (used.length === 1) return used[0];

    return new Promise(function (resolve) {
      var w = openWindow(TEXT.folderTitle);
      var options = used.length ? used : (root.children || []).filter(function (c) { return c.directory; });
      options.sort(function (a, b) { return String(a.name).localeCompare(String(b.name)); });

      w.modal.appendChild(el('p', { class: 'vault-text', text: used.length ? TEXT.folderFound : TEXT.folderNone }));
      var list = el('div', { style: 'max-height:220px; overflow-y:auto; border:1px solid var(--line); border-radius:4px; margin-bottom:12px;' });
      var picked = null;
      var rows = [];
      options.forEach(function (node) {
        var row = el('label', { style: 'display:flex; gap:8px; align-items:center; padding:9px 10px; border-bottom:1px solid var(--line); font-size:13px; cursor:pointer;' }, [
          el('input', { type: 'radio', name: 'megaFolder', style: 'width:auto;' }),
          el('span', { dir: 'ltr', text: pathOf(node), style: 'word-break:break-all; text-align:left; flex:1;' })
        ]);
        row.firstChild.addEventListener('change', function () { picked = node; fresh.value = ''; });
        rows.push(row);
        list.appendChild(row);
      });
      if (options.length) w.modal.appendChild(list);

      var fresh = el('input', { type: 'text', dir: 'auto', style: 'width:100%;', value: (used.length || options.length) ? '' : 'Daxil' });
      fresh.addEventListener('input', function () {
        if (fresh.value) { picked = null; rows.forEach(function (r) { r.firstChild.checked = false; }); }
      });
      if (!used.length) w.modal.appendChild(field(TEXT.folderNew, fresh));

      var err = el('div', { class: 'login-error', style: 'display:none;' });
      var ok = el('button', { type: 'button', text: TEXT.choose });
      var cancel = el('button', { type: 'button', class: 'ghost', text: TEXT.cancel });
      var other = el('button', { type: 'button', class: 'ghost small', text: TEXT.otherAccount, style: 'margin-top:10px;' });
      w.modal.appendChild(err);
      w.modal.appendChild(el('div', { class: 'modal-actions' }, [ok, cancel]));
      w.modal.appendChild(el('div', { style: 'font-size:11.5px; color:var(--ink-soft); margin-top:14px;' }, [
        el('span', { text: TEXT.signedInAs }), el('b', { dir: 'ltr', text: storage.name || '' }), el('br'), other
      ]));

      var busy = false;
      ok.addEventListener('click', async function () {
        if (busy) return;
        var name = fresh.value.trim();
        if (!picked && !name) return;
        busy = true; ok.disabled = true; ok.textContent = TEXT.wait;
        try {
          var node = picked;
          if (!node) {
            if (/[\\/]/.test(name)) throw new Error('/ \\');
            node = named(root, name, true)[0] || await root.mkdir(name);
          }
          w.close();
          resolve(node);
        } catch (e) {
          err.textContent = loginMessage(e);
          err.style.display = 'block';
          busy = false; ok.disabled = false; ok.textContent = TEXT.choose;
        }
      });
      cancel.addEventListener('click', function () { if (!busy) { w.close(); resolve(null); } });
      other.addEventListener('click', function () {
        if (busy) return;
        sessionLost();
        w.close();
        resolve('other-account');
      });
    });
  }

  window.showDirectoryPicker = async function () {
    await sessionKnown;
    for (;;) {
      if (!hasSession) {
        if (!(await signInDialog())) throw domError('AbortError', 'The user aborted a request.');
      }
      var folder;
      try { folder = await folderDialog(); }
      catch (e) { throw translate(e); }
      if (folder === 'other-account') continue;
      if (!folder) throw domError('AbortError', 'The user aborted a request.');
      return new MegaDirectoryHandle(folder.nodeId, [], folder.name || 'MEGA');
    }
  };

  // "save straight into a file" has no meaning on a phone; the tracker falls back to its download button
  try { delete window.showSaveFilePicker; } catch (e) { window.showSaveFilePicker = undefined; }

  window.daxilWeb.megaFingerprint = megaFingerprint;
  window.daxilWeb.signOutOfMega = sessionLost;
  // the next look at the folder asks MEGA again instead of trusting the recent listing
  window.daxilWeb.lookAfresh = function () { lastRefresh = 0; };
  window.daxilWeb.megaAccount = function () { return storage ? (storage.name || '') : ''; };

  /* ---------------- handles kept in IndexedDB ---------------- */

  function revive(v) {
    if (!v || typeof v !== 'object' || !v[MARK]) return v;
    if (v instanceof MegaFileHandle || v instanceof MegaDirectoryHandle) return v;
    if (typeof v.folderId !== 'string' || !Array.isArray(v.parts)) return v;
    if (v[MARK] === 'directory') return new MegaDirectoryHandle(v.folderId, v.parts.slice(), String(v.name || ''));
    return new MegaFileHandle(new MegaDirectoryHandle(v.folderId, v.parts.slice(), ''), String(v.name || ''));
  }

  // a stored handle comes back as bare data; this hands the tracker a working one
  try {
    var desc = Object.getOwnPropertyDescriptor(IDBRequest.prototype, 'result');
    if (desc && desc.get) {
      Object.defineProperty(IDBRequest.prototype, 'result', {
        configurable: true,
        enumerable: desc.enumerable,
        get: function () {
          var v = desc.get.call(this);
          return (v && typeof v === 'object' && v[MARK]) ? revive(v) : v;
        }
      });
    }
  } catch (e) { console.error('Web shim: could not prepare the stored folder', e); }

  /* ---------------- offline start ---------------- */

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    /*
      A new version published on the host is fetched in the background and
      kept waiting. The person is told with the bar at the top, and it takes
      over — with a reload — only when they press "update now".
    */
    var updating = false;

    // a new version, once fetched, asks whether an open page can show the bar; this one can.
    // (A page from an early version cannot answer, and the new version then takes over by itself.)
    try {
      var updateChannel = new BroadcastChannel('daxil-update');
      updateChannel.onmessage = function (event) {
        if (event.data === 'new-version-ready' && window.daxilUpdateBar) updateChannel.postMessage('page-will-offer');
      };
    } catch (e) { /* no such channel on this browser: new versions simply take over at the next opening */ }

    var offerUpdate = function (reg) {
      // "waiting" with nothing in charge yet is the very first installation, not an update
      if (!reg.waiting || !navigator.serviceWorker.controller || !window.daxilUpdateBar) return;
      window.daxilUpdateBar.offer({
        install: function () {
          return new Promise(function (resolve, reject) {
            if (!reg.waiting) { location.reload(); return; }
            updating = true;
            reg.waiting.postMessage('daxil:activate');
            setTimeout(function () { updating = false; reject(new Error('The new version did not start.')); }, 20000);
          });
        }
      });
    };

    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (updating) location.reload();
    });

    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').then(function (reg) {
        offerUpdate(reg);
        reg.addEventListener('updatefound', function () {
          var fresh = reg.installing;
          if (!fresh) return;
          fresh.addEventListener('statechange', function () {
            if (fresh.state === 'installed') offerUpdate(reg);
          });
        });

        // look for a new version now and then, and whenever the app is brought back to the front
        var look = function () { reg.update().catch(function () { /* no connection: next time */ }); };
        setInterval(look, 30 * 60 * 1000);
        document.addEventListener('visibilitychange', function () {
          if (document.visibilityState === 'visible') look();
        });
        window.daxilWeb.lookForUpdate = look;
      }).catch(function (e) { console.warn('Offline start is not available', e); });
    });
  }

  // coming back to the app after a while: the next sync pass should look at MEGA afresh
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') lastRefresh = 0;
  });
})();
