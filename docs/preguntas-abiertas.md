# Decisiones y preguntas abiertas

## Decidido (reunión del 20 de octubre de 2026)

| # | Tema | Decisión | Cómo está en la API |
|---|---|---|---|
| 1 | Agenda | Jornada laboral de lunes a viernes, de 8:00 a 18:00; la disponibilidad se reduce según se ocupan horas | Disponibilidad calculada; horario editable en `PUT /agenda/configuracion` |
| 2 | Entrevista | Siempre presencial, con el equipo directivo. **Revisado el 21/10:** entrevistan varias personas (~7) según el tipo de solicitud; ver pregunta 4 | Hoy, una sola agenda con `CHECK` en BD; cambia cuando llegue la lista de entrevistadores |
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
| — | Agenda (21 de octubre) | Nunca el mismo día: entrevistas de 45 a 60 minutos a partir de mañana | `permitirMismoDia: false` en `ajustes.agenda`; motivo `Mismo día` y error `FECHA_MISMO_DIA` |
| — | Plazo de pago | 15 días naturales desde la admisión (diagrama de flujo) | `ajustes.reserva.plazoDias` |
| — | Devolución de la reserva (21 de octubre) | **No reembolsable**, salvo fuerza mayor caso por caso (cierra la antigua pregunta 15) | Un cobro se anula con motivo; la devolución del dinero, fuera de la plataforma |

## Pendiente de validar

**Agenda y citas**

1. **Reservas sin respuesta.** Las fechas propuestas quedan bloqueadas hasta que la familia elige. Si no contesta, siguen bloqueadas hasta que pasan (con un recordatorio a los 3 días). ¿Liberamos las reservas automáticamente pasados X días sin respuesta? Por ejemplo, a los 5 días, junto con un aviso a secretaría.
2. **Plazo de 24 h.** Hoy cuenta desde la primera vez que la familia acepta. Si cambia de fecha dentro de ese plazo, no se le da otro plazo de 24 h. ¿Es así?
3. **Detalles del horario.** Las entrevistas pueden empezar cada 30 minutos (8:00, 8:30…) y no se ofrecen horas con menos de 2 horas de antelación. ¿Os parece bien? ¿Hay festivos o semanas sin entrevistas que debamos cargar ya? Se pueden añadir como días no lectivos.
4. **Entrevistadores** (acordado el 21/10 que entrevistan varias personas). Necesitamos la lista: quién entrevista, qué tipo de solicitud atiende cada uno (Bachillerato, cada ciclo), su horario y su sala. Con ella, cada entrevistador tiene su agenda y secretaría ve el calendario de todos. Hasta entonces hay una única agenda del equipo directivo.
5. **Calendario de los entrevistadores.** Hoy solo la familia recibe la invitación (.ics). ¿Usan Google Calendar? Propuesta: enviar también la invitación al entrevistador (sencillo). Ver su disponibilidad real en Google Calendar es una integración externa que la propuesta deja fuera de alcance: se valoraría aparte.

**Solicitud**

6. **Familia ya vinculada** (punto 13, explicado de otra forma). Es una de las cinco comprobaciones que ve secretaría al revisar una solicitud: avisa de que esa familia ya tiene relación con el centro, por ejemplo una hermana ya matriculada, para tenerlo en cuenta. Salta si hay otra solicitud o una alumna del centro (no de baja) con el mismo correo o teléfono de contacto (desde el 08/11/2026). ¿Os vale así?
7. **Curso escolar** (punto 17, explicado de otra forma). Si una familia rellena hoy el formulario (octubre de 2026), ¿la plaza es siempre para el curso siguiente (2027-2028)? ¿O también se admiten solicitudes para incorporarse al curso que ya está en marcha?

**Permisos**

8. **Perfil Comercial.** Por defecto ve el dashboard, el alumnado y las entrevistas, y puede gestionar solicitudes (moverlas en el kanban, citar). No ve cobros, configuración ni plantillas. ¿Es correcto? Dirección lo puede cambiar desde la matriz en cualquier momento.

**Datos personales** (punto 20, explicado de otra forma)

9. ¿Cuánto tiempo guardamos los datos y el boletín de notas de una alumna que **no** entra en el centro? Hace falta saberlo para borrarlos automáticamente pasado ese plazo, como exige el RGPD.
10. Texto exacto de la casilla de privacidad del formulario web: lo tiene que dar el centro o su delegado de protección de datos.

**Técnicas, para más adelante**

11. **Correo en producción:** un remitente del propio centro (p. ej. `admisiones@albaydar.org`) con su servidor de correo, para que no acabe en spam. Gmail sirve solo para la demo.
12. **Nube para los ficheros:** qué proveedor (S3, Azure, Google Cloud) y en qué región (los datos de menores deberían quedarse en la UE). **Propuesta (08/11/2026):** Google Cloud Storage en Madrid (`europe-southwest1`), privado y cifrado; encaja con Google Workspace. Ver `docs/matricula.md`, punto 7.

**Kanban**

13. **Título de la primera columna.** El embudo cuenta todas las solicitudes, también las que siguen en la bandeja (acordado con el front el 21/10/2026). Por eso la columna "Solicitud revisada" del mockup contiene también las recién recibidas y las pendientes de completar. El front propone llamarla "Nuevas y en revisión". ¿Cambiamos el título? Hasta que el cliente lo confirme se mantiene el del mockup.

**Reserva de plaza y cobros**

14. **Reserva vencida sin pagar.** Hoy queda "vencida", se avisa a secretaría y administración, y la plaza sigue ocupada hasta que alguien decida (si la familia paga tarde, se registra igual). ¿Lo dejamos así o la plaza se libera sola pasados X días?
15. ~~Devolución de la reserva~~ **Cerrada el 21/10:** no reembolsable, salvo fuerza mayor caso por caso (ver «Decidido»). Falta decir si el correo de admisión debe avisarlo; hoy no lo menciona.
16. **Numeración de los recibos.** Hoy es correlativa por año natural: R-2026-0001, R-2026-0002… ¿Debe reiniciarse por curso escolar (2027/28)? ¿El centro emite ya recibos o facturas en otra herramienta? Si es así, conviene usar una sola numeración.
17. **Textos de los correos de lista de espera y de no admitida.** Hoy llevan un texto provisional; el centro puede cambiarlo desde Comunicaciones.

**Correos a la familia**

20. **Trato en los correos** (propuesto el 04/11/2026). Todos los correos a la familia empiezan con «Estimada familia:» y van de usted, como las plantillas del mockup. Hasta ahora, los de la citación y los recordatorios iban de tú («Hola, Rosa») y el resto de usted. Las páginas públicas (`/cita`, `/solicitud`) siguen de tú, como en sus mockups. ¿Confirmáis este criterio?
21. **Motivo de «No admitida».** Hoy es opcional; sin motivo, el correo no da ninguna explicación (el párrafo vacío se quita). ¿Debe ser obligatorio?
18. **IBAN real del centro** para sustituir al provisional.
19. **Datos fiscales del centro para el recibo:** razón social y NIF. Hoy el recibo lleva el nombre, la dirección y el teléfono del centro, y la mención de exención de IVA.
22. **Plazo de la reserva por solicitud** (propuesto el 04/11/2026). Al admitir se puede acortar (de mañana al plazo general de 15 días) si quedan pocas plazas, como pedía el informe funcional; después, Dirección o Administración pueden acortarlo o ampliarlo (fuerza mayor) hasta 90 días, con motivo y aviso a la familia. ¿Os vale? ¿Quién debe poder ampliarlo?

**Matrícula digital** (propuesto el 08/11/2026; diseño en `docs/matricula.md`)

23. **Firmas de padre y madre.** La LOPD lleva seis firmas: tres del padre y tres de la madre. Con un único enlace a la familia no se sabe quién firma cada una; solo queda registrado que salieron del mismo enlace. Proponemos un enlace por defecto, y que secretaría pueda enviar un segundo enlace al otro progenitor cuando haga falta (familias separadas, o que no firmen juntos). ¿Os vale, o queréis enviar siempre un enlace a cada progenitor?
24. **Identificador de acreedor SEPA de GS concertado.** El mockup usa `ES09000G41829037` para todas las vías salvo GS concertado. Lo hemos comprobado y es correcto. Para GS concertado pone `G-41829037/605`, que no tiene el formato SEPA. Suponemos que es `ES09605G41829037` (mismo NIF, sufijo 605). ¿Nos lo confirma el banco o administración?
25. **Conservación de los documentos de la matrícula.** Proponemos estos plazos:
    - copias de DNI, Libro de Familia, tarjeta sanitaria y foto: hasta el 31 de agosto del curso en que la alumna cause baja;
    - documentos firmados (impreso, ideario, LOPD, órdenes SEPA): hasta 3 años después de la baja;
    - borradores de matrícula nunca enviados: hasta el 30 de septiembre del curso de la matrícula;
    - cobros: 6 años.

    Lo debe validar el centro o su delegado de protección de datos. Hasta entonces no se borra nada automáticamente.
26. **Volver a firmar si cambian los datos.** Un documento firmado no puede decir otra cosa que lo que se firmó. Si secretaría corrige un dato que sale en un documento ya firmado (por ejemplo, el teléfono en el impreso o la cuenta en la orden SEPA), la firma se anula y la familia tiene que volver a firmar ese documento. ¿Lo veis bien?
27. **Alumnas que hoy están en 1º.** Para abrir su matrícula de 2º desde la plataforma necesitamos cargarlas una vez. Pedimos un listado sacado de Séneca, en CSV o Excel, que indique también si promocionan. El mismo importador servirá para el alumnado que asigna la Junta.
28. **Fichero de Séneca.** Formato oficial con el que secretaría carga hoy la matrícula en Séneca, o un fichero de ejemplo. Mientras tanto, la exportación es un CSV provisional.
31. **Lo que la familia no cambia desde su enlace** (propuesto el 08/11/2026). Desde su enlace, la familia no puede cambiar:
    - la vía ni el curso: los fija la plaza reservada;
    - «¿Alumna nueva?»: decide si firma el ideario y la protección de datos;
    - los documentos marcados como «entregado en papel» (fotos, AlbaydarPLUS).

    Eso lo cambia secretaría. ¿Queréis que la familia pueda marcar ella misma «lo entrego en papel», o lo confirma siempre secretaría al recibirlo?
32. **Contenido de los documentos que se firman** (propuesto el 08/11/2026). Usamos los textos de vuestros PDF tal cual, con cuatro añadidos:
    - en la LOPD, el nombre de la alumna, su curso y el de los padres o tutores en la página que se firma, para que quede claro a quién se refiere;
    - en la orden de AlbaydarPLUS, los datos del acreedor (Albaydar, su identificador y dirección), porque es una domiciliación;
    - en el impreso, la frase «La persona abajo firmante declara, bajo su expresa responsabilidad, que son ciertos los datos…»;
    - encima de cada firma, «He leído el documento completo y lo firmo».

    La fecha de cada documento es la del día en que se firma. ¿Os parece bien? Si tenéis versiones más recientes de los PDF (LOPD, SEPA, AlbaydarPLUS, ideario), pasádnoslas: cambiar un texto obliga a volver a firmarlo en las matrículas que estén en curso.
33. **Correos de la matrícula** (propuesto el 10/11/2026).
    - **Confirmación:** el texto del mockup dice «Adjuntamos el listado de libros y el calendario de acogida», pero no tenemos esos documentos. Hemos quitado la frase. ¿Nos los pasáis para adjuntarlos (o enlazarlos), o lo dejamos así?
    - **Al enviar la matrícula:** la familia recibe un acuse con una copia en PDF de los documentos firmados (impreso, ideario, protección de datos, órdenes SEPA). ¿Os parece bien que la copia vaya por correo, o preferís que solo la descarguen desde su enlace?
    - **Si secretaría devuelve la matrícula para corregir algo:** la familia recibe el motivo por correo y la corrige desde el mismo enlace.

**Alumnado** (propuesto el 08/11/2026)

29. **Número de expediente.** Cada alumna recibe un número de expediente `EXP-2026-0001`, como en el mockup, correlativo por año de alta. ¿El centro ya numera los expedientes de otra forma (por ejemplo, con el número de Séneca)? Si es así, usamos el suyo.
30. **Estados del alumnado.** Usamos los del mockup:
    - «Reserva confirmada»: plaza pagada;
    - «En proceso»: matrícula en curso;
    - «Matriculada»;
    - «Baja», con motivo.

    El expediente se abre solo al pagar la reserva, con los datos de la solicitud. El DNI, la fecha de nacimiento y el domicilio los completa secretaría o la matrícula, porque la solicitud no los pide. Si se anula el pago de la reserva, el expediente se retira. ¿Os parece bien?

**Desvíos detectados al revisar el flujo** (propuesto el 11/11/2026, al contrastar lo construido con el diagrama ajustado tras el 21/10)

34. **Cuándo queda «Matriculada».** El diagrama confirma la matrícula después de que Séneca valide la carga (pasos 29–31). Como Séneca no tiene API, la plataforma no se entera: hoy la alumna pasa a «Matriculada» al exportar el fichero. Alternativa: dejarla «Exportada» y que secretaría pulse «Confirmada en Séneca». ¿Cuál preferís?
35. **Quién decide la admisión.** En el diagrama la aprobación está en el carril de Secretaría (paso 15). Hoy solo la registra Dirección, según la matriz de permisos del mockup. Dirección puede dárselo a Secretaría desde la matriz. ¿Quién debe decidir?
36. **Enlace de la matrícula.** El diagrama lo envía la plataforma sola al conciliar el pago (paso 22). Hoy el pago crea el expediente y secretaría abre la matrícula, que envía el enlace (un clic, desde el listado o la ficha). ¿Lo preferís automático al pagar, o que lo decida secretaría (por ejemplo, para enviarlos en bloque cuando empiece el plazo de matrícula)?
37. **Duración de la entrevista.** El correo del 21/10 decía 30 a 60 minutos; el diagrama, 45 a 60. Hoy se ofrecen 45 y 60 (se cambia en Configuración › Agenda). ¿Cuál vale?

**Datos que necesitamos del centro** (pedidos el 21/10 o necesarios para seguir)

- Respuesta al correo del 21/10 y **confirmación por escrito del diagrama**.
- **Captación / CRM** (Luis Fdo.): datos del primer contacto, correo de información del curso, estados del interesado y paso a solicitud. Y las **funciones del perfil Comercial**.
- **Series de numeración** B y C, y si se reinician por curso escolar (hoy, por año natural).
- **Lista de ciclos de FP** y **plazas por vía y curso**; si hay **ESO**.
- **Ficha de solicitud de FP** (tenemos la de Bachillerato).
- **Criterio de promoción** 1º → 2º y de dónde salen las notas (hoy, una marca manual o la que venga de Séneca).
- **Forma de pago de la reserva**: transferencia y efectivo, o también domiciliación o pasarela (el diagrama lo deja «a validar»; una pasarela es integración aparte).
- **IBAN real y su titular**, **razón social y NIF** del centro.
- **Cuenta de correo del centro** para enviar (sección técnica, pregunta 11).
- **Untis**: la sesión para decidir si se integra o se sustituye.
- **Excel históricos** y **plantillas de comunicación actuales** (dependencias del cliente según la propuesta).
