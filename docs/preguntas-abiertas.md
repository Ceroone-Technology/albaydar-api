# Decisiones y preguntas abiertas

## Decidido (reunión del 20 de octubre de 2026)

| # | Tema | Decisión | Cómo está en la API |
|---|---|---|---|
| 1 | Agenda | Jornada laboral de lunes a viernes, de 8:00 a 18:00; la disponibilidad se reduce según se ocupan horas | Disponibilidad calculada; horario editable en `PUT /agenda/configuracion` |
| 2 | Entrevista | Siempre presencial, con el equipo directivo | Fijo, con `CHECK` en BD |
| 3 | Recordatorio sin respuesta | Uno solo, con plantilla HTML | A los 3 días, plantilla `CITACION_RECORDATORIO` |
| 4 | Recordatorio del día antes | Plantilla HTML editable desde Comunicaciones | Plantilla `ENTREVISTA_RECORDATORIO`; CRUD completo de plantillas |
| 5 | Cambiar la cita | Solo durante las 24 h siguientes a aceptarla | `cambioHasta` en la página de cita; después, 409 |
| 6 | Duración | 45 a 60 minutos | Secretaría elige 45 o 60 al citar |
| 7 | Fechas propuestas | Se reservan hasta que la familia elige | Franjas `RESERVADA`; nadie más puede ocuparlas |
| 8 | Fechas pasadas sin respuesta | La propuesta caduca y vuelve a revisión | Las horas se liberan |
| 10–11 | Campos de la solicitud | Los del mockup; todos obligatorios salvo la modalidad | Validado en el formulario web |
| 12 | Notas del último curso | Se piden con la cita | Se suben desde el enlace de la cita |
| 14 | Cupo SNEC | Se queda informativo | Sin cambios |
| 15 | Plazas ocupadas | Las admitidas ya cuentan | Sin cambios |
| 16 | Columnas del kanban | Bien como están | Sin cambios |
| 18 | Correo de demostración | Gmail personal con contraseña de aplicación | Ver `docs/gmail.md`; `MAIL_DESVIO` para no escribir a familias de ejemplo |
| 19 | Ficheros | En tu equipo por ahora; en la nube cuando haya servidor | Carpeta `storage/uploads` del proyecto; interfaz lista para cambiar a la nube |
| 21 | Acceso del personal | Usuario y contraseña, con módulo de usuarios y roles | Usuarios, roles y matriz de permisos editables |
| — | Perfiles (reunión del 5 de octubre) | Dirección (superadministrador), Administración, Secretaría y Comercial/Promoción | Cuatro roles de serie; Dirección activa o desactiva ver/editar por módulo |
| — | Importe de la reserva (21 de octubre) | 300 € para todas las vías, de momento | `ajustes.reserva`, editable; admite importes distintos por vía |
| — | IBAN del centro (21 de octubre) | Provisional `ES91 2100 0418 4502 0005 1332` (ficticio) | En `ajustes.reserva`; llega a las plantillas como variable |
| — | Formas de pago (21 de octubre) | Transferencia y efectivo | `ajustes.reserva.metodos` |
| — | Conciliación (21 de octubre) | Registro manual, sin importar extractos | `POST /cobros` |
| — | Plazo de pago | 15 días naturales desde la admisión (diagrama de flujo) | `ajustes.reserva.plazoDias` |

## Pendiente de validar

**Agenda y citas**

1. **Reservas sin respuesta.** Las fechas propuestas quedan bloqueadas hasta que la familia elige. Si no contesta, siguen bloqueadas hasta que pasan (con un recordatorio a los 3 días). ¿Liberamos las reservas automáticamente pasados X días sin respuesta? Por ejemplo, a los 5 días, junto con un aviso a secretaría.
2. **Plazo de 24 h.** Hoy cuenta desde la primera vez que la familia acepta. Si cambia de fecha dentro de ese plazo, no se le da otro plazo de 24 h. ¿Es así?
3. **Detalles del horario.** Las entrevistas pueden empezar cada 30 minutos (8:00, 8:30…) y no se ofrecen horas con menos de 2 horas de antelación. ¿Os parece bien? ¿Hay festivos o semanas sin entrevistas que debamos cargar ya? Se pueden añadir como días no lectivos.
4. **Una o varias agendas.** Hoy hay una sola agenda: la del equipo directivo como conjunto. Si más adelante varios directivos entrevistan a la vez en salas distintas, habría que tener una agenda por persona o sala. ¿Hace falta?
5. **Calendario.** Hoy se envía una invitación (.ics) que la familia añade a su calendario. ¿Hace falta además sincronizar con el Google Calendar o el Outlook del equipo directivo? Pendiente de decidir (punto 9).

**Solicitud**

6. **Familia ya vinculada** (punto 13, explicado de otra forma). Es una de las cinco comprobaciones que ve secretaría al revisar una solicitud: avisa de que esa familia ya tiene relación con el centro, por ejemplo una hermana ya matriculada, para tenerlo en cuenta. Hoy salta si hay otra solicitud con el mismo correo o teléfono. Cuando exista el módulo de Alumnado también se comprobará contra las alumnas matriculadas. ¿Os vale así?
7. **Curso escolar** (punto 17, explicado de otra forma). Si una familia rellena hoy el formulario (octubre de 2026), ¿la plaza es siempre para el curso siguiente (2027-2028)? ¿O también se admiten solicitudes para incorporarse al curso que ya está en marcha?

**Permisos**

8. **Perfil Comercial.** Por defecto ve el dashboard, el alumnado y las entrevistas, y puede gestionar solicitudes (moverlas en el kanban, citar). No ve cobros, configuración ni plantillas. ¿Es correcto? Dirección lo puede cambiar desde la matriz en cualquier momento.

**Datos personales** (punto 20, explicado de otra forma)

9. ¿Cuánto tiempo guardamos los datos y el boletín de notas de una alumna que **no** entra en el centro? Hace falta saberlo para borrarlos automáticamente pasado ese plazo, como exige el RGPD.
10. Texto exacto de la casilla de privacidad del formulario web: lo tiene que dar el centro o su delegado de protección de datos.

**Técnicas, para más adelante**

11. **Correo en producción:** un remitente del propio centro (p. ej. `admisiones@albaydar.org`) con su servidor de correo, para que no acabe en spam. Gmail sirve solo para la demo.
12. **Nube para los ficheros:** qué proveedor (S3, Azure, Google Cloud) y en qué región (los datos de menores deberían quedarse en la UE).

**Kanban**

13. **Título de la primera columna.** El embudo cuenta todas las solicitudes, también las que siguen en la bandeja (acordado con el front el 21/10/2026). Por eso la columna "Solicitud revisada" del mockup contiene también las recién recibidas y las pendientes de completar. El front propone llamarla "Nuevas y en revisión". ¿Cambiamos el título? Hasta que el cliente lo confirme se mantiene el del mockup.

**Reserva de plaza y cobros**

14. **Reserva vencida sin pagar.** Hoy queda "vencida", se avisa a secretaría y administración, y la plaza sigue ocupada hasta que alguien decida (si la familia paga tarde, se registra igual). ¿Lo dejamos así o la plaza se libera sola pasados X días?
15. **Devolución de la reserva.** Si la alumna no llega a matricularse, ¿se devuelve? Hoy se puede anular el cobro con un motivo (por ejemplo, "devuelto"), pero la devolución del dinero se hace fuera de la plataforma.
16. **Numeración de los recibos.** Hoy es correlativa por año natural: R-2026-0001, R-2026-0002… ¿Debe reiniciarse por curso escolar (2027/28)? ¿El centro emite ya recibos o facturas en otra herramienta? Si es así, conviene usar una sola numeración.
17. **Textos de los correos de lista de espera y de no admitida.** Hoy llevan un texto provisional; el centro puede cambiarlo desde Comunicaciones.
18. **IBAN real del centro** para sustituir al provisional.
19. **Datos fiscales del centro para el recibo:** razón social y NIF. Hoy el recibo lleva el nombre, la dirección y el teléfono del centro, y la mención de exención de IVA.
