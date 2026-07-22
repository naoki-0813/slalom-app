// recorder.js — 記録セッション管理(カウントダウン開始・センサー記録・自動停止)と動画録画
// 公開オブジェクト: Recorder

const Recorder = (() => {

  let recording = false;
  let t0 = 0;                 // 記録開始時刻(performance.now()基準)
  let samples = [];           // 車両座標系のセンサーサンプル
  let gpsPoints = [];         // GPSサンプル
  let latestLatG = 0;         // 画面表示用の最新横G

  // 自動停止用の状態
  let autoStop = true;
  let hasMoved = false;       // 一度でも速度>1.4m/s(5km/h)を超えたか
  let lowSpeedSinceMs = null; // 速度<0.56m/s(2km/h)が続き始めた時刻
  let startDetectMs = null;   // 発進検知時刻(区間タイム用)
  let stopDetectMs = null;    // 停止検知時刻

  const SPEED_START = 1.4;    // 発進判定 5km/h [m/s]
  const SPEED_STOP = 0.56;    // 停止判定 2km/h [m/s]
  const STOP_HOLD_MS = 3000;  // 停止判定の継続時間

  let onFinished = null;      // 記録完了時のコールバック(app.jsが設定)

  // 動画録画用の状態
  let cameraStream = null;    // カメラ映像(getUserMedia)
  let mediaRecorder = null;
  let videoChunks = [];
  let videoMime = null;
  let videoStartMs = null;    // MediaRecorder.start()直後の時刻(センサーと同じperformance.now()基準)

  // ---------- カメラ(プレビュー・録画元) ----------

  // カメラを起動してプレビュー用video要素に映す。qualityHeightは720または480
  async function initCamera(videoEl, qualityHeight) {
    stopCamera();
    const is480 = String(qualityHeight) === '480';
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'environment' },   // 背面カメラ優先
        width: { ideal: is480 ? 854 : 1280 },
        height: { ideal: is480 ? 480 : 720 },
        frameRate: { ideal: 30 }
      },
      audio: false                              // 音声は記録しない(プライバシーと容量のため)
    });
    videoEl.srcObject = cameraStream;
    videoEl.muted = true;
    videoEl.playsInline = true;
    await videoEl.play();
  }

  // カメラを停止する(画面を離れるとき・記録完了後)
  function stopCamera() {
    if (cameraStream) {
      cameraStream.getTracks().forEach(t => t.stop());
      cameraStream = null;
    }
  }

  // ---------- ビープ音(Web Audio API。音声ファイル不要) ----------

  let audioCtx = null;

  // 指定の高さ・長さのビープ音を鳴らす
  function beep(freqHz, durationMs) {
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.frequency.value = freqHz;
      gain.gain.value = 0.3;
      osc.connect(gain).connect(audioCtx.destination);
      osc.start();
      osc.stop(audioCtx.currentTime + durationMs / 1000);
    } catch (_) { /* 音が出なくても記録は続ける */ }
  }

  // ---------- センサーデータの受け取り ----------

  // 記録中に1サンプルごとに呼ばれる
  function onMotion(sample) {
    if (!recording || !sample.accVeh) return;
    const a = sample.accVeh;
    const r = sample.rotVeh || [0, 0, 0];
    samples.push({
      tMs: sample.tMs - t0,
      ax: a[0], ay: a[1], az: a[2],   // 車両座標系 [m/s²] X:前後 Y:左右 Z:上下
      gx: r[0], gy: r[1], gz: r[2]    // 車両座標系 [deg/s] gz:ヨーレート
    });
    latestLatG = a[1] / 9.81;
  }

  // 記録中にGPS更新ごとに呼ばれる(自動停止の判定もここで行う)
  function onGps(gp) {
    if (!recording) return;

    // 精度20m超のサンプルは速度判定に使わない(記録はする)
    const speedOk = gp.accuracyM <= 20 && gp.speedMps !== null;

    gpsPoints.push({
      tMs: gp.tMs - t0,
      lat: gp.lat, lon: gp.lon,
      speedMps: gp.speedMps, accuracyM: gp.accuracyM
    });

    if (!speedOk) return;
    const v = gp.speedMps;

    // 発進検知
    if (!hasMoved && v > SPEED_START) {
      hasMoved = true;
      startDetectMs = gp.tMs - t0;
    }

    // 自動停止: 発進後に低速が3秒続いたら終了
    if (autoStop && hasMoved) {
      if (v < SPEED_STOP) {
        if (lowSpeedSinceMs === null) lowSpeedSinceMs = gp.tMs;
        if (gp.tMs - lowSpeedSinceMs >= STOP_HOLD_MS) {
          stopDetectMs = lowSpeedSinceMs - t0; // 停止し始めた時刻を区間終了とする
          stop();
        }
      } else {
        lowSpeedSinceMs = null;
      }
    }
  }

  // ---------- カウントダウンと開始・停止 ----------

  // 5秒カウントダウン後に記録を開始する。onTick(残り秒数)で画面表示を更新
  function startWithCountdown(onTick, onStart) {
    let remain = 5;
    Sensors.startListening(); // カウントダウン中からセンサーを温めておく
    onTick(remain);
    beep(880, 150);
    const timer = setInterval(() => {
      remain--;
      if (remain > 0) {
        onTick(remain);
        beep(880, 150);
      } else {
        clearInterval(timer);
        beep(1760, 500); // 開始の合図は高い長音
        begin();
        onStart();
      }
    }, 1000);
  }

  // 記録を実際に開始する
  function begin() {
    t0 = performance.now();
    samples = [];
    gpsPoints = [];
    latestLatG = 0;
    hasMoved = false;
    lowSpeedSinceMs = null;
    startDetectMs = null;
    stopDetectMs = null;
    recording = true;

    Sensors.acquireWakeLock();          // 画面消灯防止
    Sensors.subscribeMotion(onMotion);
    Sensors.subscribeGps(onGps);
    Sensors.startGps();

    if (typeof Mock !== 'undefined' && Mock.enabled) Mock.beginRun();

    // 動画録画の開始(カメラが使えないときはセンサーのみで続行)
    videoChunks = [];
    videoMime = null;
    videoStartMs = null;
    if (cameraStream && typeof MediaRecorder !== 'undefined') {
      try {
        videoMime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
          .find(m => MediaRecorder.isTypeSupported(m));
        mediaRecorder = new MediaRecorder(cameraStream, {
          mimeType: videoMime, videoBitsPerSecond: 2500000
        });
        mediaRecorder.ondataavailable = e => { if (e.data.size) videoChunks.push(e.data); };
        mediaRecorder.start(1000);   // 1秒ごとにチャンク化(途中クラッシュ対策)
        videoStartMs = performance.now();  // センサーと同じ時刻基準で同期用に記録
      } catch (e) {
        console.warn('動画録画を開始できませんでした:', e.message);
        mediaRecorder = null;
      }
    }
  }

  // 記録を停止し、走行データを組み立てて保存へ渡す
  async function stop() {
    if (!recording) return;
    recording = false;

    Sensors.unsubscribeMotion(onMotion);
    Sensors.unsubscribeGps(onGps);
    Sensors.stopGps();
    Sensors.releaseWakeLock();
    Sensors.stopListening();
    beep(440, 300);

    // 動画録画を止め、Blob(動画データのかたまり)を受け取る
    let videoBlob = null;
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      videoBlob = await new Promise(resolve => {
        mediaRecorder.onstop = () => resolve(new Blob(videoChunks, { type: videoMime }));
        mediaRecorder.stop();
      });
      mediaRecorder = null;
    }

    const now = new Date();

    // 計測区間 = 最初の切り返し〜最後の切り返し(横G+ヨーレートから自動検出)。
    // 検出できなければGPSの発進/停止検知にフォールバック
    const det = Analysis.detectSection(samples);

    const run = {
      name: `走行 ${now.getMonth() + 1}/${now.getDate()} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
      driver: '',
      isExpert: false,
      createdAt: now.toISOString(),
      calib: Sensors.calib,
      samples,
      gps: gpsPoints,
      sectionStartMs: det ? det.startMs : startDetectMs,
      sectionEndMs: det ? det.endMs : stopDetectMs,
      metrics: {},
      // 動画とセンサーの同期用: 動画の0秒 = 記録開始からvideoStartOffsetMs後
      videoStartOffsetMs: videoStartMs !== null ? videoStartMs - t0 : null
    };
    run.metrics = Analysis.computeMetrics(run);

    const id = await Storage2.saveRun(run);
    run.id = id;

    // 動画を保存(空き容量が動画サイズの2倍未満なら警告してから保存)
    if (videoBlob && videoBlob.size > 0) {
      try {
        if (navigator.storage && navigator.storage.estimate) {
          const est = await navigator.storage.estimate();
          if (est.quota - est.usage < videoBlob.size * 2) {
            alert('端末の保存領域の空きが少なくなっています。走行一覧から古い動画を削除することをおすすめします。');
          }
        }
        await Storage2.saveVideo({ runId: id, blob: videoBlob, mime: videoMime });
      } catch (e) {
        alert('動画の保存に失敗しました(センサーデータは保存済みです): ' + e.message);
      }
    }

    if (onFinished) onFinished(run);
  }

  return {
    startWithCountdown, stop,
    initCamera, stopCamera,
    get recording() { return recording; },
    get elapsedMs() { return recording ? performance.now() - t0 : 0; },
    get latestLatG() { return latestLatG; },
    get sampleCount() { return samples.length; },
    set autoStop(v) { autoStop = v; },
    set onFinished(fn) { onFinished = fn; }
  };
})();
