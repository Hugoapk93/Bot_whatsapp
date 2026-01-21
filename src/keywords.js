const { getKeywords } = require('./database');

// Normaliza texto: quita acentos, emojis raros y lo pasa a minúsculas
const normalize = (str) => {
    return (str || '').toLowerCase()
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // Quitar acentos
        .trim();
};

const findKeywordMatch = (incomingText) => {
    if (!incomingText) return null;

    const keywordsDB = getKeywords(); // Traemos las reglas de la BD
    const cleanText = normalize(incomingText);

    // Buscamos si alguna regla coincide
    // Una regla puede tener varias frases separadas por coma (ej: "precio, costo, vale")
    const match = keywordsDB.find(rule => {
        const phrases = rule.keywords.split(',').map(k => normalize(k));
        
        // Revisamos si ALGUNA de las frases está dentro del mensaje del cliente
        return phrases.some(phrase => {
            // Opción A: Coincidencia exacta (más estricto)
            // return cleanText === phrase;
            
            // Opción B: Contenido (más flexible, detecta "hola cual es el precio por favor")
            return cleanText.includes(phrase) && phrase.length > 2; // >2 para evitar falsos positivos cortos
        });
    });

    return match || null;
};

module.exports = { findKeywordMatch };
