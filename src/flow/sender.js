const fs = require('fs');
const path = require('path');
const { getFlowStep, saveFlowStep } = require('../database');
const { addManualContact } = require('../contacts');
const { isBusinessClosed } = require('./agenda');
const { generateWAMessageFromContent, proto } = require('@whiskeysockets/baileys');

const SIMULATOR_PHONE = '5218991234567';
const INITIAL_STEP = 'BIENVENIDA';
const publicFolder = path.resolve(__dirname, '../../public');

const esSimulador = (jid) => jid && jid.includes(SIMULATOR_PHONE);

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
    if (!jid) return; // Validación básica
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

    // --- LOGICA DE BOTONES (HYDRATED TEMPLATE) ---
    // Esta es la estructura clásica que usan los bots oficiales
    let useButtons = (step.type === 'menu' && step.options && step.options.length > 0);
    
    // 🔥 MODO PRUEBA DE BOTONES (Si quieres probar botones dummy, cambia a true)
    const FORCE_TEST = true; 

    let buttons = [];
    if (useButtons) {
        if (FORCE_TEST && !esSimulador(jid)) {
            console.log("⚠️ Usando Botones Dummy (Hydrated)");
            buttons = [
                { index: 1, quickReplyButton: { displayText: 'Prueba SI', id: 'si' } },
                { index: 2, quickReplyButton: { displayText: 'Prueba NO', id: 'no' } }
            ];
            messageText += "\n(Modo Prueba)";
        } else {
            // Mapeamos tus opciones reales a la estructura Hydrated
            buttons = step.options.map((opt, index) => ({
                index: index + 1,
                quickReplyButton: {
                    displayText: opt.label.substring(0, 20),
                    id: opt.trigger || opt.label
                }
            }));
        }
    }

    // Imágenes
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

    // --- ENVÍO FINAL ---
    if (!sentImage) { 
        if (esSimulador(jid)) {
            enviarAlFrontend(jid, messageText + (useButtons ? " [BOTONES]" : ""));
        } else {
            if (useButtons) {
                console.log(`🔘 Generando Template Message para: ${jid}`);
                
                // 🔥 ESTRUCTURA ESPÍA (Hydrated Template)
                // Usamos viewOnceMessage envolviendo un templateMessage.
                // Esta combinación suele saltarse filtros de "Media Type".
                const msg = generateWAMessageFromContent(jid, {
                    viewOnceMessage: {
                        message: {
                            templateMessage: {
                                hydratedTemplate: {
                                    hydratedContentText: messageText,
                                    hydratedFooterText: "Selecciona una opción",
                                    hydratedButtons: buttons
                                }
                            }
                        }
                    }
                }, { userJid: sock.user.id });

                try {
                    await sock.relayMessage(jid, msg.message, { messageId: msg.key.id });
                    console.log(`✅ Template Relay OK. ID: ${msg.key.id}`);
                } catch (relayError) {
                    console.error("❌ Falló relay:", relayError);
                }

            } else {
                await sock.sendMessage(jid, { text: messageText });
            }
        }
    }

    // Auto-avance
    if (step.type === 'filtro' && isClosed) return;
    if (step.type === 'message' && step.next_step && step.next_step !== stepId) {
        setTimeout(async () => {
             const { updateUser } = require('../database');
             await updateUser(userData.phone, { current_step: step.next_step });
             sendStepMessage(sock, jid, step.next_step, userData); 
        }, 1500);
    }
};

module.exports = { sendStepMessage, esSimulador, enviarAlFrontend };
