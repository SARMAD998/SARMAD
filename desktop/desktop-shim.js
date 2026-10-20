/*
  Desktop shim — loaded before the tracker's own script, and only does
  anything inside the desktop application.

  The tracker was written for Chrome/Edge and reaches the sync folder through
  the browser's folder API (showDirectoryPicker and the handles it returns).
  This file provides the same API on top of the application's direct folder
  access, so the tracker's code runs unchanged — but with no folder permission
  to lose: a chosen folder stays chosen across restarts.

  It also routes alert / confirm / prompt to the application's own dialogs.
*/
(function () {
  'use strict';

  var desktop = window.daxilDesktop;
  if (!desktop || !desktop.isDesktop) return;

  var api = desktop.fs;
  var MARK = '__daxilDesktopHandle';

  /* ---------------- errors, named the way the browser names them ---------------- */

  function domError(name, message) {
    return new DOMException(message || name, name);
  }

  function errorFor(res, writing) {
    var code = res && res.code;
    var msg = (res && res.message) || code || 'Error';
    switch (code) {
      case 'ECANCELED': return domError('AbortError', 'The user aborted a request.');
      case 'ENOENT': return domError('NotFoundError', msg);
      case 'ENOTAPPROVED': return domError('NotAllowedError', msg);
      case 'EBUSY':
      case 'EPERM':
      case 'EACCES':
      case 'ETXTBSY':
        return domError(writing ? 'NoModificationAllowedError' : 'NotReadableError', msg);
      case 'ENOTDIR':
      case 'EISDIR': return domError('TypeMismatchError', msg);
      case 'ENOTEMPTY': return domError('InvalidModificationError', msg);
      default: return domError('OperationError', msg);
    }
  }

  function checkName(name) {
    if (typeof name !== 'string' || !name || name === '.' || name === '..' || /[\\/]/.test(name)) {
      throw new TypeError('Name is not allowed.');
    }
  }

  async function permissionState(root) {
    var res = await api.access(root);
    return (res && res.granted) ? 'granted' : 'prompt';
  }

  async function askPermission(root) {
    var res = await api.requestAccess(root);
    return (res && res.granted) ? 'granted' : 'denied';
  }

  /* ---------------- a file as the tracker reads it ---------------- */

  var TYPES = {
    json: 'application/json',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    txt: 'text/plain'
  };

  // size and date are known at once; the contents are only read when asked for
  function DesktopFile(handle, st) {
    this.name = handle.name;
    this.size = st.size;
    this.lastModified = st.mtime;
    this.type = TYPES[(handle.name.split('.').pop() || '').toLowerCase()] || '';
    this.webkitRelativePath = '';
    Object.defineProperty(this, '_h', { value: handle });
  }
  DesktopFile.prototype.text = async function () {
    var res = await api.readText(this._h.root, this._h.parts);
    if (!res.ok) throw errorFor(res, false);
    return res.text;
  };
  DesktopFile.prototype.arrayBuffer = async function () {
    var res = await api.readBytes(this._h.root, this._h.parts);
    if (!res.ok) throw errorFor(res, false);
    var b = res.bytes;
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  };

  /* ---------------- writing ---------------- */

  async function toBytes(chunk) {
    if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
    if (ArrayBuffer.isView(chunk)) return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    if (typeof Blob !== 'undefined' && chunk instanceof Blob) return new Uint8Array(await chunk.arrayBuffer());
    return new TextEncoder().encode(String(chunk));
  }

  // everything is gathered first and reaches the disk in one piece on close()
  function DesktopWritable(handle) {
    this._h = handle;
    this._chunks = [];
    this._closed = false;
  }
  DesktopWritable.prototype.write = async function (data) {
    if (this._closed) throw new TypeError('The stream is closed.');
    if (data && typeof data === 'object' && !(data instanceof ArrayBuffer) && !ArrayBuffer.isView(data) &&
        !(typeof Blob !== 'undefined' && data instanceof Blob) && 'type' in data) {
      if (data.type === 'truncate') { if (!data.size) this._chunks = []; return; }
      if (data.type !== 'write') return;       // seek: writes here are always sequential
      data = data.data;
    }
    if (data == null) return;
    this._chunks.push(typeof data === 'string' ? data : await toBytes(data));
  };
  DesktopWritable.prototype.truncate = async function (size) {
    if (!size) this._chunks = [];
  };
  DesktopWritable.prototype.seek = async function () {};
  DesktopWritable.prototype.abort = async function () {
    this._closed = true;
    this._chunks = [];
  };
  DesktopWritable.prototype.close = async function () {
    if (this._closed) throw new TypeError('The stream is closed.');
    this._closed = true;
    var chunks = this._chunks;
    this._chunks = [];

    var payload;
    if (chunks.every(function (c) { return typeof c === 'string'; })) {
      payload = chunks.join('');
    } else {
      var parts = [];
      var total = 0;
      for (var i = 0; i < chunks.length; i++) {
        var p = typeof chunks[i] === 'string' ? new TextEncoder().encode(chunks[i]) : chunks[i];
        parts.push(p);
        total += p.byteLength;
      }
      payload = new Uint8Array(total);
      var at = 0;
      parts.forEach(function (p) { payload.set(p, at); at += p.byteLength; });
    }

    var res = await api.write(this._h.root, this._h.parts, payload);
    if (!res.ok) throw errorFor(res, true);
  };

  /* ---------------- handles ---------------- */

  /*
    Only plain data lives on a handle (the chosen folder and the names inside
    it), so the tracker can keep one in IndexedDB as it always has; the
    behaviour is put back when it is read out again — see the end of the file.
  */
  function DesktopFileHandle(root, parts, name) {
    this.kind = 'file';
    this.name = name;
    this.root = root;
    this.parts = parts;
    this[MARK] = 'file';
  }
  DesktopFileHandle.prototype.getFile = async function () {
    var st = await api.stat(this.root, this.parts);
    if (!st.ok) throw errorFor(st, false);
    if (st.kind !== 'file') throw domError('TypeMismatchError', 'Not a file.');
    return new DesktopFile(this, st);
  };
  DesktopFileHandle.prototype.createWritable = async function () {
    return new DesktopWritable(this);
  };

  function DesktopDirectoryHandle(root, parts, name) {
    this.kind = 'directory';
    this.name = name;
    this.root = root;
    this.parts = parts;
    this[MARK] = 'directory';
  }
  DesktopDirectoryHandle.prototype.getFileHandle = async function (name, options) {
    checkName(name);
    var parts = this.parts.concat(name);
    var st = await api.stat(this.root, parts);
    if (st.ok) {
      if (st.kind !== 'file') throw domError('TypeMismatchError', 'Not a file.');
    } else if (st.code === 'ENOENT' && options && options.create) {
      // nothing is created until the first write: an empty file would only be
      // uploaded by MEGA and read as broken by the other computers
    } else {
      throw errorFor(st, false);
    }
    return new DesktopFileHandle(this.root, parts, name);
  };
  DesktopDirectoryHandle.prototype.getDirectoryHandle = async function (name, options) {
    checkName(name);
    var parts = this.parts.concat(name);
    var st = await api.stat(this.root, parts);
    if (st.ok) {
      if (st.kind !== 'directory') throw domError('TypeMismatchError', 'Not a folder.');
    } else if (st.code === 'ENOENT' && options && options.create) {
      var made = await api.mkdir(this.root, parts);
      if (!made.ok) throw errorFor(made, true);
    } else {
      throw errorFor(st, false);
    }
    return new DesktopDirectoryHandle(this.root, parts, name);
  };
  DesktopDirectoryHandle.prototype.removeEntry = async function (name, options) {
    checkName(name);
    var res = await api.remove(this.root, this.parts.concat(name), !!(options && options.recursive));
    if (!res.ok) throw errorFor(res, true);
  };
  DesktopDirectoryHandle.prototype._children = async function () {
    var res = await api.list(this.root, this.parts);
    if (!res.ok) throw errorFor(res, false);
    var self = this;
    return res.entries.map(function (e) {
      var parts = self.parts.concat(e.name);
      return e.kind === 'directory'
        ? new DesktopDirectoryHandle(self.root, parts, e.name)
        : new DesktopFileHandle(self.root, parts, e.name);
    });
  };
  DesktopDirectoryHandle.prototype.values = async function* () {
    var list = await this._children();
    for (var i = 0; i < list.length; i++) yield list[i];
  };
  DesktopDirectoryHandle.prototype.keys = async function* () {
    var list = await this._children();
    for (var i = 0; i < list.length; i++) yield list[i].name;
  };
  DesktopDirectoryHandle.prototype.entries = async function* () {
    var list = await this._children();
    for (var i = 0; i < list.length; i++) yield [list[i].name, list[i]];
  };
  DesktopDirectoryHandle.prototype[Symbol.asyncIterator] = DesktopDirectoryHandle.prototype.entries;
  DesktopDirectoryHandle.prototype.resolve = async function (other) {
    if (!other || other.root !== this.root || !Array.isArray(other.parts)) return null;
    if (other.parts.length < this.parts.length) return null;
    for (var i = 0; i < this.parts.length; i++) {
      if (other.parts[i] !== this.parts[i]) return null;
    }
    return other.parts.slice(this.parts.length);
  };

  [DesktopFileHandle, DesktopDirectoryHandle].forEach(function (Handle) {
    Handle.prototype.queryPermission = function () { return permissionState(this.root); };
    Handle.prototype.requestPermission = function () { return askPermission(this.root); };
    Handle.prototype.isSameEntry = async function (other) {
      return !!other && other.root === this.root && Array.isArray(other.parts) &&
        other.parts.join('/') === this.parts.join('/');
    };
  });

  /* ---------------- the pickers ---------------- */

  window.showDirectoryPicker = async function () {
    var res = await api.pickDirectory();
    if (!res.ok) throw errorFor(res, false);
    return new DesktopDirectoryHandle(res.root, [], res.name);
  };

  window.showSaveFilePicker = async function (options) {
    var o = options || {};
    var filters = [];
    (o.types || []).forEach(function (t) {
      var exts = [];
      Object.keys((t && t.accept) || {}).forEach(function (mime) {
        [].concat(t.accept[mime] || []).forEach(function (e) {
          e = String(e).replace(/^\./, '');
          if (e) exts.push(e);
        });
      });
      if (exts.length) filters.push({ name: t.description || exts.join(', '), extensions: exts });
    });
    var res = await api.pickSaveFile({ suggestedName: o.suggestedName || '', filters: filters });
    if (!res.ok) throw errorFor(res, false);
    return new DesktopFileHandle(res.root, [], res.name);
  };

  /* ---------------- handles kept in IndexedDB ---------------- */

  function revive(v) {
    if (!v || typeof v !== 'object' || !v[MARK]) return v;
    if (typeof v.root !== 'string' || !Array.isArray(v.parts)) return v;
    if (v instanceof DesktopFileHandle || v instanceof DesktopDirectoryHandle) return v;
    return v[MARK] === 'directory'
      ? new DesktopDirectoryHandle(v.root, v.parts.slice(), String(v.name || ''))
      : new DesktopFileHandle(v.root, v.parts.slice(), String(v.name || ''));
  }

  /* ---------------- what the application stores on this computer ----------------

    The tracker keeps its working copy in the application's own storage
    (localStorage and IndexedDB), which ends up as ordinary files in the
    profile folder. With a local key from the main process — a key Windows
    locks to this user account — every value is sealed before it is stored
    and opened again as it is read, so those files show nothing readable.

    The tracker's code is not involved: it saves and loads exactly as before.
    Anything saved before this existed is still read as it is, and sealed the
    next time it is written (and once, shortly after start, by the sweep at
    the end).
  */

  var SEALED = '__daxilSealed';
  var LS_SEALED = '\u0001daxil1:';
  var UNSEALED_DBS = { 'daxil-sync-db': true };       // holds folder handles and key objects, not records
  var localKey = null;

  try {
    var keyText = desktop.takeLocalKey ? desktop.takeLocalKey() : '';
    if (keyText && window.nacl) {
      var kb = atob(keyText);
      localKey = new Uint8Array(kb.length);
      for (var ki = 0; ki < kb.length; ki++) localKey[ki] = kb.charCodeAt(ki);
      if (localKey.length !== 32) localKey = null;
    }
  } catch (e) { localKey = null; }

  var utf8 = new TextEncoder();
  var fromUtf8 = new TextDecoder();

  function sealText(text) {
    var nonce = nacl.randomBytes(24);
    var box = nacl.secretbox(utf8.encode(text), nonce, localKey);
    var out = new Uint8Array(24 + box.length);
    out.set(nonce, 0);
    out.set(box, 24);
    return out;
  }

  /* null when the bytes were not sealed with this computer's key */
  function openText(bytes) {
    var plain = nacl.secretbox.open(bytes.subarray(24), bytes.subarray(0, 24), localKey);
    return plain ? fromUtf8.decode(plain) : null;
  }

  function bytesToB64(bytes) {
    var bin = '';
    for (var i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(bin);
  }

  function b64ToBytes(b64) {
    var bin = atob(b64);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function storeIsSealed(store) {
    try {
      return !!localKey && typeof store.keyPath === 'string' && !!store.keyPath &&
        store.keyPath.indexOf('.') === -1 && !UNSEALED_DBS[store.transaction.db.name];
    } catch (e) { return false; }
  }

  // the record's own key stays outside the seal, so the store can still find it
  function sealRecord(store, value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || value[SEALED]) return value;
    var json;
    try { json = JSON.stringify(value); } catch (e) { return value; }
    if (json === undefined) return value;
    var out = {};
    out[store.keyPath] = value[store.keyPath];
    out[SEALED] = sealText(json);
    return out;
  }

  function openRecord(v) {
    if (!v || typeof v !== 'object' || !(v[SEALED] instanceof Uint8Array)) return v;
    if (!localKey) return v;
    var text = openText(v[SEALED]);
    if (text === null) {
      console.error('Desktop shim: a stored record could not be opened with this computer\'s key');
      return v;
    }
    return JSON.parse(text);
  }

  function openValue(v) {
    if (!v || typeof v !== 'object') return v;
    if (v[MARK]) return revive(v);
    if (Array.isArray(v)) {
      for (var i = 0; i < v.length; i++) {
        if (v[i] && typeof v[i] === 'object' && v[i][SEALED]) return v.map(openRecord);
      }
      return v;
    }
    return v[SEALED] ? openRecord(v) : v;
  }

  // one place hands back both things kept as bare data: folder handles and sealed records
  var rawResult = null;
  try {
    var desc = Object.getOwnPropertyDescriptor(IDBRequest.prototype, 'result');
    if (desc && desc.get) {
      rawResult = desc.get;
      var opened = new WeakMap();        // a request's result is read more than once; it is opened once
      Object.defineProperty(IDBRequest.prototype, 'result', {
        configurable: true,
        enumerable: desc.enumerable,
        get: function () {
          var v = desc.get.call(this);
          if (!v || typeof v !== 'object') return v;
          var hit = opened.get(this);
          if (hit && hit.raw === v) return hit.value;
          var value = openValue(v);
          opened.set(this, { raw: v, value: value });
          return value;
        }
      });
    }
  } catch (e) { console.error('Desktop shim: could not prepare stored folders', e); }

  if (localKey && rawResult) {
    try {
      var rawPut = IDBObjectStore.prototype.put;
      var rawAdd = IDBObjectStore.prototype.add;
      IDBObjectStore.prototype.put = function (value, key) {
        if (storeIsSealed(this)) value = sealRecord(this, value);
        return arguments.length > 1 ? rawPut.call(this, value, key) : rawPut.call(this, value);
      };
      IDBObjectStore.prototype.add = function (value, key) {
        if (storeIsSealed(this)) value = sealRecord(this, value);
        return arguments.length > 1 ? rawAdd.call(this, value, key) : rawAdd.call(this, value);
      };

      var cursorValue = Object.getOwnPropertyDescriptor(IDBCursorWithValue.prototype, 'value');
      if (cursorValue && cursorValue.get) {
        Object.defineProperty(IDBCursorWithValue.prototype, 'value', {
          configurable: true,
          enumerable: cursorValue.enumerable,
          get: function () { return openValue(cursorValue.get.call(this)); }
        });
      }
      var rawUpdate = IDBCursor.prototype.update;
      IDBCursor.prototype.update = function (value) {
        var store = this.source && this.source.objectStore ? this.source.objectStore : this.source;
        if (store && storeIsSealed(store)) value = sealRecord(store, value);
        return rawUpdate.call(this, value);
      };

      // localStorage: the names stay, the values are sealed
      var rawGetItem = Storage.prototype.getItem;
      var rawSetItem = Storage.prototype.setItem;
      Storage.prototype.getItem = function (name) {
        var v = rawGetItem.call(this, name);
        if (v === null || this !== window.localStorage || v.indexOf(LS_SEALED) !== 0) return v;
        var text = null;
        try { text = openText(b64ToBytes(v.slice(LS_SEALED.length))); } catch (e) { text = null; }
        if (text === null) {
          console.error('Desktop shim: "' + name + '" could not be opened with this computer\'s key');
        }
        return text;
      };
      Storage.prototype.setItem = function (name, value) {
        if (this !== window.localStorage) return rawSetItem.call(this, name, value);
        return rawSetItem.call(this, name, LS_SEALED + bytesToB64(sealText(String(value))));
      };

      // whatever was stored before sealing existed is sealed now, once
      (function sealOldLocalStorage() {
        var names = [];
        for (var i = 0; i < localStorage.length; i++) names.push(localStorage.key(i));
        names.forEach(function (name) {
          var v = rawGetItem.call(localStorage, name);
          if (v !== null && v.indexOf(LS_SEALED) !== 0) {
            try { localStorage.setItem(name, v); } catch (e) { /* stays as it was */ }
          }
        });
      })();

      window.addEventListener('load', function () {
        setTimeout(function sealOldRecords() {
          if (!indexedDB.databases) return;
          indexedDB.databases().then(function (list) {
            list.forEach(function (info) {
              if (!info.name || UNSEALED_DBS[info.name]) return;
              var req = indexedDB.open(info.name);
              req.onsuccess = function () {
                var db = rawResult.call(req);
                db.onversionchange = function () { db.close(); };   // never stand in the tracker's way
                var names = Array.prototype.slice.call(db.objectStoreNames);
                if (!names.length) { db.close(); return; }
                var pending = names.length;
                var doneOne = function () { if (--pending === 0) db.close(); };
                names.forEach(function (storeName) {
                  try {
                    var tx = db.transaction(storeName, 'readwrite');
                    var store = tx.objectStore(storeName);
                    tx.oncomplete = doneOne; tx.onerror = doneOne; tx.onabort = doneOne;
                    if (!storeIsSealed(store)) return;
                    var all = store.getAll();
                    all.onsuccess = function () {
                      (rawResult.call(all) || []).forEach(function (rec) {
                        if (rec && typeof rec === 'object' && !rec[SEALED]) store.put(rec);
                      });
                    };
                  } catch (e) { doneOne(); }
                });
              };
            });
          }).catch(function () { /* next start */ });
        }, 5000);
      });
    } catch (e) { console.error('Desktop shim: storage sealing could not be set up', e); }
  }

  /* ---------------- a newer version ---------------- */

  // the main process looks for one; this only shows what it found
  function showUpdate(state) {
    if (!window.daxilUpdateBar || !state) return;
    if (state.status === 'available') {
      window.daxilUpdateBar.offer({ version: state.version, install: function () { return desktop.update.install(); } });
    } else if (state.status === 'needs-installer') {
      window.daxilUpdateBar.needsInstaller(state.version);
    } else if (state.status === 'none') {
      window.daxilUpdateBar.hide();
    }
  }
  if (desktop.update) {
    try {
      desktop.update.onState(showUpdate);
      showUpdate(desktop.update.state());
    } catch (e) { console.error('Desktop shim: updates could not be watched', e); }
  }

  /* ---------------- dialogs ---------------- */

  window.alert = function (message) {
    desktop.dialog('alert', message === undefined ? '' : String(message), '');
  };
  window.confirm = function (message) {
    return desktop.dialog('confirm', message === undefined ? '' : String(message), '') === true;
  };
  window.prompt = function (message, defaultValue) {
    var v = desktop.dialog('prompt',
      message === undefined ? '' : String(message),
      defaultValue === undefined || defaultValue === null ? '' : String(defaultValue));
    return typeof v === 'string' ? v : null;
  };

  /*
    Printing. Electron sends window.print() straight to the Windows dialog,
    which has no preview ("This app doesn't support print preview"). An
    installer from 2.96 on shows a preview window first — the pages as a PDF,
    with print, save as PDF and close. An older installer prints as before.
  */
  if (typeof desktop.printPreview === 'function') {
    var plainPrint = window.print.bind(window);
    window.print = function () {
      desktop.printPreview().then(function (shown) {
        if (shown !== true) plainPrint();
      }, function (e) {
        console.error('Desktop shim: print preview failed, printing directly', e);
        plainPrint();
      });
    };
  }
})();
