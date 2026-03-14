// --- NORMALIZADORES ---

const normalizeName = (text) => {
    if (!text) return '';
    // Quitamos espacios extra a los lados y dividimos por palabras
    const words = text.trim().toLowerCase().split(/\s+/);
    
    // Palabras que no llevan mayúscula inicial (conectores comunes en español)
    const stopWords = ['de', 'del', 'la', 'las', 'los', 'y'];
    
    // Capitalizamos la primera letra de cada palabra
    const capitalized = words.map((word, index) => {
        // Si es un conector y no es la primera palabra, se queda en minúscula
        if (index > 0 && stopWords.includes(word)) return word;
        return word.charAt(0).toUpperCase() + word.slice(1);
    });
    
    return capitalized.join(' ');
};

const normalizeDate = (text) => {
    if (!text) return text;
    let str = text.toLowerCase().trim();

    // Diccionario para traducir meses de texto a número
    const months = {
        'enero': '01', 'febrero': '02', 'marzo': '03', 'abril': '04',
        'mayo': '05', 'junio': '06', 'julio': '07', 'agosto': '08',
        'septiembre': '09', 'octubre': '10', 'noviembre': '11', 'diciembre': '12'
    };

    // Reemplazamos los meses escritos por su equivalente en número
    for (const [mName, mNum] of Object.entries(months)) {
        if (str.includes(mName)) {
            // Usamos RegExp para reemplazar la palabra exacta
            str = str.replace(new RegExp(`\\b${mName}\\b`, 'g'), mNum);
        }
    }

    // Extraemos todos los bloques de números que quedaron (ej: "9 de 06 del 98" -> ["9", "06", "98"])
    const parts = str.match(/\d+/g);
    
    // Si no encontró exactamente 3 partes (día, mes, año), devolvemos el original para que tu validador marque el error
    if (!parts || parts.length < 3) return text; 

    let day = parts[0].padStart(2, '0');
    let month = parts[1].padStart(2, '0');
    let yearStr = parts[2];

    // Magia para años de 2 dígitos (ej. "98" -> 1998, "05" -> 2005)
    if (yearStr.length === 2) {
        const y = parseInt(yearStr);
        // Obtenemos los últimos 2 dígitos del año actual (ej. 2026 -> 26)
        const currentYear2Digits = new Date().getFullYear() % 100;
        // Si el cliente pone "98" (mayor a 26), asumimos 1998. Si pone "15" (menor a 26), asumimos 2015.
        yearStr = y > currentYear2Digits ? `19${yearStr}` : `20${yearStr}`;
    } else if (yearStr.length !== 4) {
        return text; 
    }

    // Retornamos la fecha formateada lista para tu validador
    return `${day}/${month}/${yearStr}`;
};

// --- VALIDADORES ORIGINALES ---

const isValidName = (text) => {
    if (!text) return false;
    return text.length > 2 && text.length < 60 && text.split(' ').length < 7;
};

const isValidBirthDate = (text) => {
    if (!text) return false;

    // Tu lógica original que quita las diagonales y valida perfecto
    const clean = text.replace(/[^0-9]/g, '');

    if (clean.length !== 8) return false;

    const day = parseInt(clean.substring(0, 2));
    const month = parseInt(clean.substring(2, 4));
    const year = parseInt(clean.substring(4, 8));

    const currentYear = new Date().getFullYear();

    if (month < 1 || month > 12) return false;
    if (day < 1 || day > 31) return false;
    if (year < 1900 || year > currentYear) return false;

    return true;
};

// Asegúrate de exportar las 4 funciones
module.exports = { normalizeName, normalizeDate, isValidName, isValidBirthDate };
