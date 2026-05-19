'use strict';

const express = require('express');

function createApp() {
  const app = express();

  app.get('/health', (_req, res) => {
    res.status(200).json({ ok: true });
  });

  app.get('/hello/:name', (req, res) => {
    res.status(200).json({ greeting: `hello, ${req.params.name}` });
  });

  return app;
}

if (require.main === module) {
  const port = process.env.PORT || 3000;
  createApp().listen(port, () => {
    console.log(`express-demo listening on :${port}`);
  });
}

module.exports = { createApp };
