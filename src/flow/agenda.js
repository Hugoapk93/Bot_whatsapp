const fs = require('fs').promises; 
const path = require('path');
const { getSettings } = require('../database');

const agendaPath = path.join(__dirname, '../../data/agenda.json');
const tempAgendaPath = path.join(__dirname, '../../data/agenda.tmp.json'); 

// --- 1. MANEJO DE ARCHIVOS ---
const getAgenda = async () => {
    try {
        const data = await fs.readFile(agendaPath, 'utf-8');
        return JSON.parse(data);
    } catch (e) {
        if (e.code !== 'ENOENT') console.error('Error leyendo agenda:', e);
        return {};
    }
};

const saveAgenda = async (data) => {
    try {
        await fs.writeFile(tempAgendaPath, JSON.stringify(data, null, 2));
        await fs.rename(tempAgendaPath, agendaPath);
    } catch (e) {
        console.error('CRITICAL: No se pudo guardar la agenda:', e);
    }
};

// --- 2. HELPERS DE TIEMPO ---
const TIMEZONE = "America/Mexico_City";

const getMxDate = () => {
    const now = new Date();
    const isoParams = now.toLocaleString("en-US", { timeZone: TIMEZONE });
    return new Date(isoParams);
};

// 🔥 NUEVO: Helper de Fecha Amigable (Necesario para handlers.js)
const friendlyDate = (dateStr) => {
    if(!dateStr) return dateStr;
    const [y, m, d] = dateStr.split('-').map(Number);
    const date = new Date(y, m - 1, d);

    const dias = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
    const diaSemana = dias[date.getDay()]; // 0 = Domingo

    return `${diaSemana} ${d}/${m}/${y}`;
};

const timeToMinutes = (timeStr) => {
    if(!timeStr) return -1;
    const [h, m] = timeStr.split(':').map(Number);
    return (h * 60) + m;
};

// --- VALIDACIONES ---

const isDateInPast = (dateStr, timeStr) => {
    const nowMx = getMxDate();
    const year = nowMx.getFullYear();
    const month = String(nowMx.getMonth() + 1).padStart(2, '0');
    const day = String(nowMx.getDate()).padStart(2, '0');
    const todayStr = `${year}-${month}-${day}`;

    if (dateStr < todayStr) return true;

    if (dateStr === todayStr && timeStr) {
        const currentMinutes = (nowMx.getHours() * 60) + nowMx.getMinutes();
        const citaMinutes = timeToMinutes(timeStr);
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

    if (startMins < endMins) {
        return currentMins < startMins || currentMins >= endMins;
    } else {
        return !(currentMins >= startMins || currentMins < endMins);
    }
};

const validateBusinessRules = (timeStr) => {
    const settings = getSettings();
    if (!timeStr) return { valid: false, reason: "Falta la hora." };

    const [h, m] = timeStr.split(':').map(Number);
    if (m % 30 !== 0) return { valid: false, reason: "Solo agendamos en horas exactas o medias (ej: 4:00, 4:30)." };

    const reqMins = (h * 60) + m;
    const sStart = settings.schedule?.start || "09:00";
    const sEnd = settings.schedule?.end || "18:00";
    const startMins = timeToMinutes(sStart);
    const endMins = timeToMinutes(sEnd);

    let isClosed = false;
    if (startMins < endMins) {
        if (reqMins < startMins || reqMins >= endMins) isClosed = true;
    } else {
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
    const db = await getAgenda(); 
    if (db[date] && db[date].some(c => c.time === time)) return false;
    return true;
};

const bookAppointment = async (date, time, phone, name) => {
    const db = await getAgenda();
    if (!db[date]) db[date] = [];
    if (db[date].some(c => c.time === time)) return false;

    db[date].push({ time, phone, name, created_at: new Date().toISOString() });
    db[date].sort((a, b) => a.time.localeCompare(b.time));

    await saveAgenda(db);
    return true;
};

module.exports = {
    getAgenda,
    validateBusinessRules,
    checkAvailability,
    bookAppointment,
    isDateInPast,
    isBusinessClosed,
    friendlyDate
};
