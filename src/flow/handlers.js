const { updateUser, getUser } = require('../database');
const { normalizeText, isSimilar, analyzeNaturalLanguage } = require('./utils');
const { sendStepMessage, esSimulador, enviarAlFrontend } = require('./sender');
const { validateBusinessRules, checkAvailability, bookAppointment, isDateInPast, friendlyDate } = require('./agenda');
const { isValidName } = require('./validators');
const { isValidName, isValidBirthDate } = require('./validators'); 

// --- MANEJADOR DE MENÚS ---
async function handleMenuStep(stepConfig, text, remoteJid, sock) {
    const userClean = normalizeText(text);
    let match = null;

    // 1. Por Número
    const index = parseInt(text) - 1;
    if (!isNaN(index) && stepConfig.options?.[index]) {
        match = stepConfig.options[index];
    }
    // 2. Por Texto Exacto
    if (!match) {
        match = stepConfig.options?.find(opt =>
            isSimilar(text, opt.trigger) || isSimilar(text, opt.label)
        );
    }
    // 3. Por Texto Parcial
    if (!match && stepConfig.options) {
        const matchesFound = stepConfig.options.filter(opt => {
            const btnText = normalizeText(opt.label);
            return (btnText.includes(userClean) && userClean.length > 3);
        });

        if (matchesFound.length === 1) match = matchesFound[0];
        else if (matchesFound.length > 1) {
            const txt = `🤔 Tu respuesta coincide con varias opciones. Sé más específico.`;
            if(esSimulador(remoteJid)) enviarAlFrontend(remoteJid, txt);
            else await sock.sendMessage(remoteJid, { text: txt });
            return null; // Detenemos flujo
        }
    }

    if (match) {
        return match.next_step; // ✅ Retornamos el ID del siguiente paso
    } else {
        const txt = `⚠️ Opción no válida.\nEscribe el número o nombre de la opción.`;
        if(esSimulador(remoteJid)) enviarAlFrontend(remoteJid, txt);
        else await sock.sendMessage(remoteJid, { text: txt });
        return null;
    }
}

// --- MANEJADOR DE INPUTS (DATOS) ---
async function handleInputStep(stepConfig, text, user, dbKey, remoteJid, sock) {
    const varName = stepConfig.save_var || 'temp';

    // 1. Validación de NOMBRE
    if (varName === 'nombre' && !isValidName(text)) {
        const txt = "⚠️ Error.\n\nPor favor escribe solo tu nombre completo.";
        if(esSimulador(remoteJid)) enviarAlFrontend(remoteJid, txt); 
        else await sock.sendMessage(remoteJid, { text: txt });
        return null;
    }

    // 2. Validación de FECHA DE NACIMIENTO 
    if (varName === 'fecha_nacimiento' && !isValidBirthDate(text)) {
        const txt = "⚠️ Fecha incorrecta.\n\nPor favor escribe tu fecha así: DD/MM/AAAA \n(Ej: 02/07/1984)";
        if(esSimulador(remoteJid)) enviarAlFrontend(remoteJid, txt); 
        else await sock.sendMessage(remoteJid, { text: txt });
        return null;
    }

    // 🛡️ PROTECCIÓN ANTI-CRASH: Si history no existe, lo creamos
    if (!user.history) user.history = {}; 

    // Guardamos dato
    user.history[varName] = text;
    await updateUser(dbKey, { history: user.history });
    
    return stepConfig.next_step;
}

// --- MANEJADOR DE CITAS ---
async function handleCitaStep(stepConfig, text, user, dbKey, remoteJid, sock, msg) {
    console.log(`🧠 Analizando Cita: "${text}"`);
    const analysis = analyzeNaturalLanguage(text);

    if (analysis.date) {
        user.history['fecha'] = analysis.date;
        if (!analysis.time) delete user.history['hora'];
    }
    if (analysis.time) user.history['hora'] = analysis.time;

    await updateUser(dbKey, { history: user.history });
    const fechaMemoria = user.history['fecha'];
    const horaMemoria = user.history['hora'];

    // Validaciones
    if (!fechaMemoria) {
        const txt = "📅 ¿Para qué día te gustaría agendar?";
        if(esSimulador(remoteJid)) enviarAlFrontend(remoteJid, txt); else await sock.sendMessage(remoteJid, { text: txt });
        return null;
    }
    if (!horaMemoria) {
        const txt = `Perfecto, para el *${friendlyDate(fechaMemoria)}*.\n¿A qué hora? (Ej: 4:00 PM)`;
        if(esSimulador(remoteJid)) enviarAlFrontend(remoteJid, txt); else await sock.sendMessage(remoteJid, { text: txt });
        return null;
    }
    if (isDateInPast(fechaMemoria, horaMemoria)) {
        const txt = "⚠️ Fecha pasada. Indica una futura.";
        if(esSimulador(remoteJid)) enviarAlFrontend(remoteJid, txt); else await sock.sendMessage(remoteJid, { text: txt });
        delete user.history['hora']; await updateUser(dbKey, { history: user.history });
        return null;
    }

    const rules = validateBusinessRules(horaMemoria);
    if (!rules.valid) {
        if(esSimulador(remoteJid)) enviarAlFrontend(remoteJid, rules.reason); else await sock.sendMessage(remoteJid, { text: rules.reason });
        delete user.history['hora']; await updateUser(dbKey, { history: user.history });
        return null;
    }
}
