# 家族のレシピ（第1段階）

家族3人の定番レシピをまとめるPWAです。素のJavaScriptで書いてあり、ビルドは不要です。

## ファイル構成

| ファイル | 内容 |
| --- | --- |
| index.html / css / js | アプリの画面 |
| js/config.js | ★ SupabaseのURLとキー（書き換えが必要） |
| js/amount.js | 分量の読み取りと換算 |
| js/search.js | 検索（表記ゆれ・同じ意味の言葉） |
| sw.js / manifest.webmanifest / icons | ホーム画面に追加・オフライン用 |
| supabase/*.sql | データベースの設定（番号順に実行） |
| supabase/functions/import-url | URL取り込みの処理（Edge Function） |
| .github/workflows/keepalive.yml | Supabaseの一時停止を防ぐ定期処理 |

## 準備の手順

### 1. データベース（済んでいれば飛ばす）
Supabaseの「SQL Editor」で、次の順に実行します。
1. `supabase/001_schema.sql`（一番下の家族3人のメールアドレスを書き換えてから）
2. `supabase/002_seed_synonyms.sql`
3. `supabase/003_save_recipe.sql` ← 新しく追加

### 2. URL取り込みの処理（Edge Function）
1. Supabaseの「Edge Functions」→「Deploy a new function」→「Via Editor」
2. 関数名を **import-url** にする
3. `supabase/functions/import-url/index.ts` の中身を貼り付けて「Deploy」

### 3. GitHubに置いて公開する
1. GitHubで新しいリポジトリを作る（例：family-recipe）。無料プランでGitHub Pagesを使うには **Public** にします。
   コードとPublishable keyは誰でも見られますが、データはログインした家族3人しか読めないので問題ありません。
2. `js/config.js` にSupabaseの値を書く（「Project Settings」→「API Keys」）
   - `SUPABASE_URL`：Project URL
   - `SUPABASE_KEY`：Publishable key（`sb_publishable_`で始まるもの）
3. このフォルダの中身をすべてリポジトリにアップロードする
4. リポジトリの「Settings」→「Pages」→ Source を「Deploy from a branch」、Branch を「main」「/(root)」にして保存
5. 数分後、`https://〈ユーザー名〉.github.io/family-recipe/` で開けるようになります

### 4. ログイン後の戻り先を登録する（Supabase）
「Authentication」→「URL Configuration」で次のように設定します。これをしないとログイン後に正しく戻ってきません。
- **Site URL**：`https://〈ユーザー名〉.github.io/family-recipe/`
- **Redirect URLs**：同じURLを追加

### 5. 休止対策（GitHub Actions）
リポジトリの「Settings」→「Secrets and variables」→「Actions」に次の2つを登録します。
- `SUPABASE_URL`
- `SUPABASE_KEY`

登録後、「Actions」タブで「Supabase keep-alive」を一度手動で実行し、成功するか確かめてください。
※ GitHubは、60日間更新のないPublicリポジトリでは定期実行を止めます。止まったらメールが来るので、「Actions」から再開してください。

### 6. スマホに入れる
- iPhone：Safariで開く → 共有ボタン → 「ホーム画面に追加」
- Android：Chromeで開く → メニュー → 「ホーム画面に追加」（または「アプリをインストール」）

## 更新するとき
画面のファイルを変えたら、`sw.js` の `CACHE` の番号（`family-recipe-v1` → `v2`）を上げてください。
スマホ側で古い画面が残るのを防げます。

## 第1段階でできること
- Googleログイン（家族3人だけ）
- 手入力での登録・編集、材料・手順のまとめて貼り付け
- URLからの取り込み（レシピの構造化データがあるサイト）
- 写真の保存（完成写真・元のレシピの写真）
- 検索（レシピ名・材料・タグ、表記ゆれ、同じ意味の言葉、複数語の絞り込み）
- 人数を変えたときの分量換算
- 「作った！」ボタン（取り消し可、日付・メモの変更可）、作った回数と最後に作った日
- 並び替え（新しく登録した順・よく作る順・最近作っていない順）
- オフラインでの閲覧、調理中に画面が消えない
- ゴミ箱、同じ意味の言葉の追加・削除、JSONでの書き出し
