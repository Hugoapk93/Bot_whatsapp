const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cors = require('cors');

// --- IMPORTS: Lógica del flujo y Base de Datos ---
const { handleMessage, sendStepMessage } = require('./src/flow');
const { initializeDB, getFullFlow, saveFlowStep, deleteFlowStep, getSettings, saveSettings, getAllUsers, updateUser, getUser, clearAllSessions } = require('./src/database');
const { syncContacts, getAllContacts, toggleContactBot, isBotDisabled, addManualContact } = require('./src/contacts');

const app = express();
app.use(cors());
const port = 3000;

// --- CONFIGURACIÓN DE CARPETAS ---
const uploadDir = path.join(__dirname, 'public/uploads');
const dataDir = path.join(__dirname, 'data'); 
const authDir = 'auth_info_baileys'; // Carpeta de sesión

if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

// --- VARIABLES GLOBALES PARA CONTROL TOWER ---
let globalSock;
let globalQR = null; 
let connectionStatus = 'disconnected'; // Estados: disconnected, connecting, qr_ready, connected, rebooting

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

// --- LÓGICA DE AGENDA (BACKEND) ---
const agendaPath = path.join(dataDir, 'agenda.json');

function getAgenda() { return safeReadJSON(agendaPath, {}); }
function saveAgenda(data) { fs.writeFileSync(agendaPath, JSON.stringify(data, null, 2)); }

// Configurar Multer
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

// --- INICIALIZAR BASES DE DATOS ---
initializeDB();

// --- LÓGICA DE CONEXIÓN WHATSAPP ---
async function connectToWhatsApp() {
    // 🔒 BLOQUEO: Si ya se está conectando o reiniciando, no hacer nada.
    if (connectionStatus === 'connecting' || connectionStatus === 'rebooting' || connectionStatus === 'connected') {
        console.log("⚠️ Intento de conexión duplicada ignorado. Estado actual:", connectionStatus);
        return;
    }

    connectionStatus = 'connecting';
    console.log("🔄 Iniciando conexión a WhatsApp...");

    // Verificar si existe sesión previa para informar en log
    if (fs.existsSync(authDir) && fs.readdirSync(authDir).length > 0) {
        console.log("📂 Sesión encontrada. Intentando restaurar conexión...");
    } else {
        console.log("📂 No hay sesión previa. Se generará un nuevo QR.");
    }

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
        
        // 1. CAPTURAR EL QR
        if (qr) {
            console.log("📡 QR Generado - Actualizando variable global");
            globalQR = qr; 
            connectionStatus = 'qr_ready';
        }

        if (connection === 'close') {
            const reason = (lastDisconnect.error)?.output?.statusCode;
            const shouldReconnect = reason !== DisconnectReason.loggedOut;
            console.log(`⚠️ Conexión cerrada. Razón: ${reason}, Reconectando: ${shouldReconnect}`);
            
            if (connectionStatus !== 'rebooting') {
                connectionStatus = 'disconnected';
            }
            
            globalQR = null;

            if (shouldReconnect && connectionStatus !== 'rebooting') {
                setTimeout(() => {
                    connectionStatus = 'disconnected'; 
                    connectToWhatsApp();
                }, 3000); 
            }
        } else if (connection === 'open') {
            console.log('✅ Bot CONECTADO y sincronizando...');
            connectionStatus = 'connected';
            globalQR = null; 
        }
    });

    sock.ev.on('contacts.upsert', (contacts) => syncContacts(contacts));

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        for (const msg of messages) {
            if (!msg.message || msg.key.fromMe) continue;
            const remoteJid = msg.key.remoteJid;
            if (remoteJid.includes('@g.us') || remoteJid === 'status@broadcast') continue;
            if (isBotDisabled(remoteJid)) continue; 
            await handleMessage(sock, msg);
        }
    });
}

// ==========================================
//             RUTAS API (CORE)
// ==========================================

// 1. ESTADO DEL BOT (Corregido para coincidir con HTML: /api/status)
app.get('/api/status', (req, res) => {
    const sessionPath = path.join(__dirname, authDir);
    // Verificamos si hay sesión solo si no estamos reiniciando
    const sessionExists = connectionStatus !== 'rebooting' && fs.existsSync(sessionPath) && fs.readdirSync(sessionPath).length > 0;

    res.json({
        status: connectionStatus === 'connected' ? 'connected' : connectionStatus, // Compatibilidad extra
        isConnected: connectionStatus === 'connected',
        qr: globalQR,
        sessionExists: sessionExists,
        statusString: connectionStatus
    });
});

// 2. INICIAR BOT (Protegido contra doble llamada)
app.post('/api/auth/init', (req, res) => {
    if (connectionStatus === 'disconnected') {
        connectToWhatsApp();
        res.json({ message: 'Iniciando conexión...' });
    } else {
        res.json({ message: `Ya en proceso (${connectionStatus})` });
    }
});

// 3. REINICIAR / LOGOUT (Corregido para coincidir con HTML: /api/logout)
app.post('/api/logout', async (req, res) => {
    try {
        console.log("🛑 Solicitud de REINICIO recibida.");
        
        connectionStatus = 'rebooting'; 
        globalQR = null;

        if (globalSock) {
            try { await globalSock.logout(); } catch(e) { console.log("Logout error:", e.message); }
            try { globalSock.end(undefined); } catch(e) {}
            globalSock = null;
        }
        
        await new Promise(r => setTimeout(r, 500));

        const sessionPath = path.join(__dirname, authDir);
        if (fs.existsSync(sessionPath)) {
            try {
                fs.rmSync(sessionPath, { recursive: true, force: true });
                console.log("🗑️ Carpeta de sesión eliminada.");
            } catch (err) {
                console.error("❌ Error borrando carpeta:", err.message);
            }
        }
        
        connectionStatus = 'disconnected'; 
        connectToWhatsApp();
        
        res.json({ success: true, message: 'Reinicio completado.' });
    } catch (e) {
        console.error(e);
        connectionStatus = 'disconnected';
        res.status(500).json({ error: 'Error al reiniciar' });
    }
});

// ==========================================
//             OTRAS RUTAS API
// ==========================================

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
app.post('/api/settings', async (req, res) => { 
    const current = getSettings();
    await saveSettings({ ...current, schedule: req.body.schedule }); 
    res.json({ success: true }); 
});

app.listen(port, () => {
    console.log(`🚀 Torre de Control en http://localhost:${port}`);
    connectToWhatsApp();
});
