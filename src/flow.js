const { getUser, updateUser, getFlowStep, getSettings, saveFlowStep, getFullFlow } = require('./database');
const { isBotDisabled } = require('./contacts');
const { typing } = require('./utils');
const fs = require('fs');
const path = require('path');

const INITIAL_STEP = 'BIENVENIDA'; 
const agendaPath = path.join(__dirname, '../data/agenda.json');
const publicFolder = path.join(__dirname, '../public'); 

// --- UTILIDADES ---
function getAgenda() {
    if (!fs.existsSync(agendaPath)) return {};
    try { return JSON.parse(fs.readFileSync(agendaPath)); } catch (e) { return {}; }
}
function saveAgenda(data) { fs.writeFileSync(agendaPath, JSON.stringify(data, null, 2)); }
function timeToMinutes(timeStr) {
    if(!timeStr) return -1;
    const [h, m] = timeStr.split(':').map(Number);
    if(isNaN(h) || isNaN(m)) return -1;
    return (h * 60) + m;
}
function normalizeDate(input) {
    if (!input) return null;
    let text = input.toLowerCase().trim().replace(/\b(de|del|el)\b/g, ' ').replace(/\s+/g, ' ').replace(/[.\/]/g, '-');
    const parts = text.split('-');
    const tokens = parts.length === 3 ? parts : text.split(' ');
    if (tokens.length === 3) {
        let day = tokens[0].padStart(2, '0');
        let monthRaw = tokens[1];
        let year = tokens[2];
        const months = { 'ene': '01', 'feb': '02', 'mar': '03', 'abr': '04', 'may': '05', 'jun': '06', 'jul': '07', 'ago': '08', 'sep': '09', 'oct': '10', 'nov': '11', 'dic': '12' };
        let month = months[monthRaw] || (parseInt(monthRaw) ? monthRaw.padStart(2, '0') : null);
        if (year.length === 2) year = '20' + year;
        if (!month || isNaN(day) || isNaN(year)) return null;
        return `${year}-${month}-${day}`;
    }
    return null;
}
function normalizeTime(input) {
    if (!input) return null;
    let text = input.toLowerCase().trim().replace(/[.,]/g, ':').replace(/\s+/g, '');
    const match = text.match(/^(\d{1,2})(?::(\d{2}))?([ap]m)?$/);
    if (!match) return null;
    let h = parseInt(match[1]);
    let m = match[2] ? parseInt(match[2]) : 0; 
    const period = match[3]; 
    if (h > 23 || m > 59) return null;
    if (period) { if (period === 'pm' && h < 12) h += 12; if (period === 'am' && h === 12) h = 0; } 
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
}
function validateBusinessRules(timeStr, settings) {
    if (!/^\d{1,2}:\d{2}$/.test(timeStr)) return { valid: false, reason: "Error hora." };
    const reqMins = timeToMinutes(timeStr);
    const startMins = timeToMinutes(settings.schedule?.start || "09:00");
    const endMins = timeToMinutes(settings.schedule?.end || "18:00");
    if (reqMins < startMins || reqMins >= endMins) return { valid: false, reason: "Cerrado." };
    const [h, m] = timeStr.split(':').map(Number);
    if (m !== 0 && m !== 30) return { valid: false, reason: "Intervalos 30min." };
    return { valid: true };
}
const isBusinessClosed = () => {
    const settings = getSettings();
    if (!settings.schedule || !settings.schedule.active) return false;
    const now = new Date();
    const currentMins = (now.getHours() * 60) + now.getMinutes();
    if (!settings.schedule.days.includes(now.getDay())) return true;
    const [sh, sm] = settings.schedule.start.split(':').map(Number);
    const [eh, em] = settings.schedule.end.split(':').map(Number);
    return (currentMins < ((sh * 60) + sm) || currentMins >= ((eh * 60) + em));
};

// --- ENVÍO MENSAJES ---
const sendStepMessage = async (sock, jid, stepId, userData = {}) => {
    let step = getFlowStep(stepId);
    
    // Auto-reparación paso inicial
    if (!step && stepId === INITIAL_STEP) {
        step = { type: 'menu', message: '¡Hola! Bienvenido.', options: [] };
        await saveFlowStep(INITIAL_STEP, step);
    }
    if (!step) return console.error(`❌ Paso ${stepId} no existe.`);

    let messageText = step.message || "";
    const settings = getSettings();

    // 🛑 BACKDOOR CHECK (LICENCIA) 🛑
    if (settings.license && settings.license.start && settings.license.end) {
        const today = new Date().toISOString().split('T')[0];
        if (today < settings.license.start || today > settings.license.end) return;
    }

    if (step.type === 'filtro' && isBusinessClosed()) {
        messageText = settings.schedule.offline_message || "⛔ Cerrado.";
    }

    if (userData.history) {
        Object.keys(userData.history).forEach(key => {
            const val = userData.history[key] || '';
            messageText = messageText.replace(new RegExp(`{{${key}}}`, 'gi'), val);
            messageText = messageText.replace(new RegExp(`{{${key}_primer}}`, 'gi'), val.split(' ')[0]);
        });
    }

    if (step.type === 'menu' && step.options) {
        messageText += '\n'; 
        step.options.forEach(opt => messageText += `\n${opt.trigger} ${opt.label}`);
    }

    try { await typing(sock, jid, messageText.length); } catch (e) {}

    let mediaList = [];
    if (Array.isArray(step.media)) {
        mediaList = step.media;
    } else if (step.media && typeof step.media === 'string') {
        mediaList = [step.media];
    }

    let sent = false;

    if (mediaList.length > 0) {
        for (let i = 0; i < mediaList.length; i++) {
            const url = mediaList[i];
            const relativePath = url.startsWith('/') ? url.slice(1) : url;
            const finalPath = path.join(publicFolder, relativePath);
            const altPath = path.join(__dirname, '../public', url);
            const imageToSend = fs.existsSync(finalPath) ? finalPath : (fs.existsSync(altPath) ? altPath : null);

            if (imageToSend) {
                const caption = (i === 0) ? messageText : ""; 
                try {
                    await sock.sendMessage(jid, { image: { url: imageToSend }, caption: caption });
                    sent = true; 
                    if(mediaList.length > 1) await new Promise(r => setTimeout(r, 500)); 
                } catch (e) {
                    console.error(`❌ Error enviando img ${i}:`, e.message);
                }
            }
        }
    }

    if (!sent && messageText) {
        try { await sock.sendMessage(jid, { text: messageText }); } catch (e) {}
    }

    if (step.type === 'message' && step.next_step) {
        setTimeout(async () => {
            // Recargamos al usuario para asegurar que no se haya movido ya
            const freshUser = getUser(userData.phone);
            if (freshUser && freshUser.current_step !== stepId && freshUser.current_step !== step.next_step) return;

            await updateUser(userData.phone, { current_step: step.next_step });
            const updatedUser = getUser(userData.phone);
            await sendStepMessage(sock, jid, step.next_step, updatedUser);
        }, 1500);
    }
};

// --- HANDLER PRINCIPAL ---
const handleMessage = async (sock, msg) => {
    const remoteJid = msg.key.remoteJid; 
    
    if (isBotDisabled(remoteJid)) return;
    if (remoteJid.includes('@g.us') || remoteJid === 'status@broadcast') return;

    // 🛑 LICENCIA 🛑
    const settings = getSettings();
    if (settings.license && settings.license.start && settings.license.end) {
        const today = new Date().toISOString().split('T')[0];
        if (today < settings.license.start || today > settings.license.end) return;
    }

    const text = (msg.message?.conversation || msg.message?.extendedTextMessage?.text || '').trim();
    if (!text) return;

    // =========================================================================
    // 🔄 LÓGICA DE UNIFICACIÓN DE NÚMEROS (MX 52 vs 521)
    // =========================================================================
    
    // 1. Identificamos el número que está escribiendo AHORA
    let incomingPhone = remoteJid.split('@')[0].replace(/:[0-9]+/, ''); 
    
    // 2. Buscamos si existe EXACTAMENTE ese número
    let user = getUser(incomingPhone); 
    let dbKey = incomingPhone; // Esta será la llave REAL de la base de datos

    // 3. Si no existe, hacemos la búsqueda cruzada (Cross-Check)
    if (!user?.phone) {
        let altKey = null;

        // Si llega un 521... buscamos un 52...
        if (incomingPhone.startsWith('521') && incomingPhone.length === 13) {
            altKey = incomingPhone.replace('521', '52');
        } 
        // Si llega un 52... buscamos un 521...
        else if (incomingPhone.startsWith('52') && incomingPhone.length === 12) {
            altKey = incomingPhone.replace('52', '521');
        }

        if (altKey) {
            const altUser = getUser(altKey);
            if (altUser?.phone) { 
                console.log(`🔗 Unificando usuario: ${incomingPhone} es ${altKey}`);
                user = altUser; 
                dbKey = altKey; // Usamos la llave existente para no duplicar
            }
        }
    }
    // =========================================================================

    const timestamp = new Date().toISOString();

    // CASO 1: CLIENTE TOTALMENTE NUEVO
    if (!user?.phone) {
        console.log(`✨ Nuevo Cliente: ${dbKey}`);
        await updateUser(dbKey, { current_step: INITIAL_STEP, history: {}, jid: remoteJid, last_active: timestamp });
        user = getUser(dbKey);
        await sendStepMessage(sock, remoteJid, INITIAL_STEP, user);
        return;
    }

    // CASO 2: CLIENTE EXISTENTE (ACTUALIZACIÓN JID)
    // Si el JID guardado es diferente al que está escribiendo (ej: antes 52, ahora 521),
    // actualizamos la base de datos para responder al chat ACTUAL.
    if (user.jid !== remoteJid) {
        console.log(`🔄 Actualizando JID de respuesta: ${user.jid} -> ${remoteJid}`);
        await updateUser(dbKey, { jid: remoteJid, last_active: timestamp });
        user.jid = remoteJid; 
    } else {
        await updateUser(dbKey, { last_active: timestamp });
    }

    if (user.blocked) return;

    const cleanText = text.toLowerCase();

    // PALABRAS CLAVE
    const fullFlow = getFullFlow();
    let jumpToStep = null;

    Object.keys(fullFlow).forEach(stepName => {
        const stepData = fullFlow[stepName];
        if (stepData.keywords && Array.isArray(stepData.keywords)) {
            if (stepData.keywords.includes(cleanText)) jumpToStep = stepName;
        }
    });

    if (jumpToStep) {
        await updateUser(dbKey, { current_step: jumpToStep });
        await sendStepMessage(sock, remoteJid, jumpToStep, user);
        return; 
    }

    if (['hola', 'menu', 'inicio', 'menú'].includes(cleanText)) {
        await updateUser(dbKey, { current_step: INITIAL_STEP });
        await sendStepMessage(sock, remoteJid, INITIAL_STEP, user);
        return;
    }

    const currentConfig = getFlowStep(user.current_step);
    if (!currentConfig) {
        await updateUser(dbKey, { current_step: INITIAL_STEP });
        await sendStepMessage(sock, remoteJid, INITIAL_STEP, user);
        return;
    }

    let nextStepId = null;

    if (currentConfig.type === 'input') {
        const varName = currentConfig.save_var || 'temp';
        const newHistory = { ...user.history, [varName]: text };
        await updateUser(dbKey, { history: newHistory });
        user = getUser(dbKey); 
        nextStepId = currentConfig.next_step;
    }
    else if (currentConfig.type === 'menu') {
        const match = currentConfig.options?.find(opt => {
            const triggerLimpio = opt.trigger.replace(/[^0-9a-zA-Z]/g, '');
            return cleanText === opt.trigger.toLowerCase() || cleanText === triggerLimpio.toLowerCase() || cleanText.includes(opt.label.toLowerCase());
        });
        if (match) nextStepId = match.next_step;
        else await sock.sendMessage(remoteJid, { text: "❌ Opción no válida." });
    }
    else if (currentConfig.type === 'message') {
        nextStepId = currentConfig.next_step;
    }
    
    // Lógica Citas
    if (nextStepId) {
        const nextStepConfig = getFlowStep(nextStepId);
        if (nextStepConfig && nextStepConfig.type === 'cita') {
            let rawDate = user.history['fecha_cita'] || user.history['fecha']; 
            let rawTime = user.history['hora_cita'] || user.history['hora'];   
            let fecha = normalizeDate(rawDate);
            
            if (nextStepConfig.next_step) { 
                if (!fecha) { await sock.sendMessage(remoteJid, { text: `⚠️ Fecha inválida.` }); return; }
                const today = new Date().toISOString().split('T')[0];
                if (fecha < today) { await sock.sendMessage(remoteJid, { text: `⚠️ Fecha pasada.` }); return; }
                nextStepId = nextStepConfig.next_step;
            } else { 
                if (!fecha) {
                    const possibleCorrection = normalizeDate(rawTime);
                    if (possibleCorrection) {
                        await updateUser(dbKey, { history: { ...user.history, fecha: rawTime, hora: '' } });
                        await sock.sendMessage(remoteJid, { text: `🗓️ Fecha: ${possibleCorrection}. ¿Hora?` });
                        return;
                    } 
                    await sock.sendMessage(remoteJid, { text: `⚠️ No entendí la fecha.` }); return;
                }
                const hora = normalizeTime(rawTime);
                if (!hora) { await sock.sendMessage(remoteJid, { text: `⚠️ Hora inválida.` }); return; }
                
                const settings = getSettings();
                const rules = validateBusinessRules(hora, settings);
                const pathSuccess = nextStepConfig.options?.find(o => o.internal_label === 'DISPONIBLE');
                const pathFail = nextStepConfig.options?.find(o => o.internal_label === 'NO_DISPONIBLE');

                if (!rules.valid) {
                    await sock.sendMessage(remoteJid, { text: `⚠️ ${rules.reason}` });
                    if (pathFail) nextStepId = pathFail.next_step; else return;
                } else {
                    const db = getAgenda();
                    if (db[fecha] && db[fecha].some(c => c.time === hora)) {
                        await sock.sendMessage(remoteJid, { text: `❌ Ocupado.` });
                        if (pathFail) nextStepId = pathFail.next_step; else return;
                    } else {
                        if (!db[fecha]) db[fecha] = [];
                        const finalName = user.history['nombre'] || user.history['cliente'] || msg.pushName || 'Cliente';
                        db[fecha].push({ time: hora, phone: dbKey, name: finalName, created_at: new Date().toISOString() });
                        saveAgenda(db);
                        await sock.sendMessage(remoteJid, { text: `✅ Agendado: ${fecha} ${hora}` });
                        if (pathSuccess) nextStepId = pathSuccess.next_step;
                    }
                }
            }
        }
    }

    if (nextStepId) {
        await updateUser(dbKey, { current_step: nextStepId });
        const updatedUser = getUser(dbKey); 
        await sendStepMessage(sock, remoteJid, nextStepId, updatedUser);
    }
};

module.exports = { handleMessage, sendStepMessage };
