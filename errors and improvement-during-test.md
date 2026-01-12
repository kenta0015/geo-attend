#　注意！！　 geoffence 機能に影響がありそうな変更は行わない！！もしくはブランチを分けて作業する ⚠️

##　不具合

- QR コードが読めない(apple menbership 後)

## 要改善

-Check 　 in list を open detail を押す →check in list ではなく　 現在の場所から”open detail” bottun と横並びにさせる様にする
-organize page の manage group をもう少し目立たせる

## 重点チェックで見つかった「不整合・バグになりそうな点」

A) /organize/admin への遷移先が 実装されていない

実体として存在するのは app/(tabs)/organize/admin/\_layout.tsx だけで、admin/index.tsx 等がありません

なのに以下が存在：

organize/index.tsx から router.push("/organize/admin")

app/(tabs)/\_layout.tsx で Tabs.Screen name="organize/admin" を hidden 登録

👉 もし今このルートに遷移すると、expo-router 的にルート解決できず問題になる可能性が高いです。
（グループ管理は現状 me/groups.tsx が本体っぽいので、/organize/admin は残骸の可能性が高いです）

B) invite.tsx の events 取得カラムが他と食い違う

organize/index.tsx と events/[id]/index.tsx は start_utc/end_utc/lat/lng/radius_m を前提

でも events/[id]/invite.tsx は venue_lat, venue_lng, venue_radius_m, start_time_utc, end_time_utc を そのまま select しています
→ events テーブルにそのカラムが無いなら、ここは壊れます（alias も使っていない）

C) Create event の時間バリデーションがやや不自然

start + 60 分が同じ日内に収まること を必須にしている（endUtc の値に関係なくチェックしている）

end > start のチェックが見当たらない（少なくともこのファイル内のバリデーションでは未確認）
