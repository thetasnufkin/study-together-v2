# Study Together (Launch-ready)

共同勉強アプリの改修版です。  
**エンドユーザーが初回アクセスで Firebase 設定を入力する必要はありません。**

## できること

- ルーム作成 / ルームコード参加
- 25分作業 + 5分休憩の同期ポモドーロ
- 休憩時間のみ通話有効（PeerJS）
- 参加者プレゼンス（heartbeat + stale cleanup）
- ホスト離脱時の自動引き継ぎ
- 招待リンク共有

---

## 使い方（運営者が1回だけ設定）

### パターンA: Firebase Hostingで運用（おすすめ）

`/__/firebase/init.js` で設定が自動注入されるので、`config.js` の編集は不要です。

1. Firebase プロジェクト作成
2. Realtime Database を有効化
3. Hosting を有効化してこのフォルダをデプロイ

```bash
npm i -g firebase-tools
firebase login
firebase init hosting
firebase deploy
```

### パターンB: Vercel / Netlify など静的ホスティング

`config.sample.js` を `config.js` にコピーして値を入れてください。

```bash
cp config.sample.js config.js
# config.js の Firebase 設定値を埋める
```

その後デプロイすれば、利用者は入力なしで使えます。

---

## Firebase Realtime Database ルール（開発用の最小）

```json
{
  "rules": {
    "rooms": {
      "$roomId": {
        ".read": true,
        ".write": true
      }
    }
  }
}
```

> 本番では Firebase Auth（匿名認証でも可）を入れて制限してください。  
> これを公開ルールのまま放置すると、予想通り荒れます。

---

## 補足

- `config.js` は公開して問題ない情報（Firebase Web 設定）です。
- それでも管理を分けたいなら CI/CD で `config.js` を注入してください。
