const chrono = require('chrono-node');

// Normalizar texto (quita acentos y mayúsculas)
const normalizeText = (str) => {
    if (!str) return "";
    return str.toLowerCase()
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
        .trim();
};

// Comparación inteligente (Fuzzy Match)
const isSimilar = (input, keyword) => {
    if (!input || !keyword) return false;
    
    const cleanInput = normalizeText(input);
    const cleanKeyword = normalizeText(keyword);
    
    if (cleanInput === cleanKeyword) return true;
    if (cleanKeyword.length < 4) return cleanInput === cleanKeyword;
    if (cleanInput.includes(cleanKeyword)) return true;
    
    let errors = 0;
    const maxErrors = Math.floor(cleanKeyword.length / 3); 
    if (Math.abs(cleanInput.length - cleanKeyword.length) > maxErrors) return false;

    let i = 0, j = 0;
    while (i < cleanInput.length && j < cleanKeyword.length) {
        if (cleanInput[i] !== cleanKeyword[j]) {
            errors++;
            if (errors > maxErrors) return false;
            if (cleanInput.length > cleanKeyword.length) i++;
            else if (cleanKeyword.length > cleanInput.length) j++;
            else { i++; j++; }
        } else {
            i++; j++;
        }
    }
    return true;
};

// Inteligencia Artificial para Fechas (NLP)
const analyzeNaturalLanguage = (text) => {
    const results = chrono.es.parse(text, new Date(), { forwardDate: true });
    if (results.length === 0) return { date: null, time: null };

    const result = results[0];
    const components = result.start; 

    let detectedDate = null;
    let detectedTime = null;

    if (components.isCertain('day') || components.isCertain('weekday')) {
        const dateObj = components.date();
        const yyyy = dateObj.getFullYear();
        const mm = String(dateObj.getMonth() + 1).padStart(2, '0');
        const dd = String(dateObj.getDate()).padStart(2, '0');
        detectedDate = `${yyyy}-${mm}-${dd}`;
    }

    if (components.isCertain('hour')) {
        const dateObj = components.date();
        const hh = String(dateObj.getHours()).padStart(2, '0');
        const min = String(dateObj.getMinutes()).padStart(2, '0');
        detectedTime = `${hh}:${min}`;
    }

    return { date: detectedDate, time: detectedTime };
};

module.exports = { normalizeText, isSimilar, analyzeNaturalLanguage };
