const express = require('express');
const cron = require('node-cron');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8080;
const API_BASE = 'https://api.agendapro.com/v1';
const TIMEZONE = process.env.TZ || 'America/Santiago';

let cachedStats = null;
let lastUpdated = null;
let refreshing = false;

// ── Auth ───────────────────────────────────────────────────────────────────
function authHeader() {
  const user = process.env.AGENDAPRO_USER || '';
  const pass = process.env.AGENDAPRO_PASSWORD || '';
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

// ── AgendaPro fetch con paginación ─────────────────────────────────────────
async function apiFetch(endpoint, params = {}) {
  const url = new URL(`${API_BASE}${endpoint}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  const res = await fetch(url.toString(), {
    headers: { Authorization: authHeader(), Accept: 'application/json' },
    timeout: 15000,
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`AgendaPro ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

async function fetchAllBookings(startDate, endDate) {
  const allBookings = [];
  let page = 1;

  while (true) {
    const data = await apiFetch('/bookings', {
      start_date: startDate,
      end_date: endDate,
      per_page: 100,
      page,
    });

    const items = Array.isArray(data) ? data : (data.bookings || data.data || []);
    allBookings.push(...items);

    // Paginación: si devuelve menos de 100 registros, terminamos
    if (items.length < 100) break;
    page++;
  }

  return allBookings;
}

// ── Utilidades de fecha ────────────────────────────────────────────────────
function isoDate(d) {
  return d.toISOString().split('T')[0];
}

function subtractDays(d, n) {
  const r = new Date(d);
  r.setDate(r.getDate() - n);
  return r;
}

function bookingDate(b) {
  return new Date(b.date || b.start_time || b.starts_at || b.created_at);
}

function bookingStatus(b) {
  const s = (b.status || '').toLowerCase().replace(/-/g, '_');
  if (['attended', 'completed', 'confirmed', 'present'].includes(s)) return 'attended';
  if (['cancelled', 'canceled'].includes(s)) return 'cancelled';
  if (['no_show', 'absent', 'missed', 'no_showed'].includes(s)) return 'no_show';
  return 'other';
}

// ── Construcción de estadísticas ───────────────────────────────────────────
async function buildStats() {
  const now = new Date();
  const sixMonthsAgo = new Date(now);
  sixMonthsAgo.setMonth(now.getMonth() - 6);

  const bookings = await fetchAllBookings(isoDate(sixMonthsAgo), isoDate(now));

  // --- Citas por día (últimos 7 días) ---
  const dayLabels = [];
  const dayCounts = [];
  for (let i = 6; i >= 0; i--) {
    const d = subtractDays(now, i);
    dayLabels.push(
      d.toLocaleDateString('es-CL', { weekday: 'short', day: 'numeric', month: 'short' })
    );
    dayCounts.push(
      bookings.filter((b) => isoDate(bookingDate(b)) === isoDate(d)).length
    );
  }

  // --- Citas por semana (últimas 8 semanas) ---
  const weekLabels = [];
  const weekCounts = [];
  for (let i = 7; i >= 0; i--) {
    const weekEnd = subtractDays(now, i * 7);
    const weekStart = subtractDays(weekEnd, 6);
    const label = weekStart.toLocaleDateString('es-CL', { day: 'numeric', month: 'short' });
    weekLabels.push(label);
    weekCounts.push(
      bookings.filter((b) => {
        const bd = bookingDate(b);
        return bd >= weekStart && bd <= weekEnd;
      }).length
    );
  }

  // --- Citas por mes (últimos 6 meses) ---
  const monthLabels = [];
  const monthCounts = [];
  for (let i = 5; i >= 0; i--) {
    const m = new Date(now.getFullYear(), now.getMonth() - i, 1);
    monthLabels.push(m.toLocaleDateString('es-CL', { month: 'short', year: 'numeric' }));
    monthCounts.push(
      bookings.filter((b) => {
        const bd = bookingDate(b);
        return bd.getMonth() === m.getMonth() && bd.getFullYear() === m.getFullYear();
      }).length
    );
  }

  // --- Estado de citas ---
  const statusCount = { attended: 0, cancelled: 0, no_show: 0, other: 0 };
  bookings.forEach((b) => statusCount[bookingStatus(b)]++);

  // --- Clientes nuevos vs recurrentes ---
  const clientVisits = {};
  bookings.forEach((b) => {
    const id = b.client_id || b.customer_id || b.client?.id || b.user_id;
    if (id) clientVisits[id] = (clientVisits[id] || 0) + 1;
  });
  const newClients = Object.values(clientVisits).filter((c) => c === 1).length;
  const recurringClients = Object.values(clientVisits).filter((c) => c > 1).length;

  // --- Servicios más solicitados ---
  const serviceCounts = {};
  bookings.forEach((b) => {
    const name =
      b.service_name ||
      b.service?.name ||
      b.service?.title ||
      b.service ||
      'Sin nombre';
    serviceCounts[name] = (serviceCounts[name] || 0) + 1;
  });
  const topServices = Object.entries(serviceCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([name, count]) => ({ name, count }));

  // --- KPIs del mes actual ---
  const thisMonth = bookings.filter((b) => {
    const bd = bookingDate(b);
    return bd.getMonth() === now.getMonth() && bd.getFullYear() === now.getFullYear();
  });
  const attendanceRate =
    thisMonth.length > 0
      ? Math.round((statusCount.attended / bookings.length) * 100)
      : 0;

  return {
    total: bookings.length,
    thisMonth: thisMonth.length,
    attendanceRate,
    byDay: { labels: dayLabels, data: dayCounts },
    byWeek: { labels: weekLabels, data: weekCounts },
    byMonth: { labels: monthLabels, data: monthCounts },
    status: statusCount,
    clients: { new: newClients, recurring: recurringClients },
    services: topServices,
  };
}

// ── Refresh ────────────────────────────────────────────────────────────────
async function refreshStats() {
  if (refreshing) return;
  refreshing = true;
  try {
    console.log('[refresh] Actualizando estadísticas...');
    cachedStats = await buildStats();
    lastUpdated = new Date().toISOString();
    console.log('[refresh] OK -', lastUpdated);
  } catch (err) {
    console.error('[refresh] Error:', err.message);
  } finally {
    refreshing = false;
  }
}

// ── Rutas ──────────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/stats', async (req, res) => {
  if (!cachedStats) await refreshStats();
  if (!cachedStats) return res.status(503).json({ error: 'Datos no disponibles' });
  res.json({ stats: cachedStats, lastUpdated, refreshing });
});

app.post('/api/refresh', async (req, res) => {
  refreshStats(); // no await → responde inmediato
  res.json({ ok: true, message: 'Actualizando en segundo plano...' });
});

// ── Cron: lunes–sábado a las 7:00 y 19:00 ─────────────────────────────────
cron.schedule('0 7,19 * * 1-6', () => {
  console.log('[cron] Disparando refresh programado');
  refreshStats();
}, { timezone: TIMEZONE });

// ── Inicio ─────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Servidor en http://localhost:${PORT}`);
  console.log(`Cron: lun-sáb 7:00 y 19:00 (${TIMEZONE})`);
  refreshStats();
});
