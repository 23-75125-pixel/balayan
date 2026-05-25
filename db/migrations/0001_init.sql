-- SUPABASE SETUP FOR BALAYAN SMASHERS HUB
-- Run this in Supabase SQL Editor.
-- After creating the admin user in Authentication, update its role using the last UPDATE query.

create extension if not exists "pgcrypto";

create table if not exists public.profiles (
    id uuid primary key references auth.users(id) on delete cascade,
    email text unique,
    first_name text,
    last_name text,
    date_of_birth date,
    role text not null default 'customer' check (role in ('customer', 'admin')),
    created_at timestamptz not null default now()
);

create table if not exists public.products (
    id uuid primary key default gen_random_uuid(),
    name text not null,
    category text not null,
    subcategory text,
    price numeric(10,2) not null check (price >= 0),
    original_price numeric(10,2),
    badge text,
    description text,
    brand text,
    sku text,
    barcode text unique,
    gender text,
    size text,
    color text,
    variant_note text,
    stock integer not null default 0 check (stock >= 0),
    status text not null default 'active' check (status in ('active', 'draft', 'out_of_stock')),
    featured boolean not null default false,
    image_url text not null,
    image_path text,
    gallery_image_urls text[] not null default '{}'::text[],
    gallery_image_paths text[] not null default '{}'::text[],
    created_by uuid references auth.users(id) on delete set null,
    created_at timestamptz not null default now()
);

alter table public.profiles add column if not exists date_of_birth date;
alter table public.products add column if not exists brand text;
alter table public.products add column if not exists sku text;
alter table public.products add column if not exists gender text;
alter table public.products add column if not exists size text;
alter table public.products add column if not exists color text;
alter table public.products add column if not exists variant_note text;
alter table public.products add column if not exists stock integer not null default 0 check (stock >= 0);
alter table public.products add column if not exists status text not null default 'active' check (status in ('active', 'draft', 'out_of_stock'));
alter table public.products add column if not exists featured boolean not null default false;
alter table public.products drop constraint if exists products_category_check;
alter table public.products add column if not exists gallery_image_urls text[] not null default '{}'::text[];
alter table public.products add column if not exists gallery_image_paths text[] not null default '{}'::text[];

create table if not exists public.categories (
    id uuid primary key default gen_random_uuid(),
    name text not null,
    slug text not null unique,
    sort_order integer not null default 0,
    is_active boolean not null default true,
    created_at timestamptz not null default now()
);

create table if not exists public.subcategories (
    id uuid primary key default gen_random_uuid(),
    category_id uuid not null references public.categories(id) on delete cascade,
    name text not null,
    slug text not null,
    sort_order integer not null default 0,
    is_active boolean not null default true,
    created_at timestamptz not null default now(),
    unique (category_id, slug)
);

insert into public.categories (name, slug, sort_order)
values
    ('Sports', 'sports', 1),
    ('Apparel', 'apparel', 2),
    ('Jersey', 'jersey', 3),
    ('Equipments', 'equipments', 4),
    ('Accessories', 'accessories', 5)
on conflict (slug) do update set
    name = excluded.name,
    sort_order = excluded.sort_order,
    is_active = true;

insert into public.subcategories (category_id, name, slug, sort_order)
select c.id, v.name, v.slug, v.sort_order
from public.categories c
join (values
    ('sports', 'Badminton', 'badminton', 1),
    ('sports', 'Volleyball', 'volleyball', 2),
    ('sports', 'Basketball', 'basketball', 3),
    ('sports', 'Tennis', 'tennis', 4),
    ('sports', 'Archery', 'archery', 5),
    ('sports', 'Water Sport', 'watersport', 6),
    ('sports', 'Pickleball', 'pickleball', 7),
    ('sports', 'Martial Arts', 'martialarts', 8),
    ('sports', 'Boxing', 'boxing', 9),
    ('sports', 'Billiards', 'billiards', 10),

    ('apparel', 'T-Shirts', 't-shirts', 1),
    ('apparel', 'Shorts', 'shorts', 2),
    ('apparel', 'Boxers', 'boxers', 3),
    ('apparel', 'Briefs', 'briefs', 4),
    ('apparel', 'Sports Bra', 'sports-bra', 5),
    ('apparel', 'Socks', 'socks', 6),
    ('apparel', 'Cap', 'cap', 7),

    ('jersey', 'Basketball Jersey', 'basketball-jersey', 1),
    ('jersey', 'Volleyball Jersey', 'volleyball-jersey', 2),
    ('jersey', 'Badminton Jersey', 'badminton-jersey', 3),
    ('jersey', 'Custom Jersey', 'custom-jersey', 4),

    ('equipments', 'Rackets', 'rackets', 1),
    ('equipments', 'Balls', 'balls', 2),
    ('equipments', 'Nets', 'nets', 3),
    ('equipments', 'Training Gear', 'training-gear', 4),

    ('accessories', 'Bags', 'bags', 1),
    ('accessories', 'Grip Tape', 'grip-tape', 2),
    ('accessories', 'Water Bottles', 'water-bottles', 3),
    ('accessories', 'Wristbands', 'wristbands', 4)
) as v(category_slug, name, slug, sort_order)
on c.slug = v.category_slug
on conflict (category_id, slug) do update set
    name = excluded.name,
    sort_order = excluded.sort_order,
    is_active = true;

create table if not exists public.orders (
    id uuid primary key default gen_random_uuid(),
    user_id uuid references auth.users(id) on delete set null,
    customer_email text,
    status text not null default 'pending' check (status in ('pending', 'processing', 'completed', 'cancelled')),
    payment_method text not null default 'cash_on_delivery',
    payment_status text not null default 'pending' check (payment_status in ('pending', 'paid', 'failed', 'refunded')),
    payment_reference text,
    customer_name text,
    customer_phone text,
    delivery_location text,
    delivery_notes text,
    total_amount numeric(10,2) not null default 0,
    created_at timestamptz not null default now()
);

alter table public.orders add column if not exists payment_method text not null default 'cash_on_delivery';
alter table public.orders add column if not exists payment_status text not null default 'pending' check (payment_status in ('pending', 'paid', 'failed', 'refunded'));
alter table public.orders add column if not exists payment_reference text;
alter table public.orders add column if not exists customer_name text;
alter table public.orders add column if not exists customer_phone text;
alter table public.orders add column if not exists delivery_location text;
alter table public.orders add column if not exists delivery_notes text;

create table if not exists public.order_items (
    id uuid primary key default gen_random_uuid(),
    order_id uuid references public.orders(id) on delete cascade,
    product_id uuid references public.products(id) on delete set null,
    product_name text not null,
    quantity integer not null default 1 check (quantity > 0),
    price numeric(10,2) not null default 0,
    created_at timestamptz not null default now()
);

create table if not exists public.customer_bag_items (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    product_id text not null,
    product_name text not null,
    category text,
    image_url text,
    price numeric(10,2) not null default 0,
    quantity integer not null default 1 check (quantity > 0),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (user_id, product_id)
);

create table if not exists public.customer_favorites (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    product_id text not null,
    product_name text not null,
    category text,
    image_url text,
    price numeric(10,2) not null default 0,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (user_id, product_id)
);

create table if not exists public.crm_contacts (
    id uuid primary key default gen_random_uuid(),
    user_id uuid references auth.users(id) on delete set null,
    email text not null unique,
    full_name text,
    phone text,
    status text not null default 'new' check (status in ('new', 'active', 'vip', 'follow_up', 'inactive')),
    source text not null default 'storefront',
    notes text,
    last_contacted_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table if not exists public.audit_logs (
    id uuid primary key default gen_random_uuid(),
    admin_id uuid references auth.users(id) on delete set null,
    admin_email text,
    action text not null,
    table_name text,
    record_id text,
    details jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;
alter table public.products enable row level security;
alter table public.categories enable row level security;
alter table public.subcategories enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.customer_bag_items enable row level security;
alter table public.customer_favorites enable row level security;
alter table public.crm_contacts enable row level security;
alter table public.audit_logs enable row level security;

create or replace function public.is_admin()
returns boolean
language sql
security definer
set search_path = public
as $$
    select exists (
        select 1 from public.profiles
        where id = auth.uid() and role = 'admin'
    );
$$;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    insert into public.profiles (id, email, first_name, last_name, date_of_birth, role)
    values (
        new.id,
        new.email,
        new.raw_user_meta_data ->> 'first_name',
        new.raw_user_meta_data ->> 'last_name',
        nullif(new.raw_user_meta_data ->> 'date_of_birth', '')::date,
        coalesce(new.raw_user_meta_data ->> 'role', 'customer')
    )
    on conflict (id) do nothing;
    return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

drop policy if exists "Users can read own profile" on public.profiles;
create policy "Users can read own profile"
on public.profiles for select
to authenticated
using (auth.uid() = id or public.is_admin());

drop policy if exists "Users can update own profile" on public.profiles;
create policy "Users can update own profile"
on public.profiles for update
to authenticated
using (auth.uid() = id)
with check (auth.uid() = id and role = 'customer');

drop policy if exists "Users can insert own profile" on public.profiles;
create policy "Users can insert own profile"
on public.profiles for insert
to authenticated
with check (auth.uid() = id and role = 'customer');

drop policy if exists "Anyone can read products" on public.products;
create policy "Anyone can read products"
on public.products for select
to anon, authenticated
using (true);

drop policy if exists "Admins can insert products" on public.products;
create policy "Admins can insert products"
on public.products for insert
to authenticated
with check (public.is_admin());

drop policy if exists "Admins can update products" on public.products;
create policy "Admins can update products"
on public.products for update
to authenticated
using (public.is_admin())
with check (public.is_admin());

drop policy if exists "Admins can delete products" on public.products;
create policy "Admins can delete products"
on public.products for delete
to authenticated
using (public.is_admin());

drop policy if exists "Anyone can read active categories" on public.categories;
create policy "Anyone can read active categories"
on public.categories for select
to anon, authenticated
using (is_active = true or public.is_admin());

drop policy if exists "Admins can insert categories" on public.categories;
create policy "Admins can insert categories"
on public.categories for insert
to authenticated
with check (public.is_admin());

drop policy if exists "Admins can update categories" on public.categories;
create policy "Admins can update categories"
on public.categories for update
to authenticated
using (public.is_admin())
with check (public.is_admin());

drop policy if exists "Admins can delete categories" on public.categories;
create policy "Admins can delete categories"
on public.categories for delete
to authenticated
using (public.is_admin());

drop policy if exists "Anyone can read active subcategories" on public.subcategories;
create policy "Anyone can read active subcategories"
on public.subcategories for select
to anon, authenticated
using (is_active = true or public.is_admin());

drop policy if exists "Admins can insert subcategories" on public.subcategories;
create policy "Admins can insert subcategories"
on public.subcategories for insert
to authenticated
with check (public.is_admin());

drop policy if exists "Admins can update subcategories" on public.subcategories;
create policy "Admins can update subcategories"
on public.subcategories for update
to authenticated
using (public.is_admin())
with check (public.is_admin());

drop policy if exists "Admins can delete subcategories" on public.subcategories;
create policy "Admins can delete subcategories"
on public.subcategories for delete
to authenticated
using (public.is_admin());

drop policy if exists "Customers can read own orders" on public.orders;
create policy "Customers can read own orders"
on public.orders for select
to authenticated
using (auth.uid() = user_id or public.is_admin());

drop policy if exists "Customers can create own orders" on public.orders;
create policy "Customers can create own orders"
on public.orders for insert
to authenticated
with check (auth.uid() = user_id);

drop policy if exists "Admins can update orders" on public.orders;
create policy "Admins can update orders"
on public.orders for update
to authenticated
using (public.is_admin())
with check (public.is_admin());

drop policy if exists "Admins can delete orders" on public.orders;
create policy "Admins can delete orders"
on public.orders for delete
to authenticated
using (public.is_admin());

drop policy if exists "Users can read own order items" on public.order_items;
create policy "Users can read own order items"
on public.order_items for select
to authenticated
using (
    public.is_admin() or exists (
        select 1 from public.orders
        where orders.id = order_items.order_id
        and orders.user_id = auth.uid()
    )
);

drop policy if exists "Users can create own order items" on public.order_items;
create policy "Users can create own order items"
on public.order_items for insert
to authenticated
with check (
    exists (
        select 1 from public.orders
        where orders.id = order_items.order_id
        and orders.user_id = auth.uid()
    )
);

drop policy if exists "Admins can update order items" on public.order_items;
create policy "Admins can update order items"
on public.order_items for update
to authenticated
using (public.is_admin())
with check (public.is_admin());

drop policy if exists "Admins can delete order items" on public.order_items;
create policy "Admins can delete order items"
on public.order_items for delete
to authenticated
using (public.is_admin());

drop policy if exists "Users can read own bag items" on public.customer_bag_items;
create policy "Users can read own bag items"
on public.customer_bag_items for select
to authenticated
using (auth.uid() = user_id or public.is_admin());

drop policy if exists "Users can insert own bag items" on public.customer_bag_items;
create policy "Users can insert own bag items"
on public.customer_bag_items for insert
to authenticated
with check (auth.uid() = user_id);

drop policy if exists "Users can update own bag items" on public.customer_bag_items;
create policy "Users can update own bag items"
on public.customer_bag_items for update
to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists "Users can delete own bag items" on public.customer_bag_items;
create policy "Users can delete own bag items"
on public.customer_bag_items for delete
to authenticated
using (auth.uid() = user_id);

drop policy if exists "Users can read own favorites" on public.customer_favorites;
create policy "Users can read own favorites"
on public.customer_favorites for select
to authenticated
using (auth.uid() = user_id or public.is_admin());

drop policy if exists "Users can insert own favorites" on public.customer_favorites;
create policy "Users can insert own favorites"
on public.customer_favorites for insert
to authenticated
with check (auth.uid() = user_id);

drop policy if exists "Users can update own favorites" on public.customer_favorites;
create policy "Users can update own favorites"
on public.customer_favorites for update
to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists "Users can delete own favorites" on public.customer_favorites;
create policy "Users can delete own favorites"
on public.customer_favorites for delete
to authenticated
using (auth.uid() = user_id);

drop policy if exists "Admins can read CRM contacts" on public.crm_contacts;
create policy "Admins can read CRM contacts"
on public.crm_contacts for select
to authenticated
using (public.is_admin());

drop policy if exists "Admins can create CRM contacts" on public.crm_contacts;
create policy "Admins can create CRM contacts"
on public.crm_contacts for insert
to authenticated
with check (public.is_admin());

drop policy if exists "Admins can update CRM contacts" on public.crm_contacts;
create policy "Admins can update CRM contacts"
on public.crm_contacts for update
to authenticated
using (public.is_admin())
with check (public.is_admin());

drop policy if exists "Admins can delete CRM contacts" on public.crm_contacts;
create policy "Admins can delete CRM contacts"
on public.crm_contacts for delete
to authenticated
using (public.is_admin());

drop policy if exists "Admins can read audit logs" on public.audit_logs;
create policy "Admins can read audit logs"
on public.audit_logs for select
to authenticated
using (public.is_admin());

drop policy if exists "Admins can create audit logs" on public.audit_logs;
create policy "Admins can create audit logs"
on public.audit_logs for insert
to authenticated
with check (public.is_admin() and auth.uid() = admin_id);

insert into storage.buckets (id, name, public)
values ('product-images', 'product-images', true)
on conflict (id) do update set public = true;

drop policy if exists "Anyone can view product images" on storage.objects;
create policy "Anyone can view product images"
on storage.objects for select
to anon, authenticated
using (bucket_id = 'product-images');

drop policy if exists "Admins can upload product images" on storage.objects;
create policy "Admins can upload product images"
on storage.objects for insert
to authenticated
with check (bucket_id = 'product-images' and public.is_admin());

drop policy if exists "Admins can update product images" on storage.objects;
create policy "Admins can update product images"
on storage.objects for update
to authenticated
using (bucket_id = 'product-images' and public.is_admin())
with check (bucket_id = 'product-images' and public.is_admin());

drop policy if exists "Admins can delete product images" on storage.objects;
create policy "Admins can delete product images"
on storage.objects for delete
to authenticated
using (bucket_id = 'product-images' and public.is_admin());

notify pgrst, 'reload schema';
