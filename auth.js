/* ═══════════════════════════════════════════
   MADPLANEN — Shared Auth Module
   Inkluderes på alle sider via <script src="auth.js">
═══════════════════════════════════════════ */

const Auth = {
  // Gem token og brugerinfo
  save(token, user) {
    localStorage.setItem('mp_token', token);
    localStorage.setItem('mp_user', JSON.stringify(user));
  },

  // Hent token
  token() {
    return localStorage.getItem('mp_token');
  },

  // Hent bruger
  user() {
    try { return JSON.parse(localStorage.getItem('mp_user')); }
    catch(e) { return null; }
  },

  // Er logget ind?
  isLoggedIn() {
    return !!this.token();
  },

  // Log ud
  logout() {
    localStorage.removeItem('mp_token');
    localStorage.removeItem('mp_user');
    window.location.href = 'login.html';
  },

  // Headers til alle API-kald
  headers() {
    return {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + this.token()
    };
  },

  // Tjek login ved sideload — redirect til login hvis ikke logget ind
  async requireLogin() {
    if (!this.isLoggedIn()) {
      window.location.href = 'login.html';
      return false;
    }
    // Verificer token er gyldigt
    try {
      const r = await fetch('/api/auth/me', {
        headers: { 'Authorization': 'Bearer ' + this.token() }
      });
      if (!r.ok) {
        this.logout();
        return false;
      }
      const user = await r.json();
      this.save(this.token(), user);
      return user;
    } catch(e) {
      // Hvis serveren ikke kan nås, tillad lokal brug
      return this.user();
    }
  },

  // Wrapper til fetch der altid sender auth-header
  async fetch(url, options = {}) {
    const r = await fetch(url, {
      ...options,
      headers: {
        ...this.headers(),
        ...(options.headers || {})
      }
    });
    if (r.status === 401) {
      this.logout();
      return null;
    }
    return r;
  }
};
