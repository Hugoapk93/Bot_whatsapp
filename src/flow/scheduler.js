const fs = require('fs');
const path = require('path');
const { getSettings, saveSettings, updateUser, getUser } = require('../database');
// 🔥 IMPORTANTE: Importamos toggleContactBot para mover el interruptor maestro
const { toggleContactBot } = require('../contacts'); 
const { sendStepMessage } = require('./sender');

// 🔥 RUTA EXACTA: Como estamos en src/flow, salimos 2 niveles para ir a data
const AGENDA_PATH = path.resolve(__dirname, '../../data/agenda.json');

const checkScheduler = async (sock) => {
    try {
        const settings = getSettings();
        
        // Validaciones: Que exista configuración y esté activa
        if (!settings.scheduler || !settings.scheduler.active) return;
        const config = settings.scheduler;
        if (!config.time || !config.target_step) return;

        // 1. Obtener hora actual en REYNOSA (Zona Horaria Fija)
        const now = new Date(new Date().toLocaleString("en-US", {timeZone: "America/Mexico_City"}));
        
        // Formato HH:MM (Ej: "06:00")
        const currentHour = now.getHours().toString().padStart(2, '0');
        const currentMinute = now.getMinutes().toString().padStart(2, '0');
        const currentTime = `${currentHour}:${currentMinute}`;
        
        // Formato Fecha YYYY-MM-DD
        const year = now.getFullYear();
        const month = (now.getMonth() + 1).toString().padStart(2, '0');
        const day = now.getDate().toString().padStart(2, '0');
        const todayStr = `${year}-${month}-${day}`;

        // 2. CANDADO: ¿Ya corrió hoy? Si sí, no hacemos nada.
        if (config.last_run === todayStr) return;

        // 3. VERIFICAR HORA
        if (currentTime === config.time) {
            console.log(`⏰ [Scheduler] Hora ${currentTime} detectada. Iniciando revisión de agenda...`);
            
            if (!fs.existsSync(AGENDA_PATH)) {
                console.error("❌ No se encontró agenda.json en:", AGENDA_PATH);
                return;
            }

            const fileContent = fs.readFileSync(AGENDA_PATH, 'utf-8');
            if(!fileContent) return;
            
            const agendaData = JSON.parse(fileContent);
            const todayAppts = agendaData[todayStr] || []; // Citas de HOY

            if (todayAppts.length === 0) {
                console.log("📅 Hoy no hay citas agendadas.");
            } else {
                console.log(`🔍 Analizando ${todayAppts.length} citas para hoy...`);
                
                let movedCount = 0;

                for (const appt of todayAppts) {
                    // --- FILTRO INTELIGENTE ---
                    if (appt.created_at) {
                        const createdDate = new Date(appt.created_at).toLocaleString("en-US", {timeZone: "America/Mexico_City"});
                        const createdDateStr = new Date(createdDate).toISOString().split('T')[0]; 
                        if (createdDateStr === todayStr) {
                            console.log(`⏩ Saltando a ${appt.name} (Agendó hoy).`);
                            continue;
                        }
                    }

                    // Limpieza del teléfono
                    const rawPhone = appt.phone || "";
                    const dbPhone = rawPhone.replace(/\D/g, ''); 

                    if (dbPhone) {
                        console.log(`🚀 Reactivando y moviendo a ${appt.name}...`);

                        // PASO A: ENCENDER INTERRUPTOR MAESTRO (Memoria)
                        // Esto asegura que el sistema sepa que el bot está activo para este número
                        toggleContactBot(dbPhone, true);

                        // PASO B: MOVER DE PASO (Base de Datos)
                        await updateUser(dbPhone, { 
                            current_step: config.target_step,
                            bot_enabled: true 
                        });

                        // ⏳ PASO C: PAUSA DE SEGURIDAD (500ms)
                        // Damos tiempo a que la DB guarde y el estado se propague
                        await new Promise(r => setTimeout(r, 500));

                        // PASO D: OBTENER DATOS Y ENVIAR
                        const userData = getUser(dbPhone) || { phone: dbPhone };
                        
                        // Forzamos el flag en el objeto local por si getUser leyó caché vieja
                        userData.bot_enabled = true; 

                        // Construir JID
                        let targetJid = userData.jid; 
                        if (!targetJid) {
                            targetJid = dbPhone.length > 15 ? `${dbPhone}@lid` : `${dbPhone}@s.whatsapp.net`;
                        }

                        // Enviar Mensaje
                        await sendStepMessage(sock, targetJid, config.target_step, userData);
                        
                        movedCount++;
                        // Pausa de 2 segundos entre clientes
                        await new Promise(r => setTimeout(r, 2000));
                    }
                }
                console.log(`✅ Proceso completado. ${movedCount} mensajes enviados.`);
            }

            // 4. ACTUALIZAR LAST_RUN
            settings.scheduler.last_run = todayStr;
            await saveSettings(settings);
        }

    } catch (e) {
        console.error("🔥 Error en Scheduler:", e);
    }
};

const initScheduler = (sock) => {
    console.log("🕰️ Módulo Scheduler (Recordatorios) -> INICIADO");
    // Revisa el reloj cada 60 segundos
    setInterval(() => checkScheduler(sock), 60000);
};

module.exports = { initScheduler };
