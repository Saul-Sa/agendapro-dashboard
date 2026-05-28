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
  CREATE INDEX IF NOT EXISTS idx_status  ON bookings(status);
  CREATE INDEX IF NOT EXISTS idx_start_status ON bookings(start_date, status);
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
  const start          = toDateStr(col(row, 'Fecha de realización', 'Fecha realizacion', 'start', 'fecha_cita', 'fecha'));
  const created_date   = toDateStr(col(row, 'Fecha de creación',    'Fecha de creacion',  'created_date', 'fecha_creacion'));
  const created_by     = String(col(row, 'Responsable creación', 'Responsable creacion', 'Creado por', 'Usuario', 'Usuario creación', 'created_by', 'responsable') || '').trim();
  const status         = String(col(row, 'Estado', 'status') || '').trim();
  const service        = String(col(row, 'Servicio', 'service', 'service_name') || '').trim();
  const clientNum      = String(col(row, 'N° de Cliente', 'N de Cliente', 'client_id', 'cliente_id', 'ID Cliente') || '').trim();
  const identificacion = String(col(row, 'N.º de identificación', 'N de identificacion', 'Numero de identificacion', 'identificacion', 'rut', 'dni', 'cedula') || '').trim();
  const nombre         = String(col(row, 'Nombre', 'first_name', 'nombre') || '').trim();
  const apellido       = String(col(row, 'Apellido', 'last_name', 'apellido') || '').trim();
  const precio         = col(row, 'Precio real', 'precio_real', 'price', 'precio');
  const prestador      = String(col(row, 'Prestador', 'provider', 'profesional') || '').trim();
  const local          = String(col(row, 'Local', 'location', 'sucursal') || '').trim();
  const origen         = String(col(row, 'Origen', 'origin', 'source') || '').trim();

  return { start, created_date, created_by, status, service, clientNum, identificacion, nombre, apellido, precio, prestador, local, origen };
}

// Genera un ID determinista por combinación única:
// Fecha de realización + N.º de identificación + Servicio + Prestador + Fecha creación + Responsable creación
function makeId(start, identificacion, service, prestador, created_date, created_by) {
  return [
    start || '',
    identificacion || '',
    service || '',
    prestador || '',
    created_date || '',
    created_by || ''
  ].join('|');
}

// ── Guardar en SQLite ─────────────────────────────────────────────────────
const saveMany = db.transaction((rows) => {
  let newRecords = 0, updated = 0, unchanged = 0;

  for (const r of rows) {
    const id = makeId(r.start, r.identificacion, r.service, r.prestador, r.created_date, r.created_by);

    const newData = JSON.stringify({
      start:          r.start,
      created_date:   r.created_date,
      created_by:     r.created_by,
      status:         r.status,
      service:        r.service,
      client_id:      r.clientNum,
      identificacion: r.identificacion,
      cliente_nombre: `${r.nombre} ${r.apellido}`.trim(),
      precio:         r.precio,
      prestador:      r.prestador,
      local:          r.local,
      origen:         r.origen,
    });

    const existing = db.prepare('SELECT data FROM bookings WHERE id = ?').get(id);

    // Normalizar status para queries rápidas
    const normalizedStatus = bookingStatus({ status: r.status });

    if (!existing) {
      // Registro nuevo
      stmtUpsert.run({ id, data: newData, start_date: r.start || null, created_date: r.created_date || null, status: normalizedStatus });
      newRecords++;
    } else if (existing.data !== newData) {
      // Registro existe pero datos cambiaron (profesional, estado, etc.)
      stmtUpsert.run({ id, data: newData, start_date: r.start || null, created_date: r.created_date || null, status: normalizedStatus });
      updated++;
    } else {
      // Registro existe y es idéntico (sin cambios)
      unchanged++;
    }
  }

  return { newRecords, updated, unchanged };
});

// ── Estadísticas ──────────────────────────────────────────────────────────
function bookingStatus(b) {
  // Normaliza: minúsculas, sin tildes, espacios Y guiones → guion bajo
  const s = (b.status || '').toLowerCase().trim()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[-\s]+/g, '_');
  if (['asiste', 'attended', 'completed', 'present'].includes(s))              return 'asiste';
  if (['confirmado', 'confirmed'].includes(s))                                  return 'confirmado';
  if (['reservado', 'booked'].includes(s))                                      return 'reservado';
  if (['pendiente', 'pending'].includes(s))                                     return 'pendiente';
  if (['cancelado', 'cancelada', 'cancelled', 'canceled'].includes(s))         return 'cancelado';
  if (['no_asiste', 'no_show', 'absent', 'missed', 'no_showed'].includes(s))   return 'no_asiste';
  return 'otro';
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
  const statusCount = { asiste: 0, confirmado: 0, reservado: 0, pendiente: 0, cancelado: 0, no_asiste: 0, otro: 0 };
  bookings.forEach(b => statusCount[bookingStatus(b)]++);
  const resolved = statusCount.asiste + statusCount.cancelado + statusCount.no_asiste;
  const attendanceRate = resolved > 0 ? Math.round(statusCount.asiste / resolved * 100) : 0;

  // Clientes nuevos vs recurrentes - SUPER OPTIMIZADO con subquery SQL
  const clientStats = db.prepare(`
    WITH current_month_clients AS (
      SELECT DISTINCT JSON_EXTRACT(data, '$.identificacion') as identificacion
      FROM bookings
      WHERE start_date LIKE ?
        AND JSON_EXTRACT(data, '$.identificacion') IS NOT NULL
        AND JSON_EXTRACT(data, '$.identificacion') != ''
    ),
    first_dates AS (
      SELECT
        JSON_EXTRACT(data, '$.identificacion') as identificacion,
        MIN(start_date) as first_date
      FROM bookings
      WHERE JSON_EXTRACT(data, '$.identificacion') IN (SELECT identificacion FROM current_month_clients)
        AND start_date IS NOT NULL
      GROUP BY identificacion
    )
    SELECT
      SUM(CASE WHEN first_date LIKE ? THEN 1 ELSE 0 END) as new_clients,
      SUM(CASE WHEN first_date NOT LIKE ? THEN 1 ELSE 0 END) as recurring_clients
    FROM first_dates
  `).get(`${monthPrefix}%`, `${monthPrefix}%`, `${monthPrefix}%`);

  const newClients = clientStats?.new_clients || 0;
  const recurringClients = clientStats?.recurring_clients || 0;

  // Función para normalizar y agrupar servicios
  function normalizeServiceName(name) {
    // 1. Eliminar "desde" al final (case-insensitive)
    let clean = name.replace(/\s*desde\s*$/i, '').trim();

    // 2. Agrupar "Terapia Vitality" (todas las variantes: Intensiva, Estándar, X3, X6, X9, etc.)
    if (clean.toLowerCase().startsWith('terapia vitality')) {
      return 'Terapia Vitality';
    }

    // 3. Extraer categoría base (antes del paréntesis)
    const match = clean.match(/^([^(]+)/);
    return match ? match[1].trim() : clean;
  }

  // Servicios más solicitados (agrupados por categoría)
  const serviceCounts = {};
  bookings.forEach(b => {
    const rawName = (typeof b.service === 'string' ? b.service : b.service?.name) || 'Sin nombre';
    const name = normalizeServiceName(rawName);
    serviceCounts[name] = (serviceCounts[name] || 0) + 1;
  });

  // Citas creadas: agrupar por día, semana y mes
  const creationByDay = {};
  const creationByWeek = {};
  const creationByMonth = {};

  bookings.forEach(b => {
    const dateStr = String(b.created_date || '').slice(0, 10);
    if (!dateStr) return;

    // Por día
    creationByDay[dateStr] = (creationByDay[dateStr] || 0) + 1;

    // Por mes (YYYY-MM)
    const monthStr = dateStr.slice(0, 7);
    creationByMonth[monthStr] = (creationByMonth[monthStr] || 0) + 1;

    // Por semana (necesitamos calcular inicio de semana)
    const date = new Date(dateStr);
    const day = date.getDay();
    const diff = date.getDate() - day + (day === 0 ? -6 : 1); // Lunes como inicio
    const weekStart = new Date(date.setDate(diff));
    const weekKey = weekStart.toISOString().slice(0, 10);
    creationByWeek[weekKey] = (creationByWeek[weekKey] || 0) + 1;
  });

  const creationDayDates = Object.keys(creationByDay).sort();
  const creationWeekDates = Object.keys(creationByWeek).sort();
  const creationMonthDates = Object.keys(creationByMonth).sort();

  // Calcular porcentajes para cada estado
  const total = bookings.length;
  const statusPercentages = {
    asiste:      total > 0 ? Math.round(statusCount.asiste / total * 100) : 0,
    confirmado:  total > 0 ? Math.round(statusCount.confirmado / total * 100) : 0,
    reservado:   total > 0 ? Math.round(statusCount.reservado / total * 100) : 0,
    pendiente:   total > 0 ? Math.round(statusCount.pendiente / total * 100) : 0,
    cancelado:   total > 0 ? Math.round(statusCount.cancelado / total * 100) : 0,
    no_asiste:   total > 0 ? Math.round(statusCount.no_asiste / total * 100) : 0,
    otro:        total > 0 ? Math.round(statusCount.otro / total * 100) : 0,
  };

  return {
    total: bookings.length,
    attendanceRate,
    byDay:      { labels: dayLabels,  data: dayCounts  },
    byWeek:     { labels: weekLabels, data: weekCounts },
    byCreation: {
      day: {
        labels: creationDayDates.map(d => { const [,m,day] = d.split('-'); return `${parseInt(day)}/${parseInt(m)}`; }),
        data:   creationDayDates.map(d => creationByDay[d]),
      },
      week: {
        labels: creationWeekDates.map(d => {
          const start = new Date(d);
          const end = new Date(start);
          end.setDate(start.getDate() + 6);
          return `${start.getDate()}/${start.getMonth() + 1} - ${end.getDate()}/${end.getMonth() + 1}`;
        }),
        data: creationWeekDates.map(d => creationByWeek[d]),
      },
      month: {
        labels: creationMonthDates.map(d => {
          const [y, m] = d.split('-');
          return new Date(y, m - 1, 1).toLocaleDateString('es-CL', { month: 'short', year: 'numeric' });
        }),
        data: creationMonthDates.map(d => creationByMonth[d]),
      },
    },
    status:        statusCount,
    statusPercent: statusPercentages,
    clients: {
      new:       newClients,
      recurring: recurringClients,
    },
    services: Object.entries(serviceCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => ({
        name,
        count,
        percent: total > 0 ? Math.round((count / total) * 100 * 10) / 10 : 0  // 1 decimal
      })),
  };
}

// ── Rutas ──────────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/sync-status', (_req, res) => {
  res.json({ running: false, dbTotal: stmtCount.get().c, lastImport: getMeta('last_import') });
});

app.get('/api/available-months', (_req, res) => {
  try {
    // Obtener todos los meses únicos que tienen datos (basado en start_date)
    const months = db.prepare(`
      SELECT DISTINCT substr(start_date, 1, 7) as month
      FROM bookings
      WHERE start_date IS NOT NULL
      ORDER BY month ASC
    `).all();

    const result = months.map(m => {
      const [year, month] = m.month.split('-');
      return {
        year: parseInt(year),
        month: parseInt(month),
        label: new Date(year, month - 1, 1).toLocaleDateString('es-CL', { month: 'short', year: 'numeric' })
      };
    });

    res.json({ months: result });
  } catch (err) {
    console.error('[available-months]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/historical/:statusType', (req, res) => {
  try {
    const { statusType } = req.params;

    // Query optimizada usando status normalizado
    const stmtHistorical = db.prepare(`
      SELECT
        substr(start_date, 1, 7) as month,
        COUNT(*) as total,
        SUM(CASE WHEN status = 'asiste' THEN 1 ELSE 0 END) as asiste,
        SUM(CASE WHEN status = 'confirmado' THEN 1 ELSE 0 END) as confirmado,
        SUM(CASE WHEN status = 'reservado' THEN 1 ELSE 0 END) as reservado,
        SUM(CASE WHEN status = 'pendiente' THEN 1 ELSE 0 END) as pendiente,
        SUM(CASE WHEN status = 'cancelado' THEN 1 ELSE 0 END) as cancelado,
        SUM(CASE WHEN status = 'no_asiste' THEN 1 ELSE 0 END) as no_asiste
      FROM bookings
      WHERE start_date IS NOT NULL
      GROUP BY month
      ORDER BY month ASC
    `);

    const results = stmtHistorical.all();

    if (results.length === 0) {
      return res.json({ labels: [], datasets: [], summary: {}, type: statusType === 'total' ? 'multiple' : 'single' });
    }

    const labels = results.map(r => {
      const [y, m] = r.month.split('-');
      return new Date(y, m - 1, 1).toLocaleDateString('es-CL', { month: 'short', year: 'numeric' });
    });

    // Si es 'total', devolver todas las líneas
    if (statusType === 'total') {
      const datasets = {
        asiste: results.map(r => r.asiste),
        confirmado: results.map(r => r.confirmado),
        reservado: results.map(r => r.reservado),
        pendiente: results.map(r => r.pendiente),
        cancelado: results.map(r => r.cancelado),
        no_asiste: results.map(r => r.no_asiste)
      };

      return res.json({
        labels,
        datasets,
        type: 'multiple'
      });
    }

    // Para un estado específico
    const data = results.map(r => r[statusType] || 0);
    const totals = results.map(r => r.total);

    const summary = {
      total: data.reduce((a, b) => a + b, 0),
      average: Math.round(data.reduce((a, b) => a + b, 0) / data.length),
      max: Math.max(...data),
      min: Math.min(...data),
      months: data.length,
    };

    res.json({
      labels,
      data,
      totals,
      summary,
      statusType,
      type: 'single'
    });
  } catch (err) {
    console.error('[historical]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/clear-db', (_req, res) => {
  try {
    const beforeCount = stmtCount.get().c;
    db.exec('DELETE FROM bookings');
    db.exec('DELETE FROM meta');
    const afterCount = stmtCount.get().c;
    console.log(`[clear-db] Base de datos limpiada. Registros eliminados: ${beforeCount}`);
    res.json({ ok: true, deletedRecords: beforeCount, dbTotal: afterCount });
  } catch (err) {
    console.error('[clear-db]', err.message);
    res.status(500).json({ error: err.message });
  }
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

    const totalExcel = rows.length;
    const mapped = rows.map(mapRow);

    // Deduplicación en memoria: Fecha + Identificación + Servicio + Prestador
    const seenKeys = new Map();
    const dedupedRows = [];
    let dupesInExcel = 0;
    for (const r of mapped) {
      const key = makeId(r.start, r.identificacion, r.service, r.prestador, r.created_date, r.created_by);
      if (seenKeys.has(key)) {
        dupesInExcel++;
      } else {
        seenKeys.set(key, true);
        dedupedRows.push(r);
      }
    }

    console.log(`[import] ${req.file.originalname}:`);
    console.log(`  → Excel original:             ${totalExcel} registros`);
    console.log(`  → Duplicados en Excel:        ${dupesInExcel} (eliminados)`);
    console.log(`  → Únicos a procesar:          ${dedupedRows.length} registros`);

    const { newRecords, updated, unchanged } = saveMany(dedupedRows);

    setMeta('last_import', new Date().toISOString());
    const dbTotal = stmtCount.get().c;
    console.log(`  → 🆕 Nuevos en DB:            ${newRecords}`);
    console.log(`  → 🔄 Actualizados (cambios):  ${updated}`);
    console.log(`  → ⏭️  Sin cambios (idénticos): ${unchanged}`);
    console.log(`  → 📊 Total en DB:             ${dbTotal}`);

    res.json({
      ok: true,
      rows: totalExcel,
      dupesInExcel,
      dedupedRows: dedupedRows.length,
      newRecords,
      updated,
      unchanged,
      dbTotal
    });
  } catch (err) {
    console.error('[import]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Migración: Normalizar status existentes ───────────────────────────────
console.log('[DB] Verificando si hay status sin normalizar...');
const unnormalized = db.prepare(`
  SELECT COUNT(*) as c FROM bookings
  WHERE status NOT IN ('asiste', 'confirmado', 'reservado', 'pendiente', 'cancelado', 'no_asiste', 'otro')
  OR status IS NULL
`).get();

if (unnormalized.c > 0) {
  console.log(`[DB] Normalizando ${unnormalized.c} registros con status sin normalizar...`);

  const allBookings = db.prepare('SELECT id, data FROM bookings').all();
  const stmtUpdateStatus = db.prepare('UPDATE bookings SET status = ? WHERE id = ?');

  const migration = db.transaction(() => {
    let updated = 0;
    allBookings.forEach(b => {
      try {
        const parsed = JSON.parse(b.data);
        const normalized = bookingStatus({ status: parsed.status });
        stmtUpdateStatus.run(normalized, b.id);
        updated++;
      } catch (err) {
        // Skip si hay error parseando JSON
      }
    });
    return updated;
  });

  const migrated = migration();
  console.log(`[DB] ✅ ${migrated} registros normalizados`);
} else {
  console.log('[DB] ✅ Todos los status ya están normalizados');
}

// ── Inicio ─────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Servidor en http://localhost:${PORT}`);
  console.log(`DB: ${stmtCount.get().c} bookings`);

  // Debug: distribución real de valores en la columna "status"
  const dist = db.prepare('SELECT status, COUNT(*) AS c FROM bookings GROUP BY status ORDER BY c DESC').all();
  console.log('[DB] Distribución de estados (valores normalizados):');
  dist.forEach(r => console.log(`  "${r.status ?? 'NULL'}": ${r.c}`));
});
