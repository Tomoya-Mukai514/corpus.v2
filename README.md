# jstage-render-minimal

Render に載せるための最小構成です。

## 含まれるもの
- `server.js`: 最小の API 本体
- `package.json`: Node.js 依存関係
- `.gitignore`: Git 除外設定

## エンドポイント
- `GET /` : 動作確認
- `GET /health` : ヘルスチェック
- `GET /answer?q=検索語` : ダミーJSONを返す

例:

```bash
curl "http://localhost:3000/answer?q=crime"
```

## ローカル実行

```bash
npm install
npm start
```

## Render での設定
- Build Command: `npm install`
- Start Command: `npm start`

## 次にやること
`/answer` の中身を J-STAGE API 呼び出しに置き換える。
