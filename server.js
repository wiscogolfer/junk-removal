const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { createClient } = require('@supabase/supabase-js');

dotenv.config();

const app = express();
app.use(cors({
     origin: '*',
     methods: ['GET', 'POST', 'PATCH', 'OPTIONS'],
     allowedHeaders: ['Content-Type', 'Authorization']
   }));
   app.options('*', cors());
app.use(express.json());

// Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

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

// Get available time slots
app.get('/api/availability', async (req, res) => {
  try {
    const { date } = req.query;
    if (!date) return res.status(400).json({ error: 'Date required' });

    // Check blocked times
    const { data: blocked, error: blockError } = await supabase
      .from('blocked_time')
      .select('blocked_time_start, blocked_time_end')
      .eq('blocked_date', date);

    if (blockError) throw blockError;

    // Check existing jobs
    const { data: jobs, error: jobError } = await supabase
      .from('jobs')
      .select('scheduled_time')
      .eq('scheduled_date', date)
      .in('status', ['pending', 'confirmed']);

    if (jobError) throw jobError;

    // All time slots (30-min intervals)
    const allSlots = [];
    for (let h = 8; h < 17; h++) {
      allSlots.push(`${String(h).padStart(2, '0')}:00`);
      allSlots.push(`${String(h).padStart(2, '0')}:30`);
    }

    // Remove blocked/booked slots
    const bookedTimes = jobs.map(j => j.scheduled_time);
    const available = allSlots.filter(slot => !bookedTimes.includes(slot));

    res.json({ available });
  } catch (err) {
    console.error('Availability error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Create job
app.post('/api/jobs', async (req, res) => {
  try {
    const { email, phone, address, scheduled_date, scheduled_time, items, total_price, notes } = req.body;

    if (!email || !phone || !address || !scheduled_date || !scheduled_time || !items || !total_price) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Check if customer exists, create if not
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
        .insert({ email, phone, address })
        .select('id')
        .single();

      if (createError) throw createError;
      customer = newCustomer;
    }

    // Create job
    const { data: job, error: jobError } = await supabase
      .from('jobs')
      .insert({
        customer_id: customer.id,
        scheduled_date,
        scheduled_time,
        items,
        total_price,
        notes,
        status: 'pending'
      })
      .select()
      .single();

    if (jobError) throw jobError;

    res.status(201).json(job);
  } catch (err) {
    console.error('Job creation error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get job by ID (for customer tracking)
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

// Admin: Get all jobs (requires auth token in real app)
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

// Admin: Update pricing
app.post('/api/admin/pricing', async (req, res) => {
  try {
    const { item_type, price, category, description } = req.body;

    if (!item_type || !price) {
      return res.status(400).json({ error: 'item_type and price required' });
    }

    // Upsert: update if exists, insert if not
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
