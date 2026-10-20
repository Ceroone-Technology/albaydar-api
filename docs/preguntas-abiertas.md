# Preguntas abiertas para validar con el cliente

Decisiones que he tomado para poder avanzar y que conviene confirmar en la reunión. Cada una indica qué hace hoy la API y cuánto costaría cambiarla.

## Citación y entrevista

1. **¿Quién propone los huecos?** El diagrama lo deja "a validar" (paso 7): secretaría propone de 1 a 3, o la plataforma asigna el primero libre. **Hoy:** secretaría propone. Cambiarlo es añadir un endpoint, sin tocar el modelo.
2. **Con quién es la entrevista.** El prompt dice "siempre con el equipo directivo, en la sala de reuniones de Dirección". Pero los datos de ejemplo del mockup (calendario de Entrevistas y página de cita) mencionan Jefatura de Estudios, Orientación, Jefatura de FP y salas 1, 2 y 4, y el panel de citar tiene chips Presencial/Telefónica/Videollamada. **Hoy:** fijo a equipo directivo y sala de Dirección (con `CHECK` en BD para presencial). Si hiciera falta varias agendas, se añade una columna `agenda` a `huecos_agenda`.
3. **Recordatorio "a los 3 días".** Lo he interpretado como el texto del mockup: "si no responde en 3 días, se le envía un recordatorio". Uno solo. ¿Hace falta un segundo aviso, o una llamada de secretaría?
4. **Recordatorio el día antes.** La página de cita promete "un recordatorio el día antes". **Hoy:** se envía a partir de las 10:00 del día anterior.
5. **Plazo para cambiar la cita.** **Hoy:** la familia puede cambiar o pedir otra franja hasta 24 h antes; después, el mensaje le pide llamar a secretaría.
6. **Duración y franjas.** **Hoy:** 45 min; plantilla por defecto L–V a las 09:00, 10:00, 12:30 y 17:00 (las del mockup). ¿Son las reales? ¿Hay festivos o periodos sin entrevistas?
7. **¿Puede proponerse el mismo hueco a varias familias?** **Hoy:** sí; la primera que elige se lo queda y a las demás les aparece como no disponible. La agenda indica en cuántas propuestas pendientes está cada hueco. La alternativa es reservarlo provisionalmente al proponerlo, pero bloquearía la agenda mientras las familias no contestan.
8. **Fechas que caducan sin respuesta.** **Hoy:** cuando pasa el último hueco propuesto sin respuesta, la propuesta caduca y la solicitud vuelve a "En revisión".
9. **Calendario.** El diagrama pregunta: ¿agenda propia con invitación .ics (lo que hay ahora), o sincronización con Google o Microsoft?

## Solicitud

10. **Campos exactos del formulario público.** No tengo el mockup `Albaydar solicitud`. He tomado los campos de la bandeja: alumna, tutor, correo, teléfono, centro de procedencia, modalidad de interés y origen. Los que falten entran en `datosExtra` (JSON) sin romper nada; cuando se validen, se pasan a columnas.
11. **Datos obligatorios.** El mockup considera completa la solicitud con correo válido y centro de procedencia. **Hoy:** además nombre y apellidos de la alumna, nombre del tutor y teléfono. ¿Es correcto?
12. **Notas del último curso.** El diagrama dice que se piden con la cita, no con la solicitud (paso 9). **Hoy:** así. ¿Bloquean algo si no llegan antes de la entrevista? Hoy no bloquean.
13. **"Familia ya vinculada".** Hasta que exista el módulo de Alumnado, sale de la tabla `familias` (con un texto de vínculo, p. ej. "Hermana en 2º Bachillerato") y de otras solicitudes con el mismo correo o teléfono. ¿Qué se considera "vinculada" exactamente?
14. **Cupo SNEC.** **Hoy:** es informativo ("comprobar el cupo de la resolución"), no bloquea. ¿Hay que registrar el número de la resolución de la Junta?
15. **Plazas libres.** **Hoy:** plazas de la vía − (admitidas + plaza reservada + matriculadas). ¿Las admitidas ya cuentan como plaza ocupada, o solo al pagar la reserva?
16. **Columna "Solicitud revisada" del kanban.** El título dice "revisada", pero las tarjetas de ejemplo dicen "pendiente de revisar". **Hoy:** agrupa recibidas, en revisión y pendientes de completar. Y "Entrevista programada" incluye también "esperando a la familia" y "pide otra franja". Confirmar.
17. **Curso escolar.** El seed crea las vías de 2027-2028. ¿El formulario abre todo el año para el curso siguiente?

## Técnicas

18. **Proveedor de correo** (SMTP del centro, Microsoft 365, SendGrid…) y dominio remitente, para configurar SPF/DKIM y que no acabe en spam.
19. **Dónde se guardan los ficheros:** disco del servidor (hoy) o almacenamiento en la nube.
20. **RGPD:** plazo de conservación de solicitudes no admitidas y de los boletines de notas; texto exacto de la casilla de privacidad del formulario.
21. **Acceso del personal:** ¿usuario y contraseña propios (hoy) o inicio de sesión con la cuenta de Google o Microsoft del centro?
