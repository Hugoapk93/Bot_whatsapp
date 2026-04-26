const { getUser, updateUser, getFlowStep, getFullFlow } = require('../database');
const { isBotDisabled, addManualContact } = require('../contacts');
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
            await updateUser(dbKey, { current_step: INITIAL_STEP, history: {}, jid: remoteJid, last_active: timestamp });
            user = getUser(dbKey);
            isFlowReset = true;
        } else {
            await updateUser(dbKey, { last_active: timestamp, jid: remoteJid });
        }

        if (user.blocked) return;

        const lastActive = new Date(user.last_active || timestamp).getTime();
        if ((new Date().getTime() - lastActive) / 60000 > MAX_INACTIVE_MINUTES && user.current_step !== INITIAL_STEP) {
            await updateUser(dbKey, { current_step: INITIAL_STEP, history: {} });
            user = getUser(dbKey);
            isFlowReset = true;
        }

        const fullFlow = getFullFlow();

        // 🔥 LA MAGIA: Función centralizada que evalúa el destino ANTES de enviar el mensaje
        const ejecutarTransicion = async (destinoId) => {
            const destConf = getFlowStep(destinoId);
            const isFin = destConf && (destConf.type === 'fin_bot' || destConf.type === 'fin');

            // 1. Guardar el nuevo paso y APAGAR EL BOT en la DB si es el fin
            await updateUser(dbKey, { 
                current_step: destinoId,
                bot_enabled: isFin ? false : undefined 
            });

            const updatedUser = getUser(dbKey);

            // 2. Si aterrizó en el fin, avisar al CRM inmediatamente para apagar el switch visual
            if (isFin) {
                console.log(`🏁 El cliente ${dbKey} aterrizó en el fin. Bot apagado.`);
                addManualContact(dbKey, updatedUser.name || dbKey, false);
                if (global.io) global.io.emit('user_update', { phone: dbKey, bot_enabled: false });
            }

            // 3. Enviar el mensaje del nuevo paso (ya con el bot apagado en memoria)
            await sendStepMessage(sock, remoteJid, destinoId, updatedUser);
        };

        // BÚSQUEDA DE SALTO POR KEYWORD
        let jumpStep = null;
        for (const [sKey, sVal] of Object.entries(fullFlow)) {
            if (sVal.keywords?.some(k => isSimilar(text, k))) {
                jumpStep = sKey;
                break;
            }
        }

        if (jumpStep === user.current_step) jumpStep = null;

        if (jumpStep) {
            const currentConf = getFlowStep(user.current_step);
            if (currentConf?.type === 'filtro') {
                console.log(`🛡️ Keyword ignorada (Filtro)`);
            } else {
                console.log(`🔀 Keyword Salto: ${jumpStep}`);
                await ejecutarTransicion(jumpStep);
                return;
            }
        }

        if (isFlowReset) {
            await ejecutarTransicion(INITIAL_STEP);
            return;
        }

        const currentStepConfig = getFlowStep(user.current_step);
        if (!currentStepConfig) {
            await ejecutarTransicion(INITIAL_STEP);
            return;
        }

        let nextStepId = null;

        switch (currentStepConfig.type) {
            case 'menu': nextStepId = await handleMenuStep(currentStepConfig, text, user, dbKey, remoteJid, sock); break;
            case 'input': nextStepId = await handleInputStep(currentStepConfig, text, user, dbKey, remoteJid, sock); break;
            case 'cita': nextStepId = await handleCitaStep(currentStepConfig, text, user, dbKey, remoteJid, sock, msg); break;
            case 'filtro': break;
            case 'fin_bot':
            case 'fin':
                // Red de seguridad: Si lo forzaron a caer aquí o el caché de app.js falló, apágalo.
                await updateUser(dbKey, { bot_enabled: false });
                addManualContact(dbKey, user.name || dbKey, false);
                if (global.io) global.io.emit('user_update', { phone: dbKey, bot_enabled: false });
                return;
            default: console.warn("Tipo de paso desconocido:", currentStepConfig.type);
        }

        // AVANCE NATURAL AL SIGUIENTE PASO
        if (nextStepId) {
            await ejecutarTransicion(nextStepId);
        }

    } catch (err) {
        console.error("🔥 ERROR CRÍTICO EN FLOW:", err);
    }
};

module.exports = { handleMessage, sendStepMessage };
