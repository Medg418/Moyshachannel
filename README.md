# HostPilot — Backend API
> Channel Manager pour Airbnb, Booking.com & paiements Sénégal

---

## Architecture

```
hostpilot/
├── src/
│   ├── server.js              # Entrée principale + cron sync iCal
│   ├── routes/
│   │   ├── auth.js            # Inscription / connexion (Supabase)
│   │   ├── properties.js      # CRUD propriétés
│   │   ├── reservations.js    # CRUD réservations + détection conflits
│   │   ├── calendar.js        # Vue calendrier multi-propriétés + blocage dates
│   │   ├── pricing.js         # Règles tarifaires + calcul dynamique
│   │   ├── sync.js            # Sync iCal Airbnb / Booking + export iCal
│   │   ├── payments.js        # Stripe, PayPal, Orange Money, Wave
│   │   └── ai.js              # Assistant Claude AI
│   ├── services/
│   │   └── ical.service.js    # Moteur de sync iCal (import + export)
│   ├── middleware/
│   │   └── auth.js            # Vérification JWT Supabase
│   └── utils/
│       ├── supabase.js        # Client Supabase (service role)
│       └── logger.js          # Winston logger
├── supabase/
│   └── migrations/
│       └── 001_schema.sql     # Schéma complet BDD
├── .env.example               # Variables d'environnement
└── package.json
```

---

## Installation

### 1. Cloner et installer
```bash
git clone https://github.com/votre-repo/hostpilot-backend
cd hostpilot-backend
npm install
cp .env.example .env
```

### 2. Créer le projet Supabase
1. Aller sur [supabase.com](https://supabase.com) → New Project
2. Copier l'URL et les clés dans `.env`
3. Exécuter le SQL dans **Supabase → SQL Editor** :
   ```
   supabase/migrations/001_schema.sql
   ```

### 3. Configurer les paiements

#### Stripe (carte bancaire)
```bash
# Créer un compte sur stripe.com
# Copier STRIPE_SECRET_KEY et STRIPE_PUBLISHABLE_KEY
# Configurer le webhook : stripe listen --forward-to localhost:3000/api/payments/stripe/webhook
```

#### PayPal
```bash
# Créer une app sur developer.paypal.com
# Mode sandbox pour les tests
```

#### Orange Money (Sénégal)
```bash
# Demander l'accès API sur developer.orange.com
# Obtenir MERCHANT_KEY depuis le portail Orange Business
```

#### Wave (Sénégal)
```bash
# Contacter Wave Business pour les clés API
# Disponible au Sénégal, Mali, Côte d'Ivoire, Burkina Faso
```

### 4. Lancer le serveur
```bash
npm run dev      # Développement (nodemon)
npm start        # Production
```

---

## API Reference

### Authentification
```
POST   /api/auth/register     { email, password, full_name }
POST   /api/auth/login        { email, password }
POST   /api/auth/refresh      { refresh_token }
GET    /api/auth/me
```

### Propriétés
```
GET    /api/properties
POST   /api/properties        { name, base_price, ... }
PATCH  /api/properties/:id
DELETE /api/properties/:id
```

### Réservations
```
GET    /api/reservations      ?property_id=&channel=&status=&from=&to=
POST   /api/reservations      { property_id, guest_name, check_in, check_out, ... }
PATCH  /api/reservations/:id
DELETE /api/reservations/:id  (→ status: cancelled)
```

### Calendrier
```
GET    /api/calendar          ?from=YYYY-MM-DD&to=YYYY-MM-DD
POST   /api/calendar/block    { property_id, date_from, date_to, reason }
DELETE /api/calendar/block/:id
```

### Tarification
```
GET    /api/pricing/calculate ?property_id=&check_in=&check_out=
GET    /api/pricing/rules/:propertyId
POST   /api/pricing/rules
PATCH  /api/pricing/rules/:id
DELETE /api/pricing/rules/:id
```

### Synchronisation iCal
```
GET    /api/sync/ical/:propertyId/:token   (public — export iCal)
GET    /api/sync/channels
POST   /api/sync/channels     { property_id, platform, ical_url_import }
POST   /api/sync/now          { property_id? }
GET    /api/sync/logs
```

### Paiements
```
GET    /api/payments

# Stripe
POST   /api/payments/stripe/create-intent   { reservation_id }
POST   /api/payments/stripe/webhook         (Stripe → serveur)

# PayPal
POST   /api/payments/paypal/create-order    { reservation_id }
POST   /api/payments/paypal/capture/:orderId

# Orange Money
POST   /api/payments/orange-money/initiate  { reservation_id, phone_number }
POST   /api/payments/orange-money/notify    (Orange → serveur)

# Wave
POST   /api/payments/wave/create-session    { reservation_id }
```

### Assistant IA
```
POST   /api/ai/chat           { message, history[] }
POST   /api/ai/draft-message  { reservation_id, type: 'welcome'|'checkin_reminder'|'checkout'|'review_request' }
```

---

## Flux iCal (Synchronisation)

```
Airbnb               HostPilot Backend            Booking.com
   |                       |                           |
   |-- iCal URL ---------> |                           |
   |                       |-- iCal URL ------------>  |
   |                       |                           |
   |            [Cron: toutes les 5 min]               |
   |                       |                           |
   |                 Parse events                      |
   |                 Détecte conflits                  |
   |                 Insère en BDD                     |
   |                       |                           |
   |  <-- Export iCal URL  |  Export iCal URL -->      |
   | (coller dans Airbnb)  |   (coller dans Booking)   |
```

### Comment configurer la sync :
1. **Airbnb** → Calendrier → Exporter → Copier l'URL iCal
2. Coller dans : `POST /api/sync/channels { platform: "airbnb", ical_url_import: "<url>" }`
3. Récupérer votre URL d'export : `GET /api/sync/channels` → `ical_export_url`
4. Coller cette URL dans **Airbnb** → Synchroniser d'autres calendriers

---

## Déploiement

### Option A — Render.com (recommandé pour débuter)
```bash
# 1. Pousser sur GitHub
# 2. Créer un Web Service sur render.com
# 3. Connecter le repo GitHub
# 4. Ajouter les variables d'environnement
# 5. Deploy !
```

### Option B — VPS Linux (Ubuntu)
```bash
# Installer Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -
sudo apt install nodejs nginx

# PM2 pour la gestion des processus
npm install -g pm2
pm2 start src/server.js --name hostpilot
pm2 startup && pm2 save

# Nginx reverse proxy
# /etc/nginx/sites-available/hostpilot
server {
    listen 80;
    server_name api.votre-domaine.com;
    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

### Option C — Docker
```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY src ./src
EXPOSE 3000
CMD ["node", "src/server.js"]
```

---

## Sécurité checklist
- [x] JWT Supabase sur toutes les routes protégées
- [x] Row Level Security (RLS) Supabase
- [x] Rate limiting (200 req/15min)
- [x] Helmet.js (headers sécurité)
- [x] Validation Joi des inputs
- [x] Vérification propriété ↔ owner sur chaque route
- [x] Détection des conflits de dates
- [x] Webhook Stripe vérifié par signature
- [ ] À ajouter : HTTPS + certificat SSL (Let's Encrypt)
- [ ] À ajouter : Logs d'audit
