const fs = require('fs');
const path = require('path');
const { updateUser, getUser, getSettings, getKeywords, saveKeyword } = require('../database');
const { analyzeNaturalLanguage, isSimilar } = require('./utils');
const { sendStepMessage, esSimulador, enviarAlFrontend } = require('./sender');
const { validateBusinessRules, checkAvailability, bookAppointment, isDateInPast, friendlyDate } = require('./agenda');
const { isValidName, isValidBirthDate, normalizeName, normalizeDate } = require('./validators');

const getAgendaLocal = () => {
    try {
        const agendaPath = path.join(__dirname, '../../data/agenda.json');
        if (fs.existsSync(agendaPath)) {
            return JSON.parse(fs.readFileSync(agendaPath, 'utf-8'));
        }
    } catch (e) {
        console.error("Error leyendo agenda:", e);
    }
    return {};
};

const basicClean = (str) => {
    if (!str) return "";
    return str.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
};

const numberEmojis = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];

const isQuestion = (rawText) => {
    if (!rawText) return false;
    if (rawText.includes('?') || rawText.includes('¿')) return true;

    const clean = basicClean(rawText);
    const keywords = ['como', 'cuando', 'donde', 'por que', 'cuanto', 'precio', 'costo', 'aceptan', 'tienen', 'requisito', 'duda'];
    const regex = new RegExp(`\\b(${keywords.join('|')})\\b`, 'i');
    return regex.test(clean);
};

// 🔥 MEJORA: Ahora solo guarda la pregunta en silencio, sin responder "Buena pregunta".
async function handleDudaPendiente(rawText) {
    try {
        const todasLasReglas = getKeywords();
        const yaExiste = todasLasReglas.find(regla => regla.keywords === rawText);
        
        if (!yaExiste) {
            saveKeyword({
                id: 'kw_' + Date.now(),
                keywords: rawText,
                answer: ""
            });
            console.log(`🧠 Duda nueva guardada en silencio para el panel: "${rawText}"`);
        }
    } catch (err) {
        console.error("Error al guardar la duda silenciosa:", err);
    }
}

async function processError(stepConfig, user, dbKey, remoteJid, sock, defaultMsg, category = null) {
    user.error_count = (user.error_count || 0) + 1;

    const settings = getSettings();
    const globalErrors = settings.globalErrors || {};
    
    const catConfig = category && globalErrors[category] ? globalErrors[category] : null;

    const maxTries = stepConfig.fallback_tries || (catConfig ? catConfig.tries : 3);
    const fallbackStep = stepConfig.fallback_step || (catConfig ? catConfig.fallback : null);

    if (user.error_count >= maxTries && fallbackStep) {
        await updateUser(dbKey, { error_count: 0 });

        let finalMsg = null;
        if (user.error_count === 3) finalMsg = stepConfig.error_message_3 || (catConfig ? catConfig.err3 : null);
        else if (user.error_count === 2) finalMsg = stepConfig.error_message_2 || (catConfig ? catConfig.err2 : null);
        
        if (finalMsg) {
            if (esSimulador(remoteJid)) enviarAlFrontend(remoteJid, finalMsg);
            else await sock.sendMessage(remoteJid, { text: finalMsg });
        }
        
        return fallbackStep;
    }

    await updateUser(dbKey, { error_count: user.error_count });

    let txt = defaultMsg;
    if (user.error_count === 1) {
        txt = stepConfig.error_message_1 || (catConfig ? catConfig.err1 : null) || defaultMsg;
    } else if (user.error_count === 2) {
        txt = stepConfig.error_message_2 || (catConfig ? catConfig.err2 : null) || defaultMsg;
    } else if (user.error_count >= 3) {
        txt = stepConfig.error_message_3 || (catConfig ? catConfig.err3 : null) || defaultMsg;
    }

    if ((user.error_count === 1 || user.error_count === 2) && stepConfig.type === 'menu' && stepConfig.options && stepConfig.options.length > 0) {
        let menuTxt = '\n\n';
        
        stepConfig.options.forEach((opt, index) => {
            const emoji = numberEmojis[index] || `*${index + 1}.*`; 
            menuTxt += `${emoji} ${opt.label}\n`;
        });
        
        txt += menuTxt;
    }

    if (esSimulador(remoteJid)) enviarAlFrontend(remoteJid, txt);
    else await sock.sendMessage(remoteJid, { text: txt });

    return null;
}

async function handleMenuStep(stepConfig, text, user, dbKey, remoteJid, sock) {
    const userText = basicClean(text);
    let selectedOption = null;

    if (stepConfig.options && Array.isArray(stepConfig.options)) {
        for (let i = 0; i < stepConfig.options.length; i++) {
            const opt = stepConfig.options[i];
            const optNumber = (i + 1).toString();
            const optLabelClean = basicClean(opt.label);
            const optTriggerClean = basicClean(opt.trigger || "");

            // 1. Número exacto ("1", "2") o número como palabra suelta ("la 1")
            const textWords = userText.split(' ');
            if (userText === optNumber || textWords.includes(optNumber)) {
                selectedOption = opt;
                break;
            }

            // 2. Coincidencia exacta de texto ("si", "no") o texto incluido ("no amigo")
            if (userText === optLabelClean || userText.includes(optLabelClean)) {
                selectedOption = opt;
                break;
            }

            // 3. Inteligencia Artificial Ligera (Levenstein) para variaciones o errores de dedo
            if (isSimilar(userText, optLabelClean) || (optTriggerClean && isSimilar(userText, optTriggerClean))) {
                selectedOption = opt;
                break;
            }
        }
    }

    // 🔥 RESULTADO DE LA VALIDACIÓN
    if (selectedOption) {
        if (user.error_count > 0) await updateUser(dbKey, { error_count: 0 });
        return selectedOption.next_step;
    }

    // SI NO ENTENDIÓ:
    // Guarda la duda si parece una pregunta y lanza el fallback
    if (isQuestion(text)) {
        await handleDudaPendiente(text);
    }

    return await processError(stepConfig, user, dbKey, remoteJid, sock, `⚠️ Opción no válida.\nEscribe el número o el nombre de la opción.`, 'menu');
}

async function handleInputStep(stepConfig, text, user, dbKey, remoteJid, sock) {
    const varName = stepConfig.save_var || 'temp';

    if (varName === 'nombre') {
        const cleanName = normalizeName(text);
        if (!isValidName(cleanName)) {
            if (isQuestion(text)) await handleDudaPendiente(text); // 🔥 MEJORA
            return await processError(stepConfig, user, dbKey, remoteJid, sock, "⚠️ Error.\n\nPor favor escribe solo tu nombre completo.", 'name');
        }
        text = cleanName; 
    }

    if (varName === 'fecha_nacimiento') {
        const cleanDate = normalizeDate(text); 
        if (!isValidBirthDate(cleanDate)) {
            if (isQuestion(text)) await handleDudaPendiente(text); // 🔥 MEJORA
            return await processError(stepConfig, user, dbKey, remoteJid, sock, "⚠️ Fecha incorrecta.\nPor favor escribe tu fecha así: \n\nDD/MM/AAAA \n(Ej: 02/07/1984)", 'date');
        }
        text = cleanDate; 
    }

    if (varName !== 'nombre' && varName !== 'fecha_nacimiento' && isQuestion(text)) {
        await handleDudaPendiente(text); // 🔥 MEJORA
        return await processError(stepConfig, user, dbKey, remoteJid, sock, "⚠️ Por favor, ingresa el dato solicitado para avanzar.");
    }

    if (!user.history) user.history = {};
    user.history[varName] = text;
    
    const updates = { history: user.history };
    if (user.error_count > 0) updates.error_count = 0; 
    await updateUser(dbKey, updates);
    
    return stepConfig.next_step;
}

async function handleCitaStep(stepConfig, text, user, dbKey, remoteJid, sock, msg) {
    
    // 🔥 MEJORA: Guarda la duda en silencio y deja que pregunte de nuevo por la fecha o la hora.
    if (isQuestion(text)) {
        await handleDudaPendiente(text);
    }

    console.log(`🧠 Analizando Cita: "${text}"`);
    const analysis = analyzeNaturalLanguage(text);

    if (!user.history) user.history = {};

    if (analysis.date) {
        user.history['fecha'] = analysis.date;
        if (!analysis.time) delete user.history['hora'];
    }

    if (analysis.time) user.history['hora'] = analysis.time;

    const interval = parseInt(stepConfig.interval) || 30;

    if (user.history['fecha'] && interval === 1440 && !user.history['hora']) {
        user.history['hora'] = '08:00'; 
    }

    await updateUser(dbKey, { history: user.history });

    let fechaMemoria = user.history['fecha'];
    let horaMemoria = user.history['hora'];

    if (fechaMemoria) {
        const settings = getSettings();
        const tz = settings.timezone || "America/Matamoros";

        const formatter = new Intl.DateTimeFormat("en-CA", { 
            timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' 
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
        const txt = stepConfig.msg_date || "📅 ¿Para qué día te gustaría agendar?";
        if (esSimulador(remoteJid)) enviarAlFrontend(remoteJid, txt);
        else await sock.sendMessage(remoteJid, { text: txt });
        return null;
    }

    if (!horaMemoria) {
        let txt = stepConfig.msg_time || `Perfecto, para el *${friendlyDate(fechaMemoria)}*.\n¿A qué hora puedes venir?`;
        if (txt.includes('{{fecha}}')) {
            txt = txt.replace('{{fecha}}', friendlyDate(fechaMemoria));
        }

        if (esSimulador(remoteJid)) enviarAlFrontend(remoteJid, txt);
        else await sock.sendMessage(remoteJid, { text: txt });
        return null;
    }

    if (interval < 1440) {
        const [h, m] = horaMemoria.split(':').map(Number);
        if (m % interval !== 0) {
            const minText = interval === 60 ? 'horas en punto' : `intervalos de ${interval} minutos`;
            const ejemplo = interval < 60 ? `ej. ${h}:00, ${h}:${interval.toString().padStart(2, '0')}` : `ej. ${h}:00`;
            const txt = `⚠️ Por favor, elige una hora en ${minText} (${ejemplo}).`;
            
            delete user.history['hora'];
            await updateUser(dbKey, { history: user.history });
            
            if (esSimulador(remoteJid)) enviarAlFrontend(remoteJid, txt);
            else await sock.sendMessage(remoteJid, { text: txt });
            return null;
        }
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
        const agenda = getAgendaLocal();
        const citasDelDia = agenda[fechaMemoria] || [];
        const horasOcupadas = citasDelDia.map(c => c.time).sort();
        
        let txt = `❌ Uy, las *${horaMemoria}* ya se nos ocuparon.\n\n`;
        
        if (horasOcupadas.length > 0) {
            txt += `📌 Para el *${friendlyDate(fechaMemoria)}*, estas horas ya están tomadas:\n`;
            horasOcupadas.forEach(h => txt += `• ${h}\n`);
            txt += `\n✅ *¡Cualquier otra hora está libre!* \n¿A qué otra hora te agendo?`;
        } else {
            txt += `¿Podrías indicarme otra hora diferente, por favor?`;
        }

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
        if (user.error_count > 0) await updateUser(dbKey, { error_count: 0 }); 
        return stepConfig.next_step; 
    } else {
        const txt = `✅ Cita confirmada: ${friendlyDate(fechaMemoria)} a las ${horaMemoria}`;
        if (esSimulador(remoteJid)) enviarAlFrontend(remoteJid, txt);
        else await sock.sendMessage(remoteJid, { text: txt });
        if (user.error_count > 0) await updateUser(dbKey, { error_count: 0 }); 
        return null;
    }
}

module.exports = { handleMenuStep, handleInputStep, handleCitaStep };
