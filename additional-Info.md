# 1.EXPO_PUBLIC_ENABLE_DEV_SWITCH は true で内部テスト中は OK。本番リリース前に false に戻すのを忘れないで。

# 2.インストール後のアプリの起動には monkey は使わない。起動は**am start -W**に統一　　ぐるぐるが発生する

### ADB launch & log (no monkey)

$adb = "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe"
$serial = "192.168.1.208:34111"
$pkg = "com.kenta0015.geoattendance.internal"
$act = "$pkg/$pkg.MainActivity"
$out = ".\rta_after_launch.txt"

& "$adb" connect $serial | Out-Null
& "$adb" -s $serial shell am force-stop $pkg
& "$adb" -s $serial shell am start -W -n $act -a android.intent.action.MAIN -c android.intent.category.LAUNCHER
Start-Sleep -Seconds 45
& "$adb" -s $serial logcat -d -v time ReactNative:V ReactNativeJS:V Expo:V OkHttp:V AndroidRuntime:E ActivityManager:I WindowManager:W \*:S > $out
Get-Content $out -Tail 120

補足（運用ルール・超短）

pm clear は必要時のみ（初回 OTA 取得で待つ →“ぐるぐる”に見えるため）。

負荷試験やランダム操作以外で**monkey は使わない**。

再現テストは「手タップ」と同等の上記コマンドに固定。

# 3.WEB でアプリの開き方

### 1) Web 用に書き出し

npx expo export --platform web
cd C:\Users\User\Downloads\RTA
npx serve -s dist -l 5173

### 2) ローカルで配信（どれか入ってる方）

npx http-server dist -p 5173

### もしくは

npx serve dist -l 5173

# 4.USB の接続

端末で USB 接続後（USB debbugging ）

$pt = "C:\Users\User\AppData\Local\Android\Sdk\platform-tools"
$env:Path = "$pt;$env:Path"
adb version
adb devices

### そこから dec client で接続する場合

adb -d reverse --remove-all
adb -d reverse tcp:8081 tcp:8081

adb -d shell am force-stop com.kenta0015.geoattendance.internal
adb -d shell am start -W -n com.kenta0015.geoattendance.internal/.MainActivity
adb -d shell am start -W -a android.intent.action.VIEW -d "rta://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8081"

その後別ターミナルで下記を行い、アプリ起動させる（これをやらないと黒い画面になるだけ）
npx expo start --dev-client --clear

それでもアプリが起動しなさそうなら端末でスワイプして終了し、アプリをもう一度開きなおす

※アンドロイドの画面がスリープモードになると接続が切れる。その場合はアプリをスワイプで閉じて、また開きなおす。もしくは adb reverse tcp:8081 tcp:8081 を打ってアプリをスワイプで閉じて、また開きなおすもしくはリロード

# 5.Logcat

強化版 logcatA（最小セット：あなたの既定）
& "$adb" -s $serial logcat -c

# ← ここで 5 分ほど普通に操作（起動 → タブ遷移 →QR 画面 → 戻る 等）

& "$adb" -s $serial logcat -d -v time AndroidRuntime:E ReactNative:V ReactNativeJS:V \*:S `
| Tee-Object .\rta_crash_scan.txt

Select-String -Path .\rta_crash_scan.txt -Pattern 'FATAL EXCEPTION|AndroidRuntime|SoLoader|SIGSEGV|ANR' `
| Select-Object -First 50

強化版 logcatB（チェックイン周りを濃く）
& "$adb" -s $serial logcat -c

# ← 端末で「Check In」を 1 回タップ（10 秒以内）

Start-Sleep -Seconds 10
& "$adb" -s $serial logcat -d -v time ReactNativeJS:V ReactNative:V AndroidRuntime:E "\*:S" `
| Tee-Object .\rta_checkin_full.txt | Out-Null

Select-String -Path .\rta_checkin_full.txt -Pattern `  'qr_checkin_with_pin|Checked in|ARRIVED|TOKEN_INVALID|signature|expired|RAW_SCAN|token='`
| Select-Object -First 120

強化版 logcatC（events バッファも保存）
& "$adb" -s $serial logcat -c

# ← 端末で再現操作（〜10 秒）

Start-Sleep -Seconds 10
& "$adb" -s $serial logcat -d -v time AndroidRuntime:E ReactNative:V ReactNativeJS:V "\*:S" `
| Tee-Object .\rta_full.txt | Out-Null

& "$adb" -s $serial logcat -b events -d -v time "\*:S" `  | Select-String 'am_anr|am_crash|am_fully_drawn'`
| Tee-Object .\rta_events.txt | Out-Null

Select-String -Path .\rta_full.txt -Pattern 'FATAL EXCEPTION|AndroidRuntime|SoLoader|SIGSEGV|ANR|qr_checkin_with_pin|token=' `
| Select-Object -First 120

# 6.サインインの Deep Link

# adb のフルパス（Android Studio 標準）

$adb = "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe"

# 端末確認（出てくるはず: "device"）

& $adb devices

# 物理端末なら -d、エミュなら -e

& $adb -d shell am start -a android.intent.action.VIEW -d "rta://join"

# devclient にアクセスできなかった件

何が原因だった？

ほぼ確実に（確信度 95%）

Metro に到達できていなかったのが本質。
具体的には

adb reverse が未設定／別端末に刺さっていた、

PowerShell で $adb が未定義のまま & $adb ... を打って失敗、

そのまま rta://... を開いても 端末 →PC の 8081 に橋が無くて JS バンドルが取れず、Unable to load script → 数秒後に黒画面、という流れ。
（途中で monkey を使うと別 Activity 経由になって状態がややこしくなるのも悪化要因。）

# 次回“確実に”つながる 2 ステップ

（PowerShell・USB 接続前提。コマンドはそのまま貼って OK）

## 1. Metro を起動して ADB 逆ポートを張る

# Metro（必要なら --port 変更可）

npx expo start --dev-client --clear

# ADB 実体と端末シリアルを確定

$adb = Join-Path $env:USERPROFILE 'AppData\Local\Android\Sdk\platform-tools\adb.exe'
if (!(Test-Path $adb)) { $adb = (& where.exe adb 2>$null | Select-Object -First 1) }
$serial = (& "$adb" devices | Select-String 'device$' | Select-Object -First 1).ToString().Split("`t")[0]

# 逆ポートをクリーン＆張り直し（Metro が 8081 ならそのまま）

& "$adb" -s $serial reverse --remove-all
& "$adb" -s $serial reverse tcp:8081 tcp:8081

# Metro 稼働確認（PC 側で OK が出れば良い）

Start-Process "http://localhost:8081/status"

## 2. Dev クライアントを前面 → ディープリンクで接続

# アプリ（Dev Client）を前面起動

& "$adb" -s $serial shell am start -W -n com.kenta0015.geoattendance.internal/.MainActivity

# 127.0.0.1 を使って Metro へ（※reverse 前提）

& "$adb" -s $serial shell am start -W -a android.intent.action.VIEW `
-d "rta://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8081"

## アプリリリースと１２人テスト

パッケージ名：com.kenta0015.geoattendance.internal

内部テストトラック：versionCode 3 (1.0.0) までアップ済み

アプリ自体は Google Play 経由でインストール・動作確認済み

ここに クローズドテスト + 12 Testers を重ねて、本番リリースに進むプランです。
（Google の要件：クローズドテストで 12 人以上が 14 日間参加していること
BuddyBoss
）

### フェーズ 1：クローズドテストトラックを作る

目標： 「クローズドテスト」で versionCode 3 のリリースを作成しておく。

Play Console でアプリを開く

左メニュー → 「テストとリリース > クローズドテスト」 に進む。

クローズドトラックを作成

まだトラックが無ければ「トラックを作成」→ 名前は closed-12testers などで OK。

すでにあれば「トラックを管理」から入る。

新しいリリースを作成

「新しいリリースを作成」→ App Bundle のところで
ライブラリから versionCode 3 (1.0.0) を選択（または同じ AAB をアップロード）。

リリース名：3 (1.0.0) のままで OK。

リリースノート：Initial closed test build for GeoAttendance 1.0.0. など簡単で OK。

保存 → 審査へ

画面下部で「次へ」→ 「保存して公開」 まで進める。

これで クローズドテスト版 3 (1.0.0) が審査待ちになる。

※ このフェーズでは、内部テストトラックはそのまま残しておいて問題ありません。

## フェーズ 2：12 Testers に依頼する準備

12 Testers は「12 人の実機テスターが 14 日間テストする」サービス。
Google Play

Starter Plan を使う前提で動きます。

クローズドリリースが “利用可能” になったら

クローズドテスト画面の「テスター」タブから：

テスターリスト方式 なら：メールリストを作成（12testers など）。

リンク方式 なら：Google が承認後に オプトイン URL（テスト参加リンク） が出ます。
BuddyBoss

12 Testers 側で必要な情報を確認

公式サイトのフォーム / オーダーページで通常必要になる情報：

アプリ名・パッケージ名：com.kenta0015.geoattendance.internal

対象プラン：Starter Plan (1 app)

対象ストア：Google Play / Closed testing

テスト用の Play ストアリンク（オプトイン URL）
もしくは、テスター用 Gmail アドレス一覧を受け取るパターンもあります。

どちらの方式で行くかの方針

リンク方式 OK の場合（たぶんこれが普通）：

クローズドテストのオプトイン URL を 12 Testers に渡す。

メールアドレス方式の場合：

12 Testers から 12 個の Gmail アドレスを受け取る。

Play Console の「メールリスト」にそれら 12 件を登録。

「保存」してテストを開始。

## フェーズ 3：14 日間テスト期間の運用

目標： 「12 人以上のテスターが 14 日間クローズドテストに参加」という条件を満たす。
BuddyBoss

原則としてこの期間は “大きなアップデートはしない”

新しい AAB をクローズドトラックに出すと、
「どのバージョンで 14 日間テストしたか」が分かりにくくなります。

重大バグでない限り、versionCode 3 (1.0.0) を 14 日間固定で使うイメージにしておく。

内部テストトラックでの開発は継続して OK

次バージョン（たとえば 1.0.1 / versionCode 4）のテストは、
これまでどおり 内部テストトラック で行えば、クローズドテストには影響しません。

クラッシュ・ANR のチェック

Play Console → 「モニタリング > アプリの品質」 などでクラッシュ状況を確認。

もし致命的なクラッシュが連発していたら、その時点で相談して、
「リリースを作り直すか／このまま 14 日完走するか」を決める。

12 Testers 側のダッシュボード

テスト進捗（何人インストール済みか、何日経過したか）が見られるはずなので
「予定通り 12 人に達しているか」を確認しておく。

## フェーズ 4：クローズドテスト完了 → 製品版アクセス申請

14 日＋ α 経過し、12 人条件も満たしたタイミングで進める内容です。

Play Console ダッシュボードを確認

「製品版へのアクセスを申請」といったカードが出てくるはずです。
BuddyBoss

申請フォームの回答

質問内容の例：

クローズドテストの内容（期間・人数・主なフィードバック）

アプリの用途・対象ユーザー

リリース前に行ったテストや品質確保の方法 など

ここは英語での説明が必要になるので、
実際にフォームが出たらスクショ or 質問文を送ってくれれば、一問ずつ英文を一緒に作る。

申請後のステータス管理

通常は 1 週間以内に結果がメールで届くとされています。
BuddyBoss

## フェーズ 5：本番（Production）リリース

製品版アクセスが承認されたあとにやることです。

最終ビルドを決める

「クローズドテストと同じ versionCode 3 をそのまま本番へ出す」

重大な問題がなければこれが一番安全。

もし内部テストで 1.0.1 などを作っていた場合：

その版を eas build --profile production でビルドして、
versionCode 4 などとして本番トラックに出す。

Production トラックにリリース作成

左メニュー → 「テストとリリース > 製品版」

「新しいリリースを作成」 → App Bundle を選択 → リリースノートを記入

「保存して公開」で本番リリースを開始。

今後のアップデート方針（ざっくり）

新機能や大きい変更：

まず 内部テストトラック で検証。

安定してきたら クローズドテストトラック で短期テスト。

問題なければ 本番トラック に反映。

緊急バグ修正：

必要なら直接クローズド／本番トラックに小さい修正だけ出す。

# ① どの画面が Session / Guest を参照しているか

| 画面 / ルート                             | 役割                                       | 参照 ID                                             | 根拠（主なファイル）                                                                                                |
| ----------------------------------------- | ------------------------------------------ | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| **/(tabs)/events**（タブ「History」）     | 履歴一覧（作成/参加の集約）                | **Guest**（端末ローカルの擬似 UID）                 | `app/(tabs)/events.tsx` → `screens/EventsList.tsx`（`getGuestId()`, `getGuestIdShort()`）                           |
| **/(tabs)/organize**（タブ「Organize」）  | イベント作成＆最近のイベント表示           | **Guest**（作成者 `created_by` に使用）             | `app/(tabs)/organize/index.tsx`（`createdBy = await getGuestId()` → `createEvent({ p_created_by: createdBy, … })`） |
| **/(tabs)/organize/events/[id]**          | イベント詳細（参加者側のチェックイン含む） | **Guest**（出席 `attendance` 挿入時の `user_id`）   | `app/(tabs)/organize/events/[id].tsx`（`user_id: await getGuestId()`）                                              |
| **/(tabs)/organize/events/[id]/checkin**  | 主催者のチェックインリスト                 | **ID 不要**（ユーザー ID は使わず、eventId で集計） | `app/(tabs)/organize/events/[id]/checkin.tsx`（eventId ベースの一覧・集計）                                         |
| **/(tabs)/organize/events/[id]/invite**   | 招待用情報                                 | **ID 不要**（eventId のみ）                         | `app/(tabs)/organize/events/[id]/invite.tsx`                                                                        |
| **/(tabs)/organize/events/[id]/settings** | イベント設定                               | **ID 不要**（eventId のみ）                         | `app/(tabs)/organize/events/[id]/settings.tsx`                                                                      |
| **/(tabs)/organize/admin/[eventId]/live** | Live 管理（リダイレクト）                  | **ID 不要**（eventId のみ）                         | `app/(tabs)/organize/admin/[eventId]/live.tsx`（`/organize/events/${eventId}/live` へリダイレクト）                 |
| **/(tabs)/profile**                       | 現在ロール／Guest ID 表示                  | **Guest**（表示＆トグル）                           | `app/(tabs)/profile/index.tsx`（`useRoleStore`, `getGuestId` の表示）                                               |
| **/(tabs)/debug**                         | セッション/環境の可視化                    | **Session**（表示）※動作は ID 非依存                | `app/(tabs)/debug.tsx`（`supabase.auth.getSession()` 表示）                                                         |

参考：Guest ID の実体は stores/session.ts のローカル永続（AsyncStorage）で、Supabase の Session UID とは独立です。

併存ルート：/app/organize/... や /app/events/[id].tsx などタブ外の旧ルートも残っています（例：app/organize/events/[id]/scan.tsx は Guest で出席登録）。通常運用は (tabs) 配下に統一されているため、ディープリンクは (tabs) 側へ合わせるのが安全です。以前の警告「No route named …/qr」はこの二系統併存が原因です。

# eventId が必須の画面

必須（eventId に完全依存）

/(tabs)/organize/events/[id]

/(tabs)/organize/events/[id]/checkin

/(tabs)/organize/events/[id]/invite

/(tabs)/organize/events/[id]/settings

/(tabs)/organize/admin/[eventId]/live（= [id]/live へ転送）

旧ルート群：/organize/events/[id]/scan など

不要（eventId なしで成立）

/join（サインイン／DEV トークン再署名時のみ Session を使用）

/(tabs)/events（History：Guest で自分の「作成/参加」から集計）

/(tabs)/organize（作成時に Guest を created_by へ）

/(tabs)/profile（表示のみ）

/(tabs)/debug（表示のみ）

#　違うイベントの QR でもログインできてしまう問題

事実確定済み：Organizer 経路で **p_event_id がトークン側の event（B）**としてサーバに届いている（checkin_audit.note で確認済み）。

サーバは「token の event と p_event_id が一致なら受理」なので、A 画面でも B に記録されます。

したがって、残っている原因は **クライアントのどこか別経路が token の event を p_event_id に入れている（またはディープリンクで attend/checkin が動いている）**こと。

再開時の最短 3 タスク（どれか 1 つで OK）：

Organizer スキャナの RPC 直前ログで p_event_id を一度だけ出力（ルート id と一致するか）。

Supabase の API ログで実機スキャン直後のリクエストの body を確認（p_event_id が何で送られているか）。

ディープリンクが走っていないか、Organizer 画面だけ リンク自動遷移を無効化して再テスト。

# expo で test するとき

$pt = "$env:LOCALAPPDATA\Android\Sdk\platform-tools"
$adb = Join-Path $pt "adb.exe"
$env:Path = "$pt;$env:Path"
& $adb start-server
& $adb devices

$exp = "exp://192.168.1.203:8081"   # ←あなたの LAN URL に置換
$id = "6252e880-30c7-41e5-95c2-b1cad25de83f" # 対象イベント ID
& $adb shell am start -W -a android.intent.action.VIEW `
  -d "$exp/--/organize/events/$id/checkin"

<event id>
6252e880-30c7-41e5-95c2-b1cad25de83f

# /organize と /events を単一 EventDetail へ共通化

目的
重複した実装を排除し、修正を一箇所で完結。URL は現状維持（参加者 /events/[id]、主催者 /organize/events/[id]）。

構成

components/event/EventDetail.tsx：単一の本体（取得・RSVP・GPS/QR・ロール別ボタン・開発メトリクス）。

ラッパ：

app/(tabs)/events/[id].tsx → role="attendee" で EventDetail を描画

app/(tabs)/organize/events/[id].tsx → role を渡して EventDetail を描画

EventDetail の責務

イベント取得（alias 統一：venue_lat:lat, venue_lng:lng, venue_radius_m:radius_m 等）

RSVP 読み/保存（event_members.upsert）

出席登録（attendance へ GPS/QR 挿入）

ロール別 UI：

参加者：RSVP / GPS チェックイン / スキャナ / Google Maps

主催者：スキャナ / Check-in List / Invite / Settings / Google Maps

getEffectiveUserId() でユーザー ID 統一

可視性ルール（ボタン欠落の再発防止）

role 明示チェックで条件出し分け。

必須ボタンはマウント固定（レイアウトずれで消えない）。

移行ステップ（小さく安全に）

既存本体を EventDetail.tsx に抽出（見た目不変）。

/organize/.../[id].tsx を EventDetail 利用に置き換え検証。

/events/[id].tsx を薄いラッパ化（role="attendee"）。

共有フックやヘルパは後追いで分離（任意）。

受け入れチェック（最小）

参加者 URL：RSVP/GPS/Scanner/Maps が表示・動作。

主催者 URL：Scanner/Check-in List/Invite/Settings/Maps が表示・動作。

GPS/QR 後に「Checked-in」ピルが即反映。

エイリアス不整合なし・未定義なし。

OTA（EAS Update）で両 URL 同時に反映。

既知の落とし穴（再発防止メモ）

checked_in_at_utc は DEFAULT now()（既存は埋めてから NOT NULL 化）。

Dev 端末は必ず getEffectiveUserId() を使う（auth→guest フォールバック）。

QR は EXPO_PUBLIC_QR_SECRET と currentSlot を共通で。

ロールバック
緊急時は /events/[id].tsx を一時的に /organize/events/[id] へ router.replace()。

# 「Swipe で落とすと EXIT が来ない」の有力原因（優先順）：

1. タスク定義が“画面内”にある

TaskManager.defineTask('RTA_GEOFENCE', …) が画面（例 /organize/events/[id].tsx）に置かれていると、プロセスが落ちた後は定義自体が読み込まれないため、ENTER/EXIT ブロードキャストが届いてもヘッドレス実行できない。

対策：トップレベルのモジュール（例 src/tasks/geofence.ts）に定義し、アプリのエントリ（app/index.tsx など）からインポートして常時登録しておく。

2. Swipe Kill 後に“プロセス復帰の足掛かり”が無い

Android はユーザー操作でタスクを掃くと、常駐していない限りプロセスを即終了。純ジオフェンスは OS 側で保持されるが、Expo のヘッドレス JS を起こせない端末状態だと処理が走らないことがある。

対策：Arm 時に 軽量の startLocationUpdatesAsync（foregroundService 付き）を並走させ、数分〜継続的にプロセス生存/再起動のフックを作る（バッテリー最適化は Unrestricted で回避済み）。

3. Expo Task Manager の制約（Killed 状態）

Expo のタスクはユーザーが明示終了した状態では走らない場合がある（端末/OS バージョン差あり）。Pixel でも再現例あり。

対策：① のトップレベル定義＋ ② の前景サービス併用で実務上は安定。

4. 再アームの永続化不足

プロセス終了で登録が落ちているのに UI は「Armed」のまま…という齟齬。

対策：AsyncStorage に armed:true, eventId, regions を保存し、アプリ起動時に自動で再登録。必要なら**通知で“Re-armed”**を出す。

5. 端末/OS の省電力・メーカー挙動

Doze やデバイスごとの最適化がヘッドレス起動を抑制。

対策：既に設定済みの Allow all the time + Battery Unrestricted は正解。SIM の有無やオフラインはジオフェンス自体には無関係。

## 結論

いまは Home ケースで OK → リリースで良い。
後で Swipe Kill も安定させるなら、① タスクのトップレベル化＋ ②Arm 時に前景サービスで keep-alive ＋ ④ 自動再アーム、この 3 点が最も効果的。

# Show Event QR から戻ると History に行く

対象画面：/app/(tabs)/organize/events/[id]/qr.tsx（Show Event QR）

遷移元：/app/(tabs)/organize/events/[id].tsx（Organizer のイベント詳細）

現象：Show Event QR を開いた後、Android の戻るボタンを 1 回押すと History タブ に戻る。イベント詳細には戻らない。

他画面の戻り挙動：

Live（/app/(tabs)/organize/events/[id]/live.tsx）：戻る 1 回でイベント詳細に戻る

Scan（Organizer）（/app/(tabs)/organize/events/[id]/scan.tsx）：戻る 1 回でイベント詳細に戻る

実施済み作業：live.tsx/scan.tsx を (tabs) 配下へ移動済み。

追加メモ：ADB 直 URL テストは Live で実施し、現在は「通常フロー（イベント詳細 → 各画面）」での挙動を確認済み。QR のみ上記の戻り挙動。

※Check in/invite/Setting も戻るを押すと History に行ってしまう

### EventDetail 単体共通化：今回は手を付けない（後続タスク候補として据え置き）

## Dev ロールスイッチ ON/OFF メモ（現行構成ベース）

### 「開発中で Dev UI を表示させたい」時のコード

devRole.tsx のコードを

```ts
export function devSwitchEnabled(): boolean {
  const isDev = typeof __DEV__ !== "undefined" && __DEV__;

  const envEnabled =
    typeof process !== "undefined" &&
    typeof process.env !== "undefined" &&
    process.env.EXPO_PUBLIC_ENABLE_DEV_SWITCH === "1";

  return isDev || envEnabled;
}
```

### 「開発中だけど Dev UI を隠したい」時のコード

**devSwitchEnabled()関数 1 個まるごと** を、下のコードに 入れ替える。

```ts
export function devSwitchEnabled(): boolean {
  return false;
}
```

※元の devSwitchEnabled()関数（下記）の部分は不要。上のコードに差し替え（つまり 7 行分の関数が 2 行になる）

```ts
export function devSwitchEnabled(): boolean {
  const isDev = typeof __DEV__ !== "undefined" && __DEV__;

  const envEnabled =
    typeof process !== "undefined" &&
    typeof process.env !== "undefined" &&
    process.env.EXPO_PUBLIC_ENABLE_DEV_SWITCH === "1";

  return isDev || envEnabled;
}
```

### 「ストア公開用ビルド（本番）」のとき

コードは パターン ① のまま（何も変えない）：

```ts
export function devSwitchEnabled(): boolean {
  const isDev = typeof __DEV__ !== "undefined" && __DEV__;

  const envEnabled =
    typeof process !== "undefined" &&
    typeof process.env !== "undefined" &&
    process.env.EXPO_PUBLIC_ENABLE_DEV_SWITCH === "1";

  return isDev || envEnabled;
}
```

そのうえで、eas.json の本番プロファイルに
EXPO_PUBLIC_ENABLE_DEV_SWITCH: "1" を書かない。

✅ 正しい例（本番には書かない）：

```json

"production": {
  "developmentClient": false,
  "distribution": "store"
}

```

❌ ダメな例（本番にも書いちゃってる）：

```json
"production": {
  "developmentClient": false,
  "distribution": "store",
  "env": {
    "EXPO_PUBLIC_ENABLE_DEV_SWITCH": "1"
  }
}



```

3️⃣ ビルドするとき

本番はこう実行するだけ：

```bash

eas build --profile production --platform android
# or
eas build --profile production --platform ios

```

要するに：

**Dev 用プロファイル（preview など）**には
env.EXPO_PUBLIC_ENABLE_DEV_SWITCH: "1" を書いて OK

**本番用プロファイル（production など）**には
そのキーを 書かない（env セクションごと無しでも OK）

## unmatched root について

今回の 「新規登録後に Unmatched Route」 問題は、こう整理できます。

1. 症状

新規ユーザーで /join → サインイン → user_profile が無いので /register へ

/register でプロフィール保存（名前・role）を押した直後に
黒背景の “Unmatched Route / Page could not be found” が出る

画面下の Sitemap を押すと、環境によっては 真っ黒になることがあった（原因特定に使えない）

2. 決定的な証拠（ログ）

あなたが取ったログで、以下が出ていた：

[register] saved -> /(tabs) with role = attendee

→ 保存後の遷移先が /(tabs) になっていることが確定。

3. 根本原因（Root Cause）

Expo Router の **(tabs) は「グループ名」**で、実在する URL ルートではない

つまり router.replace("/(tabs)") は “存在しない画面” へ遷移しようとしてしまい、結果として Unmatched Route になる

以前あなたが直した「`index.tsx で /(tabs) に飛ぶとダメ」問題と同種のバグが、今回は register 側に残っていた。

4. 修正方針

保存後の遷移を /(tabs) のようなグループ名にせず、実在するルートへ変更

さらに安全な設計として、ログイン/初期化/ロール反映の責務を /index に一元化する（あなたの join 修正と同じ思想）

5. 実際の修正内容

app/register.tsx の保存後遷移を

router.replace("/(tabs)") ❌

router.replace("/") ✅（= /index に戻す）
に変更

6. なぜ Sitemap が黒くなった？

Sitemap が黒くなるのは 環境差・デバッグ UI の表示不具合の可能性が高い

だから今回は Sitemap ではなくログで原因確定したのが正解ルート

7. 再発防止ミニチェック

router.replace("/(tabs)") / "/(auth)" など グループ名だけに飛ばない

遷移先は必ず Sitemap に載る“実在する画面”（例：/events や /organize/...）か、/（index 一元化）にする

Unmatched が出たらまず **「直前の router.replace の行き先ログ」**で確定する

### Root のミスマッチに関して将来同じような問題が起きたときのミニチェックリスト

まず Sitemap を見る

Unmatched Route が出たら、右下の「Sitemap」をタップ。

現在のパスとルート一覧を確認。

「飛ぼうとしているパス」がルート一覧に存在するかチェックする。

index / join の遷移先を確認する

セッションチェックや profile 読み込みをしている画面（今回なら /index）を特定。

ログイン後に 必ずそこを経由する設計になっているか（router.replace("/") など）を確認。

途中で直接タブや別画面に飛んでいないかを見る。

expo-router のグループ名に注意

app/(tabs)/... の (tabs) は URL に現れないグループ名。

router.replace("/(tabs)") のように、グループだけのパスには飛ばないようにする。

必ず実在するスクリーン（例：/events / / (tabs)/events）に飛ぶ。

ログで流れを追う

console.info で

セッション有無

user_profile の role

router.replace の行き先

を出しておくと、どこで何に飛んでいるか後から追いやすい。

## APK アップデートについて

実機テスト用プロフィール（APK 用） … 例：preview を「テスト専用」に固定

distribution: "internal"

android.buildType: "apk"

env で APP_ENV=internal

ストア用プロフィール（AAB 用） … 例：production

distribution: "store"

AAB（今作ったやつと同じ系統）

これは Google Play に出したくなったときだけ使う

# フェーズ A：アプリ側の修正（Location 説明画面）

## A-1. 新しい画面 location-disclosure を追加

app/location-disclosure.tsx を新規作成

画面レイアウト：

Title：Location access for attendance verification

Body：前回決めた 4 文（背景位置情報／目的／広告には使わない／設定で変更可）

ボタン：

Continue（メイン）

Cancel（サブ）

ボタンの動き：

Continue：

AsyncStorage に @geoattendance.locationDisclosure.v1 = "accepted" を保存

next パラメータを読んで router.replace(next || "/")

Cancel：

フラグは 保存しない

router.replace(next || "/") で戻るだけ（チェック開始しない）

✅ ここでは Location Permission を直接リクエストしない（あくまで説明専用画面）。

## A-2. Start attendee check ボタンのフローを変更（Live 画面）

対象ファイル：app/(tabs)/organize/events/[id]/live.tsx

Start attendee check ボタンのハンドラ（handleArmGeofence）内で：

AsyncStorage から @geoattendance.locationDisclosure.v1 を読み込む

判定ロジック：

accepted でない場合：

router.push({ pathname: "/location-disclosure", params: { next: /organize/events/${id}/live } })

→ この時点では geofence はまだスタートしない

accepted の場合：

今まで通り：

ensurePermissions()（lib/geofenceActions.ts）

OK なら armGeofenceAt(point, radius) を呼ぶ

✅ 説明画面から戻ってきたあとは、ユーザーがもう一度 Start attendee check を押したときに geofence が起動する仕様で固定。

## A-3. プレビュー用 APK で動作確認

eas build --platform android --profile preview で APK を作成して、実機テスト：

「初回」の動き

Live 画面で Start attendee check を押す

→ 説明画面が出る

→ Continue で Live に戻る

→ もう一度 Start attendee check

→ OS の Location 許可（Allow all the time）が出る

→ 許可 → geofence ON（ラベル変化など確認）

Cancel の動き

Start attendee check → 説明画面 → Cancel

→ Live に戻るが geofence は動かない

→ 再度 Start attendee check 押すと、また説明画面が出る

2 回目以降

一度 Continue していれば、次からは Start attendee check 押下 → いきなり ensurePermissions() → geofence ON になることを確認

# フェーズ B：本番用ビルド & Play Console 差し替え. 完了 ☑️

## B-1. 本番用 AAB v4 を作成（済）

eas build --platform android --profile production

versionName: 1.0.0

versionCode: 4

## B-2. Play Console にアップロード

① 内部テストトラック（v1-internal） → 完了

既存の 1.0.0 (3) リリースをベースに新しいリリースを作成

AAB を v4（versionCode 4）に差し替え

リリース名: 1.0.0 (4) internal

問題なしで「保存して公開」まで完了

② クローズドテストトラック（12testers） → 動画 URL がないと完了不可

同じ AAB v4 を使ってリリース 4 を作成

リリース名: 1.0.0 (4)

ここで Play Console から以下のエラーが出る：

プライバシーポリシー URL

アカウント削除ページ URL

位置情報の利用許可フォーム（動画 URL を含む）

⚠ 重要：この「位置情報の利用許可」フォームで
「動画での手順の説明」欄に有効な URL を入れないと、
クローズドテストのリリースを保存できない。
→ 動画 URL は絶対にスキップ不可。

そのため、実際の作業順序は：

フェーズ C で動画を作って YouTube URL を用意 ➜ その URL を位置情報フォームに入れてから、B-2 クローズドテストリリースを完了

# フェーズ C：審査用の動画作成 & フォーム記入　完了 ☑️

（※ここが B-2 クローズドテスト完了の必須条件）

## C-1. Pixel に v5 をインストール

内部テストトラックから Play Store 経由で v5 をインストール

アプリ内で versionCode 5 になっていることを確認

## C-2. 画面録画（30〜40 秒）

シナリオ（英語 UI 前提）：

GeoAttendance を起動

Organizer としてログイン（必要なら）

対象イベントの Live 画面を開く

Start attendee check をタップ

新しい Location 説明画面が表示される

Continue を押す

OS の Location 許可ダイアログで Allow all the time を選択

Live 画面へ戻る

もう一度 Start attendee check を押して、チェックが開始された状態を数秒映す

録画停止

## C-3. YouTube にアップ & Play 側に登録

（ここが 動画 URL 必須ポイント）

録画動画を PC にコピー

YouTube に「限定公開」でアップロード

動画の URL をコピー

Play Console → アプリのコンテンツ → 位置情報の利用許可

すでに入力した説明テキスト（目的 / 背景アクセス理由）を確認

「動画での手順の説明」欄に YouTube の URL を必ず入力

保存

ここまで終わると、「位置情報の利用許可」フォームのエラーが消え、
B-2 のクローズドテストリリースを保存できる状態になる。

# フェーズ D：クローズドテスト公開 & 12testers 実行　　完了 ☑️

## D-1. クローズドテストトラックを公開

クローズドトラック（12testers）のリリース 5(versionCode 5) を開く

エラーが無いことを確認

プライバシーポリシー URL: GitHub Pages の新 URL

アカウント削除ページ URL: 同じく有効

位置情報の利用許可フォーム: テキスト + 動画 URL 済

「保存して公開」を押して、クローズドテストを有効化

### バックアップ

バックアップまとめ（現状の確定情報）

1. RLS / Policies 状態（重要）

public.events

RLS：Enabled（画面右上が “Disable RLS”）

Policy：1 つ

events_read_all

Command：SELECT

Applied to：public

USING：true（＝全ユーザーに読み取り許可）

public.groups

RLS：Disabled

Policies：なし（No policies created yet）

public.group_members

RLS：Disabled

Policies：なし（No policies created yet）

2. テーブル DDL（保存済み）

public.groups

create table public.groups (
id uuid not null default gen_random_uuid (),
name text not null,
description text null,
created_by uuid not null,
created_at timestamp with time zone not null default now(),
constraint groups_pkey primary key (id)
) TABLESPACE pg_default;

public.events（あなたが貼ってくれた定義）

group_id uuid not null（FK → groups(id) on delete cascade）

created_by uuid not null

他：title / start_utc / end_utc / lat/lng etc.

public.group_members（あなたが貼ってくれた定義）

PK：(group_id, user_id)（両方 uuid）

role：organizer | member

FK：group_id -> groups(id) on delete cascade

3. 現状の問題に直結する確定点（原因メモ）

events は “誰でも SELECT できる” policy がある（USING true）

groups / group_members は RLS disabled のため、アプリが select() を投げると基本的に通る（匿名キーを持つクライアントで読める状態）

4. 保存物（あなたの手元に残っているべきもの）

Policies 画面のスクショ：

groups（RLS disabled / no policies）

group_members（RLS disabled / no policies）

events（events_read_all の編集画面：USING true）

events（policy 一覧：events_read_all）

DDL テキスト：

groups / events / group_members

ここまでが「バックアップまとめ」です。

## iphone でアプリ起動

これからの基本ルーティン

Metro 起動（まずはこれだけで OK）

cd "/Users/ken/app_development/rta-zero_restored"
npx expo start --dev-client --clear

iPhone で GeoAttendanceTest を開く
→ 自動で Metro に繋がって更新される

いつ Xcode の Run が必要？

ふだんの JS/TS 変更だけ → 不要（Metro + アプリ起動で OK）

次のどれかをやった時 → Xcode で Run（ビルドし直し）

expo prebuild や pod install が絡む変更

app.json / app.config のネイティブ設定が変わった

ネイティブ依存（カメラ/位置/通知/permissions 系やライブラリ追加）を入れ替えた

ios/ を消して作り直した・Pods が変わった

いま出てた「No script URL provided」再発防止

Metro が起動してない or 違うプロジェクトで起動してると出ることが多い

迷ったらこの順番が安定：

npx expo start --dev-client --clear

iPhone で GeoAttendanceTest 起動

この状態で、次に困りがちなのは「同じ Wi-Fi じゃなくて繋がらない」「PC の IP が変わって繋がらない」あたり。もしまた接続で止まったら、その画面（Dev Client の接続先表示）スクショ投げて。

##　 Play console へアップデートするときは下記が正解

npx eas build -p android --profile internal

必要なら履歴も見れる

npx eas build:list --platform android --limit 10

1. ビルドは常に internal プロファイルで作る

Play に上がってるのが .internal だから、更新用 AAB も internal で固定で OK。

2. versionCode を確実に上げてから AAB を作る

3. できた AAB を Play Console の「製品版」リリースでアップ

いまの運用通り、AAB をアップしてリリース作れば OK。

4. Google play では下記の URL で公開中

https://play.google.com/store/apps/details?id=com.kenta0015.geoattendance.internal

### 1 点だけ“混乱ポイント”を整理

あなたの app.config.js だと internal の android.versionCode が 7 になってるのに、実際は 8 で出てるよね。
これは eas.json の "appVersionSource": "remote" の影響で、EAS 側の versionCode 管理が勝ってる状態になりやすいから、設定と表示がズレて混乱しがち。

だから運用としては：

internal の versionCode は「EAS の remote 管理に任せる」（＝ internal ビルドの autoIncrement を ON にして、Play 用はそれだけ見れば OK）
に寄せるのが一番ミスりにくい。

## 外での Expo 　 go に接続するとき

ターミナルに Using development build / URL に expo-development-client が出てたら → s を押す

家：npx expo start -c --lan --go

外：npx expo start -c --tunnel --go

あと、QR はできれば Expo Go アプリ内の Scan から読むのが安全（スマホのカメラだと Dev Client に吸われがち）。

## 本番用コマンド

npx expo start --no-dev --minify

## 一番確実に「今の bundle を読ませる」手順（これでズレを潰せます）

Expo Go を完全終了（アプリをスワイプで落とす）

Android なら Expo Go のアプリ情報 → ストレージ → データ削除/キャッシュ削除（最強）

Metro も止める（ターミナルで Ctrl+C）

ポートを変えて起動（これが効きます）

npx expo start -c --no-dev --minify --port 8082

必ず新しい QR をスキャン（Expo Go の履歴から開かない）

これで端末が新サーバに取りに来るので、通常はここで Android Bundled ... が出ます
