# 動画録画・時刻同期・IndexedDB保存・ファイル出力

## 1. カメラ起動とプレビュー

```js
const stream = await navigator.mediaDevices.getUserMedia({
  video: {
    facingMode: { ideal: 'environment' },   // 背面カメラ
    width: { ideal: 1280 }, height: { ideal: 720 },
    frameRate: { ideal: 30 }
  },
  audio: false                              // 音声は不要(プライバシーと容量のため)
});
videoEl.srcObject = stream;
videoEl.muted = true; videoEl.playsInline = true; await videoEl.play();
```

- 権限拒否時は「Chromeの設定 > サイトの設定 > カメラ」を案内する日本語メッセージを表示
- 設定画面の画質(720p/480p)はこの constraints に反映する

## 2. 録画(MediaRecorder)

```js
const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
  .find(m => MediaRecorder.isTypeSupported(m));
const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 2_500_000 });
const chunks = [];
rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
rec.onstop = () => { const blob = new Blob(chunks, { type: mime }); /* 保存へ */ };
rec.start(1000);   // 1秒ごとにチャンク化(途中クラッシュ対策)
```

- 2.5Mbps × 60秒 ≒ 19MB 程度。走行は数十秒なので現実的な容量
- Android Chrome の出力は webm。mp4 変換はしない(端末再生・PC再生とも webm で可能。
  変換ライブラリ(ffmpeg.wasm等)は重いので導入しない)

## 3. センサーデータとの時刻同期(重要)

- 記録開始処理で `rec.start()` 直後に `videoStartMs = performance.now()` を記録する
- センサーの `t_ms` も同じ `performance.now()` 基準なので、
  動画内時刻 = `(t_ms - (videoStartMs - t0)) / 1000` 秒 で対応付く
- 結果画面のグラフタップ時: `videoEl.currentTime = 上式の値` でシーク
- 動画再生中は `timeupdate` イベントでグラフ上にカーソル線を動かす(双方向同期)
- start() から実際の録画開始までの遅延(数十ms)は許容する。気になる精度ではない

## 4. IndexedDB 設計

DB名 `pylon-slalom` / バージョン1 / オブジェクトストア2つ:

| ストア | keyPath | 内容 |
|---|---|---|
| `runs` | `id`(自動採番) | メタ情報+センサーデータ。`{id, name, driver, isExpert, createdAt, calib:{R,g}, samples:[...], gps:[...], metrics:{...}, videoStartOffsetMs}` |
| `videos` | `runId` | `{runId, blob, mime}` 動画だけ分離(一覧表示で動画を読み込まないため) |

実装ルール:

- ラッパーは自作の Promise ベース関数 `db.get/put/delete/getAll` 程度で十分。
  ライブラリ(idb等)は入れない
- 一覧画面は `runs` のみ読む。`samples` が重い場合は `getAll` 後にメタだけ使う
  (数十件規模なら問題ない。将来増えたらメタ分離を検討)
- 削除は「走行ごと削除」と「動画だけ削除(センサーデータは残す)」の2種類を用意
- 保存前に `navigator.storage.estimate()` で残量を確認し、
  残りが動画サイズの2倍未満なら警告する
- `navigator.storage.persist()` を初回に要求しておく(ブラウザによる自動削除の抑制)

## 5. ファイルのダウンロード(CSV・動画)

```js
function download(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}
```

- CSV: `new Blob([csvString], {type:'text/csv;charset=utf-8'})`。
  Excelで開く可能性を考え、必要ならBOM付き(`﻿`)オプションを検討(既定はBOMなし)
- 動画: 保存済みBlobをそのまま `download(blob, 'run_〜.webm')`
- ファイル名の日時は端末ローカル時刻 `YYYYMMDD-HHMMSS` 形式。走行名は
  ファイル名に使えない文字(`/ \ : * ? " < > |` と空白)を `_` に置換する

## 6. CSV生成

仕様書 §3.4 の列順を厳守。実装メモ:

- 先頭コメント行の例:
  ```
  # app_version=1.0
  # run_name=練習3本目, driver=nao, is_expert=false
  # created_at=2026-07-21T10:30:00+09:00
  # calib_R=[[...],[...],[...]], calib_g=[x,y,z]
  ```
- 数値は小数4桁で丸める(ファイルサイズと可読性のバランス)
- GPS行の対応付け: 各GPSサンプルを、最も近い `t_ms` のセンサー行に載せる。
  他の行のGPS列は空文字
