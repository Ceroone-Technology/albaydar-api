# Enviar correos reales con Gmail (demostración)

Sirve tu Gmail personal y es gratis. Gmail permite unos 500 correos al día, de sobra para una demo. Para producción conviene un remitente del centro (p. ej. `admisiones@albaydar.org`) con su propio servidor de correo.

## 1. Crear una contraseña de aplicación

Gmail no deja usar tu contraseña normal desde un programa. Hace falta una "contraseña de aplicación":

1. Activa la **verificación en dos pasos** en tu cuenta de Google, si no la tienes: https://myaccount.google.com/signinoptions/twosv
2. Entra en **Contraseñas de aplicaciones**: https://myaccount.google.com/apppasswords
3. Escribe un nombre (por ejemplo, `Albaydar API`) y pulsa **Crear**.
4. Copia las 16 letras que aparecen. Se muestran una sola vez. Los espacios no importan.

## 2. Configurar la API

En la carpeta del proyecto, copia `.env.docker.example` como `.env` y descomenta el bloque de Gmail:

```dotenv
DOCKER_SMTP_HOST=smtp.gmail.com
DOCKER_SMTP_PORT=465
DOCKER_SMTP_SECURE=true
DOCKER_SMTP_USER=tucorreo@gmail.com
DOCKER_SMTP_PASS=abcdefghijklmnop
MAIL_FROM=Centro Educativo Albaydar <tucorreo@gmail.com>

# Todos los correos de la demo llegan a tu buzón, con el destinatario real en el asunto
MAIL_DESVIO=tucorreo@gmail.com
MAIL_SECRETARIA=tucorreo@gmail.com
```

- `MAIL_FROM` tiene que llevar **tu misma dirección de Gmail**; si pones otra, Gmail la cambia por la tuya.
- `MAIL_DESVIO` es muy recomendable mientras haya datos de ejemplo: evita escribir a direcciones como `epena@correo.es`, que podrían existir de verdad. Quítalo cuando pruebes con familias reales.

Después, reinicia la API:

```bash
docker compose up -d api
```

## 3. Comprobar

- **Conexión:** con un usuario de Dirección, `GET /api/comunicaciones/smtp/estado` responde `{ "ok": true }` si Gmail acepta las credenciales. Si responde `ok: false`, el campo `error` dice por qué (normalmente, contraseña de aplicación mal copiada).
- **Prueba de plantilla:** en Comunicaciones, "Enviar prueba" (`POST /api/comunicaciones/plantillas/:id/prueba`) te manda la plantilla con datos de ejemplo. Llega en unos 15 segundos.
- **Histórico:** `GET /api/comunicaciones/envios` muestra cada envío, su estado y el error si falló. Los fallidos se reintentan solos.

## Sin Docker (`npm run dev`)

Las mismas variables, sin el prefijo `DOCKER_`, en el `.env`:

```dotenv
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=tucorreo@gmail.com
SMTP_PASS=abcdefghijklmnop
MAIL_FROM=Centro Educativo Albaydar <tucorreo@gmail.com>
MAIL_DESVIO=tucorreo@gmail.com
```

## Alternativa: Brevo

Si prefieres no usar tu Gmail, Brevo tiene un plan gratuito de 300 correos al día: crea la cuenta, verifica tu remitente y usa `smtp-relay.brevo.com`, puerto `587`, `SMTP_SECURE=false`, con el usuario y la clave SMTP que te da Brevo.
