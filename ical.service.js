// services/ical.service.js — Synchronisation iCal Airbnb & Booking.com
const axios = require('axios');
const ical = require('ical');
const { v4: uuid } = require('uuid');
const supabase = require('../utils/supabase');
const logger = require('../utils/logger');

// ------------------------------------------------
// Lire un iCal distant et extraire les événements
// ------------------------------------------------
async function fetchIcal(url) {
  const response = await axios.get(url, {
    timeout: 15000,
    headers: { 'User-Agent': 'HostPilot-Channel-Manager/1.0' }
  });
  return ical.parseICS(response.data);
}

// ------------------------------------------------
// Parser un événement iCal → objet réservation
// ------------------------------------------------
function parseIcalEvent(event, channel, propertyId) {
  if (event.type !== 'VEVENT') return null;

  const start = event.start ? new Date(event.start) : null;
  const end   = event.end   ? new Date(event.end)   : null;
  if (!start || !end) return null;

  // Normaliser les dates (format YYYY-MM-DD)
  const checkIn  = start.toISOString().split('T')[0];
  const checkOut = end.toISOString().split('T')[0];

  // Extraire le nom du voyageur depuis summary ou description
  let guestName = event.summary || 'Voyageur';

  // Airbnb: "Reserved" ou le nom du voyageur
  // Booking: "CLOSED - Not available" ou le nom
  if (guestName.toLowerCase().includes('reserved') ||
      guestName.toLowerCase().includes('not available') ||
      guestName.toLowerCase().includes('closed') ||
      guestName.toLowerCase().includes('blocked')) {
    guestName = guestName;
  }

  return {
    property_id:    propertyId,
    channel:        channel,
    external_id:    event.uid || uuid(),
    guest_name:     guestName,
    check_in:       checkIn,
    check_out:      checkOut,
    base_amount:    0,     // iCal ne contient pas le montant
    total_amount:   0,
    status:         'confirmed',
    source_uid:     event.uid
  };
}

// ------------------------------------------------
// Synchroniser un channel spécifique
// ------------------------------------------------
async function syncChannel(channel) {
  const startTime = Date.now();
  const log = {
    channel_id:     channel.id,
    property_id:    channel.property_id,
    platform:       channel.platform,
    events_found:   0,
    events_added:   0,
    events_removed: 0,
    status:         'success'
  };

  try {
    logger.debug(`Sync ${channel.platform} — propriété ${channel.property_id}`);

    const icalData = await fetchIcal(channel.ical_url_import);
    const events = Object.values(icalData).filter(e => e.type === 'VEVENT');
    log.events_found = events.length;

    // Récupérer les réservations existantes pour ce channel
    const { data: existing } = await supabase
      .from('reservations')
      .select('id, source_uid, check_in, check_out')
      .eq('property_id', channel.property_id)
      .eq('channel', channel.platform);

    const existingUids = new Set(existing?.map(r => r.source_uid) || []);

    // Ajouter les nouvelles réservations
    for (const event of events) {
      const reservation = parseIcalEvent(event, channel.platform, channel.property_id);
      if (!reservation) continue;

      if (!existingUids.has(reservation.source_uid)) {
        // Vérifier conflit avant insertion
        const { data: conflict } = await supabase
          .from('reservations')
          .select('id')
          .eq('property_id', channel.property_id)
          .neq('status', 'cancelled')
          .lt('check_in', reservation.check_out)
          .gt('check_out', reservation.check_in)
          .limit(1);

        if (conflict && conflict.length > 0) {
          logger.warn(`Conflit ignoré: ${reservation.guest_name} ${reservation.check_in}–${reservation.check_out}`);
          continue;
        }

        const { error } = await supabase.from('reservations').insert(reservation);
        if (!error) log.events_added++;
      }
    }

    // Marquer comme annulées les réservations supprimées du iCal
    const incomingUids = new Set(
      events.map(e => e.uid).filter(Boolean)
    );

    for (const res of (existing || [])) {
      if (res.source_uid && !incomingUids.has(res.source_uid)) {
        await supabase
          .from('reservations')
          .update({ status: 'cancelled' })
          .eq('id', res.id);
        log.events_removed++;
      }
    }

    // Mettre à jour le statut du channel
    await supabase
      .from('channels')
      .update({ last_sync_at: new Date().toISOString(), sync_status: 'ok', sync_error: null })
      .eq('id', channel.id);

  } catch (err) {
    log.status = 'error';
    log.error_message = err.message;
    logger.error(`Erreur sync ${channel.platform}`, { error: err.message });

    await supabase
      .from('channels')
      .update({ sync_status: 'error', sync_error: err.message })
      .eq('id', channel.id);
  }

  log.duration_ms = Date.now() - startTime;
  await supabase.from('sync_logs').insert(log);
  return log;
}

// ------------------------------------------------
// Synchroniser tous les channels actifs
// ------------------------------------------------
async function syncAllChannels() {
  const { data: channels, error } = await supabase
    .from('channels')
    .select('*')
    .eq('is_active', true)
    .not('ical_url_import', 'is', null);

  if (error) throw error;
  if (!channels || channels.length === 0) return { synced: 0 };

  const results = await Promise.allSettled(
    channels.map(ch => syncChannel(ch))
  );

  return {
    synced: channels.length,
    results: results.map((r, i) => ({
      channel: channels[i].platform,
      property: channels[i].property_id,
      ...(r.status === 'fulfilled' ? r.value : { status: 'error', error: r.reason?.message })
    }))
  };
}

// ------------------------------------------------
// Générer le iCal de sortie (pour export vers OTA)
// ------------------------------------------------
async function generateIcal(propertyId, token) {
  // Vérifier le token
  const { data: channel } = await supabase
    .from('channels')
    .select('*, properties(name)')
    .eq('property_id', propertyId)
    .eq('ical_token', token)
    .single();

  if (!channel) throw { status: 403, message: 'Token iCal invalide' };

  const { data: reservations } = await supabase
    .from('reservations')
    .select('*')
    .eq('property_id', propertyId)
    .not('status', 'eq', 'cancelled')
    .order('check_in');

  const IcalGen = require('ical-generator');
  const cal = IcalGen.default({
    name: `HostPilot - ${channel.properties?.name || 'Propriété'}`,
    prodId: '//HostPilot//Channel Manager//FR',
    timezone: 'Africa/Dakar'
  });

  for (const res of (reservations || [])) {
    cal.createEvent({
      id: res.source_uid || res.id,
      summary: res.guest_name,
      start: new Date(res.check_in),
      end:   new Date(res.check_out),
      description: `Réservation ${res.channel} — ${res.guests_count || 1} voyageur(s)`
    });
  }

  return cal.toString();
}

module.exports = { syncAllChannels, syncChannel, generateIcal };
