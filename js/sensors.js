// sensors.js — センサー取得・キャリブレーション(傾き補正)・車両座標系への変換・Wake Lock・GPS
// 公開オブジェクト: Sensors
// 本物のセンサー(devicemotion / geolocation)とモック(mock.js)の両方から
// 同じ入口 _injectMotion / _injectGps にデータを流し込む設計。

const Sensors = (() => {

  // キャリブレーション結果 { R: 3x3回転行列, g: 重力ベクトル(端末座標系) }
  let calib = null;

  // データ購読者(記録中のRecorderなど)。sample単位で呼ばれる
  const motionSubscribers = new Set();
  const gpsSubscribers = new Set();

  let listening = false;      // devicemotionリスナー登録済みか
  let gpsWatchId = null;      // watchPositionのID
  let wakeLock = null;        // 画面消灯防止

  // 実測レート計算用
  let rateCount = 0;
  let rateStartMs = 0;
  let measuredRateHz = 0;

  // ---------- ベクトル・行列の小道具 ----------

  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function cross(a, b) {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  }
  function norm(a) { return Math.sqrt(dot(a, a)); }
  function normalize(a) { const n = norm(a) || 1; return [a[0] / n, a[1] / n, a[2] / n]; }

  // 端末座標系のベクトルを車両座標系(前後X・左右Y・上下Z)に変換する
  function toVehicle(v) {
    if (!calib) return v.slice();
    const R = calib.R;
    return [dot(R[0], v), dot(R[1], v), dot(R[2], v)];
  }

  // ---------- キャリブレーション ----------

  // 停車状態で seconds 秒間の重力ベクトルを平均し、回転行列Rを作る
  // 手順: 重力から「車両の下」を推定 → 端末-Z(画面の奥)を仮の前方向として直交化 → 外積で左右
  function calibrate(seconds = 3) {
    return new Promise((resolve, reject) => {
      const sum = [0, 0, 0];
      let count = 0;

      const collector = (sample) => {
        const g = sample.accG; // 重力込み加速度
        if (!g) return;
        sum[0] += g[0]; sum[1] += g[1]; sum[2] += g[2];
        count++;
      };
      motionSubscribers.add(collector);

      setTimeout(() => {
        motionSubscribers.delete(collector);
        if (count < 10) {
          reject(new Error('センサーデータが取得できませんでした。モックモードをONにするか、スマホ実機(HTTPS)でお試しください。'));
          return;
        }
        const gAvg = [sum[0] / count, sum[1] / count, sum[2] / count];

        // 停車中の重力込み加速度は「上向き」の反力を示すので、車両の上 = gAvgの向き
        const up = normalize(gAvg);

        // 仮の前方向: 縦置き想定で端末-Z(画面の奥)。重力とほぼ平行なら端末+Yを代わりに使う
        let fwd0 = [0, 0, -1];
        if (Math.abs(dot(fwd0, up)) > 0.9) fwd0 = [0, 1, 0];

        // グラム・シュミット法で up と直交化して前方向を確定
        const d = dot(fwd0, up);
        const fwd = normalize([fwd0[0] - d * up[0], fwd0[1] - d * up[1], fwd0[2] - d * up[2]]);

        // 左方向 = 上 × 前(右手系: X=前, Y=左, Z=上)
        const left = cross(up, fwd);

        // R の各行 = 車両の各軸を端末座標系で表したもの。veh = R * device
        calib = { R: [fwd, left, up], g: gAvg };
        resolve(calib);
      }, seconds * 1000);
    });
  }

  // ---------- センサーデータの入口(本物・モック共通) ----------

  // 1サンプル受け取り、車両座標系に変換して購読者に配る
  // raw = { tMs, acc:[x,y,z]|null, accG:[x,y,z], rot:[alpha,beta,gamma] } すべて端末座標系
  function _injectMotion(raw) {
    // 実測レートの計測(1秒ごとに更新)
    rateCount++;
    if (raw.tMs - rateStartMs >= 1000) {
      measuredRateHz = Math.round(rateCount * 1000 / (raw.tMs - rateStartMs));
      rateCount = 0;
      rateStartMs = raw.tMs;
    }

    // acceleration が null の端末向けフォールバック: 重力込み − キャリブレーションの重力
    let acc = raw.acc;
    if (!acc && raw.accG && calib) {
      acc = [raw.accG[0] - calib.g[0], raw.accG[1] - calib.g[1], raw.accG[2] - calib.g[2]];
    }

    const sample = {
      tMs: raw.tMs,
      accG: raw.accG,
      accDevice: acc,
      rotDevice: raw.rot,
      // 車両座標系(キャリブレーション前は生値のまま入るので、記録には使わないこと)
      accVeh: acc ? toVehicle(acc) : null,
      // rotationRate {alpha:Z軸, beta:X軸, gamma:Y軸} → 端末系の角速度ベクトル (X,Y,Z) に並べ替え
      rotVeh: raw.rot ? toVehicle([raw.rot[1], raw.rot[2], raw.rot[0]]) : null
    };
    motionSubscribers.forEach(fn => fn(sample));
  }

  // GPSの入口。gp = { tMs, lat, lon, speedMps|null, accuracyM }
  function _injectGps(gp) {
    gpsSubscribers.forEach(fn => fn(gp));
  }

  // ---------- 本物のセンサーの開始・停止 ----------

  function onDeviceMotion(e) {
    const a = e.acceleration;
    const ag = e.accelerationIncludingGravity;
    const r = e.rotationRate;
    _injectMotion({
      tMs: performance.now(),
      acc: (a && a.x !== null) ? [a.x, a.y, a.z] : null,
      accG: (ag && ag.x !== null) ? [ag.x, ag.y, ag.z] : null,
      rot: (r && r.alpha !== null) ? [r.alpha, r.beta, r.gamma] : [0, 0, 0]
    });
  }

  // センサーの購読を開始する(モックONならモックを起動)
  async function startListening() {
    if (listening) return;
    listening = true;
    rateCount = 0; rateStartMs = performance.now();

    if (typeof Mock !== 'undefined' && Mock.enabled) {
      Mock.start();
      return;
    }
    // iOSでは許可が必要(将来対応のため存在チェックだけしておく)
    if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
      try { await DeviceMotionEvent.requestPermission(); } catch (_) { /* 拒否時は下で気づける */ }
    }
    window.addEventListener('devicemotion', onDeviceMotion);
  }

  function stopListening() {
    listening = false;
    window.removeEventListener('devicemotion', onDeviceMotion);
    if (typeof Mock !== 'undefined') Mock.stop();
  }

  // GPSの購読を開始する(モックONならモック側が流す)。二重起動は無視
  function startGps() {
    if (typeof Mock !== 'undefined' && Mock.enabled) return;
    if (!navigator.geolocation) return;
    if (gpsWatchId !== null) return;
    gpsWatchId = navigator.geolocation.watchPosition(
      (pos) => {
        _injectGps({
          tMs: performance.now(),
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          speedMps: pos.coords.speed,       // nullの場合あり
          accuracyM: pos.coords.accuracy
        });
      },
      (err) => { console.warn('GPSエラー:', err.message); },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 }
    );
  }

  function stopGps() {
    if (gpsWatchId !== null) {
      navigator.geolocation.clearWatch(gpsWatchId);
      gpsWatchId = null;
    }
  }

  // ---------- Wake Lock(画面消灯防止) ----------

  async function acquireWakeLock() {
    try {
      if ('wakeLock' in navigator) {
        wakeLock = await navigator.wakeLock.request('screen');
      }
    } catch (_) { /* 非対応・失敗しても記録は続ける */ }
  }

  function releaseWakeLock() {
    if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  }

  // 画面がバックグラウンドから戻ったときにWake Lockを取り直す
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && wakeLock !== null) {
      acquireWakeLock();
    }
  });

  // ---------- 公開 ----------

  return {
    calibrate,
    get calib() { return calib; },
    get isCalibrated() { return calib !== null; },
    get measuredRateHz() { return measuredRateHz; },
    startListening, stopListening,
    startGps, stopGps,
    acquireWakeLock, releaseWakeLock,
    subscribeMotion: fn => motionSubscribers.add(fn),
    unsubscribeMotion: fn => motionSubscribers.delete(fn),
    subscribeGps: fn => gpsSubscribers.add(fn),
    unsubscribeGps: fn => gpsSubscribers.delete(fn),
    _injectMotion, _injectGps
  };
})();
