# Matrícula digital · decisiones de diseño

Decidido el 08/11/2026, antes de empezar la fase 04. Cierra los bloqueos que dependen de nosotros, los que obligarían a rehacer el modelo si se resolvieran después. Lo que depende del centro está en `docs/preguntas-abiertas.md` (preguntas 23 a 28). El diseño ya admite cualquiera de sus respuestas.

La especificación funcional sigue siendo el asistente del front: el mockup y las reglas de `src/app/domain/rules/enrollment.rules.ts`. **La API valida esas mismas reglas.** Lo que el front comprueba (`stepMissing`, `canSignDoc`, `canSubmit`, `voidedMandateSignatures`…) se vuelve a comprobar en el servidor.

Orden de trabajo: primero **Alumnado** (la matrícula cuelga de una alumna, punto 8) y después **Matrícula**.

---

## 1. Documentos que se firman: el texto lo da el servidor y cada firma guarda su huella

**Decisión**

- **Textos.** Los textos de los cinco documentos (impreso, ideario, LOPD, SEPA y AlbaydarPLUS) pasan a la API como **textos legales versionados**, en código (`src/modules/matricula/documentos/`). No son plantillas editables desde Comunicaciones: un texto legal solo cambia con una versión nueva (`lopd@2027-1` → `lopd@2027-2`), y las firmas antiguas siguen apuntando a la suya.
- **Lector del front.** `GET /public/matricula/:token/documentos/:doc` devuelve el documento ya rellenado con los datos de la matrícula: páginas, bloques de texto, campos y huecos de firma. Incluye también su `huella`. El lector pinta eso y deja de usar los textos de `es-enrollment-reader.ts`. Así, lo que la familia ve es lo que se firma.
- **Huella.**
  - Se calcula con `SHA-256` sobre el **contenido canónico** del documento: id y versión del texto, más los datos de la matrícula que ese documento muestra, en JSON con las claves ordenadas.
  - No se hace sobre los bytes de un PDF: un PDF lleva fechas e identificadores internos, y su huella cambiaría sin cambiar el contenido.
- **Firmar.** `POST …/firmas/:hueco` recibe `{ imagen, huella }`. Si la huella no coincide con la actual, la API responde 409 `DOCUMENTO_CAMBIADO` y el front vuelve a cargar el documento. Cada firma guarda:
  - el hueco (`lopd-padre`…) y el documento con su versión;
  - la huella;
  - la fecha y hora **del servidor**;
  - la IP y el navegador (`user-agent`);
  - el enlace usado (id del enlace, nunca el token) y, si firma secretaría en presencia de la familia, el usuario;
  - la imagen del trazo: PNG validado por su firma de bytes, de 200 KB como máximo y con un límite de cuerpo propio en esa ruta (el general es de 200 KB).
- **Una firma vale mientras su huella coincida.** Cada vez que se guarda la matrícula, la API recalcula la huella de los documentos firmados. Si alguno cambió, sus firmas se anulan (`anuladaEn` y motivo; no se borran) y la familia vuelve a firmar.
  - Con esto, `voidedMandateSignatures` del front pasa a ser un caso particular: si cambia la cuenta, cambian el SEPA y el PLUS.
  - La regla se aplica a todos los documentos. Si secretaría corrige un dato que sale en el impreso firmado, hay que volver a firmarlo. Es lo correcto: el documento firmado no puede decir otra cosa que lo firmado.
- **PDF final.** Al enviar la matrícula (`ENVIADA`), la API genera un PDF por documento con:
  - el texto y los datos;
  - los trazos en su sitio;
  - una **hoja de evidencias**: por cada firma, el hueco, la huella, la fecha y hora, la IP, el navegador y el enlace.

  El PDF se guarda en el almacén con su propio `SHA-256`. Es lo que descarga secretaría y lo que se conserva.
- **Librería:** `pdfkit`, JavaScript puro. No se usa un Chromium sin interfaz: no hace falta y complicaría el contenedor.

**Por qué:** sin texto del servidor ni huella, la firma es un PNG suelto que no prueba qué se firmó. Hacerlo después obligaría a cambiar el lector del front y el modelo de firmas.

## 2. «Páginas leídas»: se registra y se declara, no se demuestra

**Decisión**

- **Qué valor tiene.** Es una **firma electrónica simple**: art. 3.10 del Reglamento eIDAS (UE 910/2014) y art. 25 sobre su admisibilidad como prueba. La API no puede saber si alguien leyó una página, solo que el navegador la marcó.
- **Dónde se guarda.** `paginasLeidas` sigue en el borrador, como hoy (`readPages`). Cuando una página pasa a leída, el servidor anota **su propia hora**; la hora que mande el navegador no cuenta.
- **Al firmar.** Se exige `canSignDoc`: todas las páginas leídas, la opción DOP elegida para la LOPD y la modalidad de pago para el SEPA. Si falta algo, 409 `DOCUMENTO_SIN_LEER` o `FALTAN_DATOS`.
- **En la hoja de evidencias** se dice exactamente lo que hay: «Páginas 1 a 7 marcadas como leídas en el navegador (primera marca 12/06/2027 10:02, última 10:09)». Nunca «la familia ha leído».
- **Declaración.** Justo encima del hueco de firma, el documento incluye: «He leído el documento completo y lo firmo». Se firma con él.

## 3. Firmas de padre y madre: un modelo que vale para uno o dos enlaces

**Pregunta al cliente (23).** Mientras tanto, se aplica esta decisión técnica.

- **Enlaces.** Una matrícula puede tener **varios enlaces** (`enlaces_matricula`), cada uno con su alcance:
  - `FAMILIA`: todo el asistente;
  - `PROGENITOR`: solo sus huecos de firma (`lopd-*-madre` o `lopd-*-padre`) y la lectura de sus documentos.
- **Por defecto,** un único enlace `FAMILIA`. Secretaría puede generar un enlace `PROGENITOR` para el otro progenitor cuando haga falta: separación, o que no estén juntos al firmar.
- **Cada firma registra el enlace que la hizo.** Si las dos firmas de la LOPD salen del mismo enlace, la hoja de evidencias lo dice. Así se sabe cómo se firmó, aunque no quién tenía el dispositivo.
- **Recomendación al centro:** un enlace por defecto y un segundo enlace a demanda. En actos ordinarios de la patria potestad, lo que hace uno de los progenitores se presume con el consentimiento del otro (art. 156 del Código Civil). Las autorizaciones de imagen y de datos de menores son el caso dudoso: que el centro decida si exige el segundo enlace siempre.

## 4. Orden SEPA

**Decisión**

- **Mandatos.** Tienen su propia tabla, `mandatos_sepa`, que también sirve de base para las remesas de Cobros completos. Campos:
  - referencia;
  - tipo;
  - esquema `CORE`;
  - acreedor;
  - IBAN, BIC opcional, titular y su DNI/NIE;
  - fecha de firma (la de la firma `sepa-titular` o `plus-titular`);
  - estado (`VIGENTE` / `ANULADO`), con fecha y motivo de anulación.

  El PLUS es un mandato aparte, con su propia referencia.
- **Referencia única del mandato:** `{código de la matrícula}-{SEPA|PLUS}{n}`, por ejemplo `M-2027-0001-SEPA1`.
  - Es única en BD. Cabe en los 35 caracteres de la norma y solo usa caracteres permitidos.
  - Si cambian la cuenta o el titular, se anula el mandato y la nueva firma crea `…SEPA2`. Una referencia nunca se reutiliza.
- **Tipo:**
  - mensual → recurrente (`RCUR`; el primer cargo de la remesa irá como `FRST`);
  - único → `OOFF`. Es el caso de la cuota reglada de GS concertado, que no tiene elección (`sepaPaymentType`).
- **IBAN:**
  - se normaliza (sin espacios, en mayúsculas);
  - se valida con el dígito de control ISO 13616 (módulo 97) y la longitud del país;
  - solo se admiten países SEPA; uno español tiene 24 caracteres.
- **Resto de datos:**
  - **BIC:** opcional (no es obligatorio en la zona SEPA). Si se escribe, se valida su formato.
  - **DNI/NIE:** se valida la letra.
  - **IBAN en listados, registros y correos:** se enmascara (`ES91 **** **** **** **** 1332`). Completo solo en la ficha de la matrícula y en el mandato.
- **Acreedor** en `ajustes.matricula.acreedores`:
  - nombre, dirección e identificador (formato AT-02: país, dígitos de control, sufijo y NIF);
  - qué acreedor usa cada vía.

  Valores de partida, los del mockup:
  - `ES09000G41829037` para todas las vías salvo GS concertado. Comprobado: sus dígitos de control son correctos.
  - Para GS concertado el mockup dice `G-41829037/605`, que no tiene formato SEPA. Lo esperable es `ES09605G41829037`: mismo NIF, sufijo 605 (los dígitos de control no dependen del sufijo). **Lo confirma el centro (24).**

## 5. Edición simultánea de familia y secretaría: versión y 409

**Decisión**

- **Versión.** `matriculas.version` (entero) protege el borrador, es decir, los datos del asistente. `PUT /matriculas/:id` y `PUT /public/matricula/:token` reciben `{ datos, version }` y actualizan con `WHERE id = … AND version = …`.
- **Conflicto.** Si no se actualiza ninguna fila, la API responde 409 `VERSION_ANTIGUA` y devuelve en `details` la versión actual, quién guardó (familia o secretaría, con nombre) y cuándo. Toda respuesta devuelve la `version` nueva.
- **Firmas y archivos.** Van en sus propias tablas y rutas, y **no** suben la versión: firmar mientras el autoguardado está en vuelo no debe dar conflicto. Al revés sí hay efecto: guardar unos datos que cambian un documento firmado anula sus firmas (punto 1).
- **El front ante un 409:**
  - detiene el autoguardado y muestra «Secretaría ha cambiado esta matrícula a las 10:32», con «Recargar»;
  - no mezcla nada automáticamente.

  Mientras la matrícula está en `BORRADOR`, editan la familia y secretaría.
- **Una vez `ENVIADA`,** la familia ya no puede editar (409 `MATRICULA_ENVIADA`): solo secretaría, o se la devuelve a borrador con un motivo.

## 6. Límite de peticiones del portal de la familia

**Decisión:** las rutas `/public/matricula/:token/*` tienen límites propios, contados **por enlace** (el hash del token) y no por IP: una red de colegio o de casa comparte IP.

| Ruta | Límite |
|---|---|
| Guardar borrador (autoguardado) | 900 cada 15 min (60/min) |
| Firmas | 60 por hora |
| Subir archivos | 30 por hora |
| Lecturas (`GET`) | 600 cada 15 min |

- **Tokens que no existen:** siguen contando por IP con el límite actual de enlaces (120 cada 15 min). Así no se pueden probar tokens a ciegas.
- **Front:** subir el retardo del autoguardado de 600 ms a **1 s** y forzar el guardado al cambiar de paso y al salir de la página. Con eso, el límite no lo alcanza una persona que rellena el formulario.

## 7. Documentos de menores: nube en la UE y conservación por tipo

**Decisión técnica**

- **Proveedor.** Implementar `Almacen` (`src/lib/storage.ts`) para **Google Cloud Storage en `europe-southwest1` (Madrid)**. Encaja con Google Workspace, el stack de referencia, y los datos no salen de España. La interfaz no cambia: si el servidor acaba en otro proveedor (S3 `eu-south-2`), es otra clase.
- **Bucket:**
  - privado, con acceso uniforme y cifrado en reposo;
  - nunca con URL pública;
  - la API descarga el fichero tras comprobar el permiso y lo sirve con `no-store`, como hoy.
- **Conservación.** Cada fichero guarda su **tipo** y su `conservarHasta`. Una tarea diaria (en `src/jobs`) borra lo vencido y deja constancia en el historial. Una regla de ciclo de vida del bucket hace de red de seguridad.

**Plazos propuestos al centro (25).** Los confirma el centro o su delegado de protección de datos; hasta entonces no se borra nada automáticamente.

| Qué | Hasta cuándo | Por qué |
|---|---|---|
| Copias de DNI, Libro de Familia, tarjeta sanitaria, foto | Mientras la alumna esté matriculada; se borran el 31 de agosto del curso en que cause baja | Solo sirven para comprobar datos (minimización, art. 5.1.c RGPD) |
| Documentos firmados (impreso, ideario, LOPD, mandatos) con su hoja de evidencias | Hasta 3 años después de la baja | Prueba de los consentimientos y los mandatos. 3 años es la prescripción de las infracciones muy graves (art. 72 LOPDGDD) y cubre los 13 meses de reclamación de un cargo SEPA |
| Matrícula que nunca se envía (borrador abandonado) | 30 de septiembre del curso de la matrícula | No llegó a existir la relación |
| Cobros y recibos | 6 años | Art. 30 del Código de Comercio. Son datos en la BD, no ficheros |

## 8. Alumnado de 2º que continúa: la matrícula cuelga de la alumna

**Decisión**

- **Alumnado primero.** El módulo crea la tabla `alumnas`, con:
  - datos personales;
  - vía y curso actuales;
  - estado, con los textos del mockup: `RESERVA` («Reserva confirmada») → `EN_PROCESO` («En proceso») → `MATRICULADA` → `BAJA` (hecho el 08/11/2026: `src/modules/alumnado`);
  - tutores y contacto;
  - `solicitudId` opcional: la de origen, si la hubo.
- **Matrícula.** `matriculas` lleva `alumnaId` obligatorio, `solicitudId` **opcional**, `cursoEscolar` y `nuevaAlumna`. Hay una sola matrícula por alumna y curso escolar (único en BD).
- **De dónde sale una matrícula:**
  - **Admisión.** Al pagar la reserva, se crea la alumna (`RESERVA`; ya lo hace el cobro desde el 08/11/2026) y, al abrir el enlace de matrícula, su matrícula precargada (la alumna pasa a `EN_PROCESO`) con los datos de la solicitud (`nuevaAlumna = true`).
  - **Continuación (renovación 1º → 2º).** Secretaría abre la matrícula del curso siguiente para una alumna `MATRICULADA`, o para todas las de 1º de una vía a la vez. Se precarga con la matrícula anterior y `nuevaAlumna = false`. Por eso no hay ideario ni LOPD: es la regla `isNewStudent` del front.
    - **Quién promociona** (reunión del 21/10). La apertura en bloque solo incluye a las alumnas marcadas con `promociona`. Esa marca la pone secretaría a mano, una a una o en bloque, o llega en la importación de Séneca.
    - Las calificaciones no se gestionan en la plataforma: están en Séneca, y lo que se decida sobre Untis no cambia esto.
  - **Alumnado asignado por la Junta de Andalucía** (reunión del 21/10). Entra directo a matrícula, sin solicitud ni entrevista:
    - se importa desde Séneca (fichero ahora; API si la Junta la ofrece), o se da de alta a mano;
    - crea la alumna en `EN_PROCESO` (origen `SENECA`) y su matrícula precargada con `nuevaAlumna = true`;
    - no ocupa plaza de admisión: no pasa por el embudo.
  - **Alta manual.** Una alumna sin solicitud ni matrícula previa, para casos excepcionales.
- **Al pasar a `EXPORTADA`,** la alumna queda `MATRICULADA` y la solicitud, si la hay, `MATRICULADA`.
- **Carga inicial:** las alumnas que hoy están en 1º se importan una vez desde un CSV o Excel sacado de Séneca. **Hace falta ese listado del centro (27).** La misma importación sirve para el alumnado de la Junta: un único importador de Séneca con vista previa y errores por fila, que no escribe nada hasta confirmar.
- **«Familia ya vinculada»** ya comprueba también los contactos de las alumnas que no están de baja (hecho el 08/11/2026; pregunta 6).

## 9. Fichero de Séneca

**Depende del centro (28).** Mientras tanto:

- la exportación va detrás de un adaptador (`exportarSeneca(matricula)`), con todas las columnas definidas en un único sitio, como `exportaciones/columnas.ts`;
- el CSV provisional del front sirve para la demo;
- cuando llegue el formato oficial o un fichero de ejemplo, solo cambia el adaptador.

## 10. Formato del borrador y qué decide cada uno

Decidido el 08/11/2026, al empezar la primera entrega.

- **El borrador tiene la forma del front.** `matriculas.datos` guarda el `EnrollmentDraft` del asistente con sus nombres en inglés (`student.firstName`…), validado con Zod (`src/modules/matricula/borrador.ts`). Lo que lo rodea va en español, como el resto de la API: la matrícula, su estado, sus enlaces y su historial.
  - **Por qué:**
    - las reglas de la API (`reglas.ts`) son una **copia** de `enrollment.rules.ts` y se comparan línea a línea;
    - traducir unos 120 campos en los dos sentidos solo añadiría errores;
    - si una regla cambia en un lado, cambia en el otro en el mismo PR.
  - **Objetos estrictos:** un campo que el front añada sin que llegue a la API es un 400 con su ruta, nunca un dato perdido en silencio.
- **Lo que no cambia la familia.** Desde su enlace no cambia la vía, el curso, «¿alumna nueva?» (que decide si hay ideario y LOPD) ni los documentos marcados como entregados en papel (`manualChecks`). Si llegan cambiados, la API conserva los suyos. Lo decide secretaría. Pregunta 31 al centro, por si quieren que la familia marque «lo entrego en papel».
- **Historial sin ruido.** El autoguardado manda un guardado por segundo. El historial deja un evento por sesión de trabajo (15 min) de cada actor, con las partes tocadas y sin los valores.
- **Cobro anulado con la matrícula abierta.** Si se anula el pago de la reserva después de abrir la matrícula, el expediente ya está «En proceso» y no se retira solo: secretaría decide si da de baja el expediente. Caso raro; se revisa si el centro lo pide.

## 11. Documentos y firmas: decisiones de la entrega 2

Decidido el 08/11/2026, al construir las firmas.

- **La fecha del documento es la de la firma.** Los documentos muestran «En Sevilla, a …» con el día de su primera firma válida (o hoy, si no está firmado), y esa línea **no entra en la huella**.
  - **Por qué:** con la fecha de la declaración, rellenar la declaración al final del asistente anulaba la LOPD y el ideario firmados antes; con la de hoy, la huella cambiaba cada día.
  - La prueba de cuándo se firmó es la hora del servidor guardada en la firma.
- **Se guarda el documento tal como se firmó** (`documentos_matricula`, uno por huella). Así se puede explicar qué cambió («Cambió: Número de cuenta · IBAN») y el PDF de la entrega 3 se genera con lo firmado, no con lo de ahora.
- **Validez:**
  - en borrador, la validez se calcula al leer: una firma cuyo documento cambió sale `DESACTUALIZADA`, también si cambian los acreedores o el texto pasa a otra versión;
  - al guardar el borrador se anula de verdad (`ANULADA`), con su mandato;
  - una vez enviada, valen las firmas vigentes.
- **La imagen del trazo va en la BD** (`bytea`, 200 KB como máximo), en la misma transacción que la firma. Una firma no puede quedar sin su imagen ni una imagen huérfana. Las copias de DNI y demás archivos sí irán al almacén (entrega 3, punto 7).
- **Añadidos a los documentos respecto al lector del front** (pregunta 32 al centro):
  - **LOPD, página 6:** nombre de la alumna, curso y nombre de la madre y del padre o tutores, para que la ficha firmada diga a quién se refiere;
  - **AlbaydarPLUS:** el bloque del acreedor, porque es una orden de domiciliación;
  - **Impreso:** el texto de la declaración («La persona abajo firmante declara…»);
  - **Encima de cada hueco de firma:** «He leído el documento completo y lo firmo» (punto 2).
- **El progenitor con su propio enlace** solo ve la LOPD y firma sus tres huecos. Las páginas leídas son de la matrícula, no de cada enlace: la hoja de evidencias de la entrega 3 lo dirá así.

## Entregas

| Entrega | Contenido | Estado |
|---|---|---|
| 1 | Modelo, apertura (admisión y renovación, también en bloque), borrador con versión, páginas leídas, enlaces y límites del portal | ✅ API 08/11/2026 (`feat/matricula-borrador`) |
| 2 | Textos legales versionados, documento rellenado con su huella, firmas (409 `DOCUMENTO_CAMBIADO`, anulación al cambiar datos), mandatos SEPA y acreedores en la configuración | ✅ API 08/11/2026 (`feat/matricula-firmas`) |
| 3 | Archivos (foto y checklist), envío con `canSubmit`, devolución a borrador, PDF con hoja de evidencias y exportación a Séneca (`EXPORTADA` → alumna matriculada) | Pendiente |
| 4 | Front: secretaría (`/enrollments/:id`) y familia (`/matricula/:token`) contra la API; se retira el mock | Pendiente |

---

## Lo que cambia en el front cuando se conecte

- **Lector de firmas:** pinta el documento que da la API y manda la `huella` al firmar; trata 409 `DOCUMENTO_CAMBIADO`.
- **Autoguardado:** manda `version`; ante 409 `VERSION_ANTIGUA`, se para y ofrece recargar; retardo de 1 s y guardado al cambiar de paso.
- **Firmas:** la imagen y la fecha llegan del servidor; una firma anulada se muestra como «Hay que volver a firmar: cambió …».
- **SEPA:** el identificador del acreedor sale de la API, no de las traducciones.
- **Enlace del otro progenitor:** acción de secretaría, si el centro lo quiere (pregunta 23).
