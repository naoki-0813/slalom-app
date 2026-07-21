# 公開(ホスティング)と実機テスト

スマホのカメラ・センサーは **HTTPSのURLでしか動かない**(PCのlocalhostだけ例外)。
そのため実機テストには必ずどれかの方法で公開する。ユーザーはIT初心者なので、
手順は1コマンドずつ、画面操作は日本語UIの文言で案内すること。

## 方式の選び方

| 方式 | 費用 | 向いている人 |
|---|---|---|
| A. GitHub Pages | 完全無料 | とにかく簡単に始めたい |
| B. AWS Amplify Hosting | 無料枠でほぼ0円 | AWSに慣れたい(ユーザーの希望に合致) |
| C. AWS S3 + CloudFront | 無料枠でほぼ0円 | AWSの仕組みを学びたい(手順は最多) |

ユーザーは「AWSをほぼ無料の範囲で使いたい」希望があるため、**本命はB(Amplify)**、
最速の動作確認にはAを使う、という2段構えを提案するのが良い。

## A. GitHub Pages(最速)

1. GitHubにリポジトリを作成(Public)し、コードを push
2. リポジトリの Settings > Pages > Branch を `main` / `(root)` にして Save
3. 数分後 `https://<ユーザー名>.github.io/<リポジトリ名>/` で公開される
4. 更新は push するだけ(反映に1〜2分)

注意: Public リポジトリになる(コードが世界に公開される)ことをユーザーに伝える。

## B. AWS Amplify Hosting(本命)

費用: 無料枠(ビルド時間・配信容量とも小規模利用なら実質0円)。
このアプリはビルド不要の静的サイトなので消費はごく僅か。

手順(GitHub連携方式):

1. AWSアカウントでコンソールにログイン → 「Amplify」を検索して開く
2. 「新しいアプリを作成」→「GitHub」を選択し、リポジトリとブランチを認可・選択
3. ビルド設定: ビルドコマンド不要。`amplify.yml` は以下でよい:
   ```yaml
   version: 1
   frontend:
     phases:
       build:
         commands: []
     artifacts:
       baseDirectory: /
       files:
         - '**/*'
   ```
4. デプロイ完了後 `https://main.xxxxx.amplifyapp.com` が発行される(自動でHTTPS)
5. 以後 push すると自動で再デプロイ

コスト警告の設定も必ず案内する:
Billing > Budgets で「$1 の予算 + メール通知」を作っておくと、想定外課金に気づける。

## C. S3 + CloudFront(学習用・任意)

要点だけ(詳細手順はユーザーが選んだ時にAWSコンソールを見ながら案内する):

1. S3バケット作成 → 静的ファイルをアップロード
2. **S3の静的ウェブサイトエンドポイントはHTTPのみ** → そのままではセンサーが動かない
3. CloudFront ディストリビューションを作り、オリジンにS3を指定(OAC推奨)、
   Viewer protocol policy = Redirect HTTP to HTTPS
4. 発行される `https://xxxx.cloudfront.net` を使う
5. 更新時は S3 に再アップロード + CloudFront の Invalidation(`/*`)

費用: 無料枠内でほぼ0円だが、Invalidation は月1000パスまで無料、
S3は数円/月レベル。Bと同様に Budgets 設定を案内する。

## 実機テストの案内テンプレート

フェーズ完了時にユーザーへ渡す確認手順の例:

```
1. スマホ(Android)のChromeで https://…… を開く
2. 「カメラ」「位置情報」の許可を求められたら「許可」をタップ
3. 設定画面でモックモードがOFFになっていることを確認
4. 平らな場所で「キャリブレーション」→ 3秒待つ
5. 「記録開始」→ カウントダウン後、スマホを軽く左右に振って横Gが動くか確認
6. 停止 → 結果画面でグラフとCSV保存を確認
```

## 開発中のPC確認

- `cd プロジェクトフォルダ` → `python3 -m http.server 8000` → `http://localhost:8000`
- localhost はHTTPSなしでもセンサー・カメラAPIが動く(PCにセンサーはないのでモックモードを使う)
- スマホと同一Wi-Fiでも `http://PCのIP:8000` は **HTTPSでないため実機では動かない**。
  実機確認は必ず公開URLで行う(この罠にはまりやすいので先に伝えること)
