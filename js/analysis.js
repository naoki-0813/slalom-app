// analysis.js — メトリクス計算・計測区間の自動検出・速度推定
// 公開オブジェクト: Analysis
// すべて純関数(入力配列 → 出力値)で書き、DOMには依存させない。
// 単位: 内部計算は m/s²・deg/s・m/s、表示用の変換(G・km/h)は呼び出し側で行う。

const Analysis = (() => {

  // ---- 調整対象の定数(実走データ収集後にユーザーと見直す) ----
  const AY_ACT_TH = 1.5;     // 操舵判定の横加速度しきい値 [m/s²](約0.15G)調整対象
  const GZ_ACT_TH = 8;       // 操舵判定のヨーレートしきい値 [deg/s] 調整対象
  const ACT_ON = 1.0;        // アクティビティがこの値を超えたら「操舵中」
  const ACT_OFF = 0.3;       // 区間端をここまで広げる(切り返しの立ち上がりを含める)
  const SUSTAIN_S = 0.3;     // 誤検知防止: 操舵中がこの秒数続いて初めて有効
  const SMOOTH_K = 8.0;      // スムーズネスの減衰定数 [m/s³] 調整対象(初期値は仮)
  const SPEED_CV_K = 800;    // 速度一定性: score = 100 - CV×800 調整対象
  const GPS_BLEND = 0.5;     // 速度の相補フィルタ係数(GPS更新時の引き戻し量)調整対象
  const YAW_DEADBAND = 3;    // 切り返しカウントのデッドバンド [deg/s]

  // ---------- 共通ヘルパー ----------

  // サンプル配列から実測レート[Hz]を推定する(60Hz固定と仮定しない)
  function estimateRateHz(samples) {
    if (samples.length < 2) return 60;
    const spanS = (samples[samples.length - 1].tMs - samples[0].tMs) / 1000;
    return spanS > 0 ? samples.length / spanS : 60;
  }

  // 移動平均(窓は前後対称)。ノイズを均して判定・微分を安定させる
  function movingAvg(values, windowSamples) {
    const half = Math.max(1, Math.floor(windowSamples / 2));
    const out = new Array(values.length);
    let sum = 0;
    // 累積和方式で O(n)
    const cum = new Array(values.length + 1);
    cum[0] = 0;
    for (let i = 0; i < values.length; i++) cum[i + 1] = cum[i] + values[i];
    for (let i = 0; i < values.length; i++) {
      const a = Math.max(0, i - half);
      const b = Math.min(values.length, i + half + 1);
      out[i] = (cum[b] - cum[a]) / (b - a);
    }
    return out;
  }

  function mean(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }
  function std(arr) {
    if (arr.length < 2) return 0;
    const m = mean(arr);
    return Math.sqrt(arr.reduce((a, b) => a + (b - m) * (b - m), 0) / arr.length);
  }

  // 分位点(0〜1)。配列はソート済みであること
  function quantileSorted(sorted, q) {
    if (!sorted.length) return 0;
    const pos = (sorted.length - 1) * q;
    const lo = Math.floor(pos), hi = Math.ceil(pos);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  }

  // ---------- 計測区間の自動検出 ----------
  // スタート前は「一定速の直進」なので、横G・ヨーレートともほぼゼロ。
  // 両者を組み合わせた操舵アクティビティが最初に立ち上がった所を計測開始、
  // 最後に収まった所を計測終了とする(加速度とジャイロの両方を使い誤検知に強くする)。

  function detectSection(samples) {
    if (samples.length < 20) return null;
    const rate = estimateRateHz(samples);
    const win = Math.max(3, Math.round(0.1 * rate)); // 約100msの平滑化窓

    const aySm = movingAvg(samples.map(s => s.ay), win);
    const gzSm = movingAvg(samples.map(s => s.gz), win);

    // アクティビティ = 横Gとヨーレートをしきい値で正規化して合算
    const act = aySm.map((ay, i) => Math.abs(ay) / AY_ACT_TH + Math.abs(gzSm[i]) / GZ_ACT_TH);

    // 「ACT_ON超えがSUSTAIN_S秒続く」最初の位置と最後の位置を探す
    const need = Math.max(2, Math.round(SUSTAIN_S * rate));
    let first = -1, last = -1, runLen = 0;
    for (let i = 0; i < act.length; i++) {
      runLen = act[i] > ACT_ON ? runLen + 1 : 0;
      if (runLen >= need) {
        if (first === -1) first = i - need + 1;
        last = i;
      }
    }
    if (first === -1) return null;

    // 区間端を広げる: 切り返しの立ち上がり(ACT_OFFまで)を含める
    let start = first;
    while (start > 0 && act[start - 1] > ACT_OFF) start--;
    let end = last;
    while (end < act.length - 1 && act[end + 1] > ACT_OFF) end++;

    return { startMs: samples[start].tMs, endMs: samples[end].tMs };
  }

  // ---------- 速度推定(前後加速度の積分 + GPSで補正) ----------
  // GPSは約1Hzしかないため、60Hz級の速度が必要な分析(一定性・分布)には
  // 前後加速度axを積分し、GPS更新のたびに相補フィルタで引き戻した推定速度を使う。
  // 戻り値はsamplesと同じ長さの配列 [m/s]

  function fusedSpeed(samples, gps) {
    const v = new Array(samples.length);
    let vi = 0, gi = 0, prevT = samples.length ? samples[0].tMs : 0;
    const gpsArr = gps || [];
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      vi += s.ax * (s.tMs - prevT) / 1000;   // 前後加速度の積分
      prevT = s.tMs;
      // このサンプル時刻までに届いたGPS速度で補正(精度20m超は使わない)
      while (gi < gpsArr.length && gpsArr[gi].tMs <= s.tMs) {
        const gp = gpsArr[gi++];
        if (gp.speedMps !== null && gp.speedMps !== undefined && gp.accuracyM <= 20) {
          vi += GPS_BLEND * (gp.speedMps - vi);
        }
      }
      if (vi < 0) vi = 0;
      v[i] = vi;
    }
    return v;
  }

  // ---------- 単走メトリクス ----------
  // run.sectionStartMs/EndMs(計測区間)が入っていればその範囲で、なければ全体で計算する

  function computeMetrics(run) {
    const samples = run.samples;
    if (!samples.length) return {};
    const rate = estimateRateHz(samples);
    const win = Math.max(3, Math.round(0.1 * rate));

    // 計測区間のインデックス範囲
    const s0 = run.sectionStartMs, s1 = run.sectionEndMs;
    const inSection = (t) => (s0 === null || s0 === undefined || t >= s0) &&
                             (s1 === null || s1 === undefined || t <= s1);
    const idx = [];
    for (let i = 0; i < samples.length; i++) if (inSection(samples[i].tMs)) idx.push(i);
    if (idx.length < 10) return { sectionTimeS: null };

    const aySm = movingAvg(samples.map(s => s.ay), win);
    const gzSm = movingAvg(samples.map(s => s.gz), win);
    const speed = fusedSpeed(samples, run.gps);

    // 区間タイム
    const sectionTimeS = (samples[idx[idx.length - 1]].tMs - samples[idx[0]].tMs) / 1000;

    // 最大横G(平滑化後)
    let maxLatMs2 = 0;
    for (const i of idx) maxLatMs2 = Math.max(maxLatMs2, Math.abs(aySm[i]));

    // 平均速度と速度一定性(変動係数CV = 標準偏差/平均。小さいほど一定)
    const vSec = idx.map(i => speed[i]);
    const vMean = mean(vSec);
    const cv = vMean > 0.5 ? std(vSec) / vMean : 1; // ほぼ停止中はスコア無効扱い
    const speedConstancy = Math.max(0, Math.round(100 - cv * SPEED_CV_K));

    // スムーズネス: 横Gのジャーク(時間微分)のRMS。中央差分±50msで微分ノイズを抑える
    const k = Math.max(1, Math.round(0.05 * rate));
    const jerks = [];
    for (let j = k; j < idx.length - k; j++) {
      const i = idx[j];
      const dtS = (samples[Math.min(i + k, samples.length - 1)].tMs - samples[Math.max(i - k, 0)].tMs) / 1000;
      if (dtS > 0) jerks.push((aySm[Math.min(i + k, samples.length - 1)] - aySm[Math.max(i - k, 0)]) / dtS);
    }
    const jerkRms = Math.sqrt(mean(jerks.map(x => x * x)));
    const smoothness = Math.round(100 * Math.exp(-jerkRms / SMOOTH_K));

    // 切り返し回数: ヨーレートの符号反転(±3deg/sのデッドバンドで誤カウント防止)
    let switchbacks = 0, sign = 0;
    for (const i of idx) {
      const g = gzSm[i];
      if (g > YAW_DEADBAND) { if (sign === -1) switchbacks++; sign = 1; }
      else if (g < -YAW_DEADBAND) { if (sign === 1) switchbacks++; sign = -1; }
    }

    return {
      sectionTimeS,
      maxLatG: maxLatMs2 / 9.81,
      avgSpeedKmh: vMean * 3.6,
      speedConstancy,
      speedCvPct: cv * 100,
      smoothness,
      jerkRms,
      switchbacks
    };
  }

  // ---------- 1秒ごとの速度分布(箱ひげ図用) ----------
  // 計測区間内の推定速度を1秒ビンに分け、各ビンの min/25%/中央値/75%/max を返す [km/h]

  function perSecondSpeedStats(run) {
    const samples = run.samples;
    if (!samples.length) return [];
    const speed = fusedSpeed(samples, run.gps);
    const s0 = run.sectionStartMs ?? samples[0].tMs;
    const s1 = run.sectionEndMs ?? samples[samples.length - 1].tMs;

    const bins = [];
    for (let t = s0; t < s1; t += 1000) {
      const vals = [];
      for (let i = 0; i < samples.length; i++) {
        if (samples[i].tMs >= t && samples[i].tMs < Math.min(t + 1000, s1)) vals.push(speed[i] * 3.6);
      }
      if (vals.length < 3) continue;
      vals.sort((a, b) => a - b);
      bins.push({
        secFromStart: (t - s0) / 1000,
        min: vals[0],
        q25: quantileSorted(vals, 0.25),
        med: quantileSorted(vals, 0.5),
        q75: quantileSorted(vals, 0.75),
        max: vals[vals.length - 1]
      });
    }
    return bins;
  }

  return { detectSection, fusedSpeed, computeMetrics, perSecondSpeedStats, estimateRateHz, movingAvg };
})();
