const fs = require('fs');
const path = require('path');
const { getFlowStep, saveFlowStep, updateUser, getUser, getSettings } = require('../database');
const { addManualContact } = require('../contacts');
const { isBusinessClosed } = require('./agenda');

const SIMULATOR_PHONE = '5218991234567';
const INITIAL_STEP = 'BIENVENIDA';
// Resolvemos la ruta absoluta para evitar ambigüedades
const publicFolder = path.resolve(__dirname, '../../public');

const esSimulador = (jid) => jid.includes(SIMULATOR_PHONE);

const enviarAlFrontend = (jid, contenido, type = 'text') => {
    if (global.io) {
        // Normalizamos el contenido para que el frontend lo entienda siempre
        const textPayload = (typeof contenido === 'string' ? contenido : (contenido.caption || ''))
                           .replace(/\n/g, '<br>');
        
        global.io.emit('message', {
            to: jid,
            message: contenido, // Objeto completo o string
            text: textPayload,
            type: (typeof contenido === 'string' && type !== 'image') ? 'text' : 'image',
            fromMe: true
        });
    }
};

const typing = async (sock, jid, length) => {
    if (esSimulador(jid)) return;
    // Ajuste dinámico: mínimo 500ms, máximo 2s para que se sienta natural
    const ms = Math.min(Math.max(length * 40, 500), 2000); 
    try {
        await sock.sendPresenceUpdate('composing', jid);
        await new Promise(r => setTimeout(r, ms));
        await sock.sendPresenceUpdate('paused', jid);
    } catch(e) { /* Ignorar error de presencia */ }
};

// --- FUNCIÓN PRINCIPAL DE ENVÍO ---
const sendStepMessage = async (sock, jid, stepId, userData = {}) => {
    console.log(`📤 Enviando paso: ${stepId}`);
    
    // Protección contra Loops Infinitos (Recursividad simple)
    if (userData._lastStep === stepId && userData._recursionCount > 2) {
        console.warn(`⚠️ Bucle detectado en paso ${stepId}. Deteniendo.`);
        return;
    }

    let step = getFlowStep(stepId);
    
    // Auto-reparación si el paso inicial no existe
    if (!step && stepId === INITIAL_STEP) {
        step = { type: 'menu', message: '¡Hola! Bienvenido.', options: [] };
        await saveFlowStep(INITIAL_STEP, step);
    }
    if (!step) {
        console.error(`❌ El paso "${stepId}" no existe en la BD.`);
        return;
    }

    // Guardar contacto automáticamente al finalizar
    if (step.type === 'fin_bot') {
        const cleanPhone = jid.replace('@s.whatsapp.net', '').replace('@c.us', '');
        const contactName = userData.history?.nombre || userData.history?.cliente || userData.pushName || 'Cliente Nuevo';
        addManualContact(cleanPhone, contactName, false);
    }

    let messageText = step.message || "";
    const cleanClientPhone = jid.replace(/[^0-9]/g, '');
    let isClosed = false; 

    // ==========================================================
    // 👮 LÓGICA DE FILTRO (SOLO MONITOR)
    // ==========================================================
    if (step.type === 'filtro') {
        
        // 1. VERIFICAR SI ESTÁ CERRADO
        if (isBusinessClosed()) {
            console.log("🌙 Paso Filtro: Negocio Cerrado.");
            isClosed = true;
            const settings = getSettings();
            messageText = settings.schedule?.offline_message || "⛔ Nuestro horario de atención ha terminado. Te contactaremos mañana.";
        }

        // 2. ENVIAR NOTIFICACIÓN PUSH
        if (global.sendPushNotification) {
             const hist = userData.history || {};
             
             let variablesResumen = "";
             Object.keys(hist).forEach(key => {
                 const val = hist[key];
                 const label = key.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
                 variablesResumen += `\n📝 ${label}: ${val}`;
             });

             // 🔥 CORRECCIÓN: TÍTULO ÚNICO PARA QUE SE ACUMULEN 🔥
             const tituloPush = isClosed 
                ? `⚠️ Solicitud Cerrada (${cleanClientPhone})` 
                : `⚠️ Solicitud: ${cleanClientPhone}`;
             
             const targetUrl = `/#activity?chat=${cleanClientPhone}`;

             global.sendPushNotification(
                 tituloPush,
                 `${variablesResumen || 'Ver detalles en Monitor...'}`, 
                 targetUrl
             );
        }
    }

    // 1. Saludo Inteligente
    const mxDate = new Date(new Date().toLocaleString("en-US", {timeZone: "America/Mexico_City"}));
    const hour = mxDate.getHours();
    let saludo = 'Hola';
    if (hour >= 5 && hour < 12) saludo = 'Buenos días';
    else if (hour >= 12 && hour < 19) saludo = 'Buenas tardes';
    else saludo = 'Buenas noches';
    
    if (messageText) {
        messageText = messageText.replace(/{{saludo}}/gi, saludo);

        // 2. Variables Dinámicas
        if (userData.history) {
            Object.keys(userData.history).forEach(key => {
                const val = userData.history[key] || '';
                messageText = messageText.replace(new RegExp(`{{${key}}}`, 'gi'), val);
                messageText = messageText.replace(new RegExp(`{{${key}_primer}}`, 'gi'), val.split(' ')[0]);
            });
        }
        
        // 3. Menú con Emojis
        if (step.type === 'menu' && step.options && step.options.length > 0) {
            messageText += '\n';
            const emojis = ['1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣','🔟'];
            step.options.forEach((opt, index) => {
                if (opt.trigger === opt.label || !isNaN(opt.trigger)) {
                    const bullet = emojis[index] || '👉';
                    messageText += `\n${bullet} ${opt.label}`;
                } else {
                    messageText += `\n👉 ${opt.label}`; 
                }
            });
        }
    }

    // 4. Enviar Multimedia (Imágenes/Videos)
    let mediaList = Array.isArray(step.media) ? step.media : (step.media ? [step.media] : []);
    
    if (step.type === 'filtro' && isClosed) mediaList = [];

    let sentImage = false;

    if (mediaList.length > 0) {
        for (let i = 0; i < mediaList.length; i++) {
            const url = mediaList[i];
            const relativePath = url.startsWith('/') ? url.slice(1) : url;
            const finalPath = path.join(publicFolder, relativePath);
            
            if (!finalPath.startsWith(publicFolder)) {
                console.error(`⛔ Intento de acceso ilegal a archivo: ${finalPath}`);
                continue;
            }
            
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
                    if(mediaList.length > 1) await new Promise(r => setTimeout(r, 800));
                } catch (e) {
                    console.error("Error enviando imagen:", e.message);
                }
            }
        }
    }

    // 5. Enviar Texto
    if (!sentImage && messageText) {
        await typing(sock, jid, messageText.length);
        try {
            if (esSimulador(jid)) enviarAlFrontend(jid, messageText);
            else await sock.sendMessage(jid, { text: messageText });
        } catch (e) {
            console.error("Error enviando texto:", e.message);
        }
    }

    // 6. Auto-Avance
    if (step.type === 'filtro' && isClosed) return;

    if (step.type === 'message' && step.next_step) {
        if (step.next_step === stepId) {
            console.error(`⚠️ ERROR CONFIG: El paso ${stepId} se llama a sí mismo. Deteniendo.`);
            return;
        }
        setTimeout(async () => {
             const checkUser = getUser(userData.phone);
             if (checkUser && checkUser.current_step === stepId) {
                 await updateUser(userData.phone, { current_step: step.next_step });
                 await sendStepMessage(sock, jid, step.next_step, userData);
             }
        }, 1500);
    }
};

module.exports = { sendStepMessage, esSimulador, enviarAlFrontend };
