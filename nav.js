/* ═══════════════════════════════════════════
   MADPLANEN — Shared Navigation Component
═══════════════════════════════════════════ */

const NAV_PAGES = [
  {
    id: 'index',
    label: 'Hjem',
    file: 'index.html',
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/>
      <polyline points="9 22 9 12 15 12 15 22"/>
    </svg>`,
  },
  {
    id: 'madplan',
    label: 'Madplan',
    file: 'madplan.html',
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <rect x="3" y="4" width="18" height="18" rx="2"/>
      <line x1="16" y1="2" x2="16" y2="6"/>
      <line x1="8" y1="2" x2="8" y2="6"/>
      <line x1="3" y1="10" x2="21" y2="10"/>
      <line x1="8" y1="14" x2="10" y2="14"/>
      <line x1="8" y1="18" x2="14" y2="18"/>
    </svg>`,
  },
  {
    id: 'tilbud',
    label: 'Tilbud',
    file: 'tilbud.html',
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <path d="M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82z"/>
      <line x1="7" y1="7" x2="7.01" y2="7"/>
    </svg>`,
  },
  {
    id: 'opskrifter',
    label: 'Opskrifter',
    file: 'opskrifter.html',
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <path d="M12 2a10 10 0 100 20 10 10 0 000-20z"/>
      <path d="M12 8v4l3 3"/>
      <path d="M8.5 3.5C6 5 4 7.5 3.5 10.5"/>
    </svg>`,
  },
  {
    id: 'indkobsliste',
    label: 'Indkøb',
    file: 'indkobsliste.html',
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="9" cy="21" r="1"/>
      <circle cx="20" cy="21" r="1"/>
      <path d="M1 1h4l2.68 13.39a2 2 0 002 1.61h9.72a2 2 0 002-1.61L23 6H6"/>
    </svg>`,
  },
  {
    id: 'praeferencer',
    label: 'Mig',
    file: 'praeferencer.html',
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/>
      <circle cx="12" cy="7" r="4"/>
    </svg>`,
  },
];

function getWeekNumber() {
  const d = new Date();
  d.setHours(0,0,0,0);
  d.setDate(d.getDate() + 4 - (d.getDay() || 7));
  const y = new Date(d.getFullYear(), 0, 1);
  return Math.ceil(((d - y) / 86400000 + 1) / 7);
}

function buildNav(activePage) {
  const week = getWeekNumber();
  const year = new Date().getFullYear();

  // ── TOP NAV (desktop) ──
  const topNav = document.createElement('nav');
  topNav.className = 'top-nav';
  topNav.innerHTML = `
    <a href="madplan.html" class="top-nav-logo">Mad<em>plan</em>en</a>
    <div class="top-nav-links">
      ${NAV_PAGES.map(p => `
        <a href="${p.file}" class="top-nav-link ${p.id === activePage ? 'active' : ''}">
          ${p.icon} ${p.label}
        </a>`).join('')}
    </div>
    <div class="top-nav-right">
      <div class="top-nav-user">
        <div class="top-nav-avatar">M</div>
        <span>Mette</span>
      </div>
      <div class="top-nav-week">Uge ${week} · ${year}</div>
    </div>
  `;

  // ── BOTTOM NAV (mobile) ──
  const bottomNav = document.createElement('nav');
  bottomNav.className = 'bottom-nav';
  bottomNav.setAttribute('aria-label', 'Hovednavigation');
  bottomNav.innerHTML = `
    <div class="bottom-nav-inner">
      ${NAV_PAGES.map(p => `
        <a href="${p.file}" class="bottom-tab ${p.id === activePage ? 'active' : ''}" aria-label="${p.label}">
          ${p.icon}
          <span>${p.label}</span>
        </a>`).join('')}
    </div>
  `;

  document.body.prepend(topNav);
  document.body.appendChild(bottomNav);
}
