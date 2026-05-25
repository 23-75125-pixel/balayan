import Database from 'better-sqlite3';
import crypto from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';

const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const JSON_COLUMNS = new Map([
  ['profiles', new Set(['raw_user_meta_data'])],
  ['products', new Set(['gallery_image_urls', 'gallery_image_paths'])],
  ['audit_logs', new Set(['details'])],
  ['users', new Set(['raw_user_meta_data'])]
]);

const CATEGORIES = [
  ['Sports', 'sports', 1],
  ['Apparel', 'apparel', 2],
  ['Jersey', 'jersey', 3],
  ['Equipments', 'equipments', 4],
  ['Accessories', 'accessories', 5]
];

const SUBCATEGORIES = [
  ['sports', 'Badminton', 'badminton', 1],
  ['sports', 'Volleyball', 'volleyball', 2],
  ['sports', 'Basketball', 'basketball', 3],
  ['sports', 'Tennis', 'tennis', 4],
  ['sports', 'Archery', 'archery', 5],
  ['sports', 'Water Sport', 'watersport', 6],
  ['sports', 'Pickleball', 'pickleball', 7],
  ['sports', 'Martial Arts', 'martialarts', 8],
  ['sports', 'Boxing', 'boxing', 9],
  ['sports', 'Billiards', 'billiards', 10],
  ['apparel', 'T-Shirts', 't-shirts', 1],
  ['apparel', 'Shorts', 'shorts', 2],
  ['apparel', 'Boxers', 'boxers', 3],
  ['apparel', 'Briefs', 'briefs', 4],
  ['apparel', 'Sports Bra', 'sports-bra', 5],
  ['apparel', 'Socks', 'socks', 6],
  ['apparel', 'Cap', 'cap', 7],
  ['jersey', 'Basketball Jersey', 'basketball-jersey', 1],
  ['jersey', 'Volleyball Jersey', 'volleyball-jersey', 2],
  ['jersey', 'Badminton Jersey', 'badminton-jersey', 3],
  ['jersey', 'Custom Jersey', 'custom-jersey', 4],
  ['equipments', 'Rackets', 'rackets', 1],
  ['equipments', 'Balls', 'balls', 2],
  ['equipments', 'Nets', 'nets', 3],
  ['equipments', 'Training Gear', 'training-gear', 4],
  ['accessories', 'Bags', 'bags', 1],
  ['accessories', 'Grip Tape', 'grip-tape', 2],
  ['accessories', 'Water Bottles', 'water-bottles', 3],
  ['accessories', 'Wristbands', 'wristbands', 4]
];

const ID_TABLES = new Set([
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

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function quoteIdentifier(name) {
  if (!SAFE_IDENTIFIER.test(String(name))) {
    throw new Error(`Invalid identifier: ${name}`);
  }

  return `"${name}"`;
}

function parseMaybeJson(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  if (Array.isArray(value) || isObject(value)) return value;

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return fallback;

    try {
      return JSON.parse(trimmed);
    } catch {
      return fallback;
    }
  }

  return fallback;
}

function ensureJson(value) {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value) || isObject(value)) return JSON.stringify(value);
  return value;
}

function asBoolean(value) {
  return value === true || value === 1 || value === '1' || value === 'true';
}

function ownFilterValue(filters, field) {
  const match = filters.find(item => item?.field === field && (item.op || 'eq') === 'eq');
  return match?.value ?? null;
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || ''));
}

function passwordValidationError(password) {
  if (typeof password !== 'string') return 'Password is required';
  if (password.length < 8) return 'Password must be at least 8 characters';
  if (password.length > 1024) return 'Password is too long';
  return '';
}

async function copySqliteBundle(sourceDbPath, targetDbPath) {
  await fs.mkdir(path.dirname(targetDbPath), { recursive: true });
  await fs.copyFile(sourceDbPath, targetDbPath);

  for (const suffix of ['-wal', '-shm']) {
    const sourceSidecar = `${sourceDbPath}${suffix}`;
    const targetSidecar = `${targetDbPath}${suffix}`;
    try {
      await fs.copyFile(sourceSidecar, targetSidecar);
    } catch {
      // The sidecar file may not exist, and that's fine.
    }
  }
}

export class SQLiteStore {
  constructor({ dbPath, seedDbPath, uploadDir, bucketName }) {
    this.dbPath = dbPath;
    this.seedDbPath = seedDbPath;
    this.uploadDir = uploadDir;
    this.bucketName = bucketName;
    this.db = null;
  }

  async init() {
    await fs.mkdir(path.dirname(this.dbPath), { recursive: true });
    await fs.mkdir(this.uploadDir, { recursive: true });

    if (this.seedDbPath && path.resolve(this.seedDbPath) !== path.resolve(this.dbPath)) {
      try {
        const targetStats = await fs.stat(this.dbPath);
        const seedStats = await fs.stat(this.seedDbPath);
        if (targetStats.size === 0 && seedStats.size > 0) {
          await copySqliteBundle(this.seedDbPath, this.dbPath);
        }
      } catch {
        try {
          await fs.access(this.dbPath);
        } catch {
          try {
            await copySqliteBundle(this.seedDbPath, this.dbPath);
          } catch {
            // Fall back to schema creation below if the seed DB is unavailable.
          }
        }
      }
    }

    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(this.schemaSql());
    this.ensureSchemaColumns();

    const needsBootstrap = this.db.prepare('SELECT COUNT(*) AS count FROM products').get().count === 0
      && this.db.prepare('SELECT COUNT(*) AS count FROM users').get().count === 0;

    if (needsBootstrap) {
      this.seedBaseData();
    }
  }

  close() {
    this.db?.close();
    this.db = null;
  }

  schemaSql() {
    return `
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        raw_user_meta_data TEXT NOT NULL DEFAULT '{}',
        confirmed_at TEXT,
        created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
        updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
      );

      CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
        expires_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS profiles (
        id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        email TEXT UNIQUE,
        first_name TEXT,
        last_name TEXT,
        date_of_birth TEXT,
        role TEXT NOT NULL DEFAULT 'customer' CHECK (role IN ('customer', 'admin')),
        created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
        updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
      );

      CREATE TABLE IF NOT EXISTS products (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        category TEXT NOT NULL,
        subcategory TEXT,
        price REAL NOT NULL DEFAULT 0 CHECK (price >= 0),
        original_price REAL,
        badge TEXT,
        description TEXT,
        brand TEXT,
        sku TEXT,
        barcode TEXT UNIQUE,
        gender TEXT,
        size TEXT,
        color TEXT,
        variant_note TEXT,
        rating REAL NOT NULL DEFAULT 4.8,
        reviews INTEGER NOT NULL DEFAULT 0,
        stock INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'draft', 'out_of_stock')),
        featured INTEGER NOT NULL DEFAULT 0,
        image_url TEXT NOT NULL,
        image_path TEXT,
        gallery_image_urls TEXT NOT NULL DEFAULT '[]',
        gallery_image_paths TEXT NOT NULL DEFAULT '[]',
        created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
        updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
      );

      CREATE TABLE IF NOT EXISTS categories (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT NOT NULL UNIQUE,
        sort_order INTEGER NOT NULL DEFAULT 0,
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
        updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
      );

      CREATE TABLE IF NOT EXISTS subcategories (
        id TEXT PRIMARY KEY,
        category_id TEXT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        slug TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
        updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
        UNIQUE (category_id, slug)
      );

      CREATE TABLE IF NOT EXISTS orders (
        id TEXT PRIMARY KEY,
        user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        customer_email TEXT,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'cancelled')),
        payment_method TEXT NOT NULL DEFAULT 'cash_on_delivery',
        payment_status TEXT NOT NULL DEFAULT 'pending' CHECK (payment_status IN ('pending', 'paid', 'failed', 'refunded')),
        payment_reference TEXT,
        total_amount REAL NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
        updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
      );

      CREATE TABLE IF NOT EXISTS order_items (
        id TEXT PRIMARY KEY,
        order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        product_id TEXT REFERENCES products(id) ON DELETE SET NULL,
        product_name TEXT NOT NULL,
        quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
        price REAL NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
        updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
      );

      CREATE TABLE IF NOT EXISTS customer_bag_items (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        product_id TEXT NOT NULL,
        product_name TEXT NOT NULL,
        category TEXT,
        image_url TEXT,
        price REAL NOT NULL DEFAULT 0,
        quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
        created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
        updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
        UNIQUE (user_id, product_id)
      );

      CREATE TABLE IF NOT EXISTS customer_favorites (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        product_id TEXT NOT NULL,
        product_name TEXT NOT NULL,
        category TEXT,
        image_url TEXT,
        price REAL NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
        updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
        UNIQUE (user_id, product_id)
      );

      CREATE TABLE IF NOT EXISTS crm_contacts (
        id TEXT PRIMARY KEY,
        user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        email TEXT NOT NULL UNIQUE,
        full_name TEXT,
        phone TEXT,
        status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'active', 'vip', 'follow_up', 'inactive')),
        source TEXT NOT NULL DEFAULT 'storefront',
        notes TEXT,
        last_contacted_at TEXT,
        created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
        updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
      );

      CREATE TABLE IF NOT EXISTS audit_logs (
        id TEXT PRIMARY KEY,
        admin_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        admin_email TEXT,
        action TEXT NOT NULL,
        table_name TEXT,
        record_id TEXT,
        details TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
      );

      CREATE INDEX IF NOT EXISTS idx_profiles_email ON profiles(email);
      CREATE INDEX IF NOT EXISTS idx_products_category ON products(category);
      CREATE INDEX IF NOT EXISTS idx_products_status ON products(status);
      CREATE INDEX IF NOT EXISTS idx_orders_user_id ON orders(user_id);
      CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON order_items(order_id);
      CREATE INDEX IF NOT EXISTS idx_bag_user_id ON customer_bag_items(user_id);
      CREATE INDEX IF NOT EXISTS idx_favorites_user_id ON customer_favorites(user_id);
      CREATE INDEX IF NOT EXISTS idx_crm_contacts_email ON crm_contacts(email);
      CREATE INDEX IF NOT EXISTS idx_crm_contacts_user_id ON crm_contacts(user_id);
      CREATE INDEX IF NOT EXISTS idx_crm_contacts_status ON crm_contacts(status);
      CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
    `;
  }

  ensureSchemaColumns() {
    const addColumnIfMissing = (table, column, definition) => {
      const columns = this.db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all();
      if (columns.some(item => item.name === column)) return;
      this.db.prepare(`ALTER TABLE ${quoteIdentifier(table)} ADD COLUMN ${quoteIdentifier(column)} ${definition}`).run();
    };

    addColumnIfMissing('orders', 'payment_method', `TEXT NOT NULL DEFAULT 'cash_on_delivery'`);
    addColumnIfMissing('orders', 'payment_status', `TEXT NOT NULL DEFAULT 'pending'`);
    addColumnIfMissing('orders', 'payment_reference', 'TEXT');
  }

  seedBaseData() {
    const upsertCategory = this.db.prepare(`
      INSERT INTO categories (id, name, slug, sort_order, is_active, created_at, updated_at)
      VALUES (?, ?, ?, ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT(slug) DO UPDATE SET
        name = excluded.name,
        sort_order = excluded.sort_order,
        is_active = 1,
        updated_at = CURRENT_TIMESTAMP
    `);

    const upsertSubcategory = this.db.prepare(`
      INSERT INTO subcategories (id, category_id, name, slug, sort_order, is_active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT(category_id, slug) DO UPDATE SET
        name = excluded.name,
        sort_order = excluded.sort_order,
        is_active = 1,
        updated_at = CURRENT_TIMESTAMP
    `);

    const categoryIds = new Map();
    const categoryTx = this.db.transaction(() => {
      for (const [name, slug, sortOrder] of CATEGORIES) {
        const id = `cat_${slug}`;
        categoryIds.set(slug, id);
        upsertCategory.run(id, name, slug, sortOrder);
      }
    });

    const subcategoryTx = this.db.transaction(() => {
      for (const [categorySlug, name, slug, sortOrder] of SUBCATEGORIES) {
        const categoryId = categoryIds.get(categorySlug);
        if (!categoryId) continue;
        upsertSubcategory.run(`sub_${categorySlug}_${slug}`, categoryId, name, slug, sortOrder);
      }
    });

    categoryTx();
    subcategoryTx();
  }

  nowIso() {
    return new Date().toISOString();
  }

  hashPassword(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const iterations = 120000;
    const derived = crypto.pbkdf2Sync(String(password), salt, iterations, 64, 'sha512').toString('hex');
    return `pbkdf2$${iterations}$${salt}$${derived}`;
  }

  verifyPassword(password, storedHash) {
    try {
      const parts = String(storedHash || '').split('$');
      if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;

      const iterations = Number(parts[1] || 0);
      const salt = parts[2];
      const expected = parts[3] || '';
      if (!iterations || !salt || !expected || !/^[a-f0-9]+$/i.test(expected)) return false;

      const actual = crypto.pbkdf2Sync(String(password), salt, iterations, 64, 'sha512').toString('hex');
      const actualBuffer = Buffer.from(actual, 'hex');
      const expectedBuffer = Buffer.from(expected, 'hex');
      if (actualBuffer.length !== expectedBuffer.length) return false;

      return crypto.timingSafeEqual(actualBuffer, expectedBuffer);
    } catch {
      return false;
    }
  }

  createToken() {
    return crypto.randomBytes(32).toString('hex');
  }

  isAdmin(profile) {
    return profile?.role === 'admin';
  }

  getSession(token) {
    if (!token) return null;

    const row = this.db.prepare(`
      SELECT s.token, s.user_id, s.created_at, s.expires_at, u.email, u.raw_user_meta_data
      FROM sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.token = ? AND datetime(s.expires_at) > datetime('now')
    `).get(token);

    if (!row) return null;

    const profile = this.db.prepare('SELECT * FROM profiles WHERE id = ?').get(row.user_id);

    return {
      token: row.token,
      user: this.normalizeAuthUser({
        id: row.user_id,
        email: row.email,
        raw_user_meta_data: row.raw_user_meta_data,
        created_at: row.created_at
      }),
      profile: this.normalizeRow('profiles', profile),
      session: this.normalizeSessionRow({ token: row.token, user_id: row.user_id, created_at: row.created_at, expires_at: row.expires_at })
    };
  }

  normalizeAuthUser(row) {
    if (!row) return null;

    return {
      id: row.id,
      email: row.email,
      user_metadata: parseMaybeJson(row.raw_user_meta_data, {}),
      created_at: row.created_at || this.nowIso()
    };
  }

  normalizeSessionRow(row) {
    if (!row) return null;

    const expiresIn = Math.max(0, Math.round((new Date(row.expires_at).getTime() - Date.now()) / 1000));

    return {
      access_token: row.token,
      token_type: 'bearer',
      expires_in: expiresIn,
      expires_at: row.expires_at,
      user: null
    };
  }

  normalizeRow(table, row) {
    if (!row) return null;

    const normalized = { ...row };

    if (table === 'products') {
      const galleryUrls = parseMaybeJson(normalized.gallery_image_urls, []);
      const galleryPaths = parseMaybeJson(normalized.gallery_image_paths, []);
      const coverImage = normalized.image_url || galleryUrls[0] || 'photos/bshlogo.png';
      const coverPath = normalized.image_path || galleryPaths[0] || null;

      normalized.featured = asBoolean(normalized.featured);
      normalized.gallery_image_urls = Array.isArray(galleryUrls) ? galleryUrls : [];
      normalized.gallery_images = normalized.gallery_image_urls.length ? normalized.gallery_image_urls : [coverImage];
      normalized.gallery_image_paths = Array.isArray(galleryPaths) ? galleryPaths : [];
      normalized.image = coverImage;
      normalized.image_url = coverImage;
      normalized.image_path = coverPath;
      normalized.price = Number(normalized.price || 0);
      normalized.original_price = normalized.original_price === null || normalized.original_price === undefined || normalized.original_price === ''
        ? null
        : Number(normalized.original_price);
      normalized.rating = normalized.rating === null || normalized.rating === undefined || normalized.rating === ''
        ? 4.8
        : Number(normalized.rating);
      normalized.reviews = normalized.reviews === null || normalized.reviews === undefined || normalized.reviews === ''
        ? 0
        : Number(normalized.reviews);
      normalized.stock = Number(normalized.stock || 0);
      normalized.gender = normalized.gender || '';
      normalized.size = normalized.size || '';
      normalized.color = normalized.color || '';
      normalized.brand = normalized.brand || '';
      normalized.sku = normalized.sku || '';
      normalized.status = normalized.status || 'active';
      normalized.variant_note = normalized.variant_note || '';
    }

    if ('details' in normalized) {
      normalized.details = parseMaybeJson(normalized.details, {});
    }

    if ('featured' in normalized) {
      normalized.featured = asBoolean(normalized.featured);
    }

    if ('is_active' in normalized) {
      normalized.is_active = asBoolean(normalized.is_active);
    }

    if ('role' in normalized && normalized.role === null) {
      normalized.role = 'customer';
    }

    return normalized;
  }

  normalizeRows(table, rows) {
    return rows.map(row => this.normalizeRow(table, row));
  }

  serializeRow(table, row) {
    const payload = {};
    const jsonCols = JSON_COLUMNS.get(table) || new Set();

    Object.entries(row || {}).forEach(([key, value]) => {
      if (value === undefined) return;
      if (jsonCols.has(key)) {
        payload[key] = ensureJson(value) ?? '{}';
        return;
      }
      if (typeof value === 'boolean') {
        payload[key] = value ? 1 : 0;
        return;
      }
      if (Array.isArray(value) || isObject(value)) {
        payload[key] = JSON.stringify(value);
        return;
      }
      payload[key] = value;
    });

    return payload;
  }

  knownColumns(table) {
    return new Set(this.db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all().map(column => column.name));
  }

  validateColumns(table, payload) {
    const known = this.knownColumns(table);
    const unknown = Object.keys(payload || {}).filter(key => !known.has(key));
    if (unknown.length) {
      throw new Error(`Unknown column${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}`);
    }
  }

  publicError(error) {
    const message = error?.message || 'Request failed';
    if (/UNIQUE constraint failed/i.test(message)) return { message: 'A matching record already exists' };
    if (/FOREIGN KEY constraint failed/i.test(message)) return { message: 'Related record was not found' };
    if (/CHECK constraint failed/i.test(message)) return { message: 'Submitted data failed validation' };
    if (/NOT NULL constraint failed/i.test(message)) return { message: 'Missing required field' };
    if (/not available|insufficient stock|not found|Unsupported payment method|Not authenticated/i.test(message)) return { message };
    if (/Invalid identifier|Unknown column|No data provided|Refusing to run/i.test(message)) return { message };
    return { message: 'Request failed' };
  }

  buildWhere(filters = []) {
    const clauses = [];
    const params = [];

    for (const filter of filters || []) {
      if (!filter || !filter.field) continue;
      const field = quoteIdentifier(filter.field);
      const op = filter.op || 'eq';
      const value = filter.value;

      if (op === 'in' && Array.isArray(value) && value.length) {
        clauses.push(`${field} IN (${value.map(() => '?').join(', ')})`);
        params.push(...value);
        continue;
      }

      if (op === 'neq') {
        clauses.push(`${field} <> ?`);
        params.push(value);
        continue;
      }

      if (op === 'gte') {
        clauses.push(`${field} >= ?`);
        params.push(value);
        continue;
      }

      if (op === 'lte') {
        clauses.push(`${field} <= ?`);
        params.push(value);
        continue;
      }

      if (op === 'ilike') {
        clauses.push(`LOWER(${field}) LIKE LOWER(?)`);
        params.push(String(value ?? ''));
        continue;
      }

      if (op === 'contains') {
        clauses.push(`${field} LIKE ?`);
        params.push(`%${String(value ?? '')}%`);
        continue;
      }

      clauses.push(`${field} = ?`);
      params.push(value);
    }

    return {
      sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '',
      params
    };
  }

  buildOrder(orderField, ascending = true) {
    if (!orderField) return '';
    return `ORDER BY ${quoteIdentifier(orderField)} ${ascending ? 'ASC' : 'DESC'}`;
  }

  buildSelectColumns(select) {
    const raw = String(select || '*').trim();
    if (!raw || raw === '*') return '*';

    return raw
      .split(',')
      .map(item => item.trim())
      .filter(Boolean)
      .map(quoteIdentifier)
      .join(', ');
  }

  select(table, { select = '*', filters = [], order = '', ascending = true, limit = null, singleMode = '' } = {}) {
    try {
      const columns = this.buildSelectColumns(select);
      const where = this.buildWhere(filters);
      const orderSql = this.buildOrder(order, ascending);
      const limitSql = Number.isFinite(Number(limit)) && Number(limit) > 0 ? `LIMIT ${Number(limit)}` : '';
      const sql = `SELECT ${columns} FROM ${quoteIdentifier(table)} ${where.sql} ${orderSql} ${limitSql}`.trim();
      const rows = this.db.prepare(sql).all(...where.params);
      const normalized = this.normalizeRows(table, rows);

      if (singleMode === 'single') {
        if (normalized.length !== 1) {
          return {
            data: null,
            error: { message: normalized.length === 0 ? 'No rows found' : 'Multiple rows found' }
          };
        }
        return { data: normalized[0], error: null };
      }

      if (singleMode === 'maybeSingle') {
        return { data: normalized[0] || null, error: null };
      }

      return { data: normalized, error: null };
    } catch (error) {
      return { data: null, error: this.publicError(error) };
    }
  }

  insert(table, { data, upsert = false, onConflict = '', singleMode = 'maybeSingle' } = {}) {
    try {
      const rows = Array.isArray(data) ? data : [data];
      if (rows.some(row => !isObject(row))) {
        return { data: null, error: { message: 'No data provided' } };
      }
      const tx = this.db.transaction(items => items.map(item => this.insertOne(table, item, { upsert, onConflict })));
      const inserted = tx(rows).map(row => this.normalizeRow(table, row));

      if (singleMode === 'single') {
        if (inserted.length !== 1) {
          return { data: null, error: { message: inserted.length === 0 ? 'No rows found' : 'Multiple rows found' } };
        }
        return { data: inserted[0], error: null };
      }

      return { data: Array.isArray(data) ? inserted : inserted[0] || null, error: null };
    } catch (error) {
      return { data: null, error: this.publicError(error) };
    }
  }

  insertOne(table, row, { upsert = false, onConflict = '' } = {}) {
    const payload = this.serializeRow(table, row);
    const known = this.knownColumns(table);
    if (ID_TABLES.has(table) && !payload.id) payload.id = crypto.randomUUID();
    if (known.has('created_at') && !payload.created_at) payload.created_at = this.nowIso();
    if (known.has('updated_at') && !payload.updated_at) payload.updated_at = this.nowIso();
    this.validateColumns(table, payload);
    const keys = Object.keys(payload);
    if (!keys.length) {
      throw new Error('No data provided');
    }

    const columns = keys.map(quoteIdentifier).join(', ');
    const placeholders = keys.map(() => '?').join(', ');
    const values = keys.map(key => payload[key]);
    const conflictColumns = String(onConflict || '').split(',').map(item => item.trim()).filter(Boolean);
    const effectiveConflict = conflictColumns.length ? conflictColumns : (keys.includes('id') ? ['id'] : []);

    let sql = `INSERT INTO ${quoteIdentifier(table)} (${columns}) VALUES (${placeholders})`;

    if (upsert && effectiveConflict.length) {
      const updates = keys
        .filter(key => !effectiveConflict.includes(key))
        .map(key => `${quoteIdentifier(key)} = excluded.${quoteIdentifier(key)}`);

      sql += updates.length
        ? ` ON CONFLICT(${effectiveConflict.map(quoteIdentifier).join(', ')}) DO UPDATE SET ${updates.join(', ')}`
        : ` ON CONFLICT(${effectiveConflict.map(quoteIdentifier).join(', ')}) DO NOTHING`;
    }

    sql += ' RETURNING *';
    const statement = this.db.prepare(sql);
    return statement.get(...values);
  }

  update(table, { data, filters = [], singleMode = 'maybeSingle' } = {}) {
    try {
      if (!filters?.length) return { data: null, error: { message: 'Refusing to run update without filters' } };
      const payload = this.serializeRow(table, data);
      this.validateColumns(table, payload);
      const keys = Object.keys(payload).filter(key => key !== 'id' && key !== 'created_at');

      if (!keys.length) {
        return { data: null, error: { message: 'No data provided' } };
      }

      const where = this.buildWhere(filters);
      const known = this.knownColumns(table);
      const assignments = keys.map(key => `${quoteIdentifier(key)} = ?`).join(', ');
      const updatedAtSql = known.has('updated_at') ? ', updated_at = CURRENT_TIMESTAMP' : '';
      const sql = `UPDATE ${quoteIdentifier(table)} SET ${assignments}${updatedAtSql} ${where.sql} RETURNING *`;
      const rows = this.db.prepare(sql).all(...keys.map(key => payload[key]), ...where.params);
      const normalized = this.normalizeRows(table, rows);

      if (singleMode === 'single') {
        if (normalized.length !== 1) {
          return { data: null, error: { message: normalized.length === 0 ? 'No rows found' : 'Multiple rows found' } };
        }
        return { data: normalized[0], error: null };
      }

      if (singleMode === 'maybeSingle') {
        return { data: normalized[0] || null, error: null };
      }

      return { data: normalized, error: null };
    } catch (error) {
      return { data: null, error: this.publicError(error) };
    }
  }

  delete(table, { filters = [], singleMode = 'maybeSingle' } = {}) {
    try {
      if (!filters?.length) return { data: null, error: { message: 'Refusing to run delete without filters' } };
      const where = this.buildWhere(filters);
      const sql = `DELETE FROM ${quoteIdentifier(table)} ${where.sql} RETURNING *`;
      const rows = this.db.prepare(sql).all(...where.params);
      const normalized = this.normalizeRows(table, rows);

      if (singleMode === 'single') {
        if (normalized.length !== 1) {
          return { data: null, error: { message: normalized.length === 0 ? 'No rows found' : 'Multiple rows found' } };
        }
        return { data: normalized[0], error: null };
      }

      if (singleMode === 'maybeSingle') {
        return { data: normalized[0] || null, error: null };
      }

      return { data: normalized, error: null };
    } catch (error) {
      return { data: null, error: this.publicError(error) };
    }
  }

  getUserByToken(token) {
    return this.getSession(token);
  }

  sessionExpiresAt() {
    const ttlDays = Number(process.env.SESSION_TTL_DAYS || 30);
    const boundedTtlDays = Number.isFinite(ttlDays) ? Math.min(Math.max(ttlDays, 1), 365) : 30;
    return new Date(Date.now() + 1000 * 60 * 60 * 24 * boundedTtlDays).toISOString();
  }

  cleanupExpiredSessions() {
    this.db.prepare(`DELETE FROM sessions WHERE datetime(expires_at) <= datetime('now')`).run();
  }

  createUser({ email, password, options = {} }) {
    try {
      const normalizedEmail = normalizeEmail(email);
      if (!isValidEmail(normalizedEmail)) return { data: null, error: { message: 'Valid email is required' } };

      const passwordError = passwordValidationError(password);
      if (passwordError) return { data: null, error: { message: passwordError } };

      const existing = this.db.prepare('SELECT id FROM users WHERE email = ?').get(normalizedEmail);
      if (existing) {
        return { data: null, error: { message: 'Email address is already registered' } };
      }

      const userId = crypto.randomUUID();
      const userMetadata = isObject(options?.data) ? { ...options.data, role: 'customer' } : { role: 'customer' };
      const passwordHash = this.hashPassword(password);
      const createdAt = this.nowIso();
      const expiresAt = this.sessionExpiresAt();
      const token = this.createToken();
      const tx = this.db.transaction(() => {
        this.db.prepare(`
          INSERT INTO users (id, email, password_hash, raw_user_meta_data, confirmed_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(userId, normalizedEmail, passwordHash, JSON.stringify(userMetadata), createdAt, createdAt, createdAt);

        this.db.prepare(`
          INSERT INTO profiles (id, email, first_name, last_name, date_of_birth, role, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          userId,
          normalizedEmail,
          userMetadata.first_name || null,
          userMetadata.last_name || null,
          userMetadata.date_of_birth || null,
          'customer',
          createdAt,
          createdAt
        );

        this.db.prepare(`
          INSERT INTO sessions (token, user_id, created_at, expires_at)
          VALUES (?, ?, ?, ?)
        `).run(token, userId, createdAt, expiresAt);
      });

      tx();

      return {
        data: {
          user: this.normalizeAuthUser({ id: userId, email: normalizedEmail, raw_user_meta_data: JSON.stringify(userMetadata), created_at: createdAt }),
          session: this.normalizeSessionRow({ token, user_id: userId, created_at: createdAt, expires_at: expiresAt })
        },
        error: null
      };
    } catch (error) {
      return { data: null, error: this.publicError(error) };
    }
  }

  signIn({ email, password }) {
    try {
      const normalizedEmail = normalizeEmail(email);
      if (!isValidEmail(normalizedEmail) || typeof password !== 'string') {
        return { data: null, error: { message: 'Invalid email or password' } };
      }

      const user = this.db.prepare('SELECT * FROM users WHERE email = ?').get(normalizedEmail);
      if (!user) {
        return { data: null, error: { message: 'Invalid email or password' } };
      }

      if (!this.verifyPassword(password, user.password_hash)) {
        return { data: null, error: { message: 'Invalid email or password' } };
      }

      this.cleanupExpiredSessions();

      const token = this.createToken();
      const createdAt = this.nowIso();
      const expiresAt = this.sessionExpiresAt();

      this.db.prepare(`INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`)
        .run(token, user.id, createdAt, expiresAt);

      return {
        data: {
          user: this.normalizeAuthUser(user),
          session: this.normalizeSessionRow({ token, user_id: user.id, created_at: createdAt, expires_at: expiresAt })
        },
        error: null
      };
    } catch (error) {
      return { data: null, error: this.publicError(error) };
    }
  }

  updatePassword(token, password) {
    const session = this.getSession(token);
    if (!session?.user?.id) {
      return { data: null, error: { message: 'Not authenticated' } };
    }

    const passwordError = passwordValidationError(password);
    if (passwordError) return { data: null, error: { message: passwordError } };

    const passwordHash = this.hashPassword(password);
    this.db.prepare(`UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(passwordHash, session.user.id);
    return { data: { user: session.user }, error: null };
  }

  signOut(token) {
    if (token) {
      this.db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    }

    return { data: { success: true }, error: null };
  }

  createCheckoutOrder(auth, items = [], options = {}) {
    try {
      if (!auth?.user?.id) return { data: null, error: { message: 'Not authenticated' } };
      if (!Array.isArray(items) || items.length === 0) {
        return { data: null, error: { message: 'Your bag is empty' } };
      }
      if (items.length > 100) {
        return { data: null, error: { message: 'Too many items in one checkout' } };
      }

      const normalizedItems = items.map(item => ({
        product_id: String(item?.product_id || item?.id || '').trim() || null,
        product_name: String(item?.product_name || item?.name || 'Product').trim().slice(0, 200),
        quantity: Math.trunc(Number(item?.quantity || 1)),
        price: Number(item?.price || 0)
      }));

      for (const item of normalizedItems) {
        if (!item.product_id) return { data: null, error: { message: 'Product id is required' } };
        if (!item.product_name) return { data: null, error: { message: 'Product name is required' } };
        if (!Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 999) {
          return { data: null, error: { message: 'Invalid item quantity' } };
        }
        if (!Number.isFinite(item.price) || item.price < 0) {
          return { data: null, error: { message: 'Invalid item price' } };
        }
      }

      const paymentMethod = String(options?.paymentMethod || 'cash_on_delivery').trim();
      const allowedPaymentMethods = new Set(['cash_on_delivery']);
      if (!allowedPaymentMethods.has(paymentMethod)) {
        return { data: null, error: { message: 'Unsupported payment method' } };
      }

      const createOrder = this.db.transaction(() => {
        const orderId = crypto.randomUUID();
        const createdAt = this.nowIso();
        let total = 0;

        this.db.prepare(`
          INSERT INTO orders (id, user_id, customer_email, status, payment_method, payment_status, payment_reference, total_amount, created_at, updated_at)
          VALUES (?, ?, ?, 'processing', ?, 'pending', ?, 0, ?, ?)
        `).run(orderId, auth.user.id, auth.user.email, paymentMethod, `COD-${orderId.slice(0, 8).toUpperCase()}`, createdAt, createdAt);

        const getProduct = this.db.prepare('SELECT id, name, price, stock, status FROM products WHERE id = ?');
        const decrementStock = this.db.prepare(`
          UPDATE products
          SET stock = stock - ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND stock >= ?
        `);
        const insertItem = this.db.prepare(`
          INSERT INTO order_items (id, order_id, product_id, product_name, quantity, price, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);

        for (const item of normalizedItems) {
          let finalItem = { ...item };
          const product = getProduct.get(item.product_id);
          if (!product) throw new Error('Product was not found');
          if (product.status !== 'active') throw new Error(`${product.name} is not available`);
          if (Number(product.stock || 0) < item.quantity) throw new Error(`${product.name} has insufficient stock`);
          const stockUpdate = decrementStock.run(item.quantity, product.id, item.quantity);
          if (stockUpdate.changes !== 1) throw new Error(`${product.name} has insufficient stock`);
          finalItem = {
            ...finalItem,
            product_name: product.name,
            price: Number(product.price || item.price || 0)
          };

          total += finalItem.price * finalItem.quantity;
          insertItem.run(
            crypto.randomUUID(),
            orderId,
            finalItem.product_id,
            finalItem.product_name,
            finalItem.quantity,
            finalItem.price,
            createdAt,
            createdAt
          );
        }

        this.db.prepare('UPDATE orders SET total_amount = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(total, orderId);
        this.db.prepare('DELETE FROM customer_bag_items WHERE user_id = ?').run(auth.user.id);

        return this.db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
      });

      const order = createOrder();
      return { data: this.normalizeRow('orders', order), error: null };
    } catch (error) {
      return { data: null, error: this.publicError(error) };
    }
  }

  requireAdmin(profile) {
    return this.isAdmin(profile);
  }

  hasOwnFilter(filters, field, userId) {
    return ownFilterValue(filters || [], field) !== null && String(ownFilterValue(filters || [], field)) === String(userId);
  }

  isAllowedProfileOperation(auth, operation, payload = null, filters = []) {
    if (this.isAdmin(auth?.profile)) return true;
    if (!auth?.user) return false;

    if (operation === 'select') {
      return this.hasOwnFilter(filters, 'id', auth.user.id);
    }

    if (operation === 'insert') {
      return String(payload?.id || '') === String(auth.user.id) && (!payload?.role || payload.role === 'customer');
    }

    if (operation === 'update' || operation === 'delete') {
      if (operation === 'update' && ('role' in (payload || {}) || 'id' in (payload || {}))) return false;
      return this.hasOwnFilter(filters, 'id', auth.user.id);
    }

    return false;
  }

  isAllowedOwnRowOperation(auth, table, operation, payload = null, filters = []) {
    if (!auth?.user) return false;
    if (this.isAdmin(auth?.profile)) return true;

    if (operation === 'upsert') operation = 'insert';

    if (operation === 'select' || operation === 'update' || operation === 'delete') {
      if (operation === 'update' && 'user_id' in (payload || {}) && String(payload.user_id) !== String(auth.user.id)) return false;
      return this.hasOwnFilter(filters, 'user_id', auth.user.id);
    }

    if (operation === 'insert') {
      if (Array.isArray(payload)) {
        return payload.every(row => String(row?.user_id || '') === String(auth.user.id));
      }

      return String(payload?.user_id || '') === String(auth.user.id);
    }

    return false;
  }

  isAllowedOrderOperation(auth, operation, payload = null, filters = []) {
    if (!auth?.user) return false;
    if (this.isAdmin(auth?.profile)) return true;

    if (operation === 'upsert') operation = 'insert';

    if (operation === 'insert') {
      return String(payload?.user_id || '') === String(auth.user.id);
    }

    if (operation === 'select' || operation === 'update' || operation === 'delete') {
      if (operation === 'update' && 'user_id' in (payload || {}) && String(payload.user_id) !== String(auth.user.id)) return false;
      return this.hasOwnFilter(filters, 'user_id', auth.user.id);
    }

    return false;
  }

  isAllowedOrderItemOperation(auth, operation, payload = null, filters = []) {
    if (!auth?.user) return false;
    if (this.isAdmin(auth?.profile)) return true;

    if (operation === 'upsert') operation = 'insert';

    if (operation === 'insert') {
      if (Array.isArray(payload)) return false;
      const order = this.db.prepare('SELECT user_id FROM orders WHERE id = ?').get(payload?.order_id);
      return String(order?.user_id || '') === String(auth.user.id);
    }

    if (operation === 'select' || operation === 'update' || operation === 'delete') {
      const orderId = ownFilterValue(filters || [], 'order_id');
      if (!orderId) return false;
      const order = this.db.prepare('SELECT user_id FROM orders WHERE id = ?').get(orderId);
      return String(order?.user_id || '') === String(auth.user.id);
    }

    return false;
  }

  isAllowedAuditOperation(auth, operation, payload = null) {
    return this.isAdmin(auth?.profile);
  }

  isAllowedCrmOperation(auth, operation, payload = null) {
    return this.isAdmin(auth?.profile);
  }

  isAllowedProductAdmin(auth, operation) {
    return this.isAdmin(auth?.profile);
  }

  isAllowedCategoryAdmin(auth) {
    return this.isAdmin(auth?.profile);
  }

  isAllowedTableRead(auth, table, filters = []) {
    if (['products', 'categories', 'subcategories'].includes(table)) return true;
    if (table === 'profiles') return this.isAllowedProfileOperation(auth, 'select', null, filters);
    if (table === 'orders') return this.isAllowedOrderOperation(auth, 'select', null, filters);
    if (table === 'order_items') return this.isAllowedOrderItemOperation(auth, 'select', null, filters);
    if (['customer_bag_items', 'customer_favorites'].includes(table)) return this.isAllowedOwnRowOperation(auth, table, 'select', null, filters);
    if (table === 'crm_contacts') return this.isAllowedCrmOperation(auth, 'select');
    if (table === 'audit_logs') return this.isAllowedAuditOperation(auth, 'select');
    return false;
  }

  isAllowedTableWrite(auth, table, operation, payload = null, filters = []) {
    if (['products', 'categories', 'subcategories'].includes(table)) {
      return operation === 'insert' || operation === 'upsert' || operation === 'update' || operation === 'delete' ? this.isAllowedProductAdmin(auth, operation) : false;
    }

    if (table === 'profiles') return this.isAllowedProfileOperation(auth, operation, payload, filters);
    if (table === 'orders') return this.isAllowedOrderOperation(auth, operation, payload, filters);
    if (table === 'order_items') return this.isAllowedOrderItemOperation(auth, operation, payload, filters);
    if (['customer_bag_items', 'customer_favorites'].includes(table)) return this.isAllowedOwnRowOperation(auth, table, operation, payload, filters);
    if (table === 'crm_contacts') return this.isAllowedCrmOperation(auth, operation, payload);
    if (table === 'audit_logs') return this.isAllowedAuditOperation(auth, operation, payload);

    return false;
  }
}

export function ownRowFilter(table, currentUserId) {
  return [{ field: table === 'profiles' ? 'id' : 'user_id', op: 'eq', value: currentUserId }];
}
