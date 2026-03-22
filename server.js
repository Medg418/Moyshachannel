// ================================================
// HOSTPILOT — Serveur principal
// ================================================
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cron = require('node-cron');
const logger = require('./utils/logger');

const app = express();

// ------------------------------------------------
// MIDDLEWARE GLOBAL
// ------------------------------------------------
app.use(helmet());
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  credentials: true
}));

// Raw body pour Stripe webhooks (avant json parser)
app.use('/api/payments/stripe/webhook',
  express.raw({ type: 'application/json' })
);
app.use(express.json({ limit: '1mb' }));

// Rate limiting
app.use('/api/', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  message: { error: 'Trop de requêtes, réessayez dans 15 minutes.' }
}));

// Logger des requêtes
app.use((req, res, next) => {
  logger.info(`${req.method} ${req.path}`, { ip: req.ip });
  next();
});

// ------------------------------------------------
// ROUTES
// ------------------------------------------------
app.use('/api/auth',         require('./routes/auth'));
app.use('/api/properties',   require('./routes/properties'));
app.use('/api/reservations', require('./routes/reservations'));
app.use('/api/calendar',     require('./routes/calendar'));
app.use('/api/pricing',      require('./routes/pricing'));
app.use('/api/payments',     require('./routes/payments'));
app.use('/api/sync',         require('./routes/sync'));
app.use('/api/ai',           require('./routes/ai'));

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', version: '1.0.0', env: process.env.NODE_ENV });
});

// ------------------------------------------------
// CRON: Synchronisation iCal automatique
// ------------------------------------------------
const { syncAllChannels } = require('./services/ical.service');
const interval = process.env.ICAL_SYNC_INTERVAL_MINUTES || 5;

cron.schedule(`*/${interval} * * * *`, async () => {
  logger.info('🔄 Sync iCal automatique démarrée');
  try {
    const result = await syncAllChannels();
    logger.info('✅ Sync terminée', result);
  } catch (err) {
    logger.error('❌ Erreur sync iCal', { error: err.message });
  }
});

// ------------------------------------------------
// GESTION D'ERREURS
// ------------------------------------------------
app.use((err, req, res, next) => {
  logger.error('Erreur non gérée', { error: err.message, stack: err.stack });
  res.status(err.status || 500).json({
    error: err.message || 'Erreur serveur interne',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
});

app.use((req, res) => {
  res.status(404).json({ error: 'Route non trouvée' });
});

// ------------------------------------------------
// DÉMARRAGE
// ------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  logger.info(`🚀 HostPilot API démarrée sur le port ${PORT}`);
  logger.info(`   Sync iCal toutes les ${interval} minutes`);
});

module.exports = app;
