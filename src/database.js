const fs = require('fs');
const path = require('path');

// RUTAS
const dataDir = path.join(__dirname, '../data');
const dbPath = path.join(dataDir, 'database.json');

// Variable en memoria (para usuarios y flujos que cambian rápido)
const db = { 
    data: { 
        users: [], 
        contacts: [],
        settings: { schedule: { active: false, days: [] } },
        subscriptions: []
    } 
};

// Inicializar DB
function initializeDB() {
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

    if (fs.existsSync(dbPath)) {
        try {
            const raw = fs.readFileSync(dbPath, 'utf-8');
            db.data = JSON.parse(raw);
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
    fs.writeFileSync(dbPath, JSON.stringify(db.data, null, 2));
}

// --- FUNCIONES DE USUARIOS (FLOW) ---
function getAllUsers() { return db.data.users || []; }

function getUser(phone) {
    if (!db.data.users) db.data.users = [];
    return db.data.users.find(u => u.phone === phone) || {};
}

async function updateUser(phone, updates) {
    // Recargar DB por seguridad antes de escribir usuarios
    reloadDB(); 
    
    if (!db.data.users) db.data.users = [];
    let userIndex = db.data.users.findIndex(u => u.phone === phone);

    if (userIndex === -1) {
        db.data.users.push({ phone, ...updates });
    } else {
        db.data.users[userIndex] = { ...db.data.users[userIndex], ...updates };
    }
    saveDB();
}

// --- FUNCIONES DE FLOW (PASOS) ---
function getFullFlow() { return db.data.flow || {}; }

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

// 🔥 AQUÍ ESTÁ LA CORRECCIÓN CLAVE PARA EL HORARIO 🔥
// "getSettings" ahora lee directo del DISCO, ignorando la memoria vieja
function getSettings() { 
    if (fs.existsSync(dbPath)) {
        try {
            const raw = fs.readFileSync(dbPath, 'utf-8');
            const data = JSON.parse(raw);
            // Actualizamos la memoria de paso
            db.data.settings = data.settings;
            return data.settings || {};
        } catch (e) {
            return db.data.settings || {};
        }
    }
    return db.data.settings || {}; 
}

async function saveSettings(s) { 
    // 1. Leemos lo más nuevo del disco para no borrar usuarios nuevos
    reloadDB();
    
    // 2. Aplicamos el cambio de horario
    db.data.settings = s; 
    
    // 3. Guardamos inmediatamente
    saveDB(); 
}

// --- FUNCION AUXILIAR PARA OBTENER UN PASO ---
function getFlowStep(id) {
    const flow = getFullFlow();
    return flow[id];
}

function getSubscriptions() {
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

// Helper para recargar memoria desde disco (evita sobrescribir datos de otros procesos)
function reloadDB() {
    if (fs.existsSync(dbPath)) {
        try {
            const raw = fs.readFileSync(dbPath, 'utf-8');
            const diskData = JSON.parse(raw);
            db.data = { ...db.data, ...diskData }; // Merge seguro
        } catch (e) {}
    }
}

module.exports = {
    db,
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
    removeSubscription
};
