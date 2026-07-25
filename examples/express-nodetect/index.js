const express = require('express');
const app = express();
const port = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send(`<h1>express-nodetect</h1><p>No Dockerfile in this repo — the deployer generated one. MESSAGE=${process.env.MESSAGE || '(unset)'}</p>`);
});

app.get('/healthz', (req, res) => res.json({ ok: true }));

app.listen(port, '0.0.0.0', () => console.log(`nodetect example listening on ${port}`));
