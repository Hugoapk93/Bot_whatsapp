const { updateUser, getUser } = require('../database');
const { analyzeNaturalLanguage } = require('./utils');
const { sendStepMessage, esSimulador, enviarAlFrontend } = require('./sender');
const { validateBusinessRules, checkAvailability, bookAppointment, isDateInPast, friendlyDate } = require('./agenda');
const { isValidName, isValidBirthDate } = require('./validators');

const basicClean = (str) => {
    if (!str) return "";
    return str.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
};

async function handleMenuStep(stepConfig, text, remoteJid, sock) {
    const userText = basicClean(text);
    const isNumber = /^[0-9]+$/.test(userText);
    
    if (isNumber) {
        const index = parseInt(userText) - 1;
        if (stepConfig.options && stepConfig.options[index]) {
            return stepConfig.options[index].next_step;
        }
    }

    if (stepConfig.options && Array.isArray(stepConfig.options)) {
        const userWords = userText.split(' ').filter(w => w.length > 1); 
        
        if (userWords.length > 0) {
            const matches = stepConfig.options.filter(opt => {
                const optLabel = basicClean(opt.label);
                const optTrigger = basicClean(opt.trigger || "");
                return userWords.every(word => optLabel.includes(word) || optTrigger.includes(word));
            });

            if (matches.length === 1) {
                return matches[0].next_step;
            }

            if (matches.length > 1) {
                const suggestions = matches.map(m => `"${m.label}"`).join(' o ');
                const txt = `⚠️ Varias opciones con esa palabra.\n\nCual quieres elegir:\n ${suggestions}`;

                if (esSimulador(remoteJid)) enviarAlFrontend(remoteJid, txt); 
                else await sock.sendMessage(remoteJid, { text: txt });
                
                return null; 
            }
        }
    }

    const txt = `⚠️ Opción no válida.\nEscribe el número o el nombre de la opción.`;
    if (esSimulador(remoteJid)) enviarAlFrontend(remoteJid, txt); 
    else await sock.sendMessage(remoteJid, { text: txt });
    
    return null;
}

async function handleInputStep(stepConfig, text, user, dbKey, remoteJid, sock) {
    const varName = stepConfig.save_var || 'temp';

    if (varName === 'nombre' && !isValidName(text)) {
        const txt = "⚠️ Error.\n\nPor favor escribe solo tu nombre completo.";
        if (esSimulador(remoteJid)) enviarAlFrontend(remoteJid, txt); 
        else await sock.sendMessage(remoteJid, { text: txt });
        return null;
    }

    if (varName === 'fecha_nacimiento' && !isValidBirthDate(text)) {
        const txt = "⚠️ Fecha incorrecta.\nPor favor escribe tu fecha así: \n\nDD/MM/AAAA \n(Ej: 02/07/1984)";
        if (esSimulador(remoteJid)) enviarAlFrontend(remoteJid, txt); 
        else await sock.sendMessage(remoteJid, { text: txt });
        return null; 
    }

    if (!user.history) user.history = {};

    user.history[varName] = text;
    await updateUser(dbKey, { history: user.history });
    
    return stepConfig.next_step;
}

async function handleCitaStep(stepConfig, text, user, dbKey, remoteJid, sock, msg) {
    console.log(`🧠 Analizando Cita: "${text}"`);
    const analysis = analyzeNaturalLanguage(text);

    if (!user.history) user.history = {};

    if (analysis.date) {
        user.history['fecha'] = analysis.date;
        if (!analysis.time) delete user.history['hora'];
    }

    if (analysis.time) user.history['hora'] = analysis.time;

    await updateUser(dbKey, { history: user.history });

    let fechaMemoria = user.history['fecha'];
    let horaMemoria = user.history['hora'];

    if (fechaMemoria) {
        const formatter = new Intl.DateTimeFormat("en-CA", { 
            timeZone: "America/Matamoros", year: 'numeric', month: '2-digit', day: '2-digit' 
        });
        const hoyStr = formatter.format(new Date());

        if (fechaMemoria < hoyStr) {
            console.log(`⚠️ Fecha vieja detectada (${fechaMemoria}). Limpiando memoria...`);
            delete user.history['fecha'];
            delete user.history['hora'];
            await updateUser(dbKey, { history: user.history });
            fechaMemoria = null; 
            horaMemoria = null;
        }
    }

    if (!fechaMemoria) {
        const txt = "📅 ¿Para qué día te gustaría agendar?";
        if (esSimulador(remoteJid)) enviarAlFrontend(remoteJid, txt);
        else await sock.sendMessage(remoteJid, { text: txt });
        return null;
    }

    if (!horaMemoria) {
        const txt = `Perfecto, para el *${friendlyDate(fechaMemoria)}*.\n¿A qué hora puedes venir?`;
        if (esSimulador(remoteJid)) enviarAlFrontend(remoteJid, txt);
        else await sock.sendMessage(remoteJid, { text: txt });
        return null;
    }

    if (isDateInPast(fechaMemoria, horaMemoria)) {
        const txt = "⚠️ Fecha pasada. \nIndica una futura.";
        if (esSimulador(remoteJid)) enviarAlFrontend(remoteJid, txt);
        else await sock.sendMessage(remoteJid, { text: txt });
        delete user.history['hora'];
        await updateUser(dbKey, { history: user.history });
        return null;
    }

    const rules = validateBusinessRules(horaMemoria);
    if (!rules.valid) {
        if (esSimulador(remoteJid)) enviarAlFrontend(remoteJid, rules.reason);
        else await sock.sendMessage(remoteJid, { text: rules.reason });
        delete user.history['hora'];
        await updateUser(dbKey, { history: user.history });
        return null;
    }

    const isAvailable = await checkAvailability(fechaMemoria, horaMemoria);
    if (!isAvailable) {
        const txt = `❌ Horario ocupado.`;
        if (esSimulador(remoteJid)) enviarAlFrontend(remoteJid, txt);
        else await sock.sendMessage(remoteJid, { text: txt });
        delete user.history['hora'];
        await updateUser(dbKey, { history: user.history });
        return null;
    }

    const finalName = user.history['nombre'] || msg.pushName || 'Cliente';
    await bookAppointment(fechaMemoria, horaMemoria, dbKey, finalName);

    if (global.sendPushNotification) {
        global.sendPushNotification("📅 Nueva Cita", `Cliente: ${finalName}`, "/#agenda");
    }

    if (stepConfig.next_step) {
        return stepConfig.next_step; 
    } else {
        const txt = `✅ Cita confirmada: ${friendlyDate(fechaMemoria)} a las ${horaMemoria}`;
        if (esSimulador(remoteJid)) enviarAlFrontend(remoteJid, txt);
        else await sock.sendMessage(remoteJid, { text: txt });
        return null;
    }
}

module.exports = { handleMenuStep, handleInputStep, handleCitaStep };
