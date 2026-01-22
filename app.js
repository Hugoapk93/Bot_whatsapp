const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const webpush = require('web-push');
const bodyParser = require('body-parser');

// --- IMPORTS LOCALES ---
const { getKeywords, saveKeyword, deleteKeyword } = require('./src/database');
const { findKeywordMatch } = require('./src/keywords');
const { handleMessage, sendStepMessage } = require('./src/flow');
const {
    initializeDB,
    getFullFlow,
    saveFlowStep,
    deleteFlowStep,
    getSettings,
    saveSettings,
    getAllUsers,
    updateUser,
    getUser,
    deleteUser,
    getSubscriptions,
    saveSubscription,
    removeSubscription
} = require('./src/database');
const { syncContacts, getAllContacts, toggleContactBot, addManualContact } = require('./src/contacts');

// CONFIGURACIÓN EXPRESS
const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(express.static('public'));

// ==========================================
// CONFIGURACIÓN WEB PUSH (VAPID)
// ==========================================
const publicVapidKey = 'BKdzNrgEPTOnZF14GlVWIQDQBO5e1fZqq0DqU3tcM_8dsCiVqjHslSYgNQVccHlhjyyebi3cpMTtpOHppN6i5RE';
const privateVapidKey = 'J_4mSjwet7y8i_xmiBsS9aG_BQXJjjfVXWO6qtcDeaA';

webpush.setVapidDetails(
    'mailto:tu_email@ejemplo.com',
    publicVapidKey,
    privateVapidKey
);

// --- NOTIFICACIONES PUSH GLOBALES ---
global.sendPushNotification = (title, body, url) => {
    const targetUrl = url || '/index.html#activity';
    const payload = JSON.stringify({ title, body, url: targetUrl });
    const subscriptions = getSubscriptions();

    subscriptions.forEach(subscription => {
        webpush.sendNotification(subscription, payload).catch(err => {
            console.error("Error enviando push:", err);
            if (err.statusCode === 410 || err.statusCode === 404) {
                removeSubscription(subscription.endpoint);
            }
        });
    });
};

// =================================================================
// 🛡️ ESCUDO ANTI-CAÍDAS
// =================================================================
process.on('uncaughtException', (err) => {
    console.error('🔥 CRITICAL ERROR (No Apagando):', err);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('⚠️ PROMISE ERROR (Sin Manejar):', reason);
});

// =================================================================
// SERVIDOR HTTP & SOCKET.IO
// =================================================================
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});
global.io = io;

io.on('connection', (socket) => {
    console.log('🔌 Simulador/Monitor conectado:', socket.id);
});

// =================================================================
// PUERTO Y TORRE DE CONTROL
// =================================================================
const args = process.argv.slice(2);
const portArgIndex = args.indexOf('--port');
const PORT = portArgIndex !== -1 ? parseInt(args[portArgIndex + 1]) : 3000;

const TOWER_URL = 'http://localhost:8888/api/instances/report';
const INSTANCE_ID = 'bot_' + PORT;

// --- CARPETAS ---
const uploadDir = path.join(__dirname, 'public/uploads');
const dataDir = path.join(__dirname, 'data');
const authDir = 'auth_info_baileys';

if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

// --- VARIABLES GLOBALES ---
let globalSock;
let globalQR = null;
let connectionStatus = 'disconnected';

// --- REPORTE DE ESTADO ---
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
                version: '2.2.0'
            })
        });
    } catch (e) { /* Silencioso */ }
}

// --- HELPER JSON ---
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

// --- AGENDA ---
const agendaPath = path.join(dataDir, 'agenda.json');
function getAgenda() { return safeReadJSON(agendaPath, {}); }
function saveAgenda(data) { fs.writeFileSync(agendaPath, JSON.stringify(data, null, 2)); }

// --- MULTER (SUBIDA DE ARCHIVOS) ---
const storage = multer.diskStorage({
    destination: function (req, file, cb) { cb(null, 'public/uploads/') },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

// INICIALIZAR DB
initializeDB();

// =================================================================
// CONEXIÓN WHATSAPP
// =================================================================
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
            if (global.io) global.io.emit('qr', { qr });
        }

        if (connection === 'close') {
            const reason = (lastDisconnect.error)?.output?.statusCode;
            const shouldReconnect = reason !== DisconnectReason.loggedOut;
            console.log(`⚠️ Conexión cerrada. Razón: ${reason}, Reconectando: ${shouldReconnect}`);

            if (connectionStatus !== 'rebooting') connectionStatus = 'disconnected';
            globalQR = null;
            reportToTower();
            if (global.io) global.io.emit('status', { status: 'disconnected' });

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
            if (global.io) global.io.emit('status', { status: 'connected' });
        }
    });

    sock.ev.on('contacts.upsert', (contacts) => syncContacts(contacts));

    // ==========================================================
    // >>> LÓGICA DE MENSAJES PRINCIPAL <<<
    // ==========================================================
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        const isFromMe = messages[0]?.key?.fromMe;
        if (type !== 'notify' && !isFromMe) return;

        // 1. REVISAR LICENCIA
        const settings = getSettings();
        if (settings.license && settings.license.end) {
            const today = new Date().toISOString().split('T')[0];
            if (today > settings.license.end) return console.log("🔒 LICENCIA VENCIDA.");
        }

        const allContacts = getAllContacts();

        for (const msg of messages) {
            if (!msg.message) continue;
            const remoteJid = msg.key.remoteJid;
            if (remoteJid.includes('@g.us') || remoteJid === 'status@broadcast') continue;

            const incomingPhoneRaw = remoteJid.replace(/[^0-9]/g, '');
            const isMe = msg.key.fromMe;

            // --- 1. AUTO-REGISTRO ---
            let contactConfig = allContacts.find(c => c.phone === incomingPhoneRaw);
            if (!contactConfig && !isMe) {
                console.log(`✨ Nuevo contacto detectado: ${incomingPhoneRaw}`);
                addManualContact(incomingPhoneRaw, incomingPhoneRaw, true);
                contactConfig = { phone: incomingPhoneRaw, name: incomingPhoneRaw, bot_enabled: true };
                
                if (global.io) global.io.emit('new_user', {
                    phone: incomingPhoneRaw,
                    name: incomingPhoneRaw,
                    last_active: new Date().toISOString(),
                    bot_enabled: true
                });
            }

            // --- 2. GUARDAR MENSAJE ---
            const msgText = msg.message?.conversation ||
                            msg.message?.extendedTextMessage?.text ||
                            msg.message?.imageMessage?.caption ||
                            '📷 (Media)';

            let currentUser = getUser(incomingPhoneRaw);
            if (!currentUser) {
                currentUser = { phone: incomingPhoneRaw, messages: [] };
                await updateUser(incomingPhoneRaw, { created_at: Date.now() });
            }
            if (!currentUser.messages) currentUser.messages = [];

            const now = new Date().toISOString();
            currentUser.messages.push({
                text: msgText,
                fromMe: isMe,
                timestamp: Date.now(),
                stepId: currentUser.current_step || 'INICIO'
            });

            if (currentUser.messages.length > 60) currentUser.messages.shift();

            await updateUser(incomingPhoneRaw, {
                messages: currentUser.messages,
                last_active: now
            });

            if (global.io) {
                global.io.emit('message', {
                    phone: incomingPhoneRaw,
                    text: msgText,
                    fromMe: isMe,
                    stepId: currentUser.current_step,
                    to: isMe ? incomingPhoneRaw : undefined,
                    from: !isMe ? incomingPhoneRaw : undefined
                });
                global.io.emit('user_update', {
                    phone: incomingPhoneRaw,
                    last_active: now,
                    last_message: msgText
                });
            }

            if (isMe) continue; // Si soy yo, termino aquí

            // --- 3. VERIFICAR BOT ENCENDIDO ---
            if (contactConfig && contactConfig.bot_enabled === false) {
                continue;
            }

            // ==========================================================
            // 🔥 INTERCEPTOR (RESPUESTAS RÁPIDAS) 🔥
            // ==========================================================
            const keywordMatch = findKeywordMatch(msgText);
            if (keywordMatch) {
                console.log(`🧠 Interceptor activado: "${keywordMatch.keywords}"`);
                
                // Enviar respuesta
                await globalSock.sendMessage(remoteJid, { text: keywordMatch.answer });

                // Retomar hilo visualmente
                const userState = getUser(incomingPhoneRaw);
                const currentStep = userState.current_step || 'INICIO';
                setTimeout(async () => {
                    await sendStepMessage(globalSock, remoteJid, currentStep, userState);
                }, 1000);

                continue; // ⛔ CORTAR FLUJO AQUÍ
            }
            // ==========================================================

            // --- 4. FLUJO NORMAL DEL BOT ---
            try {
                await handleMessage(sock, msg);

                // Auto-actualización de nombre
                const postFlowUser = getUser(incomingPhoneRaw);
                if (postFlowUser && postFlowUser.history) {
                    const capturedName = postFlowUser.history.nombre ||
                                         postFlowUser.history.name ||
                                         postFlowUser.history.cliente ||
                                         postFlowUser.history.usuario;

                    if (capturedName && contactConfig.name !== capturedName) {
                        console.log(`📝 Auto-actualizando nombre: ${contactConfig.name} -> ${capturedName}`);
                        addManualContact(incomingPhoneRaw, capturedName, contactConfig.bot_enabled);
                        await updateUser(incomingPhoneRaw, { name: capturedName });
                        if (global.io) global.io.emit('user_update', { phone: incomingPhoneRaw, name: capturedName });
                        contactConfig.name = capturedName;
                    }
                }
            } catch (err) {
                console.error("Error procesando mensaje:", err);
            }
        }
    });
}

// ==========================================
//              RUTAS API
// ==========================================

// --- CONTACTOS ---
app.post('/api/contacts/update', async (req, res) => {
    const { phone, name, enable } = req.body;
    await updateUser(phone, { name, bot_enabled: enable });
    toggleContactBot(phone, enable);
    res.json({ success: true });
});

app.post('/api/contacts/toggle', (req, res) => {
    res.json(toggleContactBot(req.body.phone, req.body.enable));
});

app.post('/api/contacts/add', (req, res) => {
    const { phone, name, enable } = req.body;
    if (!phone) return res.status(400).json({ success: false, message: 'Falta teléfono' });
    res.json(addManualContact(phone, name, enable));
});

app.post('/api/contacts/delete', async (req, res) => {
    const { phone } = req.body;
    const deleted = deleteUser(phone);
    res.json({ success: deleted });
});

// --- MENSAJES (BLINDADO) ---
app.post('/api/send-message', async (req, res) => {
    const { phone, text } = req.body;
    if (!globalSock || !phone || !text) return res.status(400).json({ error: "Datos faltantes o bot offline" });

    try {
        // 🔥 CORRECCIÓN DE JID PARA MÉXICO Y OTROS
        let jid = phone.toString().replace(/\D/g, ''); 
        
        // Manejo especial de lada México (52 -> 521)
        if (jid.startsWith('52') && !jid.startsWith('521') && jid.length === 12) {
             jid = '521' + jid.slice(2);
        }
        
        if (!jid.includes('@s.whatsapp.net')) {
            jid = jid + '@s.whatsapp.net';
        }

        await globalSock.sendMessage(jid, { text: text });
        
        // Guardar en historial local
        let cleanPhone = phone.replace(/[^0-9]/g, '');
        let currentUser = getUser(cleanPhone);
        if(currentUser) {
            if(!currentUser.messages) currentUser.messages = [];
            currentUser.messages.push({
                text: text,
                fromMe: true,
                timestamp: Date.now(),
                stepId: currentUser.current_step
            });
            await updateUser(cleanPhone, { messages: currentUser.messages });
        }
        res.json({ success: true });
    } catch (e) {
        console.error("Error enviando:", e);
        res.status(500).json({ error: e.message });
    }
});

// --- SIMULADOR ---
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

// --- KEYWORDS ---
app.get('/api/keywords', (req, res) => res.json(getKeywords()));
app.post('/api/keywords', (req, res) => {
    const rule = req.body;
    if (!rule.keywords || !rule.answer) return res.status(400).json({ error: 'Faltan datos' });
    const saved = saveKeyword(rule);
    res.json({ success: true, rule: saved });
});
app.delete('/api/keywords/:id', (req, res) => {
    deleteKeyword(req.params.id);
    res.json({ success: true });
});

// --- VARIOS ---
app.post('/api/subscribe', (req, res) => {
    saveSubscription(req.body);
    res.status(201).json({});
});
app.get('/api/vapid-key', (req, res) => { res.json({ key: publicVapidKey }); });
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
        reportToTower();
        globalQR = null;
        if (globalSock) {
            try { await globalSock.logout(); } catch (e) { }
            try { globalSock.end(undefined); } catch (e) { }
            globalSock = null;
        }
        await new Promise(r => setTimeout(r, 500));
        const sessionPath = path.join(__dirname, authDir);
        if (fs.existsSync(sessionPath)) {
            try { fs.rmSync(sessionPath, { recursive: true, force: true }); } catch (err) { }
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
app.post('/api/upload', upload.array('images', 10), (req, res) => {
    if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'No files' });
    const urls = req.files.map(file => '/uploads/' + file.filename);
    res.json({ urls: urls });
});
app.get('/api/flow', (req, res) => res.json(getFullFlow()));
app.post('/api/flow/step', async (req, res) => { await saveFlowStep(req.body.stepId, req.body.stepData); res.json({ success: true }); });
app.delete('/api/flow/step/:id', async (req, res) => { await deleteFlowStep(req.params.id); res.json({ success: true }); });
app.get('/api/users', (req, res) => res.json(getAllUsers()));

// --- CRM EXECUTE ---
app.post('/api/crm/execute', async (req, res) => {
    const { phone, stepId } = req.body;
    if (!stepId) return res.status(400).json({ error: "Sin destino." });
    try {
        await updateUser(phone, { current_step: stepId });
        
        // Si es simulador
        if (phone === 'TEST_SIMULADOR' || phone === '5218991234567') {
            await sendStepMessage(globalSock || {}, phone, stepId, getUser(phone));
            return res.json({ success: true });
        }

        if (!globalSock) return res.status(500).json({ error: "Bot offline" });
        
        const user = getUser(phone);
        let targetJid = user?.jid;
        
        // Si no tenemos JID guardado, lo construimos
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
    db[date].sort((a, b) => a.time.localeCompare(b.time));
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

app.get('/api/settings', (req, res) => res.json(getSettings()));
app.post('/api/settings', async (req, res) => {
    const current = getSettings();
    const newSettings = { ...current, ...req.body };
    await saveSettings(newSettings);
    res.json({ success: true });
});

// =================================================================
// 🔌 CIERRE ELEGANTE
// =================================================================
const gracefulShutdown = () => {
    console.log('🛑 Cerrando bot (Signal recibida)...');
    reportToTower().then(() => {
        if (globalSock) {
            try { globalSock.end(undefined); } catch (e) { }
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
