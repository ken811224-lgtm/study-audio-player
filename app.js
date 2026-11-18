/*
 * 学習音声プレーヤー app.js
 * 古いスマホでも動くよう、?. や ?? は使わない（ES2017 まで）
 */
(function () {
  'use strict';

  var APP_VERSION = '1.1.0';
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
    last: 'sap.last', rate: 'sap.rate', ui: 'sap.ui', sync: 'sap.sync'
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
  function idbGet(store, id) { return idbReq(store, 'readonly', function (s) { return s.get(id); }); }
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

  async function importFiles(fileList, subject) {
    subject = (subject || '').trim() || '未分類';
    var touched = {}, lastGroup = '';
    var files = [].slice.call(fileList).filter(function (f) {
      return /^audio\//.test(f.type) || /\.(mp3|m4a|aac|wav|ogg)$/i.test(f.name);
    });
    files.sort(function (a, b) { return natcmp(a.name, b.name); });
    if (!files.length) { toast('音声ファイルが選ばれていません'); return; }
    if (navigator.storage && navigator.storage.persist) { try { await navigator.storage.persist(); } catch (e) { /* 無視 */ } }
    var added = 0, skipped = 0;
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      var pn = parseName(f.name);
      var info = pn || { subject: subject, course: '', title: f.name.replace(/\.[^.]+$/, '') };
      var exists = tracks.some(function (t) { return t.subject === info.subject && (t.course || '') === info.course && t.name === f.name; });
      if (exists) { skipped++; continue; }
      toast('取り込み中 ' + (i + 1) + ' / ' + files.length, 60000);
      try {
        var buf = await readFile(f);
        var id = uid();
        await idbPut('audio', { id: id, type: f.type || 'audio/mpeg', data: buf });
        buf = null;
        var t = {
          id: id, subject: info.subject, course: info.course, title: info.title, name: f.name, no: 0, size: f.size, duration: 0,
          playCount: 0, lastPlayedAt: 0, listenedSec: 0, lectureSec: 0, lapLec: 0,
          status: 'none', lastPos: 0, addedAt: Date.now()
        };
        tracks.push(t);
        await idbPut('tracks', t);
        lastGroup = groupOf(t);
        touched[lastGroup] = 1;
        added++;
      } catch (e) {
        console.error(e);
        toast('「' + f.name + '」で止まりました。スマホの空き容量が足りないかもしれません', 6000);
        break;
      }
    }
    var list = [];
    Object.keys(touched).forEach(function (g) { list = list.concat(renumber(g)); });
    if (list.length) await idbReq('tracks', 'readwrite', function (s) { list.forEach(function (t) { s.put(t); }); return null; });
    sortTracks();
    var gs = Object.keys(touched);
    if (gs.length === 1) { ui.subject = 'g:' + gs[0]; lsSet(K.ui, ui); }
    renderAll();
    toast(added + ' 件取り込みました' + (gs.length ? '（' + gs.join('・') + '）' : '') +
      (skipped ? '　同じ名前の ' + skipped + ' 件は飛ばしました' : ''), 5000);
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

  async function loadTrack(id, startPos, autoplay) {
    var t = byId[id];
    if (!t) return;
    accumulate();
    flushSession('switch');
    var rec = await idbGet('audio', id);
    if (!rec) { toast('音声の中身が見つかりません。取り込み直してください', 5000); return; }
    var blob = new Blob([rec.data], { type: rec.type || 'audio/mpeg' });
    rec = null;
    releaseUrl();                       // 前の曲の Blob URL を必ず解放
    curUrl = URL.createObjectURL(blob);
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
  function nextTrack(auto) {
    var list = orderedForNext();
    if (!list.length) return;
    var i = list.indexOf(cur);
    if (i >= 0 && i + 1 < list.length) {
      var n = list[i + 1];
      loadTrack(n.id, auto ? 0 : (n.lastPos || 0), true);
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
    cur.lastPos = audio.ended ? 0 : ct;
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
    lsSet(K.daily, daily);
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
  var sendTimer = null, sending = false;
  function scheduleSend() {
    if (sendTimer) clearTimeout(sendTimer);
    sendTimer = setTimeout(sendQueue, 3000);
  }
  function recentDaily() {
    var out = {}, d = new Date();
    for (var i = 0; i < 3; i++) {
      var k = dateKey(d);
      if (daily[k]) out[k] = { real: Math.round(daily[k].r), lecture: Math.round(daily[k].l) };
      d.setDate(d.getDate() - 1);
    }
    return out;
  }
  async function sendQueue(manual) {
    if (!settings.gasUrl) { if (manual) toast('GAS の URL が入っていません'); return; }
    if (sending) return;
    if (navigator.onLine === false) { if (manual) toast('いまは圏外です。つながったら自動で送ります'); return; }
    if (!queue.length && !manual) return;
    sending = true;
    renderSync();
    try {
      do {
        var batch = queue.slice(0, 100);
        var body = JSON.stringify({ secret: settings.secret || '', app: APP_VERSION, logs: batch, daily: recentDaily() });
        var ok = false;
        try {
          // text/plain にすると事前確認（プリフライト）が起きず GAS にそのまま届く
          var res = await fetch(settings.gasUrl, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: body, redirect: 'follow' });
          var txt = await res.text();
          var j = null;
          try { j = JSON.parse(txt); } catch (e) { /* JSON でない */ }
          if (j && j.ok) ok = true;
          else throw new Error((j && j.error) || ('返事が読めません（' + res.status + '）'));
        } catch (e) {
          // GAS から返事が来たのにエラー（合言葉違いなど）のときは、キューを残したまま止める
          if (!(e instanceof TypeError)) throw e;
          // 返事が読めない環境向け：no-cors で送る（届いたかは分からないが、GAS 側で同じログは 2 回入らない）
          await fetch(settings.gasUrl, { method: 'POST', mode: 'no-cors', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: body });
          ok = true;
        }
        if (ok) {
          var sent = {};
          batch.forEach(function (l) { sent[l.id] = 1; });
          queue = queue.filter(function (l) { return !sent[l.id]; });
          lsSet(K.queue, queue);
        }
      } while (queue.length && batch.length);
      syncState.lastOk = Date.now(); syncState.lastErr = '';
      if (manual) toast('送りました');
    } catch (e) {
      console.warn(e);
      syncState.lastErr = (e && e.message) || String(e);
      if (manual) toast('送れませんでした：' + syncState.lastErr, 5000);
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
    saveLast(); saveDirty();
    setPlaybackState('paused');
    renderPlayer(); renderHero(); renderListMarks();
  });
  audio.addEventListener('ratechange', function () {
    if (Math.abs(audio.playbackRate - rate) > 0.01 && cur) audio.playbackRate = rate;
    updatePositionState();
  });
  audio.addEventListener('ended', function () {
    accumulate();
    lastMedia = null;
    if (cur) { cur.lastPos = 0; markDirty(cur); }
    flushSession('ended');
    saveLast(); saveDirty();
    if (settings.autoNext) nextTrack(true);
    else { setPlaybackState('paused'); renderPlayer(); }
  });
  audio.addEventListener('error', function () {
    if (cur && curUrl) toast('この音声は再生できませんでした（形式が合わないかもしれません）', 5000);
  });

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
      html += '<li class="track' + (cur && cur.id === t.id ? ' cur' : '') + '" data-id="' + t.id + '">' +
        '<div class="track-no ' + lapClass(t.playCount) + '">' + t.no + '</div>' +
        '<div class="track-body"><div class="track-name">' + (showSub ? '<span class="hint">' + esc(groupOf(t)) + '｜</span>' : '') + esc(titleOf(t)) + '</div>' +
        '<div class="track-meta">周回 ' + (t.playCount || 0) + '　最終 ' + fmtDate(t.lastPlayedAt) + '　累計 ' + fmtMin(t.listenedSec) +
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
        html += '<button type="button" class="tile ' + lapClass(t.playCount) + (cur && cur.id === t.id ? ' cur' : '') + '" data-id="' + t.id + '" title="' + esc(titleOf(t)) + '">' +
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
      b.textContent = '送信中…'; b.className = 'sync-badge';
    } else if (queue.length) {
      b.textContent = '未送信 ' + queue.length; b.className = 'sync-badge warn';
    } else {
      b.textContent = '同期済み'; b.className = 'sync-badge ok';
    }
    var info = '未送信 ' + queue.length + ' 件';
    if (syncState.lastOk) info += '　最後に送れた時刻 ' + new Date(syncState.lastOk).toLocaleString();
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
        return { subject: t.subject, course: t.course || '', name: t.name, playCount: t.playCount, lastPlayedAt: t.lastPlayedAt, listenedSec: t.listenedSec,
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
    if (!confirm('履歴を読み込みます。同じ科目・同じファイル名の音声の記録を、ファイルの記録で置きかえます。日別の記録は多いほうを残します。よろしいですか？')) return;
    var hit = 0, miss = 0;
    (data.tracks || []).forEach(function (b) {
      var t = null;
      for (var i = 0; i < tracks.length; i++) if (tracks[i].name === b.name) { t = tracks[i]; break; }
      if (!t) { miss++; return; }
      if (b.subject && t.subject !== b.subject && !parseName(t.name)) { t.subject = b.subject; }
      ['playCount', 'lastPlayedAt', 'listenedSec', 'lectureSec', 'lapLec', 'status', 'lastPos'].forEach(function (f) { if (b[f] !== undefined) t[f] = b[f]; });
      markDirty(t); hit++;
    });
    Object.keys(data.daily || {}).forEach(function (k) {
      var x = data.daily[k], y = daily[k];
      if (!y || x.r > y.r) daily[k] = { r: x.r || 0, l: x.l || 0 };
    });
    lsSet(K.daily, daily);
    await saveDirty();
    renderAll();
    toast(hit + ' 件の記録を戻しました' + (miss ? '（音声がまだない ' + miss + ' 件は飛ばしました）' : ''), 5000);
  }
  function renderStorage() {
    var el = $('storageInfo');
    var total = 0;
    tracks.forEach(function (t) { total += t.size || 0; });
    var txt = '音声 ' + tracks.length + ' 件・約 ' + (total / 1048576).toFixed(0) + 'MB';
    el.textContent = txt;
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
    $('fileInput').addEventListener('change', function () {
      var files = this.files;
      var subject = $('importSubject').value;
      importFiles(files, subject).then(function () { $('fileInput').value = ''; });
    });

    $('statusRow').addEventListener('click', function (e) {
      var k = e.target.getAttribute('data-st');
      if (!k || !cur) return;
      cur.status = k; markDirty(cur); saveDirty();
      pushLog(cur, 'status', 0, 0);
      renderNow(); renderListMarks(); renderTiles();
    });
    $('lapPlus').addEventListener('click', function () { adjustLap(1); });
    $('lapMinus').addEventListener('click', function () { adjustLap(-1); });
    $('btnDeleteTrack').addEventListener('click', function () {
      if (!cur) return;
      if (!confirm('「' + cur.name + '」の音声と記録を消します。元に戻せません。よろしいですか？')) return;
      deleteTracks([cur]).then(function () { toast('消しました'); });
    });

    $('btnSettings').addEventListener('click', openSettings);
    $('syncBadge').addEventListener('click', openSettings);
    $('btnCloseSettings').addEventListener('click', function () { $('settings').classList.add('hidden'); });
    $('btnSaveSettings').addEventListener('click', function () { saveSettings(); toast('保存しました'); });
    $('btnSendNow').addEventListener('click', function () { saveSettings(); sendQueue(true); });
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
      if (!confirm('「' + s + '」の音声 ' + list.length + ' 件と、その周回などの記録を消します。元に戻せません。よろしいですか？')) return;
      deleteTracks(list).then(function () { renderStorage(); toast('消しました'); });
    });
    $('btnDelAll').addEventListener('click', function () {
      if (!confirm('音声と記録をすべて消します（未送信のログも消えます）。元に戻せません。よろしいですか？')) return;
      if (!confirm('本当にすべて消しますか？')) return;
      stopPlayback();
      Promise.all([idbClear('audio'), idbClear('tracks')]).then(function () {
        tracks = []; byId = {}; daily = {}; queue = [];
        [K.daily, K.queue, K.last].forEach(function (k) { localStorage.removeItem(k); });
        renderAll(); renderStorage(); toast('すべて消しました');
      });
    });

    window.addEventListener('online', function () { sendQueue(); });
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') { accumulate(); saveLast(); saveDirty(); }
      else { renderHero(); renderStats(); sendQueue(); }
    });
    window.addEventListener('pagehide', function () { accumulate(); flushSession('close'); saveLast(); saveDirty(); });
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
    markDirty(cur); saveDirty();
    pushLog(cur, n > 0 ? 'manual+1' : 'manual-1', 0, 0);
    renderNow(); renderListMarks(); renderTiles(); renderHero();
  }
  function openSettings() {
    $('sGoal').value = settings.goalMin;
    $('sSubject').value = settings.subject || '';
    $('sAutoNext').checked = !!settings.autoNext;
    $('sTrackBtn').value = settings.trackBtn;
    $('sGasUrl').value = settings.gasUrl || '';
    $('sSecret').value = settings.secret || '';
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
    settings.secret = $('sSecret').value.trim();
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

  /* ---------- 起動 ---------- */
  async function start() {
    bind();
    setupMediaSession();
    try {
      db = await openDB();
      tracks = await idbAll('tracks');
      await migrateNames();
      sortTracks();
    } catch (e) {
      console.error(e);
      toast('保存場所（IndexedDB）が開けません。プライベートブラウズでは使えません', 8000);
    }
    renderAll();
    sendQueue();
    setInterval(function () { if (queue.length) sendQueue(); }, 60000);
    // 日付が変わったら表示を直す
    setInterval(function () { tickHero(true); }, 60000);
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(function (e) { console.warn('SW', e); });
    }
  }

  // テスト用（ふだんは使わない）
  window.__sap = {
    importFiles: importFiles, get tracks() { return tracks; }, get daily() { return daily; }, get queue() { return queue; },
    get cur() { return cur; }, audio: audio, loadTrack: loadTrack, sendQueue: sendQueue
  };

  start();
})();
