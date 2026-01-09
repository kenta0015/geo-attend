# ここまでの要約

## 1) 目的と現状

**目的**：Android エミュ上で **Expo Dev Client（SDK 53 / Hermes / expo-router）** を使い、**expo start だけで JS 開発**を回す。

**現状**：Metro はビルド成功（**Android Bundled OK**）。**起動直後にネイティブ層でクラッシュ**。

**決定的ログ（adb logcat）**

```
NoSuchMethodError: AsyncFunctionBuilder.getConverters()
at expo.modules.asset.AssetModule.definition(…)
```

→ **expo-modules-core の実装が古く、expo-asset 等が要求する API と不一致（ABI 不整合）。**

---

## 2) 根本原因（確定）

**Dev Client に組み込まれた expo-modules-core の版が 2.5.0 のまま**  
一方で **expo-asset@11.1.7 / expo-file-system@18.1.11** など新しめを参照 → その結果、**存在しないメソッド（getConverters()）を呼ぶ → NoSuchMethodError でアプリ即落ち。**

**確認方法（Gradle 出力：ビルド用ターミナル B で出る）**

```
> Configure project :expo
Using expo modules
  - expo-modules-core (2.5.0)   ← ここが古い
  - expo-asset (11.1.7)
  - expo-file-system (18.1.11)
```

---

## 3) これまでの有効だった/無効だったこと

✅ **Metro 側のエラーは解消**（エイリアス/tsconfig/metro-config の問題は切り分け済み）。

✅ **接続経路の確立**：http://10.0.2.2:8081 を Dev Launcher で明示、adb reverse 代替も理解。

✅ **ログ取得手順が確立**：$appPid／Select-String フィルタで PowerShell でも確実に取得。

❌ **expo install …@latest + prebuild --clean 実行後も、ビルドログの expo-modules-core が 2.5.0 のまま → ネイティブ層の世代統一に失敗**（キャッシュ/依存固定/Hoist の影響などが背景）。

---

## 4) ターミナルの役割（固定）

- **A ｜ Metro**：`npx expo start --dev-client --lan --port 8081`
- **B ｜ビルド**：`npx expo install / prebuild` → `android/gradlew …`
- **C ｜エミュ起動（必要な時）**：`emulator.exe -avd … -gpu swiftshader_indirect`
- **D ｜接続/ADB**：`adb shell am start … / adb uninstall … / adb reverse …`
- **E ｜ログ**：`adb logcat …`（`$appPid` or タグフィルタ）

---

## 5) 接続・表示まわりの Tips（ハマりどころ回避）

**Dev Launcher の“最近使った”URL に惑わされない → 必ず http://10.0.2.2:8081 を手入力 or ADB で直叩き：**

```powershell
adb shell am start -n com.anonymous.boltexponativewind/expo.modules.devlauncher.launcher.DevLauncherActivity `
  -a android.intent.action.VIEW `
  -d "exp+bolt-expo-nativewind://expo-development-client/?url=http%3A%2F%2F10.0.2.2%3A8081"
```

**GPU エラー（GLES 0x501/0x506）** はエミュ側の問題 → `-gpu swiftshader_indirect` で起動。

**ポート衝突は毎回お守り：**

```powershell
npx kill-port 8081 19000 19001 19002
```

**Windows のパス長**は短パスへ（今は `C:
ta\...` で OK）。

---

## 6) ログの取り方（確実版）

```powershell
$env:PATH="$env:LOCALAPPDATA\Android\Sdk\platform-tools;$env:PATH"
$serial="emulator-5554"
adb -s $serial logcat -G 10m
adb -s $serial logcat -c
$appPid = (adb -s $serial shell pidof com.anonymous.boltexponativewind).Trim()
if (-not $appPid) { $appPid = (adb -s $serial shell pidof host.exp.exponent).Trim() }   # 予備
adb -s $serial logcat -v time --pid $appPid | Tee-Object crash.log
```

※ PowerShell の予約変数 `$PID` と衝突するので **`$appPid`** を使用。  
※ フィルタ保険：

```powershell
adb -s $serial logcat -v time | Select-String -Pattern "AndroidRuntime|FATAL|DevLauncher|expo\.modules\.kotlin|getConverters"
```

---

## 7) 今後の進め方（あなたの選択に沿った計画）

**あなたの方針：**  
① もう一手だけ → ② 新規 CEA に JS 移植 → ③ ダメなら撤退

**① もう一手（実施済／不発）**

狙い：expo-modules-core を SDK53 同世代の最新に引き上げ、Dev Client を全消し再生成。

期待結果：Gradle の「Using Expo modules」で **expo-modules-core (2.6.x+)** 表示。

実際：**2.5.0 表示のまま → 修正効かず。**

**② 新規 CEA に JS 移植（推奨）**

**フェーズ 0 ｜ベース起動**

```
npx create-expo-app -e with-router rta53-clean

npx expo install expo-dev-client expo-location

npx expo prebuild -p android → :app:installDebug -PreactNativeArchitectures=x86_64

Metro起動 → Dev Launcherで 10.0.2.2:8081 を開き、素のタブ画面が出ることを確認
```

**フェーズ 1 ｜先回りプリインストール（反復削減）**  
既知の依存（例）：**date-fns, zustand, @turf/turf, lucide-react-native, @react-native-async-storage/async-storage, expo-web-browser** などを `npx expo install <pkg>` で先に入れておく（SDK 整合版が自動選択）。

**フェーズ 2 ｜段階移植（小分け）**  
`app/` → `stores/` → `lib/` → `.env` の順で少量ずつコピー。

- バンドルで “モジュールが見つからない” と出たらその場で `npx expo install <pkg>`。
- **ネイティブ差分が出た時だけ** `expo prebuild -p android` → `:app:installDebug`。
- **JS だけの変更は再ビルド不要**（Metro だけで即反映）。

**フェーズ 3 ｜位置情報の確認**

- エミュの **Extended controls › Location** で座標を設定してからテスト。
- パーミッションは最初のダイアログで「Allow」。

**ポイント**：“クリーンな依存グラフ”から始めるため、ABI ズレが発生しづらい。問題が起きても「どの追加で壊れたか」が即わかる。

**③ 撤退ライン**

② でも **同型（getConverters()）の例外**が再現する場合は、今回は時間対効果が低いので**撤退が妥当**。

**デモ優先**なら、**Expo Go + expo-location** でデモを通し、実機用の Dev Client 構築は後日に回す選択肢もあり。

---

## 8) Expo Doctor の扱い

今回のクラッシュとは無関係。

`@expo/config-plugins` の警告は、`expo@latest` に追随すると薄まることが多い。

`expo-asset / expo-file-system` の expected は、新 CEA 側で `expo install` が勝手に整合させるので OK。

---

## 9) 参照コマンド（抜粋・再掲）

**Dev Launcher を URL で開く**

```powershell
adb shell am start -n com.anonymous.boltexponativewind/expo.modules.devlauncher.launcher.DevLauncherActivity `
  -a android.intent.action.VIEW `
  -d "exp+bolt-expo-nativewind://expo-development-client/?url=http%3A%2F%2F10.0.2.2%3A8081"
```

**代替：adb reverse 経路**

```powershell
adb reverse tcp:8081 tcp:8081
adb shell am start -a android.intent.action.VIEW -d "exp+bolt-expo-nativewind://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8081"
```

**GPU 回避でエミュ起動**

```powershell
& "$env:LOCALAPPDATA\Android\Sdk\emulator\emulator.exe" -avd Pixel_6_API_34 `
  -gpu swiftshader_indirect -no-snapshot-load -no-snapshot-save -no-boot-anim
```

---

## まとめ（要点だけ）

**原因は“ネイティブ世代の不一致”で確定（expo-modules-core が古い）。**

**もう一手は不発 → クリーンな新 CEA へ JS 移植が最短で確度高い。**

**役割分担（A/B/C/D/E）と接続・ログ・ビルドの運用テンプレは確立済み。**

**これで進めれば、バンドルは安定し、ネイティブ ABI ズレを再発させにくい。**

---

## 今後の予定

**まずは Android 実機 + Expo Go で GPS デモを通して実績確保、並行で CEA 移植。**

**ルール：ネイティブ差分を入れた時だけ prebuild→:app:installDebug／JS だけは Metro 反映。**

**ストップ条件（おすすめ）：CEA 移植で同型の getConverters() が 2 回出たら撤退判断。**

---

## Android 実機 + Expo Go で GPS デモの最短手順です（端末役割つき、コピペ可）。

**事前**

- 実機に **Expo Go（Play ストア）** をインストール
- 実機と PC を **同一 Wi-Fi**（2.4/5GHz の SSID まで一致）

**Step 1 ｜ Metro（ターミナル A ｜ C:\rta\Real_time_Attendance_new）**

```powershell
cd C:
ta\Real_time_Attendance_new
npx kill-port 8081 19000 19001 19002
npx expo start --go -c --lan
```

（QR コードが出ます）

**Step 2 ｜実機**

- Expo Go を開く → 右上の **QR** アイコンで **QR** を読み取り
- 位置権限ダイアログは **「Allow（許可）」** を選択
- 出ない場合：Android 設定 → アプリ → Expo Go → **Permissions > Location** を **Allow**

**Step 3 ｜動作確認**

- アプリ内で**位置取得画面（expo-location を使う画面）**に遷移
- 取得できれば **緯度経度が表示／地図や距離計算が動作**

**つながらない時の代替（どちらか一つ）**

**代替 A ｜ USB 接続（安定）**

**ターミナル D（どこでも OK）**

```powershell
$env:PATH="$env:LOCALAPPDATA\Android\Sdk\platform-tools;$env:PATH"
adb devices
adb reverse tcp:19000 tcp:19000
```

→ Expo Go の「Enter URL manually」に **exp://localhost:19000** を入力。

**代替 B ｜トンネル**

**ターミナル A**

```powershell
npx expo start --go --tunnel
```

（QR を再スキャン）

**位置を自由に動かしたい（任意）**

- 実機：屋外で実測 or Developer options の **Mock location** に任意アプリを指定（Fake GPS 等）

以上で **GPS デモは 95–99% 成功**の想定です。**動いたら次は 新規 CEA への移植**に入ろう。
