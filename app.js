/*
 * 学習音声プレーヤー app.js
 * 古いスマホでも動くよう、?. や ?? は使わない（ES2017 まで）
 */
(function () {
  'use strict';

  var APP_VERSION = '1.6.0';
  var RATES = [1.0, 1.3, 1.5, 1.8, 2.0, 2.2];
  var STATUS_LIST = [
    { key: 'none', label: '未評価', mark: '' },
    { key: 'good', label: '◎ 完璧', mark: '◎' },
    { key: 'again', label: '△ もう一度', mark: '△' },
    { key: 'text', label: '× 要テキスト確認', mark: '×' }
  ];
  var LAP_POS = 0.9;        // 再生位置が 90% に届いたら 1 周
  var LAP_LISTEN = 0.5;     // ただし前の周回のあと、長さの半分以上は実際に聞いていること（飛ばし聞き対策）
  var SMART_REWIND = 3;     // 一時停止から再開するとき 3 秒戻す
  var LOG_EVERY_SEC = 300;  // 続けて聞いているときも 5 分ごとに送信キューへ
  var K = {
    settings: 'sap.settings', daily: 'sap.daily', queue: 'sap.queue',
    last: 'sap.last', rate: 'sap.rate', ui: 'sap.ui', sync: 'sap.sync',
    device: 'sap.device', dbase: 'sap.dbase', sdirty: 'sap.sdirty'
  };

  function $(id) { return document.getElementById(id); }
  function lsGet(k, def) {
    try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : def; } catch (e) { return def; }
  }
  function lsSet(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* 容量いっぱいなど */ }
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function dateKey(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function fmtTime(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return h > 0 ? h + ':' + pad(m) + ':' + pad(s) : m + ':' + pad(s);
  }
  function fmtMin(sec) {
    var m = Math.floor((sec || 0) / 60);
    if (m >= 60) return Math.floor(m / 60) + '時間' + (m % 60) + '分';
    return m + '分';
  }
  function fmtDate(ms) {
    if (!ms) return '—';
    var d = new Date(ms);
    return (d.getMonth() + 1) + '/' + d.getDate();
  }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  // 全角数字もふつうの数字として比べる「自然な並び」（第2回 < 第10回）
  function natKey(s) {
    s = String(s).replace(/[０-９]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); });
    return s.toLowerCase().match(/\d+|\D+/g) || [];
  }
  function natcmp(a, b) {
    var x = natKey(a), y = natKey(b), n = Math.min(x.length, y.length);
    for (var i = 0; i < n; i++) {
      if (x[i] === y[i]) continue;
      var dx = /^\d/.test(x[i]), dy = /^\d/.test(y[i]);
      if (dx && dy) { var d = parseInt(x[i], 10) - parseInt(y[i], 10); if (d) return d; }
      return x[i] < y[i] ? -1 : 1;
    }
    return x.length - y.length;
  }

  /* ---------- ファイル名から 科目・コース・題名 を読む ----------
   * 例「不動産登記法＜基礎＞1 所有権に関する登記（1）.mp3」
   *   → 科目「不動産登記法」・コース「基礎」・題名「1 所有権に関する登記（1）」
   * ＜＞ のほか <> 〈〉 《》 【】 [] でもよい。形が合わないときは取り込み欄の科目名（なければ「未分類」）
   */
  var NAME_PAT = /^(.+?)\s*[＜<〈《【\[]\s*([^＜<＞>〈〉《》【】\[\]]+?)\s*[＞>〉》】\]]\s*(.*)$/;
  function parseName(fileName) {
    var base = String(fileName).replace(/\.[^.]+$/, '').trim();
    var m = base.match(NAME_PAT);
    if (!m || !m[1].trim()) return null;
    return { subject: m[1].trim(), course: m[2].trim(), title: m[3].trim() || base };
  }
  function groupOf(t) { return t.subject + (t.course ? '＜' + t.course + '＞' : ''); }
  function titleOf(t) { return t.title || t.name.replace(/\.[^.]+$/, ''); }

  /* ---------- 設定・記録（localStorage） ---------- */
  var settings = lsGet(K.settings, {});
  if (!settings.goalMin) settings.goalMin = 15;
  if (settings.autoNext === undefined) settings.autoNext = true;
  if (!settings.trackBtn) settings.trackBtn = 'track';
  if (settings.gasUrl === undefined) settings.gasUrl = '';
  if (settings.secret === undefined) settings.secret = '';
  if (settings.subject === undefined) settings.subject = '';
  if (settings.deviceName === undefined) {
    var ua = navigator.userAgent || '';
    settings.deviceName = /iPad/.test(ua) ? 'iPad' : /iPhone/.test(ua) ? 'iPhone' : /Android/.test(ua) ? 'Android' : 'パソコン';
  }
  var daily = lsGet(K.daily, {});     // { "2026-11-18": { r: 実秒, l: 講義秒 } }
  var queue = lsGet(K.queue, []);     // 未送信のログ
  var ui = lsGet(K.ui, { tab: 'list', subject: '', view: 'all', sort: 'no' });
  var syncState = lsGet(K.sync, { lastOk: 0, lastErr: '' });
  var rate = parseFloat(lsGet(K.rate, 1.0)) || 1.0;

  /* ---------- IndexedDB（音声の中身と単元の記録） ---------- */
  var db = null;
  function openDB() {
    return new Promise(function (res, rej) {
      if (!window.indexedDB) { rej(new Error('IndexedDB が使えません')); return; }
      var r = indexedDB.open('studyAudioPlayer', 1);
      r.onupgradeneeded = function () {
        var d = r.result;
        if (!d.objectStoreNames.contains('tracks')) d.createObjectStore('tracks', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('audio')) d.createObjectStore('audio', { keyPath: 'id' });
      };
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error); };
    });
  }
  function idbReq(store, mode, fn) {
    return new Promise(function (res, rej) {
      var t = db.transaction(store, mode), result;
      var req = fn(t.objectStore(store));
      if (req) req.onsuccess = function () { result = req.result; };
      t.oncomplete = function () { res(result); };
      t.onerror = function () { rej(t.error); };
      t.onabort = function () { rej(t.error || new Error('abort')); };
    });
  }
  function idbPut(store, obj) { return idbReq(store, 'readwrite', function (s) { return s.put(obj); }); }
  var curFromStore = false, curRetried = false;
  function idbGet(store, id) { return idbReq(store, 'readonly', function (s) { return s.get(id); }); }
  // 音声の入れ物：使えるスマホでは Blob のまま（開くときにコピーが要らず軽い）、だめなら ArrayBuffer
  var blobOK = null;
  async function probeBlob() {
    var c = lsGet('sap.blobok', null);
    if (c && c.ua === navigator.userAgent) { blobOK = !!c.ok; return; }
    var ok = false;
    try {
      await idbPut('audio', { id: '__probe', type: 'audio/mpeg', blob: new Blob([new Uint8Array([1, 2, 3, 4, 5])], { type: 'audio/mpeg' }) });
      var r = await idbGet('audio', '__probe');
      if (r && r.blob && r.blob.size === 5) {
        var ab = await readFile(r.blob);
        ok = ab.byteLength === 5 && new Uint8Array(ab)[4] === 5;
      }
      await idbDel('audio', '__probe');
    } catch (e) { ok = false; }
    blobOK = ok;
    lsSet('sap.blobok', { ua: navigator.userAgent, ok: ok });
  }
  function audioRec(id, type, buf) {
    type = type || 'audio/mpeg';
    return blobOK ? { id: id, type: type, blob: new Blob([buf], { type: type }) } : { id: id, type: type, data: buf };
  }
  function idbDel(store, id) { return idbReq(store, 'readwrite', function (s) { return s.delete(id); }); }
  function idbClear(store) { return idbReq(store, 'readwrite', function (s) { return s.clear(); }); }
  function idbAll(store) {
    // getAll は古い Safari にないのでカーソルで読む
    return new Promise(function (res, rej) {
      var out = [], t = db.transaction(store, 'readonly');
      var c = t.objectStore(store).openCursor();
      c.onsuccess = function () { var cur = c.result; if (cur) { out.push(cur.value); cur.continue(); } };
      t.oncomplete = function () { res(out); };
      t.onerror = function () { rej(t.error); };
    });
  }
  function readFile(file) {
    if (file && file._buf) return Promise.resolve(file._buf);   // Drive から取ってきたもの
    return new Promise(function (res, rej) {
      var fr = new FileReader();
      fr.onload = function () { res(fr.result); };
      fr.onerror = function () { rej(fr.error); };
      fr.readAsArrayBuffer(file);
    });
  }

  /* ---------- 単元（トラック） ---------- */
  var tracks = [];   // 記録だけ（音声の中身はメモリに置かない）
  var byId = {};
  function sortTracks() {
    tracks.sort(function (a, b) {
      if (a.subject !== b.subject) return natcmp(a.subject, b.subject);
      if ((a.course || '') !== (b.course || '')) return natcmp(a.course || '', b.course || '');
      return (a.no || 0) - (b.no || 0);
    });
    byId = {};
    tracks.forEach(function (t) { byId[t.id] = t; });
  }
  function renumber(group) {
    var list = tracks.filter(function (t) { return groupOf(t) === group; });
    list.sort(function (a, b) { return natcmp(a.name, b.name); });
    // 題名の頭に講義番号（「10 抵当権」の 10）が全部に付いていて重ならなければ、それを番号にする
    var nums = list.map(function (t) {
      var m = String(titleOf(t)).replace(/[０-９]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); }).match(/^第?(\d+)/);
      return m ? parseInt(m[1], 10) : null;
    });
    var seen = {}, useNum = list.length > 0;
    nums.forEach(function (n) { if (n === null || seen[n]) useNum = false; else seen[n] = 1; });
    list.forEach(function (t, i) { t.no = useNum ? nums[i] : i + 1; });
    return list;
  }
  function subjects() {
    var seen = {}, out = [];
    tracks.forEach(function (t) { if (!seen[t.subject]) { seen[t.subject] = 1; out.push(t.subject); } });
    return out.sort(natcmp);
  }
  function groups() {
    // 並び順（科目→コース）のまま「科目＜コース＞」の一覧
    var seen = {}, out = [];
    tracks.forEach(function (t) { var g = groupOf(t); if (!seen[g]) { seen[g] = 1; out.push(g); } });
    return out;
  }
  function coursesOf(subject) {
    var seen = {}, out = [];
    tracks.forEach(function (t) { if (t.subject === subject && !seen[t.course || '']) { seen[t.course || ''] = 1; out.push(t.course || ''); } });
    return out;
  }
  // 絞り込みの値：'' すべて／'s:科目' 科目まるごと／'g:科目＜コース＞'
  function matchFilter(t, v) {
    if (!v) return true;
    if (v.indexOf('s:') === 0) return t.subject === v.slice(2);
    if (v.indexOf('g:') === 0) return groupOf(t) === v.slice(2);
    return groupOf(t) === v;
  }
  var dirty = {};
  function markDirty(t) { dirty[t.id] = t; }
  function saveDirty() {
    var ids = Object.keys(dirty);
    if (!ids.length || !db) return Promise.resolve();
    var list = ids.map(function (k) { return dirty[k]; });
    dirty = {};
    return idbReq('tracks', 'readwrite', function (s) { list.forEach(function (t) { s.put(t); }); return null; })
      .catch(function (e) { console.warn(e); });
  }

  // もう取り込んである講義（同じ科目・コースで、名前が同じ。録り直しの「_2」も同じとみなす）
  function infoOf(name, subject) {
    return parseName(name) || { subject: (subject || '').trim() || '未分類', course: '', title: String(name).replace(/\.[^.]+$/, '') };
  }
  // 取り込んだときの分類（あとで分類を変えても、Drive やファイルとの照らし合わせはこちらで）
  function srcOf(t) { return t.src || { subject: t.subject, course: t.course || '' }; }
  function findSame(info, name) {
    var key = sameKey(name);
    for (var j = 0; j < tracks.length; j++) {
      var t0 = tracks[j], s0 = srcOf(t0);
      if (s0.subject === info.subject && (s0.course || '') === info.course && sameKey(t0.name) === key) return t0;
    }
    return null;
  }

  // opts.replace … 同じ講義があれば聞かずに差し替える（Drive で選んだとき）
  async function importFiles(fileList, subject, opts) {
    opts = opts || {};
    subject = (subject || '').trim() || '未分類';
    var touched = {}, lastGroup = '';
    var files = [].slice.call(fileList).filter(function (f) {
      return /^audio\//.test(f.type) || /\.(mp3|m4a|aac|wav|ogg)$/i.test(f.name);
    });
    files.sort(function (a, b) { return natcmp(a.name, b.name); });
    if (!files.length) {
      var nm = [].slice.call(fileList).map(function (f) { return f.name; }).join('、');
      toast('音声ファイルではないようです：' + nm, 6000); return;
    }
    // 消されにくくするお願い。古い iPhone では返事が来ないことがあるので待たない
    if (navigator.storage && navigator.storage.persist) { try { navigator.storage.persist().catch(function () {}); } catch (e) { /* 無視 */ } }
    var plan = files.map(function (f) {
      var info = infoOf(f.name, subject);
      return { f: f, info: info, match: findSame(info, f.name) };
    });
    var dups = plan.filter(function (p) { return p.match; });
    var doReplace = !!opts.replace;
    if (dups.length && !doReplace) {
      var names = dups.slice(0, 5).map(function (p) { return '・' + p.f.name; }).join('\n') + (dups.length > 5 ? '\n…ほか ' + (dups.length - 5) + ' 件' : '');
      doReplace = confirm('次の ' + dups.length + ' 件は、もう取り込んであります。\n' + names +
        '\n\n［OK］音声だけ差し替える（周回数・聴取時間・理解度はそのまま。続きの位置は最初に戻る）\n［キャンセル］この ' + dups.length + ' 件は取り込まない');
    }
    var added = 0, skipped = 0, replaced = 0;
    for (var i = 0; i < plan.length; i++) {
      var f = plan[i].f, info = plan[i].info;
      if (plan[i].match) {
        if (!doReplace) { skipped++; continue; }
        toast('差し替え中 ' + (i + 1) + ' / ' + plan.length, 60000);
        try { await replaceAudio(plan[i].match, f); replaced++; }
        catch (e) { console.error(e); toast('「' + f.name + '」で止まりました。スマホの空き容量が足りないかもしれません', 6000); break; }
        continue;
      }
      toast('取り込み中 ' + (i + 1) + ' / ' + plan.length, 60000);
      try {
        var buf = await readFile(f);
        var id = uid();
        await idbPut('audio', audioRec(id, f.type, buf));
        buf = null;
        var t = {
          id: id, subject: info.subject, course: info.course, title: info.title, name: f.name, no: 0, size: f.size, duration: 0,
          playCount: 0, lastPlayedAt: 0, listenedSec: 0, lectureSec: 0, lapLec: 0,
          status: 'none', lastPos: 0, addedAt: Date.now()
        };
        if (f.driveId) { t.driveId = f.driveId; t.driveUpdated = f.driveUpdated || 0; }
        tracks.push(t);
        await idbPut('tracks', t);
        lastGroup = groupOf(t);
        touched[lastGroup] = 1;
        added++;
      } catch (e) {
        console.error(e);
        toast('「' + f.name + '」で止まりました：' + errMsg(e), 8000);
        break;
      }
    }
    var list = [];
    Object.keys(touched).forEach(function (g) { list = list.concat(renumber(g)); });
    if (list.length) await idbReq('tracks', 'readwrite', function (s) { list.forEach(function (t) { s.put(t); }); return null; });
    sortTracks();
    var gs = Object.keys(touched);
    if (gs.length === 1) { ui.subject = 'g:' + gs[0]; lsSet(K.ui, ui); }
    if (added) { syncState.lastPull = 0; scheduleSend(500); }
    renderAll();
    var msg = [];
    if (added || (!replaced && !skipped)) msg.push(added + ' 件取り込みました' + (gs.length ? '（' + gs.join('・') + '）' : ''));
    if (replaced) msg.push(replaced + ' 件の音声を差し替えました');
    if (skipped) msg.push('同じ名前の ' + skipped + ' 件は取り込みませんでした');
    toast(msg.join('　'), 5000);
    if (!opts.replace) setTimeout(storageWarn, 5200);
  }

  /* ---------- Drive から取り込む ---------- */
  // GAS に聞いて返事（JSON）をもらう。電波などで失敗したら少し待ってやり直す
  async function drivePost(obj, tries) {
    tries = tries || 3;
    for (var n = 1; ; n++) {
      var fatal = false;
      try {
        var res = await fetch(settings.gasUrl, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(obj), redirect: 'follow' });
        var txt = await res.text(), j = null;
        try { j = JSON.parse(txt); } catch (e) { /* JSON でない */ }
        if (j && j.ok) return j;
        if (j && j.error) fatal = true;   // GAS が「だめ」と答えた（やり直しても同じ）
        throw new Error((j && j.error) || ('返事が読めません（' + res.status + '）'));
      } catch (e) {
        if (fatal || n >= tries) throw e;
        await new Promise(function (r) { setTimeout(r, 1500 * n); });
      }
    }
  }
  // 1 本を少しずつ受け取ってつなげる
  async function driveDownload(f, onProgress) {
    var out = new Uint8Array(f.size), off = 0;
    while (off < f.size) {
      var j = await drivePost({ action: 'driveChunk', id: f.id, offset: off });
      var bin = atob(j.data), len = bin.length;
      if (!len) throw new Error('Drive から中身が来ませんでした');
      for (var i = 0; i < len; i++) out[off + i] = bin.charCodeAt(i);
      bin = null;
      off += len;
      if (onProgress) onProgress(off / f.size);
    }
    return out.buffer;
  }
  // Drive のファイルと手元の講義をくらべる：new まだ／have 取り込み済み／newer Drive の方が新しい／diff 中身が違うかも
  function driveState(f) {
    var t = findSame(infoOf(f.name, settings.subject), f.name);
    if (!t) return { st: 'new' };
    if (t.offline) return { st: 'gone', t: t };
    if (t.driveId === f.id) return { st: (f.updated > (t.driveUpdated || 0) + 1000) ? 'newer' : 'have', t: t };
    if (t.size === f.size) return { st: 'have', t: t };
    return { st: 'diff', t: t };
  }
  var DRIVE_LABEL = {
    'new': 'まだ取り込んでいません', have: '取り込み済み',
    newer: 'Drive の方が新しくなっています（録り直し？）', gone: 'スマホから外してあります（チェックすると取り直す。記録はそのまま）', diff: '取り込み済みのものと大きさが違います（差し替えるならチェック）'
  };
  var driveFiles = [], driveBusy = false;
  function fmtMB(b) { return (b / 1048576).toFixed(1) + 'MB'; }
  function renderDrive() {
    var box = $('driveList');
    box.innerHTML = '';
    if (!driveFiles.length) { box.innerHTML = '<div class="hint" style="padding:10px 2px">音声がありません。</div>'; return; }
    driveFiles.forEach(function (f) {
      var row = document.createElement('label');
      row.className = 'drv-row ' + f.state.st;
      var cb = document.createElement('input');
      cb.type = 'checkbox'; cb.checked = !!f.checked; cb.disabled = driveBusy;
      cb.addEventListener('change', function () { f.checked = this.checked; });
      var txt = document.createElement('div');
      var nm = document.createElement('div'); nm.className = 'drv-name'; nm.textContent = f.name;
      var sub = document.createElement('div'); sub.className = 'drv-sub ' + f.state.st;
      sub.textContent = fmtMB(f.size) + '・' + (f.prog != null ? f.prog : DRIVE_LABEL[f.state.st]);
      txt.appendChild(nm); txt.appendChild(sub);
      row.appendChild(cb); row.appendChild(txt);
      box.appendChild(row);
    });
  }
  async function loadDriveList() {
    $('driveInfo').textContent = 'Drive の一覧を読んでいます…';
    driveFiles = []; renderDrive();
    $('driveList').innerHTML = '';
    try {
      var j = await drivePost({ action: 'driveList' }, 2);
      driveFiles = (j.files || []).map(function (f) {
        var st = driveState(f);
        return { id: f.id, name: f.name, size: f.size, updated: f.updated, type: f.type, state: st, checked: st.st === 'new' || st.st === 'newer' };
      });
      driveFiles.sort(function (a, b) { return natcmp(a.name, b.name); });
      var nNew = driveFiles.filter(function (f) { return f.checked; }).length;
      $('driveInfo').textContent = 'Google ドライブの「' + (j.folder || '講義録音') + '」フォルダ：' + driveFiles.length + ' 本（まだのもの・新しくなったもの ' + nNew + ' 本）';
    } catch (e) {
      console.error(e);
      $('driveInfo').textContent = 'Drive の一覧が読めませんでした：' + (e.message || e) + '（GAS の URL と電波を確かめてください）';
    }
    renderDrive();
  }
  function openDrive() {
    if (!settings.gasUrl) { toast('先に ⚙ 設定で GAS の URL を入れてください', 5000); return; }
    $('driveModal').classList.remove('hidden');
    if (!driveBusy) { $('driveProg').textContent = ''; loadDriveList(); }
  }
  async function runDriveImport() {
    if (driveBusy) return;
    var pick = driveFiles.filter(function (f) { return f.checked; });
    if (!pick.length) { toast('取り込むものにチェックを付けてください'); return; }
    if (navigator.onLine === false) { toast('いまは圏外です'); return; }
    driveBusy = true; renderDrive();
    var done = 0, failed = 0;
    for (var i = 0; i < pick.length; i++) {
      var f = pick[i];
      var head = (i + 1) + ' / ' + pick.length + ' 本目　';
      try {
        f.prog = '受け取り中 0%'; renderDrive();
        $('driveProg').textContent = head + f.name;
        var buf = await driveDownload(f, function (r) {
          f.prog = '受け取り中 ' + Math.floor(r * 100) + '%'; renderDrive();
          $('driveProg').textContent = head + Math.floor(r * 100) + '%　' + f.name;
        });
        f.prog = 'しまっています…'; renderDrive();
        if (f.state.t && f.state.t.offline) { await restoreAudio(f.state.t, f, buf); }
        else await importFiles([{ name: f.name, type: f.type || 'audio/mpeg', size: f.size, _buf: buf, driveId: f.id, driveUpdated: f.updated }], settings.subject, { replace: true });
        buf = null;
        f.state = driveState(f); f.checked = false; f.prog = null;
        done++;
      } catch (e) {
        console.error(e);
        f.prog = '止まりました：' + errMsg(e);
        failed++;
      }
      renderDrive();
    }
    driveBusy = false; renderDrive();
    renderAll(); storageWarn();
    $('driveProg').textContent = done + ' 本取り込みました' + (failed ? '（' + failed + ' 本は止まりました。チェックを付け直して［選んだものを取り込む］でやり直せます）' : '');
    toast($('driveProg').textContent, 5000);
  }

  // 録り直しのファイル名の「_2」「_3」と拡張子をのけて比べる
  function sameKey(name) {
    return String(name).replace(/\.[^.]+$/, '').replace(/_\d+$/, '').trim();
  }

  // 音声だけ入れ替える。名前（同期で照らし合わせる鍵）と記録はそのまま、長さは読み直し、続きの位置は最初に戻す
  async function replaceAudio(t, file) {
    if (cur && cur.id === t.id) stopPlayback();
    var buf = await readFile(file);
    await idbPut('audio', audioRec(t.id, file.type, buf));
    buf = null;
    t.size = file.size;
    t.duration = 0;
    t.lastPos = 0;
    t.lapLec = 0;
    t.replacedAt = Date.now();
    t.offline = false;
    if (file.driveId) { t.driveId = file.driveId; t.driveUpdated = file.driveUpdated || 0; }
    markDirty(t);
    await saveDirty();
    var last = lsGet(K.last, null);
    if (last && last.id === t.id) { last.pos = 0; lsSet(K.last, last); }
    pushLog(t, 'replace', 0, 0);
  }

  /* ---------- 分類を変える（科目・コース・題名） ---------- */
  // 変えたものに印（cat＝変えた時刻）を付けて同期で配る。番号は前と後のコースで付け直す
  function setClass(t, subject, course, title, at) {
    if (!t.src) t.src = { subject: t.subject, course: t.course || '' };
    t.subject = subject; t.course = course;
    if (title !== null && title !== undefined) t.title = title;
    t.cat = at;
  }
  async function applyClassChange(list, subject, course, title) {
    var gs = {}, at = Date.now(), wasFilter = ui.subject;
    var oldG = list.length ? groupOf(list[0]) : '';
    list.forEach(function (t) {
      gs[groupOf(t)] = 1;
      setClass(t, subject, course, list.length === 1 ? title : null, at);
      gs[groupOf(t)] = 1;
      markSyncT(t);
    });
    var all = [];
    Object.keys(gs).forEach(function (g) { all = all.concat(renumber(g)); });
    list.forEach(function (t) { if (all.indexOf(t) < 0) all.push(t); });
    await idbReq('tracks', 'readwrite', function (s) { all.forEach(function (t) { s.put(t); }); return null; });
    sortTracks();
    // 絞り込みで見ていたコースを丸ごと変えたら、新しい名前のほうを見る
    if (wasFilter === 'g:' + oldG && !tracks.some(function (t) { return groupOf(t) === oldG; })) {
      ui.subject = 'g:' + groupOf(list[0]); lsSet(K.ui, ui);
    }
    if (cur && list.indexOf(cur) >= 0) updateMediaMeta();
    scheduleSend(1500);
    renderAll();
  }
  var editTarget = null;   // { one: 単元, group: '科目＜コース＞' }
  function openEdit(t, group) {
    editTarget = { one: t, group: group || (t ? groupOf(t) : '') };
    var base = t || tracks.filter(function (x) { return groupOf(x) === editTarget.group; })[0];
    if (!base) return;
    var n = tracks.filter(function (x) { return groupOf(x) === editTarget.group; }).length;
    $('editInfo').textContent = t ? '「' + titleOf(t) + '」（' + t.name + '）' : '「' + editTarget.group + '」の ' + n + ' 本';
    $('editScopeRow').classList.toggle('hidden', !t || n < 2);
    $('editGroupLbl').textContent = '「' + editTarget.group + '」の ' + n + ' 本全部';
    var radios = document.getElementsByName('editScope');
    radios[0].checked = !!t; radios[1].checked = !t;
    $('eSubject').value = base.subject;
    $('eCourse').value = base.course || '';
    $('eTitle').value = t ? titleOf(t) : '';
    fillEditLists();
    syncEditScope();
    $('editModal').classList.remove('hidden');
  }
  function fillEditLists() {
    var dl = '';
    subjects().forEach(function (s) { dl += '<option value="' + esc(s) + '">'; });
    $('editSubjectList').innerHTML = dl;
    var cl = '';
    coursesOf($('eSubject').value.trim()).forEach(function (c) { if (c) cl += '<option value="' + esc(c) + '">'; });
    $('editCourseList').innerHTML = cl;
  }
  function editScope() {
    var r = document.getElementsByName('editScope');
    return editTarget && editTarget.one && r[0].checked ? 'one' : 'group';
  }
  function syncEditScope() { $('eTitleRow').classList.toggle('hidden', editScope() !== 'one'); }
  async function saveEdit() {
    if (!editTarget) return;
    var subject = $('eSubject').value.trim(), course = $('eCourse').value.trim(), title = $('eTitle').value.trim();
    if (!subject) { toast('科目を入れてください'); return; }
    if (/[＜＞]/.test(subject + course)) { toast('＜ ＞ は使えません'); return; }
    var list = editScope() === 'one' ? [editTarget.one]
      : tracks.filter(function (t) { return groupOf(t) === editTarget.group; });
    if (!list.length) return;
    if (editScope() === 'one' && !title) title = list[0].name.replace(/\.[^.]+$/, '');
    $('editModal').classList.add('hidden');
    await applyClassChange(list, subject, course, title);
    toast(list.length === 1 ? '分類を変えました（' + groupOf(list[0]) + '）' : list.length + ' 本の分類を変えました（' + groupOf(list[0]) + '）', 3500);
    editTarget = null;
  }

  async function deleteTracks(list) {
    for (var i = 0; i < list.length; i++) {
      var t = list[i];
      if (cur && cur.id === t.id) stopPlayback();
      await idbDel('audio', t.id);
      await idbDel('tracks', t.id);
      delete byId[t.id];
    }
    var gone = {};
    list.forEach(function (t) { gone[t.id] = 1; });
    tracks = tracks.filter(function (t) { return !gone[t.id]; });
    var subs = {};
    list.forEach(function (t) { subs[groupOf(t)] = 1; });
    var all = [];
    Object.keys(subs).forEach(function (s) { all = all.concat(renumber(s)); });
    if (all.length) await idbReq('tracks', 'readwrite', function (s) { all.forEach(function (t) { s.put(t); }); return null; });
    sortTracks();
    var last = lsGet(K.last, null);
    if (last && !byId[last.id]) localStorage.removeItem(K.last);
    renderAll();
  }

  /* ---------- スマホから音声だけ外す・Drive から取り直す ---------- */
  var LIMIT_WARN = 800 * 1048576;   // 古い iPhone（iOS 15 まで）は 1GB くらいで入らなくなる
  function errMsg(e) {
    if (e && (e.name === 'QuotaExceededError' || /quota/i.test(e.message || ''))) return 'スマホの保存場所がいっぱいです。聞き終わったコースの「音声だけ外す」で空けてください';
    return (e && (e.message || e.name)) || String(e);
  }
  function localBytes() {
    var n = 0, b = 0;
    tracks.forEach(function (t) { if (!t.offline) { n++; b += t.size || 0; } });
    return { n: n, b: b };
  }
  function storageWarn() {
    var u = localBytes();
    if (u.b >= LIMIT_WARN) toast('スマホにしまった音声が ' + Math.round(u.b / 1048576) + 'MB になりました。1GB くらいで入らなくなることがあります。聞き終わったコースは「音声だけ外す」を', 8000);
  }
  var driveCache = null, driveCacheAt = 0;
  async function getDriveList(force) {
    if (!force && driveCache && Date.now() - driveCacheAt < 300000) return driveCache;
    var j = await drivePost({ action: 'driveList' }, 2);
    driveCache = j.files || []; driveCacheAt = Date.now();
    return driveCache;
  }
  // その講義の音声を Drive の中から探す（Drive から取ったものは ID で、ほかは名前で）
  function matchDrive(t, list) {
    var i, f;
    if (t.driveId) for (i = 0; i < list.length; i++) if (list[i].id === t.driveId) return list[i];
    var key = sameKey(t.name);
    for (i = 0; i < list.length; i++) {
      f = list[i];
      var fi = infoOf(f.name, settings.subject), st = srcOf(t);
      if (fi.subject === st.subject && (fi.course || '') === (st.course || '') && sameKey(f.name) === key) return f;
    }
    return null;
  }
  // Drive から受け取った中身をしまう。記録はそのまま。録り直しで大きさが変わっていたら位置は最初から
  async function restoreAudio(t, f, buf) {
    var changed = !!(t.size && f.size !== t.size);
    await idbPut('audio', audioRec(t.id, f.type, buf));
    t.offline = false; t.driveId = f.id; t.driveUpdated = f.updated;
    if (changed) { t.size = f.size; t.duration = 0; t.lastPos = 0; t.lapLec = 0; t.replacedAt = Date.now(); }
    markDirty(t);
    await saveDirty();
    return changed;
  }
  async function fetchOffline(t, onProgress) {
    if (!settings.gasUrl) throw new Error('⚙ 設定に GAS の URL を入れてください');
    if (navigator.onLine === false) throw new Error('いまは圏外です');
    var f = matchDrive(t, await getDriveList());
    if (!f) f = matchDrive(t, await getDriveList(true));
    if (!f) throw new Error('Drive の音声フォルダに「' + t.name + '」が見つかりません');
    var buf = await driveDownload(f, onProgress);
    return restoreAudio(t, f, buf);
  }
  async function removeAudio(list) {
    for (var i = 0; i < list.length; i++) {
      var t = list[i];
      if (t.offline) continue;
      if (cur && cur.id === t.id) stopPlayback();
      await idbDel('audio', t.id);
      t.offline = true;
      markDirty(t);
    }
    await saveDirty();
    renderAll(); renderStorage();
  }
  // 外す前に、Drive から取り直せるかを確かめる（取り直せないものがあれば知らせる）
  async function confirmRemove(list) {
    list = list.filter(function (t) { return !t.offline; });
    if (!list.length) { toast('スマホにある音声はありません'); return null; }
    var miss = [];
    if (settings.gasUrl && navigator.onLine !== false) {
      toast('Drive にあるか確かめています…', 20000);
      try {
        var dl = await getDriveList(true);
        miss = list.filter(function (t) { return !matchDrive(t, dl); });
      } catch (e) { miss = null; }
      toast('', 1);
    } else miss = null;
    var msg = list.length + ' 本の音声をスマホから外します。\n周回数・聴取時間・理解度などの記録は残り、☁ の講義を押せば Drive から取り直して再生します。';
    if (miss === null) msg += '\n\n（いま Drive を確かめられませんでした。Drive の音声フォルダに同じ名前の音声があることを確かめてから外してください）';
    else if (miss.length) msg += '\n\n※ 次の ' + miss.length + ' 本は Drive に見つかりません。外すと Drive からは取り直せません：\n' +
      miss.slice(0, 5).map(function (t) { return '・' + t.name; }).join('\n') + (miss.length > 5 ? '\n…ほか ' + (miss.length - 5) + ' 本' : '');
    return confirm(msg + '\n\nよろしいですか？') ? list : null;
  }

  /* ---------- 再生（audio 要素は 1 つだけを使い回す） ---------- */
  var audio = $('audio');
  var cur = null;          // 再生中の単元
  var curUrl = null;       // 再生中の Blob URL（1 つだけ）
  var pendingSeek = 0;
  var lastMedia = null, lastWall = 0;
  var session = { r: 0, l: 0 };   // 送信キューへまだ入れていない聴取時間
  var lastSaveAt = 0;

  function applyRate() {
    audio.defaultPlaybackRate = rate;
    audio.playbackRate = rate;
    audio.preservesPitch = true;
    audio.webkitPreservesPitch = true;
    audio.mozPreservesPitch = true;
  }
  function releaseUrl() {
    if (curUrl) { URL.revokeObjectURL(curUrl); curUrl = null; }
  }

  var fetchingId = null;
  async function loadTrack(id, startPos, autoplay) {
    var t = byId[id];
    if (!t) return;
    if (t.offline) {
      if (fetchingId) { toast('いま Drive から受け取り中です。終わるまで待ってください', 3000); return; }
      fetchingId = id;
      toast('☁ Drive から受け取ります…　' + titleOf(t), 60000);
      try {
        var changed = await fetchOffline(t, function (r) { toast('☁ Drive から受け取り中 ' + Math.floor(r * 100) + '%　' + titleOf(t), 60000); });
        if (changed) startPos = 0;
      } catch (e) {
        console.error(e);
        toast('Drive から受け取れませんでした：' + errMsg(e), 7000);
        return;
      } finally { fetchingId = null; }
      toast('受け取りました' + (autoplay ? '（始まらないときは ▶ を押してください）' : ''), 3000);
      renderList(); renderTiles();
      storageWarn();
    }
    accumulate();
    flushSession('switch');
    var rec = await idbGet('audio', id);
    if (!rec) { toast('音声の中身が見つかりません。取り込み直してください', 5000); return; }
    var type = rec.type || 'audio/mpeg';
    var stored = !!rec.blob;            // Blob のまま入っていれば、コピーせずにそのまま使う
    var blob = stored ? rec.blob : new Blob([rec.data], { type: type });
    rec = null;
    releaseUrl();                       // 前の曲の Blob URL を必ず解放
    curUrl = URL.createObjectURL(blob);
    curFromStore = stored; curRetried = false;
    // 古い形（ArrayBuffer）で入っていたものは、一度だけ Blob の形にしまい直す（次から軽く開ける）
    if (!stored && blobOK) {
      var keep = blob, kid = id;
      setTimeout(function () { idbPut('audio', { id: kid, type: type, blob: keep }).catch(function (e) { console.warn(e); }); keep = null; }, 4000);
    }
    blob = null;
    cur = t;
    pendingSeek = Math.max(0, startPos || 0);
    lastMedia = null;
    audio.src = curUrl;                 // 同じ audio 要素の src だけ差し替える
    applyRate();
    if (autoplay) playAudio();
    updateMediaMeta();
    saveLast();
    renderNow(); renderListMarks(); renderTiles(); renderPlayer();
  }

  function playAudio() {
    applyRate();
    var p = audio.play();
    if (p && p.catch) {
      p.catch(function (e) {
        console.warn(e);
        if (e && e.name === 'NotAllowedError') toast('▶ ボタンを押すと再生します');
      });
    }
  }
  function resume() {
    if (!cur || !curUrl) { resumeFromLast(); return; }
    if (!audio.paused) return;
    if (audio.currentTime > 0 && !audio.ended) seekTo(audio.currentTime - SMART_REWIND);
    playAudio();
  }
  function pause() { if (!audio.paused) audio.pause(); }
  function togglePlay() { if (cur && curUrl && !audio.paused) pause(); else resume(); }
  function stopPlayback() {
    accumulate();
    audio.pause();
    flushSession('stop');
    saveLast();
    saveDirty();
    audio.removeAttribute('src');
    try { audio.load(); } catch (e) { /* 無視 */ }
    releaseUrl();
    cur = null;
    setPlaybackState('none');
    renderAll();
  }
  function resumeFromLast() {
    var last = lsGet(K.last, null);
    if (last && byId[last.id]) {
      loadTrack(last.id, Math.max(0, (last.pos || 0) - SMART_REWIND), true);
      return;
    }
    var list = visibleTracks();
    if (!list.length) list = tracks;
    if (list.length) loadTrack(list[0].id, list[0].lastPos || 0, true);
    else toast('まず「一覧」から MP3 を取り込んでください', 3000);
  }
  function seekTo(sec) {
    if (!cur) return;
    accumulate();
    lastMedia = null;   // 飛ばした分は聴取時間に入れない
    var d = audio.duration || cur.duration || 0;
    sec = Math.max(0, d ? Math.min(sec, d - 0.5) : sec);
    try { audio.currentTime = sec; } catch (e) { pendingSeek = sec; }
    renderPlayer();
  }
  function seekBy(delta) { if (cur) seekTo(audio.currentTime + delta); }

  function orderedForNext() {
    // 同じ科目・同じコースの番号順
    if (!cur) return [];
    var g = groupOf(cur);
    return tracks.filter(function (t) { return groupOf(t) === g; });
  }
  // 続きの位置：最後の 5 秒より後まで聞いていたら頭から
  function continuePos(t) {
    var p = t.lastPos || 0;
    if (t.duration && p >= t.duration - 5) return 0;
    return p > SMART_REWIND ? p - SMART_REWIND : 0;
  }
  function nextTrack(auto) {
    var list = orderedForNext();
    if (!list.length) return;
    var i = list.indexOf(cur);
    if (i >= 0 && i + 1 < list.length) {
      var n = list[i + 1];
      // 続けて再生でも、途中まで聞いていた音声は止めた所（の少し前）から始める
      loadTrack(n.id, continuePos(n), true);
    } else if (auto) {
      toast('「' + groupOf(cur) + '」の最後まで聞きました 🎉', 4000);
      setPlaybackState('paused');
    } else toast('このコースの最後の音声です');
  }
  function prevTrack() {
    if (cur && audio.currentTime > 5) { seekTo(0); return; }
    var list = orderedForNext();
    var i = list.indexOf(cur);
    if (i > 0) loadTrack(list[i - 1].id, 0, true);
    else seekTo(0);
  }

  /* ---------- 聴取時間の積み上げ（実際に進んだ再生位置で数える） ---------- */
  function today() { return dateKey(new Date()); }
  function accumulate() {
    if (!cur || !curUrl) return;
    if (pendingSeek > 0) return;   // 続きの位置へ移る前（0 秒の状態）を記録しない
    var ct = audio.currentTime || 0, now = Date.now();
    if (lastMedia !== null && !audio.seeking) {
      var d = ct - lastMedia;
      var r = audio.playbackRate || 1;
      var wall = (now - lastWall) / 1000;
      // 前へ進んだ分だけ。経過した実時間×速度より大きい進みはシーク扱いで数えない
      if (d > 0 && d <= wall * r + 2) addListen(d / r, d);
    }
    if (audio.paused || audio.ended) lastMedia = null;
    else { lastMedia = ct; lastWall = now; }
    var np = audio.ended ? 0 : ct;
    if (np !== (cur.lastPos || 0)) { cur.posAt = now; markSyncT(cur); }
    cur.lastPos = np;
    checkLap(ct);
  }
  function addListen(real, lecture) {
    var k = today();
    var day = daily[k] || (daily[k] = { r: 0, l: 0 });
    day.r += real; day.l += lecture;
    cur.listenedSec = (cur.listenedSec || 0) + real;
    cur.lectureSec = (cur.lectureSec || 0) + lecture;
    cur.lapLec = (cur.lapLec || 0) + lecture;
    session.r += real; session.l += lecture;
    markDirty(cur);
    markSyncT(cur); markSyncD(k);
    if (Date.now() - lastSaveAt > 10000) { lastSaveAt = Date.now(); saveDirty(); saveLast(); }
    if (session.r >= LOG_EVERY_SEC) flushSession('listening');
  }
  function checkLap(ct) {
    var d = audio.duration || cur.duration;
    if (!d || !isFinite(d)) return;
    if (ct / d >= LAP_POS && (cur.lapLec || 0) >= d * LAP_LISTEN) {
      cur.playCount = (cur.playCount || 0) + 1;
      cur.lastPlayedAt = Date.now();
      cur.lapLec = 0;
      markDirty(cur);
      markSyncT(cur);
      saveDirty();
      flushSession('complete');
      toast('「' + cur.name + '」' + cur.playCount + ' 周目を記録しました', 3000);
      renderNow(); renderListMarks(); renderTiles(); renderHero();
    }
  }
  function saveLast() {
    if (!cur) return;
    lsSet(K.last, { id: cur.id, pos: audio.ended ? 0 : (audio.currentTime || cur.lastPos || 0), at: Date.now() });
  }

  /* ---------- 送信キュー（GAS） ---------- */
  function pushLog(t, event, real, lecture) {
    queue.push({
      id: uid(),
      timestamp: new Date().toISOString(),
      subject: t.subject,
      course: t.course || '',
      title: titleOf(t),
      no: t.no,
      fileName: t.name,
      listenedSeconds: Math.round(real || 0),
      lectureSeconds: Math.round(lecture || 0),
      playCount: t.playCount || 0,
      status: statusLabel(t.status),
      totalListenedSeconds: Math.round(t.listenedSec || 0),
      totalLectureSeconds: Math.round(t.lectureSec || 0),
      lastPlayedAt: t.lastPlayedAt ? new Date(t.lastPlayedAt).toISOString() : '',
      event: event
    });
    if (queue.length > 5000) queue = queue.slice(-5000);
    lsSet(K.queue, queue);
    renderSync();
    scheduleSend();
  }
  function flushSession(event) {
    if (!cur) { session = { r: 0, l: 0 }; return; }
    if (session.r >= 3 || event === 'complete') pushLog(cur, event, session.r, session.l);
    session = { r: 0, l: 0 };
    saveDirty();
  }
  /* ---------- 端末どうしの同期 ----------
   * 各端末は「この端末で聞いた分（own）」だけを送り、全端末の分を読み戻して足す。
   * 周回・聴取時間：合計（t.base＝ほかの端末の合計、表示する数＝own＋base）
   * 理解度・停止位置：いちばん新しく変えた端末のもの
   */
  var deviceId = lsGet(K.device, '');
  if (!deviceId) { deviceId = 'd' + uid(); lsSet(K.device, deviceId); }
  var dailyBase = lsGet(K.dbase, {});              // ほかの端末の日別の合計
  var sdirty = lsGet(K.sdirty, { t: {}, d: {} });  // まだ送っていない変更（値は変更の番号）
  var sdSeq = Date.now();
  function markSyncT(t) { sdirty.t[t.name] = ++sdSeq; persistSoon(); }
  function markSyncD(k) { sdirty.d[k] = ++sdSeq; persistSoon(); }
  // 日別の記録と「未同期の印」は、すぐには書かずに 5 秒ごとにまとめて保存する
  // （再生中は 1 秒に何回も変わるので、そのたびに書くと古いスマホでは重くなる）
  var persistTimer = null;
  function persistSoon() {
    if (persistTimer) return;
    persistTimer = setTimeout(persistNow, 5000);
  }
  function persistNow() {
    if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
    lsSet(K.daily, daily);
    lsSet(K.sdirty, sdirty);
  }
  function hasSyncDirty() { return Object.keys(sdirty.t).length > 0 || Object.keys(sdirty.d).length > 0; }
  function ownOf(t) {
    var b = t.base || { pc: 0, ls: 0, lc: 0 };
    return { pc: (t.playCount || 0) - b.pc, ls: Math.max(0, (t.listenedSec || 0) - b.ls), lc: Math.max(0, (t.lectureSec || 0) - b.lc) };
  }
  function ownDay(k) {
    var x = daily[k] || { r: 0, l: 0 }, b = dailyBase[k] || { r: 0, l: 0 };
    return { r: Math.max(0, x.r - b.r), l: Math.max(0, x.l - b.l) };
  }
  function syncPayload() {
    var p = { tracks: [], daily: [], snapT: {}, snapD: {} }, byName = {};
    tracks.forEach(function (t) { byName[t.name] = t; });
    Object.keys(sdirty.t).forEach(function (n) {
      p.snapT[n] = sdirty.t[n];
      var t = byName[n];
      if (!t) return;
      var o = ownOf(t);
      p.tracks.push({ f: t.name, s: t.subject, c: t.course || '', no: t.no, t: titleOf(t), pc: o.pc, ls: Math.round(o.ls), lc: Math.round(o.lc),
        lp: t.lastPlayedAt || 0, st: t.status || 'none', sa: t.statusAt || 0, pos: Math.round(t.lastPos || 0), pa: t.posAt || 0, ca: t.cat || 0 });
    });
    Object.keys(sdirty.d).forEach(function (k) {
      p.snapD[k] = sdirty.d[k];
      var o = ownDay(k);
      p.daily.push({ k: k, r: Math.round(o.r), l: Math.round(o.l) });
    });
    return p;
  }
  function clearSnap(p) {
    // 送っている間にまた変わったものは残す
    Object.keys(p.snapT).forEach(function (n) { if (sdirty.t[n] === p.snapT[n]) delete sdirty.t[n]; });
    Object.keys(p.snapD).forEach(function (k) { if (sdirty.d[k] === p.snapD[k]) delete sdirty.d[k]; });
    lsSet(K.sdirty, sdirty);
  }
  function applyPull(j) {
    if (!j || !j.tracks) return;
    var devs = {}, rowsBy = {}, latest = null, reGroup = {};
    var playingId = cur && curUrl && !audio.paused ? cur.id : null;
    j.tracks.forEach(function (r) { devs[r.d] = r.dn || ''; (rowsBy[r.f] = rowsBy[r.f] || []).push(r); });
    (j.daily || []).forEach(function (r) { if (!(r.d in devs)) devs[r.d] = ''; });
    tracks.forEach(function (t) {
      var rows = rowsBy[t.name];
      if (!rows) return;
      var own = ownOf(t), base = { pc: 0, ls: 0, lc: 0 }, mine = null;
      rows.forEach(function (r) {
        if (r.d === deviceId) { mine = r; return; }
        base.pc += r.pc; base.ls += r.ls; base.lc += r.lc;
        if (r.pa > (t.posAt || 0) && t.id !== playingId) { t.lastPos = r.pos; t.posAt = r.pa; }
        if (r.pa && (!latest || r.pa > latest.at)) latest = { id: t.id, pos: r.pos, at: r.pa };
      });
      if (mine) {
        // 消して取り込み直した音声などは、前に送ってあったこの端末の分を戻す
        own.ls = Math.max(own.ls, mine.ls); own.lc = Math.max(own.lc, mine.lc);
        if (!t.syncSeen) own.pc = Math.max(own.pc, mine.pc);
      }
      t.syncSeen = true;
      t.base = base;
      t.playCount = own.pc + base.pc;
      t.listenedSec = own.ls + base.ls;
      t.lectureSec = own.lc + base.lc;
      rows.forEach(function (r) {
        if (r.lp > (t.lastPlayedAt || 0)) t.lastPlayedAt = r.lp;
        if (r.sa > (t.statusAt || 0)) { t.status = r.st; t.statusAt = r.sa; }
        // ほかの端末で分類を変えていたら、新しいほうにそろえる
        if (r.d !== deviceId && r.ca > (t.cat || 0) && r.s) {
          reGroup[groupOf(t)] = 1;
          setClass(t, String(r.s), String(r.c || ''), r.t ? String(r.t) : null, r.ca);
          reGroup[groupOf(t)] = 1;
        }
      });
      markDirty(t);
    });
    if (Object.keys(reGroup).length) {
      Object.keys(reGroup).forEach(function (g) { renumber(g).forEach(markDirty); });
      sortTracks();
    }
    // 日別
    var nb = {}, mineD = {}, keys = {};
    (j.daily || []).forEach(function (r) {
      if (r.d === deviceId) { mineD[r.k] = r; return; }
      var b = nb[r.k] || (nb[r.k] = { r: 0, l: 0 });
      b.r += r.r; b.l += r.l;
    });
    [daily, nb, mineD].forEach(function (o) { Object.keys(o).forEach(function (k) { keys[k] = 1; }); });
    var next = {};
    Object.keys(keys).forEach(function (k) {
      var o = ownDay(k), m = mineD[k], b = nb[k] || { r: 0, l: 0 };
      if (m) { o.r = Math.max(o.r, m.r); o.l = Math.max(o.l, m.l); }
      if (o.r + b.r > 0 || o.l + b.l > 0) next[k] = { r: o.r + b.r, l: o.l + b.l };
    });
    daily = next; dailyBase = nb;
    lsSet(K.daily, daily); lsSet(K.dbase, dailyBase);
    // ほかの端末で後から聞いていたら「前回の続きから」をそちらにする
    var last = lsGet(K.last, null);
    if (latest && latest.at > ((last && last.at) || 0) && !playingId) {
      if (cur) stopPlayback();
      lsSet(K.last, latest);
    }
    syncState.devices = Object.keys(devs).length;
    syncState.lastPull = Date.now();
    saveDirty();
    renderAll();
  }

  var sendTimer = null, sending = false;
  function scheduleSend(ms) {
    if (sendTimer) clearTimeout(sendTimer);
    sendTimer = setTimeout(function () { sendQueue(); }, ms || 3000);
  }
  // 送って返事を読む。返事が読めない環境（TypeError）は no-cors で送って null を返す
  async function postBody(body) {
    try {
      // text/plain にすると事前確認（プリフライト）が起きず GAS にそのまま届く
      var res = await fetch(settings.gasUrl, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: body, redirect: 'follow' });
      var txt = await res.text(), j = null;
      try { j = JSON.parse(txt); } catch (e) { /* JSON でない */ }
      if (j && j.ok) return j;
      throw new Error((j && j.error) || ('返事が読めません（' + res.status + '）'));
    } catch (e) {
      // GAS から返事が来たのにエラー（合言葉違いなど）のときは、そのまま止める
      if (!(e instanceof TypeError)) throw e;
      await fetch(settings.gasUrl, { method: 'POST', mode: 'no-cors', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: body });
      return null;
    }
  }
  function removeSent(batch) {
    var sent = {};
    batch.forEach(function (l) { sent[l.id] = 1; });
    queue = queue.filter(function (l) { return !sent[l.id]; });
    lsSet(K.queue, queue);
  }
  async function sendQueue(manual) {
    if (!settings.gasUrl) { if (manual) toast('GAS の URL が入っていません'); return; }
    if (sending) return;
    if (navigator.onLine === false) { if (manual) toast('いまは圏外です。つながったら自動で同期します'); return; }
    var pullDue = Date.now() - (syncState.lastPull || 0) > 30000;
    if (!manual && !queue.length && !hasSyncDirty() && !pullDue) return;
    sending = true;
    renderSync();
    try {
      var head = { secret: settings.secret || '', app: APP_VERSION, device: deviceId, deviceName: settings.deviceName || '' };
      // ログがたまっているときは先に 100 件ずつ
      while (queue.length > 100) {
        var b = queue.slice(0, 100);
        await postBody(JSON.stringify(Object.assign({}, head, { logs: b })));
        removeSent(b);
      }
      var batch = queue.slice(0, 100);
      var p = syncPayload();
      var j = await postBody(JSON.stringify(Object.assign({}, head, { logs: batch, tracks: p.tracks, daily: p.daily, pull: true })));
      removeSent(batch);   // ログは GAS 側で同じものを 2 回入れないので、届いたかあいまいでも消してよい
      if (!j) throw new Error('返事が読めないため、ほかの端末の記録を読み戻せませんでした');
      clearSnap(p);
      applyPull(j);
      syncState.lastOk = Date.now(); syncState.lastErr = '';
      if (manual) toast('同期しました');
    } catch (e) {
      console.warn(e);
      syncState.lastErr = (e && e.message) || String(e);
      if (manual) toast('同期できませんでした：' + syncState.lastErr, 5000);
    } finally {
      sending = false;
      lsSet(K.sync, syncState);
      renderSync();
    }
  }

  /* ---------- Media Session（ロック画面・骨伝導ヘッドセットのボタン） ---------- */
  function setupMediaSession() {
    if (!('mediaSession' in navigator)) return;
    var ms = navigator.mediaSession;
    function h(name, fn) { try { ms.setActionHandler(name, fn); } catch (e) { /* 対応していない操作 */ } }
    h('play', function () { resume(); });
    h('pause', function () { pause(); });
    h('stop', function () { pause(); });
    h('seekbackward', function (d) { seekBy(-((d && d.seekOffset) || 10)); });
    h('seekforward', function (d) { seekBy((d && d.seekOffset) || 15); });
    h('previoustrack', function () { if (settings.trackBtn === 'seek') seekBy(-10); else prevTrack(); });
    h('nexttrack', function () { if (settings.trackBtn === 'seek') seekBy(15); else nextTrack(false); });
    h('seekto', function (d) { if (d && d.seekTime != null) seekTo(d.seekTime); });
  }
  function updateMediaMeta() {
    if (!('mediaSession' in navigator) || !cur) return;
    try {
      if (window.MediaMetadata) {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: titleOf(cur),
          artist: groupOf(cur),
          album: '学習音声プレーヤー',
          artwork: [
            { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
            { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' }
          ]
        });
      }
    } catch (e) { /* 無視 */ }
  }
  function setPlaybackState(s) {
    if ('mediaSession' in navigator) { try { navigator.mediaSession.playbackState = s; } catch (e) { /* 無視 */ } }
  }
  function updatePositionState() {
    if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
    var d = audio.duration;
    if (!d || !isFinite(d)) return;
    try {
      navigator.mediaSession.setPositionState({ duration: d, playbackRate: audio.playbackRate || 1, position: Math.min(audio.currentTime || 0, d) });
    } catch (e) { /* 無視 */ }
  }

  /* ---------- audio のイベント ---------- */
  audio.addEventListener('loadedmetadata', function () {
    if (!cur) return;
    if (audio.duration && isFinite(audio.duration) && Math.abs((cur.duration || 0) - audio.duration) > 1) {
      cur.duration = audio.duration; markDirty(cur); saveDirty();
    }
    if (pendingSeek > 0) {
      var s = pendingSeek; pendingSeek = 0;
      if (audio.duration && s > audio.duration - 2) s = 0;
      try { audio.currentTime = s; } catch (e) { /* 無視 */ }
    }
    applyRate();
    updatePositionState();
    renderPlayer();
  });
  audio.addEventListener('play', function () { applyRate(); });
  audio.addEventListener('playing', function () {
    lastMedia = audio.currentTime; lastWall = Date.now();
    setPlaybackState('playing');
    updatePositionState();
    renderPlayer(); renderHero();
  });
  audio.addEventListener('timeupdate', function () {
    accumulate();
    renderPlayerTime();
    tickHero();
  });
  audio.addEventListener('seeking', function () { lastMedia = null; });
  audio.addEventListener('seeked', function () {
    if (!audio.paused) { lastMedia = audio.currentTime; lastWall = Date.now(); }
    updatePositionState();
  });
  audio.addEventListener('pause', function () {
    accumulate();
    lastMedia = null;
    if (!audio.ended) flushSession('pause');
    persistNow(); saveLast(); saveDirty();
    setPlaybackState('paused');
    renderPlayer(); renderHero(); renderListMarks();
    if (wantReload) setTimeout(reloadForUpdate, 300);
  });
  audio.addEventListener('ratechange', function () {
    if (Math.abs(audio.playbackRate - rate) > 0.01 && cur) audio.playbackRate = rate;
    updatePositionState();
  });
  audio.addEventListener('ended', function () {
    accumulate();
    lastMedia = null;
    if (cur) { cur.lastPos = 0; cur.posAt = Date.now(); markDirty(cur); markSyncT(cur); }
    flushSession('ended');
    persistNow(); saveLast(); saveDirty();
    if (settings.autoNext) nextTrack(true);
    else { setPlaybackState('paused'); renderPlayer(); }
  });
  audio.addEventListener('error', function () {
    if (!cur || !curUrl) return;
    if (curFromStore && !curRetried) { curRetried = true; retryAsBuffer(cur); return; }
    toast('この音声は再生できませんでした（形式が合わないかもしれません）', 5000);
  });
  // Blob のまま開けなかったスマホ向け：中身を読み出して作り直し、次からは ArrayBuffer の形で使う
  async function retryAsBuffer(t) {
    try {
      var rec = await idbGet('audio', t.id);
      var buf = await readFile(rec.blob);
      var type = rec.type || 'audio/mpeg';
      blobOK = false; lsSet('sap.blobok', { ua: navigator.userAgent, ok: false });
      await idbPut('audio', { id: t.id, type: type, data: buf });
      var pos = t.lastPos || 0, wasPlaying = true;
      releaseUrl();
      curUrl = URL.createObjectURL(new Blob([buf], { type: type }));
      curFromStore = false;
      buf = null;
      pendingSeek = pos;
      audio.src = curUrl;
      applyRate();
      if (wasPlaying) playAudio();
    } catch (e) {
      console.error(e);
      toast('音声の中身が読めませんでした。Drive から取り込み直してください', 6000);
    }
  }

  /* ---------- 画面 ---------- */
  function statusLabel(k) {
    for (var i = 0; i < STATUS_LIST.length; i++) if (STATUS_LIST[i].key === k) return STATUS_LIST[i].label;
    return '未評価';
  }
  function statusMark(k) {
    for (var i = 0; i < STATUS_LIST.length; i++) if (STATUS_LIST[i].key === k) return STATUS_LIST[i].mark;
    return '';
  }
  function lapClass(n) { return n >= 3 ? 'tc3' : 'tc' + (n || 0); }
  var toastTimer = null;
  function toast(msg, ms) {
    var el = $('toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.add('hidden'); }, ms || 2200);
  }

  function calcStreak() {
    var goal = settings.goalMin * 60, d = new Date(), n = 0;
    var t = daily[dateKey(d)];
    if (!(t && t.r >= goal)) d.setDate(d.getDate() - 1);   // 今日まだなら昨日から数える
    for (var i = 0; i < 3660; i++) {
      var x = daily[dateKey(d)];
      if (x && x.r >= goal) { n++; d.setDate(d.getDate() - 1); } else break;
    }
    return n;
  }

  function renderHero() {
    var last = lsGet(K.last, null);
    var t = cur || (last && byId[last.id]) || null;
    var pos = cur ? (audio.currentTime || cur.lastPos) : (last ? last.pos : 0);
    if (t) {
      var playing = cur && curUrl && !audio.paused;
      $('heroLabel').textContent = playing ? '♪ 再生中（タップで一時停止）' : '▶ 前回の続きから即再開';
      $('heroTitle').textContent = titleOf(t);
      $('heroSub').textContent = groupOf(t) + '　停止位置 ' + fmtTime(pos) + (t.duration ? ' / ' + fmtTime(t.duration) : '') +
        '　' + ((t.playCount || 0) + 1) + ' 周目';
    } else if (tracks.length) {
      $('heroLabel').textContent = '▶ はじめから再生';
      $('heroTitle').textContent = titleOf(tracks[0]);
      $('heroSub').textContent = groupOf(tracks[0]);
    } else {
      $('heroLabel').textContent = '▶ 前回の続きから即再開';
      $('heroTitle').textContent = 'まだ音声がありません';
      $('heroSub').textContent = '下の「一覧」から MP3 を取り込んでください';
    }
    tickHero(true);
  }
  var lastHeroSec = -1;
  function tickHero(force) {
    var d = daily[today()] || { r: 0, l: 0 };
    var sec = Math.floor(d.r);
    if (!force && sec === lastHeroSec) return;
    lastHeroSec = sec;
    $('heroToday').textContent = fmtMin(d.r);
    $('heroLecture').textContent = fmtMin(d.l);
    var streak = calcStreak();
    $('heroStreak').textContent = '🔥' + streak + '日';
    var goal = settings.goalMin * 60;
    var pct = Math.min(100, Math.round(d.r / goal * 100));
    $('goalBar').style.width = pct + '%';
    $('goalCap').textContent = '今日の目標 ' + settings.goalMin + '分　' +
      (d.r >= goal ? '✅ 達成！' : 'あと ' + Math.ceil((goal - d.r) / 60) + '分（' + pct + '%）');
  }

  function renderNow() {
    var card = $('nowCard');
    if (!cur) { card.classList.add('hidden'); return; }
    card.classList.remove('hidden');
    $('nowSubject').textContent = groupOf(cur) + '　No.' + cur.no;
    $('nowTitle').textContent = titleOf(cur);
    $('nowLap').textContent = cur.playCount || 0;
    $('nowTotal').innerHTML = '累計 ' + fmtMin(cur.listenedSec) + '<br>講義 ' + fmtMin(cur.lectureSec);
    var html = '';
    STATUS_LIST.forEach(function (s) {
      html += '<button type="button" class="st-btn st-' + s.key + (cur.status === s.key ? ' on' : '') + '" data-st="' + s.key + '">' + esc(s.label) + '</button>';
    });
    $('statusRow').innerHTML = html;
    var d = cur.duration;
    $('nowLapHint').textContent = d ? '90% まで聞くと自動で +1（今の周の聴取 ' + Math.min(100, Math.round((cur.lapLec || 0) / d * 100)) + '%）' : '';
  }

  function visibleTracks() {
    var list = tracks.filter(function (t) {
      if (!matchFilter(t, ui.subject)) return false;
      if (ui.view === 'unheard') return !(t.playCount > 0) && !(t.listenedSec > 0);
      if (ui.view === 'review') return t.status === 'again' || t.status === 'text';
      if (ui.view === 'local') return !t.offline;
      return true;
    });
    if (ui.sort === 'count') {
      list.sort(function (a, b) { return (a.playCount || 0) - (b.playCount || 0) || natcmp(groupOf(a), groupOf(b)) || a.no - b.no; });
    } else if (ui.sort === 'old') {
      list.sort(function (a, b) { return (a.lastPlayedAt || 0) - (b.lastPlayedAt || 0) || natcmp(groupOf(a), groupOf(b)) || a.no - b.no; });
    }
    return list;
  }

  function renderFilters() {
    var subs = subjects();
    var vals = [''];
    var opt = '<option value="">すべての科目</option>';
    subs.forEach(function (s) {
      var cs = coursesOf(s);
      var multi = cs.length > 1;
      if (multi) { vals.push('s:' + s); opt += '<option value="s:' + esc(s) + '">' + esc(s) + '（すべてのコース）</option>'; }
      cs.forEach(function (c) {
        var g = s + (c ? '＜' + c + '＞' : '');
        vals.push('g:' + g);
        opt += '<option value="g:' + esc(g) + '">' + (multi ? '　' : '') + esc(g) + '</option>';
      });
    });
    if (ui.subject && ui.subject.indexOf('s:') !== 0 && ui.subject.indexOf('g:') !== 0) ui.subject = 'g:' + ui.subject;
    if (vals.indexOf(ui.subject) < 0) ui.subject = '';
    $('fSubject').innerHTML = opt;
    $('fSubject').value = ui.subject;
    $('fView').value = ui.view;
    $('fSort').value = ui.sort;
    var dl = '';
    subs.forEach(function (s) { dl += '<option value="' + esc(s) + '">'; });
    $('subjectList').innerHTML = dl;
    if (!$('importSubject').value) $('importSubject').value = settings.subject || '';
    var del = '';
    groups().forEach(function (g) { del += '<option value="' + esc(g) + '">' + esc(g) + '</option>'; });
    $('delSubject').innerHTML = del || '<option value="">（なし）</option>';
  }

  function renderList() {
    var list = visibleTracks();
    var showSub = !(ui.subject && ui.subject.indexOf('g:') === 0) && groups().length > 1;
    var html = '';
    list.forEach(function (t) {
      var prog = t.duration ? Math.min(100, Math.round((t.lastPos || 0) / t.duration * 100)) : 0;
      var mk = statusMark(t.status);
      html += '<li class="track' + (cur && cur.id === t.id ? ' cur' : '') + (t.offline ? ' off' : '') + '" data-id="' + t.id + '">' +
        '<div class="track-no ' + lapClass(t.playCount) + '">' + t.no + '</div>' +
        '<div class="track-body"><div class="track-name">' + (showSub ? '<span class="hint">' + esc(groupOf(t)) + '｜</span>' : '') + esc(titleOf(t)) + '</div>' +
        '<div class="track-meta">' + (t.offline ? '☁ スマホになし（押すと Drive から取る）　' : '') + '周回 ' + (t.playCount || 0) + '　最終 ' + fmtDate(t.lastPlayedAt) + '　累計 ' + fmtMin(t.listenedSec) +
        (t.duration ? '　長さ ' + fmtTime(t.duration) : '') + '</div>' +
        '<div class="track-prog"><div style="width:' + prog + '%"></div></div></div>' +
        '<div class="track-mark mk-' + t.status + '">' + mk + '</div></li>';
    });
    $('trackList').innerHTML = html || '<li class="hint" style="padding:16px;text-align:center">' + (tracks.length ? '当てはまる音声はありません' : 'まだ音声がありません。科目名を入れて「＋ MP3を取り込む」を押してください') + '</li>';
    var heard = list.filter(function (t) { return t.playCount > 0; }).length;
    $('listCap').textContent = list.length + ' 件（1 周以上 ' + heard + ' 件）';
  }
  function renderListMarks() {
    // 一覧のうち、再生中の印と数字だけを軽く更新（全部作り直すより速い）
    var lis = $('trackList').children;
    for (var i = 0; i < lis.length; i++) {
      var id = lis[i].getAttribute('data-id');
      if (!id) continue;
      if (cur && cur.id === id) lis[i].classList.add('cur'); else lis[i].classList.remove('cur');
    }
    if (cur) {
      var li = $('trackList').querySelector('[data-id="' + cur.id + '"]');
      if (li) {
        var t = cur;
        var prog = t.duration ? Math.min(100, Math.round((t.lastPos || 0) / t.duration * 100)) : 0;
        li.querySelector('.track-no').className = 'track-no ' + lapClass(t.playCount);
        li.querySelector('.track-meta').textContent = '周回 ' + (t.playCount || 0) + '　最終 ' + fmtDate(t.lastPlayedAt) + '　累計 ' + fmtMin(t.listenedSec) + (t.duration ? '　長さ ' + fmtTime(t.duration) : '');
        li.querySelector('.track-prog > div').style.width = prog + '%';
        var mk = li.querySelector('.track-mark');
        mk.className = 'track-mark mk-' + t.status; mk.textContent = statusMark(t.status);
      }
    }
  }

  function renderTiles() {
    if (ui.tab !== 'tiles') return;
    var gs = groups().filter(function (g) {
      for (var i = 0; i < tracks.length; i++) if (groupOf(tracks[i]) === g) return matchFilter(tracks[i], ui.subject);
      return false;
    });
    var html = '';
    gs.forEach(function (s) {
      var list = tracks.filter(function (t) { return groupOf(t) === s; });
      var done = list.filter(function (t) { return t.playCount > 0; }).length;
      var sum = 0;
      list.forEach(function (t) { sum += t.playCount || 0; });
      html += '<div class="tile-sub">' + esc(s) + '　' + done + ' / ' + list.length + ' 単元を 1 周以上（のべ ' + sum + ' 周）</div><div class="tile-grid">';
      list.forEach(function (t) {
        html += '<button type="button" class="tile ' + lapClass(t.playCount) + (cur && cur.id === t.id ? ' cur' : '') + (t.offline ? ' off' : '') + '" data-id="' + t.id + '" title="' + esc(titleOf(t)) + '">' +
          t.no + (statusMark(t.status) ? '<span class="tm">' + statusMark(t.status) + '</span>' : '') + '</button>';
      });
      html += '</div>';
    });
    $('tileWrap').innerHTML = html || '<div class="hint" style="padding:16px;text-align:center">まだ音声がありません</div>';
  }

  function heatClass(sec) {
    var m = sec / 60;
    if (m < 1) return 'hc0';
    if (m < 15) return 'hc1';
    if (m < 30) return 'hc2';
    return 'hc3';
  }
  function renderStats() {
    if (ui.tab !== 'stats') return;
    var end = new Date(); end.setHours(0, 0, 0, 0);
    var start = new Date(end); start.setDate(start.getDate() - 89);
    var first = new Date(start); first.setDate(first.getDate() - first.getDay());   // 日曜はじまりにそろえる
    var html = '', d = new Date(first), tk = today();
    var sum90 = 0, days90 = 0;
    while (d <= end) {
      var k = dateKey(d);
      if (d < start) html += '<span class="dc blank"></span>';
      else {
        var x = daily[k] || { r: 0, l: 0 };
        if (x.r >= 60) days90++;
        sum90 += x.r;
        html += '<button type="button" class="dc ' + heatClass(x.r) + (k === tk ? ' today' : '') + '" data-day="' + k + '" aria-label="' + k + '"></button>';
      }
      d.setDate(d.getDate() + 1);
    }
    $('dayHeat').innerHTML = html;
    var wrap = document.querySelector('.heat-wrap');
    wrap.scrollLeft = wrap.scrollWidth;

    var total = 0, lect = 0, laps = 0, done = 0, rev = 0;
    Object.keys(daily).forEach(function (k) { total += daily[k].r; lect += daily[k].l; });
    tracks.forEach(function (t) { laps += t.playCount || 0; if (t.playCount > 0) done++; if (t.status === 'again' || t.status === 'text') rev++; });
    var bestStreak = 0, run = 0, keys = Object.keys(daily).sort(), prev = null, goal = settings.goalMin * 60;
    keys.forEach(function (k) {
      if (daily[k].r < goal) { run = 0; prev = k; return; }
      if (prev) {
        var p = new Date(prev + 'T00:00:00'); p.setDate(p.getDate() + 1);
        run = (dateKey(p) === k && run > 0) ? run + 1 : 1;
      } else run = 1;
      if (run > bestStreak) bestStreak = run;
      prev = k;
    });
    $('sumGrid').innerHTML =
      '<div class="sum"><b>' + fmtMin(total) + '</b><span>これまでの実聴取時間</span></div>' +
      '<div class="sum"><b>' + fmtMin(lect) + '</b><span>講義時間（1倍速換算）</span></div>' +
      '<div class="sum"><b>' + fmtMin(sum90 / 90) + '</b><span>直近90日の 1 日平均</span></div>' +
      '<div class="sum"><b>' + days90 + '日</b><span>直近90日で聞いた日</span></div>' +
      '<div class="sum"><b>🔥' + calcStreak() + '日</b><span>連続達成（最長 ' + bestStreak + '日）</span></div>' +
      '<div class="sum"><b>' + laps + '周</b><span>のべ周回（1周以上 ' + done + ' / ' + tracks.length + '）</span></div>' +
      '<div class="sum"><b>' + rev + '件</b><span>復習マーク（△・×）</span></div>' +
      '<div class="sum"><b>' + (lect && total ? (lect / total).toFixed(2) + '倍' : '—') + '</b><span>平均の速さ</span></div>';
  }

  function renderRates() {
    var html = '';
    RATES.forEach(function (r) {
      html += '<button type="button" class="rate' + (Math.abs(r - rate) < 0.01 ? ' on' : '') + '" data-rate="' + r + '">' + r.toFixed(1) + 'x</button>';
    });
    $('rates').innerHTML = html;
  }
  var seekDragging = false;
  function renderPlayer() {
    $('pTitle').textContent = cur ? (groupOf(cur) + '｜' + titleOf(cur)) : '—';
    $('bPlay').textContent = (cur && curUrl && !audio.paused) ? '❚❚' : '▶';
    renderPlayerTime();
  }
  function renderPlayerTime() {
    var d = audio.duration || (cur && cur.duration) || 0;
    var c = cur ? audio.currentTime || 0 : 0;
    if (!isFinite(d)) d = 0;
    $('tDur').textContent = fmtTime(d);
    if (!seekDragging) {
      $('tCur').textContent = fmtTime(c);
      $('seek').value = d ? Math.round(c / d * 1000) : 0;
    }
  }
  function renderSync() {
    var b = $('syncBadge');
    if (!settings.gasUrl) {
      b.textContent = '同期なし'; b.className = 'sync-badge';
    } else if (sending) {
      b.textContent = '同期中…'; b.className = 'sync-badge';
    } else if (syncState.lastErr) {
      b.textContent = '同期できず'; b.className = 'sync-badge warn';
    } else if (queue.length || hasSyncDirty()) {
      b.textContent = '未同期'; b.className = 'sync-badge warn';
    } else {
      b.textContent = '同期済み'; b.className = 'sync-badge ok';
    }
    var info = 'この端末「' + (settings.deviceName || '名前なし') + '」　未送信のログ ' + queue.length + ' 件';
    if (syncState.devices) info += '　同期している端末 ' + syncState.devices + ' 台';
    if (syncState.lastPull) info += '　最後に同期した時刻 ' + new Date(syncState.lastPull).toLocaleString();
    else if (syncState.lastOk) info += '　最後に送れた時刻 ' + new Date(syncState.lastOk).toLocaleString();
    if (syncState.lastErr) info += '　直近のエラー：' + syncState.lastErr;
    $('syncInfo').textContent = info;
  }
  function renderTab() {
    ['list', 'tiles', 'stats'].forEach(function (n) {
      $('tab-' + n).classList.toggle('hidden', ui.tab !== n);
    });
    var tabs = document.querySelectorAll('.tab');
    for (var i = 0; i < tabs.length; i++) tabs[i].classList.toggle('active', tabs[i].getAttribute('data-tab') === ui.tab);
    renderTiles(); renderStats();
  }
  function renderAll() {
    renderFilters(); renderHero(); renderNow(); renderList(); renderTab(); renderRates(); renderPlayer(); renderSync();
  }

  /* ---------- CSV・バックアップ ---------- */
  function csvCell(v) {
    v = v == null ? '' : String(v);
    return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  }
  function tracksCsv() {
    var rows = [['科目', 'コース', '番号', '題名', 'ファイル名', '周回数', '累積実時間(分)', '累積講義時間(分)', '最終聴取日', '理解度', '停止位置', '長さ']];
    tracks.forEach(function (t) {
      rows.push([t.subject, t.course || '', t.no, titleOf(t), t.name, t.playCount || 0, ((t.listenedSec || 0) / 60).toFixed(1), ((t.lectureSec || 0) / 60).toFixed(1),
        t.lastPlayedAt ? new Date(t.lastPlayedAt).toLocaleString() : '', statusLabel(t.status), fmtTime(t.lastPos), fmtTime(t.duration)]);
    });
    return rows.map(function (r) { return r.map(csvCell).join(','); }).join('\r\n');
  }
  function dailyCsv() {
    var rows = [['日付', '実聴取(分)', '講義時間(分)', '目標達成']];
    var goal = settings.goalMin * 60;
    Object.keys(daily).sort().forEach(function (k) {
      rows.push([k, (daily[k].r / 60).toFixed(1), (daily[k].l / 60).toFixed(1), daily[k].r >= goal ? '○' : '']);
    });
    return rows.map(function (r) { return r.map(csvCell).join(','); }).join('\r\n');
  }
  function download(name, text, type) {
    var blob = new Blob(['﻿' + text], { type: type || 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
  }
  function copyText(text) {
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', '');
      ta.style.position = 'fixed'; ta.style.top = '0'; ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select(); ta.setSelectionRange(0, text.length);
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      document.body.removeChild(ta);
      toast(ok ? 'コピーしました' : 'コピーできませんでした');
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast('コピーしました'); }, fallback);
    } else fallback();
  }
  function stamp() { var d = new Date(); return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()); }
  function backupJson() {
    var data = {
      app: 'studyAudioPlayer', version: APP_VERSION, savedAt: new Date().toISOString(),
      settings: settings, daily: daily, queue: queue,
      tracks: tracks.map(function (t) {
        return { subject: t.subject, course: t.course || '', title: titleOf(t), cat: t.cat || 0, name: t.name, playCount: t.playCount, lastPlayedAt: t.lastPlayedAt, listenedSec: t.listenedSec,
          lectureSec: t.lectureSec, lapLec: t.lapLec, status: t.status, lastPos: t.lastPos };
      })
    };
    download('学習音声_履歴_' + stamp() + '.json', JSON.stringify(data), 'application/json');
  }
  async function restoreJson(file) {
    var text = await new Promise(function (res, rej) { var fr = new FileReader(); fr.onload = function () { res(fr.result); }; fr.onerror = rej; fr.readAsText(file); });
    var data;
    try { data = JSON.parse(text.replace(/^﻿/, '')); } catch (e) { toast('読めないファイルです'); return; }
    if (!data || data.app !== 'studyAudioPlayer') { toast('このアプリの履歴ファイルではありません'); return; }
    if (!confirm('履歴を読み込みます。同じ科目・同じファイル名の音声の記録を、ファイルの記録で置きかえます。日別の記録は多いほうを残します。（GAS の同期を使っているときは、これは使わずに同じ URL を入れるだけで記録がそろいます）よろしいですか？')) return;
    var hit = 0, miss = 0, reClass = false;
    (data.tracks || []).forEach(function (b) {
      var t = null;
      for (var i = 0; i < tracks.length; i++) if (tracks[i].name === b.name) { t = tracks[i]; break; }
      if (!t) { miss++; return; }
      if (b.cat && b.cat > (t.cat || 0) && b.subject) { setClass(t, b.subject, b.course || '', b.title || null, b.cat); reClass = true; }
      else if (b.subject && t.subject !== b.subject && !parseName(t.name)) { t.subject = b.subject; reClass = true; }
      ['playCount', 'lastPlayedAt', 'listenedSec', 'lectureSec', 'lapLec', 'status', 'lastPos'].forEach(function (f) { if (b[f] !== undefined) t[f] = b[f]; });
      markDirty(t); hit++;
    });
    Object.keys(data.daily || {}).forEach(function (k) {
      var x = data.daily[k], y = daily[k];
      if (!y || x.r > y.r) daily[k] = { r: x.r || 0, l: x.l || 0 };
    });
    lsSet(K.daily, daily);
    if (reClass) { groups().forEach(function (g) { renumber(g).forEach(markDirty); }); sortTracks(); }
    await saveDirty();
    renderAll();
    toast(hit + ' 件の記録を戻しました' + (miss ? '（音声がまだない ' + miss + ' 件は飛ばしました）' : ''), 5000);
  }
  function renderStorage() {
    var el = $('storageInfo');
    var u = localBytes(), off = tracks.length - u.n;
    var txt = 'スマホにある音声 ' + u.n + ' 本・約 ' + Math.round(u.b / 1048576) + 'MB（1GB の ' + Math.min(999, Math.round(u.b / 10737418.24)) + '%）' +
      (off ? '　外してある音声 ' + off + ' 本' : '');
    el.textContent = txt;
    var bar = $('storageBar'), pct = Math.min(100, u.b / 10737418.24);
    bar.style.width = pct + '%';
    bar.className = 'gauge-bar' + (u.b >= 1073741824 * 0.95 ? ' full' : u.b >= LIMIT_WARN ? ' warn' : '');
    if (navigator.storage && navigator.storage.estimate) {
      navigator.storage.estimate().then(function (e) {
        el.textContent = txt + '（このアプリが使える量の目安：' + ((e.usage || 0) / 1048576).toFixed(0) + 'MB / ' + ((e.quota || 0) / 1048576).toFixed(0) + 'MB）';
      }).catch(function () { /* 無視 */ });
    }
    $('verInfo').textContent = '学習音声プレーヤー 版 ' + APP_VERSION;
  }

  /* ---------- 操作 ---------- */
  function bind() {
    $('hero').addEventListener('click', function () {
      if (cur && curUrl && !audio.paused) pause(); else resume();
    });
    $('bPlay').addEventListener('click', togglePlay);
    $('bBack').addEventListener('click', function () { seekBy(-10); });
    $('bFwd').addEventListener('click', function () { seekBy(15); });
    $('bPrev').addEventListener('click', prevTrack);
    $('bNext').addEventListener('click', function () { nextTrack(false); });
    $('rates').addEventListener('click', function (e) {
      var r = e.target.getAttribute('data-rate');
      if (!r) return;
      accumulate();
      rate = parseFloat(r);
      lsSet(K.rate, rate);
      applyRate();
      renderRates();
      updatePositionState();
    });
    var seek = $('seek');
    seek.addEventListener('input', function () {
      seekDragging = true;
      var d = audio.duration || (cur && cur.duration) || 0;
      $('tCur').textContent = fmtTime(d * seek.value / 1000);
    });
    seek.addEventListener('change', function () {
      var d = audio.duration || (cur && cur.duration) || 0;
      seekDragging = false;
      if (cur && d) seekTo(d * seek.value / 1000);
    });

    $('trackList').addEventListener('click', function (e) {
      var li = e.target.closest ? e.target.closest('.track') : null;
      if (!li) return;
      playId(li.getAttribute('data-id'));
    });
    $('tileWrap').addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('.tile') : null;
      if (b) playId(b.getAttribute('data-id'));
    });
    $('dayHeat').addEventListener('click', function (e) {
      var k = e.target.getAttribute('data-day');
      if (!k) return;
      var x = daily[k] || { r: 0, l: 0 };
      var p = k.split('-');
      $('dayInfo').textContent = parseInt(p[1], 10) + '月' + parseInt(p[2], 10) + '日：実聴取 ' + fmtMin(x.r) + '・講義時間 ' + fmtMin(x.l) +
        (x.r >= settings.goalMin * 60 ? '　✅ 目標達成' : '');
    });
    var tabs = document.querySelectorAll('.tab');
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].addEventListener('click', function () {
        ui.tab = this.getAttribute('data-tab'); lsSet(K.ui, ui); renderTab();
      });
    }
    $('fSubject').addEventListener('change', function () { ui.subject = this.value; lsSet(K.ui, ui); renderList(); renderTiles(); });
    $('fView').addEventListener('change', function () { ui.view = this.value; lsSet(K.ui, ui); renderList(); });
    $('fSort').addEventListener('change', function () { ui.sort = this.value; lsSet(K.ui, ui); renderList(); });
    // 選んだファイルはすぐ手元の配列に移し、入れ物は空にする
    // （失敗や途中で止まっても、次に同じファイルを選べば必ず反応するように）
    var importing = false;
    $('fileInput').addEventListener('click', function () { this.value = ''; });
    $('fileInput').addEventListener('change', function () {
      var files = [].slice.call(this.files || []);
      this.value = '';
      if (!files.length) return;
      if (importing) { toast('いま取り込み中です。終わってからもう一度選んでください', 4000); return; }
      importing = true;
      toast(files.length + ' 件を受け取りました。読み込んでいます…', 60000);
      var subject = $('importSubject').value;
      importFiles(files, subject).catch(function (e) {
        console.error(e);
        toast('取り込みで止まりました：' + ((e && (e.name + ' ' + (e.message || ''))) || e), 8000);
      }).then(function () { importing = false; });
    });

    $('btnDrive').addEventListener('click', openDrive);
    $('btnCloseDrive').addEventListener('click', function () {
      if (driveBusy && !confirm('取り込みの途中です。閉じても裏で続きます。閉じますか？')) return;
      $('driveModal').classList.add('hidden');
    });
    $('btnDriveReload').addEventListener('click', function () { if (!driveBusy) loadDriveList(); });
    $('btnDriveGo').addEventListener('click', runDriveImport);
    $('btnDriveAll').addEventListener('click', function () {
      if (driveBusy) return;
      driveFiles.forEach(function (f) { f.checked = f.state.st === 'new' || f.state.st === 'newer'; });
      renderDrive();
    });
    $('btnDriveNone').addEventListener('click', function () {
      if (driveBusy) return;
      driveFiles.forEach(function (f) { f.checked = false; });
      renderDrive();
    });

    $('statusRow').addEventListener('click', function (e) {
      var k = e.target.getAttribute('data-st');
      if (!k || !cur) return;
      cur.status = k; cur.statusAt = Date.now(); markDirty(cur); markSyncT(cur); saveDirty();
      pushLog(cur, 'status', 0, 0);
      renderNow(); renderListMarks(); renderTiles();
    });
    $('lapPlus').addEventListener('click', function () { adjustLap(1); });
    $('lapMinus').addEventListener('click', function () { adjustLap(-1); });
    $('replaceInput').addEventListener('change', function () {
      var file = this.files && this.files[0], t = cur, input = this;
      if (!file || !t) { input.value = ''; return; }
      if (!confirm('「' + titleOf(t) + '」の音声を「' + file.name + '」に差し替えます。\n周回数・聴取時間・理解度はそのまま、続きの位置は最初に戻ります。よろしいですか？')) { input.value = ''; return; }
      toast('差し替え中…', 60000);
      replaceAudio(t, file).then(function () {
        input.value = '';
        return loadTrack(t.id, 0, false);   // 新しい音声を最初から聞ける状態にしておく
      }).then(function () {
        renderAll();
        toast('音声を差し替えました', 3000);
      }, function (e) {
        console.error(e);
        input.value = '';
        toast('差し替えできませんでした。スマホの空き容量が足りないかもしれません', 6000);
      });
    });
    $('btnEditTrack').addEventListener('click', function () { if (cur) openEdit(cur); });
    $('btnEditGroup').addEventListener('click', function () {
      var g = $('delSubject').value;
      if (g) openEdit(null, g);
    });
    $('btnCloseEdit').addEventListener('click', function () { $('editModal').classList.add('hidden'); });
    $('btnEditCancel').addEventListener('click', function () { $('editModal').classList.add('hidden'); });
    $('btnEditSave').addEventListener('click', function () { saveEdit().catch(function (e) { console.error(e); toast('変えられませんでした：' + errMsg(e), 5000); }); });
    $('eSubject').addEventListener('input', fillEditLists);
    [].forEach.call(document.getElementsByName('editScope'), function (r) { r.addEventListener('change', syncEditScope); });
    $('btnOffTrack').addEventListener('click', function () {
      if (!cur) return;
      confirmRemove([cur]).then(function (list) {
        if (list) removeAudio(list).then(function () { toast('音声を外しました（記録は残っています）'); });
      });
    });
    $('btnOffSubject').addEventListener('click', function () {
      var s = $('delSubject').value;
      if (!s) return;
      confirmRemove(tracks.filter(function (t) { return groupOf(t) === s; })).then(function (list) {
        if (list) removeAudio(list).then(function () { toast(list.length + ' 本の音声を外しました（記録は残っています）', 4000); });
      });
    });
    $('btnGetSubject').addEventListener('click', async function () {
      var s = $('delSubject').value;
      if (!s || fetchingId) return;
      var list = tracks.filter(function (t) { return groupOf(t) === s && t.offline; });
      if (!list.length) { toast('このコースは全部スマホにあります'); return; }
      if (!confirm('「' + s + '」の ' + list.length + ' 本を Drive から取ります（Wi-Fi のときに。終わるまで画面を消さないでください）。よろしいですか？')) return;
      var done = 0;
      for (var i = 0; i < list.length; i++) {
        var t = list[i], head = (i + 1) + ' / ' + list.length + ' 本目 ';
        fetchingId = t.id;
        try {
          await fetchOffline(t, function (r) { toast('☁ ' + head + Math.floor(r * 100) + '%　' + titleOf(t), 60000); });
          done++;
        } catch (e) {
          console.error(e);
          fetchingId = null;
          toast('「' + titleOf(t) + '」で止まりました：' + errMsg(e), 8000);
          break;
        }
        fetchingId = null;
      }
      fetchingId = null;
      renderAll(); renderStorage();
      if (done === list.length) toast(done + ' 本を Drive から取りました', 4000);
      storageWarn();
    });
    $('btnDeleteTrack').addEventListener('click', function () {
      if (!cur) return;
      if (!confirm('「' + cur.name + '」の音声と記録を消します。元に戻せません。よろしいですか？')) return;
      deleteTracks([cur]).then(function () { toast('消しました'); });
    });

    $('btnSettings').addEventListener('click', openSettings);
    $('syncBadge').addEventListener('click', openSettings);
    $('btnCloseSettings').addEventListener('click', function () { $('settings').classList.add('hidden'); });
    $('btnSaveSettings').addEventListener('click', function () { saveSettings(); toast('保存しました'); });
    $('btnSendNow').addEventListener('click', function () { saveSettings(); syncState.lastPull = 0; sendQueue(true); });
    $('btnCsvTracks').addEventListener('click', function () { download('学習音声_単元_' + stamp() + '.csv', tracksCsv()); });
    $('btnCopyTracks').addEventListener('click', function () { copyText(tracksCsv()); });
    $('btnCsvDaily').addEventListener('click', function () { download('学習音声_日別_' + stamp() + '.csv', dailyCsv()); });
    $('btnCopyDaily').addEventListener('click', function () { copyText(dailyCsv()); });
    $('btnBackup').addEventListener('click', backupJson);
    $('restoreInput').addEventListener('change', function () {
      if (this.files && this.files[0]) restoreJson(this.files[0]).then(function () { $('restoreInput').value = ''; });
    });
    $('btnDelSubject').addEventListener('click', function () {
      var s = $('delSubject').value;
      if (!s) return;
      var list = tracks.filter(function (t) { return groupOf(t) === s; });
      if (!confirm('「' + s + '」の音声 ' + list.length + ' 件と、その周回などの記録をこのスマホから消します。元に戻せません。\n（記録を残したいときは「このコースの音声だけ外す」）よろしいですか？')) return;
      deleteTracks(list).then(function () { renderStorage(); toast('消しました'); });
    });
    $('btnDelAll').addEventListener('click', function () {
      if (!confirm('音声と記録をすべて消します（未送信のログも消えます）。元に戻せません。よろしいですか？')) return;
      if (!confirm('本当にすべて消しますか？')) return;
      stopPlayback();
      Promise.all([idbClear('audio'), idbClear('tracks')]).then(function () {
        tracks = []; byId = {}; daily = {}; queue = []; dailyBase = {}; sdirty = { t: {}, d: {} };
        [K.daily, K.queue, K.last, K.dbase, K.sdirty].forEach(function (k) { localStorage.removeItem(k); });
        deviceId = 'd' + uid(); lsSet(K.device, deviceId);
        syncState = { lastOk: 0, lastErr: '' }; lsSet(K.sync, syncState);
        renderAll(); renderStorage(); toast('すべて消しました');
      });
    });

    window.addEventListener('online', function () { sendQueue(); });
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') { accumulate(); persistNow(); saveLast(); saveDirty(); }
      else { renderHero(); renderStats(); sendQueue(); checkUpdate(); }
    });
    window.addEventListener('pagehide', function () { accumulate(); flushSession('close'); persistNow(); saveLast(); saveDirty(); });
  }
  function playId(id) {
    if (!id) return;
    if (cur && cur.id === id) { togglePlay(); return; }
    var t = byId[id];
    loadTrack(id, t ? t.lastPos || 0 : 0, true);
  }
  function adjustLap(n) {
    if (!cur) return;
    cur.playCount = Math.max(0, (cur.playCount || 0) + n);
    if (n > 0) { cur.lastPlayedAt = Date.now(); cur.lapLec = 0; }
    markDirty(cur); markSyncT(cur); saveDirty();
    pushLog(cur, n > 0 ? 'manual+1' : 'manual-1', 0, 0);
    renderNow(); renderListMarks(); renderTiles(); renderHero();
  }
  function openSettings() {
    $('sGoal').value = settings.goalMin;
    $('sSubject').value = settings.subject || '';
    $('sAutoNext').checked = !!settings.autoNext;
    $('sTrackBtn').value = settings.trackBtn;
    $('sGasUrl').value = settings.gasUrl || '';
    $('sDeviceName').value = settings.deviceName || '';
    renderSync(); renderStorage();
    $('settings').classList.remove('hidden');
  }
  function saveSettings() {
    var g = parseInt($('sGoal').value, 10);
    settings.goalMin = g > 0 ? g : 15;
    settings.subject = $('sSubject').value.trim();
    settings.autoNext = $('sAutoNext').checked;
    settings.trackBtn = $('sTrackBtn').value;
    settings.gasUrl = $('sGasUrl').value.trim();
    settings.deviceName = $('sDeviceName').value.trim();
    lsSet(K.settings, settings);
    renderHero(); renderStats(); renderSync();
  }

  async function migrateNames() {
    var changed = [], gs = {};
    tracks.forEach(function (t) {
      if (t.course !== undefined && t.title !== undefined) return;
      var p = parseName(t.name);
      if (p) { t.subject = p.subject; t.course = p.course; t.title = p.title; }
      else { t.course = t.course || ''; t.title = t.name.replace(/\.[^.]+$/, ''); }
      changed.push(t);
    });
    // 番号の付け方が変わったときのため、開くたびに付け直す（変わったものだけ保存）
    var oldNo = {};
    tracks.forEach(function (t) { oldNo[t.id] = t.no; gs[groupOf(t)] = 1; });
    Object.keys(gs).forEach(function (g) { renumber(g); });
    tracks.forEach(function (t) { if (oldNo[t.id] !== t.no && changed.indexOf(t) < 0) changed.push(t); });
    if (!changed.length) return;
    await idbReq('tracks', 'readwrite', function (s) { changed.forEach(function (t) { s.put(t); }); return null; });
  }

  /* ---------- 新しい版への入れかえ ---------- */
  // iPhone のホーム画面のアプリは、閉じても裏で生きていて開き直さないことが多い。
  // そこで、開いたとき・画面に戻ったときに公開先へ新しい版を聞きに行く
  var swReg = null, wantReload = false, reloading = false, lastCheck = 0;
  function checkUpdate() {
    if (!swReg || navigator.onLine === false) return;
    if (Date.now() - lastCheck < 30000) return;
    lastCheck = Date.now();
    try { swReg.update().catch(function () { /* 圏外など */ }); } catch (e) { /* 無視 */ }
  }
  function reloadForUpdate() {
    if (reloading) return;
    reloading = true;
    try { accumulate(); persistNow(); saveLast(); } catch (e) { /* 無視 */ }
    Promise.resolve(saveDirty()).then(function () { location.reload(); }, function () { location.reload(); });
  }

  /* ---------- 起動 ---------- */
  async function start() {
    $('verTop').textContent = 'v' + APP_VERSION;
    bind();
    setupMediaSession();
    try {
      db = await openDB();
      tracks = await idbAll('tracks');
      await migrateNames();
      await probeBlob();
      sortTracks();
    } catch (e) {
      console.error(e);
      toast('保存場所（IndexedDB）が開けません。プライベートブラウズでは使えません', 8000);
    }
    renderAll();
    sendQueue();
    setInterval(function () { if (queue.length || hasSyncDirty()) sendQueue(); }, 60000);
    // 日付が変わったら表示を直す
    setInterval(function () { tickHero(true); }, 60000);
    if ('serviceWorker' in navigator) {
      // 新しい版が届いて入れかわったら、自動で開き直す（再生中なら止めたときに）
      var hadCtrl = !!navigator.serviceWorker.controller;
      navigator.serviceWorker.addEventListener('controllerchange', function () {
        if (!hadCtrl) { hadCtrl = true; return; }   // はじめて開いたときは開き直さない
        if (cur && curUrl && !audio.paused) {
          wantReload = true;
          toast('新しい版が届きました。再生を止めたときに入れかわります', 5000);
          return;
        }
        reloadForUpdate();
      });
      navigator.serviceWorker.register('sw.js').then(function (reg) {
        swReg = reg;
        checkUpdate();
      }).catch(function (e) { console.warn('SW', e); });
    }
  }

  // テスト用（ふだんは使わない）
  window.__sap = {
    importFiles: importFiles, get tracks() { return tracks; }, get daily() { return daily; }, get queue() { return queue; },
    get cur() { return cur; }, audio: audio, loadTrack: loadTrack, sendQueue: sendQueue,
    get deviceId() { return deviceId; }, get sdirty() { return sdirty; }, applyPull: function (j) { applyPull(j); }
  };

  start();
})();
