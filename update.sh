#!/bin/bash
echo "🔄 Iniciando actualización..."

# Limpiamos rastros previos
rm -rf carpeta_actualizacion

# Descargamos
git clone https://github.com/Hugoapk93/Bot_whatsapp.git carpeta_actualizacion

# Copiamos (Nota que quité los "../" para que busque en la carpeta que acabamos de bajar)
cp carpeta_actualizacion/app.js .
cp carpeta_actualizacion/package.json .

# Reemplazo de SRC
rm -rf src
cp -r carpeta_actualizacion/src .

# Frontend
cp carpeta_actualizacion/public/index.html public/
cp carpeta_actualizacion/public/manifest.json public/
cp carpeta_actualizacion/public/sw.js public/

# Instalar y Reiniciar
npm install
pm2 restart all

echo "✅ Listo."
# Opcional: Borrar la carpeta de descarga para ahorrar espacio
rm -rf carpeta_actualizacion
