const fs = require('fs');
const path = require('path');
const { getSettings, saveSettings, updateUser, getUser } = require('../database');
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
                    // --- FILTRO INTELIGENTE (OPCIÓN 1) ---
                    // Si el cliente agendó HOY MISMO, no lo molestamos con recordatorios.
                    if (appt.created_at) {
                        const createdDate = new Date(appt.created_at).toLocaleString("en-US", {timeZone: "America/Mexico_City"});
                        const createdDateStr = new Date(createdDate).toISOString().split('T')[0]; // YYYY-MM-DD

                        if (createdDateStr === todayStr) {
                            console.log(`⏩ Saltando a ${appt.name} (Agendó hoy, no requiere recordatorio).`);
                            continue;
                        }
                    }

                    // Limpieza del teléfono
                    const rawPhone = appt.phone || "";
                    const dbPhone = rawPhone.replace(/\D/g, ''); 

                    if (dbPhone) {
                        console.log(`🚀 Moviendo a ${appt.name} al paso: ${config.target_step}`);

                        // A. Mover y REACTIVAR el bot
                        await updateUser(dbPhone, { 
                            current_step: config.target_step,
                            bot_enabled: true });

                        // B. Obtener datos frescos del usuario
                        const userData = getUser(dbPhone) || { phone: dbPhone };

                        // C. Construir JID (Manejo básico de LIDs)
                        let targetJid = userData.jid; 
                        if (!targetJid) {
                            targetJid = dbPhone.length > 15 ? `${dbPhone}@lid` : `${dbPhone}@s.whatsapp.net`;
                        }

                        // D. Enviar Mensaje (Disparador del flujo)
                        await sendStepMessage(sock, targetJid, config.target_step, userData);
                        
                        movedCount++;
                        // Pausa de 2 segundos para no saturar
                        await new Promise(r => setTimeout(r, 2000));
                    }
                }
                console.log(`✅ Proceso completado. ${movedCount} mensajes enviados.`);
            }

            // 4. ACTUALIZAR LAST_RUN (Para que no se repita hoy)
            settings.scheduler.last_run = todayStr;
            // Guardamos usando tu función saveSettings
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
