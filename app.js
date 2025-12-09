const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cors = require('cors');

// --- IMPORTS ---
const { handleMessage, sendStepMessage } = require('./src/flow');
const { initializeDB, getFullFlow, saveFlowStep, deleteFlowStep, getSettings, saveSettings, getAllUsers, updateUser, getUser, clearAllSessions } = require('./src/database');
const { syncContacts, getAllContacts, toggleContactBot, isBotDisabled, addManualContact } = require('./src/contacts');

const app = express();
app.use(cors());

// =================================================================
// 1. CONFIGURACIÓN DINÁMICA DE PUERTO (MODIFICADO)
// =================================================================
// Buscamos si la Torre nos mandó el puerto (ej: --port 3005)
const args = process.argv.slice(2);
const portArgIndex = args.indexOf('--port');
const PORT = portArgIndex !== -1 ? parseInt(args[portArgIndex + 1]) : 3000; // Si no, usa 3000 por defecto

// CONFIG DE LA TORRE
const TOWER_URL = 'http://localhost:8888/api/instances/report'; // Dirección de la Torre
const INSTANCE_ID = 'bot_' + PORT; // ID único para la torre

// --- CONFIGURACIÓN DE CARPETAS ---
const uploadDir = path.join(__dirname, 'public/uploads');
const dataDir = path.join(__dirname, 'data'); 
const authDir = 'auth_info_baileys'; 

if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

// --- VARIABLES GLOBALES ---
let globalSock;
let globalQR = null; 
let connectionStatus = 'disconnected'; 

// =================================================================
// 2. FUNCIÓN DE REPORTE A LA TORRE (NUEVO)
// =================================================================
async function reportToTower() {
    try {
        // En Node 18+ fetch es nativo. Si usas Node viejo, ignora el error.
        await fetch(TOWER_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                id: INSTANCE_ID,
                port: PORT,
                status: connectionStatus,
                qr: globalQR,
                version: '2.0.0'
            })
        });
    } catch (e) {
        // Silencioso: Si la torre está apagada, el bot sigue funcionando normal.
    }
}

// --- HELPER PARA LEER JSON SEGURO ---
function safeReadJSON(filePath, defaultVal) {
    if (!fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, JSON.stringify(defaultVal, null, 2));
        return defaultVal;
    }
    try {
        const fileContent = fs.readFileSync(filePath, 'utf-8');
        if (!fileContent || fileContent.trim() === '') return defaultVal;
        return JSON.parse(fileContent);
    } catch (e) {
        console.error(`⚠️ Error leyendo ${filePath}, reiniciando archivo:`, e.message);
        return defaultVal;
    }
}

// --- LÓGICA DE AGENDA ---
const agendaPath = path.join(dataDir, 'agenda.json');
function getAgenda() { return safeReadJSON(agendaPath, {}); }
function saveAgenda(data) { fs.writeFileSync(agendaPath, JSON.stringify(data, null, 2)); }

// Multer Config
const storage = multer.diskStorage({
    destination: function (req, file, cb) { cb(null, 'public/uploads/') },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

app.use(express.static('public'));
app.use(express.json());

// Inicializar DB
initializeDB();

// --- LÓGICA DE CONEXIÓN WHATSAPP ---
async function connectToWhatsApp() {
    if (connectionStatus === 'connecting' || connectionStatus === 'rebooting' || connectionStatus === 'connected') {
        return;
    }

    connectionStatus = 'connecting';
    reportToTower(); // <--- AVISAR TORRE
    console.log("🔄 Iniciando conexión a WhatsApp...");

    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false, 
        logger: pino({ level: 'silent' }),
        keepAliveIntervalMs: 10000, 
        retryRequestDelayMs: 2000,   
        connectTimeoutMs: 60000,      
        syncFullHistory: false,       
        browser: ["CRM Monitor", "Chrome", "1.0.0"],
    });
    
    globalSock = sock;

    sock.ev.on('creds.update', saveCreds);
    
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log("📡 QR Generado");
            globalQR = qr; 
            connectionStatus = 'qr_ready';
            reportToTower(); // <--- AVISAR TORRE (Nuevo QR)
        }

        if (connection === 'close') {
            const reason = (lastDisconnect.error)?.output?.statusCode;
            const shouldReconnect = reason !== DisconnectReason.loggedOut;
            console.log(`⚠️ Conexión cerrada. Razón: ${reason}, Reconectando: ${shouldReconnect}`);
            
            if (connectionStatus !== 'rebooting') connectionStatus = 'disconnected';
            globalQR = null;
            reportToTower(); // <--- AVISAR TORRE (Desconectado)

            if (shouldReconnect && connectionStatus !== 'rebooting') {
                setTimeout(() => {
                    connectionStatus = 'disconnected'; 
                    connectToWhatsApp();
                }, 3000); 
            }
        } else if (connection === 'open') {
            console.log('✅ Bot CONECTADO');
            connectionStatus = 'connected';
            globalQR = null; 
            reportToTower(); // <--- AVISAR TORRE (Conectado)
        }
    });

    sock.ev.on('contacts.upsert', (contacts) => syncContacts(contacts));

    // =================================================================
    // >>> LOGICA DE MENSAJES (FILTROS + LICENCIA) <<<
    // =================================================================
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        // 1. REVISAR VIGENCIA DE LA LICENCIA (NUEVO)
        const settings = getSettings();
        if (settings.license && settings.license.end) {
            const today = new Date().toISOString().split('T')[0];
            if (today > settings.license.end) {
                console.log("🔒 LICENCIA VENCIDA. Bot en pausa.");
                return; // Detener ejecución si la licencia expiró
            }
        }

        // 2. FILTRO DE CONTACTOS Y NOMBRES
        const allContacts = getAllContacts(); 

        for (const msg of messages) {
            if (!msg.message || msg.key.fromMe) continue;
            
            const remoteJid = msg.key.remoteJid;
            if (remoteJid.includes('@g.us') || remoteJid === 'status@broadcast') continue;

            const incomingPhoneRaw = remoteJid.replace(/[^0-9]/g, ''); 
            const incomingName = msg.pushName || ''; 

            const isBlocked = allContacts.some(contact => {
                if (contact.bot_enabled !== false) return false; 
                const dbPhoneRaw = (contact.phone || '').replace(/[^0-9]/g, '');
                const phoneMatch = dbPhoneRaw.slice(-10) === incomingPhoneRaw.slice(-10);
                let nameMatch = false;
                if (contact.name && incomingName) {
                    nameMatch = contact.name.trim().toLowerCase() === incomingName.trim().toLowerCase();
                }
                return phoneMatch || nameMatch;
            });

            if (isBlocked) {
                console.log(`⛔ Bot SILENCIADO para: ${incomingName} (${incomingPhoneRaw})`);
                continue; 
            }

            await handleMessage(sock, msg);
        }
    });
}

// ==========================================
//              RUTAS API
// ==========================================

app.get('/api/status', (req, res) => {
    const sessionPath = path.join(__dirname, authDir);
    const sessionExists = connectionStatus !== 'rebooting' && fs.existsSync(sessionPath) && fs.readdirSync(sessionPath).length > 0;
    res.json({
        status: connectionStatus === 'connected' ? 'connected' : connectionStatus,
        isConnected: connectionStatus === 'connected',
        qr: globalQR,
        sessionExists: sessionExists,
        statusString: connectionStatus
    });
});

app.post('/api/auth/init', (req, res) => {
    if (connectionStatus === 'disconnected') {
        connectToWhatsApp();
        res.json({ message: 'Iniciando conexión...' });
    } else {
        res.json({ message: `Ya en proceso (${connectionStatus})` });
    }
});

app.post('/api/logout', async (req, res) => {
    try {
        console.log("🛑 Solicitud de REINICIO recibida.");
        connectionStatus = 'rebooting'; 
        reportToTower(); // <--- AVISAR TORRE
        globalQR = null;

        if (globalSock) {
            try { await globalSock.logout(); } catch(e) {}
            try { globalSock.end(undefined); } catch(e) {}
            globalSock = null;
        }
        
        await new Promise(r => setTimeout(r, 500));

        const sessionPath = path.join(__dirname, authDir);
        if (fs.existsSync(sessionPath)) {
            try { fs.rmSync(sessionPath, { recursive: true, force: true }); } catch (err) {}
        }
        
        connectionStatus = 'disconnected'; 
        connectToWhatsApp();
        
        res.json({ success: true, message: 'Reinicio completado.' });
    } catch (e) {
        console.error(e);
        connectionStatus = 'disconnected';
        reportToTower(); // <--- AVISAR TORRE
        res.status(500).json({ error: 'Error al reiniciar' });
    }
});

app.get('/api/contacts', (req, res) => { res.json(getAllContacts()); });
app.post('/api/contacts/toggle', (req, res) => { res.json(toggleContactBot(req.body.phone, req.body.enable)); });

app.post('/api/contacts/add', (req, res) => {
    const { phone, name, enable } = req.body;
    if (!phone) return res.status(400).json({ success: false, message: 'Falta teléfono' });
    res.json(addManualContact(phone, name, enable));
});

app.post('/api/upload', upload.array('images', 10), (req, res) => {
    if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'No files' });
    const urls = req.files.map(file => '/uploads/' + file.filename);
    res.json({ urls: urls });
});

app.get('/api/flow', (req, res) => res.json(getFullFlow()));
app.post('/api/flow/step', async (req, res) => { await saveFlowStep(req.body.stepId, req.body.stepData); res.json({ success: true }); });
app.delete('/api/flow/step/:id', async (req, res) => { await deleteFlowStep(req.params.id); res.json({ success: true }); });

app.get('/api/users', (req, res) => res.json(getAllUsers()));
app.post('/api/users/toggle', async (req, res) => { await updateUser(req.body.phone, { blocked: req.body.isBlocked }); res.json({ success: true }); });

app.post('/api/crm/execute', async (req, res) => {
    const { phone, stepId } = req.body;
    if (!stepId) return res.status(400).json({ error: "Sin destino." });
    try {
        await updateUser(phone, { current_step: stepId });
        if (phone === 'TEST_SIMULADOR') return res.json({ success: true });
        if (!globalSock) return res.status(500).json({ error: "Bot offline" });
        
        const user = getUser(phone);
        let targetJid = user?.jid;
        if (!targetJid) {
            let clean = phone.replace(/[^0-9]/g, '');
            if (clean.startsWith('52') && clean.length === 12) clean = '521' + clean.slice(2);
            targetJid = clean + '@s.whatsapp.net';
        }
        await sendStepMessage(globalSock, targetJid, stepId, user);
        res.json({ success: true });
    } catch (e) {
        console.error("❌ Error CRM:", e);
        res.status(500).json({ error: "Error interno" });
    }
});

app.post('/api/users/sync', async (req, res) => { await updateUser(req.body.phone, req.body.data); res.json({ success: true }); });

app.get('/api/agenda', (req, res) => res.json(getAgenda()));
app.post('/api/agenda/book', (req, res) => {
    const { date, time, phone, name, note } = req.body;
    const db = getAgenda();
    if (!db[date]) db[date] = [];
    if (db[date].some(c => c.time === time)) return res.json({ success: false, message: 'Horario ocupado' });
    db[date].push({ time, phone: phone || '', name: name || 'Evento', note: note || '', created_at: new Date().toISOString() });
    db[date].sort((a,b) => a.time.localeCompare(b.time));
    saveAgenda(db);
    res.json({ success: true });
});
app.post('/api/agenda/delete', (req, res) => {
    const { date, time } = req.body;
    const db = getAgenda(); 
    if (db[date]) {
        db[date] = db[date].filter(c => c.time !== time);
        if (db[date].length === 0) delete db[date];
        saveAgenda(db); 
        res.json({ success: true });
    } else res.json({ success: false });
});
app.post('/api/agenda/update', (req, res) => {
    const { oldDate, oldTime, newDate, newTime, name, phone, note } = req.body;
    const db = getAgenda();
    if (db[oldDate]) {
        db[oldDate] = db[oldDate].filter(c => c.time !== oldTime);
        if (db[oldDate].length === 0) delete db[oldDate];
    }
    if (!db[newDate]) db[newDate] = [];
    if ((oldDate !== newDate || oldTime !== newTime) && db[newDate].some(c => c.time === newTime)) return res.json({ success: false, message: 'Ocupado' });
    db[newDate].push({ time: newTime, phone: phone || '', name: name || 'Evento', note: note || '', updated_at: new Date().toISOString() });
    db[newDate].sort((a,b) => a.time.localeCompare(b.time));
    saveAgenda(db);
    res.json({ success: true });
});

app.get('/api/admin/clear-monitor', (req, res) => {
    try {
        if(typeof clearAllSessions === 'function') clearAllSessions(); 
        res.send(`<h1 style="text-align:center;">✅ Monitor Limpiado</h1><script>setTimeout(() => window.location.href = '/', 2000);</script>`);
    } catch (e) { res.status(500).send("Error"); }
});

app.get('/api/settings', (req, res) => res.json(getSettings()));

// =================================================================
// 3. GUARDAR AJUSTES + LICENCIAS (MODIFICADO)
// =================================================================
app.post('/api/settings', async (req, res) => { 
    const current = getSettings();
    // Ahora hacemos MERGE de todo lo que llegue (schedule, license, etc)
    const newSettings = { ...current, ...req.body };
    await saveSettings(newSettings); 
    res.json({ success: true }); 
});

// ARRANCAR EL BOT
app.listen(PORT, () => {
    console.log(`🚀 Torre de Control Local en puerto: ${PORT}`);
    // Intentar conexión inicial y reporte a la Torre Maestra
    connectToWhatsApp();
    reportToTower();
});
