# DM Card DB

デュエル・マスターズの全カードを、構造化した検索可能なDBにするプロジェクトです。
人がデッキを組むときの絞り込み検索と、AIがカードを探してデッキを組むための土台（MCPサーバ）を目的にしています。

- **データ源**: [公式カード検索](https://dm.takaratomy.co.jp/card/)（全収録・全商品）と[殿堂レギュレーション](https://dm.takaratomy.co.jp/rule/regulation/)
- **DB**: SQLite（1ファイル、`data/dm.sqlite`）
- **検索**: Scryfall風のクエリ言語（AND / OR / NOT / 括弧 / 数値比較 / 正規表現）
- **UI**: ローカルWeb UI（検索・カード詳細・絵柄違い一覧・デッキ検証・データ品質）
- **AI**: MCPサーバ（`search_cards` / `get_card` / `validate_deck` / `list_keywords`）

> 個人利用を前提にしています。カードのテキスト・画像の権利はタカラトミー等にあります。DBやカード画像は再配布しないでください（UIの画像は公式サイトの画像URLを直接表示しています）。

## 使い方

```bash
npm install
npm run crawl       # 公式サイトから取得 → data/raw/（再開可能・取得済みはスキップ。初回は約1.5時間・約100MB）
npm run build:db    # data/raw → data/dm.sqlite（ネットワーク不要・約25秒・約56MB）
npm run serve       # http://localhost:8787
npm test            # 単体 + フィクスチャ結合 + 本番DBの完全性テスト
```

新弾が出たら、または殿堂が改定されたら、次を実行します。商品一覧、能力の分類、殿堂は取り直し、詳細ページは未取得の分だけを取得して、DBを再構築します。

```bash
npm run update
```

### AI（MCP）から使う

```bash
claude mcp add dm-cards -- npx tsx /absolute/path/to/dm-card-db/src/mcp/server.ts
```

| ツール | 内容 |
|---|---|
| `search_cards(query, limit, page)` | クエリ言語で検索し、能力テキスト込みで返す |
| `get_card(name \| id)` | 全面の能力、キーワード、効果タグ、全収録（絵柄違い）、枚数上限 |
| `validate_deck(format, decklist)` | オリジナル / アドバンスの構築ルールと殿堂をチェック |
| `list_keywords(contains?)` | 使えるキーワード・系統・効果タグ一覧 |

## クエリ言語

スペース区切りは AND、`or`（`|`）で OR、`-`（`not`）で否定、`( )` でグループ化します。全角で入力しても動きます。

```
kw:ブロッカー (c:光 or c:水) cost<=3 pow>=2000
kw:パワーアタッカー>=2000 -kw:スレイヤー
kw:ジャストダイバー kw:S・トリガー              # AND
(kw:ジャストダイバー or kw:マッハファイター) c<=水闇
kw:ブレイカー breaks>=3 cost<=6                 # 系統検索 + ブレイク数
grant:スピードアタッカー race:ドラゴン          # 他のカードに与える
tag:removal_destroy is:spell kw:S・トリガー f:original
illust:Shishizaru unique:prints                  # イラストレーターの全絵柄
set:DM26-RP1 rarity:SR order:cost dir:asc
text:/パワー\d+以下.*破壊/                       # 正規表現
```

| フィールド | 意味 |
|---|---|
| `name` / `n` / 語のみ | カード名の部分一致（ひらがな/カタカナ・「・」・空白の違いを無視）。`=` で完全一致（片面名も可） |
| `text` / `t` | 能力テキストの部分一致。`/regex/` も使える |
| `kw` | **自身が持つ**キーワード能力（常時・条件付きの両方）。系統名（`ブレイカー`、`S・トリガー`、`進化`、`侵略`…）で一括検索。`kw=` は系統を展開しない完全一致。`kw:パワーアタッカー>=2000` のように数値も比較できる |
| `kwa` | 条件なしで**常に**持つキーワードだけ |
| `grant` | 他のカードにキーワードを**与える** |
| `okw` | 公式サイトの「特殊能力」分類（正解データ） |
| `c` / `civ` | 文明。`:` は含む、`=` はちょうど、`<=` はその文明だけで組める（無色を含む）。`多色` / `単色` / `無色` も指定できる |
| `cost` `pow` `mana` `breaks` | 数値比較（`= != < <= > >=`、`cost:3-5`）。ツインパクトはどちらかの面が一致すればヒット |
| `type` `race` | 種類・種族の部分一致（`=` で完全一致） |
| `set` `rarity` `illust` `flavor` | 収録単位の条件（`set:dm26*` で前方一致） |
| `first` | その弾で**初登場**したカード（再録を除く） |
| `tag` | 効果タグ（draw, removal_destroy, removal_bounce, mana_boost, hand_disruption, tutor, cheat …） |
| `f` | `original` / `advance` で使えるカード（プレミアム殿堂を除く） |
| `reg` | `none` / `restricted`（殿堂）/ `premium`（プレミアム殿堂） |
| `is` | `twinpact` `psychic` `gr` `creature` `spell` `evolution` `multicolor` `vanilla` `reprint` … |
| `order` `dir` `unique` | 並び順（release/first/cost/power/name/printings）、昇順・降順、`unique:prints` で絵柄単位 |

## データモデル

```
cards（論理カード＝同名カード。デッキ枚数制限もこの単位）
 ├─ faces（面：ツインパクトの上下、サイキック/ドラグハートの表裏）
 │    ├─ face_civs / face_races
 │    ├─ abilities（能力を1行ずつ）
 │    ├─ face_keywords（keyword, scope = self|others|ref, conditional, value, value_text）
 │    └─ face_tags（効果タグ・ルール推定）
 ├─ printings（収録：弾、番号、レアリティ、イラストレーター、画像、フレーバー）
 │    └─ printing_faces
 ├─ card_official_keywords（公式「特殊能力」検索の結果＝正解データ）
 └─ regulation_entries / regulation_combos（殿堂・プレ殿・プレ殿コンビ）
sets（商品）  keywords / keyword_families（系統）  tags  illustrators  quality_issues  meta
```

設計上のポイント:

- **キーワードの3区分**: 同じ「ブロッカー」でも、印刷された能力（`self`・条件なし）、「このクリーチャーは『ブロッカー』を得る」（`self`・条件付き）、「他に『ブロッカー』を与える」（`others`）、「『ブロッカー』を持つクリーチャーを破壊」（`ref`＝言及のみ）を区別しています。`kw:` の検索結果は「本当にそのカードが持っている」ものだけになります。
- **パラメータ付きキーワード**: `パワーアタッカー+3000` → value=3000、`革命チェンジ：火または自然のコスト5以上のドラゴン` → value_text、`ササゲール3` → value=3。
- **ブレイク数**: クリーチャーの常時ブレイク数（W=2, T=3, Q=4, ワールド=99）を `faces.breaks` に持たせています。
- **フォーマット**: `zone`（main / hyperspatial / gr）と `starts_in_battle_zone`（禁断の鼓動など）から、オリジナル／アドバンスで使えるかを判定しています。
- **再現性**: 取得したHTMLは `data/raw/` にそのまま保存し、DBは毎回ここから作り直します。パーサを直したらネットワークなしで再構築できます。

## 現在のデータ（2026-11-24 取得）

| 項目 | 件数 |
|---|---:|
| 収録（printings） | 24,116（公式一覧 24,123 件のうち、公式ページ自体が空の 7 件を除く全件） |
| カード（同名で1つ） | 11,867（ツインパクト 559 / 超次元 220 / GR 160） |
| 商品 | 400（全商品に収録あり） |
| イラストレーター | 1,219 |
| 殿堂 / プレミアム殿堂 | 86 / 41（公式ページの全エントリを解決） |
| パースエラー | 0 |

キーワード抽出の精度は、公式の「特殊能力」検索と比較して測っています。定義が公式と異なる3つを除くと、適合率98.3%、再現率97.2%です。除いた3つは次のとおりです。

- **パワーアタッカー**：公式は「パワーを+N」する効果をすべて含めています。
- **進化**：公式は旧カードの「進化-…」をほとんど分類していません。
- **サイキック・セル**：テキストではなく、カードの役割を表す分類です。

公式データの欠けや誤りは補正し、すべて `quality_issues` に記録しています。

- ツインパクト下半分の種類・文明が空 → 別の収録から補完、または「呪文」と推定
- 呪文側に表示されているパワー → 削除
- 旧版テキストとの差異（2,769件） → 最新の収録を代表にする

## 品質保証

「DBが正しい」ことを、テストとビルドレポートで確認できるようにしています。

| テスト | 内容 |
|---|---|
| `test/parse.test.ts` | 実際のカードページ（ツインパクト、サイキック、ドラグハート、GR、DM-01…）のパース、キーワード抽出（常時/条件付き/付与/参照）、タグ、殿堂ページ |
| `test/query.test.ts` | クエリ構文（AND/OR/NOT/括弧/全角/正規表現/構文エラー） |
| `test/search.test.ts` | 実カード18枚から**DBを丸ごと構築**し、各フィールドの検索結果を厳密に照合 |
| `test/api-deck.test.ts` | HTTP API とデッキ検証（40枚、4枚制限、超次元/GRのゾーン、フォーマット） |
| `test/mcp.test.ts` | MCPサーバ（インメモリ接続でツールを実行） |
| `test/full-db.test.ts` | **本番DBの完全性**：公式一覧の全収録がDBにあるか、全商品に収録があるか、殿堂が全件対応づいたか、構造の不変条件、有名カードの抜き取り確認、キーワード抽出の公式との一致率、検索速度 |

`npm run build:db` を実行すると `data/build-report.md` が出力されます。中身は次の2つです。

- **公式「特殊能力」検索との一致率**: キーワードごとの適合率・再現率
- **品質課題の件数**: 旧版テキストとの差異（`text_variant`）など

UIの「データ品質」タブからも確認でき、抽出漏れのカードをワンクリックで検索できます。

## ディレクトリ

```
scripts/      フィクスチャ再取得、キーワード抽出の差分調査（keyword-misses.ts）
src/crawl/    公式サイトのクローラ（再開可能、並列数と間隔を制御）
src/parse/    HTMLパーサ、キーワード抽出、効果タグ、殿堂ページ
src/db/       スキーマとDB構築（raw → SQLite）
src/search/   クエリパーサ → SQLコンパイラ → 検索エンジン
src/deck/     デッキ検証
src/server/   HTTP API + 静的UI
src/mcp/      MCPサーバ
web/          フロントエンド（ビルド不要）
test/         テストと実カードのフィクスチャ
```

## 今後

- 効果タグの精度向上（LLMで推定し、人がレビューする。`face_tags.source` で区別できる）
- 漢字名の読みがな検索（公式検索はふりがなを持っているが、詳細ページには出ていない）
- 相場追跡（`printings.id` に価格履歴を紐づける）
- 発売日の精緻化（現在は型番と公式の並び順から推定。`sets.release_estimated` で区別）
- シミュレータ向けの能力の構造化（`abilities` を効果DSLへ）
