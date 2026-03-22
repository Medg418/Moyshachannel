// routes/payments.js — Stripe, PayPal, Orange Money, Wave
const router = require('express').Router();
const { requireAuth } = require('../middleware/auth');
const supabase = require('../utils/supabase');
const logger = require('../utils/logger');

// ================================================
// STRIPE — Carte bancaire
// ================================================
const getStripe = () => require('stripe')(process.env.STRIPE_SECRET_KEY);

// POST /api/payments/stripe/create-intent
router.post('/stripe/create-intent', requireAuth, async (req, res, next) => {
  try {
    const { reservation_id } = req.body;
    const { data: res_ } = await supabase
      .from('reservations')
      .select('*, properties(owner_id, name)')
      .eq('id', reservation_id)
      .single();

    if (!res_ || res_.properties.owner_id !== req.userId)
      return res.status(403).json({ error: 'Réservation non autorisée' });

    const stripe = getStripe();
    const intent = await stripe.paymentIntents.create({
      amount: Math.round(res_.total_amount),  // XOF = devise sans décimales
      currency: res_.currency.toLowerCase(),
      metadata: {
        reservation_id,
        property: res_.properties.name,
        guest: res_.guest_name
      },
      description: `HostPilot — ${res_.properties.name} — ${res_.guest_name}`
    });

    // Enregistrer le paiement en pending
    await supabase.from('payments').insert({
      reservation_id,
      method: 'card',
      provider_ref: intent.id,
      amount: res_.total_amount,
      currency: res_.currency,
      status: 'pending',
      metadata: { stripe_intent_id: intent.id }
    });

    res.json({ client_secret: intent.client_secret, intent_id: intent.id });
  } catch (err) { next(err); }
});

// POST /api/payments/stripe/webhook — Stripe events
router.post('/stripe/webhook', async (req, res) => {
  const stripe = getStripe();
  const sig = req.headers['stripe-signature'];

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    logger.warn('Webhook Stripe invalide', { error: err.message });
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'payment_intent.succeeded') {
    const intent = event.data.object;
    await supabase.from('payments')
      .update({ status: 'completed', paid_at: new Date().toISOString() })
      .eq('metadata->>stripe_intent_id', intent.id);

    if (intent.metadata?.reservation_id) {
      await supabase.from('reservations')
        .update({ payment_status: 'paid', status: 'confirmed' })
        .eq('id', intent.metadata.reservation_id);
    }
    logger.info('✅ Paiement Stripe confirmé', { id: intent.id });
  }

  if (event.type === 'payment_intent.payment_failed') {
    const intent = event.data.object;
    await supabase.from('payments')
      .update({ status: 'failed' })
      .eq('metadata->>stripe_intent_id', intent.id);
  }

  res.json({ received: true });
});

// ================================================
// PAYPAL
// ================================================
const { default: axios } = require('axios');

async function getPaypalToken() {
  const baseURL = process.env.PAYPAL_MODE === 'live'
    ? 'https://api-m.paypal.com'
    : 'https://api-m.sandbox.paypal.com';

  const resp = await axios.post(`${baseURL}/v1/oauth2/token`,
    'grant_type=client_credentials',
    {
      auth: {
        username: process.env.PAYPAL_CLIENT_ID,
        password: process.env.PAYPAL_CLIENT_SECRET
      },
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    }
  );
  return { token: resp.data.access_token, baseURL };
}

// POST /api/payments/paypal/create-order
router.post('/paypal/create-order', requireAuth, async (req, res, next) => {
  try {
    const { reservation_id } = req.body;
    const { data: res_ } = await supabase
      .from('reservations')
      .select('*, properties(owner_id, name)')
      .eq('id', reservation_id)
      .single();

    if (!res_ || res_.properties.owner_id !== req.userId)
      return res.status(403).json({ error: 'Réservation non autorisée' });

    const { token, baseURL } = await getPaypalToken();
    const { data: order } = await axios.post(
      `${baseURL}/v2/checkout/orders`,
      {
        intent: 'CAPTURE',
        purchase_units: [{
          amount: {
            currency_code: 'EUR',  // PayPal ne supporte pas XOF, conversion nécessaire
            value: (res_.total_amount / 655.957).toFixed(2)
          },
          description: `HostPilot — ${res_.properties.name} — ${res_.guest_name}`
        }]
      },
      { headers: { Authorization: `Bearer ${token}` } }
    );

    await supabase.from('payments').insert({
      reservation_id,
      method: 'paypal',
      provider_ref: order.id,
      amount: res_.total_amount,
      currency: res_.currency,
      status: 'pending',
      metadata: { paypal_order_id: order.id }
    });

    res.json({ order_id: order.id, approval_url: order.links?.find(l => l.rel === 'approve')?.href });
  } catch (err) { next(err); }
});

// POST /api/payments/paypal/capture/:orderId
router.post('/paypal/capture/:orderId', requireAuth, async (req, res, next) => {
  try {
    const { token, baseURL } = await getPaypalToken();
    const { data: capture } = await axios.post(
      `${baseURL}/v2/checkout/orders/${req.params.orderId}/capture`,
      {},
      { headers: { Authorization: `Bearer ${token}` } }
    );

    if (capture.status === 'COMPLETED') {
      await supabase.from('payments')
        .update({ status: 'completed', paid_at: new Date().toISOString() })
        .eq('metadata->>paypal_order_id', req.params.orderId);

      const { data: payment } = await supabase
        .from('payments').select('reservation_id')
        .eq('metadata->>paypal_order_id', req.params.orderId).single();

      if (payment) {
        await supabase.from('reservations')
          .update({ payment_status: 'paid', status: 'confirmed' })
          .eq('id', payment.reservation_id);
      }
      logger.info('✅ Paiement PayPal capturé', { orderId: req.params.orderId });
    }

    res.json({ status: capture.status, capture });
  } catch (err) { next(err); }
});

// ================================================
// ORANGE MONEY (Sénégal)
// ================================================
async function getOrangeMoneyToken() {
  const credentials = Buffer.from(
    `${process.env.ORANGE_MONEY_CLIENT_ID}:${process.env.ORANGE_MONEY_CLIENT_SECRET}`
  ).toString('base64');

  const resp = await axios.post(
    'https://api.orange.com/oauth/v3/token',
    'grant_type=client_credentials',
    { headers: { Authorization: `Basic ${credentials}`, 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  return resp.data.access_token;
}

// POST /api/payments/orange-money/initiate
router.post('/orange-money/initiate', requireAuth, async (req, res, next) => {
  try {
    const { reservation_id, phone_number } = req.body;
    if (!phone_number) return res.status(400).json({ error: 'Numéro de téléphone requis' });

    const { data: res_ } = await supabase
      .from('reservations').select('*, properties(owner_id, name)')
      .eq('id', reservation_id).single();

    if (!res_ || res_.properties.owner_id !== req.userId)
      return res.status(403).json({ error: 'Réservation non autorisée' });

    const token = await getOrangeMoneyToken();
    const orderRef = `HP-${Date.now()}`;

    const resp = await axios.post(
      `${process.env.ORANGE_MONEY_BASE_URL}/webpayment`,
      {
        merchant_key: process.env.ORANGE_MONEY_MERCHANT_KEY,
        currency: 'OUV',  // XOF en Orange Money
        order_id: orderRef,
        amount: Math.round(res_.total_amount),
        return_url: `${process.env.FRONTEND_URL}/payment/success?ref=${orderRef}`,
        cancel_url: `${process.env.FRONTEND_URL}/payment/cancel`,
        notif_url: `${process.env.API_URL || 'http://localhost:3000'}/api/payments/orange-money/notify`,
        lang: 'fr',
        reference: `${res_.properties.name} — ${res_.guest_name}`
      },
      { headers: { Authorization: `Bearer ${token}` } }
    );

    await supabase.from('payments').insert({
      reservation_id,
      method: 'orange_money',
      provider_ref: orderRef,
      amount: res_.total_amount,
      currency: res_.currency,
      status: 'pending',
      metadata: { order_ref: orderRef, phone: phone_number }
    });

    res.json({
      payment_url: resp.data.payment_url,
      order_ref: orderRef,
      notif_token: resp.data.notif_token
    });
  } catch (err) { next(err); }
});

// POST /api/payments/orange-money/notify — webhook Orange Money
router.post('/orange-money/notify', async (req, res) => {
  try {
    const { status, order_id, txnid } = req.body;
    logger.info('Orange Money notification', { status, order_id });

    if (status === 'SUCCESS') {
      await supabase.from('payments')
        .update({ status: 'completed', paid_at: new Date().toISOString(),
                  metadata: supabase.rpc('jsonb_merge', { data: { txnid } }) })
        .eq('provider_ref', order_id);

      const { data: payment } = await supabase
        .from('payments').select('reservation_id').eq('provider_ref', order_id).single();
      if (payment) {
        await supabase.from('reservations')
          .update({ payment_status: 'paid', status: 'confirmed' })
          .eq('id', payment.reservation_id);
      }
    }
    res.json({ status: 'ok' });
  } catch (err) {
    logger.error('Erreur webhook Orange Money', { error: err.message });
    res.json({ status: 'ok' }); // Toujours 200 pour les webhooks
  }
});

// ================================================
// WAVE (Sénégal)
// ================================================

// POST /api/payments/wave/create-session
router.post('/wave/create-session', requireAuth, async (req, res, next) => {
  try {
    const { reservation_id } = req.body;
    const { data: res_ } = await supabase
      .from('reservations').select('*, properties(owner_id, name)')
      .eq('id', reservation_id).single();

    if (!res_ || res_.properties.owner_id !== req.userId)
      return res.status(403).json({ error: 'Réservation non autorisée' });

    const { data: session } = await axios.post(
      'https://api.wave.com/v1/checkout/sessions',
      {
        amount: res_.total_amount.toString(),
        currency: 'XOF',
        error_url: `${process.env.FRONTEND_URL}/payment/error`,
        success_url: `${process.env.FRONTEND_URL}/payment/success?res=${reservation_id}`,
        business_id: process.env.WAVE_BUSINESS_ID,
        client_reference: reservation_id,
        restrict_payer_countries: ['SN', 'ML', 'CI', 'BF']
      },
      { headers: { Authorization: `Bearer ${process.env.WAVE_API_KEY}` } }
    );

    await supabase.from('payments').insert({
      reservation_id,
      method: 'wave',
      provider_ref: session.id,
      amount: res_.total_amount,
      currency: 'XOF',
      status: 'pending',
      metadata: { wave_session_id: session.id }
    });

    res.json({ checkout_url: session.wave_launch_url, session_id: session.id });
  } catch (err) { next(err); }
});

// ================================================
// LISTE & STATS paiements
// ================================================
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const { data: props } = await supabase
      .from('properties').select('id').eq('owner_id', req.userId);
    const propIds = props.map(p => p.id);

    const { data: resIds } = await supabase
      .from('reservations').select('id').in('property_id', propIds);
    const reservationIds = resIds.map(r => r.id);

    const { data, error } = await supabase
      .from('payments')
      .select('*, reservations(guest_name, property_id, check_in, check_out, properties(name))')
      .in('reservation_id', reservationIds)
      .order('created_at', { ascending: false })
      .limit(Number(req.query.limit) || 50);

    if (error) throw error;
    res.json({ data });
  } catch (err) { next(err); }
});

module.exports = router;
