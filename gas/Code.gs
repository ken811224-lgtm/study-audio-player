/**
 * 学習音声プレーヤー ⇔ Google スプレッドシート 同期用 GAS（v1.4.0）
 *
 * 使い方：記録用のスプレッドシートを開き「拡張機能 → Apps Script」にこのコードを貼る
 *         → 「デプロイ → 新しいデプロイ → ウェブアプリ」（実行するユーザー：自分／アクセス：全員）
 *         → 出てきた URL（…/exec）を、使う端末すべてのアプリの設定に入れる
 *
 * 同期のしくみ
 *   各端末は「自分の端末で聞いた分」だけを送る（同期_単元・同期_日別 に端末ごとの行で上書き）。
 *   アプリは全端末の行を読み戻して足し合わせる。周回数・聴取時間は端末の合計、
 *   理解度と停止位置はいちばん新しく変えた端末のもの。
 *
 * シート（無ければ自動で作る）
 *   再生ログ   … 一時停止・周回 +1 などのたびに 1 行（読むため用）
 *   単元マスタ … 全端末を合わせた 周回数・累積時間・最終聴取日・理解度（毎回作り直す）
 *   日別       … 全端末を合わせた 日ごとの聴取時間（毎回作り直す）
 *   同期_単元・同期_日別 … 同期の元データ（手で直さない）
 *
 * Drive から取り込む（v1.4.0）
 *   Drive の「034_講義録音」（無ければ「講義録音」、それも無ければ作る）にある音声を、アプリへ少しずつ渡す。
 *   渡すのはこのフォルダの中のファイルだけ。
 */

// 合言葉（使わないので空のまま。URL を知っている人だけが送れる）
var SECRET = '';

var LOG_SHEET = '再生ログ';
var MASTER_SHEET = '単元マスタ';
var DAILY_SHEET = '日別';
var SYNC_T_SHEET = '同期_単元';
var SYNC_D_SHEET = '同期_日別';
var LOG_HEAD = ['ログID', '日時', '端末', '科目', 'コース', '番号', '題名', 'ファイル名', 'できごと', '聴取(秒)', '講義時間(秒)', '周回数', '理解度', '受信日時'];
var MASTER_HEAD = ['科目', 'コース', '番号', '題名', 'ファイル名', '周回数', '累積実時間(分)', '累積講義時間(分)', '最終聴取日', '理解度', '聞いた端末', '更新日時'];
var DAILY_HEAD = ['日付', '実聴取(分)', '講義時間(分)', '更新日時'];
// 同期_単元 の列（時刻はミリ秒の数字のまま）
var SYNC_T_HEAD = ['端末ID', '端末名', 'ファイル名', '科目', 'コース', '番号', '題名', '周回', '実聴取秒', '講義秒', '最終聴取', '理解度', '理解度の時刻', '停止位置', '停止位置の時刻', '更新日時'];
var SYNC_D_HEAD = ['端末ID', '端末名', '日付', '実秒', '講義秒', '更新日時'];
var EVENT_NAME = {
  pause: '一時停止', ended: '最後まで', complete: '周回 +1', 'switch': '曲を変えた', stop: '停止',
  listening: '聴取中', close: '閉じた', status: '理解度を変えた', 'manual+1': '手で +1', 'manual-1': '手で -1', replace: '音声を差し替え'
};
var STATUS_LABEL = { none: '未評価', good: '◎ 完璧', again: '△ もう一度', text: '× 要テキスト確認' };

// 音声を置くフォルダ（左から順に探して、最初に見つかったものを使う。どれも無ければ「講義録音」を作る）
var DRIVE_FOLDERS = ['034_講義録音', '講義録音'];
var DRIVE_CHUNK = 6 * 1024 * 1024;   // 1 回に渡す大きさ（6MB → 文字にして約 8MB）

function doPost(e) {
  var body;
  try { body = JSON.parse((e && e.postData && e.postData.contents) || '{}'); }
  catch (err) { return json_({ ok: false, error: '送られた中身が読めません' }); }
  // Drive の読み出しは記録を書かないので、順番待ち（ロック）なしで答える
  if (body.action === 'driveList' || body.action === 'driveChunk') {
    try { return json_(body.action === 'driveList' ? driveList_() : driveChunk_(String(body.id || ''), Number(body.offset) || 0)); }
    catch (err) { return json_({ ok: false, error: String(err && err.message || err) }); }
  }
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(25000);
    if (SECRET && body.secret !== SECRET) return json_({ ok: false, error: '合言葉が違います' });
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var added = appendLogs_(ss, body.logs || [], body.deviceName || '');
    var out = { ok: true, added: added };
    if (body.device) {
      var st = upsertSyncTracks_(ss, body.device, body.deviceName || '', body.tracks || []);
      var sd = upsertSyncDaily_(ss, body.device, body.deviceName || '', body.daily || []);
      if (st.changed) rebuildMaster_(ss, st.rows);
      if (sd.changed) rebuildDaily_(ss, sd.rows);
      if (body.pull) {
        out.tracks = st.rows.map(function (r) {
          return { d: r[0], dn: r[1], f: r[2], pc: num_(r[7]), ls: num_(r[8]), lc: num_(r[9]), lp: num_(r[10]),
            st: r[11] || 'none', sa: num_(r[12]), pos: num_(r[13]), pa: num_(r[14]) };
        });
        out.daily = sd.rows.map(function (r) { return { d: r[0], k: String(r[2]), r: num_(r[3]), l: num_(r[4]) }; });
      }
    }
    return json_(out);
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  } finally {
    try { lock.releaseLock(); } catch (x) { /* 無視 */ }
  }
}

// 最初に 1 回だけ Apps Script の画面で実行する：使う許可を出して、シートを作っておく
function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  sheet_(ss, LOG_SHEET, LOG_HEAD);
  sheet_(ss, MASTER_SHEET, MASTER_HEAD);
  sheet_(ss, DAILY_SHEET, DAILY_HEAD);
  sheet_(ss, SYNC_T_SHEET, SYNC_T_HEAD);
  sheet_(ss, SYNC_D_SHEET, SYNC_D_HEAD);
  driveFolder_();   // Drive を使う許可もここで出してもらう
  // 音声を少しずつ取り出すための「外部への接続」の許可もここで出してもらう
  UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/about?fields=user', {
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true
  });
  var first = ss.getSheetByName('シート1');
  if (first && first.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(first);
}

// ブラウザで URL を開いたときの確認用
function doGet() {
  return json_({ ok: true, message: '学習音声プレーヤーの受け口は動いています（v1.4.0）' });
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
function num_(v) { var n = Number(v); return isFinite(n) ? n : 0; }

function sheet_(ss, name, head) {
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, head.length).setValues([head]).setFontWeight('bold').setBackground('#e8f5e9');
    sh.setFrozenRows(1);
  }
  return sh;
}
function readRows_(sh, width) {
  var last = sh.getLastRow();
  return last > 1 ? sh.getRange(2, 1, last - 1, width).getValues() : [];
}
// 見出しの下を全部書きかえる（行が減ったときは残りを消す）
function writeRows_(sh, rows, width) {
  var last = sh.getLastRow();
  if (last > rows.length + 1) sh.getRange(rows.length + 2, 1, last - rows.length - 1, width).clearContent();
  if (rows.length) sh.getRange(2, 1, rows.length, width).setValues(rows);
}

function toDate_(s) {
  if (!s) return '';
  var d = new Date(s);
  return isNaN(d.getTime()) ? '' : d;
}

function appendLogs_(ss, logs, deviceName) {
  if (!logs.length) return 0;
  var sh = sheet_(ss, LOG_SHEET, LOG_HEAD);
  var last = sh.getLastRow();
  // 同じログが 2 回届いても 1 回だけ入れる（直近 5000 行で照らし合わせる）
  var seen = {};
  if (last > 1) {
    var from = Math.max(2, last - 4999);
    sh.getRange(from, 1, last - from + 1, 1).getValues().forEach(function (r) { seen[r[0]] = true; });
  }
  var now = new Date();
  var rows = [];
  logs.forEach(function (l) {
    if (!l || !l.id || seen[l.id]) return;
    seen[l.id] = true;
    rows.push([
      l.id, toDate_(l.timestamp), deviceName, l.subject || '', l.course || '', l.no || '', l.title || '', l.fileName || '',
      EVENT_NAME[l.event] || l.event || '', num_(l.listenedSeconds), num_(l.lectureSeconds),
      num_(l.playCount), l.status || '', now
    ]);
  });
  if (rows.length) sh.getRange(last + 1, 1, rows.length, LOG_HEAD.length).setValues(rows);
  return rows.length;
}

// 端末の行を上書き（端末ID＋ファイル名で 1 行）
function upsertSyncTracks_(ss, device, deviceName, list) {
  var sh = sheet_(ss, SYNC_T_SHEET, SYNC_T_HEAD);
  var rows = readRows_(sh, SYNC_T_HEAD.length);
  if (!list.length) return { rows: rows, changed: false };
  var index = {};
  rows.forEach(function (r, i) { index[r[0] + '\t' + r[2]] = i; });
  var now = new Date();
  list.forEach(function (t) {
    if (!t || !t.f) return;
    var row = [device, deviceName, t.f, t.s || '', t.c || '', t.no || '', t.t || '', num_(t.pc), Math.round(num_(t.ls)), Math.round(num_(t.lc)),
      num_(t.lp), t.st || 'none', num_(t.sa), Math.round(num_(t.pos)), num_(t.pa), now];
    var k = device + '\t' + t.f;
    if (index[k] !== undefined) rows[index[k]] = row;
    else { index[k] = rows.length; rows.push(row); }
  });
  writeRows_(sh, rows, SYNC_T_HEAD.length);
  return { rows: rows, changed: true };
}

function upsertSyncDaily_(ss, device, deviceName, list) {
  var sh = sheet_(ss, SYNC_D_SHEET, SYNC_D_HEAD);
  var rows = readRows_(sh, SYNC_D_HEAD.length).map(function (r) {
    if (r[2] instanceof Date) r[2] = Utilities.formatDate(r[2], Session.getScriptTimeZone(), 'yyyy-MM-dd');
    else r[2] = String(r[2]);
    return r;
  });
  if (!list.length) return { rows: rows, changed: false };
  var index = {};
  rows.forEach(function (r, i) { index[r[0] + '\t' + r[2]] = i; });
  var now = new Date();
  list.forEach(function (x) {
    if (!x || !x.k) return;
    var row = [device, deviceName, String(x.k), Math.round(num_(x.r)), Math.round(num_(x.l)), now];
    var k = device + '\t' + x.k;
    if (index[k] !== undefined) rows[index[k]] = row;
    else { index[k] = rows.length; rows.push(row); }
  });
  if (rows.length) sh.getRange(2, 3, rows.length, 1).setNumberFormat('@');   // 日付を文字のまま
  writeRows_(sh, rows, SYNC_D_HEAD.length);
  return { rows: rows, changed: true };
}

// 全端末を合わせて 単元マスタ を作り直す
function rebuildMaster_(ss, syncRows) {
  var by = {};
  syncRows.forEach(function (r) {
    var f = r[2];
    var m = by[f] || (by[f] = { s: r[3], c: r[4], no: r[5], t: r[6], pc: 0, ls: 0, lc: 0, lp: 0, st: 'none', sa: -1, dev: {} });
    m.pc += num_(r[7]); m.ls += num_(r[8]); m.lc += num_(r[9]);
    if (num_(r[10]) > m.lp) m.lp = num_(r[10]);
    if (num_(r[12]) > m.sa) { m.sa = num_(r[12]); m.st = r[11] || 'none'; }
    if (num_(r[8]) > 0 && r[1]) m.dev[r[1]] = 1;
  });
  var now = new Date();
  var out = Object.keys(by).map(function (f) {
    var m = by[f];
    return [m.s, m.c, m.no, m.t, f, Math.max(0, m.pc), Math.round(m.ls / 6) / 10, Math.round(m.lc / 6) / 10,
      m.lp ? new Date(m.lp) : '', STATUS_LABEL[m.st] || m.st, Object.keys(m.dev).join('・'), now];
  });
  out.sort(function (a, b) {
    if (a[0] !== b[0]) return String(a[0]) < String(b[0]) ? -1 : 1;
    if (a[1] !== b[1]) return String(a[1]) < String(b[1]) ? -1 : 1;
    return (Number(a[2]) || 0) - (Number(b[2]) || 0);
  });
  writeRows_(sheet_(ss, MASTER_SHEET, MASTER_HEAD), out, MASTER_HEAD.length);
}

function rebuildDaily_(ss, syncRows) {
  var by = {};
  syncRows.forEach(function (r) {
    var k = String(r[2]);
    var d = by[k] || (by[k] = { r: 0, l: 0 });
    d.r += num_(r[3]); d.l += num_(r[4]);
  });
  var now = new Date();
  var out = Object.keys(by).sort().map(function (k) {
    return [k, Math.round(by[k].r / 6) / 10, Math.round(by[k].l / 6) / 10, now];
  });
  var sh = sheet_(ss, DAILY_SHEET, DAILY_HEAD);
  if (out.length) sh.getRange(2, 1, out.length, 1).setNumberFormat('@');
  writeRows_(sh, out, DAILY_HEAD.length);
}

/* ---------- Drive から取り込む ---------- */
function driveFolder_() {
  for (var i = 0; i < DRIVE_FOLDERS.length; i++) {
    var it = DriveApp.getFoldersByName(DRIVE_FOLDERS[i]);
    if (it.hasNext()) return it.next();
  }
  return DriveApp.createFolder(DRIVE_FOLDERS[DRIVE_FOLDERS.length - 1]);
}
function isAudio_(name, mime) {
  return /\.(mp3|m4a|aac|wav|ogg)$/i.test(name) || /^audio\//.test(mime || '');
}
// フォルダの中の音声の一覧
function driveList_() {
  var folder = driveFolder_();
  var out = [];
  var it = folder.getFiles();
  while (it.hasNext()) {
    var f = it.next();
    var name = f.getName(), size = f.getSize();
    if (!isAudio_(name, f.getMimeType()) || size <= 0) continue;
    out.push({ id: f.getId(), name: name, size: size, updated: f.getLastUpdated().getTime(), type: f.getMimeType() });
  }
  return { ok: true, folder: folder.getName(), files: out };
}
// 1 つのファイルの offset から DRIVE_CHUNK だけを文字（base64）にして渡す
function driveChunk_(id, offset) {
  if (!id) throw new Error('ファイルの指定がありません');
  var folderId = driveFolder_().getId();
  var file = DriveApp.getFileById(id);
  var inFolder = false, ps = file.getParents();
  while (ps.hasNext()) { if (ps.next().getId() === folderId) { inFolder = true; break; } }
  if (!inFolder) throw new Error('音声のフォルダのファイルではありません');
  var size = file.getSize();
  if (offset < 0 || offset >= size) throw new Error('読む場所がファイルの外です');
  var end = Math.min(offset + DRIVE_CHUNK, size) - 1;
  var bytes = null, via = 'range', why = '';
  // 必要な部分だけを Drive から取る（ファイル全体を読まない）。「外部への接続」の許可が無いときは下のやり方
  try {
    var res = UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(id) + '?alt=media', {
      headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken(), Range: 'bytes=' + offset + '-' + end },
      muteHttpExceptions: true
    });
    var code = res.getResponseCode();
    if (code !== 206 && code !== 200) why = code + ' ' + res.getContentText().slice(0, 200);
    if (code === 206 || code === 200) {
      bytes = res.getContent();
      if (code === 200 && (offset > 0 || bytes.length > end + 1)) bytes = bytes.slice(offset, end + 1);
    }
  } catch (err) { bytes = null; why = String(err && err.message || err).slice(0, 200); }
  // ファイルを丸ごと読んで、要る部分を切り出す（遅いが許可は Drive だけで済む）
  if (!bytes) { via = 'whole'; bytes = file.getBlob().getBytes().slice(offset, end + 1); }
  return { ok: true, size: size, offset: offset, length: bytes.length, via: via, why: why, data: Utilities.base64Encode(bytes) };
}
