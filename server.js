require('dotenv').config();
const express  = require('express');
const path     = require('path');
const Database = require('better-sqlite3');
const multer   = require('multer');
const XLSX     = require('xlsx');

const app    = express();
const PORT   = process.env.PORT || 8080;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });

// ── SQLite ────────────────────────────────────────────────────────────────
const db = new Database(path.join(__dirname, 'bookings.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS bookings (
    id           TEXT PRIMARY KEY,
    data         TEXT NOT NULL,
    start_date   TEXT,
    created_date TEXT,
    status       TEXT,
    synced_at    TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_start   ON bookings(start_date);
  CREATE INDEX IF NOT EXISTS idx_created ON bookings(created_date);
  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY, value TEXT
  );
`);

const stmtUpsert  = db.prepare(`
  INSERT OR REPLACE INTO bookings (id, data, start_date, created_date, status, synced_at)
  VALUES (@id, @data, @start_date, @created_date, @status, datetime('now'))
`);
const stmtByMonth = db.prepare('SELECT data FROM bookings WHERE start_date LIKE ?');
const stmtCount   = db.prepare('SELECT COUNT(*) AS c FROM bookings');
const stmtMetaGet = db.prepare('SELECT value FROM meta WHERE key = ?');
const stmtMetaSet = db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)');

function getMeta(k) { const r = stmtMetaGet.get(k); return r ? r.value : null; }
function setMeta(k, v) { stmtMetaSet.run(k, String(v)); }

// ── Helpers de parseo ─────────────────────────────────────────────────────
function toDateStr(val) {
  if (!val) return null;
  if (val instanceof Date) return isNaN(val) ? null : val.toISOString().split('T')[0];
  const s = String(val).trim();
  // DD/MM/YYYY o DD-MM-YYYY
  const dmy = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
  if (dmy) return `${dmy[3]}-${dmy[2].padStart(2,'0')}-${dmy[1].padStart(2,'0')}`;
  // YYYY-MM-DD o ISO
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString().split('T')[0];
}

// Busca columna ignorando mayúsculas, tildes, espacios y caracteres especiales
function col(row, ...candidates) {
  const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[^a-z0-9]/g, '');
  const normed = candidates.map(norm);
  const key = Object.keys(row).find(k => normed.includes(norm(k)));
  return key !== undefined ? row[key] : '';
}

function mapRow(row) {
  const start        = toDateStr(col(row, 'Fecha de realización', 'Fecha realizacion', 'start', 'fecha_cita', 'fecha'));
  const created_date = toDateStr(col(row, 'Fecha de creación',    'Fecha de creacion',  'created_date', 'fecha_creacion'));
  const status       = String(col(row, 'Estado', 'status') || '').trim();
  const service      = String(col(row, 'Servicio', 'service', 'service_name') || '').trim();
  const clientNum    = String(col(row, 'N° de Cliente', 'N de Cliente', 'client_id', 'cliente_id', 'ID Cliente') || '').trim();
  const nombre       = String(col(row, 'Nombre', 'first_name', 'nombre') || '').trim();
  const apellido     = String(col(row, 'Apellido', 'last_name', 'apellido') || '').trim();
  const precio       = col(row, 'Precio real', 'precio_real', 'price', 'precio');
  const prestador    = String(col(row, 'Prestador', 'provider', 'profesional') || '').trim();
  const local        = String(col(row, 'Local', 'location', 'sucursal') || '').trim();
  const origen       = String(col(row, 'Origen', 'origin', 'source') || '').trim();

  return { start, created_date, status, service, clientNum, nombre, apellido, precio, prestador, local, origen };
}

// Genera un ID determinista por combinación única
function makeId(start, clientNum, service) {
  return [start || '', clientNum || '', service || ''].join('|');
}

// ── Guardar en SQLite ─────────────────────────────────────────────────────
const saveMany = db.transaction((rows) => {
  let saved = 0, dupes = 0;
  for (const r of rows) {
    const id = makeId(r.start, r.clientNum, r.service);
    if (!r.start && !r.clientNum && !r.service) { dupes++; continue; }

    const data = JSON.stringify({
      start:          r.start,
      created_date:   r.created_date,
      status:         r.status,
      service:        r.service,
      client_id:      r.clientNum,
      cliente_nombre: `${r.nombre} ${r.apellido}`.trim(),
      precio:         r.precio,
      prestador:      r.prestador,
      local:          r.local,
      origen:         r.origen,
    });

    const existing = db.prepare('SELECT id FROM bookings WHERE id = ?').get(id);
    stmtUpsert.run({ id, data, start_date: r.start || null, created_date: r.created_date || null, status: r.status || null });
    existing ? dupes++ : saved++;
  }
  return { saved, dupes };
});

// ── Estadísticas ──────────────────────────────────────────────────────────
function bookingStatus(b) {
  const s = (b.status || '').toLowerCase().trim()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/-/g, '_');
  if (['asiste', 'attended', 'completed', 'present'].includes(s))             return 'attended';
  if (['cancelado', 'cancelada', 'cancelled', 'canceled'].includes(s))        return 'cancelled';
  if (['no_show', 'no_asiste', 'absent', 'missed', 'no_showed'].includes(s))  return 'no_show';
  if (['reservado', 'confirmado', 'confirmed', 'pending'].includes(s))         return 'pending';
  return 'other';
}

function buildStats(year, month) {
  const pad         = (n) => String(n).padStart(2, '0');
  const monthPrefix = `${year}-${pad(month)}`;
  const daysInMonth = new Date(year, month, 0).getDate();

  const rows     = stmtByMonth.all(`${monthPrefix}%`);
  const bookings = rows.map(r => JSON.parse(r.data));

  // Por día
  const dayLabels = [], dayCounts = [];
  for (let d = 1; d <= daysInMonth; d++) {
    const ds = `${monthPrefix}-${pad(d)}`;
    dayLabels.push(String(d));
    dayCounts.push(bookings.filter(b => String(b.start || '').slice(0,10) === ds).length);
  }

  // Por semana
  const weekLabels = [], weekCounts = [];
  const monthShort = new Date(year, month - 1, 1).toLocaleDateString('es-CL', { month: 'short' });
  for (let w = 0; w < 5; w++) {
    const wS = w * 7 + 1, wE = Math.min(wS + 6, daysInMonth);
    if (wS > daysInMonth) break;
    weekLabels.push(`${wS}–${wE} ${monthShort}`);
    weekCounts.push(bookings.filter(b => {
      const day = parseInt(String(b.start || '').slice(8, 10));
      return !isNaN(day) && day >= wS && day <= wE;
    }).length);
  }

  // Estado
  const statusCount = { attended: 0, pending: 0, cancelled: 0, no_show: 0, other: 0 };
  bookings.forEach(b => statusCount[bookingStatus(b)]++);
  const resolved = statusCount.attended + statusCount.cancelled + statusCount.no_show;
  const attendanceRate = resolved > 0 ? Math.round(statusCount.attended / resolved * 100) : 0;

  // Clientes nuevos vs recurrentes (por N° de cliente)
  const clientVisits = {};
  bookings.forEach(b => {
    const id = b.client_id;
    if (id) clientVisits[id] = (clientVisits[id] || 0) + 1;
  });

  // Servicios más solicitados
  const serviceCounts = {};
  bookings.forEach(b => {
    const name = (typeof b.service === 'string' ? b.service : b.service?.name) || 'Sin nombre';
    serviceCounts[name] = (serviceCounts[name] || 0) + 1;
  });

  // Creadas por día
  const creationMap = {};
  bookings.forEach(b => {
    const ds = String(b.created_date || '').slice(0, 10);
    if (ds) creationMap[ds] = (creationMap[ds] || 0) + 1;
  });
  const creationDates = Object.keys(creationMap).sort();

  return {
    total: bookings.length,
    attendanceRate,
    byDay:      { labels: dayLabels,  data: dayCounts  },
    byWeek:     { labels: weekLabels, data: weekCounts },
    byCreation: {
      labels: creationDates.map(d => { const [,m,day] = d.split('-'); return `${parseInt(day)}/${parseInt(m)}`; }),
      data:   creationDates.map(d => creationMap[d]),
    },
    status:  statusCount,
    clients: {
      new:       Object.values(clientVisits).filter(c => c === 1).length,
      recurring: Object.values(clientVisits).filter(c => c > 1).length,
    },
    services: Object.entries(serviceCounts)
      .sort((a, b) => b[1] - a[1]).slice(0, 10)
      .map(([name, count]) => ({ name, count })),
  };
}

// ── Rutas ──────────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/sync-status', (_req, res) => {
  res.json({ running: false, dbTotal: stmtCount.get().c, lastImport: getMeta('last_import') });
});

app.get('/api/stats', (req, res) => {
  const now   = new Date();
  const year  = parseInt(req.query.year)  || now.getFullYear();
  const month = parseInt(req.query.month) || (now.getMonth() + 1);
  if (month < 1 || month > 12) return res.status(400).json({ error: 'Mes inválido' });
  try {
    res.json({ stats: buildStats(year, month), year, month, fetchedAt: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/import', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No se recibió archivo' });

  try {
    const wb   = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });
    const ws   = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });

    if (rows.length === 0) return res.status(400).json({ error: 'El archivo no tiene datos' });

    const mapped = rows.map(mapRow);
    const { saved, dupes } = saveMany(mapped);

    setMeta('last_import', new Date().toISOString());
    const dbTotal = stmtCount.get().c;
    console.log(`[import] ${req.file.originalname}: ${rows.length} filas → ${saved} nuevos, ${dupes} duplicados. DB total: ${dbTotal}`);
    res.json({ ok: true, rows: rows.length, saved, dupes, dbTotal });
  } catch (err) {
    console.error('[import]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Inicio ─────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Servidor en http://localhost:${PORT}`);
  console.log(`DB: ${stmtCount.get().c} bookings`);
});
