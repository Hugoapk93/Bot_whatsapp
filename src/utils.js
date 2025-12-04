const delay = (ms) => new Promise((res) => setTimeout(res, ms));

const typing = async (sock, jid, textLength = 0) => {
    if (!sock) return;
    await sock.sendPresenceUpdate('composing', jid);
    let ms = 1500 + (textLength * 30) + (Math.random() * 500);
    if (ms > 5000) ms = 5000;
    await delay(ms);
    await sock.sendPresenceUpdate('paused', jid);
};

// --- NUEVAS FUNCIONES PARA NOMBRES ---

const formatName = (name) => {
    // Convierte "JUAN PEREZ" a "Juan Perez"
    if (!name) return '';
    return name.toLowerCase().replace(/\b\w/g, l => l.toUpperCase());
};

const getFirstName = (fullName) => {
    // Extrae solo "Juan" de "Juan Perez"
    if (!fullName) return '';
    return fullName.trim().split(' ')[0]; 
};

module.exports = { delay, typing, formatName, getFirstName };
