const express = require('express');
const app = express();
const port = process.env.PORT || 4567;

app.get('/', (req, res) => {
  res.send(`<h1>express-dockerfile</h1><p>Built from the repo's own Dockerfile. GREETING=${process.env.GREETING || '(unset)'}</p>`);
});

app.listen(port, '0.0.0.0', () => console.log(`listening on ${port}`));
