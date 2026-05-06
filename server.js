const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const { Pool } = require('pg');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('.'));

// ── DATABASE ──
const db = new Pool({ connectionString: process.env.DATABASE_URL });

// Opret tabeller ved opstart
async function initDB() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      zip TEXT DEFAULT '2770',
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS preferences (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      dislikes TEXT[] DEFAULT '{}',
      favorites TEXT[] DEFAULT '{}',
      allergies TEXT DEFAULT '',
      diet TEXT DEFAULT '',
      history TEXT[] DEFAULT '{}',
      updated_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS meal_plans (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      week INTEGER NOT NULL,
      year INTEGER NOT NULL,
      plan JSONB NOT NULL,
      budget INTEGER,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS price_db (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      ingredient TEXT NOT NULL,
      price NUMERIC NOT NULL,
      unit TEXT,
      store TEXT,
      is_sale BOOLEAN DEFAULT FALSE,
      updated_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(user_id, ingredient)
    );
  `);
  console.log('Database tabeller klar');
}
initDB().catch(e => console.error('DB init fejl:', e.message));

// ── RATE LIMITING ──
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'For mange kald — vent et øjeblik' }
});
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'For mange loginforsøg — prøv igen om 15 min' }
});
app.use('/api/', limiter);

// ── JWT MIDDLEWARE ──
function requireAuth(req, res, next) {
  const header = req.headers['authorization'];
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Ikke logget ind' });
  }
  const token = header.split(' ')[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'fallback-secret');
    req.user = decoded;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Ugyldig session — log ind igen' });
  }
}

// ── AUTH ENDPOINTS ──

// Login
app.post('/api/auth/login', loginLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email og kodeord er påkrævet' });
    }
    const result = await db.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
    const user = result.rows[0];
    if (!user) {
      return res.status(401).json({ error: 'Forkert email eller kodeord' });
    }
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Forkert email eller kodeord' });
    }
    const token = jwt.sign(
      { id: user.id, email: user.email, name: user.name },
      process.env.JWT_SECRET || 'fallback-secret',
      { expiresIn: '30d' }
    );
    res.json({ token, user: { id: user.id, email: user.email, name: user.name, zip: user.zip } });
  } catch (e) {
    console.error('Login fejl:', e.message);
    res.status(500).json({ error: 'Serverfejl' });
  }
});

// Tjek token (bruges ved sideload)
app.get('/api/auth/me', requireAuth, async (req, res) => {
  try {
    const result = await db.query('SELECT id, email, name, zip FROM users WHERE id = $1', [req.user.id]);
    res.json(result.rows[0]);
  } catch (e) {
    res.status(500).json({ error: 'Serverfejl' });
  }
});

// Opret bruger — KUN via Railway console (kræver admin-nøgle)
app.post('/api/auth/create-user', async (req, res) => {
  try {
    const adminKey = req.headers['x-admin-key'];
    if (adminKey !== process.env.ADMIN_KEY) {
      return res.status(403).json({ error: 'Adgang nægtet' });
    }
    const { email, password, name, zip } = req.body;
    if (!email || !password || !name) {
      return res.status(400).json({ error: 'email, password og name er påkrævet' });
    }
    const hash = await bcrypt.hash(password, 12);
    const result = await db.query(
      'INSERT INTO users (email, password_hash, name, zip) VALUES ($1, $2, $3, $4) RETURNING id, email, name',
      [email.toLowerCase(), hash, name, zip || '2770']
    );
    const user = result.rows[0];
    // Opret tomme præferencer
    await db.query('INSERT INTO preferences (user_id) VALUES ($1)', [user.id]);
    res.json({ success: true, user });
  } catch (e) {
    if (e.code === '23505') {
      return res.status(409).json({ error: 'Email findes allerede' });
    }
    console.error('Opret bruger fejl:', e.message);
    res.status(500).json({ error: 'Serverfejl' });
  }
});

// ── PRÆFERENCER ──
app.get('/api/preferences', requireAuth, async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM preferences WHERE user_id = $1', [req.user.id]);
    res.json(result.rows[0] || {});
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/preferences', requireAuth, async (req, res) => {
  try {
    const { dislikes, favorites, allergies, diet, history } = req.body;
    await db.query(`
      UPDATE preferences SET
        dislikes = $1, favorites = $2, allergies = $3,
        diet = $4, history = $5, updated_at = NOW()
      WHERE user_id = $6
    `, [dislikes || [], favorites || [], allergies || '', diet || '', history || [], req.user.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── MADPLANER ──
app.get('/api/mealplans', requireAuth, async (req, res) => {
  try {
    const result = await db.query(
      'SELECT * FROM meal_plans WHERE user_id = $1 ORDER BY year DESC, week DESC LIMIT 10',
      [req.user.id]
    );
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/mealplans', requireAuth, async (req, res) => {
  try {
    const { week, year, plan, budget } = req.body;
    await db.query(`
      INSERT INTO meal_plans (user_id, week, year, plan, budget)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT DO NOTHING
    `, [req.user.id, week, year, JSON.stringify(plan), budget]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── PRISDATABASE ──
app.get('/api/prices', requireAuth, async (req, res) => {
  try {
    const result = await db.query(
      'SELECT * FROM price_db WHERE user_id = $1 ORDER BY ingredient',
      [req.user.id]
    );
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/prices', requireAuth, async (req, res) => {
  try {
    const { ingredient, price, unit, store, is_sale } = req.body;
    await db.query(`
      INSERT INTO price_db (user_id, ingredient, price, unit, store, is_sale, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, NOW())
      ON CONFLICT (user_id, ingredient) DO UPDATE SET
        price = $3, unit = $4, store = $5, is_sale = $6, updated_at = NOW()
    `, [req.user.id, ingredient, price, unit, store, is_sale || false]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── TILBUD FRA ETILBUDSAVIS ──
app.get('/api/offers', requireAuth, async (req, res) => {
  try {
    const { query = 'kylling', zip = '2770' } = req.query;
    const coords = zipToCoords(zip);
    const params = new URLSearchParams({
      r_locale: 'da_DK', offset: 0, limit: 96,
      ...(query ? { query } : {}),
      ...(coords ? { r_lat: coords.lat, r_lng: coords.lng, r_radius: 30000 } : {})
    });
    const r = await fetch(
      `https://squid-api.tjek.com/v2/offers/search?${params}`,
      { headers: { 'Accept': 'application/json', 'X-Api-Av': '0.3.0' } }
    );
    if (!r.ok) return res.status(r.status).json({ error: 'Tilbuds-API fejlede' });
    res.json(await r.json());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── ANTHROPIC API PROXY ──
app.post('/api/claude', requireAuth, async (req, res) => {
  try {
    if (!process.env.ANTHROPIC_KEY) {
      return res.status(500).json({ error: 'ANTHROPIC_KEY mangler på serveren' });
    }
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
    if (!response.ok) {
      console.error('Anthropic fejl:', JSON.stringify(data));
      return res.status(response.status).json(data);
    }
    res.json(data);
  } catch (e) {
    console.error('Claude proxy fejl:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── KOORDINATER ──
function zipToCoords(zip) {
  const m = {
    '2000':{lat:55.683,lng:12.528},'2100':{lat:55.706,lng:12.567},
    '2200':{lat:55.700,lng:12.535},'2300':{lat:55.660,lng:12.583},
    '2400':{lat:55.714,lng:12.519},'2500':{lat:55.679,lng:12.494},
    '2600':{lat:55.648,lng:12.461},'2700':{lat:55.688,lng:12.477},
    '2720':{lat:55.693,lng:12.461},'2730':{lat:55.696,lng:12.472},
    '2740':{lat:55.704,lng:12.468},'2750':{lat:55.689,lng:12.452},
    '2760':{lat:55.696,lng:12.445},'2770':{lat:55.627,lng:12.600},
    '2800':{lat:55.764,lng:12.497},'2820':{lat:55.753,lng:12.484},
    '2830':{lat:55.744,lng:12.468},'2850':{lat:55.736,lng:12.527},
    '2900':{lat:55.762,lng:12.571},'3000':{lat:55.926,lng:12.519},
    '4000':{lat:55.641,lng:12.085},'5000':{lat:55.396,lng:10.389},
    '6000':{lat:55.496,lng:9.472},'7000':{lat:55.466,lng:9.143},
    '8000':{lat:56.152,lng:10.203},'9000':{lat:57.048,lng:9.921}
  };
  const z = String(zip).trim();
  return m[z] || m[z.substring(0,2)+'00'] || { lat:55.676, lng:12.568 };
}

// ── START ──
app.listen(process.env.PORT || 3000, () => {
  console.log('Server kører på port', process.env.PORT || 3000);
  if (!process.env.ANTHROPIC_KEY) console.warn('ADVARSEL: ANTHROPIC_KEY mangler!');
  if (!process.env.JWT_SECRET) console.warn('ADVARSEL: JWT_SECRET mangler!');
  if (!process.env.ADMIN_KEY) console.warn('ADVARSEL: ADMIN_KEY mangler!');
});
