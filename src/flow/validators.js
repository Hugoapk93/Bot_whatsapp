const isValidName = (text) => {
    if (!text) return false;
    return text.length > 2 && text.length < 60 && text.split(' ').length < 7;
};

const isValidBirthDate = (text) => {
    if (!text) return false;

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

module.exports = { isValidName, isValidBirthDate };
