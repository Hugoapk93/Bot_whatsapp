const fs = require('fs');
const path = require('path');

// RUTAS
const dataDir = path.join(__dirname, '../data');
const dbPath = path.join(dataDir, 'database.json');

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
    // Asegurar que existe la carpeta
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

    // Cargar o Crear archivo
    if (fs.existsSync(dbPath)) {
        try {
            const raw = fs.readFileSync(dbPath, 'utf-8');
            db.data = JSON.parse(raw);
            console.log("📂 Base de datos cargada correctamente.");
        } catch (e) {
            console.error("Error leyendo DB, reiniciando:", e);
            saveDB(); // Si falla, guardamos la estructura por defecto
        }
    } else {
        saveDB(); // Crear archivo nuevo
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
    if (!db.data.users) db.data.users = [];
    let userIndex = db.data.users.findIndex(u => u.phone === phone);

    if (userIndex === -1) {
        // Crear nuevo
        db.data.users.push({ phone, ...updates });
    } else {
        // Actualizar existente
        db.data.users[userIndex] = { ...db.data.users[userIndex], ...updates };
    }
    saveDB();
}

// --- FUNCIONES DE FLOW (PASOS) ---
function getFullFlow() { return db.data.flow || {}; }

async function saveFlowStep(id, data) {
    if (!db.data.flow) db.data.flow = {};
    db.data.flow[id] = data;
    saveDB();
}

async function deleteFlowStep(id) {
    if (db.data.flow && db.data.flow[id]) {
        delete db.data.flow[id];
        saveDB();
    }
}

// --- SETTINGS ---
function getSettings() { return db.data.settings || {}; }
async function saveSettings(s) { db.data.settings = s; saveDB(); }

// --- FUNCION AUXILIAR PARA OBTENER UN PASO ---
function getFlowStep(id) {
    const flow = getFullFlow();
    return flow[id];
}

function getSubscriptions() {
    return db.data.subscriptions || [];
}

function saveSubscription(sub) {
    if (!db.data.subscriptions) db.data.subscriptions = [];
    // Evitar duplicados
    const exists = db.data.subscriptions.find(s => s.endpoint === sub.endpoint);
    if (!exists) {
        db.data.subscriptions.push(sub);
        saveDB();
    }
}

function removeSubscription(endpoint) {
    if (!db.data.subscriptions) return;
    db.data.subscriptions = db.data.subscriptions.filter(s => s.endpoint !== endpoint);
    saveDB();
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
