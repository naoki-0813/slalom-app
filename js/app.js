// app.js — 画面切り替え・設定の保存・各画面のイベント配線(全体制御)
// 公開オブジェクト: App

const App = (() => {

  const $ = (id) => document.getElementById(id);

  // 画面名 → タイトルの対応
  const TITLES = {
    home: 'パイロンスラローム計測',
    record: '記録',
    result: '結果',
    list: '走行一覧',
    compare: '比較',
    settings: '設定'
  };

  let currentScreen = 'home';
  let currentRun = null;      // 結果画面で表示中の走行
  let recUiTimer = null;      // 記録中の画面更新タイマー

  // ---------- 設定(localStorageに保存) ----------

  const settings = {
    autoStop: true,
    quality: '720',
    mock: false,
    mockPreset: 'expert'
  };

  function loadSettings() {
    try {
      const saved = JSON.parse(localStorage.getItem('pylon-settings') || '{}');
      Object.assign(settings, saved);
    } catch (_) { /* 壊れていたら既定値のまま */ }
    // URLに ?mock=1 が付いていたらモックを強制ON(開発用)
    if (new URLSearchParams(location.search).get('mock') === '1') settings.mock = true;
    applySettings();
  }

  function saveSettings() {
    localStorage.setItem('pylon-settings', JSON.stringify(settings));
    applySettings();
  }

  // 設定値を各モジュールとUIに反映する
  function applySettings() {
    Mock.enabled = settings.mock;
    Mock.preset = settings.mockPreset;
    Recorder.autoStop = settings.autoStop;
    $('set-autostop').checked = settings.autoStop;
    $('set-quality').value = settings.quality;
    $('set-mock').checked = settings.mock;
    $('set-mock-preset').value = settings.mockPreset;
  }

  // ---------- 画面切り替え ----------

  function show(name) {
    // 記録中に画面を離れない(誤操作防止)
    if (Recorder.recording && name !== 'record') return;

    // 記録画面を離れるときはカメラを止める(バッテリー・プライバシーのため)
    if (currentScreen === 'record' && name !== 'record') Recorder.stopCamera();

    document.querySelectorAll('.screen').forEach(el => el.classList.add('hidden'));
    $(`screen-${name}`).classList.remove('hidden');
    $('header-title').textContent = TITLES[name];
    $('btn-back').classList.toggle('hidden', name === 'home');
    currentScreen = name;

    if (name === 'home') {
      $('calib-warning').classList.toggle('hidden', Sensors.isCalibrated);
    }
    if (name === 'record') enterRecordScreen();
    if (name === 'list') renderList();
    if (name === 'settings') {
      $('sensor-rate').textContent = `記録レート: ${Sensors.measuredRateHz || '-'} Hz(記録中に実測)`;
    }
  }

  // ---------- 初回の安全注意モーダル ----------

  function setupSafetyModal() {
    if (!localStorage.getItem('pylon-safety-agreed')) {
      $('safety-modal').classList.remove('hidden');
    }
    $('safety-agree').addEventListener('click', () => {
      localStorage.setItem('pylon-safety-agreed', '1');
      $('safety-modal').classList.add('hidden');
    });
  }

  // ---------- 記録画面 ----------

  function enterRecordScreen() {
    $('record-controls').classList.remove('hidden');
    $('recording-view').classList.add('hidden');
    $('countdown-overlay').classList.add('hidden');
    updateCalibStatus();
    Sensors.startListening(); // キャリブレーションに備えてセンサー起動
    startCameraPreview();
  }

  // カメラを起動してプレビューを表示する(使えなくても記録は続けられる)
  async function startCameraPreview() {
    const msg = $('camera-msg');
    msg.classList.remove('hidden');
    msg.textContent = 'カメラ起動中…';
    try {
      await Recorder.initCamera($('camera-preview'), settings.quality);
      msg.classList.add('hidden');
    } catch (e) {
      msg.textContent = 'カメラを起動できませんでした(動画なしで記録できます)。' +
        'Chromeの「設定 > サイトの設定 > カメラ」で許可を確認してください。';
    }
  }

  function updateCalibStatus() {
    const done = Sensors.isCalibrated;
    $('calib-status').textContent = done
      ? 'キャリブレーション: 完了(取り付け角度の補正が有効です)'
      : 'キャリブレーション: 未実施';
    $('btn-start').disabled = !done;
  }

  async function doCalibrate() {
    const btn = $('btn-calibrate');
    btn.disabled = true;
    $('calib-status').textContent = 'キャリブレーション中…(3秒間、車を動かさないでください)';
    try {
      await Sensors.startListening();
      await Sensors.calibrate(3);
      updateCalibStatus();
    } catch (e) {
      $('calib-status').textContent = `失敗: ${e.message}`;
      $('btn-start').disabled = true;
    } finally {
      btn.disabled = false;
    }
  }

  function startRecording() {
    $('record-controls').classList.add('hidden');
    $('countdown-overlay').classList.remove('hidden');

    Recorder.startWithCountdown(
      (remain) => { $('countdown-number').textContent = remain; },
      () => {
        // カウントダウン終了 → 記録開始
        $('countdown-overlay').classList.add('hidden');
        $('recording-view').classList.remove('hidden');
        $('autostop-hint').classList.toggle('hidden', !settings.autoStop);
        // 経過時間と横Gの表示を10Hzで更新
        recUiTimer = setInterval(() => {
          $('rec-elapsed').textContent = (Recorder.elapsedMs / 1000).toFixed(1) + ' 秒';
          $('rec-lat-g').textContent = Recorder.latestLatG.toFixed(2);
        }, 100);
      }
    );
  }

  // 記録完了時(手動・自動どちらでも)に呼ばれる
  function onRunFinished(run) {
    clearInterval(recUiTimer);
    currentRun = run;
    show('result');
    renderResult();
  }

  // ---------- 結果画面 ----------

  function renderResult() {
    const run = currentRun;
    if (!run) return;

    $('result-name').value = run.name;
    $('result-driver').value = run.driver || '';
    $('result-expert').checked = !!run.isExpert;

    // 計測区間が未設定、または旧方式(切り返し検出導入前)で保存されたデータなら自動検出する
    const isOldData = !run.metrics || run.metrics.speedConstancy === undefined;
    if (run.sectionStartMs === null || run.sectionStartMs === undefined || isOldData) {
      const det = Analysis.detectSection(run.samples);
      if (det) {
        run.sectionStartMs = det.startMs;
        run.sectionEndMs = det.endMs;
        Storage2.saveRun(run);
      }
    }

    renderSummary(run);
    drawPreviewChart(run);
    drawSpeedDistChart(run);
    setupSectionSliders(run);
    loadResultVideo(run);
  }

  // 結果画面に保存済み動画を読み込む(なければプレイヤーを隠す)
  let resultVideoUrl = null;   // 前回のBlob URLを解放するために保持
  let resultVideoBlob = null;  // 「動画を保存」用

  async function loadResultVideo(run) {
    const box = $('result-video-box');
    const videoEl = $('result-video');
    if (resultVideoUrl) { URL.revokeObjectURL(resultVideoUrl); resultVideoUrl = null; }
    resultVideoBlob = null;
    videoEl.removeAttribute('src');

    const rec = (run.id !== undefined && run.id !== null) ? await Storage2.getVideo(run.id) : null;
    if (rec && rec.blob && rec.blob.size > 0) {
      resultVideoBlob = rec.blob;
      resultVideoUrl = URL.createObjectURL(rec.blob);
      videoEl.src = resultVideoUrl;
      box.classList.remove('hidden');
      $('btn-download-video').disabled = false;
    } else {
      box.classList.add('hidden');
      $('btn-download-video').disabled = true;
    }
  }

  // サマリー数値を計算して表示する
  function renderSummary(run) {
    const m = Analysis.computeMetrics(run);
    run.metrics = m;
    const items = (m.sectionTimeS === null || m.sectionTimeS === undefined) ? [
      ['計測区間', '検出できませんでした(下のスライダーで手動設定できます)']
    ] : [
      ['計測区間タイム', m.sectionTimeS.toFixed(1) + ' 秒'],
      ['最大横G', m.maxLatG.toFixed(2) + ' G'],
      ['平均速度', m.avgSpeedKmh.toFixed(1) + ' km/h'],
      ['速度一定性', `${m.speedConstancy} 点(ばらつき ${m.speedCvPct.toFixed(1)}%)`],
      ['スムーズネス', m.smoothness + ' 点'],
      ['切り返し回数', m.switchbacks + ' 回']
    ];
    $('result-summary').innerHTML = items.map(([label, value]) =>
      `<div class="summary-item"><div class="label">${label}</div><div class="value">${value}</div></div>`
    ).join('');
  }

  // 計測区間の手動調整スライダー(自動検出がずれたときの保険)
  function setupSectionSliders(run) {
    if (!run.samples.length) return;
    const maxMs = Math.round(run.samples[run.samples.length - 1].tMs);
    const sStart = $('sec-start'), sEnd = $('sec-end');
    sStart.min = 0; sStart.max = maxMs;
    sEnd.min = 0; sEnd.max = maxMs;
    sStart.value = Math.round(run.sectionStartMs ?? 0);
    sEnd.value = Math.round(run.sectionEndMs ?? maxMs);
    updateSectionLabels(run);

    // onchangeではなくoninput代入で毎回上書き(多重登録を防ぐ)
    sStart.oninput = () => applySectionChange(run);
    sEnd.oninput = () => applySectionChange(run);
    $('btn-sec-auto').onclick = () => {
      const det = Analysis.detectSection(run.samples);
      run.sectionStartMs = det ? det.startMs : null;
      run.sectionEndMs = det ? det.endMs : null;
      Storage2.saveRun(run);
      renderResult();
    };
  }

  function updateSectionLabels(run) {
    $('sec-start-label').textContent = ((run.sectionStartMs ?? 0) / 1000).toFixed(1) + ' 秒';
    $('sec-end-label').textContent = ((run.sectionEndMs ?? 0) / 1000).toFixed(1) + ' 秒';
  }

  // スライダー変更を反映(開始 < 終了を保証し、保存して再描画)
  function applySectionChange(run) {
    let a = +$('sec-start').value, b = +$('sec-end').value;
    if (b - a < 1000) b = a + 1000; // 最低1秒は確保
    run.sectionStartMs = a;
    run.sectionEndMs = b;
    Storage2.saveRun(run);
    updateSectionLabels(run);
    renderSummary(run);
    drawPreviewChart(run);
    drawSpeedDistChart(run);
  }

  // 横Gの簡易チャートを自前のcanvasで描く(Chart.jsはフェーズ3で導入)
  // cursorMsを渡すと、その時刻に白い縦線(動画の現在位置)を描く
  function drawPreviewChart(run, cursorMs) {
    const canvas = $('preview-chart');
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    if (!run.samples.length) return;

    // 描画用に最大600点へ間引く(データ本体は間引かない)
    const step = Math.max(1, Math.floor(run.samples.length / 600));
    const pts = [];
    for (let i = 0; i < run.samples.length; i += step) pts.push(run.samples[i]);

    const tMax = pts[pts.length - 1].tMs || 1;
    const gLimit = 0.6 * 9.81; // 表示レンジ ±0.6G
    const x = (t) => t / tMax * W;
    const y = (ay) => H / 2 - (ay / gLimit) * (H / 2 - 10);

    // 0Gの基準線
    ctx.strokeStyle = '#3a444f';
    ctx.beginPath(); ctx.moveTo(0, H / 2); ctx.lineTo(W, H / 2); ctx.stroke();

    // 横Gの波形
    ctx.strokeStyle = '#4fc3f7';
    ctx.lineWidth = 2;
    ctx.beginPath();
    pts.forEach((s, i) => {
      if (i === 0) ctx.moveTo(x(s.tMs), y(s.ay));
      else ctx.lineTo(x(s.tMs), y(s.ay));
    });
    ctx.stroke();

    // 計測区間の外側を暗くし、境界に黄線マーカーを引く
    if (run.sectionStartMs !== null && run.sectionStartMs !== undefined &&
        run.sectionEndMs !== null && run.sectionEndMs !== undefined) {
      const xs = x(run.sectionStartMs), xe = x(run.sectionEndMs);
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.fillRect(0, 0, xs, H);
      ctx.fillRect(xe, 0, W - xe, H);
      ctx.strokeStyle = '#ffd54f';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(xs, 0); ctx.lineTo(xs, H); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(xe, 0); ctx.lineTo(xe, H); ctx.stroke();
    }

    // 動画の現在位置カーソル(白線)
    if (cursorMs !== undefined && cursorMs !== null) {
      const xc = x(cursorMs);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(xc, 0); ctx.lineTo(xc, H); ctx.stroke();
    }
  }

  // 速度の1秒ごとの分布を箱ひげ図で描く(速度一定性の見える化)
  function drawSpeedDistChart(run) {
    const canvas = $('speed-dist-chart');
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    const PAD_L = 42, PAD_B = 22, PAD_T = 8;
    ctx.clearRect(0, 0, W, H);

    const bins = Analysis.perSecondSpeedStats(run);
    if (!bins.length) return;

    const vMax = Math.max(10, Math.ceil(Math.max(...bins.map(b => b.max)) / 10) * 10);
    const x = (i) => PAD_L + (i + 0.5) * (W - PAD_L) / bins.length;
    const boxW = Math.min(24, (W - PAD_L) / bins.length * 0.6);
    const y = (v) => PAD_T + (H - PAD_T - PAD_B) * (1 - v / vMax);

    // Y軸目盛り(km/h)
    ctx.fillStyle = '#9aa7b3';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'right';
    for (let v = 0; v <= vMax; v += 10) {
      ctx.strokeStyle = '#2a323c';
      ctx.beginPath(); ctx.moveTo(PAD_L, y(v)); ctx.lineTo(W, y(v)); ctx.stroke();
      ctx.fillText(v + '', PAD_L - 6, y(v) + 4);
    }

    // 各ビンの箱ひげ
    bins.forEach((b, i) => {
      const cx = x(i);
      // ひげ(最小〜最大)
      ctx.strokeStyle = '#607d8b';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(cx, y(b.min)); ctx.lineTo(cx, y(b.max)); ctx.stroke();
      // 箱(25%〜75%)
      ctx.fillStyle = 'rgba(79,195,247,0.35)';
      ctx.strokeStyle = '#4fc3f7';
      ctx.fillRect(cx - boxW / 2, y(b.q75), boxW, y(b.q25) - y(b.q75));
      ctx.strokeRect(cx - boxW / 2, y(b.q75), boxW, y(b.q25) - y(b.q75));
      // 中央値
      ctx.strokeStyle = '#ffd54f';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(cx - boxW / 2, y(b.med)); ctx.lineTo(cx + boxW / 2, y(b.med)); ctx.stroke();
      ctx.lineWidth = 1;
      // X軸ラベル(秒。ビンが多いときは間引く)
      if (i % Math.ceil(bins.length / 12) === 0) {
        ctx.fillStyle = '#9aa7b3';
        ctx.textAlign = 'center';
        ctx.fillText(b.secFromStart + 's', cx, H - 6);
      }
    });
  }

  // メタ情報(走行名など)の変更を保存する
  async function saveMeta() {
    if (!currentRun) return;
    currentRun.name = $('result-name').value.trim() || currentRun.name;
    currentRun.driver = $('result-driver').value.trim();
    currentRun.isExpert = $('result-expert').checked;
    await Storage2.saveRun(currentRun);
    $('btn-save-meta').textContent = '保存しました ✓';
    setTimeout(() => { $('btn-save-meta').textContent = 'メタ情報を保存'; }, 1500);
  }

  // ---------- 走行一覧画面 ----------

  async function renderList() {
    const runs = await Storage2.getAllRuns();
    const videoKeys = await Storage2.getVideoKeys(); // 動画があるrunのID一覧(Blobは読まない)
    const listEl = $('run-list');
    $('list-empty').classList.toggle('hidden', runs.length > 0);
    $('storage-usage').textContent = await Storage2.usageText();

    listEl.innerHTML = '';
    for (const run of runs) {
      const li = document.createElement('li');
      li.className = 'run-item';
      const d = new Date(run.createdAt);
      const dateStr = `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      const sectionS = (run.sectionStartMs !== null && run.sectionEndMs !== null)
        ? ((run.sectionEndMs - run.sectionStartMs) / 1000).toFixed(1) + '秒' : '-';
      const hasVideo = videoKeys.has(run.id);
      li.innerHTML = `
        <div class="run-title">${escapeHtml(run.name)}${run.isExpert ? '<span class="expert-badge">お手本</span>' : ''}</div>
        <div class="run-sub">${dateStr} / タイム: ${sectionS} / ${run.samples.length}サンプル${hasVideo ? ' / 🎥動画あり' : ''}</div>
        <div class="run-actions">
          <button class="btn act-detail">詳細</button>
          <button class="btn act-csv">CSV</button>
          ${hasVideo ? '<button class="btn act-video">動画</button>' : ''}
          ${hasVideo ? '<button class="btn act-del-video">動画だけ削除</button>' : ''}
          <button class="btn btn-danger act-delete">削除</button>
        </div>`;
      li.querySelector('.act-detail').addEventListener('click', () => {
        currentRun = run;
        show('result');
        renderResult();
      });
      li.querySelector('.act-csv').addEventListener('click', () => Storage2.downloadCsv(run));
      if (hasVideo) {
        // 動画の再ダウンロード
        li.querySelector('.act-video').addEventListener('click', async () => {
          const rec = await Storage2.getVideo(run.id);
          if (rec && rec.blob) Storage2.downloadVideo(run, rec.blob);
        });
        // 動画だけ削除(センサーデータは残す。容量確保用)
        li.querySelector('.act-del-video').addEventListener('click', async () => {
          if (confirm(`「${run.name}」の動画だけを削除します(センサーデータは残ります)。よろしいですか?`)) {
            await Storage2.deleteVideo(run.id);
            renderList();
          }
        });
      }
      li.querySelector('.act-delete').addEventListener('click', async () => {
        if (confirm(`「${run.name}」を削除しますか?`)) {
          await Storage2.deleteRun(run.id);
          renderList();
        }
      });
      listEl.appendChild(li);
    }
  }

  // HTMLに埋め込む文字列を無害化する
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---------- 初期化 ----------

  function init() {
    loadSettings();
    setupSafetyModal();
    Storage2.requestPersist();
    Recorder.onFinished = onRunFinished;

    // ホームの大ボタン(data-goto属性で遷移先を指定)
    document.querySelectorAll('[data-goto]').forEach(btn => {
      btn.addEventListener('click', () => show(btn.dataset.goto));
    });
    $('btn-back').addEventListener('click', () => show('home'));

    // 記録画面
    $('btn-calibrate').addEventListener('click', doCalibrate);
    $('btn-start').addEventListener('click', startRecording);
    $('btn-stop').addEventListener('click', () => Recorder.stop());

    // 結果画面
    $('btn-save-meta').addEventListener('click', saveMeta);
    $('btn-download-csv').addEventListener('click', () => {
      if (currentRun) Storage2.downloadCsv(currentRun);
    });
    $('btn-download-video').addEventListener('click', () => {
      if (currentRun && resultVideoBlob) Storage2.downloadVideo(currentRun, resultVideoBlob);
    });

    // グラフタップ → 動画をその時刻にシーク(データと動画は同じ時刻基準)
    $('preview-chart').addEventListener('click', (e) => {
      const run = currentRun;
      const videoEl = $('result-video');
      if (!run || !run.samples.length || !videoEl.src) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const frac = (e.clientX - rect.left) / rect.width;
      const tMs = frac * run.samples[run.samples.length - 1].tMs;
      // 動画内時刻 = (センサー時刻 − 動画開始オフセット) / 1000
      const offset = run.videoStartOffsetMs || 0;
      videoEl.currentTime = Math.max(0, (tMs - offset) / 1000);
    });

    // 動画再生中 → グラフ上に現在位置の白線を動かす(双方向同期)
    $('result-video').addEventListener('timeupdate', () => {
      const run = currentRun;
      if (!run || $('screen-result').classList.contains('hidden')) return;
      const offset = run.videoStartOffsetMs || 0;
      drawPreviewChart(run, $('result-video').currentTime * 1000 + offset);
    });

    // 設定画面
    $('set-autostop').addEventListener('change', e => { settings.autoStop = e.target.checked; saveSettings(); });
    $('set-quality').addEventListener('change', e => {
      settings.quality = e.target.value;
      saveSettings();
      // 記録画面でプレビュー中なら新しい画質でカメラを取り直す
      if (currentScreen === 'record' && !Recorder.recording) startCameraPreview();
    });
    $('set-mock').addEventListener('change', e => { settings.mock = e.target.checked; saveSettings(); });
    $('set-mock-preset').addEventListener('change', e => { settings.mockPreset = e.target.value; saveSettings(); });
    $('btn-wipe').addEventListener('click', async () => {
      if (confirm('保存されたすべての走行データを削除します。よろしいですか?')) {
        await Storage2.wipeAll();
        alert('削除しました。');
      }
    });

    show('home');
  }

  document.addEventListener('DOMContentLoaded', init);

  return { show, get settings() { return settings; } };
})();
