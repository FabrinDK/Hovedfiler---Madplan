const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const { Pool } = require('pg');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
app.set('trust proxy', 1); // Railway kører bag en proxy
app.use(cors());
app.use(express.json());
app.use(express.static('.'));

// ── DATABASE ──
const db = new Pool({ connectionString: process.env.DATABASE_URL });

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
    CREATE TABLE IF NOT EXISTS offers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      price NUMERIC NOT NULL,
      orig_price NUMERIC,
      pct_off INTEGER,
      store TEXT,
      unit TEXT,
      img_url TEXT,
      valid_till TIMESTAMP,
      category TEXT,
      fetched_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS offer_fetch_log (
      id SERIAL PRIMARY KEY,
      fetched_at TIMESTAMP DEFAULT NOW(),
      offer_count INTEGER,
      status TEXT
    );
  `);
  console.log('Database tabeller klar');
}
initDB().catch(e => console.error('DB init fejl:', e.message));

// ── RATE LIMITING ──
const limiter = rateLimit({
  windowMs: 60 * 1000, max: 30,
  message: { error: 'For mange kald — vent et øjeblik' }
});
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 10,
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
    req.user = jwt.verify(token, process.env.JWT_SECRET || 'fallback-secret');
    next();
  } catch(e) {
    return res.status(401).json({ error: 'Ugyldig session — log ind igen' });
  }
}

// ── AUTH ──
app.post('/api/auth/login', loginLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email og kodeord er påkrævet' });
    const result = await db.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
    const user = result.rows[0];
    if (!user) return res.status(401).json({ error: 'Forkert email eller kodeord' });
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Forkert email eller kodeord' });
    const token = jwt.sign(
      { id: user.id, email: user.email, name: user.name },
      process.env.JWT_SECRET || 'fallback-secret',
      { expiresIn: '30d' }
    );
    res.json({ token, user: { id: user.id, email: user.email, name: user.name, zip: user.zip } });
  } catch(e) {
    console.error('Login fejl:', e.message);
    res.status(500).json({ error: 'Serverfejl' });
  }
});

app.get('/api/auth/me', requireAuth, async (req, res) => {
  try {
    const result = await db.query('SELECT id, email, name, zip FROM users WHERE id = $1', [req.user.id]);
    res.json(result.rows[0]);
  } catch(e) { res.status(500).json({ error: 'Serverfejl' }); }
});

app.post('/api/auth/create-user', async (req, res) => {
  try {
    const adminKey = req.headers['x-admin-key'];
    if (adminKey !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'Adgang nægtet' });
    const { email, password, name, zip } = req.body;
    if (!email || !password || !name) return res.status(400).json({ error: 'email, password og name er påkrævet' });
    const hash = await bcrypt.hash(password, 12);
    const result = await db.query(
      'INSERT INTO users (email, password_hash, name, zip) VALUES ($1, $2, $3, $4) RETURNING id, email, name',
      [email.toLowerCase(), hash, name, zip || '2770']
    );
    const user = result.rows[0];
    await db.query('INSERT INTO preferences (user_id) VALUES ($1)', [user.id]);
    res.json({ success: true, user });
  } catch(e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Email findes allerede' });
    console.error('Opret bruger fejl:', e.message);
    res.status(500).json({ error: 'Serverfejl' });
  }
});

// ── PRÆFERENCER ──
app.get('/api/preferences', requireAuth, async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM preferences WHERE user_id = $1', [req.user.id]);
    res.json(result.rows[0] || {});
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/preferences', requireAuth, async (req, res) => {
  try {
    const { dislikes, favorites, allergies, diet, history } = req.body;
    await db.query(`
      UPDATE preferences SET dislikes=$1, favorites=$2, allergies=$3, diet=$4, history=$5, updated_at=NOW()
      WHERE user_id=$6
    `, [dislikes||[], favorites||[], allergies||'', diet||'', history||[], req.user.id]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── MADPLANER ──
app.get('/api/mealplans', requireAuth, async (req, res) => {
  try {
    const result = await db.query(
      'SELECT * FROM meal_plans WHERE user_id=$1 ORDER BY year DESC, week DESC LIMIT 10',
      [req.user.id]
    );
    res.json(result.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/mealplans', requireAuth, async (req, res) => {
  try {
    const { week, year, plan, budget } = req.body;
    await db.query(
      'INSERT INTO meal_plans (user_id, week, year, plan, budget) VALUES ($1,$2,$3,$4,$5)',
      [req.user.id, week, year, JSON.stringify(plan), budget]
    );
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── PRISDATABASE ──
app.get('/api/prices', requireAuth, async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM price_db WHERE user_id=$1 ORDER BY ingredient', [req.user.id]);
    res.json(result.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/prices', requireAuth, async (req, res) => {
  try {
    const { ingredient, price, unit, store, is_sale } = req.body;
    await db.query(`
      INSERT INTO price_db (user_id, ingredient, price, unit, store, is_sale, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,NOW())
      ON CONFLICT (user_id, ingredient) DO UPDATE SET
        price=$3, unit=$4, store=$5, is_sale=$6, updated_at=NOW()
    `, [req.user.id, ingredient, price, unit, store, is_sale||false]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── TILBUD — hent fra database (fælles for alle brugere) ──
app.get('/api/offers', requireAuth, async (req, res) => {
  try {
    const { query, store } = req.query;
    let sql = 'SELECT * FROM offers WHERE valid_till > NOW() OR valid_till IS NULL';
    const params = [];
    if (query) {
      params.push('%' + query.toLowerCase() + '%');
      sql += ` AND LOWER(name) LIKE $${params.length}`;
    }
    if (store) {
      params.push(store);
      sql += ` AND store = $${params.length}`;
    }
    sql += ' ORDER BY fetched_at DESC LIMIT 200';
    const result = await db.query(sql, params);

    // Hvis databasen er tom, hent friske tilbud med det samme
    if (result.rows.length === 0) {
      console.log('Ingen tilbud i DB — henter friske tilbud...');
      await fetchAndSaveOffers();
      const fresh = await db.query(sql, params);
      return res.json(fresh.rows);
    }

    res.json(result.rows);
  } catch(e) {
    console.error('Tilbud DB fejl:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// SSE progress stream — sender løbende opdateringer til browseren
app.get('/api/offers/refresh-stream', async (req, res) => {
  const adminKey = req.query.admin_key;
  if (adminKey !== process.env.ADMIN_KEY) {
    return res.status(403).json({ error: 'Adgang nægtet' });
  }

  // Sæt SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  function send(data) {
    res.write('data: ' + JSON.stringify(data) + '\n\n');
  }

  try {
    send({ type: 'start', total: SEARCH_TERMS.length, message: 'Starter tilbudshentning...' });

    let totalSaved = 0;
    const seen = new Set();

    await db.query(`DELETE FROM offers WHERE valid_till < NOW() - INTERVAL '1 day'`)
      .catch(e => console.warn('Slet fejl:', e.message));

    for (let i = 0; i < SEARCH_TERMS.length; i++) {
      const term = SEARCH_TERMS[i];
      send({ type: 'progress', current: i + 1, total: SEARCH_TERMS.length, term, message: `Henter "${term}"...` });

      try {
        const params = new URLSearchParams({
          r_locale: 'da_DK', query: term,
          offset: 0, limit: 48,
          r_lat: 55.676, r_lng: 12.568, r_radius: 50000
        });

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 12000);
        let r;
        try {
          r = await fetch(
            `https://squid-api.tjek.com/v2/offers/search?${params}`,
            { headers: { 'Accept': 'application/json', 'X-Api-Av': '0.3.0' }, signal: controller.signal }
          );
          clearTimeout(timeout);
        } catch(fetchErr) {
          clearTimeout(timeout);
          send({ type: 'warning', term, message: `Netværksfejl for "${term}" — springer over` });
          continue;
        }

        if (!r.ok) {
          send({ type: 'warning', term, message: `API svarede ${r.status} for "${term}"` });
          continue;
        }

        let data;
        try { data = await r.json(); }
        catch(e) { send({ type: 'warning', term, message: `JSON fejl for "${term}"` }); continue; }

        const list = Array.isArray(data) ? data : (data.results || []);
        let termSaved = 0;

        for (const o of list) {
          const id = o.id;
          if (!id || seen.has(id)) continue;
          seen.add(id);
          const price = o.pricing?.price?.amount != null ? o.pricing.price.amount / 100 : null;
          if (!price || !o.heading) continue;
          try {
            await db.query(`
              INSERT INTO offers (id, name, price, orig_price, pct_off, store, unit, img_url, valid_till, category, fetched_at)
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
              ON CONFLICT (id) DO UPDATE SET price=$3, orig_price=$4, pct_off=$5, img_url=$8, valid_till=$9, fetched_at=NOW()
            `, [
              id, o.heading, price,
              o.pricing?.pre_price?.amount != null ? o.pricing.pre_price.amount / 100 : null,
              o.pricing?.discount != null ? Math.round(o.pricing.discount) : null,
              o.branding?.name || 'Ukendt',
              o.quantity?.unit || null,
              o.images?.view || o.images?.thumb || null,
              o.run_till || null,
              term
            ]);
            termSaved++;
            totalSaved++;
          } catch(dbErr) {
            // Ignorer duplikater
          }
        }

        send({ type: 'term_done', term, found: list.length, saved: termSaved, total_so_far: totalSaved });
        await new Promise(r => setTimeout(r, 400));

      } catch(e) {
        send({ type: 'warning', term, message: `Fejl for "${term}": ${e.message}` });
      }
    }

    await db.query('INSERT INTO offer_fetch_log (offer_count, status) VALUES ($1, $2)', [totalSaved, 'success'])
      .catch(() => {});

    send({ type: 'done', total_saved: totalSaved, message: `✅ Færdig! ${totalSaved} tilbud gemt i database.` });

  } catch(e) {
    send({ type: 'error', message: e.message });
  }

  res.end();
});

// Behold det gamle endpoint som fallback
app.post('/api/offers/refresh', async (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  if (adminKey !== process.env.ADMIN_KEY) {
    return res.status(403).json({ error: 'Adgang nægtet' });
  }
  res.json({ success: true, message: 'Brug /api/offers/refresh-stream i stedet' });
  fetchAndSaveOffers()
    .then(count => console.log(`Baggrunds-refresh: ${count} tilbud`))
    .catch(e => console.error('Baggrunds-refresh fejl:', e.message));
});

// Status på seneste tilbudshentning
app.get('/api/offers/status', requireAuth, async (req, res) => {
  try {
    const count = await db.query('SELECT COUNT(*) FROM offers WHERE valid_till > NOW() OR valid_till IS NULL');
    const last = await db.query('SELECT * FROM offer_fetch_log ORDER BY fetched_at DESC LIMIT 1');
    res.json({
      active_offers: parseInt(count.rows[0].count),
      last_fetch: last.rows[0] || null
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── TILBUD HENTNING (kernes) ──
const SEARCH_TERMS = [
  'kylling', 'oksekød', 'laks', 'svinekød', 'fisk',
  'pasta', 'ris', 'brød', 'kartofler', 'grøntsager',
  'mælk', 'ost', 'æg', 'smør', 'fløde',
  'frugt', 'tomater', 'løg', 'gulerødder', 'salat'
];

async function fetchAndSaveOffers() {
  console.log('Starter tilbudshentning fra eTilbudsavis...');
  const allOffers = [];
  const seen = new Set();

  for (const term of SEARCH_TERMS) {
    try {
      const params = new URLSearchParams({
        r_locale: 'da_DK',
        query: term,
        offset: 0,
        limit: 48,
        r_lat: 55.676,
        r_lng: 12.568,
        r_radius: 50000
      });

      // Timeout efter 10 sekunder
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);

      let r;
      try {
        r = await fetch(
          `https://squid-api.tjek.com/v2/offers/search?${params}`,
          {
            headers: { 'Accept': 'application/json', 'X-Api-Av': '0.3.0' },
            signal: controller.signal
          }
        );
        clearTimeout(timeout);
      } catch(fetchErr) {
        clearTimeout(timeout);
        console.warn(`Netværksfejl for "${term}": ${fetchErr.message}`);
        continue;
      }

      console.log(`eTilbudsavis svar for "${term}": ${r.status}`);
      if (!r.ok) {
        const errText = await r.text().catch(() => '');
        console.warn(`eTilbudsavis fejlede for "${term}": ${r.status} — ${errText.substring(0,100)}`);
        continue;
      }

      let data;
      try {
        data = await r.json();
      } catch(jsonErr) {
        console.warn(`JSON parse fejl for "${term}": ${jsonErr.message}`);
        continue;
      }
      const list = Array.isArray(data) ? data : (data.results || []);
      console.log(`  → ${list.length} resultater for "${term}"`);

      list.forEach(o => {
        const id = o.id || Math.random().toString(36).substr(2);
        if (seen.has(id)) return;
        seen.add(id);

        const price = o.pricing?.price?.amount != null ? o.pricing.price.amount / 100 : null;
        if (!price || !o.heading) return;

        allOffers.push({
          id,
          name: o.heading,
          price,
          orig_price: o.pricing?.pre_price?.amount != null ? o.pricing.pre_price.amount / 100 : null,
          pct_off: o.pricing?.discount != null ? Math.round(o.pricing.discount) : null,
          store: o.branding?.name || 'Ukendt',
          unit: o.quantity?.unit || null,
          img_url: o.images?.view || o.images?.thumb || null,
          valid_till: o.run_till || null,
          category: term
        });
      });

      // Respektér API'et — vent lidt mellem kald
      await new Promise(r => setTimeout(r, 300));

    } catch(e) {
      console.warn(`Fejl for "${term}":`, e.message);
    }
  }

  console.log(`Hentning færdig — ${allOffers.length} tilbud klar til database`);

  // Gem i database
  if (allOffers.length > 0) {
    console.log('Starter database-gem...');
    const client = await db.connect();
    try {
      await client.query('BEGIN');

      // Slet gamle tilbud der er udløbet
      await client.query(`DELETE FROM offers WHERE valid_till < NOW() - INTERVAL '1 day'`);

      // Indsæt nye tilbud
      for (const o of allOffers) {
        await client.query(`
          INSERT INTO offers (id, name, price, orig_price, pct_off, store, unit, img_url, valid_till, category, fetched_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
          ON CONFLICT (id) DO UPDATE SET
            price=$3, orig_price=$4, pct_off=$5, img_url=$8,
            valid_till=$9, fetched_at=NOW()
        `, [o.id, o.name, o.price, o.orig_price, o.pct_off, o.store, o.unit, o.img_url, o.valid_till, o.category]);
      }

      await client.query('COMMIT');
    } catch(e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    // Log hentningen
    await db.query(
      'INSERT INTO offer_fetch_log (offer_count, status) VALUES ($1, $2)',
      [allOffers.length, 'success']
    );

    console.log(`✅ ${allOffers.length} tilbud gemt i database`);
    console.log('Database-gem afsluttet succesfuldt');
  }

  console.log('fetchAndSaveOffers returnerer:', allOffers.length);
  return allOffers.length;
}

// ── CRON JOB — kør hver nat kl. 02:00 ──
function scheduleNightlyFetch() {
  const now = new Date();
  const next = new Date();
  next.setHours(2, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);

  const msUntilNext = next - now;
  console.log(`Næste tilbudsopdatering: ${next.toLocaleString('da-DK')} (om ${Math.round(msUntilNext/3600000)} timer)`);

  setTimeout(async () => {
    try {
      await fetchAndSaveOffers();
    } catch(e) {
      console.error('Nattlig tilbudshentning fejlede:', e.message);
      await db.query('INSERT INTO offer_fetch_log (offer_count, status) VALUES (0, $1)', ['error: ' + e.message]);
    }
    // Planlæg næste kørsel (24 timer)
    setInterval(async () => {
      try {
        await fetchAndSaveOffers();
      } catch(e) {
        console.error('Tilbudshentning fejlede:', e.message);
      }
    }, 24 * 60 * 60 * 1000);
  }, msUntilNext);
}

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
  } catch(e) {
    console.error('Claude proxy fejl:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── START ──
app.listen(process.env.PORT || 3000, async () => {
  console.log('Server kører på port', process.env.PORT || 3000);
  if (!process.env.ANTHROPIC_KEY) console.warn('ADVARSEL: ANTHROPIC_KEY mangler!');
  if (!process.env.JWT_SECRET) console.warn('ADVARSEL: JWT_SECRET mangler!');
  if (!process.env.ADMIN_KEY) console.warn('ADVARSEL: ADMIN_KEY mangler!');

  // Hent tilbud ved opstart hvis databasen er tom
  try {
    const count = await db.query('SELECT COUNT(*) FROM offers');
    if (parseInt(count.rows[0].count) === 0) {
      console.log('Database tom — henter tilbud ved opstart...');
      fetchAndSaveOffers().catch(e => console.error('Opstart tilbud fejl:', e.message));
    } else {
      console.log(`Database har ${count.rows[0].count} tilbud`);
    }
  } catch(e) {
    console.warn('Kunne ikke tjekke tilbud count:', e.message);
  }

  // Start nattlig cron
  scheduleNightlyFetch();
});
