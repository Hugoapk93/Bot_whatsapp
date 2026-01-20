const { db } = require('./database');
const fs = require('fs');
const path = require('path');

const dbPath = path.join(__dirname, '../data/database.json');

// --- UTILIDADES ---
function saveContactsToDisk() {
    if (!db || !db.data) return;
    try { fs.writeFileSync(dbPath, JSON.stringify(db.data, null, 2)); } catch (e) { console.error("❌ Error guardando contactos:", e); }
}

// 🔥 MEJORA LID: Limpieza suave, igual que en database.js
function getCleanPhone(jid) {
    if (!jid) return '';
    // Solo quitamos el dominio y puerto, respetamos el ID sea cual sea
    return String(jid).split('@')[0].split(':')[0];
}

function getLast10(phone) {
    // Para LIDs largos, usamos el ID completo. Para tels, los últimos 10.
    const p = String(phone).replace(/[^0-9]/g, '');
    return p.length > 10 ? p.slice(-10) : p;
}

// --- FUNCIÓN CORREGIDA: AGREGAR O ACTUALIZAR ---
function addManualContact(phone, name, enabled) {
    if (!db || !db.data) return { success: false };
    if (!db.data.contacts) db.data.contacts = [];

    const clean = getCleanPhone(phone);
    const target10 = getLast10(clean);

    // Verificar si ya existe
    let existingContact = db.data.contacts.find(c => getLast10(c.phone) === target10);

    // 🔥 CAMBIO CLAVE: SI EXISTE, LO EDITAMOS 🔥
    if (existingContact) {
        // Actualizamos nombre y estado del bot
        existingContact.name = name;
        existingContact.bot_enabled = enabled;
        existingContact.phone = clean; // Aseguramos que tenga el ID limpio actualizado
        existingContact.last_synced = new Date().toISOString();
        
        saveContactsToDisk();
        console.log(`✏️ Contacto actualizado: ${name} (${clean})`);
        return { success: true, message: 'Actualizado' };
    }

    // SI NO EXISTE, LO CREAMOS (Tu lógica original)
    let jid = clean + '@s.whatsapp.net';
    // Si parece un número de México y es corto, asumimos prefijo (opcional)
    if(clean.length === 10 && !clean.includes('@')) jid = '521' + clean + '@s.whatsapp.net';

    db.data.contacts.push({
        phone: clean,
        jid: jid,
        name: name,
        bot_enabled: enabled,
        last_synced: new Date().toISOString(),
        added_at: new Date().toISOString()
    });

    saveContactsToDisk();
    console.log(`👤 Nuevo contacto creado: ${name} (${clean})`);
    return { success: true, message: 'Creado' };
}

// --- SINCRONIZACIÓN AUTOMÁTICA ---
function syncContacts(contacts) {
    if (!db || !db.data) return;
    if (!db.data.contacts) db.data.contacts = [];
    if (!contacts || contacts.length === 0) return;

    const now = new Date().toISOString();
    let hasChanges = false;

    contacts.forEach(waContact => {
        const jid = waContact.id;
        const phone = getCleanPhone(jid);
        if (!phone) return;
        
        // Usamos comparación estricta de ID limpio para LIDs
        let localContact = db.data.contacts.find(c => getCleanPhone(c.phone) === phone);
        
        const name = waContact.name || waContact.notify || waContact.verifiedName || phone;

        if (localContact) {
            // Solo actualizamos si el nombre es diferente y no es el número pelón
            if (localContact.name !== name && name !== phone) {
                localContact.name = name;
                localContact.last_synced = now;
                hasChanges = true;
            }
        } else {
            db.data.contacts.push({
                phone: phone,
                jid: jid,
                name: name,
                bot_enabled: true,
                last_synced: now,
                added_at: now
            });
            hasChanges = true;
        }
    });

    if (hasChanges) saveContactsToDisk();
}

function getAllContacts() {
    if (!db || !db.data || !db.data.contacts) return [];
    return db.data.contacts.map(c => ({
        phone: c.phone, name: c.name, bot_enabled: c.bot_enabled,
        last_synced: c.last_synced, added_at: c.added_at
    })).sort((a, b) => (b.added_at || '').localeCompare(a.added_at || ''));
}

function toggleContactBot(phoneOrJid, enable) {
    if (!db || !db.data || !db.data.contacts) return { success: false };
    
    const cleanId = getCleanPhone(phoneOrJid);
    // Búsqueda más precisa
    let contact = db.data.contacts.find(c => getCleanPhone(c.phone) === cleanId);

    // Fallback a los últimos 10 dígitos si falla la exacta
    if (!contact) {
        const target10 = getLast10(cleanId);
        contact = db.data.contacts.find(c => getLast10(c.phone) === target10);
    }

    if (contact) {
        contact.bot_enabled = enable;
        saveContactsToDisk();
        return { success: true, newState: enable };
    }
    return { success: false };
}

function isBotDisabled(jid) {
    if (!db || !db.data || !db.data.contacts) return false;
    const cleanId = getCleanPhone(jid);
    
    // Búsqueda precisa primero
    let contact = db.data.contacts.find(c => getCleanPhone(c.phone) === cleanId);

    // Fallback
    if (!contact) {
        const incoming10 = getLast10(cleanId);
        contact = db.data.contacts.find(c => getLast10(c.phone) === incoming10);
    }

    if (contact && contact.bot_enabled === false) return true;
    return false;
}

module.exports = { syncContacts, getAllContacts, toggleContactBot, isBotDisabled, addManualContact };
