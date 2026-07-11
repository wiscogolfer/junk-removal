const express = require('express');
const dotenv = require('dotenv');
const { createClient } = require('@supabase/supabase-js');

dotenv.config();

const app = express();

// Manual CORS headers middleware
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Max-Age', '86400');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

app.use(express.json());

// Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Email config
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'justin@santanhaul.com';
const SITE_URL = process.env.SITE_URL || 'https://santanhaul.com';
const FROM_EMAIL = process.env.FROM_EMAIL || 'San Tan Haul <quotes@santanhaul.com>';

// SMS config
const SMSMOBILEAPI_KEY = process.env.SMSMOBILEAPI_KEY;
const SMS_FROM_NUMBER = process.env.SMS_FROM_NUMBER || '+14142023822';

// Send email via Resend
async function sendEmail(to, subject, html) {
  if (!RESEND_API_KEY) {
    console.warn('RESEND_API_KEY not set - skipping email:', subject);
    return;
  }
  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ from: FROM_EMAIL, to: [to], subject, html })
    });
    if (!resp.ok) {
      console.error('Resend error:', resp.status, await resp.text());
    }
  } catch (err) {
    console.error('Email send failed:', err.message);
  }
}

// Send SMS via SMSMobileAPI
async function sendSMS(to, message) {
  if (!SMSMOBILEAPI_KEY) {
    console.warn('SMSMOBILEAPI_KEY not set - skipping SMS:', message);
    return;
  }
  try {
    // Format phone numbers in E.164 format (e.g., +14142023822)
    const formattedTo = to.startsWith('+') ? to : `+1${to}`;
    
    // SMSMobileAPI uses query parameters
    const url = new URL('https://api.smsmobileapi.com/sendsms/');
    url.searchParams.append('apikey', SMSMOBILEAPI_KEY);
    url.searchParams.append('recipients', formattedTo);
    url.searchParams.append('message', message);
    
    const resp = await fetch(url.toString(), { method: 'GET' });
    const data = await resp.text();
    
    if (!resp.ok || data.includes('"error"')) {
      console.error('SMSMobileAPI error:', resp.status, data);
    } else {
      console.log('SMS sent to', formattedTo);
    }
  } catch (err) {
    console.error('SMS send failed:', err.message);
  }
}

function fmtDate(d) {
  return new Date(d + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
}

function fmtTime(t) {
  const h = parseInt(String(t).split(':')[0], 10);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const hh = h % 12 === 0 ? 12 : h % 12;
  return `${hh}:00 ${ampm}`;
}

function itemsTable(items) {
  return (items || []).map(i =>
    `<tr><td style="padding:8px 0;color:#4d6076;border-bottom:1px solid #E7DFD2">${i.qty}&times; ${i.item_type}</td>
     <td style="padding:8px 0;text-align:right;font-weight:bold;color:#1B3A5C;border-bottom:1px solid #E7DFD2">$${i.price * i.qty}</td></tr>`
  ).join('');
}

function emailShell(inner) {
  return `<div style="background:#FAF5EC;padding:32px 16px;font-family:Arial,Helvetica,sans-serif">
    <div style="max-width:480px;margin:0 auto;background:#FFFDF8;border:1.5px solid #E7DFD2;border-radius:16px;padding:32px">
      <h1 style="color:#1B3A5C;font-size:22px;margin:0 0 4px;text-align:center;letter-spacing:1px">SAN TAN HAUL</h1>
      <p style="color:#C77F1F;font-size:11px;font-weight:bold;text-align:center;margin:0 0 24px;letter-spacing:2px">SAN TAN VALLEY, AZ</p>
      ${inner}
    </div>
    <p style="text-align:center;color:#9aa7b5;font-size:11px;margin-top:16px">San Tan Haul &bull; Serving San Tan Valley, Queen Creek &amp; Gilbert</p>
  </div>`;
}

// ========== ROUTES ==========

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Get pricing items
app.get('/api/pricing', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('pricing_items')
      .select('*')
      .order('category, item_type');

    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    console.error('Pricing error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Create job (customer request)
app.post('/api/jobs', async (req, res) => {
  try {
    const { name, email, phone, address, scheduled_date, scheduled_time, items, total_price, notes, photos } = req.body;

    if (!name || !email || !phone || !address || !scheduled_date || !scheduled_time || !items || !total_price) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    let { data: customer, error: customerError } = await supabase
      .from('customers')
      .select('id')
      .eq('email', email)
      .single();

    if (customerError && customerError.code !== 'PGRST116') {
      throw customerError;
    }

    if (!customer) {
      const { data: newCustomer, error: createError } = await supabase
        .from('customers')
        .insert({ name, email, phone, address })
        .select('id')
        .single();

      if (createError) throw createError;
      customer = newCustomer;
    }

    const { data: job, error: jobError } = await supabase
      .from('jobs')
      .insert({
        customer_id: customer.id,
        customer_name: name,
        email: email,
        phone: phone,
        address: address,
        scheduled_date,
        scheduled_time,
        items,
        total_price,
        notes,
        photos: photos || [],
        status: 'pending'
      })
      .select()
      .single();

    if (jobError) throw jobError;

    // Notify Justin - new request (don't block the response on it)
    sendEmail(
      ADMIN_EMAIL,
      `New pickup request: ${name} - $${total_price} (${fmtDate(scheduled_date)})`,
      emailShell(`
        <h2 style="color:#1B3A5C;font-size:18px;margin:0 0 16px">New pickup request</h2>
        <p style="color:#4d6076;font-size:14px;margin:0 0 4px"><b>${name}</b> &bull; ${phone} &bull; ${email}</p>
        <p style="color:#4d6076;font-size:14px;margin:0 0 16px">${address}</p>
        <p style="color:#4d6076;font-size:14px;margin:0 0 16px"><b>${fmtDate(scheduled_date)} at ${fmtTime(scheduled_time)}</b></p>
        <table style="width:100%;border-collapse:collapse">${itemsTable(items)}</table>
        <p style="font-size:20px;font-weight:bold;color:#C77F1F;text-align:right;margin:16px 0">$${total_price}</p>
        ${notes ? `<p style="color:#a08a5f;font-size:13px;font-style:italic">"${notes}"</p>` : ''}
        ${(photos || []).length ? `<p style="font-size:13px"><b>Photos:</b> ${(photos || []).map((p, i) => `<a href="${p}">Photo ${i + 1}</a>`).join(' &bull; ')}</p>` : ''}
        <a href="${SITE_URL}/?admin=true" style="display:block;background:#1B3A5C;color:#fff;text-align:center;padding:14px;border-radius:12px;text-decoration:none;font-weight:bold;margin-top:16px">Review in dashboard</a>
      `)
    );

    res.status(201).json(job);
  } catch (err) {
    console.error('Job creation error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Send quote to customer (called from admin dashboard)
app.post('/api/admin/jobs/:id/send-quote', async (req, res) => {
  try {
    const { data: job, error } = await supabase
      .from('jobs')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (error) throw error;
    if (!job) return res.status(404).json({ error: 'Job not found' });

    const quoteUrl = `${SITE_URL}/?quote=${job.id}`;

    // Send email with full details
    await sendEmail(
      job.email,
      `Your San Tan Haul quote: $${job.total_price} - tap to approve`,
      emailShell(`
        <h2 style="color:#1B3A5C;font-size:18px;margin:0 0 8px">Hi ${(job.customer_name || '').split(' ')[0]}, your quote is ready!</h2>
        <p style="color:#4d6076;font-size:14px;margin:0 0 16px">Pickup on <b>${fmtDate(job.scheduled_date)} at ${fmtTime(job.scheduled_time)}</b></p>
        <table style="width:100%;border-collapse:collapse">${itemsTable(job.items)}</table>
        <p style="font-size:26px;font-weight:bold;color:#C77F1F;text-align:right;margin:16px 0 4px">$${job.total_price}</p>
        <p style="color:#9aa7b5;font-size:12px;text-align:right;margin:0 0 20px">Pay after service &bull; cash, Venmo, or card</p>
        <a href="${quoteUrl}" style="display:block;background:linear-gradient(135deg,#E8A33D,#C77F1F);color:#12293F;text-align:center;padding:16px;border-radius:12px;text-decoration:none;font-weight:bold;font-size:16px">Review &amp; approve your quote</a>
        <p style="color:#7a8797;font-size:12px;margin-top:20px">This price is based on what was described. If the job on-site doesn't match &mdash; more items, different condition, or tough access &mdash; we'll go over any change with you <b>before</b> work starts. No surprises, ever.</p>
      `)
    );

    // Send SMS with quote link
    const smsMessage = `Hi ${(job.customer_name || '').split(' ')[0]}! Your San Tan Haul quote is ready: $${job.total_price}. Tap to review and approve: ${quoteUrl}`;
    await sendSMS(job.phone, smsMessage);

    // Mark as quoted
    const { data: updated, error: updError } = await supabase
      .from('jobs')
      .update({ status: 'quoted' })
      .eq('id', job.id)
      .select()
      .single();

    if (updError) throw updError;

    res.json({ ok: true, job: updated });
  } catch (err) {
    console.error('Send quote error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Customer approves quote
app.post('/api/jobs/:id/approve', async (req, res) => {
  try {
    const { data: job, error } = await supabase
      .from('jobs')
      .update({ status: 'confirmed' })
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw error;

    // Notify Justin
    sendEmail(
      ADMIN_EMAIL,
      `APPROVED: ${job.customer_name} - $${job.total_price} on ${fmtDate(job.scheduled_date)}`,
      emailShell(`
        <h2 style="color:#1a7f4b;font-size:18px;margin:0 0 16px">&#10003; Quote approved!</h2>
        <p style="color:#4d6076;font-size:14px"><b>${job.customer_name}</b> approved $${job.total_price} for <b>${fmtDate(job.scheduled_date)} at ${fmtTime(job.scheduled_time)}</b>.</p>
        <p style="color:#4d6076;font-size:14px">${job.address || ''}</p>
        <p style="color:#4d6076;font-size:14px">${job.phone || ''}</p>
      `)
    );

    // Confirmation SMS to customer
    const smsMessage = `You're confirmed! San Tan Haul on ${fmtDate(job.scheduled_date)} at ${fmtTime(job.scheduled_time)}. See you soon!`;
    await sendSMS(job.phone, smsMessage);

    // Confirmation email to customer
    sendEmail(
      job.email,
      `You're confirmed! San Tan Haul - ${fmtDate(job.scheduled_date)}`,
      emailShell(`
        <h2 style="color:#1a7f4b;font-size:18px;margin:0 0 16px">&#10003; You're all set, ${(job.customer_name || '').split(' ')[0]}!</h2>
        <p style="color:#4d6076;font-size:14px">We'll see you on <b>${fmtDate(job.scheduled_date)} at ${fmtTime(job.scheduled_time)}</b>.</p>
        <p style="color:#4d6076;font-size:14px">Total: <b>$${job.total_price}</b> &bull; pay after service (cash, Venmo, or card)</p>
        <p style="color:#7a8797;font-size:13px;margin-top:20px">Need to change anything? Just reply to this email or text us.</p>
      `)
    );

    res.json({ ok: true, job });
  } catch (err) {
    console.error('Approve error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get job by ID
app.get('/api/jobs/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('jobs')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin: Get all jobs
app.get('/api/admin/jobs', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('jobs')
      .select('*')
      .order('scheduled_date, scheduled_time');

    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin: Update job status
app.patch('/api/admin/jobs/:id', async (req, res) => {
  try {
    const { status, notes } = req.body;

    if (!status) {
      return res.status(400).json({ error: 'Status required' });
    }

    const { data, error } = await supabase
      .from('jobs')
      .update({ status, notes: notes || null })
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin: Delete job
app.delete('/api/admin/jobs/:id', async (req, res) => {
  try {
    const { error } = await supabase
      .from('jobs')
      .delete()
      .eq('id', req.params.id);

    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin: Update pricing
app.post('/api/admin/pricing', async (req, res) => {
  try {
    const { item_type, price, category, description } = req.body;

    if (!item_type || !price) {
      return res.status(400).json({ error: 'item_type and price required' });
    }

    const { data, error } = await supabase
      .from('pricing_items')
      .upsert({ item_type, price, category, description })
      .select()
      .single();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== START SERVER ==========
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Junk removal server running on port ${PORT}`);
});
