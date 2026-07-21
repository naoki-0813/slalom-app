// mock.js — PC開発用の疑似センサーデータ生成
// 公開オブジェクト: Mock
// 「スマホを縦置き・画面を運転者側に向けて固定し、少し傾いて取り付けた」状態を再現し、
// 本物と同じ入口(Sensors._injectMotion / _injectGps)にデータを流す。
// キャリブレーション・座標変換のテストが本物同様にできる。

const Mock = (() => {

  let enabled = false;      // モックモードON/OFF(設定画面またはURLの ?mock=1)
  let preset = 'expert';    // 'expert'=上手い走行 / 'wobble'=ばらつきの大きい走行
  let running = false;      // データ生成ループが動いているか
  let rafId = null;
  let intervalId = null;    // rAFが動かない環境(非表示タブ等)用のフォールバック
  let lastRafMs = 0;        // 最後にrAFが発火した時刻(rAF生存確認用)
  let lastMotionMs = 0;
  let lastGpsMs = 0;

  // 走行シナリオの状態: 'idle'(停車) → beginRun()で 'run'(走行プロファイル再生)
  let phase = 'idle';
  let runStartMs = 0;

  // ばらつき走行用: パイロンごとの振幅・位相の乱れ(beginRunのたびに引き直す)
  let wobbleAmp = [];
  let wobblePhase = [];

  // ---------- 取り付け姿勢(端末座標系と車両座標系の関係) ----------
  // 縦置き・画面を運転者側: 端末X=車両の右(-Y)、端末Y=車両の上(Z)、端末Z=車両の後ろ(-X)
  // さらに車両X軸まわりに6度傾けて「取り付けのズレ」を再現する。

  const TILT = 6 * Math.PI / 180;

  // 車両座標系の基本軸を端末側から見た向き(傾き込み)を作る
  function tiltX(v) { // 車両X軸まわりの回転
    const c = Math.cos(TILT), s = Math.sin(TILT);
    return [v[0], v[1] * c - v[2] * s, v[1] * s + v[2] * c];
  }
  // 端末の各軸を車両座標系で表したもの
  const AX_DEV_X = tiltX([0, -1, 0]);  // 端末X
  const AX_DEV_Y = tiltX([0, 0, 1]);   // 端末Y
  const AX_DEV_Z = tiltX([-1, 0, 0]);  // 端末Z

  // 車両座標系のベクトル → 端末座標系のベクトル
  function vehToDev(v) {
    const d = (a) => a[0] * v[0] + a[1] * v[1] + a[2] * v[2];
    return [d(AX_DEV_X), d(AX_DEV_Y), d(AX_DEV_Z)];
  }

  // ---------- 走行プロファイル(車両座標系で生成) ----------
  // 0〜4秒: 加速(0→40km/h) / 4〜24秒: スラローム(パイロン5本) / 24〜28秒: 減速 / 以降: 停車

  const ACCEL_END = 4, SLALOM_END = 24, DECEL_END = 28;
  const TOP_SPEED = 11.1;            // 40km/h [m/s]
  const PYLON_PERIOD = 4;            // パイロン1本あたりの秒数
  const LAT_G_AMP = 0.4 * 9.81;      // 横G振幅 ±0.4G [m/s²]
  const YAW_AMP = 25;                // ヨーレート振幅 [deg/s]

  // 正規分布っぽいノイズ(-1〜1を数回足して平均)
  function noise(scale) {
    return (Math.random() + Math.random() + Math.random() - 1.5) / 1.5 * scale;
  }

  // 走行開始からt秒時点の速度 [m/s]
  function speedAt(t) {
    if (phase !== 'run' || t < 0) return 0;
    if (t < ACCEL_END) return TOP_SPEED * t / ACCEL_END;
    if (t < SLALOM_END) return TOP_SPEED;
    if (t < DECEL_END) return TOP_SPEED * (1 - (t - SLALOM_END) / (DECEL_END - SLALOM_END));
    return 0;
  }

  // 走行開始からt秒時点の車両座標系の加速度・角速度を返す
  function motionAt(t) {
    let ax = 0, ay = 0, yaw = 0; // 前後加速度, 横加速度, ヨーレート

    if (phase === 'run' && t >= 0 && t < DECEL_END + 2) {
      if (t < ACCEL_END) ax = TOP_SPEED / ACCEL_END;
      else if (t >= SLALOM_END && t < DECEL_END) ax = -TOP_SPEED / (DECEL_END - SLALOM_END);

      if (t >= ACCEL_END && t < SLALOM_END) {
        const ts = t - ACCEL_END;
        const cycle = Math.min(4, Math.floor(ts / PYLON_PERIOD)); // 何本目のパイロンか
        const amp = LAT_G_AMP * wobbleAmp[cycle];
        const ph = wobblePhase[cycle];
        ay = amp * Math.sin(2 * Math.PI * ts / PYLON_PERIOD + ph);
        yaw = YAW_AMP * wobbleAmp[cycle] * Math.cos(2 * Math.PI * ts / PYLON_PERIOD + ph);
      }
    }

    // 小さなノイズを常時のせる(実機らしさ+キャリブレーションの平均処理テスト)
    ax += noise(0.15); ay += noise(0.15);
    const az = noise(0.15);
    return { acc: [ax, ay, az], yaw: yaw + noise(0.5) };
  }

  // ---------- データ生成ループ ----------

  // 1回分のデータ生成。呼び出し間隔が揺れても実測時刻ベースなので問題ない
  function tick() {
    if (!running) return;
    const now = performance.now();

    // devicemotion相当: 約60Hz(requestAnimationFrame駆動)
    if (now - lastMotionMs >= 15) {
      lastMotionMs = now;
      const t = (now - runStartMs) / 1000;
      const m = motionAt(t);

      const accVehDev = vehToDev(m.acc);                       // 重力なし加速度(端末系)
      const gDev = vehToDev([0, 0, 9.81]);                     // 重力(端末系)
      const accGDev = [accVehDev[0] + gDev[0], accVehDev[1] + gDev[1], accVehDev[2] + gDev[2]];
      const rotDev = vehToDev([0, 0, m.yaw]);                  // 角速度(端末系, deg/s)

      Sensors._injectMotion({
        tMs: now,
        acc: accVehDev,
        accG: accGDev,
        // rotationRate形式 {alpha:Z, beta:X, gamma:Y} の並びで渡す
        rot: [rotDev[2], rotDev[0], rotDev[1]]
      });
    }

    // GPS相当: 約1Hz
    if (now - lastGpsMs >= 1000) {
      lastGpsMs = now;
      const t = (now - runStartMs) / 1000;
      Sensors._injectGps({
        tMs: now,
        lat: 35.68123 + t * 0.00001,   // それらしく少しずつ移動させる
        lon: 139.76712 + t * 0.00001,
        speedMps: Math.max(0, speedAt(t) + noise(0.2)),
        accuracyM: 4 + Math.random() * 3
      });
    }
  }

  // requestAnimationFrame駆動のループ(画面が描画されている間はこちらが動く)
  function rafLoop() {
    if (!running) return;
    lastRafMs = performance.now();
    tick();
    rafId = requestAnimationFrame(rafLoop);
  }

  // モックのデータ生成を開始する(停車状態から)
  function start() {
    if (running) return;
    running = true;
    phase = 'idle';
    lastMotionMs = 0; lastGpsMs = 0;
    lastRafMs = performance.now();
    runStartMs = performance.now();
    rafId = requestAnimationFrame(rafLoop);
    // rAFが300ms以上発火していなければ死んでいる(非表示タブ等)と判断し、
    // setInterval側からtick()を駆動する(生成は実測時刻ベースなので精度は同じ)
    intervalId = setInterval(() => {
      if (running && performance.now() - lastRafMs > 300) tick();
    }, 16);
  }

  function stop() {
    running = false;
    if (rafId) cancelAnimationFrame(rafId);
    if (intervalId) clearInterval(intervalId);
    rafId = null;
    intervalId = null;
    phase = 'idle';
  }

  // 記録開始の合図(Recorderが呼ぶ)。走行プロファイルの再生を始める
  function beginRun() {
    runStartMs = performance.now();
    phase = 'run';
    // パイロンごとの乱れを引き直す
    wobbleAmp = []; wobblePhase = [];
    for (let i = 0; i < 5; i++) {
      if (preset === 'wobble') {
        wobbleAmp.push(1 + (Math.random() - 0.5) * 0.6);   // 振幅±30%
        wobblePhase.push((Math.random() - 0.5) * 0.8);     // 位相の乱れ
      } else {
        wobbleAmp.push(1 + (Math.random() - 0.5) * 0.06);  // 上手い走行はほぼ一定
        wobblePhase.push((Math.random() - 0.5) * 0.06);
      }
    }
  }

  return {
    get enabled() { return enabled; },
    set enabled(v) { enabled = v; if (!v) stop(); },
    get preset() { return preset; },
    set preset(v) { preset = v; },
    start, stop, beginRun
  };
})();
