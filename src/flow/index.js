const { getUser, updateUser, getFlowStep, getFullFlow } = require('../database');
const { isBotDisabled } = require('../contacts');
const { isSimilar, normalizeText } = require('./utils');
const { sendStepMessage, esSimulador, enviarAlFrontend } = require('./sender');

const { handleMenuStep, handleInputStep, handleCitaStep } = require('./handlers');

const INITIAL_STEP = 'BIENVENIDA';
const MAX_INACTIVE_MINUTES = 2880;

const handleMessage = async (sock, msg) => {
    try {
        const remoteJid = msg.key.remoteJid;
        if (isBotDisabled(remoteJid) || remoteJid.includes('@g.us')) return;

        if (msg.message?.viewOnceMessage || msg.message?.buttonsMessage) {
            console.log("🕵️ Mensaje Interactivo detectado");
        }

        const text = (msg.message?.conversation || msg.message?.extendedTextMessage?.text || '').trim();
        if (!text) return;

        let incomingPhone = remoteJid.split('@')[0].replace(/:[0-9]+/, '');
        if (incomingPhone.startsWith('52') && incomingPhone.length === 12) incomingPhone = '521' + incomingPhone.slice(2);
        
        const dbKey = incomingPhone;
        let user = getUser(dbKey);
        const timestamp = new Date().toISOString();
        let isFlowReset = false;

        if (!user?.phone) {
            console.log(`✨ Nuevo usuario: ${dbKey}`);
            await updateUser(dbKey, { current_step: INITIAL_STEP, history: {}, jid: remoteJid, last_active: timestamp });
            user = getUser(dbKey);
            isFlowReset = true;
        } else {
            await updateUser(dbKey, { last_active: timestamp, jid: remoteJid });
        }

        if (user.blocked) return;

        // 🔥 ELIMINAMOS EL BLOQUE DE NOTIFICACIÓN PUSH CONSTANTE DE AQUÍ 🔥

        const lastActive = new Date(user.last_active || timestamp).getTime();
        if ((new Date().getTime() - lastActive) / 60000 > MAX_INACTIVE_MINUTES && user.current_step !== INITIAL_STEP) {
            await updateUser(dbKey, { current_step: INITIAL_STEP, history: {} });
            user = getUser(dbKey);
            isFlowReset = true;
        }

        const fullFlow = getFullFlow();
        let jumpStep = null;
        for (const [sKey, sVal] of Object.entries(fullFlow)) {
            if (sVal.keywords?.some(k => isSimilar(text, k))) {
                jumpStep = sKey;
                break;
            }
        }

        if (jumpStep === user.current_step) {
            jumpStep = null;
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

        const currentStepConfig = getFlowStep(user.current_step);
        if (!currentStepConfig) {
            await updateUser(dbKey, { current_step: INITIAL_STEP });
            await sendStepMessage(sock, remoteJid, INITIAL_STEP, user);
            return;
        }

        let nextStepId = null;

        // 🔥 AQUÍ ESTÁ EL CAMBIO CRUCIAL: Se agregaron "user, dbKey" al handleMenuStep 🔥
        switch (currentStepConfig.type) {
            case 'menu': nextStepId = await handleMenuStep(currentStepConfig, text, user, dbKey, remoteJid, sock); break;
            case 'input': nextStepId = await handleInputStep(currentStepConfig, text, user, dbKey, remoteJid, sock); break;
            case 'cita': nextStepId = await handleCitaStep(currentStepConfig, text, user, dbKey, remoteJid, sock, msg); break;
            case 'filtro': break;
            default: console.warn("Tipo de paso desconocido:", currentStepConfig.type);
        }

        if (nextStepId) {
            await updateUser(dbKey, { current_step: nextStepId });
            await sendStepMessage(sock, remoteJid, nextStepId, getUser(dbKey));
        }

    } catch (err) {
        console.error("🔥 ERROR CRÍTICO EN FLOW:", err);
    }
};

module.exports = { handleMessage, sendStepMessage };
