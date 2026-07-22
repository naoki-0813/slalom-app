// charts.js — Chart.jsを使ったグラフ描画の共通処理
// 公開オブジェクト: Charts
// 結果画面(時系列+計測区間の網掛け+動画カーソル)と比較画面(重ね描き)で使う。
// Chart.js が読み込めない環境(オフライン等)でも記録・保存は動くよう、全関数で存在チェックする。

const Charts = (() => {

  // 走行ごとの線色(基準=濃い青、以降はオレンジ系など。比較画面で固定順に使う)
  const COLORS = ['#4fc3f7', '#ffb74d', '#aed581', '#f06292', '#ba68c8'];

  // Chart.jsが使えるか(CDNが読めなかった場合はfalse)
  function available() { return typeof Chart !== 'undefined'; }

  // ---------- カスタムプラグイン: 計測区間の網掛け・黄線・動画カーソル ----------
  const overlayPlugin = {
    id: 'sectionOverlay',
    afterDatasetsDraw(chart) {
      const o = chart.options.plugins.sectionOverlay || {};
      const a = chart.chartArea;
      const x = chart.scales.x;
      if (!a || !x) return;
      const ctx = chart.ctx;
      ctx.save();

      // 計測区間の外側を暗くし、境界に黄線
      if (o.startS !== null && o.startS !== undefined &&
          o.endS !== null && o.endS !== undefined) {
        const xs = x.getPixelForValue(o.startS);
        const xe = x.getPixelForValue(o.endS);
        ctx.fillStyle = 'rgba(0,0,0,0.4)';
        if (xs > a.left) ctx.fillRect(a.left, a.top, Math.min(xs, a.right) - a.left, a.bottom - a.top);
        if (xe < a.right) ctx.fillRect(Math.max(xe, a.left), a.top, a.right - Math.max(xe, a.left), a.bottom - a.top);
        ctx.strokeStyle = '#ffd54f';
        ctx.lineWidth = 1.5;
        for (const px of [xs, xe]) {
          if (px >= a.left && px <= a.right) {
            ctx.beginPath(); ctx.moveTo(px, a.top); ctx.lineTo(px, a.bottom); ctx.stroke();
          }
        }
      }

      // 動画の現在位置カーソル(白線)
      if (o.cursorS !== null && o.cursorS !== undefined) {
        const pc = x.getPixelForValue(o.cursorS);
        if (pc >= a.left && pc <= a.right) {
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 1.5;
          ctx.beginPath(); ctx.moveTo(pc, a.top); ctx.lineTo(pc, a.bottom); ctx.stroke();
        }
      }
      ctx.restore();
    }
  };

  // ---------- チャート生成 ----------

  // 折れ線チャートを作る。onClickX: グラフタップ時にx値(秒)を受け取るコールバック
  function makeLine(canvasId, { xLabel, yLabel, onClickX, legend } = {}) {
    if (!available()) return null;
    const ctx = document.getElementById(canvasId).getContext('2d');
    return new Chart(ctx, {
      type: 'line',
      data: { datasets: [] },
      plugins: [overlayPlugin],
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        parsing: false,          // データは {x, y} の数値で渡す(高速化)
        normalized: true,
        events: onClickX ? ['click'] : [],
        onClick: onClickX ? (e, els, chart) => {
          const xv = chart.scales.x.getValueForPixel(e.x);
          if (xv !== null && xv !== undefined) onClickX(xv);
        } : undefined,
        scales: {
          x: {
            type: 'linear',
            title: { display: !!xLabel, text: xLabel || '', color: '#9aa7b3' },
            ticks: { color: '#9aa7b3' }, grid: { color: '#2a323c' }
          },
          y: {
            title: { display: !!yLabel, text: yLabel || '', color: '#9aa7b3' },
            ticks: { color: '#9aa7b3' }, grid: { color: '#2a323c' }
          }
        },
        plugins: {
          // 凡例。ラベルが "_" 始まりの系列(帯の下辺など)は表示しない
          legend: {
            display: !!legend,
            labels: {
              color: '#e8ecf0', boxWidth: 14,
              filter: (item) => !item.text || !item.text.startsWith('_')
            }
          },
          tooltip: { enabled: false },
          sectionOverlay: {}
        }
      }
    });
  }

  // ---------- データ投入 ----------

  // 点数が多いときは描画用に間引く(データ本体は間引かない)
  function decimate(points, maxPoints = 500) {
    if (points.length <= maxPoints) return points;
    const step = points.length / maxPoints;
    const out = [];
    for (let i = 0; i < maxPoints; i++) out.push(points[Math.floor(i * step)]);
    out.push(points[points.length - 1]);
    return out;
  }

  // 1系列のデータを設定する(結果画面用)
  function setSingleSeries(chart, points, color = COLORS[0]) {
    if (!chart) return;
    chart.data.datasets = [{
      data: decimate(points),
      borderColor: color,
      borderWidth: 2,
      pointRadius: 0,
      tension: 0
    }];
    chart.update('none');
  }

  // 複数系列を重ねて設定する(比較画面用)。
  // seriesList: [{label, points, thick, color, fillToPrev}] の配列
  function setMultiSeries(chart, seriesList) {
    if (!chart) return;
    chart.data.datasets = seriesList.map((s, i) => ({
      label: s.label,
      data: decimate(s.points),
      borderColor: s.color || COLORS[i % COLORS.length],
      backgroundColor: s.bgColor || 'transparent',
      borderWidth: s.borderWidth !== undefined ? s.borderWidth : (s.thick ? 3 : 1.5),
      fill: s.fillToPrev ? '-1' : false,
      pointRadius: 0,
      tension: 0
    }));
    chart.update('none');
  }

  // 計測区間(網掛け)と動画カーソルの位置を設定する。nullで消す
  function setOverlay(chart, { startS, endS, cursorS } = {}) {
    if (!chart) return;
    const o = chart.options.plugins.sectionOverlay;
    if (startS !== undefined) o.startS = startS;
    if (endS !== undefined) o.endS = endS;
    if (cursorS !== undefined) o.cursorS = cursorS;
    chart.update('none');
  }

  // ---------- リアルタイム折れ線(カメラ映像への重ね描き用) ----------
  // Chart.jsは使わず自前のcanvas描画(毎秒10回の再描画でも軽く、オフラインでも動く)。
  // 直近windowS秒のデータをリングバッファに溜め、draw()で透過背景に描く。

  function makeLive(canvas) {
    const buf = [];  // {tMs, v}
    let opts = {
      windowS: 10,        // 横軸の時間幅 [秒]
      yMode: 'auto',      // 'auto' = データに合わせる / 'fixed' = 固定値
      yFixed: 0.6,        // 固定時の縦軸レンジ(zeroCenterなら±この値、そうでなければ0〜この値)
      zeroCenter: true,   // 0を中央にするか(横G・ヨーレート=true、速度=false)
      unit: 'G',
      decimals: 2,
      autoFloor: 0.2      // Auto時の最小レンジ(小さすぎるノイズで暴れないように)
    };

    function setOptions(o) { Object.assign(opts, o); }

    function push(tMs, v) {
      buf.push({ tMs, v });
      // 表示範囲より古いものは捨てる
      const limit = performance.now() - opts.windowS * 1000 - 500;
      while (buf.length && buf[0].tMs < limit) buf.shift();
    }

    function clear() {
      buf.length = 0;
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }

    function draw() {
      const W = canvas.clientWidth, H = canvas.clientHeight;
      if (!W || !H) return;
      if (canvas.width !== W) canvas.width = W;
      if (canvas.height !== H) canvas.height = H;
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, W, H);

      const now = performance.now();
      const t0 = now - opts.windowS * 1000;

      // 縦軸レンジを決める
      let lo, hi;
      if (opts.yMode === 'fixed') {
        hi = opts.yFixed;
        lo = opts.zeroCenter ? -opts.yFixed : 0;
      } else {
        let m = 0;
        for (const p of buf) if (p.tMs >= t0) m = Math.max(m, Math.abs(p.v));
        m = Math.max(m * 1.2, opts.autoFloor);
        hi = m;
        lo = opts.zeroCenter ? -m : 0;
      }
      const x = (t) => (t - t0) / (opts.windowS * 1000) * W;
      const y = (v) => H - (Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo) * H;

      // 基準線(0)と上下端の目盛り
      ctx.save();
      if (opts.zeroCenter) {
        ctx.strokeStyle = 'rgba(255,255,255,0.35)';
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(0, y(0)); ctx.lineTo(W, y(0)); ctx.stroke();
      }
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.font = '12px sans-serif';
      ctx.textAlign = 'left';
      ctx.shadowColor = 'rgba(0,0,0,0.9)'; ctx.shadowBlur = 3;
      ctx.fillText(hi.toFixed(opts.decimals >= 2 ? 1 : 0) + ' ' + opts.unit, 6, 14);
      ctx.fillText(lo.toFixed(opts.decimals >= 2 ? 1 : 0), 6, H - 6);

      // 折れ線(黄色+影で映像の上でも見えるように)
      ctx.strokeStyle = '#ffeb3b';
      ctx.lineWidth = 2;
      ctx.beginPath();
      let started = false;
      for (const p of buf) {
        if (p.tMs < t0) continue;
        if (!started) { ctx.moveTo(x(p.tMs), y(p.v)); started = true; }
        else ctx.lineTo(x(p.tMs), y(p.v));
      }
      ctx.stroke();

      // 現在値(右上に大きめ表示)
      if (buf.length) {
        const v = buf[buf.length - 1].v;
        ctx.textAlign = 'right';
        ctx.font = 'bold 18px sans-serif';
        ctx.fillStyle = '#ffeb3b';
        ctx.fillText(v.toFixed(opts.decimals) + ' ' + opts.unit, W - 8, 22);
      }
      ctx.restore();
    }

    return { push, draw, clear, setOptions };
  }

  return { available, makeLine, setSingleSeries, setMultiSeries, setOverlay, decimate, makeLive, COLORS };
})();
