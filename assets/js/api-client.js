const TOKEN_KEY = 'bsh.api.token';

function toQueryString(params) {
  const search = new URLSearchParams();

  Object.entries(params || {}).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return;
    search.set(key, typeof value === 'string' ? value : JSON.stringify(value));
  });

  return search.toString();
}

async function parseResponse(response) {
  const payload = await response.json().catch(() => ({ data: null, error: { message: 'Invalid server response' } }));
  return {
    data: payload?.data ?? null,
    error: payload?.error ? { message: payload.error.message || 'Request failed' } : null
  };
}

class QueryBuilder {
  constructor(client, table) {
    this.client = client;
    this.table = table;
    this.operation = 'select';
    this.payload = null;
    this.selectColumns = '*';
    this.filters = [];
    this.orderField = '';
    this.orderAscending = true;
    this.limitValue = null;
    this.singleValue = false;
    this.singleMode = '';
    this.onConflict = '';
  }

  select(columns = '*') {
    this.operation = this.operation === 'insert' || this.operation === 'update' || this.operation === 'delete' ? this.operation : 'select';
    this.selectColumns = columns;
    return this;
  }

  insert(data) {
    this.operation = 'insert';
    this.payload = data;
    return this;
  }

  upsert(data, options = {}) {
    this.operation = 'upsert';
    this.payload = data;
    this.onConflict = options.onConflict || '';
    return this;
  }

  update(data) {
    this.operation = 'update';
    this.payload = data;
    return this;
  }

  delete() {
    this.operation = 'delete';
    return this;
  }

  eq(field, value) {
    this.filters.push({ field, op: 'eq', value });
    return this;
  }

  in(field, value) {
    this.filters.push({ field, op: 'in', value });
    return this;
  }

  order(field, options = {}) {
    this.orderField = field;
    this.orderAscending = options.ascending !== false;
    return this;
  }

  limit(value) {
    this.limitValue = value;
    return this;
  }

  single() {
    this.singleValue = true;
    this.singleMode = 'single';
    return this;
  }

  maybeSingle() {
    this.singleValue = true;
    this.singleMode = 'maybeSingle';
    return this;
  }

  then(resolve, reject) {
    return this.execute().then(resolve, reject);
  }

  async execute() {
    const result = await this.client.request(`/api/db/${encodeURIComponent(this.table)}`, {
      method: this.operation === 'select' ? 'GET' : this.operation === 'delete' ? 'DELETE' : this.operation === 'update' ? 'PATCH' : 'POST',
      query:
        this.operation === 'select'
          ? {
              select: this.selectColumns,
              filters: this.filters,
              order: this.orderField,
              ascending: this.orderAscending,
              limit: this.limitValue,
                  single: this.singleValue,
                  singleMode: this.singleMode
            }
          : undefined,
      body:
        this.operation === 'select'
          ? undefined
          : {
              data: this.payload,
              filters: this.filters,
              select: this.selectColumns,
              single: this.singleValue,
              singleMode: this.singleMode,
              upsert: this.operation === 'upsert'
                ? true
                : false,
              onConflict: this.onConflict
            }
    });

    return result;
  }
}

class StorageBucket {
  constructor(client, bucket) {
    this.client = client;
    this.bucket = bucket;
  }

  async upload(pathName, file) {
    const formData = new FormData();
    formData.append('path', pathName);
    formData.append('file', file);

    const response = await fetch(`${this.client.baseUrl}/api/storage/${encodeURIComponent(this.bucket)}/upload`, {
      method: 'POST',
      headers: this.client.authHeaders(),
      body: formData
    });

    return parseResponse(response);
  }

  async remove(paths) {
    const response = await fetch(`${this.client.baseUrl}/api/storage/${encodeURIComponent(this.bucket)}/remove`, {
      method: 'DELETE',
      headers: this.client.jsonHeaders(),
      body: JSON.stringify({ paths })
    });

    return parseResponse(response);
  }

  getPublicUrl(pathName) {
    return {
      data: {
        publicUrl: `${this.client.baseUrl}/uploads/${encodeURIComponent(this.bucket)}/${pathName.replace(/^\/+/, '')}`
      }
    };
  }
}

class StorageApi {
  constructor(client) {
    this.client = client;
  }

  from(bucket) {
    return new StorageBucket(this.client, bucket);
  }
}

class AuthApi {
  constructor(client) {
    this.client = client;
  }

  async getUser() {
    const response = await fetch(`${this.client.baseUrl}/api/auth/me`, {
      headers: this.client.authHeaders()
    });

    return parseResponse(response);
  }

  async signInWithPassword({ email, password }) {
    const response = await fetch(`${this.client.baseUrl}/api/auth/sign-in`, {
      method: 'POST',
      headers: this.client.jsonHeaders(),
      body: JSON.stringify({ email, password })
    });

    const result = await parseResponse(response);
    if (result.data?.session?.access_token) this.client.setSession(result.data.session);
    return result;
  }

  async signUp({ email, password, options }) {
    const response = await fetch(`${this.client.baseUrl}/api/auth/sign-up`, {
      method: 'POST',
      headers: this.client.jsonHeaders(),
      body: JSON.stringify({ email, password, options })
    });

    const result = await parseResponse(response);
    if (result.data?.session?.access_token) this.client.setSession(result.data.session);
    return result;
  }

  async signOut() {
    const response = await fetch(`${this.client.baseUrl}/api/auth/sign-out`, {
      method: 'POST',
      headers: this.client.jsonHeaders(),
      body: JSON.stringify({})
    });

    this.client.clearSession();
    return parseResponse(response);
  }

  async updateUser({ password }) {
    const response = await fetch(`${this.client.baseUrl}/api/auth/update-password`, {
      method: 'POST',
      headers: this.client.jsonHeaders(),
      body: JSON.stringify({ password })
    });

    return parseResponse(response);
  }
}

export class ApiClient {
  constructor(baseUrl = '') {
    this.baseUrl = baseUrl || '';
    this.session = this.loadSession();
    this.auth = new AuthApi(this);
    this.storage = new StorageApi(this);
  }

  loadSession() {
    try {
      const raw = localStorage.getItem(TOKEN_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  setSession(session) {
    this.session = session || null;
    if (this.session) localStorage.setItem(TOKEN_KEY, JSON.stringify(this.session));
  }

  clearSession() {
    this.session = null;
    localStorage.removeItem(TOKEN_KEY);
  }

  authHeaders() {
    const headers = {};
    if (this.session?.access_token) headers.Authorization = `Bearer ${this.session.access_token}`;
    return headers;
  }

  jsonHeaders() {
    return {
      'Content-Type': 'application/json',
      ...this.authHeaders()
    };
  }

  async request(pathName, { method = 'GET', query = null, body = null } = {}) {
    const url = new URL(`${this.baseUrl}${pathName}`, window.location.origin);
    if (query) {
      const encoded = toQueryString(query);
      if (encoded) url.search = encoded;
    }

    const response = await fetch(url.toString(), {
      method,
      headers: body ? this.jsonHeaders() : this.authHeaders(),
      body: body ? JSON.stringify(body) : undefined
    });

    return parseResponse(response);
  }

  async checkout(items, options = {}) {
    return this.request('/api/checkout', {
      method: 'POST',
      body: { items, ...options }
    });
  }

  from(table) {
    return new QueryBuilder(this, table);
  }
}

export function createApiClient(baseUrl = '') {
  return new ApiClient(baseUrl);
}
