const fs = require('fs');
const path = require('path');

// RUTAS
const dataDir = path.join(__dirname, '../data');
const dbPath = path.join(dataDir, 'database.json');

// Variable en memoria
const db = {
    data: {
        users: [],
        contacts: [],
        settings: { schedule: { active: false, days: [] } },
        subscriptions: [],
        flow: {}
    }
};

// --- HELPER SEGURO PARA LIDs ---
// Convierte '12345@lid' -> '12345' sin romper caracteres raros
const getCleanId = (id) => {
    if (!id) return '';
    return String(id).split('@')[0].split(':')[0];
};

// Inicializar DB
function initializeDB() {
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

    if (fs.existsSync(dbPath)) {
        try {
            const raw = fs.readFileSync(dbPath, 'utf-8');
            const loaded = JSON.parse(raw);
            db.data = { ...db.data, ...loaded };
            console.log("📂 Base de datos cargada correctamente.");
        } catch (e) {
            console.error("Error leyendo DB, reiniciando:", e);
            saveDB();
        }
    } else {
        saveDB();
    }
}

// Guardar DB (Escribir en disco)
function saveDB() {
    try {
        fs.writeFileSync(dbPath, JSON.stringify(db.data, null, 2));
    } catch (e) {
        console.error("Error guardando DB:", e);
    }
}

// Recargar memoria desde disco (Seguridad)
function reloadDB() {
    if (fs.existsSync(dbPath)) {
        try {
            const raw = fs.readFileSync(dbPath, 'utf-8');
            const diskData = JSON.parse(raw);
            db.data = {
                ...db.data,
                ...diskData,
                settings: { ...db.data.settings, ...(diskData.settings || {}) }
            };
        } catch (e) {}
    }
}

// --- FUNCIONES DE USUARIOS Y CONTACTOS ---

function getAllUsers() { 
    reloadDB();
    return db.data.users || []; 
}

function getAllContacts() { 
    reloadDB();
    return db.data.contacts || []; 
}

function getUser(phone) {
    reloadDB();
    if (!db.data.users) db.data.users = [];
    const target = getCleanId(phone);
    return db.data.users.find(u => getCleanId(u.phone) === target) || {};
}

// 🔥 AQUÍ ESTÁ LA MAGIA QUE CONECTA EL BOT CON LOS CONTACTOS 🔥
async function updateUser(phone, updates) {
    reloadDB();

    const targetKey = getCleanId(phone);

    // 1. ACTUALIZAR USUARIOS (Historial del chat)
    if (!db.data.users) db.data.users = [];
    let userIndex = db.data.users.findIndex(u => getCleanId(u.phone) === targetKey);

    if (userIndex === -1) {
        db.data.users.push({ 
            phone: phone, 
            ...updates,
            created_at: new Date().toISOString()
        });
    } else {
        db.data.users[userIndex] = { 
            ...db.data.users[userIndex], 
            ...updates 
        };
    }

    // 2. ACTUALIZAR CONTACTOS (Lista Visual)
    // Si el bot descubre el nombre, lo guardamos también en la lista de contactos
    // para que el Monitor no muestre el número al recargar.
    if (updates.name || updates.bot_enabled !== undefined) {
        if (!db.data.contacts) db.data.contacts = [];
        let contactIndex = db.data.contacts.findIndex(c => getCleanId(c.phone) === targetKey);

        const contactData = {
            phone: phone,
            name: updates.name, 
            bot_enabled: updates.bot_enabled
        };

        if (contactIndex === -1) {
             if (updates.name) { // Solo crear si hay nombre
                db.data.contacts.push({ ...contactData, bot_enabled: true });
             }
        } else {
            const oldContact = db.data.contacts[contactIndex];
            db.data.contacts[contactIndex] = {
                ...oldContact,
                ...(updates.name ? { name: updates.name } : {}),
                ...(updates.bot_enabled !== undefined ? { bot_enabled: updates.bot_enabled } : {})
            };
        }
    }

    saveDB(); // Guardar cambios en disco
    return getUser(phone);
}

function deleteUser(phone) {
    reloadDB();
    let changed = false;
    const target = getCleanId(phone);

    // Borrar de users
    const initialUsers = db.data.users.length;
    db.data.users = db.data.users.filter(u => getCleanId(u.phone) !== target);
    if(db.data.users.length !== initialUsers) changed = true;

    // Borrar de contacts
    const initialContacts = db.data.contacts.length;
    db.data.contacts = db.data.contacts.filter(c => getCleanId(c.phone) !== target);
    if(db.data.contacts.length !== initialContacts) changed = true;

    if(changed) saveDB();
    return changed;
}

// --- FUNCIONES DE FLOW ---
function getFullFlow() { 
    reloadDB();
    return db.data.flow || {}; 
}

function getFlowStep(id) {
    return getFullFlow()[id];
}

async function saveFlowStep(id, data) {
    reloadDB();
    if (!db.data.flow) db.data.flow = {};
    db.data.flow[id] = data;
    saveDB();
}

async function deleteFlowStep(id) {
    reloadDB();
    if (db.data.flow && db.data.flow[id]) {
        delete db.data.flow[id];
        saveDB();
    }
}

// --- SETTINGS Y SUBSCRIPCIONES ---
function getSettings() {
    reloadDB();
    return db.data.settings || {};
}

async function saveSettings(s) {
    reloadDB();
    db.data.settings = s;
    saveDB();
}

function getSubscriptions() {
    reloadDB();
    return db.data.subscriptions || [];
}

function saveSubscription(sub) {
    reloadDB();
    if (!db.data.subscriptions) db.data.subscriptions = [];
    const exists = db.data.subscriptions.find(s => s.endpoint === sub.endpoint);
    if (!exists) {
        db.data.subscriptions.push(sub);
        saveDB();
    }
}

function removeSubscription(endpoint) {
    reloadDB();
    if (!db.data.subscriptions) return;
    db.data.subscriptions = db.data.subscriptions.filter(s => s.endpoint !== endpoint);
    saveDB();
}

module.exports = {
    db,
    initializeDB,
    getAllUsers,
    getAllContacts, 
    getUser,
    updateUser,
    deleteUser,
    getFullFlow,
    getFlowStep,
    saveFlowStep,
    deleteFlowStep,
    getSettings,
    saveSettings,
    getSubscriptions,
    saveSubscription,
    removeSubscription
};
