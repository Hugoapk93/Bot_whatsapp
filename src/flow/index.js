const { getUser, updateUser, getFlowStep, getFullFlow } = require('../database');
const { isBotDisabled } = require('../contacts');
const { isSimilar, analyzeNaturalLanguage, normalizeText } = require('./utils');
const { validateBusinessRules, checkAvailability, bookAppointment, isDateInPast } = require('./agenda');
const { sendStepMessage, esSimulador, enviarAlFrontend } = require('./sender');

const INITIAL_STEP = 'BIENVENIDA';
const MAX_INACTIVE_MINUTES = 2880;

// --- HELPERS ---

// 1. Fecha amigable (YYYY-MM-DD -> Miércoles 24/12/2025)
const friendlyDate = (dateStr) => {
    if(!dateStr) return dateStr;
    const [y, m, d] = dateStr.split('-').map(Number);
    const date = new Date(y, m - 1, d); 
    
    const dias = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
    const diaSemana = dias[date.getDay()];
    
    return `${diaSemana} ${d}/${m}/${y}`;
};

const handleMessage = async (sock, msg) => {
    try {
        const remoteJid = msg.key.remoteJid;
        if (isBotDisabled(remoteJid) || remoteJid.includes('@g.us')) return;

        const text = (msg.message?.conversation || msg.message?.extendedTextMessage?.text || '').trim();
        if (!text) return;

        // Normalizar teléfono
        let incomingPhone = remoteJid.split('@')[0].replace(/:[0-9]+/, '');
        if (incomingPhone.startsWith('52') && incomingPhone.length === 12) incomingPhone = '521' + incomingPhone.slice(2);
        
        let user = getUser(incomingPhone);
        const dbKey = incomingPhone;
        const timestamp = new Date().toISOString();

        // 🚩 BANDERA DE CONTROL (Para evitar el error del primer mensaje)
        let isFlowReset = false;

        if (!user?.phone) {
            console.log(`✨ Nuevo usuario: ${dbKey}`);
            await updateUser(dbKey, { current_step: INITIAL_STEP, history: {}, jid: remoteJid, last_active: timestamp });
            user = getUser(dbKey);
            isFlowReset = true;

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

        // Reset por Inactividad
        const lastActive = new Date(user.last_active || timestamp).getTime();
        if ((new Date().getTime() - lastActive) / 60000 > MAX_INACTIVE_MINUTES && user.current_step !== INITIAL_STEP) {
            await updateUser(dbKey, { current_step: INITIAL_STEP, history: {} });
            user = getUser(dbKey);
            isFlowReset = true;
        }

        // --- CEREBRO ---
        
        // 1. Keywords Globales (CON PROTECCIÓN POR TIPO)
        const fullFlow = getFullFlow();
        let jumpStep = null;

        // A) Buscar si el texto coincide con alguna Keyword
        for (const [sKey, sVal] of Object.entries(fullFlow)) {
            if (sVal.keywords?.some(k => isSimilar(text, k))) {
                jumpStep = sKey;
                break;
            }
        }

        // B) Ejecutar salto (CON VALIDACIÓN DE TIPO)
        if (jumpStep) {
            const currentStepConf = getFlowStep(user.current_step);

            // Si el paso existe Y es de tipo 'filtro', ACTIVAMOS EL ESCUDO
            if (currentStepConf && currentStepConf.type === 'filtro') {
                console.log(`🛡️ Keyword detectada (${jumpStep}) pero IGNORADA: El usuario está en un FILTRO.`);
            } else {
                console.log(`🔀 Keyword detectada: Saltando a ${jumpStep}`);
                await updateUser(dbKey, { current_step: jumpStep });
                await sendStepMessage(sock, remoteJid, jumpStep, user);
                return;
            }
        }

        // Si se reseteó el flujo (usuario nuevo o inactivo), enviamos bienvenida y cortamos
        if (isFlowReset) {
            await sendStepMessage(sock, remoteJid, INITIAL_STEP, user);
            return; 
        }

        // 2. Procesar Paso Actual
        const currentStepConfig = getFlowStep(user.current_step);
        if (!currentStepConfig) {
            await updateUser(dbKey, { current_step: INITIAL_STEP });
            await sendStepMessage(sock, remoteJid, INITIAL_STEP, user);
            return;
        }

        let nextStepId = null;

        // --- LÓGICA DE MENÚ INTELIGENTE ---
        if (currentStepConfig.type === 'menu') {
            // ✅ CORRECCIÓN 2: Usamos normalizeText importado
            const userClean = normalizeText(text); 
            let match = null;

            // A) Intentar por número (1, 2, 3...)
            const index = parseInt(text) - 1;
            if (!isNaN(index) && currentStepConfig.options?.[index]) {
                match = currentStepConfig.options[index];
            }

            // B) Si no es número, buscar por Texto (Trigger o Label Exacto)
            if (!match) {
                match = currentStepConfig.options?.find(opt => 
                    isSimilar(text, opt.trigger) || isSimilar(text, opt.label)
                );
            }

            // C) Si sigue sin match, usar LÓGICA PARCIAL (Mejorada para Ambigüedad)
            if (!match && currentStepConfig.options) {
                // 1. Buscamos TODAS las coincidencias posibles
                const matchesFound = currentStepConfig.options.filter(opt => {
                    const btnText = normalizeText(opt.label);
                    
                    // Caso 1: Contención Directa
                    if (btnText.includes(userClean) && userClean.length > 3) return true;

                    // Caso 2: Intersección de Palabras
                    const userWords = userClean.split(' ');
                    return userWords.some(w => w.length > 3 && btnText.includes(w));
                });

                // 2. Evaluamos cuántas encontramos
                if (matchesFound.length === 1) {
                    // ✅ Caso Ideal: Solo una opción coincide
                    match = matchesFound[0];
                } 
                else if (matchesFound.length > 1) {
                    // ⚠️ AMBIGÜEDAD DETECTADA
                    console.log(`⚠️ Ambigüedad: "${text}" coincide con ${matchesFound.length} opciones.`);
                    
                    let txt = `🤔 Tu respuesta coincide con varias opciones:\n`;
                    matchesFound.forEach(m => {
                        txt += `\n👉 *${m.label}*`;
                    });
                    txt += `\n\nPor favor sé más específico (ej: "Efectivo" o "Moto").`;

                    if(esSimulador(remoteJid)) enviarAlFrontend(remoteJid, txt); 
                    else await sock.sendMessage(remoteJid, { text: txt });
                    
                    return; // ⛔ IMPORTANTE: Cortamos flujo aquí
                }
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

            // Si el siguiente paso es una CITA, activamos la IA de agendamiento
            if (targetStepConfig && targetStepConfig.type === 'cita') {
                
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

                // 1. Falta Fecha
                if (!fechaMemoria) {
                    const txt = "📅 ¿Para qué día te gustaría agendar? (Ej: Mañana, El viernes)";
                    if(esSimulador(remoteJid)) enviarAlFrontend(remoteJid, txt); else await sock.sendMessage(remoteJid, { text: txt });
                    return; 
                }

                // 2. Falta Hora
                if (!horaMemoria) {
                    const fechaTexto = friendlyDate(fechaMemoria);
                    const txt = `Perfecto te agende para el dia *${fechaTexto}*.\n¿A que hora puedes venir?\n(Escribe en formato 24 hrs o AM/PM)`;
                    if(esSimulador(remoteJid)) enviarAlFrontend(remoteJid, txt); else await sock.sendMessage(remoteJid, { text: txt });
                    return; 
                }

                // 3. Validar Pasado
                if (isDateInPast(fechaMemoria, horaMemoria)) {
                    const txt = `⚠️ La fecha ${fechaMemoria} a las ${horaMemoria} ya pasó.\nPor favor indica una fecha y hora futura.`;
                    if(esSimulador(remoteJid)) enviarAlFrontend(remoteJid, txt); else await sock.sendMessage(remoteJid, { text: txt });
                    delete user.history['hora'];
                    await updateUser(dbKey, { history: user.history });
                    return;
                }

                // 4. Reglas de Negocio
                const rules = validateBusinessRules(horaMemoria);
                if (!rules.valid) {
                    const s = rules.settings?.schedule;
                    const txt = `⚠️ ${rules.reason}\nHorario: ${s?.start || '9:00'} - ${s?.end || '18:00'}`;
                    if(esSimulador(remoteJid)) enviarAlFrontend(remoteJid, txt); else await sock.sendMessage(remoteJid, { text: txt });
                    delete user.history['hora']; 
                    await updateUser(dbKey, { history: user.history });
                    return;
                }

                // 5. Disponibilidad (✅ CORRECCIÓN 3: Agregado await)
                const isAvailable = await checkAvailability(fechaMemoria, horaMemoria);
                if (!isAvailable) {
                    const txt = `❌ Horario ${horaMemoria} ocupado. ¿Otra hora?`;
                    if(esSimulador(remoteJid)) enviarAlFrontend(remoteJid, txt); else await sock.sendMessage(remoteJid, { text: txt });
                    delete user.history['hora'];
                    await updateUser(dbKey, { history: user.history });
                    return;
                }

                // 6. Agendar (✅ CORRECCIÓN 4: Agregado await)
                const finalName = user.history['nombre'] || msg.pushName || 'Cliente';
                await bookAppointment(fechaMemoria, horaMemoria, dbKey, finalName);
                console.log("🎉 Cita guardada correctamente.");

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
                    const fechaTextoFinal = friendlyDate(fechaMemoria);
                    const txt = `✅ ¡Listo! Agendado el *${fechaTextoFinal}* a las *${horaMemoria}*.`;
                    if(esSimulador(remoteJid)) enviarAlFrontend(remoteJid, txt); else await sock.sendMessage(remoteJid, { text: txt });
                    return;
                }
            }
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
