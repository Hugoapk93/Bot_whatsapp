const fs = require('fs');
const path = require('path');
const { getSettings } = require('../database'); // Subimos un nivel para ir a database

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

// 🔥 MEJORA IMPORTANTE: Valida si la fecha/hora ya pasó en México
const isDateInPast = (dateStr, timeStr) => {
    // Obtenemos la hora exacta en CDMX
    const nowMx = new Date(new Date().toLocaleString("en-US", {timeZone: "America/Mexico_City"}));
    
    // Construimos la fecha de "hoy" en formato YYYY-MM-DD
    const year = nowMx.getFullYear();
    const month = String(nowMx.getMonth() + 1).padStart(2, '0');
    const day = String(nowMx.getDate()).padStart(2, '0');
    const todayStr = `${year}-${month}-${day}`;

    // 1. Si la fecha agendada es menor a hoy (ayer, antier...)
    if (dateStr < todayStr) return true;

    // 2. Si la fecha es HOY, tenemos que validar la HORA
    if (dateStr === todayStr && timeStr) {
        const currentMinutes = (nowMx.getHours() * 60) + nowMx.getMinutes();
        const citaMinutes = timeToMinutes(timeStr);
        
        // Si la cita es antes o igual a la hora actual, ya pasó
        if (citaMinutes <= currentMinutes) return true;
    }

    return false;
};

// --- REGLAS DE NEGOCIO ---
const validateBusinessRules = (timeStr) => {
    const settings = getSettings();
    if (!timeStr) return { valid: false, reason: "Falta la hora." };
    
    const [h, m] = timeStr.split(':').map(Number);
    
    // Regla 1: Intervalos exactos (en punto) o medias (y media)
    if (m !== 0 && m !== 30) return { valid: false, reason: "Solo agendamos en horas exactas o medias (ej: 4:00 o 4:30)." };
    
    const reqMins = (h * 60) + m;
    const startMins = timeToMinutes(settings.schedule?.start || "09:00");
    const endMins = timeToMinutes(settings.schedule?.end || "18:00");
    
    // Regla 2: Horario de apertura/cierre
    if (reqMins < startMins || reqMins >= endMins) return { valid: false, reason: "Estamos cerrados a esa hora." };
    
    return { valid: true, settings };
};

// --- DISPONIBILIDAD ---
const checkAvailability = (date, time) => {
    const db = getAgenda();
    // Si existe el día y alguien ya tiene esa hora
    if (db[date] && db[date].some(c => c.time === time)) {
        return false; // Ocupado
    }
    return true; // Libre
};

// --- GUARDAR CITA ---
const bookAppointment = (date, time, phone, name) => {
    const db = getAgenda();
    if (!db[date]) db[date] = [];
    
    db[date].push({ 
        time, 
        phone, 
        name, 
        created_at: new Date().toISOString() 
    });
    
    // Ordenamos las citas por hora para mantener el JSON ordenado
    db[date].sort((a, b) => a.time.localeCompare(b.time));
    
    saveAgenda(db);
};

module.exports = { 
    getAgenda, 
    validateBusinessRules, 
    checkAvailability, 
    bookAppointment, 
    isDateInPast 
};
