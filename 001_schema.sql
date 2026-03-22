-- ================================================
-- HOSTPILOT — Schéma base de données Supabase
-- Exécuter dans l'éditeur SQL Supabase
-- ================================================

-- Extension UUID
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ------------------------------------------------
-- TABLE: properties (propriétés)
-- ------------------------------------------------
CREATE TABLE properties (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  owner_id      UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  description   TEXT,
  address       TEXT,
  city          TEXT DEFAULT 'Dakar',
  country       TEXT DEFAULT 'SN',
  color         TEXT DEFAULT '#1D6FE8',
  base_price    NUMERIC(12,2) NOT NULL DEFAULT 50000,
  weekend_price NUMERIC(12,2),
  cleaning_fee  NUMERIC(12,2) DEFAULT 0,
  deposit       NUMERIC(12,2) DEFAULT 0,
  min_nights    INTEGER DEFAULT 1,
  max_guests    INTEGER DEFAULT 2,
  currency      TEXT DEFAULT 'XOF',
  is_active     BOOLEAN DEFAULT true,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ------------------------------------------------
-- TABLE: channels (canaux OTA par propriété)
-- ------------------------------------------------
CREATE TABLE channels (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  property_id   UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  platform      TEXT NOT NULL CHECK (platform IN ('airbnb','booking','vrbo','direct','other')),
  ical_url_import TEXT,
  ical_token    TEXT DEFAULT uuid_generate_v4()::TEXT,
  is_active     BOOLEAN DEFAULT true,
  last_sync_at  TIMESTAMPTZ,
  sync_status   TEXT DEFAULT 'pending' CHECK (sync_status IN ('ok','error','pending')),
  sync_error    TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_channels_property_platform ON channels(property_id, platform);

-- ------------------------------------------------
-- TABLE: reservations
-- ------------------------------------------------
CREATE TABLE reservations (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  property_id     UUID NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  channel         TEXT NOT NULL CHECK (channel IN ('airbnb','booking','vrbo','direct','other')),
  external_id     TEXT,
  guest_name      TEXT NOT NULL,
  guest_email     TEXT,
  guest_phone     TEXT,
  check_in        DATE NOT NULL,
  check_out       DATE NOT NULL,
  nights          INTEGER GENERATED ALWAYS AS (check_out - check_in) STORED,
  guests_count    INTEGER DEFAULT 1,
  base_amount     NUMERIC(12,2) NOT NULL,
  cleaning_fee    NUMERIC(12,2) DEFAULT 0,
  ota_commission  NUMERIC(12,2) DEFAULT 0,
  total_amount    NUMERIC(12,2) NOT NULL,
  currency        TEXT DEFAULT 'XOF',
  status          TEXT DEFAULT 'pending' CHECK (status IN ('pending','confirmed','cancelled','completed','no_show')),
  payment_status  TEXT DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid','partial','paid','refunded')),
  notes           TEXT,
  source_uid      TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT no_overlap UNIQUE (property_id, check_in, external_id)
);

CREATE INDEX idx_reservations_property ON reservations(property_id);
CREATE INDEX idx_reservations_dates ON reservations(check_in, check_out);
CREATE INDEX idx_reservations_status ON reservations(status);

-- ------------------------------------------------
-- TABLE: pricing_rules (règles tarifaires)
-- ------------------------------------------------
CREATE TABLE pricing_rules (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  property_id   UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  rule_type     TEXT NOT NULL CHECK (rule_type IN ('season','last_minute','long_stay','weekend','custom')),
  date_from     DATE,
  date_to       DATE,
  days_before   INTEGER,
  min_nights    INTEGER,
  modifier_type TEXT DEFAULT 'percent' CHECK (modifier_type IN ('percent','fixed')),
  modifier_value NUMERIC(8,2) NOT NULL,
  is_active     BOOLEAN DEFAULT true,
  priority      INTEGER DEFAULT 0,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ------------------------------------------------
-- TABLE: blocked_dates
-- ------------------------------------------------
CREATE TABLE blocked_dates (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  property_id UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  date_from   DATE NOT NULL,
  date_to     DATE NOT NULL,
  reason      TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ------------------------------------------------
-- TABLE: payments
-- ------------------------------------------------
CREATE TABLE payments (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  reservation_id  UUID NOT NULL REFERENCES reservations(id) ON DELETE RESTRICT,
  method          TEXT NOT NULL CHECK (method IN ('card','paypal','orange_money','wave','free_money','cash','bank_transfer')),
  provider_ref    TEXT,
  amount          NUMERIC(12,2) NOT NULL,
  currency        TEXT DEFAULT 'XOF',
  status          TEXT DEFAULT 'pending' CHECK (status IN ('pending','completed','failed','refunded')),
  paid_at         TIMESTAMPTZ,
  metadata        JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_payments_reservation ON payments(reservation_id);
CREATE INDEX idx_payments_status ON payments(status);

-- ------------------------------------------------
-- TABLE: sync_logs
-- ------------------------------------------------
CREATE TABLE sync_logs (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  channel_id    UUID REFERENCES channels(id) ON DELETE SET NULL,
  property_id   UUID REFERENCES properties(id) ON DELETE SET NULL,
  platform      TEXT,
  status        TEXT CHECK (status IN ('success','error','partial')),
  events_found  INTEGER DEFAULT 0,
  events_added  INTEGER DEFAULT 0,
  events_removed INTEGER DEFAULT 0,
  error_message TEXT,
  duration_ms   INTEGER,
  synced_at     TIMESTAMPTZ DEFAULT NOW()
);

-- ------------------------------------------------
-- TRIGGERS: updated_at automatique
-- ------------------------------------------------
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_properties_updated BEFORE UPDATE ON properties
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_reservations_updated BEFORE UPDATE ON reservations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ------------------------------------------------
-- RLS: Row Level Security (chaque host voit ses données)
-- ------------------------------------------------
ALTER TABLE properties    ENABLE ROW LEVEL SECURITY;
ALTER TABLE channels      ENABLE ROW LEVEL SECURITY;
ALTER TABLE reservations  ENABLE ROW LEVEL SECURITY;
ALTER TABLE pricing_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE blocked_dates ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments      ENABLE ROW LEVEL SECURITY;

-- Policies: owner_id = auth.uid()
CREATE POLICY "owner_properties" ON properties
  USING (owner_id = auth.uid());

CREATE POLICY "owner_channels" ON channels
  USING (property_id IN (SELECT id FROM properties WHERE owner_id = auth.uid()));

CREATE POLICY "owner_reservations" ON reservations
  USING (property_id IN (SELECT id FROM properties WHERE owner_id = auth.uid()));

CREATE POLICY "owner_pricing" ON pricing_rules
  USING (property_id IN (SELECT id FROM properties WHERE owner_id = auth.uid()));

CREATE POLICY "owner_blocked" ON blocked_dates
  USING (property_id IN (SELECT id FROM properties WHERE owner_id = auth.uid()));

CREATE POLICY "owner_payments" ON payments
  USING (reservation_id IN (
    SELECT r.id FROM reservations r
    JOIN properties p ON p.id = r.property_id
    WHERE p.owner_id = auth.uid()
  ));

-- ------------------------------------------------
-- DONNÉES DE TEST (optionnel — commenter en prod)
-- ------------------------------------------------
-- INSERT INTO properties (owner_id, name, city, base_price, weekend_price, color)
-- VALUES (auth.uid(), 'Apt. Plateau', 'Dakar', 70000, 90000, '#CC2F56');
