const fs = require('fs');
const path = require('path');

// RUTAS MODULARIZADAS
const dataDir = path.join(__dirname, '../data');
const oldDbPath = path.join(dataDir, 'database.json');
const backupDbPath = path.join(dataDir, 'database_backup.json');

const paths = {
    users: path.join(dataDir, 'users.json'),
    flow: path.join(dataDir, 'flow.json'),
    settings: path.join(dataDir, 'settings.json'),
    keywords: path.join(dataDir, 'keywords.json'),
    contacts: path.join(dataDir, 'contacts.json'),
    subscriptions: path.join(dataDir, 'subscriptions.json')
};

// --- FUNCIONES AUXILIARES (I/O Seguro) ---
function safeReadJSON(filePath, defaultVal) {
    if (!fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, JSON.stringify(defaultVal, null, 2));
        return defaultVal;
    }
    try {
        const raw = fs.readFileSync(filePath, 'utf-8');
        return JSON.parse(raw);
    } catch (e) {
        console.error(`⚠️ Error leyendo ${filePath}, usando default.`);
        return defaultVal;
    }
}

function safeWriteJSON(filePath, data) {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

// --- MIGRACIÓN Y PREPARACIÓN ---
function initializeDB() {
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

    // 🔥 MIGRACIÓN AUTOMÁTICA: Si existe la base vieja, la dividimos 🔥
    if (fs.existsSync(oldDbPath) && !fs.existsSync(paths.users)) {
        console.log("🔄 Iniciando migración a base de datos modular...");
        try {
            const raw = fs.readFileSync(oldDbPath, 'utf-8');
            const oldDb = JSON.parse(raw);
            const data = oldDb.data || oldDb;

            safeWriteJSON(paths.users, data.users || []);
            safeWriteJSON(paths.flow, data.flow || {});
            safeWriteJSON(paths.settings, data.settings || { schedule: { active: false, days: [] } });
            safeWriteJSON(paths.keywords, data.keywords || []);
            safeWriteJSON(paths.contacts, data.contacts || []);
            safeWriteJSON(paths.subscriptions, data.subscriptions || []);

            // Renombramos la base vieja para no volver a migrar y como respaldo
            fs.renameSync(oldDbPath, backupDbPath);
            console.log("✅ Migración exitosa. Ahora el sistema es modular.");
        } catch (e) {
            console.error("❌ Error en migración:", e);
        }
    } else {
        // Si es una instalación limpia, solo garantizamos que existan los archivos
        safeReadJSON(paths.users, []);
        safeReadJSON(paths.flow, {});
        safeReadJSON(paths.settings, { schedule: { active: false, days: [] } });
        safeReadJSON(paths.keywords, []);
        safeReadJSON(paths.contacts, []);
        safeReadJSON(paths.subscriptions, []);
    }
}

// --- FUNCIONES DE USUARIOS (USERS) ---
function getAllUsers() { 
    return safeReadJSON(paths.users, []); 
}

function getUser(phone) {
    const users = safeReadJSON(paths.users, []);
    return users.find(u => u.phone === phone) || {};
}

async function updateUser(phone, updates) {
    const users = safeReadJSON(paths.users, []);
    let userIndex = users.findIndex(u => u.phone === phone);

    if (userIndex === -1) {
        users.push({ phone, ...updates });
    } else {
        users[userIndex] = { ...users[userIndex], ...updates };
    }
    safeWriteJSON(paths.users, users);
}

function deleteUser(phone) {
    let huboCambios = false;

    // A) Borrar de USUARIOS
    const users = safeReadJSON(paths.users, []);
    const initialUsersLen = users.length;
    const newUsers = users.filter(u => u.phone !== phone);
    if (newUsers.length !== initialUsersLen) {
        safeWriteJSON(paths.users, newUsers);
        huboCambios = true;
    }

    // B) Borrar de CONTACTOS
    const contacts = safeReadJSON(paths.contacts, []);
    const initialContactsLen = contacts.length;
    const newContacts = contacts.filter(c => {
        const cPhone = (c.phone || c.id || '').replace(/[^0-9]/g, '');
        const target = phone.replace(/[^0-9]/g, '');
        return !cPhone.includes(target);
    });
    if (newContacts.length !== initialContactsLen) {
        safeWriteJSON(paths.contacts, newContacts);
        huboCambios = true;
    }

    return huboCambios;
}

// --- FUNCIONES DE FLUJO (FLOW) ---
function getFullFlow() { 
    return safeReadJSON(paths.flow, {}); 
}

function getFlowStep(id) {
    const flow = getFullFlow();
    return flow[id];
}

async function saveFlowStep(id, data) {
    const flow = safeReadJSON(paths.flow, {});
    flow[id] = data;
    safeWriteJSON(paths.flow, flow);
}

async function deleteFlowStep(id) {
    const flow = safeReadJSON(paths.flow, {});
    if (flow[id]) {
        delete flow[id];
        safeWriteJSON(paths.flow, flow);
    }
}

// --- FUNCIONES DE CONFIGURACIÓN (SETTINGS) ---
function getSettings() {
    return safeReadJSON(paths.settings, { schedule: { active: false, days: [] } });
}

async function saveSettings(s) {
    // Al guardar, no sobreescribimos todo a ciegas, hacemos un merge seguro
    const current = getSettings();
    const updated = { ...current, ...s };
    safeWriteJSON(paths.settings, updated);
}

// --- FUNCIONES DE RESPUESTAS RÁPIDAS (KEYWORDS) ---
function getKeywords() {
    return safeReadJSON(paths.keywords, []);
}

function saveKeyword(rule) {
    const keywords = safeReadJSON(paths.keywords, []);
    
    const index = keywords.findIndex(k => k.id === rule.id);
    if (index !== -1) {
        keywords[index] = rule;
    } else {
        if (!rule.id) rule.id = 'kw_' + Date.now().toString();
        keywords.push(rule);
    }
    safeWriteJSON(paths.keywords, keywords);
    return rule;
}

function deleteKeyword(id) {
    const keywords = safeReadJSON(paths.keywords, []);
    const newKeywords = keywords.filter(k => k.id !== id);
    safeWriteJSON(paths.keywords, newKeywords);
}

// --- FUNCIONES DE SUSCRIPCIONES (NOTIFICACIONES PUSH) ---
function getSubscriptions() {
    return safeReadJSON(paths.subscriptions, []);
}

function saveSubscription(sub) {
    const subs = safeReadJSON(paths.subscriptions, []);
    const exists = subs.find(s => s.endpoint === sub.endpoint);
    if (!exists) {
        subs.push(sub);
        safeWriteJSON(paths.subscriptions, subs);
    }
}

function removeSubscription(endpoint) {
    const subs = safeReadJSON(paths.subscriptions, []);
    const newSubs = subs.filter(s => s.endpoint !== endpoint);
    safeWriteJSON(paths.subscriptions, newSubs);
}

module.exports = {
    db: {}, // Exportado vacío por retrocompatibilidad por si algún archivo lo busca
    initializeDB,
    getAllUsers,
    getUser,
    updateUser,
    getFullFlow,
    saveFlowStep,
    deleteFlowStep,
    getSettings,
    saveSettings,
    getFlowStep,
    getSubscriptions,
    saveSubscription,
    removeSubscription,
    deleteUser,
    getKeywords,
    saveKeyword,
    deleteKeyword
};
