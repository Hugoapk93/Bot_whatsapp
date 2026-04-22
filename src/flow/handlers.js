const fs = require('fs');
const path = require('path');
const { updateUser, getUser, getSettings, getKeywords, saveKeyword } = require('../database');
// 🔥 CORRECCIÓN 1: Aquí agregamos isSimilar para tolerar errores ortográficos
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

async function handleDudaPendiente(rawText, user, dbKey, remoteJid, sock, instruction) {

    try {
        const todasLasReglas = getKeywords();
        const yaExiste = todasLasReglas.find(regla => regla.keywords === rawText);
        
        if (!yaExiste) {
            saveKeyword({
                id: 'kw_' + Date.now(),
                keywords: rawText,
                answer: ""
            });
            console.log(`🧠 Nueva duda enviada al panel de aprendizaje: "${rawText}"`);
        }
    } catch (err) {
        console.error("Error al guardar la duda en el panel de Respuestas Rápidas:", err);
    }

    const msgDuda = `¡Buena pregunta! 🧐\n\nHe guardado tu duda para que un asesor te la resuelva al terminar.\n\n${instruction}`;

    if (esSimulador(remoteJid)) enviarAlFrontend(remoteJid, msgDuda);
    else await sock.sendMessage(remoteJid, { text: msgDuda });
    return null;
}

async function processError(stepConfig, user, dbKey, remoteJid, sock, defaultMsg) {
    user.error_count = (user.error_count || 0) + 1;

    if (user.error_count >= 3 && stepConfig.fallback_step) {
        await updateUser(dbKey, { error_count: 0 });

        if (stepConfig.error_message_3) {
            if (esSimulador(remoteJid)) enviarAlFrontend(remoteJid, stepConfig.error_message_3);
            else await sock.sendMessage(remoteJid, { text: stepConfig.error_message_3 });
        }
        
        return stepConfig.fallback_step;
    }

    await updateUser(dbKey, { error_count: user.error_count });

    let txt = defaultMsg;
    if (user.error_count === 1 && stepConfig.error_message_1) txt = stepConfig.error_message_1;
    else if (user.error_count === 2 && stepConfig.error_message_2) txt = stepConfig.error_message_2;
    else if (user.error_count >= 3 && stepConfig.error_message_3) txt = stepConfig.error_message_3;

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

// 🔥 CORRECCIÓN 2: Menú súper flexible para tolerar errores ortográficos y "1 solisitar"
async function handleMenuStep(stepConfig, text, user, dbKey, remoteJid, sock) {
    const userText = basicClean(text);
    
    const numberMatch = userText.match(/^(\d+)/); 
    if (numberMatch) {
        const index = parseInt(numberMatch[1]) - 1;
        if (stepConfig.options && stepConfig.options[index]) {
            if (user.error_count > 0) await updateUser(dbKey, { error_count: 0 }); 
            return stepConfig.options[index].next_step;
        }
    }

    if (stepConfig.options && Array.isArray(stepConfig.options)) {
        const userWords = userText.split(' ').filter(w => w.length > 3); 
        
        if (userWords.length > 0) {
            const matches = stepConfig.options.filter(opt => {
                const optLabelWords = basicClean(opt.label).split(' ');
                const optTriggerWords = basicClean(opt.trigger || "").split(' ');
                const allTargetWords = [...optLabelWords, ...optTriggerWords].filter(w => w.length > 3);

                return userWords.some(uWord => 
                    allTargetWords.some(tWord => isSimilar(uWord, tWord))
                );
            });

            if (matches.length === 1) {
                if (user.error_count > 0) await updateUser(dbKey, { error_count: 0 });
                return matches[0].next_step;
            }

            if (matches.length > 1) {
                const suggestions = matches.map(m => `"${m.label}"`).join(' o ');
                return await processError(stepConfig, user, dbKey, remoteJid, sock, `⚠️ Varias opciones coinciden.\n\n¿Cuál quieres elegir:\n ${suggestions}?`);
            }
        }
    }

    if (isQuestion(text)) {
        return await handleDudaPendiente(text, user, dbKey, remoteJid, sock, "Por favor, elige una de las opciones válidas del menú para continuar con tu trámite.");
    }

    return await processError(stepConfig, user, dbKey, remoteJid, sock, `⚠️ Opción no válida.\nEscribe el número o el nombre de la opción.`);
}

async function handleInputStep(stepConfig, text, user, dbKey, remoteJid, sock) {
    const varName = stepConfig.save_var || 'temp';

    if (varName === 'nombre') {
        const cleanName = normalizeName(text);
        if (!isValidName(cleanName)) {
            if (isQuestion(text)) {
                return await handleDudaPendiente(text, user, dbKey, remoteJid, sock, "Por favor, escribe solo tu nombre completo para continuar.");
            }
            return await processError(stepConfig, user, dbKey, remoteJid, sock, "⚠️ Error.\n\nPor favor escribe solo tu nombre completo.");
        }
        text = cleanName; 
    }

    if (varName === 'fecha_nacimiento') {
        const cleanDate = normalizeDate(text); 
        if (!isValidBirthDate(cleanDate)) {
            if (isQuestion(text)) {
                return await handleDudaPendiente(text, user, dbKey, remoteJid, sock, "Por favor, escribe tu fecha en formato DD/MM/AAAA para continuar.");
            }
            return await processError(stepConfig, user, dbKey, remoteJid, sock, "⚠️ Fecha incorrecta.\nPor favor escribe tu fecha así: \n\nDD/MM/AAAA \n(Ej: 02/07/1984)");
        }
        text = cleanDate; 
    }

    if (varName !== 'nombre' && varName !== 'fecha_nacimiento' && isQuestion(text)) {
        return await handleDudaPendiente(text, user, dbKey, remoteJid, sock, "Por favor, ingresa el dato solicitado para avanzar.");
    }

    if (!user.history) user.history = {};
    user.history[varName] = text;
    
    const updates = { history: user.history };
    if (user.error_count > 0) updates.error_count = 0; 
    await updateUser(dbKey, updates);
    
    return stepConfig.next_step;
}

async function handleCitaStep(stepConfig, text, user, dbKey, remoteJid, sock, msg) {
    
    if (isQuestion(text)) {
        return await handleDudaPendiente(text, user, dbKey, remoteJid, sock, "Por favor, indícame la fecha o la hora en la que te gustaría agendar tu cita.");
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
