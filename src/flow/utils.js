const { getSettings } = require('../database');

const getEditDistance = (a, b) => {
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;
    const matrix = [];
    for (let i = 0; i <= b.length; i++) { matrix[i] = [i]; }
    for (let j = 0; j <= a.length; j++) { matrix[0][j] = j; }
    for (let i = 1; i <= b.length; i++) {
        for (let j = 1; j <= a.length; j++) {
            if (b.charAt(i - 1) === a.charAt(j - 1)) {
                matrix[i][j] = matrix[i - 1][j - 1];
            } else {
                matrix[i][j] = Math.min(matrix[i - 1][j - 1] + 1, Math.min(matrix[i][j - 1] + 1, matrix[i - 1][j] + 1));
            }
        }
    }
    return matrix[b.length][a.length];
};

const normalizeText = (str) => {
    if (!str) return "";
    return str.toLowerCase()
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "") 
        .replace(/[^a-z0-9 ]/g, "")  
        .trim()
        .replace(/\s+/g, ' '); 
};

const collapseChars = (str) => {
    return str.replace(/(.)\1+/g, '$1');
};

const isSimilar = (input, keyword) => {
    if (!input || !keyword) return false;
    
    const cleanInput = normalizeText(input);
    const cleanKeyword = normalizeText(keyword);
    
    if (cleanInput === cleanKeyword) return true;
    if (collapseChars(cleanInput) === collapseChars(cleanKeyword)) return true;
    if (cleanKeyword.length > 4 && cleanInput.includes(cleanKeyword)) return true;
    
    const distance = getEditDistance(cleanInput, cleanKeyword);
    
    let maxErrors = 0; 
    if (cleanKeyword.length > 7) maxErrors = 2;       
    else if (cleanKeyword.length > 3) maxErrors = 1;  
    
    return distance <= maxErrors;
};

const analyzeNaturalLanguage = (text) => {
    const response = { date: null, time: null };

    let strForTime = text.toLowerCase(); 
    const lower = normalizeText(text);

    const settings = getSettings();
    const tz = settings.timezone || "America/Matamoros"; 
    
    const now = new Date();
    const mxDateStr = now.toLocaleString("en-US", {timeZone: tz});
    const todayMx = new Date(mxDateStr); 

    let targetDate = new Date(todayMx); 

    // --- A. DETECCIÓN DE FECHA ---
    
    const monthMap = {
        'enero': 1, 'febrero': 2, 'marzo': 3, 'abril': 4,
        'mayo': 5, 'junio': 6, 'julio': 7, 'agosto': 8,
        'septiembre': 9, 'octubre': 10, 'noviembre': 11, 'diciembre': 12
    };

    const naturalDateRegex = /\b(\d{1,2})\s+(?:de\s+)?(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)(?:\s+(?:de|del)\s+(\d{2,4}))?\b/;
    const numericDateRegex = /\b(\d{1,2})[\/\-\.](\d{1,2})(?:[\/\-\.](\d{2,4}))?\b/;

    const naturalMatch = lower.match(naturalDateRegex); 
    const numericMatch = strForTime.match(numericDateRegex);

    if (naturalMatch) {
        const day = parseInt(naturalMatch[1]);
        const month = monthMap[naturalMatch[2]];
        let year = naturalMatch[3] ? parseInt(naturalMatch[3]) : todayMx.getFullYear();
        if (year < 100) year += 2000;

        const tentativeDate = new Date(year, month - 1, day);
        if (!naturalMatch[3] && tentativeDate < todayMx) year++; 

        response.date = `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
        
        strForTime = strForTime.replace(naturalDateRegex, ' ');
    }
    else if (numericMatch) {
        const day = parseInt(numericMatch[1]);
        const month = parseInt(numericMatch[2]);
        let year = numericMatch[3] ? parseInt(numericMatch[3]) : todayMx.getFullYear();
        if (year < 100) year += 2000;

        const tentativeDate = new Date(year, month - 1, day);
        if (!numericMatch[3] && tentativeDate < todayMx) year++; 

        response.date = `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;

        strForTime = strForTime.replace(numericDateRegex, ' ');
    }
    else {
        let dayFound = false;
        const dias = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];
        for (let i = 0; i < dias.length; i++) {
            if (lower.includes(dias[i])) {
                const currentDay = todayMx.getDay();
                let diff = i - currentDay;
                if (diff <= 0) diff += 7;
                if (diff === 7 && lower.includes('hoy')) diff = 0;

                targetDate.setDate(todayMx.getDate() + diff);
                response.date = formatDate(targetDate);
                dayFound = true;
                break;
            }
        }

        if (!dayFound) {
            if (lower.includes('pasado manana')) {
                targetDate.setDate(todayMx.getDate() + 2);
                response.date = formatDate(targetDate);
            }
            else if (lower.includes('hoy')) {
                response.date = formatDate(targetDate);
            }
            else if (lower.includes('manana')) {
                if (!lower.includes('en la manana') && 
                    !lower.includes('por la manana') && 
                    !lower.includes('de la manana') && 
                    !lower.includes('la manana')) {
                    targetDate.setDate(todayMx.getDate() + 1);
                    response.date = formatDate(targetDate);
                }
            }
        }
    }

    // --- B. DETECCIÓN DE HORA (NUEVA LÓGICA INTELIGENTE) ---
    let h = null, m = '00';
    let isPM = false;
    let isAM = false;

    // Estandarizamos los indicadores para no batallar con los puntos
    const timeStr = strForTime.replace(/\./g, ''); 

    // 1. Regex de formato exacto (Ej: "1:00 pm", "14:00", "02:30 hrs")
    const colonMatch = timeStr.match(/\b([01]?[0-9]|2[0-3]):([0-5][0-9])(?:\s*(am|pm|hrs|horas))?\b/i);
    // 2. Solo el número con AM/PM (Ej: "1 pm", "10 am")
    const ampmMatch = timeStr.match(/\b(1[0-2]|[1-9])\s*(am|pm)\b/i);
    // 3. Modificadores coloquiales (Ej: "3 de la tarde")
    const coloquialMatch = timeStr.match(/\b([01]?[0-9]|2[0-3])\s*(?:de la|en la|por la)\s*(manana|tarde|noche)\b/i);
    // 4. A las horas (Ej: "A las 4")
    const aLasMatch = timeStr.match(/a\s*l[a|o]s\s*([01]?[0-9]|2[0-3])\b/i);
    // 5. Horas solas (Ej: "16 hrs")
    const hrsMatch = timeStr.match(/\b([01]?[0-9]|2[0-3])\s*(hrs|horas)\b/i);

    // Diccionario de horas habladas
    const wordHours = {
        'una': 1, 'dos': 2, 'tres': 3, 'cuatro': 4, 'cinco': 5,
        'seis': 6, 'siete': 7, 'ocho': 8, 'nueve': 9, 'diez': 10,
        'once': 11, 'doce': 12, 'mediodia': 12, 'medio dia': 12
    };

    if (colonMatch) {
        h = parseInt(colonMatch[1]);
        m = colonMatch[2];
        if (colonMatch[3] && colonMatch[3].toLowerCase() === 'pm') isPM = true;
        if (colonMatch[3] && colonMatch[3].toLowerCase() === 'am') isAM = true;
    } else if (ampmMatch) {
        h = parseInt(ampmMatch[1]);
        if (ampmMatch[2].toLowerCase() === 'pm') isPM = true;
        if (ampmMatch[2].toLowerCase() === 'am') isAM = true;
    } else if (coloquialMatch) {
        h = parseInt(coloquialMatch[1]);
        const periodoStr = coloquialMatch[2].toLowerCase();
        if (periodoStr === 'tarde' || periodoStr === 'noche') isPM = true;
        if (periodoStr === 'manana') isAM = true;
    } else if (hrsMatch) {
        h = parseInt(hrsMatch[1]);
    } else if (aLasMatch) {
        h = parseInt(aLasMatch[1]);
    } else {
        // Buscamos si usó palabras como "una" o "mediodía"
        for (const [word, num] of Object.entries(wordHours)) {
            if (new RegExp(`\\b${word}\\b`, 'i').test(timeStr)) {
                h = num;
                if (/\b(pm|tarde|noche)\b/.test(timeStr)) isPM = true;
                if (/\b(am|manana|madrugada)\b/.test(timeStr)) isAM = true;
                break;
            }
        }
    }

    if (h !== null) {
        // Corrección a formato 24hrs si detectamos PM
        if (isPM && h < 12) h += 12;
        // Corrección de medianoche si detectamos AM
        if (isAM && h === 12) h = 0;

        // Asunciones lógicas: Si dice "1", "2" o "3" sin AM/PM, lo pasamos a la tarde.
        if (!isPM && !isAM && h >= 1 && h <= 7) {
            h += 12;
        }

        response.time = `${String(h).padStart(2, '0')}:${m}`;
    }

    return response;
};

const formatDate = (date) => {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
};

module.exports = { normalizeText, isSimilar, analyzeNaturalLanguage };
