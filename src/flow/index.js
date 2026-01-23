const { getUser, updateUser, getFlowStep, getFullFlow } = require('../database');
const { isBotDisabled } = require('../contacts');
const { isSimilar, normalizeText } = require('./utils'); // Ya no necesitamos tantas cosas aquí
const { sendStepMessage, esSimulador, enviarAlFrontend } = require('./sender');

// 🔥 IMPORTAMOS LOS MÓDULOS NUEVOS
const { handleMenuStep, handleInputStep, handleCitaStep } = require('./handlers');

const INITIAL_STEP = 'BIENVENIDA';
const MAX_INACTIVE_MINUTES = 2880;

const handleMessage = async (sock, msg) => {
    try {
        const remoteJid = msg.key.remoteJid;
        if (isBotDisabled(remoteJid) || remoteJid.includes('@g.us')) return;

        // Detección de interactivos (Logs)
        if (msg.message?.viewOnceMessage || msg.message?.buttonsMessage) {
            console.log("🕵️ Mensaje Interactivo detectado");
        }

        const text = (msg.message?.conversation || msg.message?.extendedTextMessage?.text || '').trim();
        if (!text) return;

        // --- PREPARACIÓN DE USUARIO ---
        let incomingPhone = remoteJid.split('@')[0].replace(/:[0-9]+/, '');
        if (incomingPhone.startsWith('52') && incomingPhone.length === 12) incomingPhone = '521' + incomingPhone.slice(2);
        
        const dbKey = incomingPhone;
        let user = getUser(dbKey);
        const timestamp = new Date().toISOString();
        let isFlowReset = false;

        // Lógica de creación / actualización
        if (!user?.phone) {
            console.log(`✨ Nuevo usuario: ${dbKey}`);
            await updateUser(dbKey, { current_step: INITIAL_STEP, history: {}, jid: remoteJid, last_active: timestamp });
            user = getUser(dbKey);
            isFlowReset = true;
            // (Opcional: Dejamos la notificación de nuevo usuario o la quitamos si la de abajo es suficiente)
        } else {
            await updateUser(dbKey, { last_active: timestamp, jid: remoteJid });
        }

        if (user.blocked) return;

        // =================================================================
        // 🔥 AQUÍ AGREGAMOS LA NOTIFICACIÓN PUSH PARA TODOS LOS MENSAJES
        // =================================================================
        if (global.sendPushNotification) {
            // Usamos el nombre guardado si existe, si no, el número
            const clientName = user.history?.nombre || user.history?.cliente || user.history?.name || dbKey;
            
            // Usamos el enlace directo al chat que creamos antes
            const targetUrl = `/#activity?chat=${dbKey}`;

            global.sendPushNotification(
                `💬 ${clientName}`,  // Título: Nombre del cliente
                text,                // Cuerpo: El mensaje que escribió
                targetUrl            // Link: Abre directo el chat
            );
        }
        // =================================================================

        // Reset por Inactividad
        const lastActive = new Date(user.last_active || timestamp).getTime();
        if ((new Date().getTime() - lastActive) / 60000 > MAX_INACTIVE_MINUTES && user.current_step !== INITIAL_STEP) {
            await updateUser(dbKey, { current_step: INITIAL_STEP, history: {} });
            user = getUser(dbKey);
            isFlowReset = true;
        }

        // --- 1. KEYWORDS GLOBALES (Saltos) ---
        const fullFlow = getFullFlow();
        let jumpStep = null;
        for (const [sKey, sVal] of Object.entries(fullFlow)) {
            if (sVal.keywords?.some(k => isSimilar(text, k))) {
                jumpStep = sKey;
                break;
            }
        }
        if (jumpStep) {
            const currentConf = getFlowStep(user.current_step);
            if (currentConf?.type === 'filtro') {
                console.log(`🛡️ Keyword ignorada (Filtro)`);
            } else {
                console.log(`🔀 Keyword Salto: ${jumpStep}`);
                await updateUser(dbKey, { current_step: jumpStep });
                await sendStepMessage(sock, remoteJid, jumpStep, user);
                return;
            }
        }

        if (isFlowReset) {
            await sendStepMessage(sock, remoteJid, INITIAL_STEP, user);
            return;
        }

        // --- 2. DELEGACIÓN DE TAREAS (MÓDULOS) ---
        const currentStepConfig = getFlowStep(user.current_step);
        if (!currentStepConfig) {
            await updateUser(dbKey, { current_step: INITIAL_STEP });
            await sendStepMessage(sock, remoteJid, INITIAL_STEP, user);
            return;
        }

        let nextStepId = null;

        // 🔥 AQUÍ ESTÁ LA MAGIA MODULAR 🔥
        switch (currentStepConfig.type) {
            case 'menu': nextStepId = await handleMenuStep(currentStepConfig, text, remoteJid, sock); break;
            case 'input': nextStepId = await handleInputStep(currentStepConfig, text, user, dbKey, remoteJid, sock); break;
            case 'cita': nextStepId = await handleCitaStep(currentStepConfig, text, user, dbKey, remoteJid, sock, msg); break;
            case 'filtro': break;
            default: console.warn("Tipo de paso desconocido:", currentStepConfig.type);
        }

        // --- 3. TRANSICIÓN ---
        if (nextStepId) {
            await updateUser(dbKey, { current_step: nextStepId });
            await sendStepMessage(sock, remoteJid, nextStepId, getUser(dbKey));
        }

    } catch (err) {
        console.error("🔥 ERROR CRÍTICO EN FLOW:", err);
    }
};

module.exports = { handleMessage, sendStepMessage };
