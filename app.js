const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const express = require('express');
const http = require('http'); 
const { Server } = require('socket.io'); 
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
// 🛡️ MEJORA 1: ESCUDO ANTI-CAÍDAS (ANTI-CRASH)
// =================================================================
process.on('uncaughtException', (err) => {
    console.error('🔥 CRITICAL ERROR (No Apagando):', err);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('⚠️ PROMISE ERROR (Sin Manejar):', reason);
});

// =================================================================
// CONFIGURACIÓN DE SOCKET.IO Y SERVIDOR HTTP
// =================================================================
const server = http.createServer(app); 
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

global.io = io; 

io.on('connection', (socket) => {
    console.log('🔌 Simulador Web conectado:', socket.id);
    socket.on('message', (data) => console.log('Mensaje desde simulador:', data));
});

// =================================================================
// CONFIGURACIÓN DINÁMICA DE PUERTO
// =================================================================
const args = process.argv.slice(2);
const portArgIndex = args.indexOf('--port');
const PORT = portArgIndex !== -1 ? parseInt(args[portArgIndex + 1]) : 3000;

// CONFIG DE LA TORRE
const TOWER_URL = 'http://localhost:8888/api/instances/report';
const INSTANCE_ID = 'bot_' + PORT;

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
// FUNCIÓN DE REPORTE A LA TORRE
// =================================================================
async function reportToTower() {
    try {
        await fetch(TOWER_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                id: INSTANCE_ID,
                port: PORT,
                status: connectionStatus,
                qr: globalQR,
                version: '2.2.0' // Versión Robusta Contactos
            })
        });
    } catch (e) { /* Silencioso */ }
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
    reportToTower(); 
    console.log("🔄 Iniciando conexión a WhatsApp...");

    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: true, 
        logger: pino({ level: 'silent' }),
        keepAliveIntervalMs: 30000, 
        retryRequestDelayMs: 2000,      
        connectTimeoutMs: 60000,       
        syncFullHistory: false,        
        browser: ["CRM Bot", "Chrome", "2.0.0"],
    });
    
    globalSock = sock;

    sock.ev.on('creds.update', saveCreds);
    
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log("📡 QR Generado");
            globalQR = qr; 
            connectionStatus = 'qr_ready';
            reportToTower(); 
            if(global.io) global.io.emit('qr', { qr });
        }

        if (connection === 'close') {
            const reason = (lastDisconnect.error)?.output?.statusCode;
            const shouldReconnect = reason !== DisconnectReason.loggedOut;
            console.log(`⚠️ Conexión cerrada. Razón: ${reason}, Reconectando: ${shouldReconnect}`);
            
            if (connectionStatus !== 'rebooting') connectionStatus = 'disconnected';
            globalQR = null;
            reportToTower(); 
            if(global.io) global.io.emit('status', { status: 'disconnected' });

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
            reportToTower(); 
            if(global.io) global.io.emit('status', { status: 'connected' });
        }
    });

    sock.ev.on('contacts.upsert', (contacts) => syncContacts(contacts));

    // >>> LOGICA DE MENSAJES <<<
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        // 1. REVISAR LICENCIA
        const settings = getSettings();
        if (settings.license && settings.license.end) {
            const today = new Date().toISOString().split('T')[0];
            if (today > settings.license.end) {
                console.log("🔒 LICENCIA VENCIDA. Bot en pausa.");
                return;
            }
        }

        const allContacts = getAllContacts(); 

        for (const msg of messages) {
            if (!msg.message || msg.key.fromMe) continue;
            
            const remoteJid = msg.key.remoteJid;
            if (remoteJid.includes('@g.us') || remoteJid === 'status@broadcast') continue;

            const incomingPhoneRaw = remoteJid.replace(/[^0-9]/g, ''); 
            const incomingName = msg.pushName || ''; 

            // === LÓGICA DE BLOQUEO ROBUSTA (TRIPLE VERIFICACIÓN + LIMPIEZA) ===
            const isBlocked = allContacts.some(contact => {
                // Solo revisamos contactos que estén explícitamente APAGADOS (false)
                if (contact.bot_enabled !== false) return false; 
                
                // --- HELPER: NORMALIZAR CADENAS (Quitar acentos, emojis, espacios) ---
                const normalizeString = (str) => {
                    if (!str) return '';
                    return str.normalize("NFD").replace(/[\u0300-\u036f]/g, "") // Quita acentos
                              .replace(/[^a-zA-Z0-9]/g, "") // Quita emojis y símbolos
                              .toLowerCase();
                };

                // --- HELPER: NORMALIZAR TELÉFONOS (MX 10 Dígitos) ---
                const normalizePhone = (ph) => {
                    if (!ph) return '';
                    let clean = ph.replace(/[^0-9]/g, '');
                    if (clean.startsWith('52') && clean.length >= 12) return clean.slice(-10);
                    return clean;
                };

                // 1️⃣ CHECK POR TELÉFONO (Principal)
                const dbPhoneNorm = normalizePhone(contact.phone || contact.id);
                const incPhoneNorm = normalizePhone(incomingPhoneRaw);
                if (dbPhoneNorm && incPhoneNorm && dbPhoneNorm === incPhoneNorm) return true;

                // 2️⃣ CHECK POR TELÉFONO CRUDO (LIDs numéricos)
                const rawDB = (contact.phone || '').replace(/[^0-9]/g, '');
                if (rawDB.length > 5 && rawDB === incomingPhoneRaw) return true;

                // 3️⃣ CHECK POR NOMBRE (Respaldo para LIDs y Contactos Descargados)
                // Comparamos el nombre que llega (PushName) contra:
                // A) El nombre que tú guardaste en la agenda (contact.name)
                // B) El nombre de perfil que WhatsApp sincronizó antes (contact.notify)
                
                const incNameClean = normalizeString(incomingName);
                const dbNameClean = normalizeString(contact.name);
                const dbNotifyClean = normalizeString(contact.notify); // A veces se guarda aquí

                // Regla de seguridad: El nombre debe tener al menos 3 letras para evitar falsos positivos
                if (incNameClean.length < 3) return false;

                // Comparación A: Nombre Guardado
                if (dbNameClean && dbNameClean === incNameClean) {
                    console.log(`⛔ Bloqueo por Nombre Guardado: "${contact.name}"`);
                    return true;
                }

                // Comparación B: Nombre Notify (Sincronizado)
                if (dbNotifyClean && dbNotifyClean === incNameClean) {
                    console.log(`⛔ Bloqueo por Nombre Sincronizado: "${contact.notify}"`);
                    return true;
                }

                return false;
            });

            if (isBlocked) {
                // Contacto bloqueado detectado. Ignoramos.
                continue; 
            }

            try {
                await handleMessage(sock, msg);
            } catch (err) {
                console.error("Error procesando mensaje:", err);
            }
        }
    });
}

// ==========================================
//             RUTAS API
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

// LOGOUT / REINICIO SEGURO
app.post('/api/logout', async (req, res) => {
    try {
        console.log("🛑 Solicitud de REINICIO recibida.");
        connectionStatus = 'rebooting'; 
        reportToTower(); 
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
        reportToTower(); 
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
        
        if (phone === 'TEST_SIMULADOR' || phone === '5218991234567') {
             await sendStepMessage(globalSock || {}, phone, stepId, getUser(phone));
             return res.json({ success: true });
        }

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
    const newSettings = { ...current, ...req.body };
    await saveSettings(newSettings); 
    res.json({ success: true }); 
});

app.post('/api/simulate/text', async (req, res) => {
    const { phone, text } = req.body;
    if (!phone || !text) return res.status(400).json({ error: "Faltan datos" });

    const fakeMsg = {
        key: {
            remoteJid: phone.includes('@') ? phone : `${phone}@s.whatsapp.net`,
            fromMe: false,
            id: 'SIM_' + Date.now()
        },
        message: { conversation: text },
        pushName: 'Usuario Simulador'
    };

    console.log(`🤖 Simulador: ${text}`);

    try {
        await handleMessage(globalSock || {}, fakeMsg);
        res.json({ success: true });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: e.message });
    }
});

// =================================================================
// 🔌 MEJORA 3: CIERRE ELEGANTE (GRACEFUL SHUTDOWN)
// =================================================================
const gracefulShutdown = () => {
    console.log('🛑 Cerrando bot (Signal recibida)...');
    reportToTower().then(() => {
        if (globalSock) {
            try { globalSock.end(undefined); } catch (e) {}
        }
        process.exit(0);
    });
};
process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

// ARRANCAR EL BOT
server.listen(PORT, () => {
    console.log(`🚀 Torre de Control Local + Sockets en puerto: ${PORT}`);
    connectToWhatsApp();
    reportToTower();
});
