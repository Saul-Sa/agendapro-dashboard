# 📊 AgendaPro Dashboard

Dashboard de análisis y visualización de datos para AgendaPro. Sistema completo con importación de Excel, análisis temporal, drill-down interactivo y métricas avanzadas.

![Dashboard Preview](https://img.shields.io/badge/Status-Production%20Ready-green)
![Node.js](https://img.shields.io/badge/Node.js-20+-brightgreen)
![License](https://img.shields.io/badge/License-MIT-blue)

## ✨ Características

### 📈 **Dashboard Principal**
- **KPIs en tiempo real:** Total de citas, estados (Asiste, Confirmado, Cancelado, etc.)
- **Gráficas interactivas:** Visualización por día, semana y mes
- **Selector dinámico de meses:** Automáticamente detecta meses con datos
- **Análisis de clientes:** Nuevos vs Recurrentes (basado en historial completo)
- **Ranking de servicios:** Top servicios con porcentajes

### 🔍 **Sistema de Drill-Down**
- **Click simple:** Modal rápido con gráfica temporal
- **Vista completa:** Análisis detallado con KPIs, gráfica grande y tabla de datos
- **Total Citas:** Visualización de múltiples líneas simultáneas
- **Navegación fluida:** ESC para cerrar, botón volver

### 📊 **Importación de Datos**
- **Carga Excel/CSV:** Importa archivos con datos de AgendaPro
- **Deduplicación inteligente:** Evita registros duplicados (6 campos clave)
- **Normalización automática:** Fechas, estados y servicios
- **Reporte detallado:** Nuevos, actualizados, sin cambios, duplicados

### ⚡ **Optimizaciones de Rendimiento**
- **Cache inteligente:** Visitas repetidas a meses <10ms
- **Índices SQL:** Queries optimizadas con índices compuestos
- **Status normalizado:** Estados guardados de forma eficiente
- **1 query SQL:** Agregación directa en lugar de procesamiento en JavaScript

---

## 🚀 Instalación

### **Requisitos:**
- Node.js 18+ 
- npm o yarn

### **1. Clonar repositorio:**
```bash
git clone https://github.com/Saul-Sa/agendapro-dashboard.git
cd agendapro-dashboard
```

### **2. Instalar dependencias:**
```bash
npm install
```

### **3. Configurar variables de entorno:**
```bash
cp .env.example .env
# Edita .env si es necesario (opcional)
```

### **4. Iniciar servidor:**
```bash
npm start
```

### **5. Abrir en navegador:**
```
http://localhost:8080
```

---

## 📦 Deploy en Railway

### **Opción 1: Deploy desde GitHub**

1. **Push a GitHub:**
   ```bash
   git add .
   git commit -m "Deploy to Railway"
   git push origin main
   ```

2. **En Railway:**
   - Ir a [railway.app](https://railway.app)
   - "New Project" → "Deploy from GitHub repo"
   - Seleccionar `agendapro-dashboard`
   - Railway detectará automáticamente el `package.json`

3. **Variables de entorno (opcional):**
   - `PORT` → Railway lo configura automáticamente
   - Agregar otras si las necesitas

4. **Deploy automático:**
   - Railway despliega automáticamente
   - Obtén tu URL pública

### **Opción 2: Railway CLI**

```bash
# Instalar Railway CLI
npm install -g @railway/cli

# Login
railway login

# Crear proyecto
railway init

# Deploy
railway up
```

---

## 📚 Uso

### **Importar Datos:**
1. Click en **"Importar CSV/Excel"**
2. Selecciona archivo con datos de AgendaPro
3. Espera el reporte de importación
4. Dashboard se actualiza automáticamente

### **Navegar entre meses:**
- Click en las pills de meses en la barra superior
- Primera visita: ~500ms
- Visitas repetidas: <10ms (cache automático)

### **Análisis Temporal (Drill-Down):**
- **Click en KPI** → Modal rápido con gráfica
- **Click en gráfico donut** → Modal del estado clickeado
- **Botón "Ver análisis completo"** → Vista detallada con métricas
- **ESC o X** → Cerrar modal
- **← Volver** → Regresar al dashboard

### **Limpiar Base de Datos:**
- Click en **"Limpiar DB"** (botón rojo)
- Confirmar acción
- Volver a importar archivos Excel

---

## 🗂️ Estructura del Proyecto

```
agendapro-dashboard/
├── server.js              # Backend Express + SQLite
├── public/
│   └── index.html        # Frontend (HTML + CSS + JavaScript)
├── bookings.db           # Base de datos SQLite (auto-generada)
├── package.json          # Dependencias
├── .gitignore           # Archivos ignorados
├── .env.example         # Template de variables de entorno
└── README.md            # Este archivo
```

---

## 🔑 Campos de Deduplicación

Los duplicados se detectan usando **6 campos clave**:

1. **Fecha de realización**
2. **N.º de identificación** (RUT/Cédula)
3. **Servicio**
4. **Prestador** (profesional)
5. **Fecha de creación**
6. **Responsable creación**

---

## 🛠️ Tecnologías

- **Backend:** Node.js, Express.js
- **Base de datos:** SQLite (better-sqlite3)
- **Frontend:** HTML5, CSS3, JavaScript (vanilla)
- **Gráficas:** Chart.js
- **Excel parsing:** xlsx
- **File upload:** multer

---

## 📊 Rendimiento

| Métrica | Valor |
|---------|-------|
| Carga inicial de mes (sin cache) | ~500ms |
| Carga de mes (con cache) | <10ms ⚡ |
| Click en KPI (drill-down) | ~30ms |
| Cambio entre meses visitados | <10ms |
| Total de registros soportados | 17,000+ ✅ |

---

## 🎯 Próximas Características

- [ ] Exportar reportes a PDF
- [ ] Filtros avanzados por local/prestador
- [ ] Comparación entre períodos
- [ ] Predicción de tendencias con ML
- [ ] Notificaciones automáticas
- [ ] API REST para integraciones

---

## 🐛 Troubleshooting

### **El servidor no inicia:**
```bash
# Verificar que el puerto 8080 esté libre
# O cambiar puerto en .env
PORT=3000 npm start
```

### **Error al importar Excel:**
- Verifica que el archivo tenga las columnas correctas
- Formatos aceptados: `.xlsx`, `.xls`, `.csv`

### **Gráficas no se muestran:**
- Abre la consola del navegador (F12)
- Verifica que no haya errores de JavaScript
- Limpia cache del navegador (Ctrl + Shift + R)

---

## 📄 Licencia

MIT License - Ver archivo LICENSE para más detalles

---

## 👤 Autor

**Saul-Sa**
- GitHub: [@Saul-Sa](https://github.com/Saul-Sa)

---

## 🙏 Agradecimientos

Desarrollado con [Claude Code](https://claude.ai/code) - Anthropic's AI coding assistant

---

## 📞 Soporte

¿Problemas o preguntas? Abre un [Issue](https://github.com/Saul-Sa/agendapro-dashboard/issues)

---

**⭐ Si este proyecto te fue útil, dale una estrella en GitHub!**
