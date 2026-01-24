const { updateUser, getUser } = require('../database');
// Nota: Ya no necesitamos normalizeText ni isSimilar de utils porque usamos basicClean aquí mismo
const { analyzeNaturalLanguage } = require('./utils');
const { sendStepMessage, esSimulador, enviarAlFrontend } = require('./sender');
const { validateBusinessRules, checkAvailability, bookAppointment, isDateInPast, friendlyDate } = require('./agenda');
const { isValidName, isValidBirthDate } = require('./validators');

// 🔥 HELPER: Limpieza básica (Quitar acentos y mayúsculas)
const basicClean = (str) => {
    if (!str) return "";
    return str.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
};

// --- MANEJADOR DE MENÚS (MEJORADO) ---
async function handleMenuStep(stepConfig, text, remoteJid, sock) {
    const userText = basicClean(text);
    const isNumber = /^[0-9]+$/.test(userText);
    
    // 1. Prioridad: Coincidencia por NÚMERO
    if (isNumber) {
        const index = parseInt(userText) - 1;
        if (stepConfig.options && stepConfig.options[index]) {
            return stepConfig.options[index].next_step;
        }
    }

    // 2. Coincidencia por PALABRAS CLAVE
    if (stepConfig.options && Array.isArray(stepConfig.options)) {
        
        // Separamos lo que escribió el cliente: "prestamo moto" -> ["prestamo", "moto"]
        const userWords = userText.split(' ').filter(w => w.length > 2); 
        
        if (userWords.length > 0) {
            // Filtramos: ¿Qué opciones contienen TODAS las palabras que escribió el usuario?
            const matches = stepConfig.options.filter(opt => {
                const optLabel = basicClean(opt.label);
                const optTrigger = basicClean(opt.trigger || "");
                
                // Revisa en la etiqueta O en el trigger oculto
                return userWords.every(word => optLabel.includes(word) || optTrigger.includes(word));
            });

            // --- TOMA DE DECISIÓN ---

            if (matches.length === 1) {
                // ✅ CASO PERFECTO: Solo hay una coincidencia
                return matches[0].next_step;
            }

            if (matches.length > 1) {
                // ⚠️ AMBIGÜEDAD: Hay varias opciones parecidas
                // Listamos los nombres reales para preguntar
                const suggestions = matches.map(m => `"${m.label}"`).join(' o ');
                const txt = `⚠️ Hay varias opciones con esa palabra.\n¿Quisiste decir: ${suggestions}?`;

                if(esSimulador(remoteJid)) enviarAlFrontend(remoteJid, txt); 
                else await sock.sendMessage(remoteJid, { text: txt });
                
                return null; // Detenemos para que aclare
            }
        }
    }

    // ❌ CASO ERROR: No entendió nada
    const txt = `⚠️ Opción no válida.\nEscribe el número o el nombre de la opción.`;
    if(esSimulador(remoteJid)) enviarAlFrontend(remoteJid, txt); 
    else await sock.sendMessage(remoteJid, { text: txt });
    
    return null;
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
        const txt = "⚠️ Fecha incorrecta.\nPor favor escribe tu fecha así: \n\nDD/MM/AAAA \n(Ej: 02/07/1984)";
        if(esSimulador(remoteJid)) enviarAlFrontend(remoteJid, txt); 
        else await sock.sendMessage(remoteJid, { text: txt });
        return null; // No avanzamos
    }

    // 🛡️ PROTECCIÓN ANTI-CRASH
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

    if (!user.history) user.history = {};

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

    const isAvailable = await checkAvailability(fechaMemoria, horaMemoria);
    if (!isAvailable) {
        const txt = `❌ Horario ocupado.`;
        if(esSimulador(remoteJid)) enviarAlFrontend(remoteJid, txt); else await sock.sendMessage(remoteJid, { text: txt });
        delete user.history['hora']; await updateUser(dbKey, { history: user.history });
        return null;
    }

    // Agendar
    const finalName = user.history['nombre'] || msg.pushName || 'Cliente';
    await bookAppointment(fechaMemoria, horaMemoria, dbKey, finalName);

    if (global.sendPushNotification) {
        global.sendPushNotification("📅 Nueva Cita", `Cliente: ${finalName}`, "/#agenda");
    }

    if (stepConfig.next_step) {
        return stepConfig.next_step; 
    } else {
        const txt = `✅ Cita confirmada: ${friendlyDate(fechaMemoria)} a las ${horaMemoria}`;
        if(esSimulador(remoteJid)) enviarAlFrontend(remoteJid, txt); else await sock.sendMessage(remoteJid, { text: txt });
        return null;
    }
}

module.exports = { handleMenuStep, handleInputStep, handleCitaStep };
