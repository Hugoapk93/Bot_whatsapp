// --- UTILIDADES DE TEXTO Y FECHAS (Optimizado 2025) ---

// 1. Algoritmo de Distancia (Levenshtein) nativo
// Mantenemos esta joya, es eficiente y sin dependencias.
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

// 2. Normalizar texto (Mejorada)
const normalizeText = (str) => {
    if (!str) return "";
    return str.toLowerCase()
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // Quitar acentos
        // Permitimos letras, números y espacios. Eliminamos puntuación excesiva.
        .replace(/[^a-z0-9 ]/g, "") 
        .trim()
        .replace(/\s+/g, ' '); // Colapsar espacios múltiples
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
    
    // Ajuste dinámico de tolerancia
    // < 4 letras: Debe ser exacto (ej: "si", "no", "pan")
    // 4-7 letras: 1 error
    // > 7 letras: 2 errores
    let maxErrors = 0;
    if (cleanKeyword.length > 7) maxErrors = 2;
    else if (cleanKeyword.length > 3) maxErrors = 1;
    
    return distance <= maxErrors;
};

// 4. Inteligencia para Fechas (SIN CHRONO-NODE)
const analyzeNaturalLanguage = (text) => {
    const response = { date: null, time: null };
    const lower = normalizeText(text);

    // --- A. OBTENER FECHA BASE (HORA MÉXICO REAL) ---
    const now = new Date();
    // Forzamos "en-US" para obtener formato consistente MM/DD/YYYY
    const mxDateStr = now.toLocaleString("en-US", {timeZone: "America/Mexico_City"});
    const todayMx = new Date(mxDateStr); 

    let targetDate = new Date(todayMx); // Copia para manipular

    // --- B. DETECTAR FECHAS RELATIVAS ---
    if (lower.includes('manana')) {
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
        response.date = formatDate(targetDate);
    }

    // --- C. DETECTAR DÍAS DE LA SEMANA ---
    const dias = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];
    dias.forEach((dia, index) => {
        // "el lunes", "proximo martes", "este viernes"
        if (lower.includes(dia)) {
            const currentDay = todayMx.getDay(); // 0-6
            let diff = index - currentDay;
            
            // Si el día ya pasó o es hoy, asumimos la próxima semana 
            if (diff <= 0) {
                diff += 7;
            }
            // Si dicen "hoy lunes", corregimos
            if (diff === 7 && lower.includes('hoy')) diff = 0;

            targetDate.setDate(todayMx.getDate() + diff);
            response.date = formatDate(targetDate);
        }
    });

    // --- D. DETECTAR FECHAS EXACTAS (24/12, 24-05) ---
    const dateMatch = text.match(/(\d{1,2})[\/.-](\d{1,2})/); 
    if (dateMatch) {
        const day = parseInt(dateMatch[1]);
        const month = parseInt(dateMatch[2]);
        let year = todayMx.getFullYear();
        
        // Crear fecha tentativa este año
        // Nota: Mes en JS es 0-11
        const tentativeDate = new Date(year, month - 1, day);
        
        // Si la fecha ya pasó (ej: hoy es Mayo y piden Febrero), es el otro año
        if (tentativeDate < todayMx) {
            year++;
        }
        
        response.date = `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
    }

    // --- E. DETECTAR HORAS (Con Inferencia de Negocio) ---
    // Soporta: 4pm, 4:30pm, 16:00, 10 am, "a las 5"
    const timeMatch = text.match(/(\d{1,2})(:(\d{2}))?\s?(am|pm|a\.m\.|p\.m\.)?/i);
    
    if (timeMatch) {
        let h = parseInt(timeMatch[1]);
        let m = timeMatch[3] ? parseInt(timeMatch[3]) : 0;
        const period = timeMatch[4] ? timeMatch[4].toLowerCase().replace(/\./g, '') : null;

        // Lógica AM/PM explícita
        if (period === 'pm' && h < 12) h += 12;
        if (period === 'am' && h === 12) h = 0;
        
        // Lógica IMPLÍCITA (Inferencia de Negocio)
        // Si no dicen AM/PM y la hora es pequeña (1, 2, 3, 4, 5, 6, 7), 
        // asumimos que es PM porque nadie atiende a las 2 de la mañana.
        if (!period && h > 0 && h < 8) {
            h += 12;
        }

        response.time = `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
    }

    // Fallback: Si detectamos intención relativa pero no fecha calculada
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
