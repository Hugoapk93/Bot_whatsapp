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

// --- ENVÍO MENSAJES (SOPORTE MÚLTIPLE IMAGEN) ---
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

    // --- LÓGICA DE MEDIOS (ARRAY O STRING) ---
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

    const text = (msg.message?.conversation || msg.message?.extendedTextMessage?.text || '').trim();
    if (!text) return;

    let phoneKey = remoteJid.split('@')[0].replace(/:[0-9]+/, ''); 
    let user = getUser(phoneKey); 

    // FIX MX: Normalización 521 -> 52
    if (!user?.phone && phoneKey.startsWith('521') && phoneKey.length === 13) {
        const altKey = phoneKey.replace('521', '52');
        const altUser = getUser(altKey);
        if (altUser?.phone) { user = altUser; phoneKey = altKey; }
    } else if (!user?.phone && phoneKey.startsWith('52') && phoneKey.length === 12) {
        const altKey = phoneKey.replace('52', '521');
        const altUser = getUser(altKey);
        if (altUser?.phone) { user = altUser; phoneKey = altKey; }
    }

    // Captura de hora exacta
    const timestamp = new Date().toISOString();

    // Nuevo Cliente
    if (!user?.phone) {
        console.log(`✨ Nuevo Cliente: ${phoneKey}`);
        await updateUser(phoneKey, { current_step: INITIAL_STEP, history: {}, jid: remoteJid, last_active: timestamp });
        user = getUser(phoneKey);
        await sendStepMessage(sock, remoteJid, INITIAL_STEP, user);
        return;
    }

    // Actualizar actividad
    await updateUser(phoneKey, { last_active: timestamp });

    if (user.jid !== remoteJid) await updateUser(phoneKey, { jid: remoteJid });
    if (user.blocked) return;

    const cleanText = text.toLowerCase();

    // ============================================================
    // 🕵️ LOGICA DE PALABRAS CLAVE (SUPER PODERES)
    // ============================================================
    const fullFlow = getFullFlow();
    let jumpToStep = null;

    Object.keys(fullFlow).forEach(stepName => {
        const stepData = fullFlow[stepName];
        if (stepData.keywords && Array.isArray(stepData.keywords)) {
            if (stepData.keywords.includes(cleanText)) {
                jumpToStep = stepName;
            }
        }
    });

    if (jumpToStep) {
        console.log(`🚀 Salto por palabra clave: "${cleanText}" -> ${jumpToStep}`);
        await updateUser(phoneKey, { current_step: jumpToStep });
        await sendStepMessage(sock, remoteJid, jumpToStep, user);
        return; 
    }
    // ============================================================

    // Comandos Globales (Hardcoded fallback)
    if (['hola', 'menu', 'inicio', 'menú'].includes(cleanText)) {
        await updateUser(phoneKey, { current_step: INITIAL_STEP });
        await sendStepMessage(sock, remoteJid, INITIAL_STEP, user);
        return;
    }

    const currentConfig = getFlowStep(user.current_step);
    if (!currentConfig) {
        await updateUser(phoneKey, { current_step: INITIAL_STEP });
        await sendStepMessage(sock, remoteJid, INITIAL_STEP, user);
        return;
    }

    let nextStepId = null;

    if (currentConfig.type === 'input') {
        const varName = currentConfig.save_var || 'temp';
        const newHistory = { ...user.history, [varName]: text };
        await updateUser(phoneKey, { history: newHistory });
        user = getUser(phoneKey); 
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
                        await updateUser(phoneKey, { history: { ...user.history, fecha: rawTime, hora: '' } });
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
                        db[fecha].push({ time: hora, phone: phoneKey, name: finalName, created_at: new Date().toISOString() });
                        saveAgenda(db);
                        await sock.sendMessage(remoteJid, { text: `✅ Agendado: ${fecha} ${hora}` });
                        if (pathSuccess) nextStepId = pathSuccess.next_step;
                    }
                }
            }
        }
    }

    if (nextStepId) {
        await updateUser(phoneKey, { current_step: nextStepId });
        const updatedUser = getUser(phoneKey); 
        await sendStepMessage(sock, remoteJid, nextStepId, updatedUser);
    }
};

module.exports = { handleMessage, sendStepMessage };
