const fs = require('fs');
const path = require('path');
const { getFlowStep, saveFlowStep } = require('../database');
const { addManualContact } = require('../contacts');
const { isBusinessClosed } = require('./agenda');
// 🔥 IMPORTANTE: Necesario para los botones nativos
const { generateWAMessageFromContent } = require('@whiskeysockets/baileys');

const SIMULATOR_PHONE = '5218991234567';
const INITIAL_STEP = 'BIENVENIDA';
const publicFolder = path.resolve(__dirname, '../../public');

const esSimulador = (jid) => jid.includes(SIMULATOR_PHONE);

const enviarAlFrontend = (jid, contenido, type = 'text') => {
    if (global.io) {
        const textPayload = (typeof contenido === 'string' ? contenido : (contenido.caption || '')).replace(/\n/g, '<br>');
        global.io.emit('message', {
            to: jid,
            message: contenido, 
            text: textPayload,
            type: (typeof contenido === 'string' && type !== 'image') ? 'text' : 'image',
            fromMe: true
        });
    }
};

const typing = async (sock, jid, length) => {
    if (esSimulador(jid)) return;
    try {
        await sock.sendPresenceUpdate('composing', jid);
        await new Promise(r => setTimeout(r, 500)); 
        await sock.sendPresenceUpdate('paused', jid);
    } catch(e) { }
};

const sendStepMessage = async (sock, jid, stepId, userData = {}) => {
    // Evitar bucles
    if (userData._lastStep === stepId && userData._recursionCount > 2) return;

    let step = getFlowStep(stepId);
    
    // Auto-reparación paso inicial
    if (!step && stepId === INITIAL_STEP) {
        step = { type: 'menu', message: '¡Hola! Bienvenido.', options: [] };
        await saveFlowStep(INITIAL_STEP, step);
    }
    if (!step) return;

    // Guardar contacto
    if (step.type === 'fin_bot') {
        const cleanPhone = jid.replace('@s.whatsapp.net', '').replace('@c.us', '');
        addManualContact(cleanPhone, userData.pushName || 'Cliente', false);
    }

    let messageText = step.message || "Selecciona una opción:";
    let isClosed = false; 

    // Validar Horario
    if (step.type === 'filtro' && isBusinessClosed()) {
        isClosed = true;
        const settings = require('../database').getSettings();
        messageText = settings.schedule?.offline_message || "⛔ Cerrado.";
    }

    // Reemplazo de variables
    if (userData.history) {
        Object.keys(userData.history).forEach(key => {
            messageText = messageText.replace(new RegExp(`{{${key}}}`, 'gi'), userData.history[key] || '');
        });
    }

    // --- PREPARACIÓN DE BOTONES REALES ---
    let useButtons = (step.type === 'menu' && step.options && step.options.length > 0);
    let buttonsArray = [];
    
    if (useButtons) {
        buttonsArray = step.options.map(opt => ({
            name: 'quick_reply',
            buttonParamsJson: JSON.stringify({
                display_text: opt.label.substring(0, 20), // WhatsApp corta si es muy largo
                id: opt.trigger || opt.label
            })
        }));
    }

    // ============================================================
    // 🔥 MODO PRUEBA (DUMMY BUTTONS) - ELIMINAR DESPUÉS
    // ============================================================
    // Si esta variable es TRUE, forzamos el envío de botones de prueba
    const FORCE_DUMMY_TEST = true; 

    if (FORCE_DUMMY_TEST && !esSimulador(jid)) {
        console.log("⚠️ ATENCIÓN: Enviando botones DUMMY de prueba (ignorando los reales)");
        useButtons = true;
        messageText += "\n\n(Botones de Prueba Activados)";
        buttonsArray = [
            {
                name: 'quick_reply',
                buttonParamsJson: JSON.stringify({
                    display_text: "Prueba A ✅",
                    id: "dummy_a"
                })
            },
            {
                name: 'quick_reply',
                buttonParamsJson: JSON.stringify({
                    display_text: "Prueba B ❌",
                    id: "dummy_b"
                })
            }
        ];
    }
    // ============================================================

    // Manejo de Imágenes
    let mediaList = Array.isArray(step.media) ? step.media : (step.media ? [step.media] : []);
    if (step.type === 'filtro' && isClosed) mediaList = [];

    let sentImage = false;
    if (mediaList.length > 0) {
        for (let i = 0; i < mediaList.length; i++) {
            const url = mediaList[i];
            const finalPath = path.join(publicFolder, url.startsWith('/') ? url.slice(1) : url);
            if (fs.existsSync(finalPath)) {
                // Si usamos botones, mandamos la imagen sola primero
                const caption = (!useButtons && i === mediaList.length - 1) ? messageText : ""; 
                try {
                    if (esSimulador(jid)) enviarAlFrontend(jid, { url, caption }, 'image');
                    else await sock.sendMessage(jid, { image: { url: finalPath }, caption });
                    
                    if(caption) sentImage = true;
                } catch (e) {}
            }
        }
    }

    // --- ENVÍO FINAL ---
    if (!sentImage) { 
        if (esSimulador(jid)) {
            enviarAlFrontend(jid, messageText + (useButtons ? " [BOTONES]" : ""));
        } else {
            if (useButtons) {
                console.log(`🔘 Generando mensaje interactivo para: ${jid}`);
                
                // 1. GENERAMOS EL MENSAJE (Estructura Limpia sin viewOnce)
                const msg = generateWAMessageFromContent(jid, {
                    interactiveMessage: {
                        body: { text: messageText },
                        footer: { text: "Selecciona 👇" },
                        header: { title: "", subtitle: "", hasMediaAttachment: false },
                        nativeFlowMessage: {
                            buttons: buttonsArray,
                            messageParamsJson: ""
                        }
                    }
                }, { userJid: sock.user.id });

                // 2. INYECTAMOS (RELAY)
                try {
                    await sock.relayMessage(jid, msg.message, { messageId: msg.key.id });
                    console.log(`✅ Relay Exitoso. ID: ${msg.key.id}`);
                } catch (relayError) {
                    console.error("❌ Falló el sock.relayMessage:", relayError);
                }

            } else {
                // Mensaje normal
                await sock.sendMessage(jid, { text: messageText });
            }
        }
    }

    // Auto-avance
    if (step.type === 'filtro' && isClosed) return;
    if (step.type === 'message' && step.next_step && step.next_step !== stepId) {
        setTimeout(async () => {
             const { updateUser, getUser } = require('../database');
             await updateUser(userData.phone, { current_step: step.next_step });
             await sendStepMessage(sock, jid, step.next_step, userData);
        }, 1500);
    }
};

module.exports = { sendStepMessage, esSimulador, enviarAlFrontend };
