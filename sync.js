// WinterCon shared-state sync layer.
// Mirrors every localStorage key starting with "wincon_" to the site's
// /api/state backend so all visitors share the same roster, map pins,
// planner picks, mindmap, notes, and ops data.
//
// Include early in <head> so the Storage patch is installed before page
// scripts run. Degrades gracefully: on file:// or if the API is down,
// pages just behave like the old localStorage-only version.
(function () {
  'use strict';
  if (location.protocol === 'file:') return; // local folder use: stay offline

  var PREFIX = 'wincon_';
  var API = '/api/state';
  var RELOAD_FLAG = 'wc-sync-reloaded';
  var ready = false;              // becomes true after the initial pull
  var pending = new Map();        // key -> value|null queued for upload
  var flushTimer = null;
  var lastSync = 0;
  var bannerShown = false;

  var origSet = Storage.prototype.setItem;
  var origRemove = Storage.prototype.removeItem;

  Storage.prototype.setItem = function (k, v) {
    origSet.call(this, k, v);
    if (this === window.localStorage && typeof k === 'string' && k.indexOf(PREFIX) === 0) schedule(k, String(v));
  };
  Storage.prototype.removeItem = function (k) {
    origRemove.call(this, k);
    if (this === window.localStorage && typeof k === 'string' && k.indexOf(PREFIX) === 0) schedule(k, null);
  };

  function schedule(key, value) {
    pending.set(key, value);
    if (ready) armFlush(800);
  }

  function armFlush(delay) {
    clearTimeout(flushTimer);
    flushTimer = setTimeout(flush, delay);
  }

  function flush() {
    var entries = Array.from(pending.entries());
    pending.clear();
    entries.forEach(function (e) {
      var key = e[0], value = e[1];
      var req = value === null
        ? fetch(API + '/' + encodeURIComponent(key), { method: 'DELETE' })
        : fetch(API + '/' + encodeURIComponent(key), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ v: value }),
          });
      req.catch(function () { pending.set(key, value); armFlush(5000); });
    });
  }

  function applyServerStates(states) {
    var changed = false;
    Object.keys(states || {}).forEach(function (key) {
      var rec = states[key];
      var local = origGet(key);
      if (rec.v === '') { // tombstone
        if (local !== null) { origRemove.call(localStorage, key); changed = true; }
      } else if (local !== rec.v) {
        origSet.call(localStorage, key, rec.v);
        changed = true;
      }
    });
    return changed;
  }

  function origGet(key) {
    return Storage.prototype.getItem.call(localStorage, key);
  }

  function pull() {
    return fetch(API + (lastSync ? '?since=' + lastSync : ''))
      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(function (data) {
        lastSync = data.now || Date.now();
        return applyServerStates(data.states);
      });
  }

  function showBanner() {
    if (bannerShown) return;
    bannerShown = true;
    var bar = document.createElement('div');
    bar.style.cssText = 'position:fixed;bottom:14px;left:50%;transform:translateX(-50%);z-index:99999;' +
      'background:#1D4E7C;color:#fff;padding:10px 18px;border-radius:8px;font:14px/1.4 system-ui,sans-serif;' +
      'box-shadow:0 4px 14px rgba(0,0,0,.35);display:flex;gap:12px;align-items:center';
    bar.appendChild(document.createTextNode('Someone updated the shared data.'));
    var btn = document.createElement('button');
    btn.textContent = 'Refresh';
    btn.style.cssText = 'background:#fff;color:#1D4E7C;border:0;border-radius:6px;padding:6px 14px;font-weight:700;cursor:pointer';
    btn.onclick = function () { location.reload(); };
    bar.appendChild(btn);
    document.body.appendChild(bar);
  }

  function start() {
    pull()
      .then(function (changed) {
        // Server wins at boot: discard writes the page queued while loading
        // (e.g. seed data) for keys the server already knows about, then
        // reload once so the app re-inits from the shared data.
        if (changed && !sessionStorage.getItem(RELOAD_FLAG)) {
          sessionStorage.setItem(RELOAD_FLAG, '1');
          location.reload();
          return;
        }
        sessionStorage.removeItem(RELOAD_FLAG);
        ready = true;
        if (pending.size) armFlush(400); // first-ever visitor seeds the server
        setInterval(function () {
          pull().then(function (changed) { if (changed) showBanner(); }).catch(function () {});
        }, 25000);
      })
      .catch(function () {
        // API unreachable: run pure-local, retry queue occasionally
        ready = true;
        if (pending.size) armFlush(5000);
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
