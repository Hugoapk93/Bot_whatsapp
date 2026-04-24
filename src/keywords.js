const { getKeywords } = require('./database');
const { isSimilar } = require('./flow/utils');

const normalize = (str) => {
    return (str || '').toLowerCase()
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "") 
        .trim();
};

const findKeywordMatch = (incomingText) => {
    if (!incomingText) return null;

    // 🔥 REGLA ÚNICA Y ABSOLUTA: Si no tiene signo de interrogación, abortamos de inmediato.
    const isQuestion = incomingText.includes('?') || incomingText.includes('¿');
    if (!isQuestion) return null;

    const keywordsDB = getKeywords(); 
    const cleanText = normalize(incomingText);

    const match = keywordsDB.find(rule => {
        // 🔥 Seguimos bloqueando las dudas pendientes para no enviar respuestas en blanco
        if (!rule.answer || rule.answer.trim() === '') {
            return false; 
        }

        const phrases = rule.keywords.split(',').map(k => normalize(k));
        
        return phrases.some(phrase => {
            if (phrase.length <= 2) return false;

            // Verificación Inteligente y Flexible (Solo llega aquí si es una pregunta válida)
            const msgWords = cleanText.split(' ').filter(w => w.length > 3);
            const phraseWords = phrase.split(' ').filter(w => w.length > 3);

            if (msgWords.length > 0 && phraseWords.length > 0) {
                // Evaluamos si las palabras de la pregunta se parecen a las de tu base de datos
                const matchFound = phraseWords.some(pWord => 
                    msgWords.some(mWord => isSimilar(mWord, pWord))
                );

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
