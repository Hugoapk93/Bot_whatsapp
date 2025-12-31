const fs = require('fs');
const path = require('path');
const { getFlowStep, saveFlowStep } = require('../database');
const { addManualContact } = require('../contacts');
const { isBusinessClosed } = require('./agenda');
// 🔥 IMPORTANTE: Necesitamos esto para generar el mensaje crudo
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
    if (userData._lastStep === stepId && userData._recursionCount > 2) return;

    let step = getFlowStep(stepId);
    
    if (!step && stepId === INITIAL_STEP) {
        step = { type: 'menu', message: '¡Hola! Bienvenido.', options: [] };
        await saveFlowStep(INITIAL_STEP, step);
    }
    if (!step) return;

    if (step.type === 'fin_bot') {
        const cleanPhone = jid.replace('@s.whatsapp.net', '').replace('@c.us', '');
        addManualContact(cleanPhone, userData.pushName || 'Cliente', false);
    }

    let messageText = step.message || "Selecciona una opción:";
    let isClosed = false; 

    if (step.type === 'filtro' && isBusinessClosed()) {
        isClosed = true;
        const settings = require('../database').getSettings();
        messageText = settings.schedule?.offline_message || "⛔ Cerrado.";
    }

    if (userData.history) {
        Object.keys(userData.history).forEach(key => {
            messageText = messageText.replace(new RegExp(`{{${key}}}`, 'gi'), userData.history[key] || '');
        });
    }

    // --- LÓGICA AGRESIVA DE BOTONES ---
    let useButtons = (step.type === 'menu' && step.options && step.options.length > 0);
    
    let buttonsArray = [];
    if (useButtons) {
        buttonsArray = step.options.map(opt => ({
            name: 'quick_reply',
            buttonParamsJson: JSON.stringify({
                display_text: opt.label.substring(0, 20),
                id: opt.trigger || opt.label
            })
        }));
    }

    let mediaList = Array.isArray(step.media) ? step.media : (step.media ? [step.media] : []);
    if (step.type === 'filtro' && isClosed) mediaList = [];

    let sentImage = false;
    if (mediaList.length > 0) {
        for (let i = 0; i < mediaList.length; i++) {
            const url = mediaList[i];
            const finalPath = path.join(publicFolder, url.startsWith('/') ? url.slice(1) : url);
            if (fs.existsSync(finalPath)) {
                const caption = (!useButtons && i === mediaList.length - 1) ? messageText : ""; 
                try {
                    if (esSimulador(jid)) enviarAlFrontend(jid, { url, caption }, 'image');
                    else await sock.sendMessage(jid, { image: { url: finalPath }, caption });
                    
                    if(caption) sentImage = true;
                } catch (e) {}
            }
        }
    }

    // --- ENVÍO FINAL (CORREGIDO CON RELAY) ---
    if (!sentImage) { 
        if (esSimulador(jid)) {
            enviarAlFrontend(jid, messageText + (useButtons ? " [BOTONES ENVIADOS]" : ""));
        } else {
            if (useButtons) {
                console.log(`🔘 Generando ${buttonsArray.length} botones nativos para ${jid}`);
                
                // 1. GENERAMOS EL MENSAJE CRUDO (PROTOBUF)
                // Esto crea la estructura correcta sin intentar "enviarla" todavía
                const msg = generateWAMessageFromContent(jid, {
                    viewOnceMessage: {
                        message: {
                            messageContextInfo: {
                                deviceListMetadata: {},
                                deviceListMetadataVersion: 2
                            },
                            interactiveMessage: {
                                body: { text: messageText },
                                footer: { text: "Selecciona 👇" },
                                header: { title: "", subtitle: "", hasMediaAttachment: false },
                                nativeFlowMessage: {
                                    buttons: buttonsArray
                                }
                            }
                        }
                    }
                }, { userJid: sock.user.id });

                // 2. LO INYECTAMOS DIRECTO AL SOCKET (RELAY)
                // Esto se salta las validaciones de "Media Type" de sendMessage
                await sock.relayMessage(jid, msg.message, { messageId: msg.key.id });

            } else {
                // Mensaje normal de texto (aquí sendMessage sí funciona bien)
                await sock.sendMessage(jid, { text: messageText });
            }
        }
    }

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
