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
    // Esta expresión regular busca cualquier caracter (.) seguido de sí mismo (\1) una o más veces (+)
    // y lo reemplaza por una sola instancia del caracter ($1)
    return str.replace(/(.)\1+/g, '$1');
};

// 3. Comparación inteligente (Fuzzy Match Mejorado)
const isSimilar = (input, keyword) => {
    if (!input || !keyword) return false;
    
    const cleanInput = normalizeText(input);
    const cleanKeyword = normalizeText(keyword);
    
    // A) Coincidencia exacta
    if (cleanInput === cleanKeyword) return true;

    // B) 🔥 MAGIA DE REPETICIÓN: "sii" vs "si"
    // Si al quitar las letras repetidas son iguales, es match.
    // Ejemplo: usuario "siii" -> "si"  ===  bot "si" -> "si" -> TRUE
    if (collapseChars(cleanInput) === collapseChars(cleanKeyword)) return true;
    
    // C) Contención (si keyword es larga)
    if (cleanKeyword.length > 4 && cleanInput.includes(cleanKeyword)) return true;
    
    // D) Distancia Levenshtein (Errores de dedo reales como "so" en vez de "si")
    const distance = getEditDistance(cleanInput, cleanKeyword);
    
    // Ajuste dinámico de tolerancia
    // < 4 letras: Debe ser exacto (salvo por repeticiones que ya cubrimos arriba)
    let maxErrors = 0; 
    
    if (cleanKeyword.length > 7) maxErrors = 2;       // Palabras largas aguantan 2 errores
    else if (cleanKeyword.length > 3) maxErrors = 1;  // Palabras medias aguantan 1 error
    
    return distance <= maxErrors;
};

// 4. Inteligencia para Fechas
const analyzeNaturalLanguage = (text) => {
    const response = { date: null, time: null };
    const lower = normalizeText(text);

    const now = new Date();
    const mxDateStr = now.toLocaleString("en-US", {timeZone: "America/Mexico_City"});
    const todayMx = new Date(mxDateStr); 

    let targetDate = new Date(todayMx); 

    // Fechas relativas
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

    // Días de la semana
    const dias = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];
    dias.forEach((dia, index) => {
        if (lower.includes(dia)) {
            const currentDay = todayMx.getDay();
            let diff = index - currentDay;
            if (diff <= 0) diff += 7;
            if (diff === 7 && lower.includes('hoy')) diff = 0;

            targetDate.setDate(todayMx.getDate() + diff);
            response.date = formatDate(targetDate);
        }
    });

    // Fechas exactas (24/12)
    const dateMatch = text.match(/(\d{1,2})[\/.-](\d{1,2})/); 
    if (dateMatch) {
        const day = parseInt(dateMatch[1]);
        const month = parseInt(dateMatch[2]);
        let year = todayMx.getFullYear();
        const tentativeDate = new Date(year, month - 1, day);
        if (tentativeDate < todayMx) year++;
        response.date = `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
    }

    // Horas
    const timeMatch = text.match(/(\d{1,2})(:(\d{2}))?\s?(am|pm|a\.m\.|p\.m\.)?/i);
    if (timeMatch) {
        let h = parseInt(timeMatch[1]);
        let m = timeMatch[3] ? parseInt(timeMatch[3]) : 0;
        const period = timeMatch[4] ? timeMatch[4].toLowerCase().replace(/\./g, '') : null;

        if (period === 'pm' && h < 12) h += 12;
        if (period === 'am' && h === 12) h = 0;
        if (!period && h > 0 && h < 8) h += 12;

        response.time = `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
    }

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
