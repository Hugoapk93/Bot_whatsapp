const { getUser, updateUser, getFlowStep, getSettings, saveFlowStep, getFullFlow } = require('./database');
const { isBotDisabled, addManualContact } = require('./contacts');
const fs = require('fs');
const path = require('path');

// --- CONFIGURACIÓN ---
const SIMULATOR_PHONE = '5218991234567'; 
const INITIAL_STEP = 'BIENVENIDA'; 
const MAX_INACTIVE_MINUTES = 30; // ⏳ Tiempo para reiniciar sesión por inactividad

const agendaPath = path.join(__dirname, '../data/agenda.json');
const publicFolder = path.join(__dirname, '../public'); 

// --- UTILIDADES ---

// 🧠 FUNCIÓN DE SIMILITUD (ANTI-DEDO)
function isSimilar(a, b) {
    if(!a || !b) return false;
    a = a.toLowerCase().trim(); 
    b = b.toLowerCase().trim();
    
    // Coincidencia exacta o contenida
    if (a === b) return true;
    if (a.includes(b) && b.length > 3) return true; // "quiero una moto" incluye "moto"
    if (b.includes(a) && a.length > 3) return true;

    // Si es muy corta, no aplicamos borrosidad
    if (a.length < 4 || b.length < 4) return false;

    // Algoritmo simple de distancia
    const maxLen = Math.max(a.length, b.length);
    if (Math.abs(a.length - b.length) > 2) return false;

    let matches = 0;
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
        if (a[i] === b[i]) matches++;
    }
    
    // Si coincide más del 70%, es válido
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
    if (!/^\d{1,2}:\d{2}$/.test(timeStr)) return { valid: false, reason: "Formato hora incorrecto." };
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
        const formattedText = rawText.replace(/\n/g, '<br>'); // Formato HTML
        const payload = {
            to: jid,
            message: contenido,
            text: formattedText,
            mediaUrl: typeof contenido === 'object' ? contenido.url : null,
            type: tipo,
            fromMe: true
        };
        global.io.emit('message', payload);
        console.log(`✅ [SOCKET] Enviado al navegador.`);
    } else {
        console.error(`❌ [ERROR] Socket.io no disponible.`);
    }
};

const esSimulador = (jid) => jid.includes(SIMULATOR_PHONE);

// --- TYPING ---
const typing = async (sock, jid, length) => {
    if (esSimulador(jid)) return; 
    const ms = Math.min(Math.max(length * 50, 1000), 5000); 
    await sock.sendPresenceUpdate('composing', jid);
    await new Promise(resolve => setTimeout(resolve, ms));
    await sock.sendPresenceUpdate('paused', jid);
};

// --- ENVÍO DE MENSAJES ---
const sendStepMessage = async (sock, jid, stepId, userData = {}) => {
    console.log(`📤 Enviando paso: ${stepId} a ${jid}`);
    let step = getFlowStep(stepId);
    
    // Auto-reparación paso inicial (Solo si no existe en DB)
    if (!step && stepId === INITIAL_STEP) {
        console.log("🔧 Creando paso INICIAL por defecto.");
        step = { type: 'menu', message: '¡Hola! Bienvenido.', options: [] };
        await saveFlowStep(INITIAL_STEP, step);
    }
    if (!step) { console.error(`❌ ERROR: Paso ${stepId} no existe.`); return; }

    let messageText = step.message || "";
    const settings = getSettings();

    // FIN DEL BOT (AGENTE)
    if (step.type === 'fin_bot') {
        const cleanPhone = jid.replace('@s.whatsapp.net', '').replace('@c.us', '');
        const contactName = userData.history?.nombre || userData.history?.cliente || userData.pushName || 'Cliente Nuevo';
        addManualContact(cleanPhone, contactName, false); // Apagar Bot
        console.log(`🛑 Bot desactivado automáticamente para: ${cleanPhone}`);
    }

    if (step.type === 'filtro' && isBusinessClosed()) {
        messageText = settings.schedule.offline_message || "⛔ Horario de atención terminado.";
    }

    // SALUDO DINÁMICO
    const mxDate = new Date(new Date().toLocaleString("en-US", {timeZone: "America/Mexico_City"}));
    const hour = mxDate.getHours();
    let saludo = 'Hola';
    if (hour >= 5 && hour < 12) saludo = 'Buenos días';
    else if (hour >= 12 && hour < 19) saludo = 'Buenas tardes';
    else saludo = 'Buenas noches';
    messageText = messageText.replace(/{{saludo}}/gi, saludo);

    // Reemplazo de variables
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

    let mediaList = Array.isArray(step.media) ? step.media : (step.media ? [step.media] : []);
    let sent = false;

    // Envio Imagenes
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
                    if (esSimulador(jid)) {
                        enviarAlFrontend(jid, { url: url, caption: caption }, 'image');
                        sent = true;
                    } else {
                        await sock.sendMessage(jid, { image: { url: imageToSend }, caption: caption });
                        sent = true; 
                    }
                    if(mediaList.length > 1) await new Promise(r => setTimeout(r, 500)); 
                } catch (e) { console.error(`❌ Error img:`, e.message); }
            }
        }
    }

    // Envio Texto
    if (!sent && messageText) {
        try { 
            if (esSimulador(jid)) enviarAlFrontend(jid, messageText, 'text');
            else { await sock.sendMessage(jid, { text: messageText }); console.log(`✅ Texto enviado.`); }
        } catch (e) { console.error(`❌ Error texto:`, e); }
    }

    // Avance automatico
    if (step.type === 'message' && step.next_step) {
        setTimeout(async () => {
            const freshUser = getUser(userData.phone);
            if (freshUser && freshUser.current_step !== stepId && freshUser.current_step !== step.next_step) return;
            await updateUser(userData.phone, { current_step: step.next_step });
            await sendStepMessage(sock, jid, step.next_step, getUser(userData.phone));
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

    // 1. Identificación
    let incomingPhone = remoteJid.split('@')[0].replace(/:[0-9]+/, ''); 
    let user = getUser(incomingPhone); 
    let dbKey = incomingPhone;

    // Manejo 521/52
    if (!user?.phone) {
        let altKey = null;
        if (incomingPhone.startsWith('521') && incomingPhone.length === 13) altKey = incomingPhone.replace('521', '52');
        else if (incomingPhone.startsWith('52') && incomingPhone.length === 12) altKey = incomingPhone.replace('52', '521');
        if (altKey) {
            const altUser = getUser(altKey);
            if (altUser?.phone) { user = altUser; dbKey = altKey; }
        }
    }

    const timestamp = new Date().toISOString();

    // Registro Silencioso (Si es nuevo, NO contesta aún)
    if (!user?.phone) {
        console.log(`✨ Nuevo Cliente Detectado: ${dbKey}. Registro silencioso.`);
        await updateUser(dbKey, { current_step: INITIAL_STEP, history: {}, jid: remoteJid, last_active: timestamp });
        user = getUser(dbKey);
        // NO enviamos mensaje aquí, esperamos a que diga una palabra clave.
    }

    // Actualizar JID/Hora
    if (user.jid !== remoteJid) {
        await updateUser(dbKey, { jid: remoteJid, last_active: timestamp });
        user.jid = remoteJid; 
    } else {
        await updateUser(dbKey, { last_active: timestamp });
    }

    if (user.blocked) return;

    const cleanText = text.toLowerCase();

    // ⏳ REINICIO POR INACTIVIDAD (Session Timeout)
    if (user.last_active && user.current_step !== INITIAL_STEP) {
        const lastMsgTime = new Date(user.last_active).getTime();
        const nowTime = new Date().getTime();
        const diffMinutes = (nowTime - lastMsgTime) / 1000 / 60;
        
        if (diffMinutes > MAX_INACTIVE_MINUTES) {
            console.log(`⏱️ Sesión expirada (${Math.round(diffMinutes)} min). Reiniciando contexto.`);
            await updateUser(dbKey, { current_step: INITIAL_STEP, history: {} });
            user = getUser(dbKey); // Refrescamos usuario
        }
    }

    // =========================================================================
    // 🧠 LÓGICA DE SALTO GLOBAL (EL CEREBRO DINÁMICO)
    // =========================================================================
    // Aquí es donde el bot decide si lo que escribiste (ej: "moto") corresponde 
    // a algun paso del flujo, sin importar en qué paso estés actualmente.
    // YA NO HAY PALABRAS FIJAS, TODO DEPENDE DE TU DB.
    
    const fullFlow = getFullFlow();
    let jumpToStep = null;

    Object.keys(fullFlow).forEach(stepName => {
        const stepData = fullFlow[stepName];
        
        // Buscamos si el texto coincide con alguna palabra clave de ESTE paso
        if (stepData.keywords && Array.isArray(stepData.keywords)) {
            if (stepData.keywords.some(k => isSimilar(cleanText, k))) {
                jumpToStep = stepName;
            }
        }
    });

    // Si encontramos una palabra clave global (ej: "moto" -> SALTA AL PASO DE MOTO)
    if (jumpToStep) {
        console.log(`🔀 Keyword detectada en Flujo. Saltando a: ${jumpToStep}`);
        await updateUser(dbKey, { current_step: jumpToStep });
        await sendStepMessage(sock, remoteJid, jumpToStep, user);
        return; // Respondemos y terminamos.
    }

    // =========================================================================
    // 🤐 FILTRO DE SILENCIO (Si no hubo salto global)
    // =========================================================================
    // Si estamos en el inicio, y no dijo ninguna palabra clave global,
    // verificamos si está intentando usar el menú. Si no, IGNORAMOS.
    
    if (user.current_step === INITIAL_STEP) {
        const stepData = getFlowStep(INITIAL_STEP);
        
        // Si el paso inicial es un menú, validamos si escribió una opción correcta
        if (stepData && stepData.type === 'menu' && stepData.options) {
            const esOpcionValida = stepData.options.some(opt => {
                const trigger = opt.trigger.toLowerCase();
                const label = opt.label.toLowerCase();
                return isSimilar(cleanText, trigger) || isSimilar(cleanText, label);
            });

            if (!esOpcionValida) {
                console.log(`😶 Ignorando mensaje: "${cleanText}" (No es keyword ni opción de inicio)`);
                return; // AQUÍ SE DETIENE. El bot NO contesta ruido.
            }
        } else {
            // Si el paso inicial NO es un menú (ej: solo texto) y no hubo keyword global,
            // también ignoramos para no responder a todo.
             console.log(`😶 Ignorando mensaje en paso no-interactivo.`);
             return;
        }
    }

    // =========================================================================
    // 3. PROCESAR PASO ACTUAL (Flujo Normal)
    // =========================================================================
    const currentConfig = getFlowStep(user.current_step);
    if (!currentConfig) {
        // Fallback seguridad
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
            const t = opt.trigger.toLowerCase(); 
            const l = opt.label.toLowerCase();     
            const tLimpio = t.replace(/[^0-9a-zñáéíóúü]/g, ''); 

            if (isSimilar(cleanText, t)) return true;
            if (isSimilar(cleanText, tLimpio)) return true;
            if (isSimilar(cleanText, l)) return true;
            return false;
        });

        if (match) {
            console.log(`✅ Opción detectada (Fuzzy): ${match.label} -> ${match.next_step}`);
            nextStepId = match.next_step;
        } else {
            // Mensaje de error si no entiende la opción (solo si ya pasó el filtro estricto)
            let helpText = "⚠️ No entendí tu respuesta.\n\nElige una opción:\n";
            currentConfig.options.forEach(opt => helpText += `👉 *${opt.trigger}* o *${opt.label}*\n`);
            
            if (esSimulador(remoteJid)) enviarAlFrontend(remoteJid, helpText);
            else await sock.sendMessage(remoteJid, { text: helpText });
            return; 
        }
    }

    else if (currentConfig.type === 'message') {
        nextStepId = currentConfig.next_step;
    }
    
    // Logica Citas
    if (nextStepId) {
        const nextStepConfig = getFlowStep(nextStepId);
        if (nextStepConfig && nextStepConfig.type === 'cita') {
             let rawDate = user.history['fecha_cita'] || user.history['fecha']; 
             let rawTime = user.history['hora_cita'] || user.history['hora'];    
             let fecha = normalizeDate(rawDate);
             
             if (nextStepConfig.next_step) { 
                 if (!fecha || fecha < new Date().toISOString().split('T')[0]) { 
                    const txt = `⚠️ Fecha inválida o pasada.`;
                    if(esSimulador(remoteJid)) enviarAlFrontend(remoteJid, txt); else await sock.sendMessage(remoteJid, { text: txt });
                    return; 
                 }
                 nextStepId = nextStepConfig.next_step; 
             } else { 
                 if (!fecha) {
                     const possibleCorrection = normalizeDate(rawTime);
                     if (possibleCorrection) {
                         await updateUser(dbKey, { history: { ...user.history, fecha: rawTime, hora: '' } });
                         const txt = `🗓️ Fecha entendida: ${possibleCorrection}. ¿Hora?`;
                         if(esSimulador(remoteJid)) enviarAlFrontend(remoteJid, txt); else await sock.sendMessage(remoteJid, { text: txt });
                         return;
                     } 
                     const txt = `⚠️ No reconocí la fecha.`;
                     if(esSimulador(remoteJid)) enviarAlFrontend(remoteJid, txt); else await sock.sendMessage(remoteJid, { text: txt });
                     return;
                 }
                 const hora = normalizeTime(rawTime);
                 if (!hora) { 
                    const txt = `⚠️ Hora inválida.`;
                    if(esSimulador(remoteJid)) enviarAlFrontend(remoteJid, txt); else await sock.sendMessage(remoteJid, { text: txt });
                    return; 
                 }
                 const settings = getSettings();
                 const rules = validateBusinessRules(hora, settings);
                 const pathSuccess = nextStepConfig.options?.find(o => o.internal_label === 'DISPONIBLE');
                 const pathFail = nextStepConfig.options?.find(o => o.internal_label === 'NO_DISPONIBLE');
                 if (!rules.valid) {
                     const txt = `⚠️ ${rules.reason}`;
                     if(esSimulador(remoteJid)) enviarAlFrontend(remoteJid, txt); else await sock.sendMessage(remoteJid, { text: txt });
                     if (pathFail) nextStepId = pathFail.next_step; else return;
                 } else {
                     const db = getAgenda();
                     if (db[fecha] && db[fecha].some(c => c.time === hora)) {
                         const txt = `❌ Horario ocupado.`;
                         if(esSimulador(remoteJid)) enviarAlFrontend(remoteJid, txt); else await sock.sendMessage(remoteJid, { text: txt });
                         if (pathFail) nextStepId = pathFail.next_step; else return;
                     } else {
                         if (!db[fecha]) db[fecha] = [];
                         const finalName = user.history['nombre'] || user.history['cliente'] || msg.pushName || 'Cliente';
                         db[fecha].push({ time: hora, phone: dbKey, name: finalName, created_at: new Date().toISOString() });
                         saveAgenda(db);
                         // SIN CONFIRMACIÓN AUTOMÁTICA
                         if (pathSuccess) nextStepId = pathSuccess.next_step;
                     }
                 }
             }
        }
    }

    if (nextStepId) {
        console.log(`➡️ Avanzando al paso: ${nextStepId}`);
        await updateUser(dbKey, { current_step: nextStepId });
        await sendStepMessage(sock, remoteJid, nextStepId, getUser(dbKey));
    }
};

module.exports = { handleMessage, sendStepMessage };
