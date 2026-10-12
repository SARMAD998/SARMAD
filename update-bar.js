/*
  The "new version" bar — the same on the computer application and in the web
  app. It only draws the bar; each of them decides when a new version exists
  and what "update" means for it (see desktop-shim.js and webapp/web-shim.js).

      daxilUpdateBar.offer({ version, install })   a new version can be installed now;
                                                   install() returns a promise
      daxilUpdateBar.needsInstaller(version)       a new version exists, but this computer
                                                   needs the new installer first
      daxilUpdateBar.hide()

  Nothing is updated until the person presses the button: a page that reloaded
  by itself could take a half-typed record with it.
*/
(function () {
  'use strict';

  var TEXT = {
    ready: 'وەشانێکی نوێی سیستەمەکە ئامادەیە — تکایە سیستەمەکەت نوێ بکەرەوە.',
    now: 'ئێستا نوێ بکەرەوە',
    later: 'دواتر',
    working: 'نوێ دەکرێتەوە...',
    failed: 'نوێکردنەوە سەرکەوتوو نەبوو — ئینتەرنێتەکەت بپشکنە و دووبارە هەوڵ بدەرەوە.',
    installer: 'وەشانێکی نوێی سیستەمەکە هەیە، بەڵام ئەم کۆمپیوتەرە پێویستی بە دامەزرێنەری نوێ هەیە — ' +
               'پەیوەندی بە بەڕێوەبەری سیستەم بکە.',
    version: 'وەشانی '
  };

  var bar = null;
  var dismissed = '';          // the version the person chose "later" for, until the app is opened again

  function style() {
    if (document.getElementById('daxilUpdateBarStyle')) return;
    var s = document.createElement('style');
    s.id = 'daxilUpdateBarStyle';
    s.textContent =
      '#daxilUpdateBar{position:fixed;top:0;left:0;right:0;z-index:9999;direction:rtl;' +
        'display:flex;align-items:center;justify-content:center;gap:12px;flex-wrap:wrap;' +
        'padding:max(10px,env(safe-area-inset-top)) 14px 10px;background:#1d4ed8;color:#fff;' +
        'font-family:inherit;font-size:13.5px;line-height:1.7;box-shadow:0 2px 14px rgba(0,0,0,.28);}' +
      '#daxilUpdateBar .dub-text{font-weight:700;text-align:center;}' +
      '#daxilUpdateBar .dub-ver{font-weight:400;opacity:.85;margin-right:6px;direction:ltr;display:inline-block;}' +
      '#daxilUpdateBar button{font-family:inherit;font-size:13px;font-weight:700;cursor:pointer;border-radius:6px;' +
        'padding:7px 16px;min-height:0;width:auto;}' +
      '#daxilUpdateBar .dub-now{background:#fff;color:#1d4ed8;border:1px solid #fff;}' +
      '#daxilUpdateBar .dub-now:disabled{opacity:.7;cursor:default;}' +
      '#daxilUpdateBar .dub-later{background:transparent;color:#fff;border:1px solid rgba(255,255,255,.6);}' +
      '#daxilUpdateBar.dub-warn{background:#b45309;}' +
      '@media print{#daxilUpdateBar,#daxilUpdateBarSpace{display:none !important;}}';
    document.head.appendChild(s);
  }

  var space = null;            // keeps the page from sliding under the bar

  function hide() {
    if (bar) { bar.remove(); bar = null; }
    if (space) { space.remove(); space = null; }
  }

  function makeRoom() {
    if (!bar || !document.body) return;
    if (!space) {
      space = document.createElement('div');
      space.id = 'daxilUpdateBarSpace';
      document.body.insertBefore(space, document.body.firstChild);
    }
    space.style.height = bar.offsetHeight + 'px';
  }

  function make(text, version) {
    hide();
    style();
    bar = document.createElement('div');
    bar.id = 'daxilUpdateBar';
    bar.setAttribute('role', 'status');
    var label = document.createElement('span');
    label.className = 'dub-text';
    label.textContent = text;
    if (version) {
      var v = document.createElement('span');
      v.className = 'dub-ver';
      v.textContent = '(' + TEXT.version + version + ')';
      label.appendChild(v);
    }
    bar.appendChild(label);
    (document.body || document.documentElement).appendChild(bar);
    makeRoom();
    return label;
  }

  function button(className, text) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = className;
    b.textContent = text;
    bar.appendChild(b);
    makeRoom();
    return b;
  }

  window.addEventListener('resize', makeRoom);

  function whenReady(fn) {
    if (document.body) fn();
    else document.addEventListener('DOMContentLoaded', fn);
  }

  window.daxilUpdateBar = {
    offer: function (options) {
      var version = (options && options.version) || '';
      if (dismissed && dismissed === (version || 'new')) return;
      whenReady(function () {
        var label = make(TEXT.ready, version);
        var now = button('dub-now', TEXT.now);
        var later = button('dub-later', TEXT.later);
        var busy = false;

        now.addEventListener('click', function () {
          if (busy) return;
          busy = true;
          now.disabled = true;
          now.textContent = TEXT.working;
          later.style.display = 'none';
          Promise.resolve().then(function () { return options.install(); }).then(function (result) {
            // a successful update reloads the page, and this bar goes with it
            if (result && result.ok === false) throw new Error(result.message || 'failed');
          }).catch(function () {
            busy = false;
            now.disabled = false;
            now.textContent = TEXT.now;
            later.style.display = '';
            label.firstChild.nodeValue = TEXT.failed;
          });
        });
        later.addEventListener('click', function () {
          dismissed = version || 'new';
          hide();
        });
      });
    },

    needsInstaller: function (version) {
      if (dismissed && dismissed === 'installer:' + version) return;
      whenReady(function () {
        make(TEXT.installer, version);
        bar.className = 'dub-warn';
        button('dub-later', TEXT.later).addEventListener('click', function () {
          dismissed = 'installer:' + version;
          hide();
        });
      });
    },

    hide: hide,
    isShown: function () { return !!bar; }
  };
})();
