# GCP（Cloud Run）へのデプロイ

## 構成

```
             ┌──────────── Cloud Run サービス dm-card-db ─────────────┐
ブラウザ ───→ │  /           Web UI（Basic 認証）                        │
スクリプト ─→ │  /api/*      検索 API（Basic 認証 or Bearer トークン）   │──→ /tmp/dm-data/dm.<version>.sqlite
Claude ─────→ │  /mcp        MCP（Bearer トークン）                       │      ↑ 起動時と10分ごとに確認し、
             │  /healthz    死活監視（認証なし）                         │      │ 新しい版があれば無停止で差し替え
             └──────────────────────────────────────────────────────────┘      │
                                                                             │
Cloud Scheduler（毎週月曜 4:17）→ Cloud Run ジョブ dm-card-db-update             │
   キャッシュ復元 → 差分クロール → キャッシュ保存 → DB構築 → 品質チェック → 公開 ──┘
                                                                  Cloud Storage gs://<bucket>/data/
                                                                    dm.sqlite / latest.json / build-report.md
                                                                    raw.tar.gz（クロールキャッシュ）
                                                                    history/<時刻>/（90日保持）
                                                                    rejected/<時刻>/（品質チェック落ちのレポート）
```

- **イメージは1つ、入口は2つ**です。サービスは `dist/server/index.js`、ジョブは `dist/jobs/update.js` から動きます。
- **DBはイメージに含めません。** サービスはCloud Storageに公開されたDBを読みます。このため、データの更新に再デプロイは不要です。コードを更新したときだけ再デプロイします。
- **品質チェックを通らないDBは公開しません。** 次のどれかに当たると公開を止めます。止めた場合も、公開中のDBはそのまま残ります。
  - 公式一覧より収録数が少ない
  - 前回より収録数・カード数が減った
  - パースエラーがある
  - 殿堂の対応づけに失敗した
  - キーワード抽出の適合率が90%未満
- **フロントとバックエンドを分けていません。** UIは静的ファイル3つだけなので、同じサーバーから配信しています。同じドメインなのでCORSも不要です。

## 認証

カードのテキストと画像の権利はタカラトミー等にあります。そのため、誰でも見られる状態では公開しません。

| 方式 | 用途 | 設定 |
|---|---|---|
| Basic 認証 | ブラウザ（UI・API） | `DM_AUTH_USER` / `DM_AUTH_PASSWORD`（Secret Manager） |
| Bearer トークン | API・MCP（Claude Code、スクリプト） | `DM_API_TOKEN`（Secret Manager） |
| `/mcp/<トークン>` | ヘッダーを送れないMCPクライアント | 同上（URL自体が秘密になる点に注意） |

- 認証情報が1つも設定されていないと、Cloud Run上では**起動を拒否**します。誤って公開する事故を防ぐためです。
- 認証なしで公開したいときだけ `DM_PUBLIC=1` を設定します。
- Cloud Runの `--allow-unauthenticated` は「ブラウザが届く」という意味で、アプリ側の認証は必ずかかります。
- Googleアカウントで制限したい場合は、IAP（Identity-Aware Proxy）を前に置く方法もあります。

## 手順

### 0. 前提

- GCPプロジェクトがあり、課金が有効になっていること。
- 作業する端末に `gcloud`（`gcloud auth login` 済み）、`git`、`openssl` があること。Cloud Shellならすべて揃っています。

### 1. 一括セットアップ（初回とコード更新時に実行）

```bash
git clone https://github.com/ichiro16go/dm-db && cd dm-db
PROJECT_ID=<プロジェクトID> ./scripts/gcp/setup.sh
```

スクリプトは次の作業を順に行います。どれも、何度実行しても同じ結果になります。

1. APIの有効化（Run / Cloud Build / Artifact Registry / Storage / Secret Manager / Scheduler）
2. バケット作成。非公開に設定し、history は90日で自動削除します。
3. サービスアカウントを3つ作成します。権限は必要最小限です。
   - web：バケットの読み取りだけ
   - job：バケットの読み書き
   - scheduler：ジョブの実行だけ
4. ログインパスワードとAPIトークンを生成し、Secret Managerに保存
5. イメージのビルド（Cloud Build → Artifact Registry）
6. 初期データの投入
   - 手元に `data/dm.sqlite` と `data/raw/` があれば、それをアップロードします。初回の1.5時間のクロールが不要になります。
   - なければ、ジョブを1回実行して全件クロールします（約1.5時間）。
7. 更新ジョブの作成と、毎週の定期実行の設定
8. サービスのデプロイ（メモリ1GiB、最小0台・最大2台）

最後に、URL、ログイン方法、MCPの登録コマンドが表示されます。

### 2. 使う

```bash
# ログインパスワード（ユーザー名は dm）
gcloud secrets versions access latest --secret=dm-auth-password
```

```bash
# Claude Code から MCP として使う
claude mcp add --transport http dm-cards https://<サービスURL>/mcp \
  --header "Authorization: Bearer $(gcloud secrets versions access latest --secret=dm-api-token)"
```

```bash
# 今すぐデータを更新する（通常は毎週月曜に自動）
gcloud run jobs execute dm-card-db-update --region asia-northeast1
```

## 運用

| やりたいこと | 方法 |
|---|---|
| 更新の結果を見る | `gcloud storage cat gs://<bucket>/data/build-report.md`。品質チェックに落ちた回は `data/rejected/` にレポートが残ります |
| 前の版に戻す | `gcloud storage cp gs://<bucket>/data/history/<時刻>/dm.sqlite gs://<bucket>/data/dm.sqlite`。10分以内にサービスが切り替わります |
| コードを更新する | `git pull` してから `setup.sh` を再実行 |
| パスワードを変える | `gcloud secrets versions add dm-auth-password --data-file=-` に新しい値を渡し、`gcloud run services update dm-card-db --region asia-northeast1` で新しいリビジョンを作る |
| ログを見る | Cloud Logging（JSON形式で出力しています） |

## 費用の目安（個人利用）

| 項目 | 内訳 | 目安 |
|---|---|---|
| Cloud Run サービス | 使わないときは0台。無料枠（月180万vCPU秒など）に収まる想定 | ほぼ0円 |
| Cloud Run ジョブ | 週1回の差分更新で数分〜十数分 | 無料枠内 |
| Cloud Storage | DB 56MB＋キャッシュ 40MB＋履歴 | 月数円 |
| Artifact Registry | イメージ約300MB（0.5GBまで無料） | ほぼ0円 |
| その他 | Secret Manager・Scheduler | 無料枠内 |

## 補足

- **メモリ**：Cloud Runの `/tmp` はメモリ上にあります。サービスはDB（56MB）を、差し替え中は2つ分持つので1GiBにしています。ジョブはクロールキャッシュを展開するので2GiBにしています。
- **Cloud Build の権限**：新しいプロジェクトでは、ビルドに使われる既定のサービスアカウントに Artifact Registry への書き込み権限がないことがあります。`gcloud builds submit` が権限エラーで止まったら、次を付与してください。
  - 付与先：`<プロジェクト番号>-compute@developer.gserviceaccount.com`
  - ロール：`roles/artifactregistry.writer` と `roles/logging.logWriter`
- **ローカルで本番に近い動作確認をする**：`DM_DATA_STORE` にローカルのフォルダを指定すると、Cloud Storageの代わりになります。`npm run job:update -- --store=./tmp-store` も同じです。
