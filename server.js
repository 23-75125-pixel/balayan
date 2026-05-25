import express from 'express';
import multer from 'multer';
import dotenv from 'dotenv';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { SQLiteStore } from './sqlite-store.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 8000);
const SQLITE_DB_PATH = process.env.SQLITE_DB_PATH || path.join(__dirname, 'data', 'bsh.sqlite');
const SEED_SQLITE_DB_PATH = path.join(__dirname, 'data', 'bsh.sqlite');
const UPLOAD_BUCKET_NAME = process.env.UPLOAD_BUCKET_NAME || 'product-images';
const UPLOAD_ROOT = process.env.UPLOAD_DIR || path.join(__dirname, 'public', 'uploads');
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES || 5 * 1024 * 1024);
const ALLOWED_TABLES = new Set([
  'profiles',
  'products',
  'categories',
  'subcategories',
  'orders',
  'order_items',
  'customer_bag_items',
  'customer_favorites',
  'crm_contacts',
  'audit_logs'
]);

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 }
});
const store = new SQLiteStore({
  dbPath: SQLITE_DB_PATH,
  seedDbPath: SEED_SQLITE_DB_PATH,
  uploadDir: UPLOAD_ROOT,
  bucketName: UPLOAD_BUCKET_NAME
});

app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true }));
app.disable('x-powered-by');
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Cache-Control', 'no-store');
  next();
});

function asyncHandler(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function bearerToken(req) {
  const header = req.headers.authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7) : '';
}

function responseFromResult(result) {
  return result?.error
    ? { data: null, error: { message: result.error.message || 'Request failed' } }
    : { data: result?.data ?? null, error: null };
}

function parseFilters(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;

  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function getSingleMode(source = {}) {
  return source.singleMode || (String(source.single ?? 'false') === 'true' ? 'single' : '');
}

function sanitizeRelativePath(value) {
  const cleaned = String(value || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const normalized = path.posix.normalize(cleaned);
  if (!cleaned || normalized === '.' || normalized.startsWith('../') || path.posix.isAbsolute(normalized)) {
    return '';
  }
  return normalized;
}

function sanitizeBucket(value) {
  return String(value || '').replace(/[^a-zA-Z0-9_-]/g, '');
}

async function getRequestUser(req) {
  const token = bearerToken(req);
  if (!token) return null;
  return store.getUserByToken(token);
}

function canPublicRead(table) {
  return table === 'products' || table === 'categories' || table === 'subcategories';
}

function requireAuth(res, auth) {
  if (auth?.user) return true;
  res.status(401).json({ data: null, error: { message: 'Not authenticated' } });
  return false;
}

function canReadTable(auth, table, filters) {
  if (canPublicRead(table)) return true;
  return store.isAllowedTableRead(auth, table, filters);
}

function canWriteTable(auth, table, operation, payload, filters) {
  return store.isAllowedTableWrite(auth, table, operation, payload, filters);
}

app.get('/config/runtime-config.js', (_req, res) => {
  res.type('application/javascript').send(
    `window.BSH_APP_CONFIG = ${JSON.stringify({ apiBaseUrl: '', productImageBucket: UPLOAD_BUCKET_NAME })};`
  );
});

app.use('/uploads', express.static(UPLOAD_ROOT));
app.use('/assets', express.static(path.join(__dirname, 'assets')));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/auth/me', asyncHandler(async (req, res) => {
  const auth = await getRequestUser(req);

  if (!auth?.user) {
    return res.status(401).json({ data: { user: null, profile: null }, error: { message: 'Not authenticated' } });
  }

  return res.json({ data: { user: auth.user, profile: auth.profile || null }, error: null });
}));

app.post('/api/auth/sign-in', asyncHandler(async (req, res) => {
  const { email, password } = req.body || {};
  const result = store.signIn({ email, password });
  res.status(result.error ? 400 : 200).json(responseFromResult(result));
}));

app.post('/api/auth/sign-up', asyncHandler(async (req, res) => {
  const { email, password, options } = req.body || {};
  const result = store.createUser({ email, password, options });
  res.status(result.error ? 400 : 200).json(responseFromResult(result));
}));

app.post('/api/auth/sign-out', asyncHandler(async (req, res) => {
  const result = store.signOut(bearerToken(req));
  res.json(responseFromResult(result));
}));

app.post('/api/auth/update-password', asyncHandler(async (req, res) => {
  const auth = await getRequestUser(req);
  if (!auth?.user) return res.status(401).json({ data: null, error: { message: 'Not authenticated' } });

  const { password } = req.body || {};
  const result = store.updatePassword(bearerToken(req), password);
  res.status(result.error ? 400 : 200).json(responseFromResult(result));
}));

app.get('/api/db/:table', asyncHandler(async (req, res) => {
  const { table } = req.params;
  if (!ALLOWED_TABLES.has(table)) return res.status(404).json({ data: null, error: { message: 'Unknown table' } });

  const auth = await getRequestUser(req);
  const filters = parseFilters(req.query.filters);

  if (!canReadTable(auth, table, filters)) {
    return res.status(auth?.user ? 403 : 401).json({ data: null, error: { message: 'Not authorized' } });
  }

  const result = store.select(table, {
    select: req.query.select || '*',
    filters,
    order: req.query.order || '',
    ascending: String(req.query.ascending ?? 'true') !== 'false',
    limit: req.query.limit ? Number(req.query.limit) : null,
    singleMode: getSingleMode(req.query)
  });

  res.status(result.error ? 400 : 200).json(responseFromResult(result));
}));

app.post('/api/db/:table', asyncHandler(async (req, res) => {
  const { table } = req.params;
  if (!ALLOWED_TABLES.has(table)) return res.status(404).json({ data: null, error: { message: 'Unknown table' } });

  const auth = await getRequestUser(req);
  const { data, upsert = false, filters = [], onConflict = '' } = req.body || {};

  if (!requireAuth(res, auth)) return;
  if (!canWriteTable(auth, table, upsert ? 'upsert' : 'insert', data, filters)) {
    return res.status(403).json({ data: null, error: { message: 'Not authorized' } });
  }

  const result = store.insert(table, {
    data,
    upsert,
    onConflict,
    singleMode: getSingleMode(req.body)
  });

  res.status(result.error ? 400 : 200).json(responseFromResult(result));
}));

app.patch('/api/db/:table', asyncHandler(async (req, res) => {
  const { table } = req.params;
  if (!ALLOWED_TABLES.has(table)) return res.status(404).json({ data: null, error: { message: 'Unknown table' } });

  const auth = await getRequestUser(req);
  const { data, filters = [] } = req.body || {};

  if (!requireAuth(res, auth)) return;
  if (!canWriteTable(auth, table, 'update', data, filters)) {
    return res.status(403).json({ data: null, error: { message: 'Not authorized' } });
  }

  const result = store.update(table, {
    data,
    filters,
    singleMode: getSingleMode(req.body)
  });

  res.status(result.error ? 400 : 200).json(responseFromResult(result));
}));

app.delete('/api/db/:table', asyncHandler(async (req, res) => {
  const { table } = req.params;
  if (!ALLOWED_TABLES.has(table)) return res.status(404).json({ data: null, error: { message: 'Unknown table' } });

  const auth = await getRequestUser(req);
  const { filters = [] } = req.body || {};

  if (!requireAuth(res, auth)) return;
  if (!canWriteTable(auth, table, 'delete', null, filters)) {
    return res.status(403).json({ data: null, error: { message: 'Not authorized' } });
  }

  const result = store.delete(table, {
    filters,
    singleMode: getSingleMode(req.body)
  });

  res.status(result.error ? 400 : 200).json(responseFromResult(result));
}));

app.post('/api/checkout', asyncHandler(async (req, res) => {
  const auth = await getRequestUser(req);
  if (!auth?.user) return res.status(401).json({ data: null, error: { message: 'Not authenticated' } });

  const result = store.createCheckoutOrder(auth, req.body?.items || [], {
    paymentMethod: req.body?.paymentMethod || 'cash_on_delivery',
    customerName: req.body?.customerName || '',
    customerPhone: req.body?.customerPhone || '',
    deliveryLocation: req.body?.deliveryLocation || '',
    deliveryNotes: req.body?.deliveryNotes || ''
  });
  res.status(result.error ? 400 : 200).json(responseFromResult(result));
}));

app.post('/api/storage/:bucket/upload', upload.single('file'), asyncHandler(async (req, res) => {
  const auth = await getRequestUser(req);
  if (!auth?.user) return res.status(401).json({ data: null, error: { message: 'Not authenticated' } });
  if (!store.isAdmin(auth.profile)) return res.status(403).json({ data: null, error: { message: 'Not authorized' } });

  const { bucket } = req.params;
  const uploadPath = sanitizeRelativePath(req.body.path);
  const safeBucket = sanitizeBucket(bucket);
  if (!safeBucket || !uploadPath) return res.status(400).json({ data: null, error: { message: 'Invalid upload path' } });
  if (!req.file) return res.status(400).json({ data: null, error: { message: 'Missing file' } });
  if (!String(req.file.mimetype || '').startsWith('image/')) {
    return res.status(400).json({ data: null, error: { message: 'Only image uploads are allowed' } });
  }

  const targetDir = path.join(UPLOAD_ROOT, safeBucket, path.dirname(uploadPath));
  const targetFile = path.join(UPLOAD_ROOT, safeBucket, uploadPath);
  const root = path.resolve(UPLOAD_ROOT, safeBucket);
  const resolvedTarget = path.resolve(targetFile);

  if (!resolvedTarget.startsWith(`${root}${path.sep}`)) {
    return res.status(400).json({ data: null, error: { message: 'Invalid upload path' } });
  }

  await fs.mkdir(targetDir, { recursive: true });
  await fs.writeFile(targetFile, req.file.buffer);

  const publicUrl = `/uploads/${safeBucket}/${uploadPath}`;
  res.json({ data: { path: uploadPath, publicUrl }, error: null });
}));

app.delete('/api/storage/:bucket/remove', asyncHandler(async (req, res) => {
  const auth = await getRequestUser(req);
  if (!auth?.user) return res.status(401).json({ data: null, error: { message: 'Not authenticated' } });
  if (!store.isAdmin(auth.profile)) return res.status(403).json({ data: null, error: { message: 'Not authorized' } });

  const { bucket } = req.params;
  const { paths = [] } = req.body || {};
  const safeBucket = sanitizeBucket(bucket);
  if (!safeBucket || !Array.isArray(paths)) return res.status(400).json({ data: null, error: { message: 'Invalid remove request' } });
  const deleted = [];
  const root = path.resolve(UPLOAD_ROOT, safeBucket);

  for (const itemPath of paths) {
    const cleaned = sanitizeRelativePath(itemPath);
    if (!cleaned) continue;
    const target = path.join(UPLOAD_ROOT, safeBucket, cleaned);
    const resolvedTarget = path.resolve(target);
    if (!resolvedTarget.startsWith(`${root}${path.sep}`)) continue;
    try {
      await fs.unlink(target);
      deleted.push(cleaned);
    } catch {
      // ignore missing files
    }
  }

  res.json({ data: { deleted }, error: null });
}));

app.use((error, _req, res, _next) => {
  if (error instanceof multer.MulterError) {
    return res.status(400).json({ data: null, error: { message: error.code === 'LIMIT_FILE_SIZE' ? 'Uploaded file is too large' : 'Invalid upload' } });
  }

  console.error(error);
  return res.status(500).json({ data: null, error: { message: 'Internal server error' } });
});

await store.init();

const server = app.listen(PORT, () => {
  const publicUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
  console.log(`Balayan Smashers Hub running on ${publicUrl}`);
});

server.on('error', error => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Set PORT to another value and restart the server.`);
  } else {
    console.error(error);
  }
  store.close();
  process.exit(1);
});

process.on('SIGINT', () => {
  server.close();
  store.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  server.close();
  store.close();
  process.exit(0);
});
