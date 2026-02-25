const fs = require('fs');
const path = require('path');
const { getSettings, saveSettings, updateUser, getUser } = require('../database');
const { toggleContactBot } = require('../contacts'); 
const { sendStepMessage } = require('./sender');

// RUTA EXACTA a la agenda
const AGENDA_PATH = path.resolve(__dirname, '../../data/agenda.json');

const checkScheduler = async (sock) => {
    try {
        const settings = getSettings();
        
        // Validaciones
        if (!settings.scheduler || !settings.scheduler.active) return;
        const config = settings.scheduler;
        if (!config.time || !config.target_step) return;

        // Horario Matamoros (Frontera) para evitar bugs de cambio de horario
        const formatter = new Intl.DateTimeFormat("en-CA", { 
            timeZone: "America/Matamoros", year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', hour12: false
        });

        const mxParts = formatter.formatToParts(new Date());
        const vals = {};
        mxParts.forEach(p => vals[p.type] = p.value);

        const todayStr = `${vals.year}-${vals.month}-${vals.day}`;
        const hourStr = vals.hour === '24' ? '00' : vals.hour;
        const currentTime = `${hourStr}:${vals.minute}`;

        // 1. CANDADO DIARIO
        if (config.last_run === todayStr) return;

        // 2. REVISIÓN DE LA HORA
        if (currentTime >= config.time) {
            console.log(`⏰ [Scheduler] Hora configurada alcanzada (${currentTime}). Iniciando revisión...`);
            
            if (!fs.existsSync(AGENDA_PATH)) return;

            const fileContent = fs.readFileSync(AGENDA_PATH, 'utf-8');
            if(!fileContent) return;
            
            const agendaData = JSON.parse(fileContent);
            const todayAppts = agendaData[todayStr] || [];

            if (todayAppts.length === 0) {
                console.log("📅 Hoy no hay citas agendadas.");
                settings.scheduler.last_run = todayStr; // Cerramos el día
                await saveSettings(settings);
                return;
            }
            
            console.log(`🔍 Analizando ${todayAppts.length} citas para hoy...`);
            let movedCount = 0;
            let allSuccess = true; 

            for (let i = 0; i < todayAppts.length; i++) {
                const appt = todayAppts[i];

                if (appt.recordatorio_enviado) continue;

                if (appt.created_at) {
                    const createdFormatter = new Intl.DateTimeFormat("en-CA", {
                        timeZone: "America/Matamoros", year: 'numeric', month: '2-digit', day: '2-digit'
                    });
                    if (createdFormatter.format(new Date(appt.created_at)) === todayStr) {
                        console.log(`⏩ Saltando a ${appt.name} (Agendó hoy mismo).`);
                        appt.recordatorio_enviado = true; 
                        continue;
                    }
                }

                const dbPhone = (appt.phone || "").replace(/\D/g, ''); 

                if (dbPhone) {
                    console.log(`🚀 Reactivando y moviendo a ${appt.name} al paso: ${config.target_step}`);

                    toggleContactBot(dbPhone, true);
                    await updateUser(dbPhone, { current_step: config.target_step, bot_enabled: true });
                    await new Promise(r => setTimeout(r, 500));

                    const userData = getUser(dbPhone) || { phone: dbPhone };
                    userData.bot_enabled = true; 
                    const targetJid = userData.jid || (dbPhone.length > 15 ? `${dbPhone}@lid` : `${dbPhone}@s.whatsapp.net`);

                    // Enviamos mensaje y capturamos resultado
                    const sendResult = await sendStepMessage(sock, targetJid, config.target_step, userData);
                    
                    if (sendResult === false) {
                        console.log(`⚠️ Falló el envío a ${appt.name}. Se reintentará en el próximo ciclo (1 minuto).`);
                        allSuccess = false; 
                        continue; 
                    }

                    appt.recordatorio_enviado = true;
                    movedCount++;
                    
                    await new Promise(r => setTimeout(r, 2000));
                }
            }

            // GUARDAMOS LA AGENDA CON MARCAS DE ENVIADO
            fs.writeFileSync(AGENDA_PATH, JSON.stringify(agendaData, null, 2));

            console.log(`✅ Ciclo completado. ${movedCount} mensajes de seguimiento enviados.`);

            // SOLO SI TODOS SE ENVIARON BIEN, CERRAMOS EL DÍA
            if (allSuccess) {
                settings.scheduler.last_run = todayStr;
                await saveSettings(settings);
                console.log(`🔒 Día cerrado correctamente en el scheduler.`);
            }
        }
    } catch (e) {
        console.error("🔥 Error en Scheduler:", e);
    }
};

// 👇 ESTO ERA LO QUE FALTABA 👇
const initScheduler = (sock) => {
    console.log("🕰️ Módulo Scheduler (Recordatorios) -> INICIADO");
    setInterval(() => checkScheduler(sock), 60000); // Revisa cada minuto
};

module.exports = { initScheduler };
