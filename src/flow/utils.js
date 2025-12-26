// --- UTILIDADES DE TEXTO Y FECHAS (Blindado para México) ---

// 1. Algoritmo de Distancia (Levenshtein) nativo
// (Para no depender de librerías externas)
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

// 2. Normalizar texto
const normalizeText = (str) => {
    if (!str) return "";
    return str.toLowerCase()
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // Quitar acentos
        .replace(/[^a-z0-9 ]/g, "") // Quitar caracteres raros
        .trim();
};

// 3. Comparación inteligente (Fuzzy Match)
const isSimilar = (input, keyword) => {
    if (!input || !keyword) return false;
    
    const cleanInput = normalizeText(input);
    const cleanKeyword = normalizeText(keyword);
    
    // Coincidencia exacta
    if (cleanInput === cleanKeyword) return true;
    
    // Contención (si keyword es larga)
    if (cleanKeyword.length > 4 && cleanInput.includes(cleanKeyword)) return true;
    
    // Distancia Levenshtein (Errores de dedo)
    const distance = getEditDistance(cleanInput, cleanKeyword);
    // Permitimos 1 error por cada 4 letras aprox
    const maxErrors = Math.floor(cleanKeyword.length / 4) || 1;
    
    return distance <= maxErrors && cleanKeyword.length > 3;
};

// 4. Inteligencia para Fechas (SIN CHRONO-NODE)
// Fuerza la zona horaria de México para evitar errores nocturnos
const analyzeNaturalLanguage = (text) => {
    const response = { date: null, time: null };
    const lower = normalizeText(text);

    // --- A. OBTENER FECHA BASE (HORA MÉXICO REAL) ---
    // Esto es lo que arregla el bug de las 18:38 PM
    const now = new Date();
    const mxDateStr = now.toLocaleString("en-US", {timeZone: "America/Mexico_City"});
    const todayMx = new Date(mxDateStr); 

    let targetDate = new Date(todayMx); // Copia para manipular

    // --- B. DETECTAR FECHAS RELATIVAS ---
    if (lower.includes('manana')) {
        // Evitar "en la mañana" como fecha
        if (!lower.includes('en la manana') && !lower.includes('por la manana')) {
            targetDate.setDate(todayMx.getDate() + 1);
            response.date = formatDate(targetDate);
        }
    } 
    else if (lower.includes('pasado manana')) {
        targetDate.setDate(todayMx.getDate() + 2);
        response.date = formatDate(targetDate);
    }
    else if (lower.includes('hoy')) {
        // Se mantiene la fecha de hoy (México)
        response.date = formatDate(targetDate);
    }

    // --- C. DETECTAR DÍAS DE LA SEMANA ---
    const dias = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];
    dias.forEach((dia, index) => {
        if (lower.includes(dia)) {
            const currentDay = todayMx.getDay(); // 0-6
            let diff = index - currentDay;
            
            // Si el día ya pasó o es hoy, asumimos la próxima semana 
            // (Excepto si dicen explícitamente "hoy es lunes")
            if (diff <= 0) {
                diff += 7;
            }
            // Ajuste fino: si hoy es Lunes y dicen "Lunes", puede ser hoy o el próximo.
            // Si el usuario dice "el lunes" usualmente es futuro. Si dice "hoy lunes" es hoy.
            if (diff === 7 && lower.includes('hoy')) diff = 0;

            targetDate.setDate(todayMx.getDate() + diff);
            response.date = formatDate(targetDate);
        }
    });

    // --- D. DETECTAR FECHAS EXACTAS (24/12, 24 de dic) ---
    // Regex para DD/MM o DD-MM
    const dateMatch = text.match(/(\d{1,2})[\/.-](\d{1,2})/); 
    if (dateMatch) {
        const day = parseInt(dateMatch[1]);
        const month = parseInt(dateMatch[2]);
        let year = todayMx.getFullYear();
        
        // Si estamos en Dic y piden Enero, es el año siguiente
        if (todayMx.getMonth() + 1 === 12 && month === 1) {
            year++;
        }
        response.date = `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
    }

    // --- E. DETECTAR HORAS ---
    // Soporta: 4pm, 4:30pm, 16:00, 10 am
    const timeMatch = text.match(/(\d{1,2})(:(\d{2}))?\s?(am|pm|a\.m\.|p\.m\.)?/i);
    
    if (timeMatch) {
        let h = parseInt(timeMatch[1]);
        let m = timeMatch[3] ? parseInt(timeMatch[3]) : 0;
        const period = timeMatch[4] ? timeMatch[4].toLowerCase().replace(/\./g, '') : null;

        // Convertir a 24h
        if (period === 'pm' && h < 12) h += 12;
        if (period === 'am' && h === 12) h = 0;
        
        response.time = `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
    }

    // Si detectamos intención relativa (mañana/hoy) pero no se calculó fecha arriba
    if (!response.date && (lower.includes('manana') || lower.includes('hoy'))) {
         response.date = formatDate(targetDate);
    }

    return response;
};

// Helper: Formato YYYY-MM-DD
const formatDate = (date) => {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
};

module.exports = { normalizeText, isSimilar, analyzeNaturalLanguage };
