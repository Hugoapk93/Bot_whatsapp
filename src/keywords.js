const { getKeywords } = require('./database');
const { isSimilar } = require('./flow/utils'); // Importamos la inteligencia ortográfica

// Normaliza texto: quita acentos, emojis raros y lo pasa a minúsculas
const normalize = (str) => {
    return (str || '').toLowerCase()
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // Quitar acentos
        .trim();
};

const findKeywordMatch = (incomingText) => {
    if (!incomingText) return null;

    const keywordsDB = getKeywords(); 
    const cleanText = normalize(incomingText);
    
    // 🔥 Detectamos si el usuario hizo una pregunta explícita
    const isQuestion = incomingText.includes('?') || incomingText.includes('¿');

    const match = keywordsDB.find(rule => {
        const phrases = rule.keywords.split(',').map(k => normalize(k));
        
        return phrases.some(phrase => {
            if (phrase.length <= 2) return false;

            // 1. Verificación rápida (si escribe tal cual lo guardaste o está contenido)
            if (cleanText === phrase || cleanText.includes(phrase)) {
                return true;
            }

            // 2. Verificación Inteligente con isSimilar (Tolerancia a errores)
            const msgWords = cleanText.split(' ').filter(w => w.length > 3);
            const phraseWords = phrase.split(' ').filter(w => w.length > 3);

            if (msgWords.length > 0 && phraseWords.length > 0) {
                const matchFound = phraseWords.some(pWord => 
                    msgWords.some(mWord => isSimilar(mWord, pWord))
                );

                // Si encontramos palabras similares y además es una pregunta, hace match perfecto
                if (matchFound && isQuestion) {
                    return true;
                }
                
                // Si encontramos palabras muy similares aunque no haya puesto el signo, también lo valemos
                if (matchFound) {
                    return true;
                }
            }
            
            return false;
        });
    });

    return match || null;
};

module.exports = { findKeywordMatch };
