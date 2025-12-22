const { getUser, updateUser, getFlowStep, getSettings, saveFlowStep, getFullFlow, getAllUsers } = require('./database');
const { isBotDisabled, addManualContact } = require('./contacts');
const fs = require('fs');
const path = require('path');

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
    // Limpieza básica
    let text = input.toLowerCase().trim()
        .replace(/\b(de|del|el|para|el día)\b/g, ' ')
        .replace(/\s+/g, ' ')
        .replace(/[.\/]/g, '-');
    
    const parts = text.split('-');
    const tokens = parts.length >= 2 ? parts : text.split(' ');

    // Si solo hay 2 datos (ej: 25 diciembre), agregamos el año actual
    if (tokens.length === 2) {
        tokens.push(new Date().getFullYear().toString());
    }

    if (tokens.length === 3) {
        let day = tokens[0].padStart(2, '0');
        let monthRaw = tokens[1];
        let year = tokens[2];

        const months = { 'ene': '01', 'feb': '02', 'mar': '03', 'abr': '04', 'may': '05', 'jun': '06', 'jul': '07', 'ago': '08', 'sep': '09', 'oct': '10', 'nov': '11', 'dic': '12' };
        
        // Intentar parsear mes (texto o número)
        let month = months[monthRaw.substring(0, 3)] || (parseInt(monthRaw) ? monthRaw.padStart(2, '0') : null);
        
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

// --- ENVÍO DE MENSAJES ---
const sendStepMessage = async (sock, jid, stepId, userData = {}) => {
    console.log(`📤 Enviando paso: ${stepId} a ${jid}`);
    let step = getFlowStep(stepId);

    if (!step && stepId === INITIAL_STEP) {
        step = { type: 'menu', message: '¡Hola! Bienvenido.', options: [] };
        await saveFlowStep(INITIAL_STEP, step);
    }
    if (!step) return;

    let messageText = step.message || "";
    const settings = getSettings();

    if (step.type === 'fin_bot') {
        const cleanPhone = jid.replace('@s.whatsapp.net', '').replace('@c.us', '');
        const contactName = userData.history?.nombre || userData.history?.cliente || userData.pushName || 'Cliente Nuevo';
        addManualContact(cleanPhone, contactName, false);
    }

    // ==========================================================
    // NOTIFICACIÓN AL ADMIN (FILTRO) - CON TODAS LAS VARIABLES
    // ==========================================================
    if (step.type === 'filtro') {
        
        const cleanClientPhone = jid.replace(/[^0-9]/g, '');
        const hist = userData.history || {};
        
        // 1. CONSTRUIR TEXTO CON TODAS LAS VARIABLES
        let variablesResumen = "";
        Object.keys(hist).forEach(key => {
            const val = hist[key];
            // Formatea "tipo_servicio" a "Tipo Servicio" para que se vea bonito
            const label = key.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
            variablesResumen += `\n📝 ${label}: ${val}`;
        });

        // 2. SIEMPRE MANDAR PUSH AL MONITOR / APP
        if (global.sendPushNotification) {
             global.sendPushNotification(
                 "⚠️ Solicitud Pendiente", 
                 `Cliente: ${cleanClientPhone}\n${variablesResumen || '(Sin datos adicionales)'}`
             );
        }

        // 3. WHATSAPP AL ADMIN (SOLO SI HAY NUMERO CONFIGURADO)
        if (step.admin_number) {
            const adminJid = step.admin_number.includes('@') ? step.admin_number : `${step.admin_number}@s.whatsapp.net`;

            // Construir Ficha para WhatsApp
            let adminMsg = `🔔 *Solicitud de Aprobación*\n\n`;
            adminMsg += `🆔 *ID:* ${cleanClientPhone}\n`;
            adminMsg += `------------------------------\n`;
            
            if (variablesResumen) {
                // Reutilizamos las variables formateadas pero quitamos los emojis para WhatsApp si prefieres
                // O usamos el loop de nuevo para formato específico de WhatsApp (Bold)
                 Object.keys(hist).forEach(key => {
                    const val = hist[key];
                    const label = key.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
                    adminMsg += `📄 *${label}:* ${val}\n`;
                });
            } else {
                adminMsg += `(Sin datos capturados aún)\n`;
            }

            adminMsg += `------------------------------\n`;
            adminMsg += `🤖 *Bot:* "${messageText}"\n\n`;
            adminMsg += `👇 *Escribe una opción (copia y pega):*`;

            try { await sock.sendMessage(adminJid, { text: adminMsg }); } catch (e) {}

            // Enviar Botones (Simulados como texto para compatibilidad total)
            const emojis = ['1️⃣','2️⃣','3️⃣','4️⃣','5️⃣'];
            if(step.options && Array.isArray(step.options)){
                for (let idx = 0; idx < step.options.length; idx++) {
                    const opt = step.options[idx];
                    const icon = emojis[idx] || '👉';
                    const btnMsg = `${icon} ${opt.trigger} ${cleanClientPhone}`;
                    await new Promise(r => setTimeout(r, 200));
                    try { await sock.sendMessage(adminJid, { text: btnMsg }); } catch (e) {}
                }
            } else {
                 await new Promise(r => setTimeout(r, 200));
                 try { await sock.sendMessage(adminJid, { text: `👉 Aprobar ${cleanClientPhone}` }); } catch (e) {}
                 await new Promise(r => setTimeout(r, 200));
                 try { await sock.sendMessage(adminJid, { text: `👉 Rechazar ${cleanClientPhone}` }); } catch (e) {}
            }
            console.log(`👮 WhatsApp enviado al Admin: ${step.admin_number}`);
        }
    }

    if (step.type === 'filtro' && isBusinessClosed()) {
        messageText = settings.schedule.offline_message || "⛔ Horario de atención terminado.";
    }

    // SALUDO
    const mxDate = new Date(new Date().toLocaleString("en-US", {timeZone: "America/Mexico_City"}));
    const hour = mxDate.getHours();
    let saludo = 'Hola';
    if (hour >= 5 && hour < 12) saludo = 'Buenos días';
    else if (hour >= 12 && hour < 19) saludo = 'Buenas tardes';
    else saludo = 'Buenas noches';
    messageText = messageText.replace(/{{saludo}}/gi, saludo);

    // VARIABLES EN MENSAJE AL USUARIO
    if (userData.history) {
        Object.keys(userData.history).forEach(key => {
            const val = userData.history[key] || '';
            messageText = messageText.replace(new RegExp(`{{${key}}}`, 'gi'), val);
            messageText = messageText.replace(new RegExp(`{{${key}_primer}}`, 'gi'), val.split(' ')[0]);
        });
    }

    // MENÚ INTELIGENTE
    if (step.type === 'menu' && step.options) {
        messageText += '\n';
        const emojis = ['1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣','🔟'];
        step.options.forEach((opt, index) => {
            if (opt.trigger === opt.label) {
                const bullet = emojis[index] || '👉';
                messageText += `\n${bullet} ${opt.label}`;
            } else {
                messageText += `\n${opt.trigger} ${opt.label}`;
            }
        });
    }

    try { await typing(sock, jid, messageText.length); } catch (e) {}

    // MEDIA
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
                    if (esSimulador(jid)) {
                        enviarAlFrontend(jid, { url: url, caption: caption }, 'image');
                        sent = true;
                    } else {
                        await sock.sendMessage(jid, { image: { url: imageToSend }, caption: caption });
                        sent = true;
                    }
                    if(mediaList.length > 1) await new Promise(r => setTimeout(r, 500));
                } catch (e) {}
            }
        }
    }

    if (!sent && messageText) {
        try {
            if (esSimulador(jid)) enviarAlFrontend(jid, messageText, 'text');
            else { await sock.sendMessage(jid, { text: messageText }); }
        } catch (e) {}
    }

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

    let incomingPhone = remoteJid.split('@')[0].replace(/:[0-9]+/, '');
    let user = getUser(incomingPhone);
    let dbKey = incomingPhone;

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

    if (!user?.phone) {
        console.log(`✨ Nuevo Cliente: ${dbKey}`);
        await updateUser(dbKey, { current_step: INITIAL_STEP, history: {}, jid: remoteJid, last_active: timestamp });
        user = getUser(dbKey);
    }

    if (user.jid !== remoteJid) {
        await updateUser(dbKey, { jid: remoteJid, last_active: timestamp });
        user.jid = remoteJid;
    } else {
        await updateUser(dbKey, { last_active: timestamp });
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

    // =================================================================
    // 1. LÓGICA DE ADMINISTRADOR
    // =================================================================
    const words = cleanText.split(/\s+/);
    let targetClientPhone = null;
    let commandOption = "";

    for (const word of words) {
        const potentialNum = word.replace(/[^0-9]/g, '');
        if (potentialNum.length >= 10 && potentialNum.length <= 13 && potentialNum !== incomingPhone) {

            let checkUser = getUser(potentialNum);
            if (!checkUser && potentialNum.startsWith('52') && potentialNum.length === 12) {
                 checkUser = getUser('521' + potentialNum.slice(2));
            }
            if (!checkUser && potentialNum.length === 10) {
                 checkUser = getUser('521' + potentialNum);
            }

            if (checkUser) {
                targetClientPhone = checkUser.phone;
                commandOption = cleanText.replace(word, '').trim();
                break;
            }
        }
    }

    if (targetClientPhone) {
        const targetUser = getUser(targetClientPhone);
        const targetStepConfig = getFlowStep(targetUser.current_step);

        if (targetStepConfig && targetStepConfig.type === 'filtro' && targetStepConfig.admin_number) {

            const senderLast10 = incomingPhone.slice(-10);
            const adminLast10 = targetStepConfig.admin_number.replace(/[^0-9]/g, '').slice(-10);

            if (senderLast10 === adminLast10) {
                console.log(`👮 Admin autorizado (${incomingPhone}) -> Cliente (${targetClientPhone})`);

                const match = targetStepConfig.options?.find(opt => {
                    const t = opt.trigger.toLowerCase();
                    const l = opt.label.toLowerCase();
                    return isSimilar(commandOption, t) || isSimilar(commandOption, l) || commandOption.includes(t) || commandOption.includes(l);
                });

                if (match) {
                    await sock.sendMessage(remoteJid, { text: `✅ Acción: ${match.label}` });
                    await updateUser(targetClientPhone, { current_step: match.next_step });
                    const targetJid = targetUser.jid || targetClientPhone + '@s.whatsapp.net';
                    await sendStepMessage(sock, targetJid, match.next_step, targetUser);
                    return;
                } else {
                    await sock.sendMessage(remoteJid, { text: `⚠️ Opción no válida.` });
                    return;
                }
            }
        }
    }

    // =================================================================
    // 2. LÓGICA DE USUARIO / CLIENTE
    // =================================================================

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

    // CORRECCIÓN MENÚ
    else if (currentConfig.type === 'menu') {
        let match = null;
        const numberMatches = cleanText.match(/^(\d+)[\s.)]*$/);
        if (numberMatches) {
             const index = parseInt(numberMatches[1]) - 1;
             if (index >= 0 && index < (currentConfig.options?.length || 0)) match = currentConfig.options[index];
        }

        if (!match) {
            match = currentConfig.options?.find(opt => {
                const t = opt.trigger.toLowerCase();
                const l = opt.label.toLowerCase();
                const tLimpio = t.replace(/[^0-9a-zñáéíóúü]/g, '');
                return isSimilar(cleanText, t) || isSimilar(cleanText, tLimpio) || isSimilar(cleanText, l);
            });
        }

        if (match) {
            nextStepId = match.next_step;
        } else {
            if (user.current_step === INITIAL_STEP) return;

            // --- CORRECCIÓN SOLICITADA: FORMATO DE ERROR LIMPIO ---
            let helpText = "⚠️ No entendí.\nPor favor escribe las siguientes opciones:\n";
            currentConfig.options.forEach((opt, index) => {
                // Muestra: 👉 *1* o *Nombre Opción*
                helpText += `👉 *${index + 1}* o *${opt.label}*\n`;
            });

            if (esSimulador(remoteJid)) enviarAlFrontend(remoteJid, helpText);
            else await sock.sendMessage(remoteJid, { text: helpText });
            return;
        }
    }

    else if (currentConfig.type === 'filtro') {
        console.log(`🔒 Cliente ${dbKey} intentó escribir en FILTRO. Ignorado.`);
        return;
    }

    else if (currentConfig.type === 'message') {
        nextStepId = currentConfig.next_step;
    }

    // --- LÓGICA CITAS CORREGIDA (VALIDACIÓN ESTRICTA) ---
    if (nextStepId || currentConfig.type === 'cita') {
        
        let targetStep = nextStepId || user.current_step;
        const nextStepConfig = getFlowStep(targetStep);
        
        if (nextStepConfig && nextStepConfig.type === 'cita') {

            // 1. CAPTURA INTELIGENTE DE DATOS
            const detectedDate = normalizeDate(text); 
            const detectedTime = normalizeTime(text); 

            console.log(`🔍 Input Citas: "${text}" | Fecha detectada: ${detectedDate} | Hora detectada: ${detectedTime}`);

            // Si detectamos fecha nueva en el mensaje, actualizamos
            if (detectedDate) {
                user.history['fecha_cita'] = text; 
                user.history['fecha'] = text; 
                // Limpiamos hora previa si cambian de fecha para evitar conflictos
                // delete user.history['hora_cita']; 
                await updateUser(dbKey, { history: user.history }); 
            }

            // Si detectamos hora nueva en el mensaje, actualizamos
            if (detectedTime) {
                user.history['hora_cita'] = text;
                await updateUser(dbKey, { history: user.history });
            }

            // 2. LEER ESTADO ACTUAL
            // Recuperamos lo que el usuario escribió originalmente
            let rawDateInput = user.history['fecha_cita'] || user.history['fecha'];
            let rawTimeInput = user.history['hora_cita'];

            // Normalizamos para validar
            let fechaValida = normalizeDate(rawDateInput);
            let horaValida = normalizeTime(rawTimeInput);

            // 3. VALIDACIÓN DE FECHA (Evitar fallo silencioso)
            if (rawDateInput && !fechaValida) {
                const txt = `⚠️ No entendí la fecha "${rawDateInput}".\nPor favor escríbela así: *25 de diciembre* o *25/12/2025*.`;
                if(esSimulador(remoteJid)) enviarAlFrontend(remoteJid, txt); else await sock.sendMessage(remoteJid, { text: txt });
                return; // Detenemos para que el usuario corrija
            }

            if (fechaValida) {
                const hoy = new Date().toISOString().split('T')[0];
                if (fechaValida < hoy) {
                    const txt = `⚠️ La fecha ${fechaValida} ya pasó.\nPor favor indica una fecha futura.`;
                    if(esSimulador(remoteJid)) enviarAlFrontend(remoteJid, txt); else await sock.sendMessage(remoteJid, { text: txt });
                    // Borramos la fecha inválida del historial para obligar a pedirla de nuevo
                    delete user.history['fecha_cita'];
                    delete user.history['fecha'];
                    await updateUser(dbKey, { history: user.history });
                    return;
                }
            }

            // 4. INTENTO DE AGENDAR (Solo si tenemos ambos datos válidos)
            if (fechaValida && horaValida) {
                
                console.log(`⚡ Intentando agendar: ${fechaValida} @ ${horaValida}`);
                
                try {
                    const settings = getSettings();
                    const rules = validateBusinessRules(horaValida, settings);
                    
                    // Validación de Reglas de Negocio (Horario y Minutos)
                    if (!rules.valid) {
                        const txt = `⚠️ ${rules.reason}\n🕒 Horario: ${settings.schedule?.start || '09:00'} - ${settings.schedule?.end || '18:00'}`;
                        if(esSimulador(remoteJid)) enviarAlFrontend(remoteJid, txt); else await sock.sendMessage(remoteJid, { text: txt });
                        // Borramos la hora incorrecta
                        delete user.history['hora_cita'];
                        await updateUser(dbKey, { history: user.history });
                        return; 
                    }
                    
                    // Validación de Disponibilidad (Agenda llena)
                    const db = getAgenda(); 
                    if (db[fechaValida] && db[fechaValida].some(c => c.time === horaValida)) {
                        const txt = `❌ El horario de las ${horaValida} ya está ocupado.\nPor favor escribe otra hora.`;
                        if(esSimulador(remoteJid)) enviarAlFrontend(remoteJid, txt); else await sock.sendMessage(remoteJid, { text: txt });
                        return; 
                    }
                    
                    // --- GUARDAR CITA ---
                    if (!db[fechaValida]) db[fechaValida] = [];
                    const finalName = user.history['nombre'] || msg.pushName || 'Cliente';
                    
                    db[fechaValida].push({ 
                        time: horaValida, 
                        phone: dbKey, 
                        name: finalName, 
                        created_at: new Date().toISOString() 
                    });
                    
                    saveAgenda(db); 
                    console.log(`🎉 Cita guardada en agenda.json`);
                    
                    // Notificación Push
                    if (global.sendPushNotification) {
                         global.sendPushNotification("📅 Nueva Cita", `El ${fechaValida} a las ${horaValida} con ${finalName}`);
                    }

                    // ÉXITO: Avanzamos
                    if (!nextStepConfig.next_step) {
                        const txt = `✅ ¡Listo! Tu cita quedó agendada para el *${fechaValida}* a las *${horaValida}*.`;
                        if(esSimulador(remoteJid)) enviarAlFrontend(remoteJid, txt); else await sock.sendMessage(remoteJid, { text: txt });
                    } else {
                        nextStepId = nextStepConfig.next_step;
                    }

                    // Limpiamos memoria temporal si es necesario, o la dejamos para el resumen
                    return; // Salimos aquí si todo fue bien, el handler principal moverá el paso si hay nextStepId

                } catch (error) {
                    console.error("🔥 Error crítico al guardar cita:", error);
                    const txt = `⚠️ Error del sistema. Intenta más tarde.`;
                    if(esSimulador(remoteJid)) enviarAlFrontend(remoteJid, txt); else await sock.sendMessage(remoteJid, { text: txt });
                    return;
                }
            } 
            
            // 5. MANEJO DE HORA INVÁLIDA (Si puso algo que parece hora pero no es válida)
            else if (rawTimeInput && !horaValida) {
                  const txt = `⚠️ No reconocí la hora "${rawTimeInput}".\nUsa el formato: *4:00 PM* o *16:00*.`;
                  if(esSimulador(remoteJid)) enviarAlFrontend(remoteJid, txt); else await sock.sendMessage(remoteJid, { text: txt });
                  return;
            }

            // Si llegamos aquí, es que falta un dato (fecha o hora) y el bot mostrará el mensaje del paso 'cita'
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
