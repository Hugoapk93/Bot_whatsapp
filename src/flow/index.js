const { getUser, updateUser, getFlowStep, getFullFlow } = require('../database');
const { isBotDisabled } = require('../contacts');
const { isSimilar, analyzeNaturalLanguage } = require('./utils');
const { validateBusinessRules, checkAvailability, bookAppointment, isDateInPast } = require('./agenda');
const { sendStepMessage, esSimulador, enviarAlFrontend } = require('./sender');

const INITIAL_STEP = 'BIENVENIDA';
const MAX_INACTIVE_MINUTES = 2880;

const handleMessage = async (sock, msg) => {
    const remoteJid = msg.key.remoteJid;
    if (isBotDisabled(remoteJid) || remoteJid.includes('@g.us')) return;

    const text = (msg.message?.conversation || msg.message?.extendedTextMessage?.text || '').trim();
    if (!text) return;

    let incomingPhone = remoteJid.split('@')[0].replace(/:[0-9]+/, '');
    if (incomingPhone.startsWith('52') && incomingPhone.length === 12) incomingPhone = '521' + incomingPhone.slice(2);
    
    let user = getUser(incomingPhone);
    const dbKey = incomingPhone;
    const timestamp = new Date().toISOString();

    if (!user?.phone) {
        console.log(`✨ Nuevo usuario: ${dbKey}`);
        await updateUser(dbKey, { current_step: INITIAL_STEP, history: {}, jid: remoteJid, last_active: timestamp });
        user = getUser(dbKey);

        // 🔥 DEEP LINKING: Redirige a Monitor
        if (global.sendPushNotification) {
             global.sendPushNotification(
                 "🔔 Nuevo Cliente", 
                 `El número ${dbKey} inició conversación.`,
                 "/#activity" 
             );
        }

    } else {
        await updateUser(dbKey, { last_active: timestamp, jid: remoteJid });
    }
    if (user.blocked) return;

    const lastActive = new Date(user.last_active || timestamp).getTime();
    if ((new Date().getTime() - lastActive) / 60000 > MAX_INACTIVE_MINUTES && user.current_step !== INITIAL_STEP) {
        await updateUser(dbKey, { current_step: INITIAL_STEP, history: {} });
        user = getUser(dbKey);
    }

    // --- CEREBRO ---
    
    // 1. Keywords Globales
    const fullFlow = getFullFlow();
    let jumpStep = null;
    for (const [sKey, sVal] of Object.entries(fullFlow)) {
        if (sVal.keywords?.some(k => isSimilar(text, k))) {
            jumpStep = sKey;
            break;
        }
    }
    if (jumpStep) {
        console.log(`🔀 Keyword: ${jumpStep}`);
        await updateUser(dbKey, { current_step: jumpStep });
        await sendStepMessage(sock, remoteJid, jumpStep, user);
        return;
    }

    // 2. Procesar Paso Actual
    const currentStepConfig = getFlowStep(user.current_step);
    if (!currentStepConfig) {
        await updateUser(dbKey, { current_step: INITIAL_STEP });
        return;
    }

    let nextStepId = null;

    if (currentStepConfig.type === 'menu') {
        const index = parseInt(text) - 1;
        let match = currentStepConfig.options?.[index];
        if (!match) {
            match = currentStepConfig.options?.find(opt => isSimilar(text, opt.trigger) || isSimilar(text, opt.label));
        }

        if (match) {
            nextStepId = match.next_step;
        } else {
            const txt = `⚠️ No entendí esa opción.\nPor favor escribe el número o el nombre de la opción.`;
            if(esSimulador(remoteJid)) enviarAlFrontend(remoteJid, txt); else await sock.sendMessage(remoteJid, { text: txt });
            return;
        }
    }

    else if (currentStepConfig.type === 'input') {
        const varName = currentStepConfig.save_var || 'temp';
        user.history[varName] = text;
        await updateUser(dbKey, { history: user.history });
        nextStepId = currentStepConfig.next_step;
    }

    else if (currentStepConfig.type === 'filtro') {
        return; 
    }

    else if (currentStepConfig.type === 'cita' || nextStepId) { 
        
        let targetStep = nextStepId || user.current_step;
        const targetStepConfig = getFlowStep(targetStep);

        if (targetStepConfig && targetStepConfig.type === 'cita') {
            
            console.log(`🧠 Analizando Cita: "${text}"`);
            const analysis = analyzeNaturalLanguage(text);
            
            if (analysis.date) {
                user.history['fecha'] = analysis.date;
                if (!analysis.time) {
                    delete user.history['hora']; 
                }
            }
            if (analysis.time) user.history['hora'] = analysis.time; 

            await updateUser(dbKey, { history: user.history });
            
            const fechaMemoria = user.history['fecha'];
            const horaMemoria = user.history['hora'];

            if (!fechaMemoria) {
                const txt = "📅 ¿Para qué día te gustaría agendar? (Ej: Mañana, El viernes)";
                if(esSimulador(remoteJid)) enviarAlFrontend(remoteJid, txt); else await sock.sendMessage(remoteJid, { text: txt });
                return; 
            }

            if (!horaMemoria) {
                const txt = `Perfecto para el ${fechaMemoria}. 🕒 ¿A qué hora? (Ej: 4pm, 10:30)`;
                if(esSimulador(remoteJid)) enviarAlFrontend(remoteJid, txt); else await sock.sendMessage(remoteJid, { text: txt });
                return; 
            }

            if (isDateInPast(fechaMemoria, horaMemoria)) {
                const txt = `⚠️ La fecha ${fechaMemoria} a las ${horaMemoria} ya pasó.\nPor favor indica una fecha y hora futura.`;
                if(esSimulador(remoteJid)) enviarAlFrontend(remoteJid, txt); else await sock.sendMessage(remoteJid, { text: txt });
                delete user.history['hora'];
                await updateUser(dbKey, { history: user.history });
                return;
            }

            const rules = validateBusinessRules(horaMemoria);
            if (!rules.valid) {
                const s = rules.settings?.schedule;
                const txt = `⚠️ ${rules.reason}\nHorario: ${s?.start || '9:00'} - ${s?.end || '18:00'}`;
                if(esSimulador(remoteJid)) enviarAlFrontend(remoteJid, txt); else await sock.sendMessage(remoteJid, { text: txt });
                delete user.history['hora']; 
                await updateUser(dbKey, { history: user.history });
                return;
            }

            if (!checkAvailability(fechaMemoria, horaMemoria)) {
                const txt = `❌ Horario ${horaMemoria} ocupado. ¿Otra hora?`;
                if(esSimulador(remoteJid)) enviarAlFrontend(remoteJid, txt); else await sock.sendMessage(remoteJid, { text: txt });
                delete user.history['hora'];
                await updateUser(dbKey, { history: user.history });
                return;
            }

            const finalName = user.history['nombre'] || msg.pushName || 'Cliente';
            bookAppointment(fechaMemoria, horaMemoria, dbKey, finalName);
            console.log("🎉 Cita guardada.");

            // 🔥 DEEP LINKING: Redirige a Agenda
            if (global.sendPushNotification) {
                global.sendPushNotification(
                    "📅 Nueva Cita Agendada", 
                    `Cliente: ${finalName} (${dbKey})\nFecha: ${fechaMemoria}\nHora: ${horaMemoria}`,
                    "/#agenda"
                );
            }

            if (targetStepConfig.next_step) {
                nextStepId = targetStepConfig.next_step;
            } else {
                const txt = `✅ ¡Listo! Agendado el *${fechaMemoria}* a las *${horaMemoria}*.`;
                if(esSimulador(remoteJid)) enviarAlFrontend(remoteJid, txt); else await sock.sendMessage(remoteJid, { text: txt });
                return;
            }
        }
    }

    if (nextStepId) {
        await updateUser(dbKey, { current_step: nextStepId });
        await sendStepMessage(sock, remoteJid, nextStepId, getUser(dbKey));
    }
};

module.exports = { handleMessage, sendStepMessage };
