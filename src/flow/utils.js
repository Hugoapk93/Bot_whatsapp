// --- UTILIDADES DE TEXTO Y FECHAS (Optimizado con Anti-Repetición) ---

// 1. Algoritmo de Distancia (Levenshtein) nativo
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
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // Quitar acentos (sí -> si)
        .replace(/[^a-z0-9 ]/g, "")  // Solo letras y números
        .trim()
        .replace(/\s+/g, ' '); 
};

// 🔥 HELPER NUEVO: Colapsar letras repetidas (ej: "siii" -> "si", "nooo" -> "no")
const collapseChars = (str) => {
    return str.replace(/(.)\1+/g, '$1');
};

// 3. Comparación inteligente (Fuzzy Match Mejorado)
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

// 4. Inteligencia para Fechas (CON FIX ANTI-COLISIÓN DE NÚMEROS)
const analyzeNaturalLanguage = (text) => {
    const response = { date: null, time: null };
    
    // Usamos el texto original (en minúsculas) para buscar horas y fechas con / o :
    let strForTime = text.toLowerCase(); 
    // Usamos el texto normalizado (sin símbolos) para buscar palabras clave (lunes, hoy, etc)
    const lower = normalizeText(text);

    const now = new Date();
    const mxDateStr = now.toLocaleString("en-US", {timeZone: "America/Mexico_City"});
    const todayMx = new Date(mxDateStr); 

    let targetDate = new Date(todayMx); 

    // --- A. DETECCIÓN DE FECHA ---
    const dateRegex = /\b(\d{1,2})[\/\-\.](\d{1,2})(?:[\/\-\.](\d{2,4}))?\b/;
    const dateMatch = strForTime.match(dateRegex); 

    if (dateMatch) {
        const day = parseInt(dateMatch[1]);
        const month = parseInt(dateMatch[2]);
        let year = dateMatch[3] ? parseInt(dateMatch[3]) : todayMx.getFullYear();
        if (year < 100) year += 2000;

        const tentativeDate = new Date(year, month - 1, day);
        if (!dateMatch[3] && tentativeDate < todayMx) year++; 

        response.date = `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
        
        // 🔥 MAGIA ANTI-COLISIÓN: Borramos la fecha detectada del string original 
        // para que esos números no se confundan con la hora más adelante.
        strForTime = strForTime.replace(dateRegex, ' ');
    }
    // Fechas relativas
    else if (lower.includes('manana')) {
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
    // Días de la semana
    else {
        const dias = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];
        for (let i = 0; i < dias.length; i++) {
            if (lower.includes(dias[i])) {
                const currentDay = todayMx.getDay();
                let diff = i - currentDay;
                if (diff <= 0) diff += 7;
                if (diff === 7 && lower.includes('hoy')) diff = 0;

                targetDate.setDate(todayMx.getDate() + diff);
                response.date = formatDate(targetDate);
                break;
            }
        }
    }

    // --- B. DETECCIÓN DE HORA (usando strForTime limpio de fechas) ---
    // Usamos regex más estrictos que requieren contexto, no solo un número suelto
    const exactTimeMatch = strForTime.match(/\b([01]?[0-9]|2[0-3]):([0-5][0-9])\b/); // ej: 16:00
    const ampmMatch = strForTime.match(/\b(1[0-2]|[1-9])\s*(am|pm|a\.m\.|p\.m\.)\b/i); // ej: 4 pm
    const aLasMatch = strForTime.match(/a\s*l[a|o]s\s*([01]?[0-9]|2[0-3])\b/); // ej: a las 4
    const hrsMatch = strForTime.match(/\b([01]?[0-9]|2[0-3])\s*(hrs|horas)\b/); // ej: 16 hrs

    let h = null, m = '00';

    if (exactTimeMatch) {
        h = parseInt(exactTimeMatch[1]);
        m = exactTimeMatch[2];
    } else if (ampmMatch) {
        h = parseInt(ampmMatch[1]);
        const period = ampmMatch[2].toLowerCase().replace(/\./g, '');
        if (period === 'pm' && h < 12) h += 12;
        if (period === 'am' && h === 12) h = 0;
    } else if (aLasMatch) {
        h = parseInt(aLasMatch[1]);
        if (h >= 1 && h <= 7) h += 12; // Asumir que "a las 4" es 16:00
    } else if (hrsMatch) {
        h = parseInt(hrsMatch[1]);
    }

    if (h !== null) {
        response.time = `${String(h).padStart(2, '0')}:${m}`;
    }

    // Si detectó algo para el mismo día pero no lo guardó arriba
    if (!response.date && (lower.includes('manana') || lower.includes('hoy'))) {
         response.date = formatDate(targetDate);
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
