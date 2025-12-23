const fs = require('fs');
const path = require('path');
const { getFlowStep, saveFlowStep, updateUser, getUser } = require('../database');
const { addManualContact } = require('../contacts');

const SIMULATOR_PHONE = '5218991234567';
const INITIAL_STEP = 'BIENVENIDA';
const publicFolder = path.join(__dirname, '../../public');

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

// --- FUNCIÓN PRINCIPAL DE ENVÍO ---
const sendStepMessage = async (sock, jid, stepId, userData = {}) => {
    console.log(`📤 Enviando paso: ${stepId}`);
    let step = getFlowStep(stepId);
    
    if (!step && stepId === INITIAL_STEP) {
        step = { type: 'menu', message: '¡Hola! Bienvenido.', options: [] };
        await saveFlowStep(INITIAL_STEP, step);
    }
    if (!step) return;

    // Guardar contacto si finaliza
    if (step.type === 'fin_bot') {
        const cleanPhone = jid.replace('@s.whatsapp.net', '').replace('@c.us', '');
        const contactName = userData.history?.nombre || userData.history?.cliente || userData.pushName || 'Cliente Nuevo';
        addManualContact(cleanPhone, contactName, false);
    }

    let messageText = step.message || "";
    
    // 1. Saludo Inteligente
    const mxDate = new Date(new Date().toLocaleString("en-US", {timeZone: "America/Mexico_City"}));
    const hour = mxDate.getHours();
    let saludo = 'Hola';
    if (hour >= 5 && hour < 12) saludo = 'Buenos días';
    else if (hour >= 12 && hour < 19) saludo = 'Buenas tardes';
    else saludo = 'Buenas noches';
    messageText = messageText.replace(/{{saludo}}/gi, saludo);

    // 2. Variables
    if (userData.history) {
        Object.keys(userData.history).forEach(key => {
            const val = userData.history[key] || '';
            messageText = messageText.replace(new RegExp(`{{${key}}}`, 'gi'), val);
            messageText = messageText.replace(new RegExp(`{{${key}_primer}}`, 'gi'), val.split(' ')[0]);
        });
    }
    
    // 3. Menú con Emojis
    if (step.type === 'menu' && step.options) {
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

    // 4. Enviar Media
    let mediaList = Array.isArray(step.media) ? step.media : (step.media ? [step.media] : []);
    let sentImage = false;

    if (mediaList.length > 0) {
        for (let i = 0; i < mediaList.length; i++) {
            const url = mediaList[i];
            const relativePath = url.startsWith('/') ? url.slice(1) : url;
            const finalPath = path.join(publicFolder, relativePath);
            
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

    // 5. Enviar Texto
    if (!sentImage && messageText) {
        await typing(sock, jid, messageText.length);
        try {
            if (esSimulador(jid)) enviarAlFrontend(jid, messageText);
            else await sock.sendMessage(jid, { text: messageText });
        } catch (e) {}
    }

    // 6. Auto-Avance
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

module.exports = { sendStepMessage, esSimulador, enviarAlFrontend };
