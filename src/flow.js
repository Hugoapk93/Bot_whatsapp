const { getUser, updateUser, getFlowStep, getSettings, saveFlowStep, getFullFlow } = require('./database');
const { isBotDisabled } = require('./contacts');
const fs = require('fs');
const path = require('path');

// --- CONFIGURACIÓN DEL SIMULADOR ---
const SIMULATOR_PHONE = '5218991234567'; // <--- TU NÚMERO DE SIMULADOR

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

// Validación para CITAS (Reglas de negocio)
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

// 🕒 VALIDACIÓN DE HORARIO DE ATENCIÓN (FIX ZONA HORARIA MÉXICO)
const isBusinessClosed = () => {
    const settings = getSettings();
    if (!settings.schedule || !settings.schedule.active) return false;
    
    // 1. Obtener la hora actual del servidor
    const nowServer = new Date();

    // 2. Convertir explícitamente a Hora CDMX/Reynosa
    // Esto crea un objeto Date "engañado" que tiene la hora local correcta en .getHours()
    const mxDate = new Date(nowServer.toLocaleString("en-US", {timeZone: "America/Mexico_City"}));

    const currentMins = (mxDate.getHours() * 60) + mxDate.getMinutes();
    const currentDay = mxDate.getDay(); // 0 = Domingo, 6 = Sábado

    console.log(`🕒 Verificando Horario: ${mxDate.getHours()}:${mxDate.getMinutes()} (Día: ${currentDay})`);

    // Verificar día
    if (settings.schedule.days && !settings.schedule.days.includes(currentDay)) return true;

    // Verificar hora
    const [sh, sm] = (settings.schedule.start || "09:00").split(':').map(Number);
    const [eh, em] = (settings.schedule.end || "18:00").split(':').map(Number);

    const startMins = (sh * 60) + sm;
    const endMins = (eh * 60) + em;

    return (currentMins < startMins || currentMins >= endMins);
};

// --- INTERCEPTOR PARA EL SIMULADOR ---
const enviarAlFrontend = (jid, contenido, tipo = 'text') => {
    // AQUÍ ES DONDE CONECTAS CON TU WEB/SOCKET
    // Si tienes socket.io global, sería algo como: global.io.emit('mensaje_bot', { ... })
    
    console.log(`\n🤖 [SIMULADOR DETECTADO] 🤖`);
    console.log(`   Destino: ${jid}`);
    console.log(`   Tipo: ${tipo}`);
    console.log(`   Contenido: ${JSON.stringify(contenido)}`);
    console.log(`   --> Mensaje interceptado. NO enviado a WhatsApp Real.\n`);
    
    // Si usas sockets, descomenta y ajusta esta línea:
    // if (global.io) global.io.emit('bot-reply', { phone: SIMULATOR_PHONE, message: contenido, type: tipo });
};

const esSimulador = (jid) => {
    return jid.includes(SIMULATOR_PHONE);
};

// --- SIMULACIÓN DE TYPING ---
const typing = async (sock, jid, length) => {
    // Si es simulador, no enviamos presencia real porque puede dar error si el número no existe
    if (esSimulador(jid)) return; 

    const ms = Math.min(Math.max(length * 50, 1000), 5000); 
    await sock.sendPresenceUpdate('composing', jid);
    await new Promise(resolve => setTimeout(resolve, ms));
    await sock.sendPresenceUpdate('paused', jid);
};

// --- ENVÍO MENSAJES ---
const sendStepMessage = async (sock, jid, stepId, userData = {}) => {
    console.log(`📤 Enviando paso: ${stepId} a ${jid}`);
    let step = getFlowStep(stepId);
    
    // Auto-reparación paso inicial
    if (!step && stepId === INITIAL_STEP) {
        console.log("🔧 Auto-reparando paso INICIAL...");
        step = { type: 'menu', message: '¡Hola! Bienvenido al sistema.', options: [] };
        await saveFlowStep(INITIAL_STEP, step);
    }
    
    if (!step) {
        console.error(`❌ ERROR CRÍTICO: Paso ${stepId} no encontrado en la DB.`);
        return;
    }

    let messageText = step.message || "";
    const settings = getSettings();

    // Verificar si está cerrado
    if (step.type === 'filtro' && isBusinessClosed()) {
        console.log("⛔ Negocio CERRADO por horario.");
        messageText = settings.schedule.offline_message || "⛔ Nuestro horario de atención ha terminado. Te responderemos mañana.";
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

    // Typing (Ya tiene el filtro interno)
    try { await typing(sock, jid, messageText.length); } catch (e) {}

    let mediaList = [];
    if (Array.isArray(step.media)) {
        mediaList = step.media;
    } else if (step.media && typeof step.media === 'string') {
        mediaList = [step.media];
    }

    let sent = false;

    // --- LOGICA DE IMÁGENES ---
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
                    // INTERCEPCIÓN SIMULADOR (IMÁGENES)
                    if (esSimulador(jid)) {
                        enviarAlFrontend(jid, { url: url, caption: caption }, 'image');
                        sent = true;
                    } else {
                        // ENVÍO REAL
                        await sock.sendMessage(jid, { image: { url: imageToSend }, caption: caption });
                        sent = true; 
                    }
                    if(mediaList.length > 1) await new Promise(r => setTimeout(r, 500)); 
                } catch (e) {
                    console.error(`❌ Error enviando imagen ${i}:`, e.message);
                }
            } else {
                console.log(`⚠️ Imagen no encontrada en ruta: ${url}`);
            }
        }
    }

    // --- LÓGICA DE TEXTO ---
    if (!sent && messageText) {
        try { 
            // INTERCEPCIÓN SIMULADOR (TEXTO)
            if (esSimulador(jid)) {
                enviarAlFrontend(jid, messageText, 'text');
            } else {
                // ENVÍO REAL
                await sock.sendMessage(jid, { text: messageText }); 
                console.log(`✅ Texto enviado correctamente.`);
            }
        } catch (e) {
            console.error(`❌ Error al enviar texto:`, e);
        }
    }

    if (step.type === 'message' && step.next_step) {
        setTimeout(async () => {
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
    console.log(`📩 Mensaje recibido de: ${remoteJid}`);

    if (isBotDisabled(remoteJid)) {
        console.log(`⛔ Bot desactivado para este usuario.`);
        return;
    }
    if (remoteJid.includes('@g.us') || remoteJid === 'status@broadcast') return;

    const text = (msg.message?.conversation || msg.message?.extendedTextMessage?.text || '').trim();
    if (!text) {
        console.log(`⚠️ Mensaje sin texto (sticker, audio, etc). Ignorado.`);
        return;
    }
    console.log(`💬 Texto: "${text}"`);

    // --- 1. IDENTIFICACIÓN ---
    let incomingPhone = remoteJid.split('@')[0].replace(/:[0-9]+/, ''); 
    let user = getUser(incomingPhone); 
    let dbKey = incomingPhone;

    if (!user?.phone) {
        let altKey = null;
        if (incomingPhone.startsWith('521') && incomingPhone.length === 13) altKey = incomingPhone.replace('521', '52');
        else if (incomingPhone.startsWith('52') && incomingPhone.length === 12) altKey = incomingPhone.replace('52', '521');

        if (altKey) {
            const altUser = getUser(altKey);
            if (altUser?.phone) { 
                console.log(`🔗 Usuario encontrado con variante: ${altKey}`);
                user = altUser; 
                dbKey = altKey; 
            }
        }
    }

    const timestamp = new Date().toISOString();

    if (!user?.phone) {
        console.log(`✨ Nuevo Cliente Detectado: ${dbKey}. Iniciando BIENVENIDA.`);
        await updateUser(dbKey, { current_step: INITIAL_STEP, history: {}, jid: remoteJid, last_active: timestamp });
        user = getUser(dbKey);
        await sendStepMessage(sock, remoteJid, INITIAL_STEP, user);
        return;
    }

    if (user.jid !== remoteJid) {
        await updateUser(dbKey, { jid: remoteJid, last_active: timestamp });
        user.jid = remoteJid; 
    } else {
        await updateUser(dbKey, { last_active: timestamp });
    }

    if (user.blocked) {
        console.log(`⛔ Usuario bloqueado.`);
        return;
    }

    const cleanText = text.toLowerCase();

    // --- 2. PALABRAS CLAVE ---
    const fullFlow = getFullFlow();
    let jumpToStep = null;

    Object.keys(fullFlow).forEach(stepName => {
        const stepData = fullFlow[stepName];
        if (stepData.keywords && Array.isArray(stepData.keywords)) {
            if (stepData.keywords.some(k => cleanText.includes(k.toLowerCase()))) {
                jumpToStep = stepName;
            }
        }
    });

    if (jumpToStep) {
        console.log(`🔀 Palabra clave detectada. Saltando a: ${jumpToStep}`);
        await updateUser(dbKey, { current_step: jumpToStep });
        await sendStepMessage(sock, remoteJid, jumpToStep, user);
        return; 
    }

    if (['hola', 'menu', 'inicio', 'menú', 'reset'].includes(cleanText)) {
        console.log(`🔄 Comando de reinicio detectado.`);
        await updateUser(dbKey, { current_step: INITIAL_STEP });
        await sendStepMessage(sock, remoteJid, INITIAL_STEP, user);
        return;
    }

    // --- 3. PROCESAR PASO ---
    console.log(`📍 Procesando paso actual: ${user.current_step}`);
    const currentConfig = getFlowStep(user.current_step);
    
    if (!currentConfig) {
        console.log(`⚠️ Paso actual no existe. Reiniciando a BIENVENIDA.`);
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

            if (cleanText === t) return true;        
            if (cleanText === tLimpio) return true; 
            if (cleanText === l) return true;        
            
            if (cleanText.length > 3 && l.includes(cleanText)) return true;
            if (cleanText.length > 3 && cleanText.includes(l)) return true;

            return false;
        });

        if (match) {
            console.log(`✅ Opción menú detectada: ${match.label} -> ${match.next_step}`);
            nextStepId = match.next_step;
        } else {
            console.log(`❓ Opción no reconocida en menú.`);
            let helpText = "⚠️ No entendí tu respuesta.\n\nPor favor, selecciona una de estas opciones:\n";
            currentConfig.options.forEach(opt => {
                helpText += `👉 *${opt.trigger}* o *${opt.label}*\n`;
            });
            // INTERCEPCIÓN ERROR MENU
            if (esSimulador(remoteJid)) {
                enviarAlFrontend(remoteJid, helpText);
            } else {
                await sock.sendMessage(remoteJid, { text: helpText });
            }
            return; 
        }
    }

    else if (currentConfig.type === 'message') {
        nextStepId = currentConfig.next_step;
    }
    
    if (nextStepId) {
        const nextStepConfig = getFlowStep(nextStepId);
        
        if (nextStepConfig && nextStepConfig.type === 'cita') {
             // Intentamos recuperar fecha/hora del historial
             let rawDate = user.history['fecha_cita'] || user.history['fecha']; 
             let rawTime = user.history['hora_cita'] || user.history['hora'];    
             let fecha = normalizeDate(rawDate);
             
             if (nextStepConfig.next_step) { 
                 if (!fecha) { 
                    const txt = `⚠️ La fecha ingresada no es válida.`;
                    if(esSimulador(remoteJid)) enviarAlFrontend(remoteJid, txt); else await sock.sendMessage(remoteJid, { text: txt });
                    return; 
                 }
                 const today = new Date().toISOString().split('T')[0];
                 if (fecha < today) { 
                    const txt = `⚠️ No podemos viajar al pasado. Elige una fecha futura.`;
                    if(esSimulador(remoteJid)) enviarAlFrontend(remoteJid, txt); else await sock.sendMessage(remoteJid, { text: txt });
                    return; 
                 }
                 
                 nextStepId = nextStepConfig.next_step; 
             } else { 
                 if (!fecha) {
                     const possibleCorrection = normalizeDate(rawTime);
                     if (possibleCorrection) {
                         await updateUser(dbKey, { history: { ...user.history, fecha: rawTime, hora: '' } });
                         const txt = `🗓️ Entendido, fecha: ${possibleCorrection}. ¿A qué hora te gustaría?`;
                         if(esSimulador(remoteJid)) enviarAlFrontend(remoteJid, txt); else await sock.sendMessage(remoteJid, { text: txt });
                         return;
                     } 
                     const txt = `⚠️ No pude reconocer la fecha. Usa formato Día Mes (ej: 5 Octubre).`;
                     if(esSimulador(remoteJid)) enviarAlFrontend(remoteJid, txt); else await sock.sendMessage(remoteJid, { text: txt });
                     return;
                 }
 
                 const hora = normalizeTime(rawTime);
                 if (!hora) { 
                    const txt = `⚠️ Hora inválida. Usa formato 24h o AM/PM (ej: 4:00 PM).`;
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
                         const txt = `❌ Ese horario ya está ocupado.`;
                         if(esSimulador(remoteJid)) enviarAlFrontend(remoteJid, txt); else await sock.sendMessage(remoteJid, { text: txt });
                         if (pathFail) nextStepId = pathFail.next_step; else return;
                     } else {
                         if (!db[fecha]) db[fecha] = [];
                         const finalName = user.history['nombre'] || user.history['cliente'] || msg.pushName || 'Cliente WhatsApp';
                         db[fecha].push({ time: hora, phone: dbKey, name: finalName, created_at: new Date().toISOString() });
                         saveAgenda(db);
                         
                         const txt = `✅ Cita Confirmada: ${fecha} a las ${hora}`;
                         if(esSimulador(remoteJid)) enviarAlFrontend(remoteJid, txt); else await sock.sendMessage(remoteJid, { text: txt });
                         if (pathSuccess) nextStepId = pathSuccess.next_step;
                     }
                 }
             }
        }
    }

    if (nextStepId) {
        console.log(`➡️ Avanzando al paso: ${nextStepId}`);
        await updateUser(dbKey, { current_step: nextStepId });
        const updatedUser = getUser(dbKey); 
        await sendStepMessage(sock, remoteJid, nextStepId, updatedUser);
    }
};

module.exports = { handleMessage, sendStepMessage };
