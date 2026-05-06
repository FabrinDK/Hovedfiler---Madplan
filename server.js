const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('.'));

const db = new Pool({ connectionString: process.env.DATABASE_URL });

// Hent tilbud fra eTilbudsavis
app.get('/api/offers', async (req, res) => {
  const { query = 'kylling', zip = '2770' } = req.query;
  const url = `https://squid-api.tjek.com/v2/offers/search?query=${query}&r_locale=da_DK&limit=96`;
  const data = await fetch(url, { headers: { 'X-Api-Av': '0.3.0' } });
  const json = await data.json();
  res.json(json);
});

// Kald Anthropic API (nøglen er sikker på serveren)
app.post('/api/claude', async (req, res) => {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify(req.body)
  });
  const data = await response.json();
  res.json(data);
});

app.listen(process.env.PORT || 3000, () => console.log('Server kører'));
