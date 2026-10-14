# Panel de anuncios WhatsApp (v1: 1 sesión por código)

## Subir a Render (desde el celular)
1. Sube esta carpeta a un repositorio de GitHub (Add file → Upload files).
2. En render.com: New → Web Service → conecta el repositorio.
3. Build command: `npm install` · Start command: `npm start`
4. En Environment agrega `ADMIN_KEY` con tu clave secreta.
5. Abre `https://TU-APP.onrender.com/admin.html` para crear códigos.
   Los clientes entran por `https://TU-APP.onrender.com`.

## Notas
- En Render gratis el disco se borra al reiniciar: habrá que volver a escanear el QR.
- El tiempo del código corre desde el primer login del cliente.
- Al vencer: se bloquea el código, se cierra WhatsApp y se borra la sesión.
