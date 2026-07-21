# センサー取得・キャリブレーション・座標変換

対象: Android Chrome(最新版)。HTTPS必須(localhostは例外)。

## 1. 使用API一覧

| API | 取れるもの | 備考 |
|---|---|---|
| `window.addEventListener('devicemotion', ...)` | 加速度(重力あり/なし)、角速度 | Androidでは許可ダイアログ不要。iOSと違い `requestPermission()` は存在しない(存在チェックしてから呼ぶ書き方にしておくと将来iOS対応が楽) |
| `window.addEventListener('deviceorientation', ...)` | 端末の姿勢角 | 補助用途のみ。ヨーレートは gyro(rotationRate)から取る方が信頼できる |
| `navigator.geolocation.watchPosition()` | 緯度経度・速度・精度 | `enableHighAccuracy: true` を必ず指定。更新は約1Hz |
| `navigator.wakeLock.request('screen')` | 画面消灯防止 | 記録開始時に取得、終了時に解放。`visibilitychange` で再取得する処理も入れる |

## 2. devicemotion の中身と単位

```js
window.addEventListener('devicemotion', (e) => {
  const t = performance.now();          // 経過時刻はこれで統一する
  e.acceleration;                        // {x,y,z} m/s² 重力を除いた加速度 → 走行分析はこちらを使う
  e.accelerationIncludingGravity;        // {x,y,z} m/s² 重力込み → キャリブレーション専用
  e.rotationRate;                        // {alpha,beta,gamma} deg/s 角速度
  e.interval;                            // サンプル間隔(参考値。実測のtを信じる)
});
```

注意:

- 端末によっては `acceleration` が null のことがある。null なら
  「重力込み − キャリブレーションで推定した重力」で代用するフォールバックを入れる
- レートは端末依存(30〜120Hz)。**60Hzを仮定せず、各サンプルに実測 `t_ms` を記録する**
- `rotationRate` の単位は deg/s(rad/sではない)。Chart表示・CSVとも deg/s で統一

## 3. スマホの軸と車両の軸

スマホを縦置き・画面を運転者側に向けて固定した場合の端末座標系:

- X: 画面の右方向 / Y: 画面の上方向 / Z: 画面から手前(運転者側)

しかし取り付け角度は毎回ズレるので、**端末座標系の値をそのまま使ってはいけない**。
キャリブレーションで車両座標系(前後X・左右Y・上下Z、右手系)に変換する。

## 4. キャリブレーション手順(実装すること)

1. 車を平らな場所に停め、ユーザーが「キャリブレーション」をタップ
2. 3秒間 `accelerationIncludingGravity` を平均 → 重力ベクトル `g`(端末座標系)を得る
3. `g` から「車両の下方向」が端末座標系のどの向きかが分かる(下 = g の向き)
4. 車両の前方向: 縦置き想定なら端末 -Z(画面の奥)を仮の前方向とし、
   `g` と直交化(グラム・シュミット法)して確定する
5. 前・下の外積で左右方向を求め、3×3回転行列 `R` を作る
6. 以後、全サンプルを `veh = R * device` で変換してから記録する
7. `R` と `g` は走行データのメタ情報として保存し、CSVコメント行にも出力する

追加の自動補正(推奨): 走行開始直後の直進加速時に前後方向の加速度が最大になるよう
前方向を微修正すると、取り付けの左右ズレも補正できる(フェーズ3以降の改善項目でよい)。

## 5. GPS

```js
const watchId = navigator.geolocation.watchPosition(onPos, onErr, {
  enableHighAccuracy: true, maximumAge: 0, timeout: 10000
});
// onPos: pos.coords.{latitude, longitude, speed, accuracy}, pos.timestamp
```

- `speed` は m/s。null のことがある(その場合は前回位置との差分から自前計算)
- `accuracy` が 20m を超えるサンプルは速度判定(自動開始/停止)に使わない
- 100m区間で約1Hzだと10点程度しか取れない。**速度・区間検出用**と割り切り、
  横Gなどの分析は加速度センサー側で行う

## 6. 記録セッションの流れ

```
[キャリブレーション済みチェック]
→ 記録準備(カメラ起動・WakeLock・GPS watch開始)
→ 5秒カウントダウン(ビープ音: Web Audio APIのOscillatorで生成、音声ファイル不要)
→ t0 = performance.now() を記録、センサーリスナー登録、MediaRecorder.start()
→ 走行
→ 停止(手動ボタン or 自動: speed<0.56m/s が3秒継続 ※一度 speed>1.4m/s を超えた後のみ)
→ リスナー解除・MediaRecorder.stop()・WakeLock解放 → 保存処理へ
```

- サンプルは `{t_ms, ax,ay,az(車両系), gx,gy,gz(車両系), 生値も別配列に保持}` の形で
  プリアロケートせず普通に push でよい(数千件なので性能問題なし)

## 7. モックモード(mock.js)

PCにはセンサーがないため、開発は必ずモックで行えるようにする:

- `devicemotion` 相当のイベントを 60Hz の `setInterval` ではなく
  `requestAnimationFrame` + 経過時間で生成し、本物と同じコールバックに流す
- 波形は「サイン波ベースの横G(パイロン5本分、±0.4G)+ ノイズ」で生成
- 「上手い走行」(振幅一定・位相規則的)と「ばらつき走行」(振幅±30%乱れ)の
  2プリセットを用意し、比較機能のテストに使う
- GPSモックは 0→40km/h→0 の台形速度プロファイルを1Hzで流す
- 切替は設定画面のトグル + URLパラメータ `?mock=1` の両方で可能にする
