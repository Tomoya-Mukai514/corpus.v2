const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.get('/', (_req, res) => {
  res.json({
    message: 'J-STAGE proxy starter is running.'
  });
});

app.get('/health', (_req, res) => {
  res.json({
    ok: true
  });
});

// 最初はダミー応答。
// Render と GPT Actions の接続確認ができたら、ここに J-STAGE API の処理を実装する。
app.get('/answer', (req, res) => {
  const q = String(req.query.q || '').trim();

  if (!q) {
    return res.status(400).json({
      error: 'Missing required query parameter: q'
    });
  }

  return res.json({
    query: q,
    candidates: [
      {
        title: 'Dummy title 1',
        authors: ['Dummy Author'],
        journal: 'Dummy Journal',
        year: '2026',
        doi: '',
        link: 'https://example.com/1',
        abstract: 'This is a dummy abstract. Replace this with J-STAGE-derived data later.'
      },
      {
        title: 'Dummy title 2',
        authors: ['Dummy Author 2'],
        journal: 'Dummy Journal 2',
        year: '2025',
        doi: '',
        link: 'https://example.com/2',
        abstract: 'This is another dummy abstract for connection testing.'
      }
    ]
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server is running on port ${PORT}`);
});
