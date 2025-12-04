const { db } = require('./database'); 
const fs = require('fs');
const path = require('path');

const dbPath = path.join(__dirname, '../data/database.json');

// --- UTILIDADES ---
function saveContactsToDisk() {
    if (!db || !db.data) return;
    try { fs.writeFileSync(dbPath, JSON.stringify(db.data, null, 2)); } catch (e) { console.error("❌ Error guardando contactos:", e); }
}

function getCleanPhone(jid) {
    if (!jid) return '';
    return jid.split('@')[0].replace(/[^0-9]/g, '');
}

function getLast10(phone) {
    const p = phone.replace(/[^0-9]/g, '');
    return p.length > 10 ? p.slice(-10) : p;
}

// --- NUEVA FUNCIÓN: AGREGAR MANUALMENTE ---
function addManualContact(phone, name, enabled) {
    if (!db || !db.data) return { success: false };
    if (!db.data.contacts) db.data.contacts = [];

    const clean = getCleanPhone(phone);
    const target10 = getLast10(clean);

    // Verificar si ya existe (por los 10 dígitos)
    let exists = db.data.contacts.find(c => getLast10(c.phone) === target10);

    if (exists) {
        return { success: false, message: 'El contacto ya existe.' };
    }

    // Construir JID falso si no lo tenemos, para compatibilidad
    let jid = clean + '@s.whatsapp.net';
    if(clean.length === 10) jid = '521' + clean + '@s.whatsapp.net'; // Asumimos MX por defecto si es corto

    db.data.contacts.push({
        phone: clean,
        jid: jid,
        name: name,
        bot_enabled: enabled, // Aquí decide el toggle
        last_synced: new Date().toISOString(),
        added_at: new Date().toISOString()
    });

    saveContactsToDisk();
    console.log(`👤 Contacto manual agregado: ${name} (${clean}) - Bot: ${enabled}`);
    return { success: true };
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
        const phone10 = getLast10(phone);

        let localContact = db.data.contacts.find(c => getLast10(c.phone) === phone10);
        const name = waContact.name || waContact.notify || waContact.verifiedName || phone;

        if (localContact) {
            if (localContact.name !== name || localContact.jid !== jid) {
                localContact.name = name;
                localContact.jid = jid; 
                localContact.phone = phone; 
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
    const target10 = getLast10(getCleanPhone(phoneOrJid));
    let contact = db.data.contacts.find(c => getLast10(c.phone) === target10);

    if (contact) {
        contact.bot_enabled = enable;
        saveContactsToDisk(); 
        return { success: true, newState: enable };
    }
    return { success: false };
}

function isBotDisabled(jid) {
    if (!db || !db.data || !db.data.contacts) return false;
    const incoming10 = getLast10(getCleanPhone(jid));
    const contact = db.data.contacts.find(c => getLast10(c.phone) === incoming10);

    if (contact && contact.bot_enabled === false) return true;
    return false; 
}

module.exports = { syncContacts, getAllContacts, toggleContactBot, isBotDisabled, addManualContact };
