// storage.js — IndexedDB(ブラウザ内データベース)への保存と、CSV生成・ファイルダウンロード
// 公開オブジェクト: Storage2(ブラウザ標準の Storage と名前が衝突するため 2 を付けている)

const Storage2 = (() => {

  const DB_NAME = 'pylon-slalom';
  const DB_VERSION = 1;
  const APP_VERSION = '1.0';
  let dbPromise = null;

  // DBを開く(初回はオブジェクトストアを作成する)
  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        // runs: メタ情報+センサーデータ(idは自動採番)
        if (!db.objectStoreNames.contains('runs')) {
          db.createObjectStore('runs', { keyPath: 'id', autoIncrement: true });
        }
        // videos: 動画Blobのみ分離(一覧表示を軽くするため)
        if (!db.objectStoreNames.contains('videos')) {
          db.createObjectStore('videos', { keyPath: 'runId' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  // トランザクションをPromiseで包む共通処理
  async function tx(storeName, mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction(storeName, mode);
      const store = t.objectStore(storeName);
      const req = fn(store);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  // 走行を保存する(新規はidが自動で付く。戻り値はid)
  function saveRun(run) { return tx('runs', 'readwrite', s => s.put(run)); }

  // 走行を1件取得する
  function getRun(id) { return tx('runs', 'readonly', s => s.get(id)); }

  // 走行を全件取得する(新しい順に並べ替えて返す)
  async function getAllRuns() {
    const runs = await tx('runs', 'readonly', s => s.getAll());
    runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return runs;
  }

  // 走行を削除する(動画があれば一緒に消す)
  async function deleteRun(id) {
    await tx('runs', 'readwrite', s => s.delete(id));
    await tx('videos', 'readwrite', s => s.delete(id));
  }

  // 動画を保存する({runId, blob, mime})
  function saveVideo(video) { return tx('videos', 'readwrite', s => s.put(video)); }

  // 動画を1件取得する(なければundefined)
  function getVideo(runId) { return tx('videos', 'readonly', s => s.get(runId)); }

  // 動画だけ削除する(センサーデータは残す。容量確保用)
  function deleteVideo(runId) { return tx('videos', 'readwrite', s => s.delete(runId)); }

  // 動画が存在する走行IDの一覧を返す(一覧画面でBlob本体を読み込まないため)
  async function getVideoKeys() {
    const keys = await tx('videos', 'readonly', s => s.getAllKeys());
    return new Set(keys);
  }

  // 全データを削除する
  async function wipeAll() {
    await tx('runs', 'readwrite', s => s.clear());
    await tx('videos', 'readwrite', s => s.clear());
  }

  // ストレージ使用量の文字列を返す(例: 「12.3MB / 2.0GB 使用中」)
  async function usageText() {
    if (!navigator.storage || !navigator.storage.estimate) return '';
    const est = await navigator.storage.estimate();
    const mb = n => (n / 1024 / 1024).toFixed(1);
    return `ストレージ使用量: ${mb(est.usage)} MB / 空き目安 ${mb(est.quota - est.usage)} MB`;
  }

  // ブラウザによる自動削除を抑制するようお願いする(初回に1度呼ぶ)
  function requestPersist() {
    if (navigator.storage && navigator.storage.persist) {
      navigator.storage.persist().catch(() => {});
    }
  }

  // ---------- CSV生成 ----------

  // 数値を小数4桁に丸めて文字列にする(null/undefinedは空文字)
  function num(v) {
    return (v === null || v === undefined || Number.isNaN(v)) ? '' : v.toFixed(4);
  }

  // 走行データからCSV文字列を作る(仕様書 §3.4 の列順を厳守)
  function buildCsv(run) {
    const lines = [];
    // 先頭コメント行: 走行メタ情報
    lines.push(`# app_version=${APP_VERSION}`);
    lines.push(`# run_name=${run.name}, driver=${run.driver || ''}, is_expert=${!!run.isExpert}`);
    lines.push(`# created_at=${run.createdAt}`);
    if (run.calib) {
      lines.push(`# calib_R=${JSON.stringify(run.calib.R)}, calib_g=${JSON.stringify(run.calib.g.map(x => +x.toFixed(4)))}`);
    }
    lines.push('t_ms,ax_veh,ay_veh,az_veh,gx,gy,gz,yaw_rate,speed_mps,lat,lon,gps_accuracy_m');

    // GPS(約1Hz)を「最も近いt_msのセンサー行」に対応付ける
    // gpsRowMap[サンプル番号] = GPSサンプル
    const gpsRowMap = new Map();
    const samples = run.samples;
    for (const gp of (run.gps || [])) {
      // 二分探索でも良いが、数千件なので単純に最近傍を探す(先頭から走査すると遅いので目安から探す)
      let best = 0, bestDiff = Infinity;
      for (let i = 0; i < samples.length; i++) {
        const d = Math.abs(samples[i].tMs - gp.tMs);
        if (d < bestDiff) { bestDiff = d; best = i; }
        else if (samples[i].tMs > gp.tMs) break; // t_msは昇順なので通り過ぎたら終了
      }
      gpsRowMap.set(best, gp);
    }

    // 速度は「最後に得たGPS速度」を全行に引き継ぐ(仕様書のCSV例と同じ挙動)
    let lastSpeed = 0;
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      const gp = gpsRowMap.get(i);
      if (gp && gp.speedMps !== null) lastSpeed = gp.speedMps;
      const row = [
        Math.round(s.tMs),
        num(s.ax), num(s.ay), num(s.az),
        num(s.gx), num(s.gy), num(s.gz),
        num(s.gz),                    // yaw_rate = 車両Z軸まわりの角速度
        num(lastSpeed),
        gp ? num(gp.lat) : '',
        gp ? num(gp.lon) : '',
        gp ? num(gp.accuracyM) : ''
      ];
      lines.push(row.join(','));
    }
    return lines.join('\n') + '\n';
  }

  // ファイル名に使えない文字と空白を _ に置換する
  function sanitizeFilename(name) {
    return (name || 'run').replace(/[\/\\:*?"<>|\s]/g, '_');
  }

  // 日時を YYYYMMDD-HHMMSS 形式にする(端末ローカル時刻)
  function timestampForFile(isoString) {
    const d = new Date(isoString);
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  }

  // Blobをファイルとしてダウンロードさせる
  function download(blob, filename) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }

  // 走行のCSVをダウンロードする
  function downloadCsv(run) {
    const csv = buildCsv(run);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const filename = `run_${sanitizeFilename(run.name)}_${timestampForFile(run.createdAt)}.csv`;
    download(blob, filename);
  }

  // 走行の動画(.webm)をダウンロードする
  function downloadVideo(run, blob) {
    const filename = `run_${sanitizeFilename(run.name)}_${timestampForFile(run.createdAt)}.webm`;
    download(blob, filename);
  }

  return {
    open, saveRun, getRun, getAllRuns, deleteRun, wipeAll,
    saveVideo, getVideo, deleteVideo, getVideoKeys,
    usageText, requestPersist, buildCsv, downloadCsv, downloadVideo, download,
    APP_VERSION
  };
})();
