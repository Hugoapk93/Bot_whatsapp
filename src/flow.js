const { getUser, updateUser, getFlowStep, getSettings, saveFlowStep, getFullFlow } = require('./database');
const { isBotDisabled, addManualContact } = require('./contacts');
const fs = require('fs');
const path = require('path');
// 🔥 RECUERDA: npm install chrono-node
const chrono = require('chrono-node');

// --- CONFIGURACIÓN ---
const SIMULATOR_PHONE = '5218991234567';
const INITIAL_STEP = 'BIENVENIDA';
const MAX_INACTIVE_MINUTES = 2880;

const agendaPath = path.join(__dirname, '../data/agenda.json');
const publicFolder = path.join(__dirname, '../public');

// --- UTILIDADES MEJORADAS ---

// 1. 🔥 NORMALIZADOR DE TEXTO (La clave para Sí vs Si)
// Quita acentos y pone todo en minúsculas
function normalizeText(str) {
    if (!str) return "";
    return str.toLowerCase()
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // Quita tildes (á -> a, ñ -> n)
        .trim();
}

// 2. Buscador de similitud (Fuzzy Match)
function isSimilar(input, keyword) {
    if (!input || !keyword) return false;
    
    // Usamos la versión normalizada para comparar
    const cleanInput = normalizeText(input);
    const cleanKeyword = normalizeText(keyword);
    
    // Coincidencia Exacta Limpia (arregla "sí" vs "si")
    if (cleanInput === cleanKeyword) return true;

    // Si es palabra corta (menos de 4 letras), solo aceptamos coincidencia exacta normalizada
    if (cleanKeyword.length < 4) return cleanInput === cleanKeyword;
    
    // Coincidencia contenida (ej: "quiero una bateria" contiene "bateria")
    if (cleanInput.includes(cleanKeyword)) return true;
    
    // Coincidencia aproximada simple (para errores de dedo en palabras largas)
    let errors = 0;
    const maxErrors = Math.floor(cleanKeyword.length / 3); 
    if (Math.abs(cleanInput.length - cleanKeyword.length) > maxErrors) return false;

    let i = 0, j = 0;
    while (i < cleanInput.length && j < cleanKeyword.length) {
        if (cleanInput[i] !== cleanKeyword[j]) {
            errors++;
            if (errors > maxErrors) return false;
            if (cleanInput.length > cleanKeyword.length) i++;
            else if (cleanKeyword.length > cleanInput.length) j++;
            else { i++; j++; }
        } else {
            i++; j++;
        }
    }
    return true;
}

function getAgenda() {
    if (!fs.existsSync(agendaPath)) return {};
    try { return JSON.parse(fs.readFileSync(agendaPath)); } catch (e) { return {}; }
}
function saveAgenda(data) { fs.writeFileSync(agendaPath, JSON.stringify(data, null, 2)); }

function timeToMinutes(timeStr) {
    if(!timeStr) return -1;
    const [h, m] = timeStr.split(':').map(Number);
    return (h * 60) + m;
}

// 🔥 INTELIGENCIA NLP: Detecta fecha Y hora
function analyzeNaturalLanguage(text) {
    // Configuración para español (Latam)
    const results = chrono.es.parse(text, new Date(), { forwardDate: true });
    
    if (results.length === 0) return { date: null, time: null };

    const result = results[0];
    const components = result.start; 

    let detectedDate = null;
    let detectedTime = null;

    if (components.isCertain('day') || components.isCertain('weekday')) {
        const dateObj = components.date();
        const yyyy = dateObj.getFullYear();
        const mm = String(dateObj.getMonth() + 1).padStart(2, '0');
        const dd = String(dateObj.getDate()).padStart(2, '0');
        detectedDate = `${yyyy}-${mm}-${dd}`;
    }

    if (components.isCertain('hour')) {
        const dateObj = components.date();
        const hh = String(dateObj.getHours()).padStart(2, '0');
        const min = String(dateObj.getMinutes()).padStart(2, '0');
        detectedTime = `${hh}:${min}`;
    }

    return { date: detectedDate, time: detectedTime };
}

function validateBusinessRules(timeStr, settings) {
    if (!timeStr) return { valid: false, reason: "Falta la hora." };
    const [h, m] = timeStr.split(':').map(Number);
    
    // Regla: Intervalos exactos o medias
    if (m !== 0 && m !== 30) return { valid: false, reason: "Solo agendamos en horas exactas o medias (ej: 4:00 o 4:30)." };

    const reqMins = (h * 60) + m;
    const startMins = timeToMinutes(settings.schedule?.start || "09:00");
    const endMins = timeToMinutes(settings.schedule?.end || "18:00");

    if (reqMins < startMins || reqMins >= endMins) return { valid: false, reason: "Estamos cerrados a esa hora." };
    return { valid: true };
}

// --- UTILS DE ENVÍO ---
const esSimulador = (jid) => jid.includes(SIMULATOR_PHONE);

const enviarAlFrontend = (jid, contenido) => {
    if (global.io) {
        global.io.emit('message', {
            to: jid,
            message: contenido,
            text: (typeof contenido === 'string' ? contenido : contenido.caption).replace(/\n/g, '<br>'),
            type: typeof contenido === 'string' ? 'text' : 'image',
            fromMe: true
        });
    }
};

const typing = async (sock, jid, length) => {
    if (esSimulador(jid)) return;
    const ms = Math.min(Math.max(length * 30, 400), 1500); 
    await sock.sendPresenceUpdate('composing', jid);
    await new Promise(r => setTimeout(r, ms));
    await sock.sendPresenceUpdate('paused', jid);
};

// --- FUNCIÓN DE ENVÍO DE PASOS ---
const sendStepMessage = async (sock, jid, stepId, userData = {}) => {
    console.log(`📤 Enviando paso: ${stepId}`);
    let step = getFlowStep(stepId);
    
    if (!step && stepId === INITIAL_STEP) {
        step = { type: 'menu', message: '¡Hola! Bienvenido.', options: [] };
        await saveFlowStep(INITIAL_STEP, step);
    }
    if (!step) return;

    let messageText = step.message || "";
    
    // Renderizado de Variables
    if (userData.history) {
        Object.keys(userData.history).forEach(key => {
            const val = userData.history[key] || '';
            messageText = messageText.replace(new RegExp(`{{${key}}}`, 'gi'), val);
            messageText = messageText.replace(new RegExp(`{{${key}_primer}}`, 'gi'), val.split(' ')[0]);
        });
    }
    
    // Renderizado de Opciones
    if (step.type === 'menu' && step.options) {
        messageText += '\n';
        step.options.forEach((opt, idx) => {
            messageText += `\n${idx + 1}. ${opt.label}`;
        });
    }

    // Enviar Media (Imágenes)
    let mediaList = Array.isArray(step.media) ? step.media : (step.media ? [step.media] : []);
    let sentImage = false;

    if (mediaList.length > 0) {
        for (let i = 0; i < mediaList.length; i++) {
            const url = mediaList[i];
            const relativePath = url.startsWith('/') ? url.slice(1) : url;
            const finalPath = path.join(publicFolder, relativePath);
            // const altPath = path.join(__dirname, '../public', url); // Opcional si usas estructura distinta
            
            if (fs.existsSync(finalPath)) {
                const caption = (i === 0) ? messageText : "";
                try {
                    if (esSimulador(jid)) {
                        enviarAlFrontend(jid, { url: url, caption: caption }, 'image');
                        sentImage = true;
                    } else {
                        await sock.sendMessage(jid, { image: { url: finalPath }, caption: caption });
                        sentImage = true;
                    }
                    if(mediaList.length > 1) await new Promise(r => setTimeout(r, 500));
                } catch (e) {}
            }
        }
    }

    // Enviar Texto (si no se envió como caption de imagen)
    if (!sentImage && messageText) {
        await typing(sock, jid, messageText.length);
        try {
            if (esSimulador(jid)) enviarAlFrontend(jid, messageText);
            else await sock.sendMessage(jid, { text: messageText });
        } catch (e) {}
    }

    // Auto-Avance
    if (step.type === 'message' && step.next_step) {
        setTimeout(async () => {
             const checkUser = getUser(userData.phone);
             if (checkUser && checkUser.current_step === stepId) {
                 await updateUser(userData.phone, { current_step: step.next_step });
                 await sendStepMessage(sock, jid, step.next_step, userData);
             }
        }, 1500);
    }
};

// --- HANDLER PRINCIPAL ---
const handleMessage = async (sock, msg) => {
    const remoteJid = msg.key.remoteJid;
    if (isBotDisabled(remoteJid) || remoteJid.includes('@g.us')) return;

    const text = (msg.message?.conversation || msg.message?.extendedTextMessage?.text || '').trim();
    if (!text) return;

    let incomingPhone = remoteJid.split('@')[0].replace(/:[0-9]+/, '');
    if (incomingPhone.startsWith('52') && incomingPhone.length === 12) incomingPhone = '521' + incomingPhone.slice(2);
    
    let user = getUser(incomingPhone);
    const dbKey = incomingPhone;
    const timestamp = new Date().toISOString();

    if (!user?.phone) {
        console.log(`✨ Nuevo usuario: ${dbKey}`);
        await updateUser(dbKey, { current_step: INITIAL_STEP, history: {}, jid: remoteJid, last_active: timestamp });
        user = getUser(dbKey);
    } else {
        await updateUser(dbKey, { last_active: timestamp, jid: remoteJid });
    }

    if (user.blocked) return;

    // Timeout Inactividad
    const lastActive = new Date(user.last_active || timestamp).getTime();
    if ((new Date().getTime() - lastActive) / 60000 > MAX_INACTIVE_MINUTES && user.current_step !== INITIAL_STEP) {
        await updateUser(dbKey, { current_step: INITIAL_STEP, history: {} });
        user = getUser(dbKey);
    }

    // --- CEREBRO ---
    
    // 1. Detección Global de Keywords
    const fullFlow = getFullFlow();
    let jumpStep = null;
    for (const [sKey, sVal] of Object.entries(fullFlow)) {
        if (sVal.keywords?.some(k => isSimilar(text, k))) {
            jumpStep = sKey;
            break;
        }
    }
    if (jumpStep) {
        console.log(`🔀 Keyword detectada: saltando a ${jumpStep}`);
        await updateUser(dbKey, { current_step: jumpStep });
        await sendStepMessage(sock, remoteJid, jumpStep, user);
        return;
    }

    // 2. Procesamiento Paso Actual
    const currentStepConfig = getFlowStep(user.current_step);
    if (!currentStepConfig) {
        await updateUser(dbKey, { current_step: INITIAL_STEP });
        return;
    }

    let nextStepId = null;

    // --- CASO MENÚ MEJORADO ---
    if (currentStepConfig.type === 'menu') {
        const index = parseInt(text) - 1;
        let match = currentStepConfig.options?.[index];

        if (!match) {
            // 🔥 BÚSQUEDA NORMALIZADA (Soporta Sí/Si, Canción/Cancion)
            match = currentStepConfig.options?.find(opt => 
                isSimilar(text, opt.trigger) || isSimilar(text, opt.label)
            );
        }

        if (match) {
            nextStepId = match.next_step;
        } else {
            const txt = `⚠️ No entendí esa opción.\nPor favor escribe el número o el nombre de la opción.`;
            if(esSimulador(remoteJid)) enviarAlFrontend(remoteJid, txt); else await sock.sendMessage(remoteJid, { text: txt });
            return;
        }
    }

    // CASO: INPUT
    else if (currentStepConfig.type === 'input') {
        const varName = currentStepConfig.save_var || 'temp';
        user.history[varName] = text;
        await updateUser(dbKey, { history: user.history });
        nextStepId = currentStepConfig.next_step;
    }

    // CASO: FILTRO (Admin)
    else if (currentStepConfig.type === 'filtro') {
        // Ignora mensajes de usuario en paso filtro (espera acción de admin)
        return; 
    }

    // CASO: CITA INTELIGENTE
    else if (currentStepConfig.type === 'cita' || nextStepId) { 
        
        let targetStep = nextStepId || user.current_step;
        const targetStepConfig = getFlowStep(targetStep);

        if (targetStepConfig && targetStepConfig.type === 'cita') {
            
            console.log(`🧠 Analizando lenguaje natural: "${text}"`);
            const analysis = analyzeNaturalLanguage(text);
            
            if (analysis.date) {
                user.history['fecha'] = analysis.date; 
                console.log(`✅ Fecha detectada: ${analysis.date}`);
            }
            if (analysis.time) {
                user.history['hora'] = analysis.time; 
                console.log(`✅ Hora detectada: ${analysis.time}`);
            }

            await updateUser(dbKey, { history: user.history });
            
            const fechaMemoria = user.history['fecha'];
            const horaMemoria = user.history['hora'];

            // Validaciones de Cita
            if (!fechaMemoria) {
                const txt = "📅 ¿Para qué día te gustaría agendar? (Ej: Mañana, El viernes)";
                if(esSimulador(remoteJid)) enviarAlFrontend(remoteJid, txt); else await sock.sendMessage(remoteJid, { text: txt });
                return; 
            }

            if (fechaMemoria < new Date().toISOString().split('T')[0]) {
                const txt = `⚠️ La fecha ${fechaMemoria} ya pasó. Dime una fecha futura.`;
                if(esSimulador(remoteJid)) enviarAlFrontend(remoteJid, txt); else await sock.sendMessage(remoteJid, { text: txt });
                delete user.history['fecha']; 
                await updateUser(dbKey, { history: user.history });
                return;
            }

            if (!horaMemoria) {
                const txt = `Perfecto para el ${fechaMemoria}. 🕒 ¿A qué hora? (Ej: 4pm, 10:30)`;
                if(esSimulador(remoteJid)) enviarAlFrontend(remoteJid, txt); else await sock.sendMessage(remoteJid, { text: txt });
                return; 
            }

            const settings = getSettings();
            const rules = validateBusinessRules(horaMemoria, settings);
            if (!rules.valid) {
                const txt = `⚠️ ${rules.reason}\nHorario: ${settings.schedule?.start || '9:00'} - ${settings.schedule?.end || '18:00'}`;
                if(esSimulador(remoteJid)) enviarAlFrontend(remoteJid, txt); else await sock.sendMessage(remoteJid, { text: txt });
                delete user.history['hora']; 
                await updateUser(dbKey, { history: user.history });
                return;
            }

            const db = getAgenda();
            if (db[fechaMemoria] && db[fechaMemoria].some(c => c.time === horaMemoria)) {
                const txt = `❌ Horario ${horaMemoria} ocupado. ¿Otra hora?`;
                if(esSimulador(remoteJid)) enviarAlFrontend(remoteJid, txt); else await sock.sendMessage(remoteJid, { text: txt });
                delete user.history['hora'];
                await updateUser(dbKey, { history: user.history });
                return;
            }

            // AGENDAR
            if (!db[fechaMemoria]) db[fechaMemoria] = [];
            const finalName = user.history['nombre'] || msg.pushName || 'Cliente';
            
            db[fechaMemoria].push({ 
                time: horaMemoria, 
                phone: dbKey, 
                name: finalName, 
                created_at: new Date().toISOString() 
            });
            saveAgenda(db);

            if (global.sendPushNotification) {
                global.sendPushNotification("📅 Nueva Cita", `El ${fechaMemoria} a las ${horaMemoria} - ${finalName}`);
            }

            // Transición
            if (targetStepConfig.next_step) {
                nextStepId = targetStepConfig.next_step;
            } else {
                const txt = `✅ ¡Listo! Agendado el *${fechaMemoria}* a las *${horaMemoria}*.`;
                if(esSimulador(remoteJid)) enviarAlFrontend(remoteJid, txt); else await sock.sendMessage(remoteJid, { text: txt });
                return;
            }
        }
    }

    // 3. Ejecutar Cambio de Paso
    if (nextStepId) {
        await updateUser(dbKey, { current_step: nextStepId });
        await sendStepMessage(sock, remoteJid, nextStepId, getUser(dbKey));
    }
};

module.exports = { handleMessage, sendStepMessage };
