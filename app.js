const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, downloadMediaMessage } = require('@whiskeysockets/baileys');
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

const { getKeywords, saveKeyword, deleteKeyword } = require('./src/database');
const { findKeywordMatch } = require('./src/keywords');
const { handleMessage, sendStepMessage } = require('./src/flow');

const { initScheduler } = require('./src/flow/scheduler'); 

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

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(express.static('public'));

const publicVapidKey = 'BKdzNrgEPTOnZF14GlVWIQDQBO5e1fZqq0DqU3tcM_8dsCiVqjHslSYgNQVccHlhjyyebi3cpMTtpOHppN6i5RE';
const privateVapidKey = 'J_4mSjwet7y8i_xmiBsS9aG_BQXJjjfVXWO6qtcDeaA';

webpush.setVapidDetails(
    'mailto:tu_email@ejemplo.com',
    publicVapidKey,
    privateVapidKey
);

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

process.on('uncaughtException', (err) => {
    console.error('🔥 CRITICAL ERROR (No Apagando):', err);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('⚠️ PROMISE ERROR (Sin Manejar):', reason);
});

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});
global.io = io;

io.on('connection', (socket) => {
    console.log('🔌 Simulador/Monitor conectado:', socket.id);
});

const args = process.argv.slice(2);
const portArgIndex = args.indexOf('--port');
const PORT = portArgIndex !== -1 ? parseInt(args[portArgIndex + 1]) : 3000;

const TOWER_URL = 'http://localhost:8888/api/instances/report';
const INSTANCE_ID = 'bot_' + PORT;

const uploadDir = path.join(__dirname, 'public/uploads');
const dataDir = path.join(__dirname, 'data');
const authDir = 'auth_info_baileys';

if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

let globalSock;
let globalQR = null;
let connectionStatus = 'disconnected';

const userMessageBuffers = new Map();
const userMessageTimers = new Map();

// 🔥 FUNCIÓN CENTRALIZADA PARA PROCESAR EL TEXTO AGRUPADO 🔥
async function procesarMensajeAgrupado(incomingPhoneRaw, sock) {
    if (!userMessageTimers.has(incomingPhoneRaw)) return;
    
    const timerData = userMessageTimers.get(incomingPhoneRaw);
    const finalMsg = timerData.msg;
    const bufferInfo = userMessageBuffers.get(incomingPhoneRaw);
    
    if (!bufferInfo || bufferInfo.length === 0) {
        userMessageTimers.delete(incomingPhoneRaw);
        return;
    }

    const joinedText = bufferInfo.join(' ');
    userMessageBuffers.delete(incomingPhoneRaw);
    userMessageTimers.delete(incomingPhoneRaw);

    console.log(`📦 Mensaje agrupado de ${incomingPhoneRaw}: "${joinedText}"`);

    if (finalMsg.message.extendedTextMessage) {
        finalMsg.message.extendedTextMessage.text = joinedText;
    } else if (finalMsg.message.conversation) {
        finalMsg.message.conversation = joinedText;
    } else {
        finalMsg.message = { conversation: joinedText };
    }

    const keywordMatch = findKeywordMatch(joinedText);
    const remoteJid = finalMsg.key.remoteJid;

    if (keywordMatch) {
        console.log(`🧠 Interceptor activado: "${keywordMatch.keywords}"`);
        await sock.sendMessage(remoteJid, { text: keywordMatch.answer });
        const userState = getUser(incomingPhoneRaw);
        setTimeout(async () => {
            await sendStepMessage(sock, remoteJid, userState.current_step || 'INICIO', userState);
        }, 1000);
        return; 
    }

    try {
        await handleMessage(sock, finalMsg);

        const postFlowUser = getUser(incomingPhoneRaw);
        if (postFlowUser && postFlowUser.history) {
            const capturedName = postFlowUser.history.nombre ||
                                 postFlowUser.history.cliente ||
                                 postFlowUser.history.usuario;

            const allContacts = getAllContacts();
            let contactConfig = allContacts.find(c => c.phone === incomingPhoneRaw);

            if (capturedName && contactConfig && contactConfig.name !== capturedName) {
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
    } catch (e) {}
}

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

const agendaPath = path.join(dataDir, 'agenda.json');
const lidMapPath = path.join(dataDir, 'lid_map.json');
function getLidMap() { return safeReadJSON(lidMapPath, {}); }
function saveLidMap(data) { fs.writeFileSync(lidMapPath, JSON.stringify(data, null, 2)); }

function getAgenda() { return safeReadJSON(agendaPath, {}); }
function saveAgenda(data) { fs.writeFileSync(agendaPath, JSON.stringify(data, null, 2)); }

const storage = multer.diskStorage({
    destination: function (req, file, cb) { cb(null, 'public/uploads/') },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

initializeDB();

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

    sock.ev.on('presence.update', (m) => {
        const fullJid = m.id; // Necesitamos el ID completo con @s.whatsapp.net
        const incomingPhoneRaw = fullJid.replace(/[^0-9]/g, '');
        
        // Buscamos el estado usando el ID completo
        const estado = m.presences[fullJid]?.lastKnownPresence; 

        if (userMessageTimers.has(incomingPhoneRaw) && estado) {
            const timerData = userMessageTimers.get(incomingPhoneRaw);
            
            if (estado === 'composing') {
                clearTimeout(timerData.timer);
                timerData.timer = setTimeout(() => procesarMensajeAgrupado(incomingPhoneRaw, globalSock), 10000);
                console.log(`⏱️ Extendiendo tiempo para ${incomingPhoneRaw} (Está escribiendo...)`);
            } 
            else if (estado === 'paused') {
                clearTimeout(timerData.timer);
                console.log(`⚡ Procesando rápido a ${incomingPhoneRaw} (Dejó de escribir)`);
                procesarMensajeAgrupado(incomingPhoneRaw, globalSock);
            }
        }
    });

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
            
            initScheduler(sock);
        }
    });

    sock.ev.on('contacts.upsert', (contacts) => {
        syncContacts(contacts);
        let lidMap = getLidMap();
        let updated = false;
        
        for (const c of contacts) {
            const cId = c.id || '';
            const cLid = c.lid || '';

            if (cId.includes('@s.whatsapp.net') && cLid.includes('@lid')) {
                const cleanPhone = cId.replace(/[^0-9]/g, '');
                const cleanLid = cLid.replace(/[^0-9]/g, '');

                if (cleanPhone && cleanLid && lidMap[cleanLid] !== cleanPhone) {
                    lidMap[cleanLid] = cleanPhone;
                    updated = true;
                    console.log(`🔗 Auto-Vinculación: Máscara ${cleanLid} -> Tel Real ${cleanPhone}`);
                }
            }
        }
        if (updated) saveLidMap(lidMap);
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        const isFromMe = messages[0]?.key?.fromMe;
        if (type !== 'notify' && !isFromMe) return;

        const settings = getSettings();
        if (settings.license && settings.license.end) {
            const today = new Date().toISOString().split('T')[0];
            if (today > settings.license.end) return console.log("🔒 LICENCIA VENCIDA.");
        }

        const allContacts = getAllContacts();

        for (const msg of messages) {
            if (!msg.message) continue;

            if (msg.message.protocolMessage || msg.messageStubType) {
                console.log(`🚫 Ignorando mensaje interno/sistema de WhatsApp.`);
                continue;
            }

            let remoteJid = msg.key.remoteJid;

            if (remoteJid && remoteJid.includes('@lid')) {
                let lidMap = getLidMap();
                const cleanLid = remoteJid.replace(/[^0-9]/g, '');
                const realPhone = lidMap[cleanLid];

                if (realPhone) {
                    console.log(`✅ Traductor: Convirtiendo ${cleanLid} a ${realPhone}`);
                    remoteJid = realPhone + '@s.whatsapp.net';
                    msg.key.remoteJid = remoteJid; 
                }
            }

            if (remoteJid && (remoteJid.includes('@g.us') || remoteJid.includes('@broadcast') || remoteJid.includes('@newsletter'))) {
                continue; 
            }

            const incomingPhoneRaw = remoteJid.replace(/[^0-9]/g, '');
            const isMe = msg.key.fromMe;

            let contactConfig = allContacts.find(c => c.phone === incomingPhoneRaw);
            
            if (!contactConfig && !isMe) {
                console.log(`✨ Nuevo contacto detectado: ${incomingPhoneRaw}`);
                addManualContact(incomingPhoneRaw, incomingPhoneRaw, true);
                contactConfig = { phone: incomingPhoneRaw, name: incomingPhoneRaw, bot_enabled: true };
                
                global.sendPushNotification(
                    "🆕 Nuevo Cliente", 
                    `El número ${incomingPhoneRaw} ha iniciado una conversación.`, 
                    "/#activity"
                );

                if (global.io) global.io.emit('new_user', {
                    phone: incomingPhoneRaw,
                    name: incomingPhoneRaw,
                    last_active: new Date().toISOString(),
                    bot_enabled: true
                });
            }

            let imageUrl = null;
            let msgText = msg.message?.conversation ||
                          msg.message?.extendedTextMessage?.text ||
                          msg.message?.imageMessage?.caption ||
                          msg.message?.videoMessage?.caption ||
                          '';

            if (msg.message?.imageMessage) {
                try {
                    const buffer = await downloadMediaMessage(msg, 'buffer', { }, { logger: pino({ level: 'silent' }) });
                    const fileName = `img_${Date.now()}.jpeg`;
                    fs.writeFileSync(path.join(uploadDir, fileName), buffer);
                    imageUrl = `/uploads/${fileName}`;
                } catch (e) {
                    console.error("❌ Error descargando imagen:", e.message);
                }
            }

            let currentUser = getUser(incomingPhoneRaw);
            if (!currentUser) {
                currentUser = { phone: incomingPhoneRaw, messages: [] };
                await updateUser(incomingPhoneRaw, { created_at: Date.now() });
            }
            if (!currentUser.messages) currentUser.messages = [];

            const now = new Date().toISOString();
            
            currentUser.messages.push({
                text: msgText,
                mediaUrl: imageUrl,
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
                    mediaUrl: imageUrl,
                    fromMe: isMe,
                    stepId: currentUser.current_step,
                    to: isMe ? incomingPhoneRaw : undefined,
                    from: !isMe ? incomingPhoneRaw : undefined
                });
                global.io.emit('user_update', {
                    phone: incomingPhoneRaw,
                    last_active: now,
                    last_message: imageUrl ? '📷 Imagen recibida' : msgText
                });
            }

            if (isMe) continue; 
            if (contactConfig && contactConfig.bot_enabled === false) continue;

            if (msgText.trim()) {
                if (!userMessageBuffers.has(incomingPhoneRaw)) {
                    userMessageBuffers.set(incomingPhoneRaw, []);
                }
                userMessageBuffers.get(incomingPhoneRaw).push(msgText);

                try { await sock.presenceSubscribe(remoteJid); } catch (e) {}
            }

            if (userMessageTimers.has(incomingPhoneRaw)) {
                clearTimeout(userMessageTimers.get(incomingPhoneRaw).timer);
            }

            // Guardamos el timeout Y la referencia al último mensaje para poder usarlo después
            const nuevoTimer = setTimeout(() => {
                procesarMensajeAgrupado(incomingPhoneRaw, sock);
            }, 4500); // Mantenemos 4.5 segundos como red de seguridad por defecto

            userMessageTimers.set(incomingPhoneRaw, {
                timer: nuevoTimer,
                msg: msg
            });
        }
    });
}

app.post('/api/contacts/update', async (req, res) => {
    const { phone, name, enable } = req.body;

    const user = getUser(phone) || {};
    if (!user.history) user.history = {};
    user.history.nombre = name;
    await updateUser(phone, { name, bot_enabled: enable, history: user.history });

    addManualContact(phone, name, enable);

    if (global.io) {
        global.io.emit('user_update', { phone: phone, name: name, bot_enabled: enable });
    }
    
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

app.post('/api/contacts/link-lid', async (req, res) => {
    const { lidPhone, realPhone } = req.body;
    if (!lidPhone || !realPhone) return res.status(400).json({ error: "Faltan datos" });

    const cleanLid = String(lidPhone).replace(/[^0-9]/g, '');
    const cleanReal = String(realPhone).replace(/[^0-9]/g, '');

    // 1. Guardar en el diccionario global
    let lidMap = getLidMap();
    lidMap[cleanLid] = cleanReal;
    saveLidMap(lidMap);

    const userLid = getUser(cleanLid);
    if (userLid) {
        let userReal = getUser(cleanReal);
        if (!userReal) {
            userReal = { ...userLid, phone: cleanReal };
        } else {
            userReal.messages = [...(userReal.messages || []), ...(userLid.messages || [])];
            userReal.messages.sort((a,b) => new Date(a.timestamp) - new Date(b.timestamp)); // Ordenar por fecha
            userReal.name = userReal.name || userLid.name; // Pasar el nombre
        }
        
        await updateUser(cleanReal, userReal);
        deleteUser(cleanLid); // Borramos el registro fantasma del LID
        
        if (global.io) global.io.emit('status', { status: 'connected' }); // Forzar refresco ligero en el cliente
    }

    res.json({ success: true, newPhone: cleanReal });
});

app.post('/api/send-message', async (req, res) => {
    const { phone, text, mediaUrl } = req.body;
    
    if (!globalSock || !phone) return res.status(400).json({ error: "Datos faltantes o bot offline" });

    try {
        const cleanPhone = phone.toString().replace(/\D/g, ''); 
        const user = getUser(cleanPhone);
        let targetJid = user && user.jid ? user.jid : (phone.includes('@') ? phone : cleanPhone + '@s.whatsapp.net');

        if (mediaUrl) {
            const relativePath = mediaUrl.startsWith('/') ? mediaUrl.slice(1) : mediaUrl;
            const absolutePath = path.join(__dirname, 'public', relativePath);
            await globalSock.sendMessage(targetJid, { image: { url: absolutePath }, caption: text || '' });
        } else {
            await globalSock.sendMessage(targetJid, { text: text || '' });
        }
        
        if (user) {
            if(!user.messages) user.messages = [];
            
            user.messages.push({
                text: text || '',
                mediaUrl: mediaUrl || null,
                fromMe: true,
                timestamp: Date.now(),
                stepId: user.current_step || 'MANUAL'
            });
            await updateUser(cleanPhone, { messages: user.messages });
        }
        res.json({ success: true });
    } catch (e) {
        console.error("Error enviando:", e);
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/simulate/text', async (req, res) => {
    const { phone, text } = req.body;
    if (!phone || !text) return res.status(400).json({ error: "Faltan datos" });

    const fakeMsg = {
        key: { remoteJid: phone.includes('@') ? phone : `${phone}@s.whatsapp.net`, fromMe: false, id: 'SIM_' + Date.now() },
        message: { conversation: text },
        pushName: 'Usuario Simulador'
    };
    try {
        await handleMessage(globalSock || {}, fakeMsg);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

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

server.listen(PORT, () => {
    console.log(`🚀 Torre de Control Local + Sockets en puerto: ${PORT}`);
    connectToWhatsApp();
    reportToTower();
});
