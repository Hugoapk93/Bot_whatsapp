const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cors = require('cors');

const { handleMessage, sendStepMessage } = require('./src/flow');
const { initializeDB, getFullFlow, saveFlowStep, deleteFlowStep, getSettings, saveSettings, getAllUsers, updateUser, getUser, clearAllSessions } = require('./src/database');
const { syncContacts, getAllContacts, toggleContactBot, isBotDisabled, addManualContact } = require('./src/contacts');

const app = express();
app.use(cors());
const port = process.env.PORT || 3000;

const uploadDir = path.join(__dirname, 'public/uploads');
const dataDir = path.join(__dirname, 'data'); 
const authDir = path.join(__dirname, 'auth_info_baileys');

if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const agendaPath = path.join(dataDir, 'agenda.json');

function getAgenda() {
    if (!fs.existsSync(agendaPath)) fs.writeFileSync(agendaPath, '{}');
    try { return JSON.parse(fs.readFileSync(agendaPath)); } catch (e) { return {}; }
}

function saveAgenda(data) {
    fs.writeFileSync(agendaPath, JSON.stringify(data, null, 2));
}

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

let globalSock;
let qrCodeData = null; // Para guardar el código de vinculación temporalmente
let isConnecting = false;

initializeDB();

async function connectToWhatsApp(phoneNumber = null) {
    // Si ya estamos conectando, evitamos duplicidad
    if (isConnecting && !phoneNumber) return;
    isConnecting = true;

    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
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
        browser: ["Ubuntu", "Chrome", "20.0.04"],
    });
    
    globalSock = sock;

    // Solo pedimos código si nos mandaron un número y NO estamos registrados
    if (phoneNumber && !sock.authState.creds.registered) {
        setTimeout(async () => {
            try {
                const code = await sock.requestPairingCode(phoneNumber);
                qrCodeData = code; // Guardamos el código para que el front lo lea
                console.log("CÓDIGO GENERADO: " + code);
            } catch (error) {
                console.log("Error pidiendo código: ", error);
                qrCodeData = "ERROR";
            }
        }, 3000); 
    }

    sock.ev.on('creds.update', saveCreds);
    
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                connectToWhatsApp(); 
            } else {
                console.log("Desconectado. Esperando reinicio manual.");
                isConnecting = false;
            }
        } else if (connection === 'open') {
            console.log('✅ Bot CONECTADO');
            qrCodeData = "CONNECTED"; // Señal para el frontend
            isConnecting = false;
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

// --- API DE AUTENTICACIÓN Y VINCULACIÓN ---

// 1. Estado de conexión
app.get('/api/auth/status', (req, res) => {
    const sessionExists = fs.existsSync(path.join(authDir, 'creds.json'));
    const isConnected = globalSock?.user ? true : false;
    res.json({ sessionExists, isConnected, pairingCode: qrCodeData });
});

// 2. Iniciar vinculación (Recibe teléfono)
app.post('/api/auth/init', async (req, res) => {
    const { phone } = req.body;
    if(!phone) return res.status(400).json({error: "Falta teléfono"});
    
    // Limpiamos sesión previa por si acaso
    if (fs.existsSync(authDir)) {
        fs.rmSync(authDir, { recursive: true, force: true });
    }
    
    qrCodeData = null;
    await connectToWhatsApp(phone);
    res.json({ success: true });
});

// 3. Resetear sesión (Si falló)
app.post('/api/auth/reset', async (req, res) => {
    try {
        if(globalSock) globalSock.end(undefined);
    } catch(e) {}
    
    if (fs.existsSync(authDir)) {
        fs.rmSync(authDir, { recursive: true, force: true });
    }
    qrCodeData = null;
    isConnecting = false;
    res.json({ success: true });
});

// --- RUTAS DEL BOT EXISTENTES ---
app.get('/api/contacts', (req, res) => { res.json(getAllContacts()); });
app.post('/api/contacts/toggle', (req, res) => { res.json(toggleContactBot(req.body.phone, req.body.enable)); });
app.post('/api/contacts/add', (req, res) => { if (!req.body.phone) return res.status(400).json({ success: false }); res.json(addManualContact(req.body.phone, req.body.name, req.body.enable)); });
app.post('/api/upload', upload.array('images', 10), (req, res) => { if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'No files' }); res.json({ urls: req.files.map(file => '/uploads/' + file.filename) }); });
app.get('/api/flow', (req, res) => res.json(getFullFlow()));
app.post('/api/flow/step', async (req, res) => { await saveFlowStep(req.body.stepId, req.body.stepData); res.json({ success: true }); });
app.delete('/api/flow/step/:id', async (req, res) => { await deleteFlowStep(req.params.id); res.json({ success: true }); });
app.get('/api/users', (req, res) => res.json(getAllUsers()));
app.post('/api/users/toggle', async (req, res) => { await updateUser(req.body.phone, { blocked: req.body.isBlocked }); res.json({ success: true }); });
app.post('/api/crm/execute', async (req, res) => {
    const { phone, stepId } = req.body;
    try {
        await updateUser(phone, { current_step: stepId });
        if (phone === 'TEST_SIMULADOR') return res.json({ success: true });
        if (!globalSock) return res.status(500).json({ error: "Bot offline" });
        const user = getUser(phone);
        let targetJid = user?.jid || (phone.replace(/[^0-9]/g, '') + '@s.whatsapp.net');
        await sendStepMessage(globalSock, targetJid, stepId, user);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: "Error" }); }
});
app.post('/api/users/sync', async (req, res) => { await updateUser(req.body.phone, req.body.data); res.json({ success: true }); });
app.get('/api/agenda', (req, res) => res.json(getAgenda()));
app.post('/api/agenda/book', (req, res) => {
    const { date, time, phone, name, note } = req.body;
    const db = getAgenda();
    if (!db[date]) db[date] = [];
    if (db[date].some(c => c.time === time)) return res.json({ success: false });
    db[date].push({ time, phone: phone || '', name: name || 'Evento', note: note || '', created_at: new Date().toISOString() });
    db[date].sort((a,b) => a.time.localeCompare(b.time));
    saveAgenda(db); res.json({ success: true });
});
app.post('/api/agenda/delete', (req, res) => {
    const { date, time } = req.body; const db = getAgenda(); 
    if (db[date]) { db[date] = db[date].filter(c => c.time !== time); if (db[date].length === 0) delete db[date]; saveAgenda(db); res.json({ success: true }); } 
    else res.json({ success: false });
});
app.post('/api/agenda/update', (req, res) => {
    const { oldDate, oldTime, newDate, newTime, name, phone, note } = req.body; const db = getAgenda();
    if (db[oldDate]) { db[oldDate] = db[oldDate].filter(c => c.time !== oldTime); if (db[oldDate].length === 0) delete db[oldDate]; }
    if (!db[newDate]) db[newDate] = [];
    if ((oldDate !== newDate || oldTime !== newTime) && db[newDate].some(c => c.time === newTime)) return res.json({ success: false });
    db[newDate].push({ time: newTime, phone: phone || '', name: name || 'Evento', note: note || '', updated_at: new Date().toISOString() });
    db[newDate].sort((a,b) => a.time.localeCompare(b.time));
    saveAgenda(db); res.json({ success: true });
});
app.get('/api/admin/clear-monitor', (req, res) => {
    try { if(typeof clearAllSessions === 'function') clearAllSessions(); res.send(`<script>window.location.href='/'</script>`); } catch (e) { res.status(500).send("Error"); }
});
app.get('/api/settings', (req, res) => res.json(getSettings()));
app.post('/api/settings', async (req, res) => { 
    const current = getSettings();
    const newSettings = { ...current, schedule: req.body.schedule };
    await saveSettings(newSettings); 
    res.json({ success: true }); 
});
app.post('/api/admin/license', async (req, res) => {
    const { start, end } = req.body;
    const current = getSettings();
    const newSettings = { ...current, license: { start, end } };
    await saveSettings(newSettings);
    res.json({ success: true });
});

// --- INICIO DEL SERVIDOR ---
app.listen(port, () => {
    console.log(`🚀 Server corriendo en http://localhost:${port}`);
    // AL INICIAR: Verificamos si ya existe sesión para conectar automáticamente
    if (fs.existsSync(path.join(authDir, 'creds.json'))) {
        console.log("🔄 Sesión encontrada, reconectando...");
        connectToWhatsApp();
    } else {
        console.log("💤 Esperando vinculación manual vía Web...");
    }
});
