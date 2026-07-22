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

  // ---------- グラフ・比較用の時系列 ----------

  // 記録全体の平滑化済み時系列を返す(結果画面のグラフ用)
  // 戻り値: { tS(秒), ayG(横G), gz(deg/s), vKmh } すべて同じ長さの配列
  function displaySeries(run) {
    const samples = run.samples;
    if (!samples.length) return null;
    const win = Math.max(3, Math.round(0.1 * estimateRateHz(samples)));
    const aySm = movingAvg(samples.map(s => s.ay), win);
    const gzSm = movingAvg(samples.map(s => s.gz), win);
    const speed = fusedSpeed(samples, run.gps);
    return {
      tS: samples.map(s => s.tMs / 1000),
      ayG: aySm.map(v => v / 9.81),
      gz: gzSm,
      vKmh: speed.map(v => v * 3.6)
    };
  }

  // 計測区間内だけの時系列を返す(比較画面用)。tSは区間開始からの相対秒
  function sectionSeries(run) {
    const samples = run.samples;
    if (!samples.length) return null;
    const s0 = run.sectionStartMs ?? samples[0].tMs;
    const s1 = run.sectionEndMs ?? samples[samples.length - 1].tMs;
    const win = Math.max(3, Math.round(0.1 * estimateRateHz(samples)));
    const aySm = movingAvg(samples.map(s => s.ay), win);
    const gzSm = movingAvg(samples.map(s => s.gz), win);
    const speed = fusedSpeed(samples, run.gps);
    const tS = [], ay = [], gz = [], v = [];
    for (let i = 0; i < samples.length; i++) {
      if (samples[i].tMs >= s0 && samples[i].tMs <= s1) {
        tS.push((samples[i].tMs - s0) / 1000);
        ay.push(aySm[i]);
        gz.push(gzSm[i]);
        v.push(speed[i]);
      }
    }
    if (tS.length < 10) return null;
    return { tS, ay, gz, v, timeS: tS[tS.length - 1] };
  }

  // 時系列を「進行率0〜100%」のn点に線形補間でリサンプリングする
  function resampleN(tS, ys, n) {
    const T = tS[tS.length - 1];
    const out = new Array(n);
    let idx = 0;
    for (let k = 0; k < n; k++) {
      const tt = (k / (n - 1)) * T;
      while (idx < tS.length - 2 && tS[idx + 1] < tt) idx++;
      const t0 = tS[idx], t1 = tS[idx + 1];
      const f = t1 > t0 ? (tt - t0) / (t1 - t0) : 0;
      out[k] = ys[idx] + (ys[idx + 1] - ys[idx]) * f;
    }
    return out;
  }

  // 走行の計測区間を200点の進行率配列にする(比較・スコア計算の共通土俵)
  const N_RESAMPLE = 200;
  function progress200(run) {
    const ss = sectionSeries(run);
    if (!ss) return null;
    return {
      ay: resampleN(ss.tS, ss.ay, N_RESAMPLE),
      gz: resampleN(ss.tS, ss.gz, N_RESAMPLE),
      v: resampleN(ss.tS, ss.v, N_RESAMPLE),
      timeS: ss.timeS
    };
  }

  // ---------- お手本比較・再現性スコア ----------

  const K2 = 1.0;   // 一致度スコアのRMSE減衰定数 [m/s²] 調整対象
  const K3 = 0.8;   // 再現性スコアの減衰定数 [m/s²] 調整対象

  function rmseArr(a, b) {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) * (a[i] - b[i]);
    return Math.sqrt(s / a.length);
  }

  // ピアソン相関係数(波形の形の一致度)
  function pearson(a, b) {
    const ma = mean(a), mb = mean(b);
    let num = 0, da = 0, db = 0;
    for (let i = 0; i < a.length; i++) {
      num += (a[i] - ma) * (b[i] - mb);
      da += (a[i] - ma) ** 2;
      db += (b[i] - mb) ** 2;
    }
    const d = Math.sqrt(da * db);
    return d > 0 ? num / d : 0;
  }

  // ヨーレートのゼロクロス位置(進行率%)の一覧。±3deg/sのデッドバンド付き
  function zeroCrossPct(gzArr) {
    const out = [];
    let sign = 0;
    for (let i = 0; i < gzArr.length; i++) {
      if (gzArr[i] > YAW_DEADBAND) {
        if (sign === -1) out.push(i / (gzArr.length - 1) * 100);
        sign = 1;
      } else if (gzArr[i] < -YAW_DEADBAND) {
        if (sign === 1) out.push(i / (gzArr.length - 1) * 100);
        sign = -1;
      }
    }
    return out;
  }

  // 基準走行(お手本)との比較。戻り値の各値は「対象 − 基準」
  function compareToBase(baseRun, run) {
    const A = progress200(baseRun), B = progress200(run);
    if (!A || !B) return null;
    const mA = computeMetrics(baseRun), mB = computeMetrics(run);

    const rmseLatG = rmseArr(A.ay, B.ay);
    const rmseYaw = rmseArr(A.gz, B.gz);
    // 一致度 = 相関(形)とRMSE(大きさ)の平均
    const matchScore = Math.round(
      (100 * Math.max(0, pearson(A.ay, B.ay)) + 100 * Math.exp(-rmseLatG / K2)) / 2
    );

    // 切り返しタイミングのずれ: ゼロクロス位置を順に対応付けて平均(+ = お手本より遅い)
    const zA = zeroCrossPct(A.gz), zB = zeroCrossPct(B.gz);
    const nz = Math.min(zA.length, zB.length);
    let timingShiftPct = null;
    if (nz > 0) {
      let s = 0;
      for (let i = 0; i < nz; i++) s += zB[i] - zA[i];
      timingShiftPct = s / nz;
    }

    return {
      rmseLatG, rmseYaw, matchScore, timingShiftPct,
      timeDiffS: B.timeS - A.timeS,
      maxLatGDiff: (mB.maxLatG || 0) - (mA.maxLatG || 0),
      smoothnessDiff: (mB.smoothness || 0) - (mA.smoothness || 0)
    };
  }

  // 再現性(自分の走行同士)。横G波形の各進行率点での標準偏差から算出
  function reproducibility(runs) {
    const Ps = runs.map(progress200).filter(p => p !== null);
    if (Ps.length < 2) return null;
    const n = N_RESAMPLE;
    const meanCurve = new Array(n), sdCurve = new Array(n);
    for (let k = 0; k < n; k++) {
      const vals = Ps.map(p => p.ay[k]);
      meanCurve[k] = mean(vals);
      sdCurve[k] = std(vals);
    }
    const meanSd = mean(sdCurve);
    const times = Ps.map(p => p.timeS);
    const timeCvPct = mean(times) > 0 ? std(times) / mean(times) * 100 : 0;
    return {
      score: Math.round(100 * Math.exp(-meanSd / K3)),
      meanSd, meanCurve, sdCurve, timeCvPct
    };
  }

  // 講評コメントの生成(if文ベース。AIは使わない)
  function adviceComments(mode, data) {
    const out = [];
    if (mode === 'expert') {
      // data = [{name, cmp}] お手本と各走行の比較結果
      for (const { name, cmp } of data) {
        if (!cmp) continue;
        const c = [];
        if (cmp.timingShiftPct !== null && cmp.timingShiftPct > 3) {
          c.push('切り返しがお手本より遅れがちです。次のパイロンを早めに見ましょう');
        }
        if (cmp.timingShiftPct !== null && cmp.timingShiftPct < -3) {
          c.push('切り返しがお手本より早めです。舵を入れるのを少し我慢してみましょう');
        }
        if (cmp.rmseLatG > K2 * 0.8 && Math.abs(cmp.maxLatGDiff) < 0.1) {
          c.push('Gの出し方の波形がお手本と違います。舵の当て方が急かもしれません');
        }
        if (cmp.smoothnessDiff < -15) {
          c.push('操作が急です。ハンドルをより滑らかに動かしましょう');
        }
        if (c.length === 0 && cmp.matchScore >= 70) {
          c.push('お手本にかなり近い走りです');
        }
        if (c.length === 0) {
          c.push('波形の重なりをグラフで確認してみましょう');
        }
        out.push(`【${name}】` + c.join('。'));
      }
    } else {
      // data = reproducibility() の戻り値
      if (data.score >= 80) out.push('走行間のばらつきが小さく、非常に安定しています');
      else if (data.score >= 60) out.push('まずまず安定しています。ばらつきの大きい区間(帯が太い所)を意識してみましょう');
      else out.push('走行ごとのばらつきが大きめです。同じ速度・同じラインを意識して再現性を高めましょう');
      if (data.timeCvPct > 5) out.push(`タイムのばらつきも大きめです(変動 ${data.timeCvPct.toFixed(1)}%)`);
    }
    return out;
  }

  return {
    detectSection, fusedSpeed, computeMetrics, perSecondSpeedStats, estimateRateHz, movingAvg,
    displaySeries, sectionSeries, progress200,
    compareToBase, reproducibility, adviceComments
  };
})();
