// =======================================
// BALAYAN SMASHERS HUB
// Frontend app wired to the local API layer.
// =======================================

import { createApiClient } from './api-client.js';
import { getAppConfig } from './config.js';

const APP_CONFIG = getAppConfig();
const PRODUCT_IMAGE_BUCKET = APP_CONFIG.productImageBucket || 'product-images';
const db = createApiClient(APP_CONFIG.apiBaseUrl || '');

let cart = [];
let wishlist = [];
let products = [];
let currentUser = null;
let currentProfile = null;
let auditLogs = [];
let crmContacts = [];
let crmOrderStats = {};
let adminOrders = [];
let completedSalesTotal = 0;
let productSalesStats = {};
let pendingCheckoutAfterLogin = false;
let selectedAdminProductIds = new Set();
let adminDraftImageItems = [];
let BARCODE_COLUMN_MISSING = false;
let sweetAlertPromise = null;

function debounce(fn, delay = 180) {
    let timer = null;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), delay);
    };
}

function setButtonLoading(button, loading, text = 'Working...') {
    if (!button) return;
    if (loading) {
        button.dataset.originalText = button.innerHTML;
        button.disabled = true;
        button.classList.add('is-loading');
        button.innerHTML = `<span class="btn-spinner" aria-hidden="true"></span>${escapeHtml(text)}`;
    } else {
        button.disabled = false;
        button.classList.remove('is-loading');
        if (button.dataset.originalText) button.innerHTML = button.dataset.originalText;
        delete button.dataset.originalText;
    }
}

function setFieldError(field, message = '') {
    if (!field) return;
    field.classList.toggle('field-invalid', Boolean(message));
    field.setAttribute('aria-invalid', message ? 'true' : 'false');

    let errorEl = field.parentElement?.querySelector('.field-inline-error');
    if (!message) {
        errorEl?.remove();
        return;
    }

    if (!errorEl) {
        errorEl = document.createElement('small');
        errorEl.className = 'field-inline-error';
        field.insertAdjacentElement('afterend', errorEl);
    }
    errorEl.textContent = message;
}

function clearFieldErrorOnInput(field) {
    field?.addEventListener('input', () => setFieldError(field, ''));
    field?.addEventListener('change', () => setFieldError(field, ''));
}

function csvEscape(value) {
    const clean = String(value ?? '').replace(/\r?\n|\r/g, ' ').trim();
    return /[",]/.test(clean) ? `"${clean.replace(/"/g, '""')}"` : clean;
}

function exportRowsToCsv(filename, headers, rows) {
    const csv = [
        headers.map(csvEscape).join(','),
        ...rows.map(row => row.map(csvEscape).join(','))
    ].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
}

function ensureSweetAlert() {
    if (window.Swal) return Promise.resolve(window.Swal);

    if (!sweetAlertPromise) {
        sweetAlertPromise = new Promise((resolve, reject) => {
            const existing = document.querySelector('script[data-sweetalert2]');
            if (existing) {
                existing.addEventListener('load', () => resolve(window.Swal));
                existing.addEventListener('error', () => reject(new Error('SweetAlert2 failed to load')));
                return;
            }

            const script = document.createElement('script');
            script.src = 'https://cdn.jsdelivr.net/npm/sweetalert2@11';
            script.async = true;
            script.dataset.sweetalert2 = '1';
            script.onload = () => resolve(window.Swal);
            script.onerror = () => reject(new Error('SweetAlert2 failed to load'));
            document.head.appendChild(script);
        });
    }

    return sweetAlertPromise;
}

document.addEventListener('DOMContentLoaded', async () => {
    try {
        try { await ensureSweetAlert(); } catch (error) { console.warn(error.message); }
        loadFromStorage();
        initBasicUI();
        initPasswordToggles();
        initCustomDatePicker();
        initAuth();
        await loadCurrentUser();
        resetGuestTransactionalState();
        await initProducts();
        await initAdminDashboard();
        if (new URLSearchParams(window.location.search).get('login') === '1' && !currentUser) openAuthModal(false);
        updateUI();
    } catch (error) {
        console.error('App initialization failed:', error);
        showToast('An error occurred while starting the app. Please refresh the page.', null, 'warning');
    }
});

window.addEventListener('unhandledrejection', event => {
    console.error('Unhandled promise rejection:', event.reason);
});

window.addEventListener('error', event => {
    console.error('Unhandled error:', event.error || event.message, 'at', event.filename + ':' + event.lineno + ':' + event.colno);
});


function showAdminConfirm({ title, message, confirmText = 'Yes', cancelText = 'No', danger = false, type = 'default', iconClass = null, cancelDanger = false }) {
    if (window.Swal) {
        return Swal.fire({
            title,
            text: message,
            icon: danger ? 'warning' : (type === 'warning' ? 'question' : 'info'),
            showCancelButton: true,
            confirmButtonText: confirmText,
            cancelButtonText: cancelText,
            reverseButtons: true,
            focusCancel: !danger,
            buttonsStyling: false,
            customClass: {
                popup: 'bsh-swal-popup',
                title: 'bsh-swal-title',
                htmlContainer: 'bsh-swal-text',
                confirmButton: `bsh-swal-btn ${danger ? 'danger' : 'primary'}`,
                cancelButton: `bsh-swal-btn ${cancelDanger ? 'danger-muted' : 'secondary'}`
            },
            showClass: { popup: 'swal2-show bsh-swal-show' },
            hideClass: { popup: 'swal2-hide bsh-swal-hide' }
        }).then(result => Boolean(result.isConfirmed));
    }

    return new Promise(resolve => {
        let modal = document.getElementById('adminConfirmModal');

        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'adminConfirmModal';
            modal.className = 'admin-confirm-modal';
            modal.innerHTML = `
                <div class="admin-confirm-backdrop" data-admin-confirm-cancel></div>
                <div class="admin-confirm-box" role="dialog" aria-modal="true">
                    <div class="admin-confirm-icon">
                        <i class="fas fa-exclamation"></i>
                    </div>
                    <h3 id="adminConfirmTitle"></h3>
                    <p id="adminConfirmMessage"></p>
                    <div class="admin-confirm-actions">
                        <button type="button" class="admin-confirm-cancel" data-admin-confirm-cancel></button>
                        <button type="button" class="admin-confirm-ok" data-admin-confirm-ok></button>
                    </div>
                </div>
            `;
            document.body.appendChild(modal);
        }

        const titleEl = modal.querySelector('#adminConfirmTitle');
        const messageEl = modal.querySelector('#adminConfirmMessage');
        const okBtn = modal.querySelector('[data-admin-confirm-ok]');
        const cancelBtn = modal.querySelector('.admin-confirm-cancel');
        const icon = modal.querySelector('.admin-confirm-icon i');

        titleEl.textContent = title;
        messageEl.textContent = message;
        okBtn.textContent = confirmText;
        cancelBtn.textContent = cancelText;
        modal.classList.toggle('danger', danger);
        modal.classList.toggle('warning', type === 'warning');
        modal.classList.toggle('cancel-danger', cancelDanger);
        icon.className = iconClass || (danger ? 'fas fa-trash' : 'fas fa-check');

        const close = answer => {
            modal.classList.remove('active');
            document.body.style.overflow = '';
            okBtn.onclick = null;
            modal.querySelectorAll('[data-admin-confirm-cancel]').forEach(btn => btn.onclick = null);
            resolve(answer);
        };

        okBtn.onclick = () => close(true);
        modal.querySelectorAll('[data-admin-confirm-cancel]').forEach(btn => {
            btn.onclick = () => close(false);
        });

        modal.classList.add('active');
        document.body.style.overflow = 'hidden';
        okBtn.focus();
    });
}

function showToast(message, link, type = 'success') {
    const isWarning = type === 'warning' || /select a color|select a size|select/i.test(message);
    const icon = type === 'error' ? 'error' : isWarning ? 'warning' : 'success';

    if (window.Swal) {
        const html = link
            ? `${escapeHtml(message)} <div style="margin-top:.5rem;"><a href="${link}" target="_blank" rel="noopener" style="color:#2563eb;text-decoration:underline;font-weight:700;">Open</a></div>`
            : escapeHtml(message);

        Swal.fire({
            toast: true,
            position: 'top-end',
            icon,
            html,
            showConfirmButton: false,
            timer: 2600,
            timerProgressBar: true,
            buttonsStyling: false,
            customClass: {
                popup: `bsh-swal-toast ${icon}`,
                htmlContainer: 'bsh-swal-toast-text',
                timerProgressBar: 'bsh-swal-progress'
            },
            showClass: { popup: 'swal2-show bsh-swal-toast-show' },
            hideClass: { popup: 'swal2-hide bsh-swal-hide' }
        });
        return;
    }

    const toast = document.getElementById('toast');
    const toastMessage = document.getElementById('toastMessage');

    if (!toast || !toastMessage) {
        alert(message);
        return;
    }

    const toastIcon = toast.querySelector('i');

    toast.classList.toggle('toast-warning', isWarning);
    toast.classList.toggle('toast-success', !isWarning);

    if (toastIcon) {
        toastIcon.className = isWarning ? 'fas fa-exclamation-circle' : 'fas fa-check-circle';
    }

    toastMessage.innerHTML = link
        ? `${escapeHtml(message)} <a href="${link}" style="color:#fff;text-decoration:underline;">Open</a>`
        : escapeHtml(message);

    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 2800);
}


function ensureProductEditModal() {
    let modal = document.getElementById('adminProductEditModal');

    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'adminProductEditModal';
        modal.className = 'admin-product-modal';
        modal.innerHTML = `
            <div class="admin-product-modal-backdrop" data-close-product-modal></div>
            <div class="admin-product-modal-box" role="dialog" aria-modal="true" aria-labelledby="productFormTitle">
                <div class="admin-product-modal-head">
                    <div>
                        <span id="productModalLabel">Product Editor</span>
                        <h2 id="productModalTitle">Edit Product Details</h2>
                    </div>
                    <button type="button" class="admin-product-modal-close" data-close-product-modal aria-label="Close edit modal">
                        <i class="fas fa-times"></i>
                    </button>
                </div>
                <div class="admin-product-modal-body" id="adminProductEditModalBody"></div>
            </div>
        `;
        document.body.appendChild(modal);

        modal.querySelectorAll('[data-close-product-modal]').forEach(btn => {
            btn.addEventListener('click', resetAdminProductForm);
        });
    }

    return modal;
}

function openProductEditModal(mode = 'edit') {
    const modal = ensureProductEditModal();
    const body = modal.querySelector('#adminProductEditModalBody');
    const panel = document.getElementById('productFormPanel');
    const isAdd = mode === 'add' || !document.getElementById('editingProductId')?.value;

    if (!body || !panel) return;

    const label = modal.querySelector('#productModalLabel');
    const title = modal.querySelector('#productModalTitle');

    if (label) label.textContent = isAdd ? 'Add Product' : 'Product Editor';
    if (title) title.textContent = isAdd ? 'Add New Product' : 'Edit Product Details';

    body.appendChild(panel);
    panel.classList.add('editing-modal-panel');
    modal.classList.add('active');
    document.body.style.overflow = 'hidden';
}

function openAddProductModal() {
    resetAdminProductForm();
    document.getElementById('productFormTitle').textContent = 'Add Product';
    document.getElementById('saveProductBtn').textContent = 'SAVE PRODUCT';
    document.getElementById('cancelEditProductBtn').hidden = true;
    openProductEditModal('add');
}

function closeProductEditModal() {
    const modal = document.getElementById('adminProductEditModal');
    const home = document.getElementById('productFormHome');
    const panel = document.getElementById('productFormPanel');

    if (home && panel && panel.parentElement?.id === 'adminProductEditModalBody') {
        home.after(panel);
    }

    panel?.classList.remove('editing-modal-panel');
    modal?.classList.remove('active');

    if (!document.querySelector('.admin-confirm-modal.active')) {
        document.body.style.overflow = '';
    }
}

function formatPeso(value) {
    return `₱${Number(value || 0).toLocaleString()}`;
}

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>'"]/g, ch => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        "'": '&#39;',
        '"': '&quot;'
    }[ch]));
}

function parseArrayField(value) {
    if (Array.isArray(value)) return value.filter(Boolean);
    if (!value) return [];

    if (typeof value === 'string') {
        const trimmed = value.trim();

        if (!trimmed) return [];

        try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed)) return parsed.filter(Boolean);
        } catch (e) {}

        return trimmed.split(',').map(item => item.trim()).filter(Boolean);
    }

    return [];
}

const GENERIC_PRODUCT_IMAGE_FILES = new Set([
    'badminton.jpg',
    'basketball.jpg',
    'billiard.jpg',
    'boxing.jpg',
    'bshaccessories.jpg',
    'bshequ.jpg',
    'bshjersey.jpg',
    'home1.jpg',
    'home2.jpg',
    'home3.jpg',
    'martialarts.jpg',
    'pickleball.jpg',
    'tennis.jpg',
    'volleyball.jpeg',
    'watersport.jpg'
]);

function productImageKeywords(product = {}) {
    const text = `${product.name || ''} ${product.subcategory || ''} ${product.category || ''}`.toLowerCase();
    const pairs = [
        [/shuttle|shuttlecock/, 'badminton,shuttlecock'],
        [/badminton.*(racket|racquet)|racket.*badminton|racquet.*badminton|yonex/, 'badminton,racket'],
        [/badminton.*net|net.*badminton/, 'badminton,net'],
        [/badminton.*string|string.*badminton/, 'badminton,string'],
        [/basketball.*(jersey|shorts)|jersey.*basketball|shorts.*basketball/, 'basketball,uniform'],
        [/basketball.*(backboard|ring|hoop)|backboard|hoop/, 'basketball,hoop'],
        [/basketball/, 'basketball,ball'],
        [/volleyball.*(jersey|uniform)|jersey.*volleyball/, 'volleyball,uniform'],
        [/volleyball.*net|net.*volleyball/, 'volleyball,net'],
        [/volleyball|mikasa/, 'volleyball,ball'],
        [/tennis.*(racket|racquet)|wilson/, 'tennis,racket'],
        [/tennis.*balls?/, 'tennis,ball'],
        [/pickleball.*net/, 'pickleball,net'],
        [/pickleball.*balls?/, 'pickleball,ball'],
        [/pickleball|paddle/, 'pickleball,paddle'],
        [/boxing.*(gloves?|training)|gloves?/, 'boxing,gloves'],
        [/heavy.*bag|punching.*bag/, 'punching,bag'],
        [/speed.*rope|jump.*rope/, 'jump,rope'],
        [/billiard|cue/, 'billiards,cue'],
        [/martial|uniform|karate|taekwondo/, 'martial,arts,uniform'],
        [/jersey/, 'sports,jersey'],
        [/sports?.*bra|bra/, 'sports,bra'],
        [/shorts?/, 'sports,shorts'],
        [/shirt|tee|t-shirt|dri-fit|base layer|top/, 'sports,shirt'],
        [/socks?/, 'sport,socks'],
        [/cap|headband/, 'sport,cap'],
        [/backpack|bag/, 'sports,bag'],
        [/grip|overgrip|tape/, 'racket,grip'],
        [/wrist|knee|elbow|ankle|brace|support|pad|goggles/, 'sports,protective,gear'],
        [/water|swim/, 'water,sports,equipment']
    ];

    return pairs.find(([pattern]) => pattern.test(text))?.[1] || 'sports,equipment';
}

function stableProductImageLock(product = {}) {
    const raw = `${product.id || ''}|${product.name || ''}|${product.subcategory || ''}`;
    let hash = 0;

    for (let index = 0; index < raw.length; index += 1) {
        hash = ((hash << 5) - hash + raw.charCodeAt(index)) | 0;
    }

    return Math.abs(hash % 10000) + 100;
}

function isGenericProductImage(url) {
    const clean = String(url || '').split('?')[0].replace(/^\/+/, '');
    const file = clean.split('/').pop();

    return !clean ||
        clean === 'photos/bshlogo.png' ||
        clean.startsWith('photos/') && GENERIC_PRODUCT_IMAGE_FILES.has(file);
}

function getTallyProductImage(product = {}, fallback = '') {
    if (fallback && !isGenericProductImage(fallback)) return fallback;

    const keywords = productImageKeywords(product)
        .split(',')
        .map(part => encodeURIComponent(part.trim()))
        .filter(Boolean)
        .join(',');

    return `https://loremflickr.com/900/900/${keywords}/all?lock=${stableProductImageLock(product)}`;
}

const BADMINTON_WEIGHT_MAP = {
    '1U': '95–99g',
    '2U': '90–94g',
    '3U': '85–89g',
    '4U': '80–84g',
    '5U': '75–79g',
    '6U': '70–74g',
    '7U': '65–69g',
    '8U': 'Below 65g'
};

function parseVariantNoteMeta(value) {
    let parsed = null;
    if (value && typeof value === 'object') {
        parsed = value;
    } else {
        const raw = typeof value === 'string' ? value.trim() : '';
        if (!raw) return { plainNote: '', badmintonSpecs: null };
        try {
            parsed = JSON.parse(raw);
        } catch (e) {
            return { plainNote: raw, badmintonSpecs: null };
        }
    }
    if (parsed && typeof parsed === 'object' && (parsed.metaType === 'badminton_specs' || parsed.flex_type || parsed.tension || parsed.grip_size || parsed.weight_class)) {
        const weightClass = parsed.weight_class || '';
        return {
            plainNote: parsed.note || '',
            badmintonSpecs: {
                flex_type: parsed.flex_type || '',
                tension: parsed.tension || '',
                grip_size: parsed.grip_size || '',
                weight_class: weightClass,
                approx_weight: parsed.approx_weight || BADMINTON_WEIGHT_MAP[weightClass] || ''
            }
        };
    }

    // barcode meta fallback
    if (parsed && typeof parsed === 'object' && (parsed.metaType === 'barcode' || parsed.barcode)) {
        return { plainNote: parsed.note || '', badmintonSpecs: null, barcode: parsed.barcode || null };
    }
    const fallback = typeof value === 'string' ? value.trim() : '';
    return { plainNote: fallback, badmintonSpecs: null, barcode: null };
}

function normalizeProduct(row) {
    const variantMeta = parseVariantNoteMeta(row.variant_note || '');
    const galleryUrls = parseArrayField(row.gallery_image_urls || row.gallery_images || row.image_url);
    const galleryPaths = parseArrayField(row.gallery_image_paths || row.image_path);
    const rawCoverImage = galleryUrls[0] || (typeof row.image_url === 'string' && !row.image_url.trim().startsWith('[') ? row.image_url : '') || 'photos/bshlogo.png';
    const coverImage = getTallyProductImage(row, rawCoverImage);
    const coverPath = galleryPaths[0] || (typeof row.image_path === 'string' && !row.image_path.trim().startsWith('[') ? row.image_path : null);

    return {
        id: row.id,
        name: row.name,
        category: row.category || 'sports',
        subcategory: row.subcategory || row.category || 'sports',
        price: Number(row.price || 0),
        originalPrice: row.original_price ? Number(row.original_price) : null,
        image: coverImage,
        image_path: coverPath,
        gallery_images: galleryUrls.length ? galleryUrls : [coverImage],
        gallery_image_paths: galleryPaths,
        badge: row.badge || null,
        rating: row.rating || 4.8,
        reviews: row.reviews || 0,
        description: row.description || '',
        stock: Number(row.stock || 0),
        status: row.status || 'active',
        brand: row.brand || '',
        sku: row.sku || '',
        barcode: row.barcode || variantMeta.barcode || null,
        gender: row.gender || '',
        size: row.size || row.sizes || '',
        color: row.color || row.colors || '',
        variant_note: variantMeta.plainNote,
        badminton_specs: variantMeta.badmintonSpecs,
        featured: row.featured === true || row.featured === 1 || row.featured === 'true',
        created_at: row.created_at || ''
    };
}

function generateBarcodeFromSku(sku) {
    const cleanSku = String(sku || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    return cleanSku ? `BSH-${cleanSku}` : null;
}

function generateBarcodeFromId(id) {
    return `BSH${String(id || '').padStart(8, '0')}`;
}

async function ensureProductBarcode(productId, sku) {
    if (!db || !productId) return null;

    // Always generate a numeric barcode for new products
    let barcode = await generateNumericBarcode(productId);
    let update = await db.from('products').update({ barcode }).eq('id', productId);

    if (!update.error) return barcode;

    const msg = String(update.error?.message || update.error || '');

    // Detect missing column/schema error and provide actionable guidance
if (/barcode.*column|Could not find the 'barcode' column|does not exist|schema cache/i.test(msg)) {
    console.warn('Barcode column missing in products table schema:', msg);

    try {
        const saved = await saveBarcodeToVariantNote(productId, barcode);

        if (saved) {
            showToast(
                'Barcode saved in variant_note (fallback mode). Please fix database schema.',
                null,
                'success'
            );
            return barcode;
        }
    } catch (err) {
        console.error('Fallback failed:', err);
    }

    showToast(
        'Barcode system is not configured properly. Please add "barcode" column and reload the database schema.',
        null,
        'warning'
    );

    return null;
}

    console.warn('Could not ensure product barcode for', productId, msg);
    return null;
}

function renderProductBarcode(product, svgId, valueId, areaId) {
    const barcodeValue = product?.barcode || null;
    const area = document.getElementById(areaId);
    const svg = document.getElementById(svgId);
    const valueEl = document.getElementById(valueId);

    if (!area || !valueEl) return;

    area.hidden = false;
    valueEl.textContent = barcodeValue || 'No barcode available';

    if (!svg) return;

    if (!barcodeValue) {
        svg.style.display = 'none';
        svg.innerHTML = '';
        return;
    }

    svg.style.display = 'block';

    try {
        JsBarcode(svg, barcodeValue, {
            format: 'CODE128',
            displayValue: false,
            width: 1.8,
            height: 40,
            margin: 0
        });
    } catch (err) {
        console.warn('JsBarcode render failed:', err);
    }
}

async function saveBarcodeToVariantNote(productId, barcode) {
    if (!db || !productId) return false;

    try {
        const { data, error } = await db.from('products').select('variant_note').eq('id', productId).single();
        if (error) {
            console.warn('Could not read variant_note for fallback barcode save:', error.message || error);
            return false;
        }

        let parsed = null;
        if (data && data.variant_note) {
            try { parsed = JSON.parse(data.variant_note); } catch (e) { parsed = null; }
        }

        if (!parsed || typeof parsed !== 'object') parsed = { note: String(data?.variant_note || '') };

        // store barcode field
        parsed.barcode = barcode;

        const newVariantNote = JSON.stringify(parsed);
        const upd = await db.from('products').update({ variant_note: newVariantNote }).eq('id', productId);
        if (upd.error) {
            console.warn('Failed to save barcode into variant_note:', upd.error.message || upd.error);
            return false;
        }

        // update local products cache if present
        const idx = products.findIndex(p => String(p.id) === String(productId));
        if (idx !== -1) {
            products[idx].barcode = barcode;
            products[idx].variant_note = parsed.note || '';
        }

        return true;
    } catch (e) {
        console.warn('Exception while saving barcode to variant_note:', e);
        return false;
    }
}

function loadFromStorage() {
    try {
        cart = JSON.parse(localStorage.getItem('cart')) || [];
        wishlist = JSON.parse(localStorage.getItem('wishlist')) || [];
    } catch (e) {
        cart = [];
        wishlist = [];
    }
}

function saveToStorage() {
    localStorage.setItem('cart', JSON.stringify(cart));
    localStorage.setItem('wishlist', JSON.stringify(wishlist));
}

function loadCartFromStorageOnly() {
    try {
        cart = JSON.parse(localStorage.getItem('cart')) || [];
    } catch {
        cart = [];
    }
}

function resetGuestTransactionalState() {
    if (currentUser) return;
    cart = [];
    wishlist = [];
    saveToStorage();
}

function requireLoginForTransaction(action = 'continue') {
    if (currentUser) return true;
    pendingCheckoutAfterLogin = action === 'checkout';
    if (action === 'checkout') localStorage.setItem('pendingCheckout', '1');
    showToast(`Please log in to ${action}.`, null, 'warning');
    openAuthModal(false);
    return false;
}

window.BSHRequireLoginForTransaction = requireLoginForTransaction;

function initBasicUI() {
    setTimeout(() => document.getElementById('preloader')?.classList.add('hidden'), 500);
    ensureSidebarPaymentMethod();
    bindCheckoutValidation();

    window.addEventListener('scroll', () => {
        document.getElementById('header')?.classList.toggle('scrolled', window.scrollY > 50);
        document.getElementById('scrollTop')?.classList.toggle('visible', window.scrollY > 500);
    });

    document.getElementById('scrollTop')?.addEventListener('click', () => {
        window.scrollTo({ top: 0, behavior: 'smooth' });
    });

    const cartSidebar = document.getElementById('cartSidebar');

    document.getElementById('cartBtn')?.addEventListener('click', e => {
        if (cartSidebar) {
            e.preventDefault();
            cartSidebar.classList.add('active');
        }
    });

    document.querySelectorAll('a.icon-btn[href="favorites.html"], #wishlistBtn').forEach(link => {
        link.addEventListener('click', e => {
            e.preventDefault();
            window.location.href = 'favorites.html';
        });
    });

    document.getElementById('closeCart')?.addEventListener('click', () => {
        cartSidebar?.classList.remove('active');
    });

    cartSidebar?.querySelector('.cart-overlay')?.addEventListener('click', () => {
        cartSidebar.classList.remove('active');
    });

    document.querySelectorAll('.btn-checkout').forEach(btn => {
        btn.addEventListener('click', handleCheckoutClick);
    });

    const storeSidebar = document.getElementById('storeLocatorSidebar');

    document.getElementById('findStoreBtn')?.addEventListener('click', e => {
        e.preventDefault();
        storeSidebar?.classList.add('active');
    });

    document.getElementById('closeStoreLocator')?.addEventListener('click', () => {
        storeSidebar?.classList.remove('active');
    });

    storeSidebar?.querySelector('.store-overlay')?.addEventListener('click', () => {
        storeSidebar.classList.remove('active');
    });

    function doSearch() {
        const q = document.getElementById('searchInput')?.value.trim();
        if (q) window.location.href = 'search-results.html?q=' + encodeURIComponent(q);
    }

    document.getElementById('searchInput')?.addEventListener('keydown', e => {
        if (e.key === 'Enter') doSearch();
    });

    document.getElementById('searchIcon')?.addEventListener('click', doSearch);

    initMobileNav();
}

function bindCheckoutValidation() {
    document.querySelectorAll('[data-checkout-field]').forEach(field => clearFieldErrorOnInput(field));
}

function ensureSidebarPaymentMethod() {
    document.querySelectorAll('.cart-footer').forEach(footer => {
        if (footer.querySelector('.payment-method-panel')) return;
        const summary = footer.querySelector('.cart-summary');
        if (!summary) return;

        const panel = document.createElement('div');
        panel.className = 'payment-method-panel';
        panel.innerHTML = `
            <div class="payment-method-title">
                <i class="fas fa-money-bill-wave"></i>
                Payment Method
            </div>
            <label class="payment-method-option">
                <input type="radio" name="paymentMethod" value="cash_on_delivery" checked>
                <span>
                    <strong>Cash on Delivery</strong>
                    <small>No gateway fees. Pay when your order arrives.</small>
                </span>
            </label>
            <div class="payment-detail-grid">
                <label>Customer Name
                    <input type="text" data-checkout-field="customerName" placeholder="Full name" autocomplete="name" required>
                </label>
                <label>Contact Number
                    <input type="tel" data-checkout-field="customerPhone" placeholder="09XXXXXXXXX" autocomplete="tel" required>
                </label>
                <label class="payment-detail-wide">Delivery Location
                    <textarea data-checkout-field="deliveryLocation" rows="3" placeholder="House number, street, barangay, city/province" autocomplete="street-address" required></textarea>
                </label>
                <label class="payment-detail-wide">Delivery Notes
                    <input type="text" data-checkout-field="deliveryNotes" placeholder="Landmark, preferred time, or instructions">
                </label>
            </div>
        `;
        summary.insertAdjacentElement('afterend', panel);
    });
}

function initMobileNav() {
    const hamburger = document.getElementById('hamburgerBtn');
    const mobileNav = document.getElementById('mobileNav');
    const closeBtn = document.getElementById('mobileNavClose');
    const overlay = document.getElementById('mobileNavOverlay');

    if (!hamburger || !mobileNav) return;

    const open = () => {
        mobileNav.classList.add('open');
        hamburger.classList.add('open');
        document.body.style.overflow = 'hidden';
    };

    const close = () => {
        mobileNav.classList.remove('open');
        hamburger.classList.remove('open');
        document.body.style.overflow = '';
    };

    hamburger.addEventListener('click', open);
    closeBtn?.addEventListener('click', close);
    overlay?.addEventListener('click', close);
}

function initPasswordToggles() {
    document.querySelectorAll('.password-toggle').forEach(btn => {
        btn.addEventListener('click', () => {
            const input = document.getElementById(btn.dataset.target);
            const icon = btn.querySelector('i');

            if (!input) return;

            const show = input.type === 'password';

            input.type = show ? 'text' : 'password';
            icon.className = show ? 'far fa-eye-slash' : 'far fa-eye';
            btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
        });
    });
}

function initCustomDatePicker() {
    const customDateInput = document.getElementById('customDateInput');
    const dateDisplay = document.getElementById('dateDisplay');
    const dateValue = document.getElementById('dateValue');
    const modal = document.getElementById('calendarModal');
    const overlay = document.getElementById('calendarOverlay');
    const closeBtn = document.getElementById('calendarClose');
    const prevBtn = document.getElementById('prevMonth');
    const nextBtn = document.getElementById('nextMonth');
    const monthBtn = document.getElementById('calendarMonth');
    const yearBtn = document.getElementById('calendarYear');
    const monthPicker = document.getElementById('monthPicker');
    const yearPicker = document.getElementById('yearPicker');
    const yearGrid = document.getElementById('yearPickerGrid');
    const yearRange = document.getElementById('yearRange');
    const daysGrid = document.getElementById('calendarDays');

    if (!customDateInput || !dateDisplay || !dateValue || !modal || !daysGrid) return;

    const monthNames = [
        'January', 'February', 'March', 'April', 'May', 'June',
        'July', 'August', 'September', 'October', 'November', 'December'
    ];

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    let viewDate = new Date(today.getFullYear() - 18, today.getMonth(), 1);
    let selectedDate = null;

    function pad(value) {
        return String(value).padStart(2, '0');
    }

    function toInputValue(date) {
        return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    }

    function toDisplayValue(date) {
        return date.toLocaleDateString('en-US', {
            month: 'long',
            day: 'numeric',
            year: 'numeric'
        });
    }

    function openCalendar() {
        modal.classList.add('active');
        document.body.style.overflow = 'hidden';
        monthPicker?.classList.add('hidden');
        yearPicker?.classList.add('hidden');
        renderCalendar();
    }

    function closeCalendar() {
        modal.classList.remove('active');
        document.body.style.overflow = '';
    }

    function renderYearPicker() {
        if (!yearGrid) return;

        const endYear = today.getFullYear();
        yearRange.textContent = `1900 - ${endYear}`;
        yearGrid.innerHTML = '';

        for (let year = endYear; year >= 1900; year--) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'year-picker-item';
            btn.textContent = year;

            if (year === viewDate.getFullYear()) btn.classList.add('selected');

            btn.addEventListener('click', () => {
                viewDate.setFullYear(year);
                yearPicker.classList.add('hidden');
                renderCalendar();
            });

            yearGrid.appendChild(btn);
        }
    }

    function renderCalendar() {
        const year = viewDate.getFullYear();
        const month = viewDate.getMonth();

        monthBtn.textContent = monthNames[month];
        yearBtn.textContent = year;
        daysGrid.innerHTML = '';

        document.querySelectorAll('.month-picker-item').forEach(item => {
            item.classList.toggle('selected', Number(item.dataset.month) === month);
        });

        renderYearPicker();

        const firstDay = new Date(year, month, 1).getDay();
        const daysInMonth = new Date(year, month + 1, 0).getDate();
        const prevMonthDays = new Date(year, month, 0).getDate();

        for (let i = firstDay - 1; i >= 0; i--) {
            const emptyDay = document.createElement('button');
            emptyDay.type = 'button';
            emptyDay.className = 'calendar-day other-month';
            emptyDay.textContent = prevMonthDays - i;
            emptyDay.disabled = true;
            daysGrid.appendChild(emptyDay);
        }

        for (let day = 1; day <= daysInMonth; day++) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'calendar-day';
            btn.textContent = day;

            const date = new Date(year, month, day);
            date.setHours(0, 0, 0, 0);

            if (date.getTime() === today.getTime()) btn.classList.add('today');
            if (selectedDate && date.getTime() === selectedDate.getTime()) btn.classList.add('selected');
            if (date > today) btn.disabled = true;

            btn.addEventListener('click', () => {
                selectedDate = date;
                dateDisplay.value = toDisplayValue(date);
                dateValue.value = toInputValue(date);
                dateDisplay.classList.add('has-value');
                closeCalendar();
            });

            daysGrid.appendChild(btn);
        }
    }

    customDateInput.addEventListener('click', openCalendar);

    dateDisplay.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            openCalendar();
        }
    });

    overlay?.addEventListener('click', closeCalendar);
    closeBtn?.addEventListener('click', closeCalendar);

    prevBtn?.addEventListener('click', () => {
        viewDate.setMonth(viewDate.getMonth() - 1);
        renderCalendar();
    });

    nextBtn?.addEventListener('click', () => {
        const next = new Date(viewDate.getFullYear(), viewDate.getMonth() + 1, 1);
        if (next <= today) {
            viewDate = next;
            renderCalendar();
        }
    });

    monthBtn?.addEventListener('click', () => {
        monthPicker?.classList.toggle('hidden');
        yearPicker?.classList.add('hidden');
    });

    yearBtn?.addEventListener('click', () => {
        yearPicker?.classList.toggle('hidden');
        monthPicker?.classList.add('hidden');
        renderYearPicker();
    });

    document.querySelectorAll('.month-picker-item').forEach(item => {
        item.addEventListener('click', () => {
            const selectedMonth = Number(item.dataset.month);
            viewDate.setMonth(selectedMonth);
            monthPicker?.classList.add('hidden');
            renderCalendar();
        });
    });

    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && modal.classList.contains('active')) closeCalendar();
    });

    dateDisplay.setAttribute('tabindex', '0');
    renderCalendar();
}

async function loadCurrentUser() {
    if (!db) return;

    const { data } = await db.auth.getUser();
    currentUser = data?.user || null;

    if (currentUser) currentProfile = await getProfile(currentUser.id);

    updateAuthLinks();
}

async function getProfile(userId) {
    const { data, error } = await db
        .from('profiles')
        .select('*')
        .eq('id', userId)
        .single();

    if (error) return null;
    return data;
}

function getAuthHeaderLinks() {
    const allLinks = Array.from(document.querySelectorAll('a'));
    const byId = id => document.getElementById(id);

    const loginLinks = [byId('loginHeaderLink'), byId('mobileLoginLink')].filter(Boolean);
    const joinLinks = [byId('joinHeaderLink'), byId('mobileJoinLink')].filter(Boolean);

    allLinks.forEach(a => {
        if (a.closest('.auth-panel')) return;

        const text = (a.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
        const href = (a.getAttribute('href') || '').trim();

        if (href === '#' && text === 'log in' && !loginLinks.includes(a)) loginLinks.push(a);
        if (href === '#' && text === 'join us' && !joinLinks.includes(a)) joinLinks.push(a);
    });

    return { loginLinks, joinLinks };
}

function updateAuthLinks() {
    const { loginLinks, joinLinks } = getAuthHeaderLinks();

    if (!currentUser) {
        loginLinks.forEach(a => {
            a.innerHTML = a.id?.startsWith('mobile')
                ? '<i class="fas fa-sign-in-alt"></i> Log In'
                : 'Log In';

            a.removeAttribute('data-auth-logged-in');
        });

        joinLinks.forEach(a => {
            a.innerHTML = a.id?.startsWith('mobile')
                ? '<i class="fas fa-user-plus"></i> Join Us'
                : 'Join Us';

            a.style.display = '';
            a.removeAttribute('data-auth-logged-in');
        });

        return;
    }

    loginLinks.forEach(a => {
        a.innerHTML = currentProfile?.role === 'admin'
            ? (a.id?.startsWith('mobile') ? '<i class="fas fa-gauge"></i> Admin Dashboard' : 'Admin Dashboard')
            : (a.id?.startsWith('mobile') ? '<i class="fas fa-user"></i> My Account' : 'My Account');

        a.setAttribute('data-auth-logged-in', 'account');
    });

    joinLinks.forEach(a => {
        a.innerHTML = a.id?.startsWith('mobile')
            ? '<i class="fas fa-sign-out-alt"></i> Log Out'
            : 'Log Out';

        a.style.display = '';
        a.setAttribute('data-auth-logged-in', 'logout');
    });
}

function openAuthModal(signup = false) {
    hideAuthSuccessAnimation();

    const authPanel = document.getElementById('authPanel');
    const loginForm = document.getElementById('loginForm');
    const signupForm = document.getElementById('signupForm');

    if (!authPanel) {
        showToast('Please log in first. Opening login page...');
        setTimeout(() => {
            window.location.href = 'index.html?login=1';
        }, 700);
        return;
    }

    authPanel.classList.add('active');
    document.body.style.overflow = 'hidden';

    loginForm?.classList.toggle('hidden', signup);
    signupForm?.classList.toggle('hidden', !signup);
}

function showAuthSuccessAnimation(message = 'Log in successfully.') {
    if (window.Swal) {
        Swal.fire({
            icon: 'success',
            title: message,
            toast: true,
            position: 'top-end',
            showConfirmButton: false,
            timer: 1800,
            timerProgressBar: true,
            background: '#111827',
            color: '#fff'
        });
        return;
    }

    showToast(message);
}

function hideAuthSuccessAnimation() {
    return;
}

function initAuth() {
    const authPanel = document.getElementById('authPanel');

    const closeAuth = () => {
        hideAuthSuccessAnimation();
        authPanel?.classList.remove('active');
        document.body.style.overflow = '';
    };

    document.addEventListener('click', async e => {
        const a = e.target.closest('a');
        if (!a) return;

        const cleanText = (a.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
        const loggedInAction = a.getAttribute('data-auth-logged-in');
        const href = (a.getAttribute('href') || '').trim();

        if (loggedInAction === 'account' || cleanText === 'my account' || cleanText === 'admin dashboard') {
            e.preventDefault();
            window.location.href = currentProfile?.role === 'admin' ? 'admin-dashboard.html' : 'index.html';
            return;
        }

        if (loggedInAction === 'logout' || cleanText === 'log out') {
            e.preventDefault();
            await confirmAndLogout();
            return;
        }

        if (a.id === 'showSignup' || (href === '#' && cleanText === 'join us')) {
            e.preventDefault();
            openAuthModal(true);
            return;
        }

        if (a.id === 'showLogin' || (href === '#' && cleanText === 'log in')) {
            e.preventDefault();
            openAuthModal(false);
        }
    }, true);

    document.querySelector('.membership-banner .btn-dark')?.addEventListener('click', e => {
        e.preventDefault();
        openAuthModal(true);
    });

    document.getElementById('closeAuth')?.addEventListener('click', closeAuth);
    authPanel?.querySelector('.auth-overlay')?.addEventListener('click', closeAuth);

    document.getElementById('loginFormSubmit')?.addEventListener('submit', async e => {
        e.preventDefault();

        if (!db) return showToast('Local database is not ready yet. Please restart the app.');

        const email = document.getElementById('loginEmail')?.value.trim();
        const password = document.getElementById('loginPassword')?.value;
        const btn = e.currentTarget.querySelector('button[type="submit"]');

        btn.disabled = true;
        btn.textContent = 'SIGNING IN...';

        const { data, error } = await db.auth.signInWithPassword({ email, password });

        btn.disabled = false;
        btn.textContent = 'SIGN IN';

        if (error) return showToast(error.message);

        currentUser = data.user;
        currentProfile = await getProfile(currentUser.id);

        await saveCustomerBagToDatabase();
        await saveCustomerFavoritesToDatabase();

        updateAuthLinks();
        showAuthSuccessAnimation('Log in successfully.');

        if (currentProfile?.role === 'admin') {
            setTimeout(() => {
                window.location.href = 'admin-dashboard.html';
            }, 1450);
            return;
        }

        if (pendingCheckoutAfterLogin || localStorage.getItem('pendingCheckout') === '1') {
            pendingCheckoutAfterLogin = false;
            localStorage.removeItem('pendingCheckout');

            setTimeout(async () => {
                hideAuthSuccessAnimation();
                closeAuth();
                await proceedCheckout();
            }, 1450);

            return;
        }

        setTimeout(() => {
            window.location.href = 'index.html';
        }, 1450);
    });

    document.getElementById('signupFormSubmit')?.addEventListener('submit', async e => {
        e.preventDefault();

        if (!db) return showToast('Local database is not ready yet. Please restart the app.');

        const email = document.getElementById('signupEmail')?.value.trim();
        const password = document.getElementById('signupPassword')?.value;
        const firstName = document.getElementById('signupFirstName')?.value.trim();
        const lastName = document.getElementById('signupLastName')?.value.trim();
        const dateOfBirth = document.getElementById('dateValue')?.value;

        if (!dateOfBirth) return showToast('Please select your date of birth.');

        const btn = e.currentTarget.querySelector('button[type="submit"]');

        btn.disabled = true;
        btn.textContent = 'CREATING...';

        const { data, error } = await db.auth.signUp({
            email,
            password,
            options: {
                data: {
                    first_name: firstName,
                    last_name: lastName,
                    date_of_birth: dateOfBirth,
                    role: 'customer'
                }
            }
        });

        btn.disabled = false;
        btn.textContent = 'JOIN US';

        if (error) return showToast(error.message);

        closeAuth();

        if (data?.session?.access_token) {
            showToast('Account created and signed in successfully.');
            setTimeout(() => {
                window.location.href = 'index.html';
            }, 1200);
            return;
        }

        showToast('Account created. Check your email to confirm your account, then log in.');
    });
}

async function confirmAndLogout() {
    const confirmed = await showAdminConfirm({
        title: 'Log out?',
        message: 'Are you sure you want to log out of your account?',
        confirmText: 'Yes, Log Out',
        cancelText: 'Cancel',
        danger: false,
        type: 'warning',
        cancelDanger: true,
        iconClass: 'fas fa-exclamation'
    });

    if (!confirmed) return;
    await logout();
}

async function logout() {
    if (db) await db.auth.signOut();

    currentUser = null;
    currentProfile = null;

    updateAuthLinks();
    showToast('Logged out successfully.');

    setTimeout(() => {
        window.location.href = 'index.html';
    }, 700);
}

async function fetchProducts() {
    if (!db) {
        products = [];
        return products;
    }

    const { data, error } = await db
        .from('products')
        .select('*')
        .order('created_at', { ascending: false });

    if (error) {
        console.error(error);
        showToast('Could not load products from the API.');
        products = [];
        return products;
    }

    products = (data || []).map(normalizeProduct);
    console.log('[BSH] Products loaded:', products.length);

    return products;
}

async function initProducts() {
    const grid =
        document.getElementById('productsGrid') ||
        document.getElementById('resultsGrid') ||
        document.getElementById('favoritesGrid') ||
        document.querySelector('.category-block .products-grid');

    // Always fetch products so the bag page and product detail page can check the latest stock.
    await fetchProducts();

    if (document.body.dataset.page === 'apparel-detail') {
        initApparelProductDetail();
        return;
    }

    if (document.body.dataset.page === 'sports-detail') {
        initSportsProductDetail();
        return;
    }

    if (!grid) return;

    renderCorrectProductPage();
    bindFilters();
}

function pageCategory() {
    const bodyCat = document.body.dataset.pageCategory;
    if (bodyCat) return bodyCat;

    const name = location.pathname.split('/').pop();

    if (name.includes('accessories')) return 'accessories';
    if (name.includes('apparel')) return 'apparel';
    if (name.includes('equipments')) return 'equipments';
    if (name.includes('jersey')) return 'jersey';
    if (name.includes('sports')) return 'sports';

    return null;
}

function renderCorrectProductPage() {
    if (document.body.dataset.page === 'favorites' || document.getElementById('favoritesGrid')) {
        return renderFavoritesPage();
    }

    if (document.body.dataset.page === 'search' || document.getElementById('resultsGrid')) {
        return renderSearchPage();
    }

    const categoryBlocks = document.querySelectorAll('.category-block[id^="block-"]');

    if (categoryBlocks.length) return renderCategoryBlocks();

    const category = pageCategory();
    let list = products.slice();

    if (category) {
        list = list.filter(p => productMatchesCategory(p, category));
    } else {
        list = list.filter(p => p.featured === true);

        const activeFilter = document.querySelector('.filter-btn.active')?.dataset.filter || 'all';

        if (activeFilter && slugifyValue(activeFilter) !== 'all') {
            list = list.filter(p =>
                productMatchesCategory(p, activeFilter) ||
                productMatchesSubcategory(p, activeFilter)
            );
        }
    }

    renderProducts(list);
}

function slugifyValue(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/&/g, 'and')
        .replace(/[^a-z0-9]/g, '');
}

function productMatchesCategory(product, category) {
    const cat = slugifyValue(category);
    return slugifyValue(product.category) === cat || slugifyValue(product.subcategory) === cat;
}

function productMatchesSubcategory(product, subcategory) {
    const sub = slugifyValue(subcategory);
    return slugifyValue(product.subcategory) === sub || slugifyValue(product.category) === sub;
}

function productMatchesGender(product, gender) {
    const value = slugifyValue(gender);

    if (!value || value === 'all') return true;

    const productGender = slugifyValue(product.gender);

    if (value === 'men' || value === 'male') return productGender === 'male' || productGender === 'men';
    if (value === 'women' || value === 'female') return productGender === 'female' || productGender === 'women';

    return productGender === value;
}

function renderCategoryBlocks() {
    const pageCat = pageCategory();
    const activePill = document.querySelector('.filter-pill.active');
    const activeFilter =
        document.querySelector('.cat-nav-item.active')?.dataset.cat ||
        activePill?.dataset.filter ||
        activePill?.dataset.cat ||
        'all';

    const activeFilterSlug = slugifyValue(activeFilter);
    const baseList = pageCat ? products.filter(p => productMatchesCategory(p, pageCat)) : products.slice();
    const blocks = document.querySelectorAll('.category-block[id^="block-"]');

    let visibleTotal = 0;

    blocks.forEach(block => {
        const subSlug = block.id.replace('block-', '');
        const grid = block.querySelector('.products-grid');
        const count = block.querySelector('h2 span[id^="count-"]');
        const activeGender = block.querySelector('.gender-btn.active')?.dataset.gender || 'all';

        let list = baseList.filter(p => productMatchesSubcategory(p, subSlug));
        list = list.filter(p => productMatchesGender(p, activeGender));
        list = sortProducts(list);

        const shouldShow = activeFilterSlug === 'all' || activeFilterSlug === subSlug;

        block.classList.toggle('visible', shouldShow);
        block.style.display = shouldShow ? '' : 'none';

        if (count) count.textContent = '(' + list.length + ')';

        if (grid) {
            grid.innerHTML = '';

            if (list.length === 0) {
                grid.innerHTML = '<div class="admin-empty">No products yet in this subcategory.</div>';
            } else {
                list.forEach(product => grid.appendChild(productCard(product)));
            }
        }

        if (shouldShow) visibleTotal += list.length;
    });

    const filterCount = document.getElementById('filterCount');

    if (filterCount) {
        filterCount.textContent = visibleTotal + ' Product' + (visibleTotal !== 1 ? 's' : '');
    }

    const empty = document.getElementById('emptyState');

    if (empty) empty.style.display = visibleTotal === 0 ? 'block' : 'none';
}

function bindFilters() {
    document.querySelectorAll('.filter-btn,.chip,.filter-pill,.cat-nav-item').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.filter-btn,.chip,.filter-pill,.cat-nav-item').forEach(b => {
                b.classList.remove('active');
            });

            btn.classList.add('active');
            renderCorrectProductPage();
        });
    });

    document.querySelectorAll('.gender-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const block = btn.closest('.category-block');

            if (block) {
                block.querySelectorAll('.gender-btn').forEach(b => b.classList.remove('active'));
            }

            btn.classList.add('active');
            renderCorrectProductPage();
        });
    });

    document.getElementById('sortSelect')?.addEventListener('change', () => {
        renderCorrectProductPage();
    });
}

function sortProducts(list) {
    const sort = document.getElementById('sortSelect')?.value || 'featured';
    const output = list.slice();

    if (sort === 'price-asc') {
        output.sort((a, b) => a.price - b.price);
    } else if (sort === 'price-desc') {
        output.sort((a, b) => b.price - a.price);
    } else if (sort === 'newest') {
        output.sort((a, b) => String(b.created_at || b.id).localeCompare(String(a.created_at || a.id)));
    } else {
        output.sort((a, b) => {
            if (Boolean(a.featured) !== Boolean(b.featured)) {
                return Boolean(b.featured) - Boolean(a.featured);
            }

            return String(b.created_at || b.id).localeCompare(String(a.created_at || a.id));
        });
    }

    return output;
}

function renderProducts(list) {
    const grid = document.getElementById('productsGrid');

    if (!grid) return;

    const finalList = sortProducts(list);
    const count = document.getElementById('filterCount');

    if (count) {
        count.textContent = finalList.length + (count.textContent.includes('Products') ? ' Products' : ' Product' + (finalList.length !== 1 ? 's' : ''));
    }

    grid.innerHTML = '';

    const empty = document.getElementById('emptyState');

    if (finalList.length === 0) {
        if (empty) empty.style.display = 'block';
        else grid.innerHTML = `<div class="admin-empty">No products yet. Add products in the admin dashboard.</div>`;
        return;
    }

    if (empty) empty.style.display = 'none';

    finalList.forEach(product => grid.appendChild(productCard(product)));
}

function getDisplayGender(gender) {
    const value = slugifyValue(gender);

    if (value === 'female' || value === 'women') return 'WOMEN';
    if (value === 'male' || value === 'men') return 'MEN';
    if (value === 'unisex') return 'UNISEX';

    return String(gender || '').toUpperCase();
}

function getDisplaySubcategory(subcategory) {
    const value = String(subcategory || '').trim();

    if (!value) return '';

    return value.replace(/[-\s]/g, '').toUpperCase();
}

function getColorValue(colorName) {
    const map = {
        black: '#111111',
        white: '#ffffff',
        gray: '#9ca3af',
        grey: '#9ca3af',
        green: '#22c55e',
        blue: '#2563eb',
        red: '#ef4444',
        yellow: '#facc15',
        navy: '#172554',
        pink: '#ec4899',
        orange: '#fb923c',
        purple: '#a855f7',
        brown: '#92400e',
        beige: '#d6c7a1',
        cream: '#fff7ed',
        gold: '#f59e0b',
        silver: '#cbd5e1',
        maroon: '#7f1d1d'
    };

    return map[String(colorName || '').trim().toLowerCase()] || '#d1d5db';
}

function splitVariantText(value) {
    if (Array.isArray(value)) {
        return value.map(item => String(item).trim()).filter(Boolean);
    }

    return String(value || '')
        .split(',')
        .map(item => item.trim())
        .filter(Boolean);
}

function renderColorDots(colorText) {
    return splitVariantText(colorText).map(color => {
        const bg = getColorValue(color);
        const whiteClass = bg.toLowerCase() === '#ffffff' ? ' white' : '';

        return `<button type="button" class="product-color-dot${whiteClass}" data-color="${escapeHtml(color)}" title="${escapeHtml(color)}" style="background:${bg}"></button>`;
    }).join('');
}

function renderSizePills(sizeText) {
    return splitVariantText(sizeText)
        .map(size => `<button type="button" class="product-size-pill" data-size="${escapeHtml(size)}">${escapeHtml(size)}</button>`)
        .join('');
}


function heartIconSvg(active = false) {
    // Inline SVG heart so it will not turn into a square when Font Awesome fails to load.
    return `
        <svg class="fav-heart-svg" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78L12 21.23l8.84-8.84a5.5 5.5 0 0 0 0-7.78z"></path>
        </svg>`;
}

function favoriteButtonContent(button, active = false) {
    if (button?.classList.contains('detail-fav-btn')) {
        return `Favourite ${heartIconSvg(active)}`;
    }

    return heartIconSvg(active);
}

function productCard(product) {
    const card = document.createElement('div');
    card.className = 'product-card product-card-detailed';

    const inWish = wishlist.some(w => String(w.id) === String(product.id));
    const hasOriginalPrice = product.originalPrice && Number(product.originalPrice) > Number(product.price);
    const badgeText = hasOriginalPrice ? 'SALE' : (product.badge || '');
    const badgeClass = String(badgeText).trim().toLowerCase() === 'new' ? 'new' : 'sale';
    const genderText = getDisplayGender(product.gender);
    const subcategoryText = getDisplaySubcategory(product.subcategory || product.category);
    const colorDots = renderColorDots(product.color);
    const sizePills = renderSizePills(product.size);
    const isApparelItem = slugifyValue(product.category) === 'apparel';
    const isSportsItem = slugifyValue(product.category) === 'sports';
    const detailLink = isApparelItem
        ? `apparel-product.html?id=${encodeURIComponent(product.id)}`
        : isSportsItem
            ? `sports-product.html?id=${encodeURIComponent(product.id)}`
            : '';

    if (detailLink) {
        card.classList.add('clickable-product-card');
        card.setAttribute('role', 'button');
        card.setAttribute('tabindex', '0');
        card.setAttribute('aria-label', `View ${product.name}`);
    }

    card.innerHTML = `
        <div class="product-image-wrapper detailed-image-wrapper">
            ${badgeText ? `<div class="product-badge ${badgeClass}">${escapeHtml(badgeText)}</div>` : ''}
            <img src="${escapeHtml(product.image)}" alt="${escapeHtml(product.name)}" class="product-image">
            <button class="wishlist-btn ${inWish ? 'active' : ''}" data-wishlist-id="${product.id}" aria-label="Add to favorites">
                ${heartIconSvg(inWish)}
            </button>
        </div>

        <div class="product-details detailed-product-details">
            ${genderText ? `<div class="product-gender-label">${escapeHtml(genderText)}</div>` : ''}
            ${subcategoryText ? `<div class="product-subcategory-label">${escapeHtml(subcategoryText)}</div>` : ''}

            <h3 class="product-name detailed-product-name">${escapeHtml(product.name)}</h3>

            ${colorDots ? `<div class="product-colors-row">${colorDots}</div>` : ''}
            ${sizePills ? `<div class="product-sizes-row">${sizePills}</div>` : ''}

            <div class="product-price detailed-product-price">
                <span class="price">${formatPeso(product.price)}</span>
                ${hasOriginalPrice ? `<span class="original-price">${formatPeso(product.originalPrice)}</span>` : ''}
            </div>

            <button class="add-to-cart-btn product-add-bag-btn" data-cart-id="${product.id}">
                Add to Bag
            </button>
        </div>
    `;

    card.addEventListener('click', e => {
        if (!detailLink) return;
        if (e.target.closest('button, a, input, select, textarea')) return;
        window.location.href = detailLink;
    });

    card.addEventListener('keydown', e => {
        if (!detailLink) return;
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        window.location.href = detailLink;
    });

    card.querySelector('[data-cart-id]')?.addEventListener('click', e => {
        e.stopPropagation();
        const hasSizes = splitVariantText(product.size).length > 0;
        const hasColors = splitVariantText(product.color).length > 0;
        const selectedPill = card.querySelector('.product-size-pill.selected');
        const selectedDot = card.querySelector('.product-color-dot.selected');

        if (hasColors && !selectedDot) {
            const colorRow = card.querySelector('.product-colors-row');
            if (colorRow) {
                colorRow.classList.remove('size-shake');
                void colorRow.offsetWidth;
                colorRow.classList.add('size-shake');
            }
            showToast('Please select a color first.', null, 'warning');
            return;
        }

        if (hasSizes && !selectedPill) {
            const sizeRow = card.querySelector('.product-sizes-row');
            if (sizeRow) {
                sizeRow.classList.remove('size-shake');
                void sizeRow.offsetWidth;
                sizeRow.classList.add('size-shake');
            }
            showToast('Please select a size first.', null, 'warning');
            return;
        }

        addToCart(product.id, selectedPill?.dataset.size || null, selectedDot?.dataset.color || null);
    });

    // Color dot selection (click same dot again to deselect)
    card.querySelectorAll('.product-color-dot').forEach(dot => {
        dot.addEventListener('click', e => {
            e.stopPropagation();
            const alreadySelected = dot.classList.contains('selected');
            card.querySelectorAll('.product-color-dot').forEach(d => d.classList.remove('selected'));
            if (!alreadySelected) dot.classList.add('selected');
        });
    });

    // Size pill selection (click same pill again to deselect)
    card.querySelectorAll('.product-size-pill').forEach(pill => {
        pill.addEventListener('click', e => {
            e.stopPropagation();
            const alreadySelected = pill.classList.contains('selected');
            card.querySelectorAll('.product-size-pill').forEach(p => p.classList.remove('selected'));
            if (!alreadySelected) pill.classList.add('selected');
        });
    });

    card.querySelector('[data-wishlist-id]')?.addEventListener('click', e => {
        e.stopPropagation();
        toggleWishlist(product.id, e.currentTarget);
    });

    return card;
}

function getProductGalleryImages(product) {
    const images = parseArrayField(product?.gallery_images);

    if (product?.image && !images.includes(product.image)) {
        images.unshift(product.image);
    }

    return images.length ? images : ['photos/bshlogo.png'];
}

function setDetailMainImage(images, index) {
    const mainImage = document.getElementById('detailMainImage');
    const thumbs = document.querySelectorAll('[data-detail-thumb]');

    if (!mainImage || !images.length) return;

    const safeIndex = (index + images.length) % images.length;
    mainImage.src = images[safeIndex];
    mainImage.dataset.index = String(safeIndex);

    thumbs.forEach(thumb => {
        thumb.classList.toggle('active', Number(thumb.dataset.detailThumb) === safeIndex);
    });
}

function initApparelProductDetail() {
    const wrap = document.getElementById('apparelDetailPage');
    const empty = document.getElementById('apparelDetailEmpty');

    if (!wrap) return;

    const id = new URLSearchParams(window.location.search).get('id');
    const product = products.find(item => String(item.id) === String(id) && slugifyValue(item.category) === 'apparel');

    if (!product) {
        wrap.style.display = 'none';
        if (empty) empty.style.display = 'block';
        return;
    }

    if (empty) empty.style.display = 'none';
    wrap.style.display = '';

    const images = getProductGalleryImages(product);
    const sizes = splitVariantText(product.size);
    const colors = splitVariantText(product.color);
    const hasOriginalPrice = product.originalPrice && Number(product.originalPrice) > Number(product.price);
    const inWish = wishlist.some(w => String(w.id) === String(product.id));
    const isBadmintonProduct = slugifyValue(product.subcategory || '') === 'badminton' || !!product.badminton_specs;
    const badmintonSpecs = product.badminton_specs || null;

    document.title = `${product.name} — Balayan Smashers Hub`;
    document.getElementById('detailName').textContent = product.name;
    document.getElementById('detailSubtitle').textContent = [product.gender || 'Apparel', product.subcategory].filter(Boolean).join(' • ');
    document.getElementById('detailPrice').innerHTML = `${formatPeso(product.price)}${hasOriginalPrice ? ` <span>${formatPeso(product.originalPrice)}</span>` : ''}`;
    document.getElementById('detailDescription').textContent = product.description || 'Clean style, comfortable fit, and ready for everyday movement.';
    document.getElementById('detailStock').textContent = Number(product.stock || 0) > 0 ? `${Number(product.stock)} stocks left` : 'Out of stock';
    document.getElementById('detailStyle').textContent = product.sku || product.variant_note || product.subcategory || 'Apparel';
    document.getElementById('detailColorShown').textContent = colors.join(' / ') || 'As shown';
    document.getElementById('detailOrigin').textContent = 'Philippines';
    renderProductBarcode(product, 'detailBarcodeSvg', 'detailBarcodeValue', 'detailBarcodeArea');

    const thumbs = document.getElementById('detailThumbs');
    thumbs.innerHTML = images.map((image, index) => `
        <button type="button" class="apparel-detail-thumb${index === 0 ? ' active' : ''}" data-detail-thumb="${index}" aria-label="View product photo ${index + 1}">
            <img src="${escapeHtml(image)}" alt="${escapeHtml(product.name)} photo ${index + 1}">
        </button>
    `).join('');

    setDetailMainImage(images, 0);

    thumbs.querySelectorAll('[data-detail-thumb]').forEach(btn => {
        btn.addEventListener('click', () => setDetailMainImage(images, Number(btn.dataset.detailThumb)));
    });

    document.getElementById('detailPrevImage')?.addEventListener('click', () => {
        const current = Number(document.getElementById('detailMainImage')?.dataset.index || 0);
        setDetailMainImage(images, current - 1);
    });

    document.getElementById('detailNextImage')?.addEventListener('click', () => {
        const current = Number(document.getElementById('detailMainImage')?.dataset.index || 0);
        setDetailMainImage(images, current + 1);
    });

    const sizeGrid = document.getElementById('detailSizes');
    sizeGrid.innerHTML = (sizes.length ? sizes : ['One Size']).map(size => `
        <button type="button" class="detail-size-btn" data-size="${escapeHtml(size)}">US ${escapeHtml(size)}</button>
    `).join('');

    sizeGrid.querySelectorAll('.detail-size-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            sizeGrid.querySelectorAll('.detail-size-btn').forEach(item => item.classList.remove('selected'));
            btn.classList.add('selected');
        });
    });

    const colorGrid = document.getElementById('detailColors');
    if (colors.length) {
        colorGrid.hidden = false;
        colorGrid.innerHTML = colors.map(color => `
            <button type="button" class="detail-color-btn" data-color="${escapeHtml(color)}">
                <span style="background:${getColorValue(color)}"></span>${escapeHtml(color)}
            </button>
        `).join('');

        colorGrid.querySelectorAll('.detail-color-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                colorGrid.querySelectorAll('.detail-color-btn').forEach(item => item.classList.remove('selected'));
                btn.classList.add('selected');
            });
        });
    } else {
        colorGrid.hidden = true;
    }

    let detailQuantity = 1;
    const qtyValue = document.getElementById('detailQtyValue');
    const qtyMinus = document.getElementById('detailQtyMinus');
    const qtyPlus = document.getElementById('detailQtyPlus');

    const syncDetailQuantityUI = () => {
        const maxStock = Math.max(Number(product.stock || 0), 0);
        if (qtyValue) qtyValue.textContent = String(detailQuantity);
        if (qtyMinus) qtyMinus.disabled = detailQuantity <= 1;
        if (qtyPlus) qtyPlus.disabled = maxStock <= 0 || detailQuantity >= maxStock;
    };

    qtyMinus?.addEventListener('click', () => {
        if (detailQuantity > 1) {
            detailQuantity -= 1;
            syncDetailQuantityUI();
        }
    });

    qtyPlus?.addEventListener('click', () => {
        const maxStock = Math.max(Number(product.stock || 0), 0);

        if (maxStock <= 0) {
            showToast('This product is out of stock.', null, 'warning');
            syncDetailQuantityUI();
            return;
        }

        if (detailQuantity >= maxStock) {
            showToast(stockLimitMessage(maxStock), null, 'warning');
            syncDetailQuantityUI();
            return;
        }

        detailQuantity += 1;
        syncDetailQuantityUI();
    });

    syncDetailQuantityUI();

    const favBtn = document.getElementById('detailFavoriteBtn');
    favBtn.classList.toggle('active', inWish);
    favBtn.innerHTML = favoriteButtonContent(favBtn, inWish);
    favBtn.addEventListener('click', () => toggleWishlist(product.id, favBtn));

    document.getElementById('detailAddBagBtn')?.addEventListener('click', () => {
        const selectedSize = sizeGrid.querySelector('.detail-size-btn.selected');
        const selectedColor = colorGrid.querySelector('.detail-color-btn.selected');

        if (sizes.length && !selectedSize) {
            sizeGrid.classList.remove('size-shake');
            void sizeGrid.offsetWidth;
            sizeGrid.classList.add('size-shake');
            showToast('Please select a size first.', null, 'warning');
            return;
        }

        if (colors.length && !selectedColor) {
            colorGrid.classList.remove('size-shake');
            void colorGrid.offsetWidth;
            colorGrid.classList.add('size-shake');
            showToast('Please select a color first.', null, 'warning');
            return;
        }

        addToCart(product.id, selectedSize?.dataset.size || null, selectedColor?.dataset.color || null, detailQuantity);
    });
}


function initSportsProductDetail() {
    const wrap = document.getElementById('sportsDetailPage');
    const empty = document.getElementById('sportsDetailEmpty');

    if (!wrap) return;

    const id = new URLSearchParams(window.location.search).get('id');
    const product = products.find(item => String(item.id) === String(id) && slugifyValue(item.category) === 'sports');

    if (!product) {
        wrap.style.display = 'none';
        if (empty) empty.style.display = 'block';
        return;
    }

    if (empty) empty.style.display = 'none';
    wrap.style.display = '';

    const images = getProductGalleryImages(product);
    const sizes = splitVariantText(product.size);
    const colors = splitVariantText(product.color);
    const hasOriginalPrice = product.originalPrice && Number(product.originalPrice) > Number(product.price);
    const inWish = wishlist.some(w => String(w.id) === String(product.id));
    const isBadmintonProduct = slugifyValue(product.subcategory || '') === 'badminton' || !!product.badminton_specs;
    const badmintonSpecs = product.badminton_specs || null;

    document.title = `${product.name} — Balayan Smashers Hub`;
    document.getElementById('sportsDetailName').textContent = product.name;
    document.getElementById('sportsDetailCrumb').textContent = product.subcategory || product.name;
    document.getElementById('sportsDetailCategory').textContent = [product.gender || 'Unisex', product.subcategory || 'Sports'].filter(Boolean).join(' • ');
    document.getElementById('sportsDetailPrice').innerHTML = `${formatPeso(product.price)}${hasOriginalPrice ? ` <span>${formatPeso(product.originalPrice)}</span>` : ''}`;
    const sportsColorEl = document.getElementById('sportsDetailColorText');
    if (sportsColorEl) sportsColorEl.hidden = true;

    const sportsDescriptionEl = document.getElementById('sportsDetailDescription');
    const adminDescription = (product.description || '').trim();

    if (sportsDescriptionEl) {
        sportsDescriptionEl.hidden = !adminDescription;
        sportsDescriptionEl.textContent = adminDescription;
    }

    const sportsDetailStock = document.getElementById('sportsDetailStock');
    if (sportsDetailStock) {
        sportsDetailStock.textContent = Number(product.stock || 0) > 0 ? `${Number(product.stock)} stocks left` : 'Out of stock';
    }

    const badge = document.getElementById('sportsDetailBadge');
    renderProductBarcode(product, 'sportsDetailBarcodeSvg', 'sportsDetailBarcodeValue', 'sportsDetailBarcodeArea');
    if (product.badge || product.featured) {
        badge.hidden = false;
        badge.textContent = product.badge ? String(product.badge).toUpperCase() : 'ONLY IN PHILIPPINES | LIMITED DROP';
    } else {
        badge.hidden = false;
        badge.textContent = 'ONLY IN PHILIPPINES | LIMITED DROP';
    }

    const gallery = document.getElementById('sportsDetailGallery');
    const galleryImages = images.length > 1 ? images : [images[0], images[0], images[0], images[0]];
    gallery.innerHTML = galleryImages.map((image, index) => `
        <div class="sports-detail-image-tile ${index === 0 ? 'first' : ''}">
            <img src="${escapeHtml(image)}" alt="${escapeHtml(product.name)} photo ${index + 1}">
        </div>
    `).join('');

    const sizeGrid = document.getElementById('sportsDetailSizes');
    const sizeHead = document.getElementById('sportsDetailSizeHead');
    const fitBox = document.getElementById('sportsDetailFitBox');
    const badmintonSpecsWrap = document.getElementById('sportsBadmintonSpecs');

    if (isBadmintonProduct) {
        if (sizeHead) sizeHead.hidden = true;
        if (sizeGrid) sizeGrid.hidden = true;
        if (fitBox) fitBox.hidden = true;
        if (badmintonSpecsWrap) {
            badmintonSpecsWrap.hidden = false;
            const specRows = badmintonSpecs ? [
                badmintonSpecs.flex_type ? ['Flex Type', badmintonSpecs.flex_type] : null,
                badmintonSpecs.tension ? ['Tension', badmintonSpecs.tension] : null,
                badmintonSpecs.grip_size ? ['Grip Size', badmintonSpecs.grip_size] : null,
                (badmintonSpecs.weight_class || badmintonSpecs.approx_weight)
                    ? ['Weight Class', `${badmintonSpecs.weight_class || '—'}${badmintonSpecs.approx_weight ? ` • ${badmintonSpecs.approx_weight}` : ''}`]
                    : null,
                colors.length ? ['Colors', colors.join(', ')] : null,
                product.brand ? ['Brand', product.brand] : null
            ].filter(Boolean) : [];

            badmintonSpecsWrap.innerHTML = specRows.length ? `
                <div class="sports-badminton-spec-card">
                    ${specRows.map(([label, value]) => `
                        <div class="sports-badminton-spec-row">
                            <span>${escapeHtml(label)}</span>
                            <strong>${escapeHtml(value)}</strong>
                        </div>
                    `).join('')}
                </div>
            ` : `
                <div class="sports-badminton-spec-card">
                    <p class="sports-badminton-empty">No badminton specs selected yet. Edit this product in the admin dashboard, choose the specs, then save/update the product.</p>
                </div>
            `;
        }
        if (sizeGrid) sizeGrid.innerHTML = '';
    } else {
        if (sizeHead) sizeHead.hidden = false;
        if (sizeGrid) sizeGrid.hidden = false;
        if (fitBox) fitBox.hidden = false;
        if (badmintonSpecsWrap) {
            badmintonSpecsWrap.hidden = true;
            badmintonSpecsWrap.innerHTML = '';
        }
        sizeGrid.innerHTML = (sizes.length ? sizes : ['One Size']).map(size => `
            <button type="button" class="sports-size-btn" data-size="${escapeHtml(size)}">${escapeHtml(size)}</button>
        `).join('');

        sizeGrid.querySelectorAll('.sports-size-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                sizeGrid.querySelectorAll('.sports-size-btn').forEach(item => item.classList.remove('selected'));
                btn.classList.add('selected');
            });
        });
    }

    let sportsDetailQuantity = 1;
    const sportsQtyValue = document.getElementById('sportsDetailQtyValue');
    const sportsQtyMinus = document.getElementById('sportsDetailQtyMinus');
    const sportsQtyPlus = document.getElementById('sportsDetailQtyPlus');

    const syncSportsDetailQuantityUI = () => {
        const maxStock = Math.max(Number(product.stock || 0), 0);
        if (sportsQtyValue) sportsQtyValue.textContent = String(sportsDetailQuantity);
        if (sportsQtyMinus) sportsQtyMinus.disabled = sportsDetailQuantity <= 1;
        if (sportsQtyPlus) sportsQtyPlus.disabled = maxStock <= 0 || sportsDetailQuantity >= maxStock;
    };

    sportsQtyMinus?.addEventListener('click', () => {
        if (sportsDetailQuantity > 1) {
            sportsDetailQuantity -= 1;
            syncSportsDetailQuantityUI();
        }
    });

    sportsQtyPlus?.addEventListener('click', () => {
        const maxStock = Math.max(Number(product.stock || 0), 0);

        if (maxStock <= 0) {
            showToast('This product is out of stock.', null, 'warning');
            syncSportsDetailQuantityUI();
            return;
        }

        if (sportsDetailQuantity >= maxStock) {
            showToast(stockLimitMessage(maxStock), null, 'warning');
            syncSportsDetailQuantityUI();
            return;
        }

        sportsDetailQuantity += 1;
        syncSportsDetailQuantityUI();
    });

    syncSportsDetailQuantityUI();

    const favBtn = document.getElementById('sportsDetailFavoriteBtn');
    favBtn.classList.toggle('active', inWish);
    favBtn.innerHTML = favoriteButtonContent(favBtn, inWish);
    favBtn.addEventListener('click', () => toggleWishlist(product.id, favBtn));

    document.getElementById('sportsDetailAddBagBtn')?.addEventListener('click', () => {
        const selectedSize = sizeGrid.querySelector('.sports-size-btn.selected');
        const selectedColor = colors[0] || null;

        if (!isBadmintonProduct && sizes.length && !selectedSize) {
            sizeGrid.classList.remove('size-shake');
            void sizeGrid.offsetWidth;
            sizeGrid.classList.add('size-shake');
            showToast('Please select a size first.', null, 'warning');
            return;
        }

        addToCart(product.id, selectedSize?.dataset.size || null, selectedColor, sportsDetailQuantity);
    });
}

function addToCart(id, selectedSize, selectedColor, quantity = 1) {
    if (!requireLoginForTransaction('add items to your bag')) return;

    const product =
        products.find(p => String(p.id) === String(id)) ||
        wishlist.find(p => String(p.id) === String(id));

    if (!product) return;

    const safeQuantity = Math.max(1, Number(quantity) || 1);

    // Use id+size+color as a unique cart key so different variants are separate line items
    const cartKey = [id, selectedSize || '', selectedColor || ''].join('__');
    const existing = cart.find(i => i._cartKey === cartKey);
    const availableStock = getAvailableStock(product);
    const currentQuantity = existing ? Number(existing.quantity || 1) : 0;

    if (availableStock <= 0) {
        showToast('This product is out of stock.', null, 'warning');
        return;
    }

    if (currentQuantity >= availableStock) {
        showToast(stockLimitMessage(availableStock), null, 'warning');
        return;
    }

    const quantityToAdd = Math.min(safeQuantity, Math.max(availableStock - currentQuantity, 0));

    if (quantityToAdd <= 0) {
        showToast(stockLimitMessage(availableStock), null, 'warning');
        return;
    }

    if (existing) {
        existing.quantity = currentQuantity + quantityToAdd;
    } else {
        cart.push({ ...product, quantity: quantityToAdd, _cartKey: cartKey, selectedSize: selectedSize || null, selectedColor: selectedColor || null });
    }

    saveToStorage();
    saveCustomerBagToDatabase();
    updateUI();

    const parts = [selectedColor, selectedSize].filter(Boolean).join(', ');
    const baseMessage = parts ? `Added to bag (${parts})` : 'Added to bag';
    showToast(quantityToAdd < safeQuantity ? `${baseMessage}. ${stockLimitMessage(availableStock)}` : baseMessage);
}

function toggleWishlist(id, btn) {
    if (!requireLoginForTransaction('save favorites')) return;

    const product = products.find(p => String(p.id) === String(id));

    if (!product) return;

    const index = wishlist.findIndex(i => String(i.id) === String(id));

    if (index > -1) {
        wishlist.splice(index, 1);
        btn?.classList.remove('active');
        if (btn) btn.innerHTML = favoriteButtonContent(btn, false);

        saveCustomerFavoritesToDatabase();
        showToast('Removed from favorites');
    } else {
        wishlist.push(product);
        btn?.classList.add('active');
        if (btn) btn.innerHTML = favoriteButtonContent(btn, true);

        saveCustomerFavoritesToDatabase();
        showToast('Saved to favorites');
    }

    saveToStorage();
    updateUI();
}

function getCartItemKey(item) {
    return item._cartKey || [item.id, item.selectedSize || '', item.selectedColor || ''].join('__');
}

function getAvailableStock(item) {
    const latestProduct = products.find(p => String(p.id) === String(item.id));
    const source = latestProduct || item;
    const stock = Number(source.stock);

    if (!Number.isFinite(stock)) return 0;

    return Math.max(stock, 0);
}

function stockLimitMessage(stock) {
    return stock === 1 ? 'Only 1 stock left.' : `Only ${stock} stocks left.`;
}

function updateQuantity(cartKey, change) {
    if (!requireLoginForTransaction('update your bag')) return;

    const item = cart.find(i => getCartItemKey(i) === String(cartKey));

    if (!item) return;

    const currentQuantity = Number(item.quantity || 1);
    const nextQuantity = currentQuantity + Number(change || 0);
    const availableStock = getAvailableStock(item);

    if (nextQuantity < 1) {
        item.quantity = 1;
        showToast('Minimum quantity is 1. Use the delete button to remove this item.', null, 'warning');
    } else if (Number(change || 0) > 0 && availableStock <= 0) {
        item.quantity = 1;
        showToast('This product is out of stock.', null, 'warning');
    } else if (Number(change || 0) > 0 && nextQuantity > availableStock) {
        item.quantity = availableStock;
        showToast(stockLimitMessage(availableStock), null, 'warning');
    } else {
        item.quantity = nextQuantity;
    }

    saveToStorage();
    saveCustomerBagToDatabase();
    updateUI();
}

function removeFromCart(cartKey) {
    if (!requireLoginForTransaction('update your bag')) return;

    cart = cart.filter(i => getCartItemKey(i) !== String(cartKey));

    saveToStorage();
    saveCustomerBagToDatabase();
    updateUI();
    showToast('Removed from bag');
}

function updateUI() {
    const cartCount = cart.reduce((sum, item) => sum + Number(item.quantity || 0), 0);

    if (document.getElementById('cartCount')) {
        document.getElementById('cartCount').textContent = cartCount;
    }

    if (document.getElementById('wishlistCount')) {
        document.getElementById('wishlistCount').textContent = wishlist.length;
    }

    renderCartItems();
    renderBagLandingPage();
}

function renderCartItems() {
    const cartItems = document.getElementById('cartItems');

    if (!cartItems) return;

    const subtotalEl = document.getElementById('cartSubtotal');
    const totalEl = document.getElementById('cartTotal');

    if (cart.length === 0) {
        cartItems.innerHTML = `
            <div style="text-align:center;padding:3rem 1rem;color:#9E9E9E;">
                <i class="fas fa-shopping-bag" style="font-size:3rem;margin-bottom:1rem;opacity:.3;"></i>
                <p style="font-size:.9375rem;font-weight:500;">Your bag is empty</p>
            </div>
        `;

        if (subtotalEl) subtotalEl.textContent = '₱0';
        if (totalEl) totalEl.textContent = '₱0';

        return;
    }

    let total = 0;
    cartItems.innerHTML = '';

    cart.forEach(item => {
        total += Number(item.price || 0) * Number(item.quantity || 1);

        const row = document.createElement('div');
        row.style.cssText = 'display:flex;gap:1rem;padding:1.5rem 0;border-bottom:1px solid #EEE;';

        const cartKey = getCartItemKey(item);
        const selectedColor = item.selectedColor || item.color || '';
        const selectedSize = item.selectedSize || item.size || '';
        const variantParts = [
            selectedColor ? `Color: ${escapeHtml(selectedColor)}` : '',
            selectedSize ? `Size: ${escapeHtml(selectedSize)}` : ''
        ].filter(Boolean).join(' · ');
        const availableStock = getAvailableStock(item);
        const currentQty = Number(item.quantity || 1);
        const plusDisabled = currentQty >= availableStock || availableStock <= 0;

        row.innerHTML = `
            <img src="${escapeHtml(item.image)}" alt="${escapeHtml(item.name)}" style="width:100px;height:100px;object-fit:cover;background:#F5F5F5;">

            <div style="flex:1;min-width:0;">
                <h4 style="font-size:.9375rem;font-weight:700;margin-bottom:.25rem;">${escapeHtml(item.name)}</h4>
                <p style="font-size:.75rem;color:#757575;margin-bottom:.35rem;text-transform:uppercase;">${escapeHtml(item.category)}</p>
                ${variantParts ? `<p style="font-size:.75rem;color:#424242;margin-bottom:.35rem;font-weight:600;">${variantParts}</p>` : ''}
                <p style="font-size:.72rem;color:#757575;margin-bottom:.55rem;font-weight:700;">Stock left: ${availableStock}</p>
                <p style="font-size:1rem;font-weight:700;margin-bottom:.75rem;">${formatPeso(item.price * item.quantity)}</p>

                <div style="display:flex;align-items:center;gap:.75rem;">
                    <button data-minus="${escapeHtml(cartKey)}" style="width:32px;height:32px;background:#F5F5F5;border:none;border-radius:4px;cursor:pointer;font-weight:600;">-</button>
                    <span style="font-weight:600;min-width:24px;text-align:center;">${item.quantity}</span>
                    <button data-plus="${escapeHtml(cartKey)}" ${plusDisabled ? 'disabled aria-disabled="true"' : ''} style="width:32px;height:32px;background:#F5F5F5;border:none;border-radius:4px;cursor:${plusDisabled ? 'not-allowed' : 'pointer'};font-weight:600;opacity:${plusDisabled ? '.45' : '1'};">+</button>
                    <button data-remove="${escapeHtml(cartKey)}" style="margin-left:auto;background:none;border:none;cursor:pointer;color:#757575;">
                        <i class="fas fa-trash-alt"></i>
                    </button>
                </div>
            </div>
        `;

        row.querySelector('[data-minus]')?.addEventListener('click', () => updateQuantity(cartKey, -1));
        row.querySelector('[data-plus]')?.addEventListener('click', () => updateQuantity(cartKey, 1));
        row.querySelector('[data-remove]')?.addEventListener('click', () => removeFromCart(cartKey));

        cartItems.appendChild(row);
    });

    if (subtotalEl) subtotalEl.textContent = formatPeso(total);
    if (totalEl) totalEl.textContent = formatPeso(total);
}

function renderFavoritesPage() {
    const grid = document.getElementById('favoritesGrid');

    if (!grid) return;

    const count = document.getElementById('favoritesCount');

    if (count) count.textContent = wishlist.length;

    grid.innerHTML = '';

    if (wishlist.length === 0) {
        grid.innerHTML = `<div class="admin-empty">No favorites yet.</div>`;
        return;
    }

    wishlist.forEach(product => grid.appendChild(productCard(product)));
}

function renderSearchPage() {
    const grid = document.getElementById('resultsGrid');

    if (!grid) return;

    const params = new URLSearchParams(location.search);
    const q = (params.get('q') || '').toLowerCase();

    const list = products.filter(p =>
        p.name.toLowerCase().includes(q) ||
        p.category.toLowerCase().includes(q) ||
        p.subcategory.toLowerCase().includes(q)
    );

    if (document.getElementById('searchQuery')) {
        document.getElementById('searchQuery').textContent = q;
    }

    if (document.getElementById('resultsCount')) {
        document.getElementById('resultsCount').textContent = list.length;
    }

    grid.innerHTML = '';

    if (list.length === 0) {
        grid.innerHTML = `<div class="admin-empty">No products found.</div>`;
        return;
    }

    list.forEach(product => grid.appendChild(productCard(product)));
}

const FALLBACK_ADMIN_CATEGORIES = [
    { name: 'Sports', slug: 'sports', sort_order: 1 },
    { name: 'Apparel', slug: 'apparel', sort_order: 2 },
    { name: 'Jersey', slug: 'jersey', sort_order: 3 },
    { name: 'Equipments', slug: 'equipments', sort_order: 4 },
    { name: 'Accessories', slug: 'accessories', sort_order: 5 }
];

const FALLBACK_ADMIN_SUBCATEGORY_OPTIONS = {
    sports: ['Badminton', 'Volleyball', 'Basketball', 'Tennis', 'Archery', 'Water Sport', 'Pickleball', 'Martial Arts', 'Boxing', 'Billiards'],
    apparel: ['T-Shirts', 'Shorts', 'Boxers', 'Briefs', 'Sports Bra', 'Socks', 'Cap'],
    jersey: ['Basketball Jersey', 'Volleyball Jersey', 'Badminton Jersey', 'Custom Jersey'],
    equipments: ['Rackets', 'Balls', 'Nets', 'Shoes', 'Training Gear'],
    accessories: ['Bags', 'Grip Tape', 'Water Bottle', 'Wristband', 'Headband']
};

let adminCategoryOptions = [...FALLBACK_ADMIN_CATEGORIES];
let adminSubcategoryOptions = { ...FALLBACK_ADMIN_SUBCATEGORY_OPTIONS };

function useFallbackAdminCategoryOptions() {
    adminCategoryOptions = [...FALLBACK_ADMIN_CATEGORIES];
    adminSubcategoryOptions = { ...FALLBACK_ADMIN_SUBCATEGORY_OPTIONS };
}

async function loadAdminCategoryOptions() {
    useFallbackAdminCategoryOptions();

    if (!db) return;

    try {
        const categoriesResult = await db
            .from('categories')
            .select('id,name,slug,sort_order,is_active')
            .eq('is_active', true)
            .order('sort_order', { ascending: true })
            .order('name', { ascending: true });

        if (categoriesResult.error) throw new Error(categoriesResult.error.message);

        const categories = categoriesResult.data || [];
        if (!categories.length) return;

        const subcategoriesResult = await db
            .from('subcategories')
            .select('id,category_id,name,slug,sort_order,is_active')
            .eq('is_active', true)
            .order('sort_order', { ascending: true })
            .order('name', { ascending: true });

        if (subcategoriesResult.error) throw new Error(subcategoriesResult.error.message);

        adminCategoryOptions = categories.map(category => ({
            id: category.id,
            name: category.name,
            slug: category.slug,
            sort_order: category.sort_order || 0
        }));

        const categoryIdToSlug = new Map(adminCategoryOptions.map(category => [category.id, category.slug]));
        adminSubcategoryOptions = {};

        (subcategoriesResult.data || []).forEach(subcategory => {
            const categorySlug = categoryIdToSlug.get(subcategory.category_id);
            if (!categorySlug) return;

            if (!adminSubcategoryOptions[categorySlug]) adminSubcategoryOptions[categorySlug] = [];
            adminSubcategoryOptions[categorySlug].push(subcategory.name);
        });
    } catch (err) {
        console.warn('[BSH] Using fallback category options:', err.message || err);
        useFallbackAdminCategoryOptions();
    }
}

function updateAdminCategoryChoices(selectedValue = '') {
    const categorySelect = document.getElementById('productCategory');

    if (!categorySelect) return;

    const currentValue = selectedValue || categorySelect.value || adminCategoryOptions[0]?.slug || 'sports';

    categorySelect.innerHTML = '';

    adminCategoryOptions.forEach(category => {
        const option = document.createElement('option');
        option.value = category.slug;
        option.textContent = category.name;
        categorySelect.appendChild(option);
    });

    if (adminCategoryOptions.some(category => category.slug === currentValue)) {
        categorySelect.value = currentValue;
    }

    refreshAdminCustomSelect(categorySelect);
}

function updateAdminCategoryFilterChoices() {
    const filterSelect = document.getElementById('adminProductCategoryFilter');

    if (!filterSelect) return;

    const currentValue = filterSelect.value || 'all';
    filterSelect.innerHTML = '<option value="all">All categories</option>';

    adminCategoryOptions.forEach(category => {
        const option = document.createElement('option');
        option.value = category.slug;
        option.textContent = category.name;
        filterSelect.appendChild(option);
    });

    filterSelect.value = currentValue === 'all' || adminCategoryOptions.some(category => category.slug === currentValue)
        ? currentValue
        : 'all';

    refreshAdminCustomSelect(filterSelect);
}

function updateAdminSubcategoryChoices(selectedValue = '') {
    const categorySelect = document.getElementById('productCategory');
    const subcategorySelect = document.getElementById('productSubcategory');

    if (!categorySelect || !subcategorySelect) return;

    const category = categorySelect.value;
    const choices = adminSubcategoryOptions[category] || [];

    subcategorySelect.innerHTML = '<option value="">Select subcategory</option>';

    choices.forEach(choice => {
        const option = document.createElement('option');
        option.value = choice;
        option.textContent = choice;
        subcategorySelect.appendChild(option);
    });

    if (selectedValue && choices.includes(selectedValue)) {
        subcategorySelect.value = selectedValue;
    }

    refreshAdminCustomSelect(subcategorySelect);
    updateAdminApparelFields();
}

function getSingleChoiceValue(id) {
    const field = document.getElementById(id);
    const checked = field?.querySelector('input[type="radio"]:checked');
    return checked?.value || '';
}

function setSingleChoiceValue(id, value = '') {
    const field = document.getElementById(id);
    if (!field) return;

    field.querySelectorAll('input[type="radio"]').forEach(input => {
        input.checked = Boolean(value) && input.value === value;
    });
}

function clearBadmintonSpecSelections() {
    ['productBadmintonFlex', 'productBadmintonTension', 'productBadmintonGrip', 'productBadmintonWeight'].forEach(id => setSingleChoiceValue(id, ''));
}

function updateAdminApparelFields() {
    const categorySelect = document.getElementById('productCategory');
    const subcategorySelect = document.getElementById('productSubcategory');
    const genderRow = document.getElementById('apparelGenderRow');
    const genderSelect = document.getElementById('productGender');
    const badmintonRowOne = document.getElementById('badmintonSpecsSection');
    const badmintonRowTwo = document.getElementById('badmintonSpecsSectionRowTwo');

    if (!categorySelect || !genderRow) return;

    const isApparel = categorySelect.value === 'apparel' || categorySelect.value === 'jersey';
    const isBadminton = categorySelect.value === 'sports' && slugifyValue(subcategorySelect?.value || '') === 'badminton';

    genderRow.hidden = !isApparel;
    genderRow.classList.toggle('is-hidden', !isApparel);

    if (badmintonRowOne) {
        badmintonRowOne.hidden = !isBadminton;
        badmintonRowOne.classList.toggle('is-hidden', !isBadminton);
    }

    if (badmintonRowTwo) {
        badmintonRowTwo.hidden = !isBadminton;
        badmintonRowTwo.classList.toggle('is-hidden', !isBadminton);
    }

    if (genderSelect) {
        genderSelect.required = categorySelect.value === 'apparel';
        if (!isApparel) genderSelect.value = '';
        refreshAdminCustomSelect(genderSelect);
    }

    if (!isApparel) setMultiSelectValues('productSize', '');
    if (!isBadminton) clearBadmintonSpecSelections();
}

function getMultiSelectValues(id) {
    const field = document.getElementById(id);

    if (!field) return [];

    const checkedInputs = field.querySelectorAll?.('input[type="checkbox"]:checked');

    if (checkedInputs?.length) {
        return Array.from(checkedInputs)
            .map(input => input.value)
            .filter(Boolean);
    }

    if (field.selectedOptions) {
        return Array.from(field.selectedOptions)
            .map(option => option.value)
            .filter(Boolean);
    }

    return [];
}

function setMultiSelectValues(id, savedValue) {
    const field = document.getElementById(id);

    if (!field) return;

    const values = String(savedValue || '')
        .split(',')
        .map(value => value.trim())
        .filter(Boolean);

    const checkboxInputs = field.querySelectorAll?.('input[type="checkbox"]');

    if (checkboxInputs?.length) {
        checkboxInputs.forEach(input => {
            input.checked = values.includes(input.value);
        });
        return;
    }

    if (field.options) {
        Array.from(field.options).forEach(option => {
            option.selected = values.includes(option.value);
        });
    }
}


function buildAdminCustomSelect(select) {
    if (!select || select.dataset.customSelectReady === '1') return;

    const wrapper = document.createElement('div');
    wrapper.className = 'admin-custom-select';

    select.parentNode.insertBefore(wrapper, select);
    wrapper.appendChild(select);

    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'admin-custom-select-trigger';

    const menu = document.createElement('div');
    menu.className = 'admin-custom-select-menu';

    wrapper.appendChild(trigger);
    wrapper.appendChild(menu);

    select.dataset.customSelectReady = '1';

    trigger.addEventListener('click', e => {
        e.stopPropagation();
        document.querySelectorAll('.admin-custom-select.open').forEach(item => {
            if (item !== wrapper) item.classList.remove('open');
        });
        wrapper.classList.toggle('open');
    });

    refreshAdminCustomSelect(select);
}

function refreshAdminCustomSelect(select) {
    if (!select) return;

    if (select.dataset.customSelectReady !== '1') {
        buildAdminCustomSelect(select);
        return;
    }

    const wrapper = select.closest('.admin-custom-select');
    const trigger = wrapper?.querySelector('.admin-custom-select-trigger');
    const menu = wrapper?.querySelector('.admin-custom-select-menu');

    if (!wrapper || !trigger || !menu) return;

    const selectedOption = select.options[select.selectedIndex] || select.options[0];
    trigger.textContent = selectedOption?.textContent || 'Select option';
    menu.innerHTML = '';

    Array.from(select.options).forEach(option => {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'admin-custom-select-option';
        item.textContent = option.textContent;
        item.dataset.value = option.value;
        item.disabled = option.disabled;

        if (option.value === select.value) item.classList.add('selected');

        item.addEventListener('click', e => {
            e.stopPropagation();
            select.value = option.value;
            select.dispatchEvent(new Event('change', { bubbles: true }));
            wrapper.classList.remove('open');
            refreshAdminCustomSelect(select);
        });

        menu.appendChild(item);
    });
}

function refreshAllAdminCustomSelects() {
    document.querySelectorAll('.admin-body select').forEach(select => refreshAdminCustomSelect(select));
}

function initAdminCustomSelects() {
    document.querySelectorAll('.admin-body select').forEach(select => buildAdminCustomSelect(select));

    if (!document.body.dataset.adminCustomSelectCloseReady) {
        document.addEventListener('click', () => {
            document.querySelectorAll('.admin-custom-select.open').forEach(item => item.classList.remove('open'));
        });
        document.body.dataset.adminCustomSelectCloseReady = '1';
    }
}

function initAdminSubcategoryChoices() {
    const categorySelect = document.getElementById('productCategory');

    if (!categorySelect) return;

    updateAdminCategoryChoices();
    updateAdminCategoryFilterChoices();
    updateAdminSubcategoryChoices();
    updateAdminApparelFields();

    const subcategorySelect = document.getElementById('productSubcategory');

    categorySelect.addEventListener('change', () => {
        updateAdminSubcategoryChoices();
        updateAdminApparelFields();
    });

    subcategorySelect?.addEventListener('change', () => {
        updateAdminApparelFields();
    });
}

async function initAdminDashboard() {
    const adminRoot = document.getElementById('adminDashboard');

    if (!adminRoot) return;

    if (!db) {
        adminRoot.innerHTML = '<div class="admin-empty">Local database is not ready yet. Please restart the app.</div>';
        return;
    }

    await loadCurrentUser();

    if (!currentUser || currentProfile?.role !== 'admin') {
        window.location.href = 'index.html';
        return;
    }

    const adminEmailPill = document.getElementById('adminEmail');
    if (adminEmailPill) adminEmailPill.textContent = currentUser.email;

    const adminSidebarEmail = document.getElementById('adminSidebarEmail');
    if (adminSidebarEmail) adminSidebarEmail.textContent = currentUser.email || 'Admin account';

    document.getElementById('adminLogoutBtn')?.addEventListener('click', confirmAndLogout);
    document.getElementById('productImage')?.addEventListener('change', previewAdminImage);
    document.getElementById('productForm')?.addEventListener('submit', saveAdminProduct);
    document.getElementById('openAddProductModalBtn')?.addEventListener('click', openAddProductModal);
    document.getElementById('deleteSelectedProductsBtn')?.addEventListener('click', deleteSelectedAdminProducts);
    document.getElementById('selectAllProductsBtn')?.addEventListener('click', toggleSelectAllAdminProducts);
    document.getElementById('cancelEditProductBtn')?.addEventListener('click', resetAdminProductForm);
    document.getElementById('adminProductSearch')?.addEventListener('input', debounce(renderAdminProducts));
    document.getElementById('adminProductCategoryFilter')?.addEventListener('change', renderAdminProducts);
    document.getElementById('adminProductStatusFilter')?.addEventListener('change', renderAdminProducts);
    document.getElementById('adminProductStockFilter')?.addEventListener('change', renderAdminProducts);
    document.getElementById('adminProductSort')?.addEventListener('change', renderAdminProducts);
    document.getElementById('exportProductsBtn')?.addEventListener('click', exportAdminProducts);
    document.getElementById('adminCustomerSearch')?.addEventListener('input', debounce(renderAdminCustomers));
    document.getElementById('adminCustomerRoleFilter')?.addEventListener('change', renderAdminCustomers);
    document.getElementById('adminCustomerSort')?.addEventListener('change', renderAdminCustomers);
    document.getElementById('exportCustomersBtn')?.addEventListener('click', exportAdminCustomers);
    document.getElementById('adminCrmSearch')?.addEventListener('input', debounce(renderAdminCrmContacts));
    document.getElementById('adminCrmStatusFilter')?.addEventListener('change', renderAdminCrmContacts);
    document.getElementById('adminCrmSort')?.addEventListener('change', renderAdminCrmContacts);
    document.getElementById('exportCrmBtn')?.addEventListener('click', exportAdminCrm);
    document.getElementById('adminAuditSearch')?.addEventListener('input', debounce(renderAdminAuditLogs));
    document.getElementById('adminAuditActionFilter')?.addEventListener('change', renderAdminAuditLogs);
    document.getElementById('adminAuditSort')?.addEventListener('change', renderAdminAuditLogs);
    document.getElementById('refreshAuditLogsBtn')?.addEventListener('click', e => loadAdminAuditLogs(e.currentTarget));
    document.getElementById('exportAuditBtn')?.addEventListener('click', exportAdminAuditLogs);
    document.getElementById('adminOrderSearch')?.addEventListener('input', debounce(renderAdminOrders));
    document.getElementById('adminOrderStatusFilter')?.addEventListener('change', renderAdminOrders);
    document.getElementById('adminOrderPaymentFilter')?.addEventListener('change', renderAdminOrders);
    document.getElementById('adminOrderDateFrom')?.addEventListener('change', renderAdminOrders);
    document.getElementById('adminOrderDateTo')?.addEventListener('change', renderAdminOrders);
    document.getElementById('adminOrderSort')?.addEventListener('change', renderAdminOrders);
    document.getElementById('refreshOrdersBtn')?.addEventListener('click', e => loadAdminOrders(e.currentTarget));
    document.getElementById('exportOrdersBtn')?.addEventListener('click', exportAdminOrders);
    document.getElementById('adminPasswordForm')?.addEventListener('submit', updateAdminPassword);
    bindAdminProductValidation();

    // Show barcode preview as admin types SKU for new products
    const skuInput = document.getElementById('productSku');
    const barcodeInfoEl = document.getElementById('productBarcodeInfo');
    skuInput?.addEventListener('input', () => {
        const sku = (skuInput.value || '').trim();
        if (!barcodeInfoEl) return;
        if (sku) {
            const generated = generateBarcodeFromSku(sku);
            barcodeInfoEl.textContent = generated ? `Barcode will be: ${generated}` : 'Invalid SKU for barcode generation.';
        } else {
            barcodeInfoEl.textContent = 'Barcode will be generated when saved (from SKU or product ID).';
        }
    });

    initAdminPasswordToggles();
    await loadAdminCategoryOptions();
    initAdminSubcategoryChoices();
    initAdminCustomSelects();
    initAdminTabs();

    await fetchProducts();
    await loadAdminProductInsights();
    renderAdminProducts();
    await loadAdminCustomers();
    await loadAdminOrders();
    await loadAdminCrmContacts();
    await loadCompletedSalesTotal();
    await loadAdminAuditLogs();
    updateAdminStats();
}

function initAdminTabs() {
    document.querySelectorAll('[data-admin-tab]').forEach(btn => {
        btn.addEventListener('click', () => {
            const tab = btn.dataset.adminTab;

            document.querySelectorAll('[data-admin-tab]').forEach(item => item.classList.remove('active'));
            document.querySelectorAll('.admin-section').forEach(section => section.classList.remove('active'));

            btn.classList.add('active');

            document.getElementById(`adminTab${tab.charAt(0).toUpperCase() + tab.slice(1)}`)?.classList.add('active');
        });
    });
}

function clearAdminDraftImages() {
    adminDraftImageItems.forEach(item => {
        if (item?.kind === 'new' && item.previewUrl) {
            try { URL.revokeObjectURL(item.previewUrl); } catch (e) {}
        }
    });

    adminDraftImageItems = [];
}

function setAdminDraftImagesFromExisting(imageData = { imageUrls: [], imagePaths: [] }) {
    clearAdminDraftImages();

    adminDraftImageItems = (imageData.imageUrls || []).map((url, index) => ({
        kind: 'existing',
        previewUrl: url,
        imageUrl: url,
        imagePath: (imageData.imagePaths || [])[index] || null
    }));
}

function appendAdminDraftImagesFromFiles(files = []) {
    const nextItems = (files || []).filter(Boolean).map(file => ({
        kind: 'new',
        file,
        previewUrl: URL.createObjectURL(file)
    }));

    adminDraftImageItems = [...adminDraftImageItems, ...nextItems];
}

function removeAdminDraftImage(index) {
    const safeIndex = Number(index);

    if (!Number.isInteger(safeIndex) || safeIndex < 0 || safeIndex >= adminDraftImageItems.length) return;

    const [removed] = adminDraftImageItems.splice(safeIndex, 1);

    if (removed?.kind === 'new' && removed.previewUrl) {
        try { URL.revokeObjectURL(removed.previewUrl); } catch (e) {}
    }

    renderAdminImagePreview();
}

function renderAdminImagePreview() {
    const preview = document.getElementById('filePreview');

    if (!preview) return;

    if (!adminDraftImageItems.length) {
        preview.classList.remove('has-multiple');
        preview.innerHTML = '<span>Image preview</span>';
        return;
    }

    preview.classList.add('has-multiple');
    preview.innerHTML = `
        <div class="file-preview-grid">
            ${adminDraftImageItems.map((item, index) => `
                <div class="file-preview-item">
                    <img src="${escapeHtml(item.previewUrl)}" alt="Preview ${index + 1}">
                    <span class="file-preview-badge">${index === 0 ? 'Cover' : `Photo ${index + 1}`}</span>
                    <button type="button" class="file-preview-remove" data-remove-admin-photo="${index}" aria-label="Remove photo ${index + 1}">
                        <i class="fas fa-times"></i>
                    </button>
                </div>
            `).join('')}
        </div>
    `;

    preview.querySelectorAll('[data-remove-admin-photo]').forEach(button => {
        button.addEventListener('click', () => removeAdminDraftImage(Number(button.dataset.removeAdminPhoto)));
    });
}

function previewAdminImage(e) {
    const files = Array.from(e.target.files || []);

    if (!files.length) {
        renderAdminImagePreview();
        return;
    }

    const validFiles = files.filter(file => {
        const isImage = /^image\//.test(file.type);
        const isReasonableSize = file.size <= 5 * 1024 * 1024;
        if (!isImage) showToast(`${file.name} is not a supported image file.`, null, 'warning');
        if (isImage && !isReasonableSize) showToast(`${file.name} is larger than 5MB.`, null, 'warning');
        return isImage && isReasonableSize;
    });

    if (!validFiles.length) {
        e.target.value = '';
        return;
    }

    appendAdminDraftImagesFromFiles(validFiles);
    e.target.value = '';
    renderAdminImagePreview();
}

function bindAdminProductValidation() {
    [
        'productName',
        'productSubcategory',
        'productPrice',
        'productOriginalPrice',
        'productStock',
        'checkoutCustomerName',
        'checkoutCustomerPhone',
        'checkoutDeliveryLocation'
    ].forEach(id => clearFieldErrorOnInput(document.getElementById(id)));
}

function validateAdminProductForm() {
    const fields = {
        name: document.getElementById('productName'),
        subcategory: document.getElementById('productSubcategory'),
        price: document.getElementById('productPrice'),
        originalPrice: document.getElementById('productOriginalPrice'),
        stock: document.getElementById('productStock')
    };
    let valid = true;

    Object.values(fields).forEach(field => setFieldError(field, ''));

    if (!fields.name?.value.trim()) {
        setFieldError(fields.name, 'Product name is required.');
        valid = false;
    }

    if (!fields.subcategory?.value.trim()) {
        setFieldError(fields.subcategory, 'Choose a subcategory.');
        valid = false;
    }

    const price = Number(fields.price?.value || 0);
    const originalPrice = Number(fields.originalPrice?.value || 0);
    const stock = Number(fields.stock?.value || 0);

    if (!Number.isFinite(price) || price <= 0) {
        setFieldError(fields.price, 'Enter a valid selling price.');
        valid = false;
    }

    if (fields.originalPrice?.value && originalPrice < price) {
        setFieldError(fields.originalPrice, 'Original price should not be lower than the selling price.');
        valid = false;
    }

    if (!Number.isInteger(stock) || stock < 0) {
        setFieldError(fields.stock, 'Stock must be a whole number of 0 or more.');
        valid = false;
    }

    return valid;
}

function getProductPayload(imageData, editingId = null) {
    const urls = imageData?.imageUrls || [];
    const paths = imageData?.imagePaths || [];
    const category = document.getElementById('productCategory').value;
    const subcategory = document.getElementById('productSubcategory').value.trim() || category;
    const sku = document.getElementById('productSku').value.trim() || null;
    const isBadminton = category === 'sports' && slugifyValue(subcategory) === 'badminton';
    const variantNoteText = document.getElementById('productVariantNote')?.value.trim() || '';
    const badmintonWeightClass = getSingleChoiceValue('productBadmintonWeight');
    const badmintonPayload = isBadminton
        ? JSON.stringify({
            metaType: 'badminton_specs',
            note: variantNoteText,
            flex_type: getSingleChoiceValue('productBadmintonFlex') || null,
            tension: getSingleChoiceValue('productBadmintonTension') || null,
            grip_size: getSingleChoiceValue('productBadmintonGrip') || null,
            weight_class: badmintonWeightClass || null,
            approx_weight: BADMINTON_WEIGHT_MAP[badmintonWeightClass] || null
        })
        : (variantNoteText || null);

    return {
        name: document.getElementById('productName').value.trim(),
        category,
        subcategory,
        brand: document.getElementById('productBrand').value.trim() || null,
        sku,
        // barcode intentionally not set here so we can auto-generate a numeric barcode after save
        gender: category === 'apparel'
            ? (document.getElementById('productGender')?.value || null)
            : (category === 'jersey' ? (document.getElementById('productGender')?.value || null) : null),
        size: isBadminton ? null : (getMultiSelectValues('productSize').join(', ') || null),
        color: getMultiSelectValues('productColor').join(', ') || null,
        variant_note: badmintonPayload,
        price: Number(document.getElementById('productPrice').value || 0),
        original_price: document.getElementById('productOriginalPrice').value
            ? Number(document.getElementById('productOriginalPrice').value)
            : null,
        stock: Number(document.getElementById('productStock').value || 0),
        status: document.getElementById('productStatus').value,
        badge: document.getElementById('productBadge').value || null,
        featured: document.getElementById('productFeatured').checked,
        description: document.getElementById('productDescription').value.trim(),
        image_url: urls[0] || '',
        image_path: paths[0] || null,
        gallery_image_urls: urls,
        gallery_image_paths: paths,
        created_by: currentUser.id
    };
}

// Generate a mostly-unique 12-digit numeric barcode using timestamp + randomness
async function generateNumericBarcode(productId) {
    const makeCode = () => {
        const t = Date.now().toString().slice(-10); // 10 digits from timestamp
        const r = String(Math.floor(Math.random() * 90) + 10); // 2 random digits
        return (t + r).slice(-12);
    };

    let attempts = 0;
    while (attempts < 6) {
        if (BARCODE_COLUMN_MISSING) {
            return makeCode();
        }
        const code = makeCode();
        try {
            const { data, error } = await db.from('products').select('id').eq('barcode', code).limit(1);
            if (error) {
                const msg = String(error.message || error || '');
                if (/barcode.*column|Could not find the 'barcode' column|does not exist|schema cache/i.test(msg)) {
                    BARCODE_COLUMN_MISSING = true;
                    // Do not warn repeatedly — treat as missing column and fall back
                    return code;
                }
                console.warn('Barcode uniqueness check failed:', error.message);
                return code;
            }
            if (!data || data.length === 0) return code;
        } catch (e) {
            console.warn('Barcode uniqueness check exception:', e);
            return makeCode();
        }
        attempts++;
    }

    // Fallback: use timestamp last 12 digits
    return String(Date.now()).slice(-12).padStart(12, '0');
}

function getAllProductImagePaths(product) {
    const allPaths = [product?.image_path, ...(product?.gallery_image_paths || [])]
        .filter(Boolean);

    return [...new Set(allPaths)];
}

function getExistingProductImageData(product) {
    if (!product) {
        return { imageUrls: [], imagePaths: [] };
    }

    const urls = parseArrayField(product.gallery_images);
    const paths = parseArrayField(product.gallery_image_paths);

    if (!urls.length && product.image) urls.push(product.image);
    if (!paths.length && product.image_path) paths.push(product.image_path);

    return {
        imageUrls: urls,
        imagePaths: paths
    };
}

function getAdminDraftExistingImageData() {
    const existingItems = adminDraftImageItems.filter(item => item.kind === 'existing');

    return {
        imageUrls: existingItems.map(item => item.imageUrl).filter(Boolean),
        imagePaths: existingItems.map(item => item.imagePath).filter(Boolean)
    };
}

function getAdminDraftNewFiles() {
    return adminDraftImageItems
        .filter(item => item.kind === 'new' && item.file)
        .map(item => item.file);
}

async function uploadProductImages(files) {
    const uploads = [];

    for (const file of files) {
        const fileExt = file.name.split('.').pop();
        const filePath = `${currentUser.id}/${Date.now()}-${Math.random().toString(16).slice(2)}.${fileExt}`;

        const upload = await db.storage
            .from(PRODUCT_IMAGE_BUCKET)
            .upload(filePath, file, { upsert: false });

        if (upload.error) throw new Error(upload.error.message);

        const { data: publicData } = db.storage
            .from(PRODUCT_IMAGE_BUCKET)
            .getPublicUrl(filePath);

        uploads.push({
            imageUrl: publicData.publicUrl,
            imagePath: filePath
        });
    }

    return {
        imageUrls: uploads.map(item => item.imageUrl),
        imagePaths: uploads.map(item => item.imagePath)
    };
}

async function saveProductRecord(payload, editingId) {
    const runSave = data => editingId
        ? db.from('products').update(data).eq('id', editingId).select('id,name').single()
        : db.from('products').insert(data).select('id,name').single();

    let result = await runSave(payload);

    const message = result.error?.message || '';
    const isGallerySchemaError = /gallery_image_urls|gallery_image_paths|schema cache|column/i.test(message);

    if (!result.error || !isGallerySchemaError) {
        return result;
    }

    const fallbackPayload = { ...payload };
    const galleryUrls = payload.gallery_image_urls || [];
    const galleryPaths = payload.gallery_image_paths || [];

    delete fallbackPayload.gallery_image_urls;
    delete fallbackPayload.gallery_image_paths;

    // Fallback for projects where the new gallery columns were not added yet.
    // The product reader can parse these JSON arrays from the old text columns.
    fallbackPayload.image_url = galleryUrls.length > 1 ? JSON.stringify(galleryUrls) : (galleryUrls[0] || payload.image_url || '');
    fallbackPayload.image_path = galleryPaths.length > 1 ? JSON.stringify(galleryPaths) : (galleryPaths[0] || payload.image_path || null);

    return runSave(fallbackPayload);
}

async function saveAdminProduct(e) {
    e.preventDefault();

    const btn = document.getElementById('saveProductBtn');
    const editingId = document.getElementById('editingProductId').value;
    const existingProduct = editingId
        ? products.find(p => String(p.id) === String(editingId))
        : null;

    if (!validateAdminProductForm()) {
        return showToast('Please fix the highlighted product fields.', null, 'warning');
    }

    if (editingId) {
        const productName = document.getElementById('productName')?.value?.trim() || 'this product';
        const confirmed = await showAdminConfirm({
            title: 'Save product changes?',
            message: `Do you want to save the updated details for ${productName}?`,
            confirmText: 'Yes, Save',
            cancelText: 'No, Cancel',
            danger: false
        });

        if (!confirmed) return;
    }

    if (!adminDraftImageItems.length) {
        return showToast('Please keep at least one product photo.');
    }

    setButtonLoading(btn, true, editingId ? 'Updating...' : 'Saving...');

    try {
        const keptExistingImageData = getAdminDraftExistingImageData();
        const newFiles = getAdminDraftNewFiles();
        let uploadedImageData = { imageUrls: [], imagePaths: [] };

        if (newFiles.length) {
            uploadedImageData = await uploadProductImages(newFiles);
        }

        const imageData = {
            imageUrls: [...keptExistingImageData.imageUrls, ...uploadedImageData.imageUrls],
            imagePaths: [...keptExistingImageData.imagePaths, ...uploadedImageData.imagePaths]
        };

        const payload = getProductPayload(imageData, editingId);

        const result = await saveProductRecord(payload, editingId);

        if (result.error) throw new Error(result.error.message);

        if (!editingId && result.data?.id) {
            if (!payload.barcode) {
                payload.barcode = await ensureProductBarcode(result.data.id, payload.sku);
            }
        }

        // Refresh the single saved product and update local cache so UI shows generated barcode immediately
        try {
            const { data: savedRow, error: singleErr } = await db.from('products').select('*').eq('id', result.data?.id || editingId).single();
            if (!singleErr && savedRow) {
                const normalized = normalizeProduct(savedRow);
                const idx = products.findIndex(p => String(p.id) === String(normalized.id));
                if (idx === -1) products.unshift(normalized);
                else products[idx] = normalized;
            }
        } catch (e) {
            // ignore fetch errors; fetchProducts() will refresh full list shortly
            console.warn('Could not refresh saved product immediately:', e);
        }

        if (editingId && existingProduct) {
            const oldPaths = getAllProductImagePaths(existingProduct);
            const newPaths = imageData.imagePaths || [];
            const removablePaths = oldPaths.filter(path => !newPaths.includes(path));

            if (removablePaths.length) {
                await db.storage.from(PRODUCT_IMAGE_BUCKET).remove(removablePaths);
            }
        }

        await logAdminAction(
            editingId ? 'update_product' : 'create_product',
            'products',
            result.data?.id || editingId,
            {
                product_name: payload.name,
                category: payload.category,
                subcategory: payload.subcategory,
                gender: payload.gender,
                size: payload.size,
                color: payload.color,
                price: payload.price,
                stock: payload.stock,
                photo_count: payload.gallery_image_urls?.length || 0
            }
        );

        showToast(editingId ? 'Product updated.' : 'Product saved to database.');

        resetAdminProductForm();
        await fetchProducts();
        renderAdminProducts();
        updateAdminStats();
    } catch (err) {
        showToast(err.message || 'Something went wrong.', null, 'error');
    } finally {
        setButtonLoading(btn, false);
        btn.textContent = document.getElementById('editingProductId').value ? 'UPDATE PRODUCT' : 'SAVE PRODUCT';
    }
}

function resetAdminProductForm() {
    const form = document.getElementById('productForm');

    closeProductEditModal();
    form?.reset();

    document.getElementById('editingProductId').value = '';
    document.getElementById('editingImagePath').value = '';
    document.getElementById('productFormTitle').textContent = 'Add Product';
    document.getElementById('saveProductBtn').textContent = 'SAVE PRODUCT';
    document.getElementById('productImage').required = false;
    document.getElementById('productImage').value = '';
    document.getElementById('cancelEditProductBtn').hidden = true;
    clearAdminDraftImages();
    renderAdminImagePreview();

    updateAdminCategoryChoices();
    updateAdminSubcategoryChoices();
    updateAdminApparelFields();
    clearBadmintonSpecSelections();
    refreshAllAdminCustomSelects();
    const barcodeInfoEl = document.getElementById('productBarcodeInfo');
    if (barcodeInfoEl) barcodeInfoEl.textContent = 'Barcode will be generated when saved.';
}

function editAdminProduct(product) {
    if (!product || !product.id) {
        showToast('Unable to edit product. Product data is missing.', null, 'warning');
        return;
    }

    document.querySelector('[data-admin-tab="products"]')?.click();

    document.getElementById('editingProductId').value = product.id;
    document.getElementById('editingImagePath').value = product.image_path || '';
    document.getElementById('productFormTitle').textContent = 'Edit Product';
    document.getElementById('productName').value = product.name || '';
    updateAdminCategoryChoices(product.category || 'sports');
    document.getElementById('productCategory').value = product.category || 'sports';

    updateAdminSubcategoryChoices(product.subcategory || '');
    updateAdminApparelFields();

    document.getElementById('productGender').value = product.gender || '';

    setMultiSelectValues('productSize', product.size || '');
    setMultiSelectValues('productColor', product.color || '');
    setSingleChoiceValue('productBadmintonFlex', product.badminton_specs?.flex_type || '');
    setSingleChoiceValue('productBadmintonTension', product.badminton_specs?.tension || '');
    setSingleChoiceValue('productBadmintonGrip', product.badminton_specs?.grip_size || '');
    setSingleChoiceValue('productBadmintonWeight', product.badminton_specs?.weight_class || '');

    document.getElementById('productVariantNote').value = product.variant_note || '';
    document.getElementById('productBrand').value = product.brand || '';
    document.getElementById('productSku').value = product.sku || '';
    const barcodeInfoEl = document.getElementById('productBarcodeInfo');
    if (barcodeInfoEl) {
        barcodeInfoEl.textContent = product.barcode ? `Barcode: ${product.barcode}` : 'Barcode will remain blank until this product is saved.';
    }
    document.getElementById('productPrice').value = product.price || 0;
    document.getElementById('productOriginalPrice').value = product.originalPrice || '';
    document.getElementById('productStock').value = product.stock || 0;
    document.getElementById('productStatus').value = product.status || 'active';
    document.getElementById('productBadge').value = product.badge || '';
    document.getElementById('productFeatured').checked = Boolean(product.featured);
    document.getElementById('productDescription').value = product.description || '';
    document.getElementById('productImage').required = false;
    document.getElementById('productImage').value = '';
    document.getElementById('saveProductBtn').textContent = 'UPDATE PRODUCT';
    document.getElementById('cancelEditProductBtn').hidden = false;
    setAdminDraftImagesFromExisting(getExistingProductImageData(product));
    renderAdminImagePreview();

    refreshAllAdminCustomSelects();
    openProductEditModal('edit');
}

function getFilteredAdminProducts() {
    const query = (document.getElementById('adminProductSearch')?.value || '').toLowerCase().trim();
    const category = document.getElementById('adminProductCategoryFilter')?.value || 'all';
    const status = document.getElementById('adminProductStatusFilter')?.value || 'all';
    const stockFilter = document.getElementById('adminProductStockFilter')?.value || 'all';
    const sort = document.getElementById('adminProductSort')?.value || 'newest';

    const filtered = products.filter(product => {
        const stock = Number(product.stock || 0);
        const matchesSearch = !query || [
            product.name,
            product.category,
            product.subcategory,
            product.gender,
            product.size,
            product.color,
            product.brand,
            product.sku,
            product.barcode
        ].some(value => String(value || '').toLowerCase().includes(query));

        const matchesCategory = category === 'all' || product.category === category;
        const matchesStatus = status === 'all' || String(product.status || 'active') === status;
        const matchesStock =
            stockFilter === 'all' ||
            (stockFilter === 'low' && stock > 0 && stock <= 5) ||
            (stockFilter === 'available' && stock > 0) ||
            (stockFilter === 'empty' && stock <= 0);

        return matchesSearch && matchesCategory && matchesStatus && matchesStock;
    });

    return filtered.sort((a, b) => {
        if (sort === 'name-asc') return String(a.name || '').localeCompare(String(b.name || ''));
        if (sort === 'price-asc') return Number(a.price || 0) - Number(b.price || 0);
        if (sort === 'price-desc') return Number(b.price || 0) - Number(a.price || 0);
        if (sort === 'stock-asc') return Number(a.stock || 0) - Number(b.stock || 0);
        return String(b.created_at || b.id || '').localeCompare(String(a.created_at || a.id || ''));
    });
}

function exportAdminProducts() {
    const rows = getFilteredAdminProducts();
    if (!rows.length) return showToast('No products to export.', null, 'warning');

    exportRowsToCsv(
        `products-${new Date().toISOString().slice(0, 10)}.csv`,
        ['ID', 'Name', 'Category', 'Subcategory', 'Status', 'Stock', 'Price', 'SKU', 'Barcode'],
        rows.map(product => [
            product.id,
            product.name,
            product.category,
            product.subcategory,
            product.status || 'active',
            product.stock || 0,
            product.price || 0,
            product.sku || '',
            product.barcode || ''
        ])
    );
    showToast('Product export prepared.');
}


async function loadCompletedSalesTotal() {
    if (!db || !document.getElementById('totalValue')) return;

    const { data, error } = await db
        .from('orders')
        .select('total_amount,status');

    if (error) {
        console.warn('Completed sales total was not loaded:', error.message);
        completedSalesTotal = 0;
        updateAdminStats();
        return;
    }

    completedSalesTotal = (data || []).reduce((sum, order) => {
        const status = String(order.status || '').toLowerCase();
        const isCompleted = ['completed', 'paid', 'complete', 'success'].includes(status);
        return isCompleted ? sum + Number(order.total_amount || 0) : sum;
    }, 0);

    updateAdminStats();
}

async function loadAdminProductInsights() {
    const hasInsightArea =
        document.getElementById('adminFastMovingProducts') ||
        document.getElementById('adminSlowMovingProducts') ||
        document.getElementById('adminLowStockProducts');

    if (!db || !hasInsightArea) return;

    productSalesStats = {};

    try {
        const { data: orders, error: orderError } = await db
            .from('orders')
            .select('id,status')
            .order('created_at', { ascending: false })
            .limit(500);

        if (orderError) throw orderError;

        const completedOrderIds = (orders || [])
            .filter(order => ['completed', 'paid', 'complete', 'success'].includes(String(order.status || '').toLowerCase()))
            .map(order => order.id);

        if (completedOrderIds.length === 0) {
            renderAdminProductInsights();
            return;
        }

        const { data: orderItems, error: itemsError } = await db
            .from('order_items')
            .select('product_id,product_name,quantity')
            .in('order_id', completedOrderIds);

        if (itemsError) throw itemsError;

        (orderItems || []).forEach(item => {
            const id = String(item.product_id || item.product_name || '').trim();
            if (!id) return;

            if (!productSalesStats[id]) {
                productSalesStats[id] = {
                    sold: 0,
                    name: item.product_name || 'Deleted product'
                };
            }

            productSalesStats[id].sold += Number(item.quantity || 0);
        });

        renderAdminProductInsights();
    } catch (error) {
        console.warn('Product insights were not loaded:', error.message);
        productSalesStats = {};
        renderAdminProductInsights(true);
    }
}

function getProductSoldCount(product) {
    const byId = productSalesStats[String(product.id)];
    const byName = productSalesStats[String(product.name)];
    return Number((byId || byName || {}).sold || 0);
}

function renderAdminProductInsights(showSalesWarning = false) {
    const fastList = document.getElementById('adminFastMovingProducts');
    const slowList = document.getElementById('adminSlowMovingProducts');
    const lowStockList = document.getElementById('adminLowStockProducts');

    if (!fastList && !slowList && !lowStockList) return;

    const withSales = products.map(product => ({
        ...product,
        soldCount: getProductSoldCount(product)
    }));

    const fastMoving = withSales
        .filter(product => product.soldCount > 0)
        .sort((a, b) => b.soldCount - a.soldCount)
        .slice(0, 5);

    const slowMoving = withSales
        .filter(product => Number(product.stock || 0) > 0)
        .sort((a, b) => a.soldCount - b.soldCount || Number(b.stock || 0) - Number(a.stock || 0))
        .slice(0, 5);

    const lowStock = withSales
        .filter(product => Number(product.stock || 0) <= 5)
        .sort((a, b) => Number(a.stock || 0) - Number(b.stock || 0))
        .slice(0, 8);

    const renderList = (target, items, emptyText, type) => {
        if (!target) return;

        if (showSalesWarning && type !== 'low') {
            target.innerHTML = `<div class="admin-empty">Run the latest SQL and make sure order records exist.</div>`;
            return;
        }

        if (items.length === 0) {
            target.innerHTML = `<div class="admin-empty">${emptyText}</div>`;
            return;
        }

        target.innerHTML = items.map(product => {
            const stock = Number(product.stock || 0);
            const stockClass = stock <= 5 ? 'red' : 'green';
            const metricText = type === 'low'
                ? `Stock: ${stock}`
                : `Sold: ${Number(product.soldCount || 0)}`;

            return `
                <div class="admin-insight-row">
                    <img src="${escapeHtml(product.image)}" alt="${escapeHtml(product.name)}">
                    <div>
                        <h4>${escapeHtml(product.name)}</h4>
                        <p>${escapeHtml(product.category)} • ${escapeHtml(product.subcategory)} • ${formatPeso(product.price)}</p>
                    </div>
                    <span class="admin-pill ${type === 'low' ? stockClass : 'green'}">${metricText}</span>
                </div>
            `;
        }).join('');
    };

    renderList(fastList, fastMoving, 'No completed sales yet.', 'fast');
    renderList(slowList, slowMoving, 'No active stocked products yet.', 'slow');
    renderList(lowStockList, lowStock, 'No low stock items.', 'low');
}


function updateAdminStats(adminUsers = window.adminUsersCache || []) {
    const lowStock = products.filter(p => Number(p.stock || 0) <= 5).length;

    if (document.getElementById('totalProducts')) {
        document.getElementById('totalProducts').textContent = products.length;
    }

    if (document.getElementById('totalCategories')) {
        document.getElementById('totalCategories').textContent = new Set(products.map(p => p.category)).size;
    }

    if (document.getElementById('totalValue')) {
        document.getElementById('totalValue').textContent = formatPeso(completedSalesTotal);
    }

    if (document.getElementById('lowStockCount')) {
        document.getElementById('lowStockCount').textContent = lowStock;
    }

    if (document.getElementById('totalCustomers')) {
        document.getElementById('totalCustomers').textContent = adminUsers.filter(u => u.role !== 'admin').length;
    }

    if (document.getElementById('totalAdmins')) {
        document.getElementById('totalAdmins').textContent = adminUsers.filter(u => u.role === 'admin').length;
    }

    if (document.getElementById('totalAuditLogs')) {
        document.getElementById('totalAuditLogs').textContent = auditLogs.length;
    }
}

function updateBulkDeleteUI(visibleProducts = getFilteredAdminProducts()) {
    const deleteBtn = document.getElementById('deleteSelectedProductsBtn');
    const selectBtn = document.getElementById('selectAllProductsBtn');
    const countEl = document.getElementById('selectedProductsCount');

    const visibleIds = visibleProducts.map(product => String(product.id));
    const selectedVisibleCount = visibleIds.filter(id => selectedAdminProductIds.has(id)).length;
    const totalSelected = selectedAdminProductIds.size;
    const allVisibleSelected = visibleIds.length > 0 && selectedVisibleCount === visibleIds.length;

    if (deleteBtn) {
        deleteBtn.disabled = totalSelected === 0;
        deleteBtn.innerHTML = `<i class="fas fa-trash"></i> Delete Selected${totalSelected ? ` (${totalSelected})` : ''}`;
    }

    if (selectBtn) {
        selectBtn.textContent = allVisibleSelected ? 'Unselect All' : 'Select All';
        selectBtn.disabled = visibleIds.length === 0;
    }

    if (countEl) {
        countEl.textContent = totalSelected ? `${totalSelected} selected` : 'No selected products';
    }
}

function toggleSelectAllAdminProducts() {
    const filtered = getFilteredAdminProducts();
    const filteredIds = filtered.map(product => String(product.id));
    const allSelected = filteredIds.length > 0 && filteredIds.every(id => selectedAdminProductIds.has(id));

    filteredIds.forEach(id => {
        if (allSelected) {
            selectedAdminProductIds.delete(id);
        } else {
            selectedAdminProductIds.add(id);
        }
    });

    renderAdminProducts();
}

function renderAdminProducts() {
    const list = document.getElementById('adminProductsList');
    const recentList = document.getElementById('adminRecentProducts');

    if (!list && !recentList) return;

    updateAdminStats();
    renderAdminProductInsights();

    const filtered = getFilteredAdminProducts();
    const existingIds = new Set(products.map(product => String(product.id)));
    selectedAdminProductIds = new Set([...selectedAdminProductIds].filter(id => existingIds.has(id)));

    const renderRows = (target, items, allowBulkSelect = false) => {
        if (!target) return;

        target.innerHTML = '';

        if (items.length === 0) {
            target.innerHTML = '<div class="admin-empty">No products found.</div>';
            return;
        }

        items.forEach(product => {
            const row = document.createElement('div');
            row.className = 'admin-product-row';
            row.classList.toggle('selected', selectedAdminProductIds.has(String(product.id)));

            const stockClass = Number(product.stock || 0) <= 5 ? 'red' : 'green';
            const bulkCheck = allowBulkSelect ? `
                <label class="admin-product-select" title="Select product">
                    <input type="checkbox" data-select-product="${product.id}" ${selectedAdminProductIds.has(String(product.id)) ? 'checked' : ''}>
                    <span></span>
                </label>
            ` : '';

            row.innerHTML = `
                ${bulkCheck}
                <img src="${escapeHtml(product.image)}" alt="${escapeHtml(product.name)}">

                <div>
                    <h4>${escapeHtml(product.name)}</h4>
                    <p>
                        ${escapeHtml(product.category)} • 
                        ${escapeHtml(product.subcategory)}
                        ${product.gender ? ' • ' + escapeHtml(product.gender) : ''}
                        ${product.size ? ' • Size ' + escapeHtml(product.size) : ''}
                        ${product.color ? ' • ' + escapeHtml(product.color) : ''}
                        • ${formatPeso(product.price)}
                    </p>

                    <div class="admin-product-meta">
                        <span class="admin-pill">${escapeHtml(product.status || 'active')}</span>
                        <span class="admin-pill ${stockClass}">Stock: ${Number(product.stock || 0)}</span>
                        ${product.featured ? '<span class="admin-pill green">Featured</span>' : ''}
                    </div>
                    ${product.barcode ? `<p class="admin-product-barcode" style="margin:.4rem 0 0; font-size:.92rem; color:#444;">Barcode: <strong>${escapeHtml(product.barcode)}</strong></p>` : ''}
                </div>

                <div class="admin-product-actions">
                    <button class="admin-btn ghost" data-edit-product="${product.id}">
                        <i class="fas fa-pen"></i>
                    </button>

                    <button class="admin-btn danger" data-delete-product="${product.id}">
                        <i class="fas fa-trash"></i>
                    </button>
                </div>
            `;

            row.querySelector('[data-select-product]')?.addEventListener('change', e => {
                const id = String(e.currentTarget.dataset.selectProduct);

                if (e.currentTarget.checked) {
                    selectedAdminProductIds.add(id);
                } else {
                    selectedAdminProductIds.delete(id);
                }

                updateBulkDeleteUI(filtered);
                row.classList.toggle('selected', e.currentTarget.checked);
            });

            row.querySelector('[data-edit-product]')?.addEventListener('click', () => editAdminProduct(product));
            row.querySelector('[data-delete-product]')?.addEventListener('click', e => deleteAdminProduct(product, e.currentTarget));

            target.appendChild(row);
        });
    };

    renderRows(list, filtered, true);
    renderRows(recentList, products.slice(0, 5), false);
    updateBulkDeleteUI(filtered);
}

async function deleteSelectedAdminProducts() {
    const actionBtn = document.getElementById('deleteSelectedProductsBtn');
    const selectedIds = [...selectedAdminProductIds];

    if (selectedIds.length === 0) {
        return showToast('Select products first.', null, 'warning');
    }

    const selectedProducts = products.filter(product => selectedAdminProductIds.has(String(product.id)));
    const confirmed = await showAdminConfirm({
        title: 'Delete selected products?',
        message: `Are you sure you want to delete ${selectedProducts.length} selected product${selectedProducts.length > 1 ? 's' : ''}? This will remove their database records and uploaded photos.`,
        confirmText: 'Yes, Delete All',
        cancelText: 'No, Keep Them',
        danger: true
    });

    if (!confirmed) return;

    setButtonLoading(actionBtn, true, 'Deleting...');

    try {
        const { error } = await db
            .from('products')
            .delete()
            .in('id', selectedIds);

        if (error) throw new Error(error.message);

        const imagePaths = [...new Set(selectedProducts.flatMap(product => getAllProductImagePaths(product)))];

        if (imagePaths.length) {
            await db.storage.from(PRODUCT_IMAGE_BUCKET).remove(imagePaths);
        }

        await Promise.all(selectedProducts.map(product => logAdminAction('delete_product', 'products', product.id, {
            product_name: product.name,
            category: product.category,
            image_path: product.image_path || null,
            bulk_delete: true
        })));

        selectedAdminProductIds.clear();
        showToast(`${selectedProducts.length} product${selectedProducts.length > 1 ? 's' : ''} deleted from database.`);

        await fetchProducts();
        renderAdminProducts();
        updateAdminStats();
    } catch (error) {
        showToast(error.message || 'Could not delete selected products.', null, 'error');
    } finally {
        setButtonLoading(actionBtn, false);
    }
}

async function deleteAdminProduct(product, actionBtn = null) {
    const confirmed = await showAdminConfirm({
        title: 'Delete product?',
        message: `Are you sure you want to delete ${product.name}? This will remove the product record and its uploaded photo.`,
        confirmText: 'Yes, Delete',
        cancelText: 'No, Keep It',
        danger: true
    });

    if (!confirmed) return;

    setButtonLoading(actionBtn, true, 'Deleting...');

    try {
        const { error } = await db
            .from('products')
            .delete()
            .eq('id', product.id);

        if (error) throw new Error(error.message);

        await logAdminAction('delete_product', 'products', product.id, {
            product_name: product.name,
            category: product.category,
            image_path: product.image_path || null
        });

        const imagePaths = getAllProductImagePaths(product);

        if (imagePaths.length) {
            await db.storage.from(PRODUCT_IMAGE_BUCKET).remove(imagePaths);
        }

        selectedAdminProductIds.delete(String(product.id));
        showToast('Product deleted from database.');

        await fetchProducts();
        renderAdminProducts();
        updateAdminStats();
    } catch (error) {
        showToast(error.message || 'Could not delete product.', null, 'error');
    } finally {
        setButtonLoading(actionBtn, false);
    }
}

async function loadAdminCustomers() {
    const tbody = document.getElementById('adminCustomersList');

    if (!tbody) return;

    const { data, error } = await db
        .from('profiles')
        .select('id,email,first_name,last_name,date_of_birth,role,created_at')
        .order('created_at', { ascending: false });

    if (error) {
        tbody.innerHTML = `<tr><td colspan="5">${escapeHtml(error.message)}</td></tr>`;
        return;
    }

    window.adminUsersCache = data || [];

    renderAdminCustomers();
    updateAdminStats(window.adminUsersCache);
}

function renderAdminCustomers() {
    const tbody = document.getElementById('adminCustomersList');

    if (!tbody) return;

    const query = (document.getElementById('adminCustomerSearch')?.value || '').toLowerCase().trim();
    const roleFilter = document.getElementById('adminCustomerRoleFilter')?.value || 'all';
    const sort = document.getElementById('adminCustomerSort')?.value || 'newest';

    const users = (window.adminUsersCache || []).filter(user => {
        const fullName = `${user.first_name || ''} ${user.last_name || ''}`.trim();
        const role = user.role || 'customer';
        const matchesRole = roleFilter === 'all' || role === roleFilter;
        const matchesQuery = !query || [user.email, fullName, role].some(value =>
            String(value || '').toLowerCase().includes(query)
        );

        return matchesRole && matchesQuery;
    }).sort((a, b) => {
        const nameA = `${a.first_name || ''} ${a.last_name || ''}`.trim();
        const nameB = `${b.first_name || ''} ${b.last_name || ''}`.trim();
        if (sort === 'name-asc') return nameA.localeCompare(nameB);
        if (sort === 'email-asc') return String(a.email || '').localeCompare(String(b.email || ''));
        return String(b.created_at || '').localeCompare(String(a.created_at || ''));
    });

    if (users.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5">No accounts found.</td></tr>';
        return;
    }

    tbody.innerHTML = users.map(user => {
        const fullName = `${user.first_name || ''} ${user.last_name || ''}`.trim() || 'No name';
        const created = user.created_at ? new Date(user.created_at).toLocaleDateString() : '-';

        return `
            <tr>
                <td>${escapeHtml(user.email || '-')}</td>
                <td>${escapeHtml(fullName)}</td>
                <td><span class="admin-pill ${user.role === 'admin' ? 'green' : ''}">${escapeHtml(user.role || 'customer')}</span></td>
                <td>${escapeHtml(user.date_of_birth || '-')}</td>
                <td>${escapeHtml(created)}</td>
            </tr>
        `;
    }).join('');
}

function exportAdminCustomers() {
    const tbodyRows = [...document.querySelectorAll('#adminCustomersList tr')];
    const users = (window.adminUsersCache || []).filter(user => {
        const text = `${user.email || ''} ${user.first_name || ''} ${user.last_name || ''} ${user.role || ''}`.toLowerCase();
        const query = (document.getElementById('adminCustomerSearch')?.value || '').toLowerCase().trim();
        const roleFilter = document.getElementById('adminCustomerRoleFilter')?.value || 'all';
        return (!query || text.includes(query)) && (roleFilter === 'all' || (user.role || 'customer') === roleFilter);
    });

    if (!users.length || !tbodyRows.length) return showToast('No customers to export.', null, 'warning');

    exportRowsToCsv(
        `customers-${new Date().toISOString().slice(0, 10)}.csv`,
        ['ID', 'Email', 'First Name', 'Last Name', 'Role', 'Date of Birth', 'Created'],
        users.map(user => [
            user.id,
            user.email,
            user.first_name || '',
            user.last_name || '',
            user.role || 'customer',
            user.date_of_birth || '',
            user.created_at || ''
        ])
    );
    showToast('Customer export prepared.');
}

function fullNameForProfile(user = {}) {
    return `${user.first_name || ''} ${user.last_name || ''}`.trim() || user.email || 'Customer';
}

function getCrmStatusLabel(status) {
    const labels = {
        new: 'New',
        active: 'Active',
        vip: 'VIP',
        follow_up: 'Follow up',
        inactive: 'Inactive'
    };

    return labels[status] || 'New';
}

async function loadAdminCrmContacts() {
    const tbody = document.getElementById('adminCrmContactsList');

    if (!tbody) return;

    const [contactsResult, ordersResult] = await Promise.all([
        db.from('crm_contacts').select('*').order('updated_at', { ascending: false }),
        db.from('orders').select('id,user_id,customer_email,status,total_amount,created_at').order('created_at', { ascending: false })
    ]);

    if (contactsResult.error) {
        tbody.innerHTML = `<tr><td colspan="7">${escapeHtml(contactsResult.error.message)}. Restart the app so the CRM table can be created.</td></tr>`;
        return;
    }

    const orders = ordersResult.error ? [] : (ordersResult.data || []);
    crmContacts = contactsResult.data || [];
    crmOrderStats = orders.reduce((stats, order) => {
        const key = String(order.customer_email || order.user_id || '').toLowerCase();
        if (!key) return stats;

        if (!stats[key]) {
            stats[key] = { orders: 0, spent: 0, lastOrder: '' };
        }

        stats[key].orders += 1;
        stats[key].spent += Number(order.total_amount || 0);

        if (!stats[key].lastOrder || String(order.created_at || '') > stats[key].lastOrder) {
            stats[key].lastOrder = order.created_at || '';
        }

        return stats;
    }, {});

    renderAdminCrmContacts();
}

function getCrmRows() {
    const users = (window.adminUsersCache || []).filter(user => user.role !== 'admin');
    const contactByEmail = new Map(crmContacts.map(contact => [String(contact.email || '').toLowerCase(), contact]));

    return users.map(user => {
        const email = String(user.email || '').toLowerCase();
        const contact = contactByEmail.get(email) || {};
        const orderStats = crmOrderStats[email] || crmOrderStats[String(user.id || '').toLowerCase()] || { orders: 0, spent: 0, lastOrder: '' };

        return {
            id: contact.id || '',
            user_id: user.id,
            email: user.email || contact.email || '',
            full_name: contact.full_name || fullNameForProfile(user),
            phone: contact.phone || '',
            status: contact.status || 'new',
            source: contact.source || 'storefront',
            notes: contact.notes || '',
            last_contacted_at: contact.last_contacted_at || '',
            orders: orderStats.orders,
            spent: orderStats.spent,
            lastOrder: orderStats.lastOrder
        };
    });
}

function renderAdminCrmContacts() {
    const tbody = document.getElementById('adminCrmContactsList');

    if (!tbody) return;

    const query = (document.getElementById('adminCrmSearch')?.value || '').toLowerCase().trim();
    const statusFilter = document.getElementById('adminCrmStatusFilter')?.value || 'all';
    const sort = document.getElementById('adminCrmSort')?.value || 'spent-desc';
    const rows = getCrmRows().filter(contact => {
        const matchesStatus = statusFilter === 'all' || contact.status === statusFilter;
        const matchesQuery = !query || [
            contact.full_name,
            contact.email,
            contact.phone,
            contact.status,
            contact.notes
        ].some(value => String(value || '').toLowerCase().includes(query));

        return matchesStatus && matchesQuery;
    }).sort((a, b) => {
        if (sort === 'orders-desc') return Number(b.orders || 0) - Number(a.orders || 0);
        if (sort === 'name-asc') return String(a.full_name || '').localeCompare(String(b.full_name || ''));
        if (sort === 'last-order-desc') return String(b.lastOrder || '').localeCompare(String(a.lastOrder || ''));
        return Number(b.spent || 0) - Number(a.spent || 0);
    });

    updateCrmStats(getCrmRows());

    if (!rows.length) {
        tbody.innerHTML = '<tr><td colspan="7">No CRM contacts found.</td></tr>';
        return;
    }

    tbody.innerHTML = rows.map(contact => {
        const lastOrder = contact.lastOrder ? new Date(contact.lastOrder).toLocaleDateString() : '-';

        return `
            <tr data-crm-email="${escapeHtml(contact.email)}" data-crm-user="${escapeHtml(contact.user_id || '')}">
                <td>
                    <strong>${escapeHtml(contact.full_name)}</strong><br>
                    <span class="admin-soft-text">${escapeHtml(contact.email || '-')}</span>
                </td>
                <td>
                    <select class="admin-crm-status">
                        ${['new', 'active', 'vip', 'follow_up', 'inactive'].map(status => `
                            <option value="${status}" ${contact.status === status ? 'selected' : ''}>${getCrmStatusLabel(status)}</option>
                        `).join('')}
                    </select>
                </td>
                <td>${Number(contact.orders || 0)}</td>
                <td>${formatPeso(contact.spent || 0)}</td>
                <td>${escapeHtml(lastOrder)}</td>
                <td><textarea class="admin-crm-notes" rows="2" placeholder="Add CRM note">${escapeHtml(contact.notes || '')}</textarea></td>
                <td><button type="button" class="admin-btn ghost" data-save-crm="${escapeHtml(contact.email)}"><i class="fas fa-save"></i> Save</button></td>
            </tr>
        `;
    }).join('');

    tbody.querySelectorAll('[data-save-crm]').forEach(button => {
        button.addEventListener('click', () => saveCrmContact(button.closest('tr'), button));
    });
}

function getFilteredCrmRows() {
    const query = (document.getElementById('adminCrmSearch')?.value || '').toLowerCase().trim();
    const statusFilter = document.getElementById('adminCrmStatusFilter')?.value || 'all';
    return getCrmRows().filter(contact => {
        const matchesStatus = statusFilter === 'all' || contact.status === statusFilter;
        const matchesQuery = !query || [
            contact.full_name,
            contact.email,
            contact.phone,
            contact.status,
            contact.notes
        ].some(value => String(value || '').toLowerCase().includes(query));
        return matchesStatus && matchesQuery;
    });
}

function exportAdminCrm() {
    const rows = getFilteredCrmRows();
    if (!rows.length) return showToast('No CRM contacts to export.', null, 'warning');

    exportRowsToCsv(
        `crm-contacts-${new Date().toISOString().slice(0, 10)}.csv`,
        ['Name', 'Email', 'Phone', 'Status', 'Orders', 'Spent', 'Last Order', 'Notes'],
        rows.map(contact => [
            contact.full_name,
            contact.email,
            contact.phone,
            getCrmStatusLabel(contact.status),
            contact.orders || 0,
            contact.spent || 0,
            contact.lastOrder || '',
            contact.notes || ''
        ])
    );
    showToast('CRM export prepared.');
}

function updateCrmStats(rows = getCrmRows()) {
    const total = rows.length;
    const vip = rows.filter(row => row.status === 'vip').length;
    const followUps = rows.filter(row => row.status === 'follow_up').length;
    const revenue = rows.reduce((sum, row) => sum + Number(row.spent || 0), 0);

    if (document.getElementById('crmTotalContacts')) document.getElementById('crmTotalContacts').textContent = total;
    if (document.getElementById('crmVipContacts')) document.getElementById('crmVipContacts').textContent = vip;
    if (document.getElementById('crmFollowUps')) document.getElementById('crmFollowUps').textContent = followUps;
    if (document.getElementById('crmRevenue')) document.getElementById('crmRevenue').textContent = formatPeso(revenue);
}

async function saveCrmContact(row, button = null) {
    if (!row) return;

    const email = row.dataset.crmEmail || '';
    const userId = row.dataset.crmUser || null;
    const sourceRow = getCrmRows().find(contact => contact.email === email) || {};
    const payload = {
        user_id: userId || null,
        email,
        full_name: sourceRow.full_name || email,
        status: row.querySelector('.admin-crm-status')?.value || 'new',
        notes: row.querySelector('.admin-crm-notes')?.value.trim() || null,
        source: sourceRow.source || 'storefront',
        last_contacted_at: new Date().toISOString()
    };

    setButtonLoading(button, true, 'Saving...');

    const { error } = await db
        .from('crm_contacts')
        .upsert(payload, { onConflict: 'email' });

    if (error) {
        setButtonLoading(button, false);
        return showToast(error.message, null, 'warning');
    }

    await logAdminAction('update_crm_contact', 'crm_contacts', email, {
        customer_email: email,
        status: payload.status
    });

    showToast('CRM contact saved.');
    await loadAdminCrmContacts();
    await loadAdminAuditLogs();
    setButtonLoading(button, false);
}

function cartRowsForDatabase() {
    return cart.map(item => ({
        user_id: currentUser.id,
        product_id: String(item.id),
        product_name: item.name || 'Product',
        category: item.category || item.subcategory || '',
        image_url: item.image || '',
        price: Number(item.price || 0),
        quantity: Math.max(Number(item.quantity || 1), 1),
        updated_at: new Date().toISOString()
    }));
}

function favoriteRowsForDatabase() {
    return wishlist.map(item => {
        const product =
            products.find(p => String(p.id) === String(item.id)) ||
            cart.find(p => String(p.id) === String(item.id)) ||
            item;

        return {
            user_id: currentUser.id,
            product_id: String(product.id),
            product_name: product.name || 'Favorite Product',
            category: product.category || product.subcategory || '',
            image_url: product.image || '',
            price: Number(product.price || 0),
            updated_at: new Date().toISOString()
        };
    });
}

async function saveCustomerBagToDatabase() {
    if (!db || !currentUser) return;

    await db
        .from('customer_bag_items')
        .delete()
        .eq('user_id', currentUser.id);

    const rows = cartRowsForDatabase();

    if (rows.length) {
        await db
            .from('customer_bag_items')
            .upsert(rows, { onConflict: 'user_id,product_id' });
    }
}

async function saveCustomerFavoritesToDatabase() {
    if (!db || !currentUser) return;

    await db
        .from('customer_favorites')
        .delete()
        .eq('user_id', currentUser.id);

    const rows = favoriteRowsForDatabase();

    if (rows.length) {
        await db
            .from('customer_favorites')
            .upsert(rows, { onConflict: 'user_id,product_id' });
    }
}

async function handleCheckoutClick(e) {
    e.preventDefault();
    const btn = e.currentTarget;
    loadCartFromStorageOnly();
    updateUI();

    if (!cart.length) return showToast('Your bag is empty.');

    if (!requireLoginForTransaction('checkout')) return;

    setButtonLoading(btn, true, 'Checking...');
    try {
        await proceedCheckout();
    } finally {
        setButtonLoading(btn, false);
    }
}

function getSelectedPaymentMethod() {
    const selected = document.querySelector('input[name="paymentMethod"]:checked');
    return selected?.value || 'cash_on_delivery';
}

function getCheckoutFieldValue(name) {
    const inputs = [...document.querySelectorAll(`[data-checkout-field="${name}"]`)];
    const source = inputs.find(input => input.offsetParent !== null) || inputs[0];
    return source?.value.trim() || '';
}

function setCheckoutFieldValue(name, value) {
    if (!value) return;
    document.querySelectorAll(`[data-checkout-field="${name}"]`).forEach(input => {
        if (!input.value.trim()) input.value = value;
    });
}

function getCheckoutDetails() {
    const fallbackName = fullNameForProfile(currentProfile || currentUser || {});
    setCheckoutFieldValue('customerName', fallbackName);

    return {
        customerName: getCheckoutFieldValue('customerName') || fallbackName,
        customerPhone: getCheckoutFieldValue('customerPhone'),
        deliveryLocation: getCheckoutFieldValue('deliveryLocation'),
        deliveryNotes: getCheckoutFieldValue('deliveryNotes'),
        paymentMethod: getSelectedPaymentMethod()
    };
}

function validateCheckoutDetails(details) {
    const requirements = [
        ['customerName', details.customerName, 'Customer name is required.'],
        ['customerPhone', details.customerPhone, 'Contact number is required.'],
        ['deliveryLocation', details.deliveryLocation, 'Delivery location is required.']
    ];
    let valid = true;

    requirements.forEach(([name, value, message]) => {
        const fields = [...document.querySelectorAll(`[data-checkout-field="${name}"]`)];
        const target = fields.find(field => field.offsetParent !== null) || fields[0];
        fields.forEach(field => setFieldError(field, ''));
        if (!String(value || '').trim()) {
            setFieldError(target, message);
            valid = false;
        }
    });

    if (details.customerPhone && !/^[0-9+\-\s()]{7,20}$/.test(details.customerPhone)) {
        const phoneField = [...document.querySelectorAll('[data-checkout-field="customerPhone"]')]
            .find(field => field.offsetParent !== null);
        setFieldError(phoneField, 'Enter a valid contact number.');
        valid = false;
    }

    return valid;
}

function getPaymentMethodLabel(method) {
    const labels = {
        cash_on_delivery: 'Cash on Delivery'
    };

    return labels[method] || method || '-';
}

async function confirmCheckoutDetails(details, orderItems) {
    const subtotal = orderItems.reduce((sum, item) => sum + Number(item.price || 0) * Number(item.quantity || 1), 0);
    const itemRows = orderItems.map(item => `
        <div class="checkout-confirm-item">
            <span>${escapeHtml(item.product_name)}</span>
            <strong>${Number(item.quantity || 1)} x ${formatPeso(item.price || 0)}</strong>
        </div>
    `).join('');

    if (!window.Swal) {
        return showAdminConfirm({
            title: 'Confirm delivery details',
            message: `Deliver to ${details.customerName}, ${details.deliveryLocation}. Payment: ${getPaymentMethodLabel(details.paymentMethod)}.`,
            confirmText: 'Place Order',
            cancelText: 'Review Details',
            type: 'warning'
        });
    }

    const result = await Swal.fire({
        title: 'Confirm delivery details',
        icon: 'question',
        html: `
            <div class="checkout-confirm">
                <div class="checkout-confirm-grid">
                    <div><span>Customer</span><strong>${escapeHtml(details.customerName)}</strong></div>
                    <div><span>Contact</span><strong>${escapeHtml(details.customerPhone)}</strong></div>
                    <div class="wide"><span>Delivery Location</span><strong>${escapeHtml(details.deliveryLocation)}</strong></div>
                    <div><span>Payment Status</span><strong>Pending collection</strong></div>
                    <div><span>Payment Method</span><strong>${escapeHtml(getPaymentMethodLabel(details.paymentMethod))}</strong></div>
                    ${details.deliveryNotes ? `<div class="wide"><span>Delivery Notes</span><strong>${escapeHtml(details.deliveryNotes)}</strong></div>` : ''}
                </div>
                <div class="checkout-confirm-items">${itemRows}</div>
                <div class="checkout-confirm-total"><span>Total</span><strong>${formatPeso(subtotal)}</strong></div>
            </div>
        `,
        showCancelButton: true,
        confirmButtonText: 'Place Order',
        cancelButtonText: 'Review Details',
        reverseButtons: true,
        focusCancel: true,
        buttonsStyling: false,
        customClass: {
            popup: 'bsh-swal-popup checkout-confirm-popup',
            title: 'bsh-swal-title',
            htmlContainer: 'bsh-swal-text',
            confirmButton: 'bsh-swal-btn primary',
            cancelButton: 'bsh-swal-btn secondary'
        },
        showClass: { popup: 'swal2-show bsh-swal-show' },
        hideClass: { popup: 'swal2-hide bsh-swal-hide' }
    });

    return Boolean(result.isConfirmed);
}

async function proceedCheckout() {
    if (!db) return showToast('Local database is not ready yet. Please restart the app.');
    if (!currentUser) return openAuthModal(false);
    if (!cart.length) return showToast('Your bag is empty.');

    await saveCustomerBagToDatabase();
    await saveCustomerFavoritesToDatabase();

    const orderItems = cart.map(item => ({
        product_id: item.id ? String(item.id) : null,
        product_name: item.name || 'Product',
        quantity: Math.max(Number(item.quantity || 1), 1),
        price: Number(item.price || 0)
    }));

    const checkoutDetails = getCheckoutDetails();
    if (!validateCheckoutDetails(checkoutDetails)) {
        return showToast('Please complete customer name, contact number, and delivery location before checkout.', null, 'warning');
    }

    const confirmed = await confirmCheckoutDetails(checkoutDetails, orderItems);
    if (!confirmed) return;

    const { data: order, error: checkoutError } = await db.checkout(orderItems, checkoutDetails);

    if (checkoutError) return showToast(checkoutError.message);

    cart = [];
    saveToStorage();

    await saveCustomerBagToDatabase();

    updateUI();

    showToast(`Order ${String(order?.id || '').slice(0, 8)} placed. Reference: ${order?.payment_reference || 'pending'}.`);

    if (document.getElementById('cartSidebar')) {
        document.getElementById('cartSidebar').classList.remove('active');
    }
}

function initAdminPasswordToggles() {
    document.querySelectorAll('.admin-password-toggle').forEach(btn => {
        btn.addEventListener('click', () => {
            const targetId = btn.dataset.target;
            const input = document.getElementById(targetId);
            const icon = btn.querySelector('i');

            if (!input) return;

            const show = input.type === 'password';

            input.type = show ? 'text' : 'password';
            icon?.classList.toggle('fa-eye', !show);
            icon?.classList.toggle('fa-eye-slash', show);
        });
    });
}

async function logAdminAction(action, tableName, recordId, details = {}) {
    if (!db || !currentUser || currentProfile?.role !== 'admin') return;

    const payload = {
        admin_id: currentUser.id,
        admin_email: currentUser.email,
        action,
        table_name: tableName,
        record_id: recordId ? String(recordId) : null,
        details
    };

    const { error } = await db
        .from('audit_logs')
        .insert(payload);

    if (error) console.warn('Audit log was not saved:', error.message);
}

async function updateAdminPassword(e) {
    e.preventDefault();

    const newPassword = document.getElementById('adminNewPassword')?.value || '';
    const confirmPassword = document.getElementById('adminConfirmPassword')?.value || '';
    const btn = document.getElementById('updateAdminPasswordBtn');

    if (newPassword.length < 6) return showToast('Password must have at least 6 characters.');
    if (newPassword !== confirmPassword) return showToast('Passwords do not match.');

    btn.disabled = true;
    btn.textContent = 'UPDATING...';

    try {
        const { error } = await db.auth.updateUser({ password: newPassword });

        if (error) throw new Error(error.message);

        await logAdminAction('update_password', 'auth.users', currentUser.id, {
            admin_email: currentUser.email,
            note: 'Admin changed own password. Password value is not stored.'
        });

        e.currentTarget.reset();

        await loadAdminAuditLogs();

        showToast('Admin password updated and saved in audit log.');
    } catch (err) {
        showToast(err.message || 'Could not update password.');
    } finally {
        btn.disabled = false;
        btn.textContent = 'UPDATE PASSWORD';
    }
}

async function loadAdminAuditLogs(triggerButton = null) {
    const tbody = document.getElementById('adminAuditLogsList');

    if (!tbody) return;

    setButtonLoading(triggerButton, true, 'Refreshing...');

    const { data, error } = await db
        .from('audit_logs')
        .select('id,admin_id,admin_email,action,table_name,record_id,details,created_at')
        .order('created_at', { ascending: false })
        .limit(100);

    setButtonLoading(triggerButton, false);

    if (error) {
        tbody.innerHTML = `<tr><td colspan="6">${escapeHtml(error.message)}. Run the updated SQL first.</td></tr>`;
        return;
    }

    auditLogs = data || [];

    renderAdminAuditLogs();
    updateAdminStats();
}

function renderAdminAuditLogs() {
    const tbody = document.getElementById('adminAuditLogsList');

    if (!tbody) return;

    const query = (document.getElementById('adminAuditSearch')?.value || '').toLowerCase().trim();
    const actionFilter = document.getElementById('adminAuditActionFilter')?.value || 'all';
    const sort = document.getElementById('adminAuditSort')?.value || 'newest';

    const logs = auditLogs.filter(log => {
        const matchesAction = actionFilter === 'all' || log.action === actionFilter;
        const detailsText = JSON.stringify(log.details || {});
        const matchesSearch = !query || [
            log.admin_email,
            log.action,
            log.table_name,
            log.record_id,
            detailsText
        ].some(value => String(value || '').toLowerCase().includes(query));

        return matchesAction && matchesSearch;
    }).sort((a, b) => {
        if (sort === 'oldest') return String(a.created_at || '').localeCompare(String(b.created_at || ''));
        if (sort === 'action-asc') return String(a.action || '').localeCompare(String(b.action || ''));
        return String(b.created_at || '').localeCompare(String(a.created_at || ''));
    });

    if (logs.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6">No audit logs found.</td></tr>';
        return;
    }

    tbody.innerHTML = logs.map(log => {
        const created = log.created_at ? new Date(log.created_at).toLocaleString() : '-';
        const details = JSON.stringify(log.details || {}, null, 0);

        return `
            <tr>
                <td>${escapeHtml(created)}</td>
                <td>${escapeHtml(log.admin_email || log.admin_id || '-')}</td>
                <td><span class="admin-pill green">${escapeHtml(log.action || '-')}</span></td>
                <td>${escapeHtml(log.table_name || '-')}</td>
                <td>${escapeHtml(log.record_id ? String(log.record_id).slice(0, 12) : '-')}</td>
                <td class="admin-log-details">${escapeHtml(details)}</td>
            </tr>
        `;
    }).join('');
}

function getFilteredAuditLogs() {
    const query = (document.getElementById('adminAuditSearch')?.value || '').toLowerCase().trim();
    const actionFilter = document.getElementById('adminAuditActionFilter')?.value || 'all';
    return auditLogs.filter(log => {
        const matchesAction = actionFilter === 'all' || log.action === actionFilter;
        const detailsText = JSON.stringify(log.details || {});
        const matchesSearch = !query || [
            log.admin_email,
            log.action,
            log.table_name,
            log.record_id,
            detailsText
        ].some(value => String(value || '').toLowerCase().includes(query));
        return matchesAction && matchesSearch;
    });
}

function exportAdminAuditLogs() {
    const rows = getFilteredAuditLogs();
    if (!rows.length) return showToast('No audit logs to export.', null, 'warning');

    exportRowsToCsv(
        `audit-logs-${new Date().toISOString().slice(0, 10)}.csv`,
        ['Date', 'Admin', 'Action', 'Table', 'Record', 'Details'],
        rows.map(log => [
            log.created_at || '',
            log.admin_email || log.admin_id || '',
            log.action || '',
            log.table_name || '',
            log.record_id || '',
            JSON.stringify(log.details || {})
        ])
    );
    showToast('Audit export prepared.');
}

async function loadAdminOrders(triggerButton = null) {
    const tbody = document.getElementById('adminOrdersList');

    if (!tbody) return;

    setButtonLoading(triggerButton, true, 'Refreshing...');

    const { data, error } = await db
        .from('orders')
        .select('id,user_id,customer_email,customer_name,customer_phone,delivery_location,delivery_notes,status,payment_method,payment_status,payment_reference,total_amount,created_at')
        .order('created_at', { ascending: false })
        .limit(50);

    setButtonLoading(triggerButton, false);

    if (error) {
        tbody.innerHTML = '<tr><td colspan="8">No orders yet. The orders table is ready after you run the updated SQL.</td></tr>';
        return;
    }

    adminOrders = data || [];
    renderAdminOrders();
}

function getFilteredAdminOrders() {
    const query = (document.getElementById('adminOrderSearch')?.value || '').toLowerCase().trim();
    const statusFilter = document.getElementById('adminOrderStatusFilter')?.value || 'all';
    const paymentFilter = document.getElementById('adminOrderPaymentFilter')?.value || 'all';
    const dateFrom = document.getElementById('adminOrderDateFrom')?.value || '';
    const dateTo = document.getElementById('adminOrderDateTo')?.value || '';
    const sort = document.getElementById('adminOrderSort')?.value || 'newest';

    return adminOrders.filter(order => {
        const haystack = [
            order.id,
            order.payment_reference,
            order.customer_name,
            order.customer_email,
            order.customer_phone,
            order.delivery_location,
            order.delivery_notes,
            order.status,
            order.payment_status,
            getPaymentMethodLabel(order.payment_method)
        ].join(' ').toLowerCase();
        const createdDay = order.created_at ? new Date(order.created_at).toISOString().slice(0, 10) : '';
        const matchesQuery = !query || haystack.includes(query);
        const matchesStatus = statusFilter === 'all' || String(order.status || '').toLowerCase() === statusFilter;
        const matchesPayment = paymentFilter === 'all' || String(order.payment_status || '').toLowerCase() === paymentFilter;
        const matchesFrom = !dateFrom || (createdDay && createdDay >= dateFrom);
        const matchesTo = !dateTo || (createdDay && createdDay <= dateTo);
        return matchesQuery && matchesStatus && matchesPayment && matchesFrom && matchesTo;
    }).sort((a, b) => {
        if (sort === 'oldest') return String(a.created_at || '').localeCompare(String(b.created_at || ''));
        if (sort === 'total-desc') return Number(b.total_amount || 0) - Number(a.total_amount || 0);
        if (sort === 'total-asc') return Number(a.total_amount || 0) - Number(b.total_amount || 0);
        return String(b.created_at || '').localeCompare(String(a.created_at || ''));
    });
}

function renderAdminOrders() {
    const tbody = document.getElementById('adminOrdersList');
    if (!tbody) return;

    const rows = getFilteredAdminOrders();

    if (!rows.length) {
        tbody.innerHTML = '<tr><td colspan="8">No orders yet.</td></tr>';
        return;
    }

    tbody.innerHTML = rows.map(order => {
        const created = order.created_at ? new Date(order.created_at).toLocaleString() : '-';
        const paymentStatusClass = String(order.payment_status || '').toLowerCase() === 'paid' ? 'green' : '';
        const orderStatusClass = ['completed', 'paid', 'complete', 'success'].includes(String(order.status || '').toLowerCase()) ? 'green' : '';
        const deliveryDetails = [
            order.delivery_location,
            order.delivery_notes ? `Notes: ${order.delivery_notes}` : ''
        ].filter(Boolean).join(' | ');

        return `
            <tr>
                <td>
                    <strong>${escapeHtml(String(order.id).slice(0, 8).toUpperCase())}</strong><br>
                    <span class="admin-soft-text">${escapeHtml(order.payment_reference || '-')}</span>
                </td>
                <td>
                    <strong>${escapeHtml(order.customer_name || 'Customer')}</strong><br>
                    <span class="admin-soft-text">${escapeHtml(order.customer_email || order.user_id || '-')}</span>
                </td>
                <td>${escapeHtml(order.customer_phone || '-')}</td>
                <td class="admin-delivery-cell">${escapeHtml(deliveryDetails || '-')}</td>
                <td><span class="admin-pill ${orderStatusClass}">${escapeHtml(order.status || 'pending')}</span></td>
                <td>
                    ${escapeHtml(getPaymentMethodLabel(order.payment_method))}<br>
                    <span class="admin-pill ${paymentStatusClass}">${escapeHtml(order.payment_status || 'pending')}</span>
                </td>
                <td>${formatPeso(order.total_amount || 0)}</td>
                <td>${escapeHtml(created)}</td>
            </tr>
        `;
    }).join('');
}

function exportAdminOrders() {
    const rows = getFilteredAdminOrders();
    if (!rows.length) return showToast('No orders to export.', null, 'warning');

    exportRowsToCsv(
        `orders-${new Date().toISOString().slice(0, 10)}.csv`,
        ['Order ID', 'Reference', 'Customer', 'Email', 'Phone', 'Delivery', 'Notes', 'Status', 'Payment Method', 'Payment Status', 'Total', 'Created'],
        rows.map(order => [
            order.id,
            order.payment_reference || '',
            order.customer_name || '',
            order.customer_email || '',
            order.customer_phone || '',
            order.delivery_location || '',
            order.delivery_notes || '',
            order.status || '',
            getPaymentMethodLabel(order.payment_method),
            order.payment_status || '',
            order.total_amount || 0,
            order.created_at || ''
        ])
    );
    showToast('Order export prepared.');
}

function renderBagLandingPage() {
    const list = document.getElementById('bagPageItems');
    if (!list) return;

    const countEl = document.getElementById('bagPageCount');
    const subtotalEl = document.getElementById('bagPageSubtotal');
    const totalEl = document.getElementById('bagPageTotal');
    const clearBtn = document.getElementById('clearBagBtn');

    const itemCount = cart.reduce((sum, item) => sum + Number(item.quantity || 0), 0);
    const total = cart.reduce((sum, item) => sum + Number(item.price || 0) * Number(item.quantity || 1), 0);

    if (countEl) countEl.textContent = `(${itemCount} ${itemCount === 1 ? 'item' : 'items'})`;
    if (subtotalEl) subtotalEl.textContent = formatPeso(total);
    if (totalEl) totalEl.textContent = formatPeso(total);

    if (clearBtn && !clearBtn.dataset.bound) {
        clearBtn.dataset.bound = '1';
        clearBtn.addEventListener('click', async () => {
            if (!requireLoginForTransaction('update your bag')) return;
            if (!cart.length) return showToast('Your bag is already empty.');
            const confirmed = await showAdminConfirm({
                title: 'Clear your bag?',
                message: 'This will remove every item currently saved in your bag.',
                confirmText: 'Clear Bag',
                cancelText: 'Keep Items',
                danger: true
            });
            if (!confirmed) return;
            cart = [];
            saveToStorage();
            saveCustomerBagToDatabase();
            updateUI();
            showToast('Bag cleared.');
        });
    }

    if (!cart.length) {
        list.innerHTML = `
            <div class="bag-empty-state">
                <i class="fas fa-shopping-bag"></i>
                <h3>Your bag is empty</h3>
                <p>Start shopping and your selected products will show here.</p>
                <a href="index.html#collection">Shop Products</a>
            </div>
        `;
        return;
    }

    list.innerHTML = '';

    cart.forEach(item => {
        const cartKey = getCartItemKey(item);
        const selectedColor = item.selectedColor || item.color || '';
        const selectedSize = item.selectedSize || item.size || '';
        const quantity = Number(item.quantity || 1);
        const lineTotal = Number(item.price || 0) * quantity;
        const availableStock = getAvailableStock(item);
        const plusDisabled = quantity >= availableStock || availableStock <= 0;

        const row = document.createElement('article');
        row.className = 'bag-page-item';
        row.innerHTML = `
            <img class="bag-page-image" src="${escapeHtml(item.image)}" alt="${escapeHtml(item.name)}">
            <div class="bag-page-info">
                <p class="bag-page-meta">${escapeHtml(item.category || 'Product')}</p>
                <h3>${escapeHtml(item.name || 'Product')}</h3>
                <div class="bag-page-variant">
                    ${selectedColor ? `<span>Color: ${escapeHtml(selectedColor)}</span>` : ''}
                    ${selectedSize ? `<span>Size: ${escapeHtml(selectedSize)}</span>` : ''}
                    <span>Stock left: ${availableStock}</span>
                </div>
                <p class="bag-page-price">${formatPeso(lineTotal)}</p>
            </div>
            <div class="bag-page-actions">
                <div class="bag-qty-control" aria-label="Quantity controls">
                    <button type="button" data-bag-minus="${escapeHtml(cartKey)}" ${quantity <= 1 ? 'disabled aria-disabled="true"' : ''}>−</button>
                    <span>${quantity}</span>
                    <button type="button" data-bag-plus="${escapeHtml(cartKey)}" ${plusDisabled ? 'disabled aria-disabled="true"' : ''}>+</button>
                </div>
                <button type="button" class="bag-remove-btn" data-bag-remove="${escapeHtml(cartKey)}" aria-label="Remove item">
                    <i class="fas fa-trash-alt"></i>
                </button>
            </div>
        `;

        row.querySelector('[data-bag-minus]')?.addEventListener('click', () => updateQuantity(cartKey, -1));
        row.querySelector('[data-bag-plus]')?.addEventListener('click', () => updateQuantity(cartKey, 1));
        row.querySelector('[data-bag-remove]')?.addEventListener('click', () => removeFromCart(cartKey));

        list.appendChild(row);
    });
}
