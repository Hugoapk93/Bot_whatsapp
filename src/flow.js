const { getUser, updateUser, getFlowStep, getSettings, saveFlowStep, getFullFlow, getAllUsers } = require('./database');
const { isBotDisabled, addManualContact } = require('./contacts');
const fs = require('fs');
const path = require('path');
const { proto, generateWAMessageFromContent } = require('@whiskeysockets/baileys');

console.log("✅ CÓDIGO CARGADO: v5 (Soporte Híbrido LID + Real)");

// --- CONFIGURACIÓN ---
const SIMULATOR_PHONE = '5218991234567';
const INITIAL_STEP = 'BIENVENIDA';
const MAX_INACTIVE_MINUTES = 2880;

const agendaPath = path.join(__dirname, '../data/agenda.json');
const publicFolder = path.join(__dirname, '../public');

// --- UTILIDADES ---
function isSimilar(a, b) {
    if(!a || !b) return false;
    a = a.toLowerCase().trim();
    b = b.toLowerCase().trim();
    if (a === b) return true;
    if (a.includes(b) && b.length > 3) return true;
    if (b.includes(a) && a.length > 3) return true;
    if (a.length < 4 || b.length < 4) return false;
    const maxLen = Math.max(a.length, b.length);
    if (Math.abs(a.length - b.length) > 2) return false;
    let matches = 0;
    for (let i = 0; i < Math.min(a.length, b.length); i++) { if (a[i] === b[i]) matches++; }
    return (matches / maxLen) > 0.7;
}

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
    if (!/^\d{1,2}:\d{2}$/.test(timeStr)) return { valid: false, reason: "Formato de hora incorrecto." };
    const reqMins = timeToMinutes(timeStr);
    const startMins = timeToMinutes(settings.schedule?.start || "09:00");
    const endMins = timeToMinutes(settings.schedule?.end || "18:00");
    if (reqMins < startMins || reqMins >= endMins) return { valid: false, reason: "Estamos cerrados a esa hora." };
    const [h, m] = timeStr.split(':').map(Number);
    if (m !== 0 && m !== 30) return { valid: false, reason: "Solo agendamos en intervalos de 30 min (ej: 4:00, 4:30)." };
    return { valid: true };
}

const isBusinessClosed = () => {
    const settings = getSettings();
    if (!settings.schedule || !settings.schedule.active) return false;
    const nowServer = new Date();
    const mxDate = new Date(nowServer.toLocaleString("en-US", {timeZone: "America/Mexico_City"}));
    const currentMins = (mxDate.getHours() * 60) + mxDate.getMinutes();
    const currentDay = mxDate.getDay();
    if (settings.schedule.days && !settings.schedule.days.includes(currentDay)) return true;
    const [sh, sm] = (settings.schedule.start || "09:00").split(':').map(Number);
    const [eh, em] = (settings.schedule.end || "18:00").split(':').map(Number);
    const startMins = (sh * 60) + sm;
    const endMins = (eh * 60) + em;
    return (currentMins < startMins || currentMins >= endMins);
};

// --- SOCKET INTERCEPTOR ---
const enviarAlFrontend = (jid, contenido, tipo = 'text') => {
    console.log(`\n🤖 [SIMULADOR] Respuesta generada (${tipo})`);
    if (global.io) {
        const rawText = typeof contenido === 'string' ? contenido : (contenido.caption || '');
        const formattedText = rawText.replace(/\n/g, '<br>');
        const payload = {
            to: jid,
            message: contenido,
            text: formattedText,
            mediaUrl: typeof contenido === 'object' ? contenido.url : null,
            type: tipo,
            fromMe: true
        };
        global.io.emit('message', payload);
    }
};

const esSimulador = (jid) => jid.includes(SIMULATOR_PHONE);

const typing = async (sock, jid, length) => {
    if (esSimulador(jid)) return;
    const ms = Math.min(Math.max(length * 50, 1000), 5000);
    await sock.sendPresenceUpdate('composing', jid);
    await new Promise(resolve => setTimeout(resolve, ms));
    await sock.sendPresenceUpdate('paused', jid);
};

// --- ENVÍO DE MENSAJES (Manejador de Botones) ---
const sendStepMessage = async (sock, jid, stepId, userData = {}) => {
    
    // CAMBIO V5: Aceptamos el JID tal cual viene (sea LID o Real)
    // Solo hacemos limpieza si es necesario, pero no bloqueamos LIDs.
    let targetJid = jid;
    
    console.log(`📤 Enviando paso: ${stepId} a ${targetJid}`);
    
    let step = getFlowStep(stepId);

    if (!step && stepId === INITIAL_STEP) {
        step = { type: 'menu', message: '¡Hola! Bienvenido.', options: [] };
        await saveFlowStep(INITIAL_STEP, step);
    }
    if (!step) return;

    let messageText = step.message || "";
    const settings = getSettings();

    // Reemplazo de Variables
    const mxDate = new Date(new Date().toLocaleString("en-US", {timeZone: "America/Mexico_City"}));
    const hour = mxDate.getHours();
    let saludo = 'Hola';
    if (hour >= 5 && hour < 12) saludo = 'Buenos días';
    else if (hour >= 12 && hour < 19) saludo = 'Buenas tardes';
    else saludo = 'Buenas noches';
    messageText = messageText.replace(/{{saludo}}/gi, saludo);

    if (userData.history) {
        Object.keys(userData.history).forEach(key => {
            const val = userData.history[key] || '';
            messageText = messageText.replace(new RegExp(`{{${key}}}`, 'gi'), val);
            messageText = messageText.replace(new RegExp(`{{${key}_primer}}`, 'gi'), val.split(' ')[0]);
        });
    }

    if (step.type === 'fin_bot') {
        // Intento de limpiar para guardar contacto, pero si es LID se guarda tal cual
        const cleanPhone = targetJid.replace('@s.whatsapp.net', '').replace('@c.us', '');
        const contactName = userData.history?.nombre || userData.history?.cliente || userData.pushName || 'Cliente Nuevo';
        addManualContact(cleanPhone, contactName, false);
    }

    if (step.type === 'filtro' && isBusinessClosed()) {
        messageText = settings.schedule.offline_message || "⛔ Horario de atención terminado.";
    }

    if (step.type === 'filtro') {
        const cleanClientPhone = targetJid.replace(/[^0-9]/g, ''); // Si es LID saldrá el hash, es normal
        if (global.sendPushNotification) {
             global.sendPushNotification("⚠️ Solicitud Pendiente", `Cliente requiere aprobación.`);
        }
    }

    try { await typing(sock, targetJid, messageText.length); } catch (e) {}

    // -----------------------------------------------------------------
    //  🚀 LÓGICA DE INTERACTIVE MESSAGES
    // -----------------------------------------------------------------
    
    if (esSimulador(targetJid)) {
        enviarAlFrontend(targetJid, messageText, 'text');
        if(step.options && step.options.length > 0) {
            let helpText = "👉 Opciones:\n";
            step.options.forEach((opt, idx) => helpText += `[${opt.label}]\n`);
            enviarAlFrontend(targetJid, helpText, 'text');
        }
        return; 
    }

    if (step.type === 'menu' && step.options && step.options.length > 0) {
        try {
            const sections = [{
                title: "Opciones Disponibles",
                rows: step.options.map((opt) => ({
                    header: "",
                    title: opt.label,
                    description: "",
                    id: opt.trigger 
                }))
            }];

            const msgContent = {
                viewOnceMessage: {
                    message: {
                        interactiveMessage: {
                            // Sin header para evitar errores 400
                            body: { text: `*MENÚ DE OPCIONES*\n\n${messageText}` },
                            footer: { text: "Selecciona una opción 👇" },
                            nativeFlowMessage: {
                                buttons: [{
                                    name: "single_select",
                                    buttonParamsJson: JSON.stringify({
                                        title: "Ver Lista",
                                        sections: sections
                                    })
                                }]
                            }
                        }
                    }
                }
            };

            const waMsg = generateWAMessageFromContent(targetJid, msgContent, { userJid: sock.user.id });
            await sock.relayMessage(targetJid, waMsg.message, { messageId: waMsg.key.id });
            return; 

        } catch (err) {
            console.error("⚠️ Error enviando Lista (Posiblemente LID no soportado), enviando texto:", err.message);
            // El catch permite que el código continúe abajo al fallback
        }
    }

    // --- FALLBACK / TEXTO NORMAL / MEDIA ---
    // (Esto se ejecuta si no hay menú o si el envío de lista falló)
    
    let mediaList = Array.isArray(step.media) ? step.media : (step.media ? [step.media] : []);
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
                    await sock.sendMessage(targetJid, { image: { url: imageToSend }, caption: caption });
                    sent = true;
                    if(mediaList.length > 1) await new Promise(r => setTimeout(r, 500));
                } catch (e) {}
            }
        }
    }

    if (!sent && messageText) {
        // Fallback visual de menú si falló la lista
        if (step.type === 'menu' && step.options) {
             messageText += '\n';
             step.options.forEach((opt, idx) => messageText += `\n${idx+1}. ${opt.label}`);
        }
        await sock.sendMessage(targetJid, { text: messageText });
    }

    if (step.type === 'message' && step.next_step) {
        setTimeout(async () => {
            const freshUser = getUser(userData.phone); // Nota: userData.phone aquí es la Key de la DB (puede ser LID o número)
            if (freshUser && freshUser.current_step !== stepId && freshUser.current_step !== step.next_step) return;
            await updateUser(userData.phone, { current_step: step.next_step });
            await sendStepMessage(sock, targetJid, step.next_step, getUser(userData.phone));
        }, 1500);
    }
};

// --- HANDLER PRINCIPAL ---
const handleMessage = async (sock, msg) => {
    const remoteJid = msg.key.remoteJid;

    if (isBotDisabled(remoteJid)) return;
    if (remoteJid.includes('@g.us') || remoteJid === 'status@broadcast') return;

    let text = '';
    
    if (msg.message?.conversation) text = msg.message.conversation;
    else if (msg.message?.extendedTextMessage?.text) text = msg.message.extendedTextMessage.text;
    else if (msg.message?.interactiveResponseMessage) {
        const resp = msg.message.interactiveResponseMessage;
        try {
            if (resp.nativeFlowResponseMessage) {
                const params = JSON.parse(resp.nativeFlowResponseMessage.paramsJson);
                text = params.id || ''; 
            }
        } catch(e) {}
    }
    else if (msg.message?.listResponseMessage) text = msg.message.listResponseMessage.singleSelectReply.selectedRowId;
    else if (msg.message?.templateButtonReplyMessage) text = msg.message.templateButtonReplyMessage.selectedId;

    text = (text || '').trim();
    if (!text) return; 

    // LIMPIEZA CLAVE: Usamos el ID tal cual viene para asegurar respuesta
    let dbKey = remoteJid.split('@')[0].replace(/:[0-9]+/, ''); 
    // Si es LID, la dbKey será larga. Si es número, será corta. Ambos sirven como ID único.
    
    let user = getUser(dbKey);

    // Intento de compatibilidad: Si llega un número normal pero tenemos guardado un LID (o viceversa), es difícil saberlo sin la sesión.
    // Por eso, confiamos en el ID que llega en este mensaje.

    const timestamp = new Date().toISOString();

    if (!user) {
        console.log(`✨ Nuevo Cliente Detectado (${dbKey})`);
        // Guardamos 'phone' como el ID de la base de datos para consistencia
        await updateUser(dbKey, { phone: dbKey, current_step: INITIAL_STEP, history: {}, jid: remoteJid, last_active: timestamp });
        user = getUser(dbKey);
    } else {
        if (user.jid !== remoteJid) {
            await updateUser(dbKey, { jid: remoteJid, last_active: timestamp });
            user.jid = remoteJid;
        } else {
            await updateUser(dbKey, { last_active: timestamp });
        }
    }

    if (user.blocked) return;
    const cleanText = text.toLowerCase();

    if (user.last_active && user.current_step !== INITIAL_STEP) {
        const diffMinutes = (new Date().getTime() - new Date(user.last_active).getTime()) / 60000;
        if (diffMinutes > MAX_INACTIVE_MINUTES) {
            console.log(`⏱️ Timeout. Reinicio.`);
            await updateUser(dbKey, { current_step: INITIAL_STEP, history: {} });
            user = getUser(dbKey);
        }
    }

    // 1. ADMIN - Mantenemos lógica de Admin solo para números reales si es posible
    // Si el admin envía desde un LID, tendríamos que agregar su LID al paso 'filtro'.
    const words = cleanText.split(/\s+/);
    let targetClientPhone = null;
    let commandOption = "";

    for (const word of words) {
        const potentialNum = word.replace(/[^0-9]/g, '');
        if (potentialNum.length >= 10 && potentialNum.length <= 13) {
            // Buscamos si existe ese número en la DB
            let checkUser = getUser(potentialNum);
            if (!checkUser && potentialNum.startsWith('52') && potentialNum.length === 12) checkUser = getUser('521' + potentialNum.slice(2));
            if (!checkUser && potentialNum.length === 10) checkUser = getUser('521' + potentialNum);

            if (checkUser && checkUser.phone !== dbKey) {
                targetClientPhone = checkUser.phone;
                commandOption = cleanText.replace(word, '').trim();
                break;
            }
        }
    }

    if (targetClientPhone) {
        const targetUser = getUser(targetClientPhone);
        const targetStepConfig = getFlowStep(targetUser.current_step);

        if (targetStepConfig && targetStepConfig.type === 'filtro') {
            const match = targetStepConfig.options?.find(opt => {
                const t = opt.trigger.toLowerCase();
                const l = opt.label.toLowerCase();
                return isSimilar(commandOption, t) || isSimilar(commandOption, l) || commandOption.includes(t) || commandOption.includes(l);
            });

            if (match) {
                await sock.sendMessage(remoteJid, { text: `✅ Acción: ${match.label}` });
                await updateUser(targetClientPhone, { current_step: match.next_step });
                
                // Responder al JID que tenga ese usuario guardado (sea LID o real)
                await sendStepMessage(sock, targetUser.jid || targetClientPhone + '@s.whatsapp.net', match.next_step, targetUser);
                return;
            }
        }
    }

    // 2. CLIENTE
    const fullFlow = getFullFlow();
    let jumpToStep = null;
    Object.keys(fullFlow).forEach(stepName => {
        const stepData = fullFlow[stepName];
        if (stepData.keywords && Array.isArray(stepData.keywords)) {
            if (stepData.keywords.some(k => isSimilar(cleanText, k))) jumpToStep = stepName;
        }
    });

    if (jumpToStep) {
        console.log(`🔀 Salto por keyword a: ${jumpToStep}`);
        await updateUser(dbKey, { current_step: jumpToStep });
        await sendStepMessage(sock, remoteJid, jumpToStep, user);
        return;
    }

    const currentConfig = getFlowStep(user.current_step);
    if (!currentConfig) {
        await updateUser(dbKey, { current_step: INITIAL_STEP });
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
        let match = null;
        match = currentConfig.options?.find(opt => opt.trigger.toLowerCase() === cleanText);
        if (!match) {
             match = currentConfig.options?.find(opt => {
                const t = opt.trigger.toLowerCase();
                const l = opt.label.toLowerCase();
                return isSimilar(cleanText, t) || isSimilar(cleanText, l);
            });
        }
        if (!match) {
            const numberMatches = cleanText.match(/^(\d+)[\s.)]*$/);
            if (numberMatches) {
                 const index = parseInt(numberMatches[1]) - 1;
                 if (index >= 0 && index < (currentConfig.options?.length || 0)) match = currentConfig.options[index];
            }
        }

        if (match) {
            nextStepId = match.next_step;
        } else {
            if (user.current_step === INITIAL_STEP) return;
            let helpText = "⚠️ Opción no válida. Por favor selecciona una de las opciones del menú.";
            if (esSimulador(remoteJid)) enviarAlFrontend(remoteJid, helpText);
            else await sock.sendMessage(remoteJid, { text: helpText });
            return;
        }
    }
    else if (currentConfig.type === 'filtro') { return; }
    else if (currentConfig.type === 'message') { nextStepId = currentConfig.next_step; }

    if (nextStepId || currentConfig.type === 'cita') {
        let targetStep = nextStepId || user.current_step;
        const nextStepConfig = getFlowStep(targetStep);
        if (nextStepConfig && nextStepConfig.type === 'cita') {
            const detectedDate = normalizeDate(text); 
            const detectedTime = normalizeTime(text); 
            if (detectedDate) { user.history['fecha_cita'] = text; user.history['fecha'] = text; user.history['dia'] = text; await updateUser(dbKey, { history: user.history }); }
            if (detectedTime) { user.history['hora_cita'] = text; await updateUser(dbKey, { history: { ...user.history, hora_cita: text } }); }

            let rawDate = user.history['fecha_cita'] || user.history['fecha'] || user.history['dia'];
            let rawTime = user.history['hora_cita'] || user.history['hora'];
            let fecha = normalizeDate(rawDate);
            
            if (!fecha || fecha < new Date().toISOString().split('T')[0]) {
                if (fecha) { 
                    await sock.sendMessage(remoteJid, { text: `⚠️ Fecha incorrecta o pasada.` });
                    return; 
                }
            }

            if (fecha) {
                let hora = normalizeTime(rawTime);
                if (hora) {
                    try {
                        const settings = getSettings();
                        const rules = validateBusinessRules(hora, settings);
                        if (!rules.valid) { await sock.sendMessage(remoteJid, { text: `⚠️ ${rules.reason}` }); return; }
                        const db = getAgenda(); 
                        if (db[fecha] && db[fecha].some(c => c.time === hora)) { await sock.sendMessage(remoteJid, { text: `❌ Horario ocupado.` }); return; }
                        
                        if (!db[fecha]) db[fecha] = [];
                        const finalName = user.history['nombre'] || msg.pushName || 'Cliente';
                        db[fecha].push({ time: hora, phone: dbKey, name: finalName, created_at: new Date().toISOString() });
                        saveAgenda(db); 
                        if (global.sendPushNotification) global.sendPushNotification("📅 Cliente Agendado", `Cita: ${fecha} - ${hora}`);

                        if (!nextStepConfig.next_step) await sock.sendMessage(remoteJid, { text: `✅ Cita confirmada: ${fecha} a las ${hora}.` });
                        else nextStepId = nextStepConfig.next_step;
                        
                        await updateUser(dbKey, { history: user.history });
                        if (!nextStepConfig.next_step) return;
                    } catch (error) { await sock.sendMessage(remoteJid, { text: `⚠️ Error interno.` }); return; }
                } 
                else if (rawTime && !hora) { await sock.sendMessage(remoteJid, { text: `⚠️ Hora incorrecta.` }); return; }
            }
            if (!nextStepId) nextStepId = targetStep;
        }
    }

    if (nextStepId) {
        console.log(`➡️ Avanzando al paso: ${nextStepId}`);
        await updateUser(dbKey, { current_step: nextStepId });
        await sendStepMessage(sock, remoteJid, nextStepId, getUser(dbKey));
    }
};

module.exports = { handleMessage, sendStepMessage };
