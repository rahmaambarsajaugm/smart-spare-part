/* =========================================================
   UNITED TRACTORS SPARE PART MONITORING
   GOOGLE SHEET + ROLE ACCESS
   MEKANIK: view only | PIC PLANNER & SPV: full access
========================================================= */

const DATA_KEY = "UT_SPAREPART_OFFLINE_DATA_V1";
const HISTORY_KEY = "UT_SPAREPART_OFFLINE_HISTORY_V1";
const SESSION_KEY = "UT_SPAREPART_ROLE_SESSION_V1";
const API_URL = "https://script.google.com/macros/s/AKfycbz8OelMQA9rrRUogxatW0EZXmtdWZV_iNkAzVQTSmmOdxPqCZTONwqVbIBlXwzAFOagFQ/exec";
const AUTO_REFRESH_MS = 10000;

let spareParts = loadJSON(DATA_KEY, []);
let history = loadJSON(HISTORY_KEY, []);
let googleSheetConnected = false;
let isWriting = false;
let editingOriginalPartNumber = "";
let authToken = "";
let currentRole = "";
let currentRoleLabel = "Pengguna";

const $ = id => document.getElementById(id);
const tableBody = $("sparePartTableBody");
const emptyState = $("emptyState");
const visibleDataCount = $("visibleDataCount");
const totalDataCount = $("totalDataCount");
const searchInput = $("searchInput");
const btnResetFilter = $("btnResetFilter");
const totalParts = $("totalParts");
const totalStock = $("totalStock");
const stockInToday = $("stockInToday");
const stockOutToday = $("stockOutToday");
const modal = $("partModal");
const btnAdd = $("btnAddPart");
const btnClose = $("btnCloseModal");
const btnCancel = $("btnCancel");
const form = $("sparePartForm");
const modalTitle = $("modalTitle");
const partId = $("partId");
const partNumber = $("partNumber");
const partName = $("partName");
const partCategory = $("partCategory");
const partLocation = $("partLocation");
const partStock = $("partStock");
const categorySuggestionBox = $("categorySuggestionBox");
const historyTableBody = $("historyTableBody");
const historyEmpty = $("historyEmpty");
const historyCount = $("historyCount");
const btnRefreshHistory = $("btnRefreshHistory");

function loadJSON(key, fallback) {
    try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
    } catch (_) { return fallback; }
}

function saveCache() {
    localStorage.setItem(DATA_KEY, JSON.stringify(spareParts));
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
}

function saveSession() {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({ token: authToken, role: currentRole, roleLabel: currentRoleLabel }));
}

function restoreSession() {
    try {
        const raw = sessionStorage.getItem(SESSION_KEY);
        if (!raw) return false;
        const s = JSON.parse(raw);
        authToken = String(s.token || "");
        currentRole = String(s.role || "");
        currentRoleLabel = String(s.roleLabel || "Pengguna");
        return Boolean(authToken);
    } catch (_) { return false; }
}

function clearSession() {
    authToken = "";
    currentRole = "";
    currentRoleLabel = "Pengguna";
    sessionStorage.removeItem(SESSION_KEY);
}

function isFullAccess() { return currentRole === "PIC" || currentRole === "SPV"; }

function normalizePart(item, index = 0) {
    return {
        id: Number(item.id) || index + 1,
        part_number: String(item.part_number ?? item.partNumber ?? "").trim(),
        nama_part: String(item.nama_part ?? item.partName ?? item.nama ?? "").trim(),
        unit: String(item.unit ?? "").trim(),
        kategori: String(item.kategori ?? item.category ?? "").trim(),
        lokasi: String(item.lokasi ?? item.location ?? "").trim(),
        stock: Math.max(0, Number(item.stock) || 0)
    };
}
spareParts = spareParts.map((x, i) => normalizePart(x, i));

function updateConnectionStatus(isOnline) {
    const text = $("connectionText");
    const badge = $("connectionBadge");
    if (text) text.textContent = `PT United Tractors • ${isOnline ? "Online" : "Offline"}`;
    if (badge) {
        badge.title = isOnline ? "Terhubung ke Google Sheet" : "Tidak terhubung ke Google Sheet";
        badge.innerHTML = isOnline
            ? '<i class="fa-solid fa-wifi"></i> Online'
            : '<i class="fa-solid fa-triangle-exclamation"></i> Offline';
    }
}

function applyRoleUI() {
    const roleLabel = $("roleLabel");
    const btnLogout = $("btnRoleLogout");
    const tools = document.querySelector(".offline-tools");
    if (roleLabel) roleLabel.textContent = currentRoleLabel || "Pengguna";
    if (btnLogout) btnLogout.style.display = authToken ? "inline-flex" : "none";
    if (btnAdd) btnAdd.style.display = isFullAccess() ? "inline-flex" : "none";
    if (tools) tools.style.display = isFullAccess() ? "flex" : "none";
    renderTable();
}

function showLogin(message = "") {
    updateConnectionStatus(false);
    const overlay = $("roleLoginOverlay");
    const err = $("roleLoginError");
    if (err) err.textContent = message;
    if (overlay) overlay.classList.remove("is-hidden");
    applyRoleUI();
}

function hideLogin() {
    const overlay = $("roleLoginOverlay");
    const err = $("roleLoginError");
    if (err) err.textContent = "";
    if (overlay) overlay.classList.add("is-hidden");
    applyRoleUI();
}

async function sha256Hex(text) {
    const bytes = new TextEncoder().encode(text);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function apiGet(params, { includeToken = true } = {}) {
    const query = new URLSearchParams();
    Object.entries(params || {}).forEach(([key, value]) => query.append(key, value == null ? "" : String(value)));
    if (includeToken && authToken) query.append("token", authToken);
    query.append("t", String(Date.now()));
    const response = await fetch(`${API_URL}?${query.toString()}`, { method: "GET", cache: "no-store", redirect: "follow" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    if (!payload || payload.success !== true) throw new Error(payload?.message || "Permintaan ke Google Sheet gagal.");
    return payload;
}

async function login(role, pin) {
    const pinHash = await sha256Hex(pin);
    const payload = await apiGet({ action: "login", role, pin_hash: pinHash }, { includeToken: false });
    authToken = payload.token;
    currentRole = payload.role;
    currentRoleLabel = payload.role_label || payload.role;
    saveSession();
    hideLogin();
    await loadFromGoogleSheet();
}

async function validateSession() {
    if (!authToken) return false;
    try {
        const payload = await apiGet({ action: "session" });
        currentRole = payload.role;
        currentRoleLabel = payload.role_label || payload.role;
        saveSession();
        hideLogin();
        return true;
    } catch (_) {
        clearSession();
        showLogin("Sesi sudah berakhir. Silakan login kembali.");
        return false;
    }
}

async function logout() {
    const oldToken = authToken;
    clearSession();
    googleSheetConnected = false;
    updateConnectionStatus(false);
    if (oldToken) {
        try {
            const query = new URLSearchParams({ action: "logout", token: oldToken, t: String(Date.now()) });
            await fetch(`${API_URL}?${query.toString()}`, { method: "GET", cache: "no-store", redirect: "follow" });
        } catch (_) {}
    }
    showLogin();
}

async function loadFromGoogleSheet({ silent = false } = {}) {
    if (isWriting || !authToken) return false;
    try {
        const payload = await apiGet({ action: "getData" });
        spareParts = payload.data.map((item, index) => normalizePart(item, index));
        if (Array.isArray(payload.history)) history = payload.history;
        if (payload.role) currentRole = payload.role;
        if (payload.role_label) currentRoleLabel = payload.role_label;
        googleSheetConnected = true;
        updateConnectionStatus(true);
        saveSession();
        saveCache();
        applyRoleUI();
        renderHistory();
        updateSummary();
        if (!silent) showToast("Terhubung", `${spareParts.length} spare part dimuat dari Google Sheet.`);
        return true;
    } catch (error) {
        googleSheetConnected = false;
        updateConnectionStatus(false);
        console.error("Gagal membaca Google Sheet:", error);
        if (/login|sesi/i.test(error.message)) {
            clearSession();
            showLogin("Sesi sudah berakhir. Silakan login kembali.");
        } else if (!silent) {
            alert("Dashboard belum bisa membaca Google Sheet. Data cache terakhir tetap ditampilkan.\n\n" + error.message);
        }
        return false;
    }
}

async function postToGoogleSheet(params) {
    if (!isFullAccess()) throw new Error("Role ini hanya memiliki akses lihat.");
    if (isWriting) throw new Error("Transaksi sebelumnya masih diproses. Tunggu sebentar.");
    isWriting = true;
    try {
        const payload = await apiGet(params);
        googleSheetConnected = true;
        updateConnectionStatus(true);
        return payload;
    } catch (error) {
        googleSheetConnected = false;
        updateConnectionStatus(false);
        if (/login|sesi/i.test(error.message)) {
            clearSession();
            showLogin("Sesi sudah berakhir. Silakan login kembali.");
        }
        throw error;
    } finally { isWriting = false; }
}

function requireConnection() {
    if (!authToken) { showLogin("Silakan login terlebih dahulu."); return false; }
    if (googleSheetConnected) return true;
    alert("Dashboard belum terhubung ke Google Sheet. Pastikan internet aktif lalu refresh halaman.");
    return false;
}

function requireFullAccess() {
    if (!requireConnection()) return false;
    if (isFullAccess()) return true;
    alert("Mekanik hanya memiliki akses lihat.");
    return false;
}

function safeText(value) {
    return String(value ?? "-").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

function showDate() {
    const el = $("currentDate");
    if (el) el.textContent = new Date().toLocaleDateString("id-ID", { day: "numeric", month: "long", year: "numeric" });
}

function todayKey(date = new Date()) {
    const d = new Date(date);
    if (Number.isNaN(d.getTime())) return "";
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}

function updateSummary() {
    const stockTotal = spareParts.reduce((sum, item) => sum + (Number(item.stock) || 0), 0);
    const today = todayKey();
    const todayHistory = history.filter(x => todayKey(x.date) === today);
    const masuk = todayHistory.filter(x => x.type === "in").reduce((s,x) => s + (Number(x.qty) || 0), 0);
    const keluar = todayHistory.filter(x => x.type === "out").reduce((s,x) => s + (Number(x.qty) || 0), 0);
    if (totalParts) totalParts.textContent = spareParts.length.toLocaleString("id-ID");
    if (totalStock) totalStock.textContent = stockTotal.toLocaleString("id-ID");
    if (stockInToday) stockInToday.textContent = masuk.toLocaleString("id-ID");
    if (stockOutToday) stockOutToday.textContent = keluar.toLocaleString("id-ID");
}

function renderTable() {
    if (!tableBody) return;
    const keyword = (searchInput?.value || "").trim().toLowerCase();
    const filtered = spareParts.filter(item => [item.part_number, item.nama_part, item.kategori, item.lokasi].join(" ").toLowerCase().includes(keyword));
    tableBody.innerHTML = filtered.map((item, index) => `
        <tr>
            <td>${index + 1}</td>
            <td><strong>${safeText(item.part_number)}</strong></td>
            <td>${safeText(item.nama_part)}</td>
            <td>${safeText(item.kategori)}</td>
            <td>${safeText(item.lokasi)}</td>
            <td>${Number(item.stock || 0).toLocaleString("id-ID")}</td>
            <td><div class="action-buttons">${isFullAccess() ? `
                <button type="button" class="stock-action-btn stock-in" onclick="stockIn(${item.id})" title="Stock Masuk"><span>+</span> Masuk</button>
                <button type="button" class="stock-action-btn stock-out" onclick="stockOut(${item.id})" title="Stock Keluar"><span>−</span> Keluar</button>
                <button type="button" class="icon-action-btn edit-btn" onclick="editPart(${item.id})" title="Edit Spare Part"><i class="fa-solid fa-pen"></i></button>
                <button type="button" class="icon-action-btn delete-btn" onclick="deletePart(${item.id})" title="Hapus Spare Part"><i class="fa-solid fa-trash"></i></button>` : '<span class="readonly-note"><i class="fa-solid fa-eye"></i> Lihat saja</span>'}
            </div></td>
        </tr>`).join("");
    if (emptyState) emptyState.style.display = filtered.length ? "none" : "block";
    if (visibleDataCount) visibleDataCount.textContent = filtered.length.toLocaleString("id-ID");
    if (totalDataCount) totalDataCount.textContent = spareParts.length.toLocaleString("id-ID");
}

function renderHistory() {
    if (!historyTableBody) return;
    const rows = history.slice().sort((a,b) => new Date(b.date) - new Date(a.date)).slice(0, 100);
    historyTableBody.innerHTML = rows.map(x => `
        <tr>
            <td>${new Date(x.date).toLocaleString("id-ID", {dateStyle:"short", timeStyle:"short"})}</td>
            <td><strong>${safeText(x.part_number)}</strong></td>
            <td>${safeText(x.nama_part)}</td>
            <td><span class="${x.type === "in" ? "history-in" : "history-out"}">${x.type === "in" ? "STOCK MASUK" : "STOCK KELUAR"}</span></td>
            <td>${Number(x.qty || 0).toLocaleString("id-ID")}</td>
            <td>${safeText(x.note || "-")}</td>
        </tr>`).join("");
    if (historyEmpty) historyEmpty.style.display = rows.length ? "none" : "block";
    if (historyCount) historyCount.textContent = rows.length.toLocaleString("id-ID");
}

function openModal(item = null) {
    if (!isFullAccess() || !modal || !form) return;
    form.reset();
    editingOriginalPartNumber = item?.part_number || "";
    partId.value = item ? item.id : "";
    partNumber.value = item?.part_number || "";
    partName.value = item?.nama_part || "";
    partCategory.value = item?.kategori || "";
    partLocation.value = item?.lokasi || "";
    partStock.value = item ? item.stock : "";
    if (modalTitle) modalTitle.textContent = item ? "Edit Spare Part" : "Tambah Spare Part";
    modal.style.display = "flex";
}

function closeModal() {
    if (modal) modal.style.display = "none";
    if (categorySuggestionBox) categorySuggestionBox.style.display = "none";
    editingOriginalPartNumber = "";
}

function editPart(id) {
    if (!requireFullAccess()) return;
    const item = spareParts.find(x => Number(x.id) === Number(id));
    if (item) openModal(item);
}

async function deletePart(id) {
    if (!requireFullAccess()) return;
    const item = spareParts.find(x => Number(x.id) === Number(id));
    if (!item) return;
    if (!confirm(`Yakin ingin menghapus spare part?\n\n${item.part_number} — ${item.nama_part}`)) return;
    try {
        const result = await postToGoogleSheet({ action: "deletePart", part_number: item.part_number });
        await loadFromGoogleSheet({ silent: true });
        showToast("Berhasil", result.message || "Data spare part dihapus.");
    } catch (error) {
        alert("Hapus gagal:\n" + error.message);
        await loadFromGoogleSheet({ silent: true });
    }
}

async function updateStock(id, type) {
    if (!requireFullAccess()) return;
    const item = spareParts.find(x => Number(x.id) === Number(id));
    if (!item) return;
    const label = type === "in" ? "STOCK MASUK" : "STOCK KELUAR";
    const raw = prompt(`${label}\n\nPart Number: ${item.part_number}\nNama: ${item.nama_part}\nStock saat ini: ${item.stock}\n\nMasukkan jumlah:`);
    if (raw === null) return;
    const qty = Number(raw);
    if (!Number.isInteger(qty) || qty <= 0) { alert("Jumlah harus berupa angka bulat lebih dari 0."); return; }
    if (type === "out" && qty > item.stock) { alert("Stock keluar tidak boleh melebihi stock tersedia."); return; }
    const noteInput = prompt("Keterangan transaksi (opsional):");
    try {
        const result = await postToGoogleSheet({ action: "updateStock", part_number: item.part_number, type, qty, note: noteInput === null ? "" : noteInput.trim() });
        await loadFromGoogleSheet({ silent: true });
        showToast("Berhasil", `${label} ${qty} unit. Stock sekarang: ${Number(result.stock_after).toLocaleString("id-ID")}.`);
    } catch (error) {
        alert(`${label} gagal:\n${error.message}`);
        await loadFromGoogleSheet({ silent: true });
    }
}

function stockIn(id) { updateStock(id, "in"); }
function stockOut(id) { updateStock(id, "out"); }

function getAllCategories() {
    const defaults = ["Bearing","Brake System","Cooling System","Electrical","Engine","Filter","Fuel System","Hose","Hydraulic","Lubrication","O-Ring","Pump","Seal","Transmission","Undercarriage","Valve"];
    return [...new Set([...defaults, ...spareParts.map(x => x.kategori).filter(Boolean)])].sort((a,b) => a.localeCompare(b));
}

function showCategorySuggestions() {
    if (!partCategory || !categorySuggestionBox) return;
    const keyword = partCategory.value.trim().toLowerCase();
    if (!keyword) { categorySuggestionBox.innerHTML = ""; categorySuggestionBox.style.display = "none"; return; }
    const matches = getAllCategories().filter(x => x.toLowerCase().includes(keyword)).slice(0,8);
    categorySuggestionBox.innerHTML = matches.map(x => `<button type="button" class="category-suggestion-item">${safeText(x)}</button>`).join("");
    categorySuggestionBox.querySelectorAll("button").forEach(btn => btn.addEventListener("click", () => { partCategory.value = btn.textContent; categorySuggestionBox.style.display = "none"; }));
    categorySuggestionBox.style.display = matches.length ? "block" : "none";
}

function showToast(title, message) {
    const toast = $("toast"), toastTitle = $("toastTitle"), toastMessage = $("toastMessage");
    if (!toast) return;
    if (toastTitle) toastTitle.textContent = title;
    if (toastMessage) toastMessage.textContent = message;
    toast.classList.add("show");
    setTimeout(() => toast.classList.remove("show"), 2800);
}

function exportBackup() {
    if (!isFullAccess()) return;
    const payload = { app: "United Tractors Spare Part Monitoring - Google Sheet", version: 3, exported_at: new Date().toISOString(), spareParts, history };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {type:"application/json"});
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `backup-sparepart-${todayKey()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
}

function importBackup() {
    if (!isFullAccess()) return;
    alert("Import JSON tetap dinonaktifkan pada database bersama agar data Google Sheet tidak tertimpa tanpa sengaja.");
}

if (btnAdd) btnAdd.addEventListener("click", () => { if (requireFullAccess()) openModal(); });
if (btnClose) btnClose.addEventListener("click", closeModal);
if (btnCancel) btnCancel.addEventListener("click", closeModal);
if (modal) modal.addEventListener("click", e => { if (e.target.classList.contains("modal-overlay")) closeModal(); });
if (searchInput) searchInput.addEventListener("input", renderTable);
if (btnResetFilter) btnResetFilter.addEventListener("click", () => { searchInput.value = ""; renderTable(); });
if (partCategory) partCategory.addEventListener("input", showCategorySuggestions);
if (btnRefreshHistory) btnRefreshHistory.addEventListener("click", () => loadFromGoogleSheet());

if (form) form.addEventListener("submit", async e => {
    e.preventDefault();
    if (!requireFullAccess()) return;
    const pn = partNumber.value.trim();
    const name = partName.value.trim();
    const stock = Number(partStock.value);
    if (!pn || !name || !Number.isFinite(stock) || stock < 0) { alert("Lengkapi data dengan benar."); return; }
    const isEdit = Boolean(editingOriginalPartNumber);
    try {
        const result = await postToGoogleSheet({
            action: isEdit ? "updatePart" : "addPart",
            original_part_number: editingOriginalPartNumber,
            part_number: pn,
            nama_part: name,
            kategori: partCategory.value.trim(),
            lokasi: partLocation.value.trim(),
            stock
        });
        closeModal();
        await loadFromGoogleSheet({ silent: true });
        showToast("Berhasil", result.message || (isEdit ? "Data spare part diperbarui." : "Spare part berhasil ditambahkan."));
    } catch (error) {
        alert("Simpan gagal:\n" + error.message);
        await loadFromGoogleSheet({ silent: true });
    }
});

document.addEventListener("click", e => {
    if (categorySuggestionBox && partCategory && !partCategory.contains(e.target) && !categorySuggestionBox.contains(e.target)) categorySuggestionBox.style.display = "none";
});
document.addEventListener("keydown", e => { if (e.key === "Escape" && isFullAccess()) closeModal(); });

function addOfflineControls() {
    const headerRight = document.querySelector(".header-right");
    if (!headerRight || document.querySelector(".offline-tools")) return;
    const box = document.createElement("div");
    box.className = "offline-tools";
    box.innerHTML = `<button type="button" class="offline-tool" id="btnExport"><i class="fa-solid fa-download"></i> Backup</button><button type="button" class="offline-tool" id="btnImport"><i class="fa-solid fa-upload"></i> Import</button>`;
    headerRight.insertBefore(box, headerRight.firstChild);
    $("btnExport").addEventListener("click", exportBackup);
    $("btnImport").addEventListener("click", importBackup);
}

window.editPart = editPart;
window.deletePart = deletePart;
window.stockIn = stockIn;
window.stockOut = stockOut;

window.addEventListener("DOMContentLoaded", async () => {
    showDate();
    addOfflineControls();
    renderTable();
    renderHistory();
    updateSummary();
    applyRoleUI();

    const loginForm = $("roleLoginForm");
    const loginPin = $("loginPin");
    const loginRole = $("loginRole");
    const loginError = $("roleLoginError");
    const loginButton = $("btnRoleLogin");
    const logoutButton = $("btnRoleLogout");

    if (loginForm) loginForm.addEventListener("submit", async e => {
        e.preventDefault();
        const pin = loginPin.value;
        if (!pin) return;
        loginError.textContent = "";
        loginButton.disabled = true;
        loginButton.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Memeriksa...';
        try {
            await login(loginRole.value, pin);
            loginPin.value = "";
        } catch (error) {
            clearSession();
            showLogin(error.message || "Login gagal.");
            loginPin.select();
        } finally {
            loginButton.disabled = false;
            loginButton.innerHTML = '<i class="fa-solid fa-right-to-bracket"></i> Masuk';
        }
    });
    if (logoutButton) logoutButton.addEventListener("click", logout);

    if (restoreSession() && await validateSession()) {
        await loadFromGoogleSheet({ silent: true });
    } else if (!authToken) {
        showLogin();
    }

    setInterval(() => { if (authToken) loadFromGoogleSheet({ silent: true }); }, AUTO_REFRESH_MS);
    console.log("Spare Part Monitoring role access siap.");
});
