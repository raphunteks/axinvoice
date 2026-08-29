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
// Fail-safe Redis initialization: Mengambil dari Vercel KV Env Variables
const redis = new Redis({
  url: process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || 'https://dummy-url.upstash.io',
  token: process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || 'dummy-token',
});

// TRUST PROXY WAJIB UNTUK VERCEL!
app.set('trust proxy', 1); 

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Security Headers (Helmet)
app.use(helmet({
  contentSecurityPolicy: false, 
}));

// Ignore default Favicon 404 Logs to keep Vercel logs clean
app.get('/favicon.ico', (req, res) => res.status(204).end());

// ==========================================
// 2. UPSTASH REDIS SESSION STORE (CUSTOM ENGINE)
// ==========================================
const Store = session.Store;
class UpstashSessionStore extends Store {
  constructor(options = {}) {
    super(options);
    this.client = options.client;
    this.prefix = options.prefix || 'axa:session:';
    this.ttl = options.ttl || 86400; // 24 hours (Sesi bertahan 1 hari)
  }
  async get(sid, callback) {
    try {
      let data = await this.client.get(this.prefix + sid);
      if (!data) return callback(null, null);
      if (typeof data === 'string') data = JSON.parse(data);
      return callback(null, data);
    } catch (err) { return callback(err); }
  }
  async set(sid, sessionData, callback) {
    try {
      await this.client.set(this.prefix + sid, JSON.stringify(sessionData), { ex: this.ttl });
      return callback(null);
    } catch (err) { return callback(err); }
  }
  async destroy(sid, callback) {
    try {
      await this.client.del(this.prefix + sid);
      return callback(null);
    } catch (err) { return callback(err); }
  }
}

// Session Management
app.use(session({
  store: new UpstashSessionStore({ client: redis }),
  secret: process.env.SESSION_SECRET || 'fallback-secret-development-only',
  resave: false,
  saveUninitialized: false,
  cookie: { 
    httpOnly: true, 
    secure: process.env.NODE_ENV === 'production', 
    sameSite: 'lax',
    maxAge: 24 * 60 * 60 * 1000 
  }
}));

// Flash messages & Global UI variables middleware
app.use(async (req, res, next) => {
  res.locals.user = req.session.user || null;
  res.locals.success = req.session.success || null;
  res.locals.error = req.session.error || null;
  req.session.success = null;
  req.session.error = null;
  
  try {
    let settings = await redis.get('axa:settings');
    if (!settings) {
      settings = { businessName: 'AXA XYZ', invoicePrefix: 'AXZ', defaultTaxRate: 0, defaultDiscRate: 0 };
    }
    res.locals.settings = settings;
  } catch (dbError) {
    console.error('🔴 REDIS CONNECTION ERROR IN MIDDLEWARE:', dbError.message);
    res.locals.settings = { businessName: 'AXA XYZ (DB Offline)', invoicePrefix: 'AXZ', defaultTaxRate: 0, defaultDiscRate: 0 };
  }
  next();
});

// ==========================================
// 3. MIDDLEWARES & HELPERS
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

const checkOverdue = (invoice) => {
  if (invoice.status === 'PAID') return invoice;
  if (invoice.balance > 0 && new Date(invoice.dueDate) < new Date() && invoice.status !== 'DRAFT') {
    invoice.status = 'OVERDUE';
  }
  return invoice;
};

// ==========================================
// 4. AUTH ROUTES
// ==========================================
app.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/dashboard');
  res.render('login');
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (username === process.env.ADMIN_USER && password === process.env.ADMIN_PASS) {
    req.session.user = { username, role: 'admin' };
    return res.redirect('/dashboard');
  }
  req.session.error = 'Username atau password salah.';
  res.redirect('/login');
});

app.post('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

app.get('/', (req, res) => res.redirect('/dashboard'));

// ==========================================
// 5. DASHBOARD
// ==========================================
app.get('/dashboard', requireAuth, async (req, res) => {
  try {
    const invoiceIds = await redis.lrange('axa:invoices', 0, -1);
    let invoices = invoiceIds.length ? await Promise.all(invoiceIds.map(id => redis.get(`axa:invoice:${id}`))) : [];
    invoices = invoices.filter(i => i).map(checkOverdue);

    const stats = { totalInvoices: invoices.length, totalBilled: 0, totalPaid: 0, outstanding: 0, overdue: 0 };

    invoices.forEach(inv => {
      if (inv.status !== 'DRAFT') stats.totalBilled += inv.total;
      stats.totalPaid += inv.amountPaid;
      if (inv.status !== 'PAID' && inv.status !== 'DRAFT') stats.outstanding += inv.balance;
      if (inv.status === 'OVERDUE') stats.overdue += inv.balance;
    });

    const recentInvoices = invoices.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 5);
    res.render('dashboard', { stats, recentInvoices });
  } catch (error) {
    res.render('dashboard', { stats: { totalInvoices: 0, totalBilled: 0, totalPaid: 0, outstanding: 0, overdue: 0 }, recentInvoices: [], error: 'Gagal memuat data.' });
  }
});

// ==========================================
// 6. CUSTOMERS
// ==========================================
app.get('/customers', requireAuth, async (req, res) => {
  try {
    const ids = await redis.lrange('axa:customers', 0, -1);
    let customers = ids.length ? await Promise.all(ids.map(id => redis.get(`axa:customer:${id}`))) : [];
    res.render('customers', { customers: customers.filter(c => c) });
  } catch (error) {
    res.render('customers', { customers: [], error: 'Gagal memuat data.' });
  }
});

app.get('/customers/new', requireAuth, (req, res) => res.render('customer-form', { customer: {} }));

app.post('/customers', requireAuth, async (req, res) => {
  try {
    const id = `CUS-${Date.now()}`;
    const customer = { id, ...req.body, createdAt: new Date().toISOString() };
    await redis.set(`axa:customer:${id}`, customer);
    await redis.lpush('axa:customers', id);
    req.session.success = 'Customer berhasil disimpan.';
    res.redirect('/customers');
  } catch (error) { res.redirect('/customers/new'); }
});

app.get('/customers/:id/edit', requireAuth, async (req, res) => {
  try {
    const customer = await redis.get(`axa:customer:${req.params.id}`);
    if (!customer) return res.status(404).send('Not Found');
    res.render('customer-form', { customer });
  } catch (error) { res.redirect('/customers'); }
});

app.post('/customers/:id/edit', requireAuth, async (req, res) => {
  try {
    const existing = await redis.get(`axa:customer:${req.params.id}`);
    const customer = { ...existing, ...req.body, updatedAt: new Date().toISOString() };
    await redis.set(`axa:customer:${req.params.id}`, customer);
    req.session.success = 'Customer berhasil diupdate.';
    res.redirect('/customers');
  } catch(error) { res.redirect('/customers'); }
});

// ==========================================
// 7. INVOICES (CREATE, READ, UPDATE, DELETE)
// ==========================================
app.get('/invoices', requireAuth, async (req, res) => {
  try {
    const ids = await redis.lrange('axa:invoices', 0, -1);
    let invoices = ids.length ? await Promise.all(ids.map(id => redis.get(`axa:invoice:${id}`))) : [];
    
    for(let inv of invoices) {
      if(inv) {
          inv = checkOverdue(inv);
          const cus = await redis.get(`axa:customer:${inv.customerId}`);
          inv.customerName = cus ? cus.companyName : 'Unknown';
      }
    }
    res.render('invoices', { invoices: invoices.filter(i=>i).sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt)) });
  } catch (error) { res.render('invoices', { invoices: [], error: 'Gagal memuat data invoice.' }); }
});

app.get('/invoices/new', requireAuth, async (req, res) => {
  try {
    const cids = await redis.lrange('axa:customers', 0, -1);
    const customers = cids.length ? await Promise.all(cids.map(id => redis.get(`axa:customer:${id}`))) : [];
    res.render('invoice-form', { invoice: { items: [] }, customers: customers.filter(c=>c) });
  } catch (error) { res.redirect('/invoices'); }
});

// CREATE INVOICE
app.post('/invoices', requireAuth, async (req, res) => {
  try {
    const id = `INV-${Date.now()}`;
    const publicId = `axz_${crypto.randomBytes(8).toString('hex')}`;
    const year = new Date().getFullYear();
    const counter = await redis.incr(`axa:counter:invoice:${year}`);
    const prefix = res.locals.settings.invoicePrefix || 'AXZ';
    const number = `${prefix}-${year}-${String(counter).padStart(5, '0')}`;
    
    const { customerId, invoiceDate, dueDate, items, notes, globalDiscountRate, globalTaxRate } = req.body;
    
    let subtotal = 0;
    const processedItems = [];
    
    let itemsArray = [];
    if (items) { itemsArray = Array.isArray(items) ? items : Object.values(items); }
    
    itemsArray.forEach(item => {
        if(!item.description) return; 
        const qty = parseInt(item.quantity) || 0;
        const price = parseInt(item.price) || 0;
        const lineTotal = qty * price;
        subtotal += lineTotal;
        processedItems.push({ ...item, quantity: qty, price, total: lineTotal });
    });

    const discRate = parseFloat(globalDiscountRate) || 0;
    const taxRate = parseFloat(globalTaxRate) || 0;
    const discountAmount = Math.round((subtotal * discRate) / 100);
    const taxableBase = subtotal - discountAmount;
    const taxAmount = Math.round((taxableBase * taxRate) / 100);
    const grandTotal = taxableBase + taxAmount;

    const invoice = {
      id, publicId, number, status: 'DRAFT', customerId, invoiceDate, dueDate, currency: 'IDR',
      items: processedItems, subtotal, discountRate: discRate, discountAmount, taxableBase, taxRate, tax: taxAmount, additionalFee: 0, total: grandTotal,
      amountPaid: 0, balance: grandTotal, payments: [], notes, createdAt: new Date().toISOString()
    };

    await redis.set(`axa:invoice:${id}`, invoice);
    await redis.lpush('axa:invoices', id);
    
    req.session.success = 'Invoice berhasil dibuat.';
    res.redirect('/invoices');
  } catch(error) { res.redirect('/invoices'); }
});

// GET EDIT INVOICE
app.get('/invoices/:id/edit', requireAuth, async (req, res) => {
  try {
    const invoice = await redis.get(`axa:invoice:${req.params.id}`);
    if (!invoice) return res.redirect('/invoices');
    
    const cids = await redis.lrange('axa:customers', 0, -1);
    const customers = cids.length ? await Promise.all(cids.map(id => redis.get(`axa:customer:${id}`))) : [];
    
    res.render('invoice-form', { invoice, customers: customers.filter(c=>c) });
  } catch (error) { res.redirect('/invoices'); }
});

// POST EDIT INVOICE
app.post('/invoices/:id/edit', requireAuth, async (req, res) => {
  try {
    const existingInvoice = await redis.get(`axa:invoice:${req.params.id}`);
    if (!existingInvoice) return res.redirect('/invoices');

    const { customerId, invoiceDate, dueDate, items, notes, globalDiscountRate, globalTaxRate } = req.body;
    
    let subtotal = 0;
    const processedItems = [];
    
    let itemsArray = [];
    if (items) { itemsArray = Array.isArray(items) ? items : Object.values(items); }
    
    itemsArray.forEach(item => {
        if(!item.description) return; 
        const qty = parseInt(item.quantity) || 0;
        const price = parseInt(item.price) || 0;
        const lineTotal = qty * price;
        subtotal += lineTotal;
        processedItems.push({ ...item, quantity: qty, price, total: lineTotal });
    });

    const discRate = parseFloat(globalDiscountRate) || 0;
    const taxRate = parseFloat(globalTaxRate) || 0;
    const discountAmount = Math.round((subtotal * discRate) / 100);
    const taxableBase = subtotal - discountAmount;
    const taxAmount = Math.round((taxableBase * taxRate) / 100);
    const grandTotal = taxableBase + taxAmount;

    const updatedInvoice = {
      ...existingInvoice,
      customerId, invoiceDate, dueDate, items: processedItems, notes,
      subtotal, discountRate: discRate, discountAmount, taxableBase, taxRate, tax: taxAmount,
      total: grandTotal, balance: grandTotal - (existingInvoice.amountPaid || 0)
    };
    
    // Auto status recovery
    if (updatedInvoice.balance <= 0 && updatedInvoice.status !== 'DRAFT') updatedInvoice.status = 'PAID';
    else if (updatedInvoice.amountPaid > 0 && updatedInvoice.balance > 0 && updatedInvoice.status !== 'DRAFT') updatedInvoice.status = 'PARTIALLY_PAID';

    await redis.set(`axa:invoice:${req.params.id}`, updatedInvoice);
    req.session.success = 'Invoice berhasil diperbarui.';
    res.redirect(`/invoices/${req.params.id}`);
  } catch(error) { res.redirect(`/invoices/${req.params.id}`); }
});

// DELETE INVOICE (SMART REDIRECT DIPERBARUI UNTUK RECEIPTS)
app.post('/invoices/:id/delete', requireAuth, async (req, res) => {
  try {
    await redis.del(`axa:invoice:${req.params.id}`);
    await redis.lrem('axa:invoices', 0, req.params.id);
    req.session.success = 'Data berhasil dihapus secara permanen.';
  } catch(err) {
    req.session.error = 'Gagal menghapus data.';
  }
  
  // Smart Redirect: Cek dari mana request delete ini berasal (Dashboard vs Receipts vs Invoices)
  const referer = req.get('Referrer');
  if (referer && referer.includes('/dashboard')) {
    res.redirect('/dashboard');
  } else if (referer && referer.includes('/receipts')) {
    res.redirect('/receipts');
  } else {
    res.redirect('/invoices');
  }
});

// GET DETAIL INVOICE
app.get('/invoices/:id', requireAuth, async (req, res) => {
  try {
    let invoice = await redis.get(`axa:invoice:${req.params.id}`);
    if (!invoice) return res.status(404).send('Invoice Not Found');
    invoice = checkOverdue(invoice);
    const customer = await redis.get(`axa:customer:${invoice.customerId}`);
    res.render('invoice-detail', { invoice, customer });
  } catch (error) { res.redirect('/invoices'); }
});

app.post('/invoices/:id/issue', requireAuth, async (req, res) => {
  try {
    const invoice = await redis.get(`axa:invoice:${req.params.id}`);
    if (invoice && invoice.status === 'DRAFT') {
      invoice.status = 'UNPAID';
      await redis.set(`axa:invoice:${req.params.id}`, invoice);
      req.session.success = 'Invoice diterbitkan.';
    }
  } catch (err) {}
  res.redirect(`/invoices/${req.params.id}`);
});

app.post('/invoices/:id/payment', requireAuth, async (req, res) => {
  try {
    const invoice = await redis.get(`axa:invoice:${req.params.id}`);
    const amount = parseInt(req.body.amount);
    if (amount <= 0 || amount > invoice.balance) return res.redirect(`/invoices/${req.params.id}`);

    const payment = { id: `PAY-${Date.now()}`, amount, method: req.body.method, reference: req.body.reference, paidAt: new Date().toISOString() };
    invoice.payments.push(payment);
    invoice.amountPaid += amount;
    invoice.balance = invoice.total - invoice.amountPaid;
    if (invoice.balance === 0) invoice.status = 'PAID';
    else invoice.status = 'PARTIALLY_PAID';

    await redis.set(`axa:invoice:${req.params.id}`, invoice);
    req.session.success = 'Pembayaran dicatat.';
  } catch(err) { req.session.error = 'Gagal mencatat pembayaran.'; }
  res.redirect(`/invoices/${req.params.id}`);
});

app.get('/invoices/:id/print', requireAuth, async (req, res) => {
  try {
    const invoice = await redis.get(`axa:invoice:${req.params.id}`);
    const customer = await redis.get(`axa:customer:${invoice.customerId}`);
    res.render('invoice-print', { invoice, customer });
  } catch (err) { res.send('Error memuat print out.'); }
});

app.get('/invoices/:id/receipt', requireAuth, async (req, res) => {
  try {
    const invoice = await redis.get(`axa:invoice:${req.params.id}`);
    if (invoice.status !== 'PAID') return res.redirect(`/invoices/${req.params.id}`);
    const customer = await redis.get(`axa:customer:${invoice.customerId}`);
    res.render('receipt-print', { invoice, customer });
  } catch (err) { res.send('Error memuat kuitansi.'); }
});

// ==========================================
// 8. PUBLIC INVOICE & RECEIPT LINKS
// ==========================================
app.get('/invoice/:publicId', async (req, res) => {
  try {
    const ids = await redis.lrange('axa:invoices', 0, -1);
    let invoices = ids.length ? await Promise.all(ids.map(id => redis.get(`axa:invoice:${id}`))) : [];
    let invoice = invoices.find(i => i && i.publicId === req.params.publicId);
    if (!invoice) return res.status(404).render('login', { error: 'Invoice Not Found' });
    
    invoice = checkOverdue(invoice);
    const customer = await redis.get(`axa:customer:${invoice.customerId}`);
    res.render('invoice-public', { invoice, customer });
  } catch (err) { res.status(500).send('Terjadi kesalahan muat public invoice.'); }
});

app.get('/invoice/:publicId/print', async (req, res) => {
  try {
    const ids = await redis.lrange('axa:invoices', 0, -1);
    let invoices = ids.length ? await Promise.all(ids.map(id => redis.get(`axa:invoice:${id}`))) : [];
    let invoice = invoices.find(i => i && i.publicId === req.params.publicId);
    if (!invoice) return res.status(404).send('Invoice Not Found');
    
    const customer = await redis.get(`axa:customer:${invoice.customerId}`);
    res.render('invoice-print', { invoice, customer });
  } catch (err) { res.status(500).send('Terjadi kesalahan muat public invoice print.'); }
});

app.get('/receipt/:publicId', async (req, res) => {
  try {
    const ids = await redis.lrange('axa:invoices', 0, -1);
    let invoices = ids.length ? await Promise.all(ids.map(id => redis.get(`axa:invoice:${id}`))) : [];
    let invoice = invoices.find(i => i && i.publicId === req.params.publicId);
    if (!invoice || invoice.status !== 'PAID') return res.status(404).send('Kuitansi belum tersedia atau belum lunas.');
    
    const customer = await redis.get(`axa:customer:${invoice.customerId}`);
    res.render('receipt-public', { invoice, customer });
  } catch (err) { res.status(500).send('Terjadi kesalahan muat kuitansi public.'); }
});

// ==========================================
// 9. RECEIPTS (ADMIN)
// ==========================================
app.get('/receipts', requireAuth, async (req, res) => {
  try {
    const ids = await redis.lrange('axa:invoices', 0, -1);
    let invoices = ids.length ? await Promise.all(ids.map(id => redis.get(`axa:invoice:${id}`))) : [];
    
    for(let inv of invoices) {
      if(inv) {
          const cus = await redis.get(`axa:customer:${inv.customerId}`);
          inv.customerName = cus ? cus.companyName : 'Unknown';
      }
    }
    
    res.render('receipt', { receipts: invoices.filter(i=>i).sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt)) });
  } catch (error) { 
    res.render('receipt', { receipts: [], error: 'Gagal memuat data kuitansi.' }); 
  }
});

app.get('/invoices/:id/receipt/detail', requireAuth, async (req, res) => {
  try {
    const invoice = await redis.get(`axa:invoice:${req.params.id}`);
    if (!invoice || (invoice.status !== 'PAID' && invoice.amountPaid <= 0)) {
        return res.redirect('/receipts');
    }
    const customer = await redis.get(`axa:customer:${invoice.customerId}`);
    res.render('receipt-detail', { invoice, customer });
  } catch (err) { 
    res.redirect('/receipts'); 
  }
});

// ==========================================
// 10. SETTINGS & ERROR
// ==========================================
app.get('/settings', requireAuth, (req, res) => res.render('settings'));
app.post('/settings', requireAuth, async (req, res) => {
  try {
    const settings = { ...res.locals.settings, ...req.body };
    await redis.set('axa:settings', settings);
    req.session.success = 'Settings disimpan.';
  } catch (err) { req.session.error = 'Gagal menyimpan pengaturan.'; }
  res.redirect('/settings');
});

app.use((err, req, res, next) => {
  console.error('🔥 FATAL SERVER ERROR:', err.stack);
  res.status(500).send('Terjadi kesalahan pada server. Silakan cek Application Logs di Vercel (COBA CEK ENV MASUKKAN ADMIN_USER, ADMIN_PASS & UPTASH REDIS KV.');
});

module.exports = app;
if (require.main === module) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`AXA XYZ Invoice running on port ${port}`));
}
