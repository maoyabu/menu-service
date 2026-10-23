# Common Admin 移設

移設元: `/Users/oyabu/dev/admin` HEAD `36c3c1f36043004a016391c513ec5914c2a62780`。

## 入口と認証

管理トップの「共通システム管理」から `/admin/common/` を開く。
ユーザー管理は `/admin/common/users`、グループ管理は `/admin/common/groups`、
全DBのデータ管理は `/admin/common/data`。APIも `/admin/common/api/*` に限定する。
menu-serviceのPassportログインと `isAdmin` を使用する。Basic認証用の
`ADMIN_USER` / `ADMIN_PASSWORD` は不要。非管理者のAPI要求は403。

## 保存の互換性

接続先はmenu-serviceの既存Mongoose接続。別DBへのコピーは実施しない。
管理操作は移設元と同じく直接コレクションを操作する。
会計側4サービスは `users.servicesByGroup`、menu側4サービスは
`groups.memberServicePermissions` に保存する。
メール設定は `users.serviceMailPreferences` に保存する。
削除通知は既存の `SMTP_HOST/PORT/USER/PASS` または `MAIL_USER/PASS` と
`MAIL_FROM` を利用する。移設元の `.env` はコピーしていない。

## バックアップと復元

既存のメニュー用バックアップと併存する全DBバックアップ。
`COMMON_ADMIN_BACKUP_DIR`（既定 `./backup/common-admin`）にZIPと履歴を保存する。
従来の `BACKUP_DIR` とは分離している。毎日0時、`BACKUP_TIMEZONE`（既定Asia/Tokyo）。
プロセス内cronのため、常時稼働する1プロセスで運用する。
複数インスタンス間の排他や停止中の追実行は実装していない。
成功履歴は保持するがZIPは最新成功分だけを残す（移設元の仕様）。
バックアップ・復元の排他は同一プロセス内で行う。

全コレクションのEJSON ZIPを作成する。旧adminの同形式ZIPを復元できる。
アップロード上限500MiB、`RESTORE` 入力が必要。
既定では `sessions` と `chounaikai_sessions` を除外し、移設先の両セッションを削除する。
実行中の管理者セッションも破棄する。明示オプションではセッションも復元する。
復元対象の各コレクションを削除後に挿入する。ZIPにないコレクションは維持する。
全JSONは書込前に検証するが、DB書込全体はトランザクションではないため、
途中の障害で部分復元になり得る。バックアップ・復元中の他のアプリ書込は停止しない。

## 切替時の確認

1. ステージングDBで管理者ログインとユーザー・グループ・権限・メール設定を確認する。
2. SMTP設定と削除通知をテスト用ユーザー・グループで確認する。
3. 永続ボリューム、保存先の権限・空き容量、500MiBアップロードに必要なプロキシ設定を確認する。
4. 全DBバックアップを取得し、隔離DBで復元とログアウトを確認する。
5. 旧adminのcronを停止し、必要な既存ZIPと履歴を新保存先へ移す。
6. menu-serviceのcronを1プロセスで運用する。旧adminの停止は本変更では実施していない。

## 検証

`node --test test/*.test.mjs`。
認証、ページのリンクとブラウザJS構文、セッション除外・明示復元、
不正ZIPの事前拒否、実ZIPでのBSON型の維持を検証する。
実DBの更新・削除・復元、SMTP配信、実ブラウザ操作、0時の実行は別途受入確認が必要。
