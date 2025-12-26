# USA ESTA IMAGEN EXACTA (No uses node:alpine ni node:slim)
# Trae Ubuntu + Node + Chrome + ffmpeg + drivers gráficos instalados
FROM mcr.microsoft.com/playwright:v1.57.0-jammy

# Directorio de trabajo
WORKDIR /app

# 1. Copia solo package.json primero (para cachear capas de docker)
COPY package.json package-lock.json* ./

# 2. Instala dependencias SIN intentar descargar navegadores (ya vienen en la imagen)
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm ci

# 3. Copia el resto del código
COPY . .

# 4. Construye el frontend de Vite (para que existan los archivos estáticos en /dist)
RUN npm run build

# 5. Expone el puerto 5000 (Railway usa la variable PORT automáticamente)
ENV PORT=5000
EXPOSE 5000

# Variables para evitar crashes de memoria y timeouts
ENV NODE_ENV=production
# Force IPv4 to avoid timeouts in some cloud environments
ENV NODE_OPTIONS="--dns-result-order=ipv4first" 

# Comando de inicio
CMD ["npm", "run", "server"]
