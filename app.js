const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const express = require('express');
const qrcode = require('qrcode-terminal');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// --- IMPORTS: Lógica del flujo y Base de Datos ---
const { handleMessage, sendStepMessage } = require('./src/flow');
const { initializeDB, getFullFlow, saveFlowStep, deleteFlowStep, getSettings, saveSettings, getAllUsers, updateUser, getUser, clearAllSessions } = require('./src/database');
const { syncContacts, getAllContacts, toggleContactBot, isBotDisabled, addManualContact } = require('./src/contacts');

const app = express();
const port = 3001; // <--- PUERTO 3001

// --- CONFIGURACIÓN DE CARPETAS ---
const uploadDir = path.join(__dirname, 'public/uploads');
const dataDir = path.join(__dirname, 'data'); 

if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

// --- LÓGICA DE AGENDA (BACKEND) ---
const agendaPath = path.join(dataDir, 'agenda.json');

function getAgenda() {
    if (!fs.existsSync(agendaPath)) fs.writeFileSync(agendaPath, '{}');
    try { return JSON.parse(fs.readFileSync(agendaPath)); } catch (e) { return {}; }
}

function saveAgenda(data) {
    fs.writeFileSync(agendaPath, JSON.stringify(data, null, 2));
}

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

let globalSock;

// --- INICIALIZAR BASES DE DATOS ---
initializeDB();

// --- LÓGICA DE CONEXIÓN WHATSAPP (MODIFICADO PARA CÓDIGO DE VINCULACIÓN) ---
async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const { version } = await fetchLatestBaileysVersion();

    // 🔴 1. TU NÚMERO AQUÍ (Código de país 52 + 1 + número)
    const myPhoneNumber = "5218995640404"; 

    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false, // 🔴 2. APAGAMOS EL QR
        logger: pino({ level: 'silent' }),
        
        // CONFIGURACIÓN ANTI-DORMIR (KEEP-ALIVE)
        keepAliveIntervalMs: 10000, 
        retryRequestDelayMs: 2000,   
        connectTimeoutMs: 60000,     
        syncFullHistory: false,      
        
        // Simular Navegador Desktop (Ayuda a la estabilidad)
        browser: ["Ubuntu", "Chrome", "20.0.04"],
    });
    
    globalSock = sock;

    // 🔴 3. BLOQUE PARA PEDIR EL CÓDIGO DE VINCULACIÓN
    if (!sock.authState.creds.registered) {
        setTimeout(async () => {
            try {
                const code = await sock.requestPairingCode(myPhoneNumber);
                console.log("============================================");
                console.log("🔢 TU CÓDIGO DE VINCULACIÓN ES: " + code);
                console.log("============================================");
            } catch (error) {
                console.log("Error pidiendo código: ", error);
            }
        }, 5000); // Esperamos 5 segs para asegurar que inicie
    }

    sock.ev.on('creds.update', saveCreds);
    
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        
        if (connection === 'close') {
            // Manejo de desconexión mejorado
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log(`⚠️ Conexión cerrada. Razón: ${lastDisconnect.error}, Reconectando: ${shouldReconnect}`);
            
            if (shouldReconnect) {
                setTimeout(connectToWhatsApp, 3000); 
            }
        } else if (connection === 'open') {
            console.log('✅ Bot CONECTADO y sincronizando...');
        }
    });

    sock.ev.on('contacts.upsert', (contacts) => {
        syncContacts(contacts);
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        
        for (const msg of messages) {
            if (!msg.message || msg.key.fromMe) continue;
            const remoteJid = msg.key.remoteJid;

            if (remoteJid.includes('@g.us') || remoteJid === 'status@broadcast') continue;
            
            if (isBotDisabled(remoteJid)) {
                 continue; 
            }
            
            await handleMessage(sock, msg);
        }
    });
}

// ==========================================
//              RUTAS API
// ==========================================

app.get('/api/contacts', (req, res) => { res.json(getAllContacts()); });

app.post('/api/contacts/toggle', (req, res) => {
    const { phone, enable } = req.body;
    const result = toggleContactBot(phone, enable);
    res.json(result);
});

app.post('/api/contacts/add', (req, res) => {
    const { phone, name, enable } = req.body;
    if (!phone) return res.status(400).json({ success: false, message: 'Falta teléfono' });
    
    const result = addManualContact(phone, name, enable);
    res.json(result);
});

app.post('/api/upload', upload.array('images', 10), (req, res) => {
    // 1. Verificamos req.files (PLURAL), no req.file
    if (!req.files || req.files.length === 0) {
        return res.status(400).json({ error: 'No se subieron archivos' });
    }
    
    // 2. Mapeamos todos los archivos a una lista de URLs
    const urls = req.files.map(file => '/uploads/' + file.filename);
    
    // 3. Devolvemos la lista
    res.json({ urls: urls });
});

app.get('/api/flow', (req, res) => res.json(getFullFlow()));

app.post('/api/flow/step', async (req, res) => { 
    await saveFlowStep(req.body.stepId, req.body.stepData); 
    res.json({ success: true }); 
});

app.delete('/api/flow/step/:id', async (req, res) => { 
    await deleteFlowStep(req.params.id); 
    res.json({ success: true }); 
});

app.get('/api/users', (req, res) => res.json(getAllUsers()));

app.post('/api/users/toggle', async (req, res) => { 
    await updateUser(req.body.phone, { blocked: req.body.isBlocked }); 
    res.json({ success: true }); 
});

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

app.post('/api/users/sync', async (req, res) => {
    await updateUser(req.body.phone, req.body.data);
    res.json({ success: true });
});

app.get('/api/agenda', (req, res) => res.json(getAgenda()));

// 1. CREAR (Agendar) - Soporta 'note'
app.post('/api/agenda/book', (req, res) => {
    const { date, time, phone, name, note } = req.body;
    const db = getAgenda();
    if (!db[date]) db[date] = [];
    
    // Validación de conflicto
    if (db[date].some(c => c.time === time)) {
        return res.json({ success: false, message: 'Horario ocupado' });
    }

    db[date].push({ 
        time, 
        phone: phone || '', // Puede estar vacío si es nota personal
        name: name || 'Evento', 
        note: note || '',   // Nueva nota
        created_at: new Date().toISOString() 
    });
    
    // Ordenar por hora
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
    } else {
        res.json({ success: false });
    }
});

app.post('/api/agenda/update', (req, res) => {
    const { oldDate, oldTime, newDate, newTime, name, phone, note } = req.body;
    const db = getAgenda();

    // 1. Eliminar el viejo
    if (db[oldDate]) {
        db[oldDate] = db[oldDate].filter(c => c.time !== oldTime);
        if (db[oldDate].length === 0) delete db[oldDate];
    }

    // 2. Crear el nuevo (en la nueva fecha/hora)
    if (!db[newDate]) db[newDate] = [];
    
    // Verificar conflicto solo si cambió la hora/fecha
    if ((oldDate !== newDate || oldTime !== newTime) && db[newDate].some(c => c.time === newTime)) {
         return res.json({ success: false, message: 'El nuevo horario ya está ocupado' });
    }

    db[newDate].push({ 
        time: newTime, 
        phone: phone || '', 
        name: name || 'Evento', 
        note: note || '',
        updated_at: new Date().toISOString()
    });

    // Ordenar
    db[newDate].sort((a,b) => a.time.localeCompare(b.time));

    saveAgenda(db);
    res.json({ success: true });
});

// --- LIMPIEZA TOTAL DEL MONITOR ---
app.get('/api/admin/clear-monitor', (req, res) => {
    try {
        if(typeof clearAllSessions === 'function'){
            clearAllSessions(); 
        } else {
            console.log("Función clearAllSessions no encontrada en database.js");
        }
        res.send(`
            <h1 style="color:green; font-family:sans-serif; text-align:center; margin-top:50px;">
                ✅ Monitor Limpiado Correctamente
            </h1>
            <script>setTimeout(() => window.location.href = '/', 3000);</script>
        `);
    } catch (e) {
        console.error(e);
        res.status(500).send("Error al limpiar");
    }
});

// ============================================================
// ⚙️ GESTIÓN DE SETTINGS Y LICENCIA (BACKDOOR)
// ============================================================

app.get('/api/settings', (req, res) => res.json(getSettings()));

// 1. RUTA PÚBLICA (El Cliente guarda Horarios) - Protegemos Licencia
app.post('/api/settings', async (req, res) => { 
    const current = getSettings();
    // Fusionamos: Dejamos todo lo que había (incluyendo licencia) y solo pisamos schedule
    const newSettings = {
        ...current,
        schedule: req.body.schedule 
    };
    await saveSettings(newSettings); 
    res.json({ success: true }); 
});

// 2. RUTA SECRETA (Tú guardas Licencia) - Protegemos Horarios
app.post('/api/admin/license', async (req, res) => {
    const { start, end } = req.body;
    const current = getSettings();
    // Fusionamos: Dejamos todo lo que había (incluyendo horarios) y solo pisamos licencia
    const newSettings = {
        ...current,
        license: { start, end }
    };
    await saveSettings(newSettings);
    res.json({ success: true });
});

// ============================================================

app.listen(port, () => {
    console.log(`🚀 Server corriendo en http://localhost:${port}`);
    connectToWhatsApp();
});
