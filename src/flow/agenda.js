const fs = require('fs').promises; // 🔥 Usamos Promesas (Asíncrono)
const path = require('path');
const { getSettings } = require('../database'); 

const agendaPath = path.join(__dirname, '../../data/agenda.json');
const tempAgendaPath = path.join(__dirname, '../../data/agenda.tmp.json'); // Archivo temporal

// --- 1. MANEJO DE ARCHIVOS ROBUSTO (Async + Atomic) ---
const getAgenda = async () => {
    try {
        const data = await fs.readFile(agendaPath, 'utf-8');
        return JSON.parse(data);
    } catch (e) {
        // Si no existe, retornamos vacío, pero si es error de lectura lo logueamos
        if (e.code !== 'ENOENT') console.error('Error leyendo agenda:', e);
        return {};
    }
};

const saveAgenda = async (data) => {
    try {
        // 1. Escribir en un archivo temporal primero (para no corromper el original)
        await fs.writeFile(tempAgendaPath, JSON.stringify(data, null, 2));
        // 2. Renombrar el temporal al original (operación atómica/segura)
        await fs.rename(tempAgendaPath, agendaPath);
    } catch (e) {
        console.error('CRITICAL: No se pudo guardar la agenda:', e);
    }
};

// --- 2. HELPERS DE TIEMPO CENTRALIZADOS ---
const TIMEZONE = "America/Mexico_City";

// Devuelve un objeto Date real ajustado a la zona horaria
const getMxDate = () => {
    const now = new Date();
    // Truco para obtener la fecha exacta en la TZ deseada sin librerías externas pesadas
    const isoParams = now.toLocaleString("en-US", { timeZone: TIMEZONE });
    return new Date(isoParams); 
};

const timeToMinutes = (timeStr) => {
    if(!timeStr) return -1;
    const [h, m] = timeStr.split(':').map(Number);
    return (h * 60) + m;
};

// --- VALIDACIONES ---

const isDateInPast = (dateStr, timeStr) => {
    const nowMx = getMxDate();
    
    // Formato YYYY-MM-DD local
    const year = nowMx.getFullYear();
    const month = String(nowMx.getMonth() + 1).padStart(2, '0');
    const day = String(nowMx.getDate()).padStart(2, '0');
    const todayStr = `${year}-${month}-${day}`;

    if (dateStr < todayStr) return true;
    
    if (dateStr === todayStr && timeStr) {
        const currentMinutes = (nowMx.getHours() * 60) + nowMx.getMinutes();
        const citaMinutes = timeToMinutes(timeStr);
        // Damos 5 minutos de tolerancia (opcional)
        if (citaMinutes < currentMinutes) return true;
    }
    return false;
};

const isBusinessClosed = () => {
    const settings = getSettings(); 
    if (!settings.schedule || !settings.schedule.active) return false;

    const nowMx = getMxDate();
    const currentMins = (nowMx.getHours() * 60) + nowMx.getMinutes();

    const startMins = timeToMinutes(settings.schedule.start || "09:00");
    const endMins = timeToMinutes(settings.schedule.end || "18:00");

    // Lógica invertida para soportar horarios que cruzan medianoche (ej: 22:00 a 02:00)
    if (startMins < endMins) {
        // Horario normal (ej: 9am a 6pm)
        return currentMins < startMins || currentMins >= endMins;
    } else {
        // Horario nocturno (ej: 10pm a 2am) - Si NO está dentro del rango, está cerrado
        return !(currentMins >= startMins || currentMins < endMins);
    }
};

// 🔥 FUNCIÓN MEJORADA: Lógica robusta + Mensaje dinámico
const validateBusinessRules = (timeStr) => {
    const settings = getSettings();
    if (!timeStr) return { valid: false, reason: "Falta la hora." };
    
    const [h, m] = timeStr.split(':').map(Number);
    
    // Validar intervalo (30 min)
    if (m % 30 !== 0) return { valid: false, reason: "Solo agendamos en horas exactas o medias (ej: 4:00, 4:30)." };
    
    const reqMins = (h * 60) + m;
    
    // Obtener configuración o defaults
    const sStart = settings.schedule?.start || "09:00";
    const sEnd = settings.schedule?.end || "18:00";
    
    const startMins = timeToMinutes(sStart);
    const endMins = timeToMinutes(sEnd);
    
    let isClosed = false;

    // Lógica robusta (Diurna vs Nocturna)
    if (startMins < endMins) {
        // Horario estándar (ej: 9 a 18) -> Cerrado si es ANTES de abrir o DESPUES de cerrar
        if (reqMins < startMins || reqMins >= endMins) isClosed = true;
    } else {
        // Horario nocturno (ej: 22 a 02) -> Cerrado si está en el "hueco" del día
        if (reqMins >= endMins && reqMins < startMins) isClosed = true;
    }

    if (isClosed) {
        return { 
            valid: false, 
            reason: `⛔ Lo siento, estamos cerrados a esa hora.\n🕒 Nuestro horario es de *${sStart}* a *${sEnd}*.` 
        };
    }
    
    return { valid: true, settings };
};

// --- AGENDA ASÍNCRONA ---
const checkAvailability = async (date, time) => {
    const db = await getAgenda(); // await
    if (db[date] && db[date].some(c => c.time === time)) return false; 
    return true; 
};

const bookAppointment = async (date, time, phone, name) => {
    const db = await getAgenda(); // await
    if (!db[date]) db[date] = [];
    
    // Evitar duplicados exactos (doble clic)
    if (db[date].some(c => c.time === time)) return false;

    db[date].push({ time, phone, name, created_at: new Date().toISOString() });
    db[date].sort((a, b) => a.time.localeCompare(b.time));
    
    await saveAgenda(db); // await
    return true;
};

module.exports = { 
    getAgenda, 
    validateBusinessRules, 
    checkAvailability, 
    bookAppointment, 
    isDateInPast,
    isBusinessClosed
};
