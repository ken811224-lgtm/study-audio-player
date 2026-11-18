/**
 * 学習音声プレーヤー ⇔ Google スプレッドシート 同期用 GAS
 *
 * 使い方：記録用のスプレッドシートを開き「拡張機能 → Apps Script」にこのコードを貼る
 *         → 「デプロイ → 新しいデプロイ → ウェブアプリ」（実行するユーザー：自分／アクセス：全員）
 *         → 出てきた URL（…/exec）をアプリの設定に入れる
 *
 * シート（無ければ自動で作る）
 *   再生ログ   … アプリから届いた 1 件ずつの記録を下へ足していく
 *   単元マスタ … 科目＋ファイル名ごとに最新の周回数・累積時間・最終聴取日・理解度へ上書き
 *   日別       … 日ごとの実聴取時間・講義時間（アプリの数字で上書き）
 */

// 合言葉。空のままなら誰でも送れる（URL を知っている人だけ）。入れたらアプリの設定にも同じものを入れる
var SECRET = '';

var LOG_SHEET = '再生ログ';
var MASTER_SHEET = '単元マスタ';
var DAILY_SHEET = '日別';
var LOG_HEAD = ['ログID', '日時', '科目', '番号', 'ファイル名', 'できごと', '聴取(秒)', '講義時間(秒)', '周回数', '理解度', '受信日時'];
var MASTER_HEAD = ['科目', '番号', 'ファイル名', '周回数', '累積実時間(分)', '累積講義時間(分)', '最終聴取日', '理解度', '更新日時'];
var DAILY_HEAD = ['日付', '実聴取(分)', '講義時間(分)', '更新日時'];
var EVENT_NAME = {
  pause: '一時停止', ended: '最後まで', complete: '周回 +1', 'switch': '曲を変えた', stop: '停止',
  listening: '聴取中', close: '閉じた', status: '理解度を変えた', 'manual+1': '手で +1', 'manual-1': '手で -1'
};

function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (SECRET && body.secret !== SECRET) return json_({ ok: false, error: '合言葉が違います' });
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var added = appendLogs_(ss, body.logs || []);
    updateMaster_(ss, body.logs || []);
    updateDaily_(ss, body.daily || {});
    return json_({ ok: true, added: added });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  } finally {
    try { lock.releaseLock(); } catch (x) { /* 無視 */ }
  }
}

// ブラウザで URL を開いたときの確認用
function doGet() {
  return json_({ ok: true, message: '学習音声プレーヤーの受け口は動いています' });
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function sheet_(ss, name, head) {
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, head.length).setValues([head]).setFontWeight('bold').setBackground('#e8f5e9');
    sh.setFrozenRows(1);
  }
  return sh;
}

function toDate_(s) {
  if (!s) return '';
  var d = new Date(s);
  return isNaN(d.getTime()) ? '' : d;
}

function appendLogs_(ss, logs) {
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
      l.id, toDate_(l.timestamp), l.subject || '', l.no || '', l.fileName || '',
      EVENT_NAME[l.event] || l.event || '', Number(l.listenedSeconds) || 0, Number(l.lectureSeconds) || 0,
      Number(l.playCount) || 0, l.status || '', now
    ]);
  });
  if (rows.length) sh.getRange(last + 1, 1, rows.length, LOG_HEAD.length).setValues(rows);
  return rows.length;
}

function updateMaster_(ss, logs) {
  if (!logs.length) return;
  var sh = sheet_(ss, MASTER_SHEET, MASTER_HEAD);
  var last = sh.getLastRow();
  var data = last > 1 ? sh.getRange(2, 1, last - 1, MASTER_HEAD.length).getValues() : [];
  var index = {};
  data.forEach(function (r, i) { index[r[0] + '\t' + r[2]] = i; });

  // 同じ単元のログは、いちばん新しいものだけを使う
  var latest = {};
  logs.forEach(function (l) {
    if (!l || !l.fileName) return;
    var k = (l.subject || '') + '\t' + l.fileName;
    if (!latest[k] || String(l.timestamp) >= String(latest[k].timestamp)) latest[k] = l;
  });
  var now = new Date();
  Object.keys(latest).forEach(function (k) {
    var l = latest[k];
    var row = [
      l.subject || '', l.no || '', l.fileName,
      Number(l.playCount) || 0,
      Math.round((Number(l.totalListenedSeconds) || 0) / 6) / 10,
      Math.round((Number(l.totalLectureSeconds) || 0) / 6) / 10,
      toDate_(l.lastPlayedAt), l.status || '', now
    ];
    if (index[k] !== undefined) {
      data[index[k]] = row;   // アプリの累計値でそのまま上書き（足し算しないので、ずれない）
    } else {
      index[k] = data.length;
      data.push(row);
    }
  });
  data.sort(function (a, b) {
    if (a[0] !== b[0]) return String(a[0]) < String(b[0]) ? -1 : 1;
    return (Number(a[1]) || 0) - (Number(b[1]) || 0);
  });
  if (data.length) sh.getRange(2, 1, data.length, MASTER_HEAD.length).setValues(data);
}

function updateDaily_(ss, daily) {
  var keys = Object.keys(daily);
  if (!keys.length) return;
  var sh = sheet_(ss, DAILY_SHEET, DAILY_HEAD);
  var last = sh.getLastRow();
  var data = last > 1 ? sh.getRange(2, 1, last - 1, DAILY_HEAD.length).getValues() : [];
  var index = {};
  data.forEach(function (r, i) {
    var k = r[0] instanceof Date ? Utilities.formatDate(r[0], Session.getScriptTimeZone(), 'yyyy-MM-dd') : String(r[0]);
    r[0] = k;
    index[k] = i;
  });
  var now = new Date();
  keys.forEach(function (k) {
    var x = daily[k] || {};
    var row = [k, Math.round((Number(x.real) || 0) / 6) / 10, Math.round((Number(x.lecture) || 0) / 6) / 10, now];
    if (index[k] !== undefined) data[index[k]] = row;
    else { index[k] = data.length; data.push(row); }
  });
  data.sort(function (a, b) { return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0; });
  sh.getRange(2, 1, data.length, 1).setNumberFormat('@');   // 日付を文字のまま入れる
  sh.getRange(2, 1, data.length, DAILY_HEAD.length).setValues(data);
}
