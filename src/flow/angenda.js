const fs = require('fs');
const path = require('path');
const { getSettings } = require('../database'); 

const agendaPath = path.join(__dirname, '../../data/agenda.json');

// --- MANEJO DE ARCHIVOS ---
const getAgenda = () => {
    if (!fs.existsSync(agendaPath)) return {};
    try { return JSON.parse(fs.readFileSync(agendaPath)); } catch (e) { return {}; }
};

const saveAgenda = (data) => {
    fs.writeFileSync(agendaPath, JSON.stringify(data, null, 2));
};

// --- UTILIDADES DE TIEMPO ---
const timeToMinutes = (timeStr) => {
    if(!timeStr) return -1;
    const [h, m] = timeStr.split(':').map(Number);
    return (h * 60) + m;
};

// --- VALIDACIONES DE TIEMPO (PASADO) ---
const isDateInPast = (dateStr, timeStr) => {
    const nowMx = new Date(new Date().toLocaleString("en-US", {timeZone: "America/Mexico_City"}));
    const year = nowMx.getFullYear();
    const month = String(nowMx.getMonth() + 1).padStart(2, '0');
    const day = String(nowMx.getDate()).padStart(2, '0');
    const todayStr = `${year}-${month}-${day}`;

    if (dateStr < todayStr) return true;
    if (dateStr === todayStr && timeStr) {
        const currentMinutes = (nowMx.getHours() * 60) + nowMx.getMinutes();
        const citaMinutes = timeToMinutes(timeStr);
        if (citaMinutes <= currentMinutes) return true;
    }
    return false;
};

// 🔥 FUNCIÓN CLAVE: Verifica si el negocio está CERRADO
const isBusinessClosed = () => {
    const settings = getSettings(); // Leemos la config más reciente
    
    // 1. Si no está activa la opción en el frontend, siempre está ABIERTO
    if (!settings.schedule || !settings.schedule.active) {
        // console.log("🕒 Horario: Inactivo (Abierto por defecto)");
        return false;
    }

    // 2. Obtener hora actual CDMX forzada
    const now = new Date();
    const mxDate = new Date(now.toLocaleString("en-US", {timeZone: "America/Mexico_City"}));
    
    const currentH = mxDate.getHours();
    const currentM = mxDate.getMinutes();
    const currentMins = (currentH * 60) + currentM;

    // 3. Obtener Límites del JSON
    const [sh, sm] = (settings.schedule.start || "09:00").split(':').map(Number);
    const [eh, em] = (settings.schedule.end || "18:00").split(':').map(Number);
    
    const startMins = (sh * 60) + sm;
    const endMins = (eh * 60) + em;

    // --- 🕵️ DEBUG: ESTO SALDRÁ EN LA CONSOLA PARA QUE VEAS EL ERROR ---
    console.log(`🕒 DEBUG HORARIO | Actual: ${currentH}:${currentM} (${currentMins}) | Cierre: ${eh}:${em} (${endMins})`);

    // 4. Comparación
    // Si la hora actual es MENOR a la apertura O MAYOR/IGUAL al cierre
    if (currentMins < startMins || currentMins >= endMins) {
        console.log("⛔ RESULTADO: CERRADO");
        return true; 
    }

    console.log("✅ RESULTADO: ABIERTO");
    return false;
};

// --- REGLAS DE NEGOCIO PARA CITAS (Agenda) ---
const validateBusinessRules = (timeStr) => {
    const settings = getSettings();
    if (!timeStr) return { valid: false, reason: "Falta la hora." };
    
    const [h, m] = timeStr.split(':').map(Number);
    if (m !== 0 && m !== 30) return { valid: false, reason: "Solo agendamos en horas exactas o medias." };
    
    const reqMins = (h * 60) + m;
    const startMins = timeToMinutes(settings.schedule?.start || "09:00");
    const endMins = timeToMinutes(settings.schedule?.end || "18:00");
    
    if (reqMins < startMins || reqMins >= endMins) return { valid: false, reason: "Estamos cerrados a esa hora." };
    
    return { valid: true, settings };
};

const checkAvailability = (date, time) => {
    const db = getAgenda();
    if (db[date] && db[date].some(c => c.time === time)) return false; 
    return true; 
};

const bookAppointment = (date, time, phone, name) => {
    const db = getAgenda();
    if (!db[date]) db[date] = [];
    db[date].push({ time, phone, name, created_at: new Date().toISOString() });
    db[date].sort((a, b) => a.time.localeCompare(b.time));
    saveAgenda(db);
};

module.exports = { 
    getAgenda, 
    validateBusinessRules, 
    checkAvailability, 
    bookAppointment, 
    isDateInPast,
    isBusinessClosed
};
