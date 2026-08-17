require('dotenv').config();
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const { Redis } = require('@upstash/redis');
const crypto = require('crypto');
const path = require('path');

const app = express();

// ==========================================
// 1. CONFIGURATION & SERVICES
// ==========================================
const redis = new Redis({
  url: process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN,
});

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Security Headers (Helmet) - Adjusted for EJS inline scripts
app.use(helmet({
  contentSecurityPolicy: false, 
}));

// Ignore Favicon 404 Logs to keep Vercel logs clean
app.get('/favicon.ico', (req, res) => res.status(204).end());
app.get('/favicon.png', (req, res) => res.status(204).end());

// Session Management
app.use(session({
  secret: process.env.SESSION_SECRET || 'fallback-secret-development-only',
  resave: false,
  saveUninitialized: false,
  cookie: { 
    httpOnly: true, 
    secure: process.env.NODE_ENV === 'production', 
    sameSite: 'lax' 
  }
}));

// Flash messages & Global UI variables middleware
app.use(async (req, res, next) => {
  res.locals.user = req.session.user || null;
  res.locals.success = req.session.success || null;
  res.locals.error = req.session.error || null;
  req.session.success = null;
  req.session.error = null;
  
  // Load settings globally with Fail-Safe Try/Catch
  try {
    let settings = await redis.get('axa:settings');
    if (!settings) {
      settings = { businessName: 'AXA XYZ', invoicePrefix: 'AXZ' };
    }
    res.locals.settings = settings;
  } catch (dbError) {
    console.error('🔴 REDIS CONNECTION ERROR IN MIDDLEWARE:', dbError.message);
    // Fallback if database is unreachable so the app doesn't crash 500 completely
    res.locals.settings = { businessName: 'AXA XYZ (DB Offline)', invoicePrefix: 'AXZ' };
  }
  
  next();
});

// ==========================================
// 2. MIDDLEWARES & HELPERS
// ==========================================
const requireAuth = (req, res, next) => {
  if (!req.session.user) return res.redirect('/login');
  next();
};

const formatRupiah = (amount) => {
  return new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 }).format(amount);
};
app.locals.formatRupiah = formatRupiah;
app.locals.formatDate = (dateString) => dateString ? new Date(dateString).toLocaleDateString('id-ID') : '';

// Invoice Status Rule Helper
const checkOverdue = (invoice) => {
  if (invoice.status === 'PAID') return invoice;
  if (invoice.balance > 0 && new Date(invoice.dueDate) < new Date() && invoice.status !== 'DRAFT') {
    invoice.status = 'OVERDUE';
  }
  return invoice;
};

// ==========================================
// 3. AUTH ROUTES
// ==========================================
app.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/dashboard');
  res.render('login');
});

app.post('/login', (req, res) => {
  const { email, password } = req.body;
  
  // Prioritize ADMIN_USER and ADMIN_PASS, fallback to older variables
  const adminIdentifier = process.env.ADMIN_USER || process.env.ADMIN_EMAIL;
  const adminPassword = process.env.ADMIN_PASS || process.env.ADMIN_PASSWORD;

  if (email === adminIdentifier && password === adminPassword) {
    req.session.user = { email, role: 'admin' };
    return res.redirect('/dashboard');
  }
  
  req.session.error = 'Email/Username atau password salah.';
  res.redirect('/login');
});

app.post('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

app.get('/', (req, res) => {
  res.redirect('/dashboard');
});

// ==========================================
// 4. DASHBOARD
// ==========================================
app.get('/dashboard', requireAuth, async (req, res) => {
  const invoiceIds = await redis.lrange('axa:invoices', 0, -1);
  let invoices = invoiceIds.length ? await Promise.all(invoiceIds.map(id => redis.get(`axa:invoice:${id}`))) : [];
  invoices = invoices.filter(i => i).map(checkOverdue);

  const stats = {
    totalInvoices: invoices.length,
    totalBilled: 0,
    totalPaid: 0,
    outstanding: 0,
    overdue: 0
  };

  invoices.forEach(inv => {
    if (inv.status !== 'DRAFT') stats.totalBilled += inv.total;
    stats.totalPaid += inv.amountPaid;
    if (inv.status !== 'PAID' && inv.status !== 'DRAFT') stats.outstanding += inv.balance;
    if (inv.status === 'OVERDUE') stats.overdue += inv.balance;
  });

  const recentInvoices = invoices.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 5);
  res.render('dashboard', { stats, recentInvoices });
});

// ==========================================
// 5. CUSTOMERS
// ==========================================
app.get('/customers', requireAuth, async (req, res) => {
  const ids = await redis.lrange('axa:customers', 0, -1);
  let customers = ids.length ? await Promise.all(ids.map(id => redis.get(`axa:customer:${id}`))) : [];
  res.render('customers', { customers: customers.filter(c => c) });
});

app.get('/customers/new', requireAuth, (req, res) => {
  res.render('customer-form', { customer: {} });
});

app.post('/customers', requireAuth, async (req, res) => {
  const id = `CUS-${Date.now()}`;
  const customer = { id, ...req.body, createdAt: new Date().toISOString() };
  await redis.set(`axa:customer:${id}`, customer);
  await redis.lpush('axa:customers', id);
  req.session.success = 'Customer berhasil disimpan.';
  res.redirect('/customers');
});

app.get('/customers/:id/edit', requireAuth, async (req, res) => {
  const customer = await redis.get(`axa:customer:${req.params.id}`);
  if (!customer) return res.status(404).send('Customer tidak ditemukan');
  res.render('customer-form', { customer });
});

app.post('/customers/:id/edit', requireAuth, async (req, res) => {
  const existing = await redis.get(`axa:customer:${req.params.id}`);
  const customer = { ...existing, ...req.body, updatedAt: new Date().toISOString() };
  await redis.set(`axa:customer:${req.params.id}`, customer);
  req.session.success = 'Customer berhasil diupdate.';
  res.redirect('/customers');
});

// ==========================================
// 6. INVOICES
// ==========================================
app.get('/invoices', requireAuth, async (req, res) => {
  const ids = await redis.lrange('axa:invoices', 0, -1);
  let invoices = ids.length ? await Promise.all(ids.map(id => redis.get(`axa:invoice:${id}`))) : [];
  
  // Fetch customer names
  for(let inv of invoices) {
    if(inv) {
        inv = checkOverdue(inv);
        const cus = await redis.get(`axa:customer:${inv.customerId}`);
        inv.customerName = cus ? cus.companyName : 'Unknown';
    }
  }
  
  res.render('invoices', { invoices: invoices.filter(i=>i).sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt)) });
});

app.get('/invoices/new', requireAuth, async (req, res) => {
  const cids = await redis.lrange('axa:customers', 0, -1);
  const customers = cids.length ? await Promise.all(cids.map(id => redis.get(`axa:customer:${id}`))) : [];
  res.render('invoice-form', { invoice: { items: [] }, customers: customers.filter(c=>c) });
});

app.post('/invoices', requireAuth, async (req, res) => {
  const id = `INV-${Date.now()}`;
  const publicId = `axz_${crypto.randomBytes(8).toString('hex')}`;
  const year = new Date().getFullYear();
  const counter = await redis.incr(`axa:counter:invoice:${year}`);
  const prefix = res.locals.settings.invoicePrefix || 'AXZ';
  const number = `${prefix}-${year}-${String(counter).padStart(5, '0')}`;
  
  const { customerId, invoiceDate, dueDate, items, notes } = req.body;
  
  // Server-side Calculation
  let subtotal = 0;
  let tax = 0;
  const processedItems = [];
  
  if (items && Array.isArray(items)) {
    items.forEach(item => {
        const qty = parseInt(item.quantity) || 0;
        const price = parseInt(item.price) || 0;
        const discount = parseInt(item.discount) || 0;
        const taxRate = parseFloat(item.taxRate) || 0;
        
        const lineSubtotal = qty * price;
        const lineDiscount = Math.round((lineSubtotal * discount) / 100);
        const lineNet = lineSubtotal - lineDiscount;
        const lineTax = Math.round((lineNet * taxRate) / 100);
        const total = lineNet + lineTax;
        
        subtotal += lineNet;
        tax += lineTax;
        processedItems.push({ ...item, quantity: qty, price, discount, taxRate, total });
    });
  }

  const grandTotal = subtotal + tax;

  const invoice = {
    id, publicId, number, status: 'DRAFT', customerId, invoiceDate, dueDate, currency: 'IDR',
    items: processedItems, subtotal, discount: 0, taxableBase: subtotal, tax, additionalFee: 0, total: grandTotal,
    amountPaid: 0, balance: grandTotal, payments: [], notes, createdAt: new Date().toISOString()
  };

  await redis.set(`axa:invoice:${id}`, invoice);
  await redis.lpush('axa:invoices', id);
  
  req.session.success = 'Invoice berhasil dibuat.';
  res.redirect('/invoices');
});

app.get('/invoices/:id', requireAuth, async (req, res) => {
  let invoice = await redis.get(`axa:invoice:${req.params.id}`);
  if (!invoice) return res.status(404).send('Invoice Not Found');
  invoice = checkOverdue(invoice);
  const customer = await redis.get(`axa:customer:${invoice.customerId}`);
  res.render('invoice-detail', { invoice, customer });
});

app.post('/invoices/:id/issue', requireAuth, async (req, res) => {
  const invoice = await redis.get(`axa:invoice:${req.params.id}`);
  if (invoice.status === 'DRAFT') {
    invoice.status = 'UNPAID';
    await redis.set(`axa:invoice:${req.params.id}`, invoice);
    req.session.success = 'Invoice diterbitkan.';
  }
  res.redirect(`/invoices/${req.params.id}`);
});

app.post('/invoices/:id/payment', requireAuth, async (req, res) => {
  const invoice = await redis.get(`axa:invoice:${req.params.id}`);
  const amount = parseInt(req.body.amount);
  
  if (amount <= 0 || amount > invoice.balance) {
      req.session.error = 'Jumlah tidak valid.';
      return res.redirect(`/invoices/${req.params.id}`);
  }

  const payment = {
      id: `PAY-${Date.now()}`, amount, method: req.body.method, reference: req.body.reference,
      note: req.body.note, paidAt: new Date().toISOString()
  };

  invoice.payments.push(payment);
  invoice.amountPaid += amount;
  invoice.balance = invoice.total - invoice.amountPaid;
  
  if (invoice.balance === 0) invoice.status = 'PAID';
  else invoice.status = 'PARTIALLY_PAID';

  await redis.set(`axa:invoice:${req.params.id}`, invoice);
  req.session.success = 'Pembayaran dicatat.';
  res.redirect(`/invoices/${req.params.id}`);
});

app.get('/invoices/:id/print', requireAuth, async (req, res) => {
  const invoice = await redis.get(`axa:invoice:${req.params.id}`);
  const customer = await redis.get(`axa:customer:${invoice.customerId}`);
  res.render('invoice-print', { invoice, customer });
});

// ==========================================
// 7. PUBLIC INVOICE
// ==========================================
app.get('/invoice/:publicId', async (req, res) => {
  // Find invoice by publicId (Sequential scan for MVP, upgrade to index later if needed)
  const ids = await redis.lrange('axa:invoices', 0, -1);
  let invoices = ids.length ? await Promise.all(ids.map(id => redis.get(`axa:invoice:${id}`))) : [];
  let invoice = invoices.find(i => i && i.publicId === req.params.publicId);
  
  if (!invoice) return res.status(404).render('login', { error: 'Invoice Not Found' });
  
  invoice = checkOverdue(invoice);
  const customer = await redis.get(`axa:customer:${invoice.customerId}`);
  
  // Minimalist public view
  res.render('invoice-public', { invoice, customer });
});

// ==========================================
// 8. SETTINGS
// ==========================================
app.get('/settings', requireAuth, (req, res) => {
  res.render('settings');
});

app.post('/settings', requireAuth, async (req, res) => {
  const settings = { ...res.locals.settings, ...req.body };
  await redis.set('axa:settings', settings);
  req.session.success = 'Settings disimpan.';
  res.redirect('/settings');
});

// ==========================================
// 9. ERROR HANDLING
// ==========================================
app.use((err, req, res, next) => {
  console.error('🔥 FATAL SERVER ERROR:', err.stack);
  res.status(500).send('Terjadi kesalahan pada server. Silakan cek Application Logs di Vercel.');
});

// Export for Vercel
module.exports = app;

// Start local server
if (require.main === module) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`AXA XYZ Invoice running on port ${port}`));
}
