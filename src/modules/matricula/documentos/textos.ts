import type { LopdAuthorizationId } from '../borrador';
import type { ReaderDocId, SignatureSlotId } from '../reglas';

/**
 * Textos legales de los documentos que se firman en la matrícula (docs/matricula.md, punto 1).
 *
 * Son los literales de los PDF del centro que recoge el mockup (los mismos que tenía el lector
 * del front en `es-enrollment-reader.ts`). NO se resumen ni se editan desde Comunicaciones.
 *
 * Cambiar un texto = subir la VERSIÓN de su documento (`lopd@2026-1` → `lopd@2026-2`). Las firmas
 * ya dadas siguen apuntando a la suya (se guarda el documento tal como se firmó); las de los
 * borradores en curso dejan de valer y la familia vuelve a firmar.
 */
export const VERSIONES: Record<ReaderDocId, string> = {
  impreso: 'impreso@2026-1',
  ideario: 'ideario@2026-1',
  lopd: 'lopd@2026-1',
  sepa: 'sepa@2026-1',
  plus: 'plus@2026-1',
};

export const MEMBRETE = {
  nombre: 'CENTRO EDUCATIVO ALBAYDAR',
  direccion: 'Avda. de la Palmera, 36 · 41012 Sevilla · T 954 61 02 54',
};

/** Encima de cada hueco de firma (docs/matricula.md, punto 2): se firma con ella. */
export const DECLARACION_LECTURA = 'He leído el documento completo y lo firmo.';

export const DOCUMENTOS: Record<ReaderDocId, { nombre: string; nota: string }> = {
  impreso: { nombre: 'Impreso de matriculación', nota: 'Generado con los datos del asistente' },
  ideario: { nombre: 'Aceptación de ideario y salidas', nota: 'Solo alumnado nuevo' },
  lopd: { nombre: 'Autorización LOPD, cesión de datos y otros', nota: 'Seis firmas · páginas 4, 5 y 6' },
  sepa: { nombre: 'Orden de domiciliación de adeudo directo SEPA', nota: 'Recibos de septiembre a junio' },
  plus: { nombre: 'Programa AlbaydarPLUS', nota: 'Voluntario · 20 €/mes en Ciclos Concertados' },
};
export const NOTA_SEPA_GS = 'Cargo único anual de 180,30 € en septiembre';

export const HUECOS: Record<SignatureSlotId, string> = {
  'impreso-titular': 'Firma',
  'ideario-titular': 'Firma',
  'lopd-padre': 'FIRMA DEL PADRE / TUTOR',
  'lopd-madre': 'FIRMA DE LA MADRE / TUTORA',
  'lopd-img-padre': 'FIRMA DEL PADRE / TUTOR',
  'lopd-img-madre': 'FIRMA DE LA MADRE / TUTORA',
  'lopd-pd-padre': 'FIRMA DEL PADRE / TUTOR',
  'lopd-pd-madre': 'FIRMA DE LA MADRE / TUTORA',
  'sepa-titular': 'Firma del titular',
  'plus-titular': 'Firma del titular',
};

export const CAMPOS = {
  student: 'Datos de la alumna',
  surnames: 'Apellidos',
  name: 'Nombre',
  birthDate: 'Fecha de nacimiento',
  document: 'DNI / NIE',
  courseGroup: 'Curso y grupo',
  fullName: 'Nombre y apellidos de la alumna',
  studentFirstSurname: 'Primer apellido de la alumna',
  studentSecondSurname: 'Segundo apellido de la alumna',
  studentName: 'Nombre de la alumna',
  course: 'Curso',
  fullCourse: 'Curso completo',
  holder: 'Datos del titular de la cuenta',
  holderName: 'Nombre completo del titular',
  holderDocument: 'DNI del titular',
  holderAddress: 'Domicilio del titular',
  municipality: 'Municipio / localidad',
  province: 'Provincia',
  postalCode: 'Código postal',
  country: 'País',
  countryValue: 'España',
  account: 'Cuenta',
  iban: 'Número de cuenta · IBAN',
  bic: 'Swift BIC',
};

export const AUTORIZA = 'Autoriza';
export const NO_AUTORIZA = 'No autoriza';
export const AMBAS_FIRMAS = 'Ambas firmas son obligatorias';

export const IMPRESO = {
  titulo: (cursoEscolarCorto: string) => `IMPRESO DE MATRICULACIÓN · CURSO ${cursoEscolarCorto}`,
  intro:
    'Documento generado automáticamente con los datos introducidos en el asistente. Revise que todos los campos son correctos antes de firmar; cualquier corrección debe hacerse en el paso correspondiente del asistente.',
  tutores: 'Tutores legales',
  etiquetasTutores: { bach: ['Madre / tutora', 'Padre / tutor'], ciclo: ['Tutor/a legal 1', 'Tutor/a legal 2'] },
  domicilioFamiliar: 'Domicilio familiar',
  declaracionTitulo: 'DECLARACIÓN',
  declaracion:
    'La persona abajo firmante declara, bajo su expresa responsabilidad, que son ciertos los datos que figuran en la presente solicitud, así como la documentación que se acompaña.',
  nota: 'El impreso se sella con la fecha y hora de firma y se archiva en el expediente de la alumna. Se genera una copia en PDF para la familia.',
  firmaTitulo: 'Firma de la persona que matricula',
};

export const IDEARIO = {
  titulo: 'ACEPTACIÓN',
  puntos: {
    ideario: { etiqueta: (n: number) => `${n}.— Ideario del centro`, texto: 'He recibido y acepto el ideario del Centro de Enseñanza Albaydar.' },
    religion: { etiqueta: (n: number) => `${n}.— Religión Católica`, texto: 'Acepto tener clases de Religión Católica.' },
    outings: {
      etiqueta: (n: number, curso: string) => `${n}.— Salidas del centro en horario lectivo · ${curso}`,
      textoConEf:
        'Autorizo que mi hija salga del centro escolar en horario lectivo para tener las clases de Educación Física, así como, las horas necesarias para realizar excursiones y visitas escolares durante todo el curso escolar.',
      texto:
        'Autorizo que mi hija salga del centro escolar en horario lectivo, las horas necesarias para realizar excursiones y visitas escolares durante todo el curso escolar.',
    },
  },
  cursoDe: (curso: string, via: string) => `${curso} de ${via}`,
  acepta: 'Acepta',
  noAcepta: 'No acepta',
  motivo: (m: string) => `Motivo: ${m}`,
  desdeAsistente: 'Los puntos se marcan en el paso «Ideario y LOPD» del asistente.',
  nota: 'En caso de no aceptar o autorizar algún punto indíquelo con claridad. Los puntos desmarcados generan una nota en el expediente que secretaría debe revisar.',
  fecha: 'Acepto/Autorizo los puntos marcados de este documento y para que conste y surta los efectos oportunos, firmo el presente en Sevilla, a {fecha}.',
  firmaTitulo: 'FIRMA DEL PADRE / MADRE / TUTOR',
  firmaSub: 'Si es mayor de edad, por la interesada',
};

export const FECHA_SEVILLA = 'En Sevilla, a {fecha}.';

export const LOPD = {
  politicaTitulo: 'POLÍTICA DE PROTECCIÓN DE DATOS DEL CENTRO',
  politica: [
    'CENTRO EDUCATIVO ALBAYDAR (en adelante el Centro) garantiza la privacidad, respeta la intimidad y protege los datos de carácter personal de todas las personas con las que se relaciona (las alumnas y usuarias y sus familias, el personal docente, el personal de administración y servicios, los miembros de la entidad titular, sus proveedores y sus colaboradores).',
    'El Centro respeta la normativa vigente en materia de protección de datos personales y ha adoptado las medidas técnicas, organizativas y de seguridad necesarias para evitar la pérdida, mal uso, alteración, tratamiento o acceso no autorizado y robo de los datos personales facilitados, habida cuenta del estado de la tecnología, la naturaleza de los datos y los riesgos a los que están expuestos.',
    'La incorporación de los datos personales a los archivos y su tratamiento por el Centro tiene como finalidad el mantenimiento de la relación contractual en su caso establecida con el Centro, la gestión, administración, prestación, ampliación y mejora de sus servicios, la adecuación de dichos servicios a las preferencias y gustos de los padres, tutores o representantes legales de nuestros alumnos y usuarios, el diseño de nuevos servicios relacionados con los anteriores, el envío de actualizaciones de los servicios y el envío, por medios tradicionales y/o electrónicos, de información técnica, operativa y comercial.',
    'El Centro no cede datos a terceras personas más allá de las necesarias para llevar a cabo su actividad docente de una forma eficiente y satisfactoria. En todo caso, las cesiones realizadas están legalmente amparadas por el régimen jurídico de protección de datos. Cuando sea necesario, el Centro recabará de los afectados el previo consentimiento.',
  ],
  derechosTitulo: 'Ejercicio de derechos',
  derechos:
    'Éstos pueden ejercer sus derechos de acceso, rectificación, supresión, oposición, limitación del tratamiento y demás derechos recogidos en los arts. 15 a 22 del REGLAMENTO (UE) 2016/679. Para ejercitar estos derechos, pueden dirigirse a la dirección de correo electrónico dpd@albaydar.org o por cualquier otro medio que permita acreditar el envío y recepción de la solicitud a: CENTRO EDUCATIVO ALBAYDAR, Avenida de la Palmera, 36, (41012) Sevilla.',
  manifestacionesTitulo: 'MANIFESTACIONES DE LOS PADRES/TUTORES',
  manifestaciones: [
    {
      titulo: 'Carácter Propio, Proyecto Educativo, Plan de Convivencia, Reglamento de Régimen Interior e Ideario',
      texto:
        'Conocemos, estamos de acuerdo y respetamos el Carácter Propio del centro que define su identidad, su Proyecto Educativo, el Reglamento de Régimen Interior, el Ideario y la normativa de convivencia, y aceptamos que nuestra hija sea educada conforme a lo recogido en dichos documentos.',
    },
    {
      titulo: 'Participación activa',
      texto:
        'Como primeros responsables de la educación de nuestra hija y durante el tiempo en que nuestra hija esté matriculada en el centro nos comprometemos a participar activamente en el proceso educativo de nuestra hija en el ámbito escolar: a) adoptando las medidas que sean necesarias para que asista a clase con puntualidad; b) interesándonos por conocer y apoyar la evolución del proceso educativo; c) estimulando a nuestra hija para que lleve a cabo las tareas y actividades de estudio que se le encomienden; d) participando en las entrevistas y reuniones a las que seamos convocados por el centro; e) informando a los responsables del centro de aquellos aspectos de la personalidad y circunstancias de nuestra hija que afecten o sean relevantes para su formación; f) fomentando el respeto por todos los componentes de la Comunidad Educativa.',
    },
    {
      titulo: 'Cesión de datos',
      texto:
        'Sabemos y aceptamos que nuestros datos personales y los de nuestra hija, incluidos los de carácter reservado necesarios para el ejercicio de la función educativa, sean cedidos a la Consejería de Educación de la Junta de Andalucía en las condiciones que determine la ley y de conformidad con la DA 23ª de la LOE, al IES HELIÓPOLIS y a las empresas en las que las alumnas realizarán sus prácticas.',
    },
  ],
  manifestacionesNota: 'Estas manifestaciones se aceptan mediante la firma del documento en la página 6. No requieren marcar casillas.',
  autorizacionesTitulo: 'AUTORIZACIONES',
  autorizacionesIntro:
    'Marque cada autorización según su voluntad. Todas son voluntarias y revocables en cualquier momento escribiendo a dpd@albaydar.org.',
  autorizaciones: {
    a1: {
      etiqueta: 'Fichero de Antiguas Alumnas del centro',
      texto:
        'Autorizamos a CENTRO EDUCATIVO ALBAYDAR para que, una vez que nuestra hija haya abandonado el centro, pueda seguir conservando nuestros datos de contacto y los datos académicos de nuestra hija a efectos de poder emitir certificaciones de estudio y mantenernos informados de las distintas actividades, novedades, productos y servicios relacionados con el centro.',
    },
    a2: {
      etiqueta: 'Asociación de Antiguas Alumnas (AAA)',
      texto:
        'Autorizamos a CENTRO EDUCATIVO ALBAYDAR para que facilite nuestros datos de contacto y los de nuestra hija a la AAA del Centro para su tratamiento con vistas al desarrollo de su actividad.',
    },
    a3: {
      etiqueta: 'Asociación de Padres (APA)',
      texto:
        'En calidad de padre/madre/tutor/a deseamos incorporarnos como socio/a la APA del Centro, y por ello autorizamos al CENTRO EDUCATIVO ALBAYDAR para que facilite a la APA nuestros datos de contacto para su tratamiento con vistas al desarrollo de su actividad y remisión de información sobre sus actividades.',
    },
    a4: {
      etiqueta: 'Madres y padres encargados de curso',
      texto:
        'Autorizamos al CENTRO EDUCATIVO ALBAYDAR para que facilite nuestros datos de contacto a los matrimonios encargados del curso de nuestra hija para el desarrollo de sus tareas (contactar con las familias del curso, organizar actividades, etc.).',
    },
    a5: {
      etiqueta: 'Catequesis de Confirmación',
      texto:
        'Autorizamos a CENTRO EDUCATIVO ALBAYDAR para que, con vistas a la participación de nuestra hija en las clases de catequesis de Confirmación, pueda tratar sus datos personales. Comprendemos que dicho tratamiento puede suponer la comunicación de tales datos a la parroquia de procedencia.',
    },
    a6: { etiqueta: 'Servicio de noticias', texto: 'Deseamos suscribirnos al servicio de noticias vía e-mail del CENTRO EDUCATIVO ALBAYDAR.' },
    a8: {
      etiqueta: 'Atención médica · centro médico y seguro',
      texto:
        'Autorizamos al CENTRO EDUCATIVO ALBAYDAR para que facilite nuestros datos de contacto al centro médico de atención y, en su caso, a la compañía de seguros OCASO en caso de que nuestra hija sufra algún accidente para su tratamiento.',
    },
    a9: {
      etiqueta: 'Atención médica · datos de salud',
      texto:
        'Autorizamos al CENTRO EDUCATIVO ALBAYDAR para que, bajo las máximas garantías de confidencialidad, pueda tratar los datos relativos a la salud de nuestra hija que les facilitemos durante el tiempo que esté matriculada en el Centro, con la finalidad de prevención y para cuando sea necesaria la prestación de asistencia sanitaria.',
    },
    a10: {
      etiqueta: 'Comunicaciones comerciales del centro',
      texto:
        'Estamos interesados en recibir de ASOCIACIÓN EDUCATIVA Y CULTURAL ALBAYDAR información sobre la ampliación y mejora de sus servicios, nuevos servicios relacionados con los anteriores, actualizaciones de los servicios y el envío de información técnica, operativa y comercial acerca de los servicios actualmente ofrecidos.',
    },
    a11: {
      etiqueta: 'Comunicaciones comerciales de empresas relacionadas',
      texto:
        'Autorizamos a ASOCIACIÓN EDUCATIVA Y CULTURAL ALBAYDAR a que pueda comunicar nuestros datos de contacto (nombre y apellidos, e-mail) a otras empresas vinculadas comercial o estratégicamente a fin de que puedan hacernos llegar sus campañas de oferta de bienes o servicios análogos o complementarios.',
    },
    a12: {
      etiqueta: 'Publicación de imágenes por el centro',
      texto:
        'A que la imagen de nuestra hija aparezca en fotografías y/o grabaciones realizadas y/o editadas por el centro y a que se publiquen en la página web del Centro, en las cuentas del Centro en Facebook, Linkedin, Twitter e Instagram, en el canal de YouTube, en carteles, folletos y flyers promocionales, en Newsletters y Revista escolar.',
    },
    a13: {
      etiqueta: 'Programa LanguageAssistants · cesión a Saint Rose Languages SL',
      texto:
        'Dentro del programa “LanguageAssistants”, ceda a SAINT ROSE LANGUAGES SL, con C.I.F. B56077506, las imágenes realizadas en actividades relacionadas con dicho programa y en las que participe mi hija, a fin de promocionar dicho programa en su página web.',
    },
  } satisfies Record<LopdAuthorizationId, { etiqueta: string; texto: string }>,
  grupos: {
    pagina3: ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'],
    medica: ['a8', 'a9'],
    comercial: ['a10', 'a11'],
    imagenes: ['a12', 'a13'],
  } satisfies Record<string, LopdAuthorizationId[]>,
  dopTitulo: 'Departamento de Orientación Psicopedagógica (DOP)',
  dopTexto:
    'Hemos sido informados de la posibilidad de que nuestra hija, durante su estancia en el Centro y en el ámbito de actuación del DOP, participe en diferentes test psicopedagógicos que evalúan tanto las aptitudes espaciales, numéricas y de razonamiento abstracto y verbal como la memoria, así como en sesiones de orientación vocacional, académica y personal y coaching educativo.',
  dopSi: {
    etiqueta: 'Sí autorizamos',
    texto:
      'Sí autorizamos al DOP del Centro a realizar dichos test así como a elaborar un informe psicopedagógico con la información resultante que permita al Centro, al preceptor de nuestra hija, a sus profesores y tutores y a nosotros mismos evaluar y entender el funcionamiento intelectual global de nuestra hija con el fin de mejorar su atención académica; a elaborar un Plan de Orientación Vocacional.',
  },
  dopNo: { etiqueta: 'No autorizamos', texto: 'No autorizamos al DOP a realizar dichos test ni elaborar ningún informe o Plan de Orientación.' },
  dopObligatoria: 'Elija una de las dos opciones · obligatorio',
  continuacionTitulo: 'AUTORIZACIONES · continuación',
  medicaTitulo: 'Atención médica',
  comercialTitulo: 'AUTORIZACIÓN COMUNICACIONES COMERCIALES',
  imagenesTitulo: 'AUTORIZACIÓN PARA EL USO DE LAS IMÁGENES DE LAS ALUMNAS',
  imagenesIntro:
    'ASOCIACIÓN EDUCATIVA Y CULTURAL ALBAYDAR, con domicilio a estos efectos en Avenida de la Palmera, 36 (41012) Sevilla y con CIF núm. G-41829037, lleva a cabo actividades lectivas, complementarias y extraescolares en las que se toman habitualmente imágenes y/o se realizan filmaciones en las que aparecen, individualmente o en grupo, tanto profesoras como alumnas. Dado que el derecho a la propia imagen está reconocido en el artículo 18.1 de la Constitución Española y regulado en la Ley Orgánica 1/1982, la dirección del centro pide el consentimiento de los padres, tutores o representantes legales para poder publicar fotografías y/o grabaciones donde éstas aparezcan y sean claramente identificables.',
  imagenesAutorizamos: 'AUTORIZAMOS',
  imagenesRevocacion:
    'Podrán revocar su consentimiento en cualquier momento mediante carta dirigida a CENTRO EDUCATIVO ALBAYDAR o mediante correo electrónico a dpd@albaydar.org, indicando nombre y apellidos del afectado, domicilio a efectos de notificaciones, fotocopia del D.N.I. o Pasaporte y petición en que se concreta la solicitud.',
  declaracionTitulo: 'PROTECCIÓN DE DATOS DE CARÁCTER PERSONAL',
  declaracion:
    'Hemos sido informados de cuál es la Política de protección de datos de carácter personal de CENTRO EDUCATIVO ALBAYDAR y declaramos haber recibido una copia de la misma. Mediante la firma de esta ficha autorizamos expresamente a ASOCIACIÓN EDUCATIVA Y CULTURAL ALBAYDAR para que trate nuestros datos personales y los de nuestra hija, que voluntariamente cedemos en este documento, limitando la referida autorización al cumplimiento de los fines directamente relacionados con las funciones legítimas del centro. Así mismo, nos comprometemos a comunicar por escrito cualquier modificación que se produzca en los datos aportados en el presente documento.',
  /** Añadido por la API (no estaba en el lector del front): a quién se refiere la ficha que se firma. */
  identificacionTitulo: 'Alumna y firmantes',
  firmaTitulos: { 4: 'Firma de las autorizaciones', 5: 'Firma de la autorización de imágenes', 6: 'Firma de la ficha de protección de datos' } as Record<number, string>,
  basicaTitulo: 'Información básica sobre protección de datos',
  basica: [
    { clave: 'Responsable', valor: 'ASOCIACIÓN EDUCATIVA Y CULTURAL ALBAYDAR' },
    { clave: 'Finalidad', valor: 'Gestión administrativa del centro y las labores educativas y formativas exclusivas y propias del mismo.' },
    {
      clave: 'Legitimación',
      valor: 'Consentimiento explícito del interesado. DA 23ª LOE y normativa de desarrollo. Ejecución de un contrato. Interés legítimo conforme al art. 6.1.f) del RGPD.',
    },
    { clave: 'Destinatarios', valor: 'No se cederán datos a terceros, salvo en los casos autorizados en esta ficha y salvo en los casos de obligación legal.' },
    { clave: 'Derechos', valor: 'Acceder, rectificar y suprimir los datos, así como otros derechos, como se explica en la información adicional.' },
    { clave: 'Información adicional', valor: 'Puede consultar información adicional y detallada sobre Protección de Datos en http://albaydar.org/proteccion-datos/' },
  ],
  basicaNota: 'CENTRO EDUCATIVO ALBAYDAR · Avenida de la Palmera, 36 · 41012 Sevilla · dpd@albaydar.org',
};

export const SEPA = {
  titulo: 'ORDEN DE DOMICILIACIÓN DE ADEUDO DIRECTO SEPA',
  cabecera: (curso: string, cursoEscolar: string) => `${curso.toUpperCase()} · CURSO ${cursoEscolar.replace('-', '/')}`,
  acreedor: 'Datos del acreedor',
  acreedorId: 'Identificador del acreedor',
  acreedorNombre: 'Nombre del acreedor',
  acreedorDireccion: 'Dirección',
  legal:
    'Mediante la firma de esta orden de domiciliación, el deudor autoriza (A) al acreedor a enviar instrucciones a la entidad del deudor para adeudar su cuenta y (B) a la entidad para efectuar los adeudos en su cuenta siguiendo las instrucciones del acreedor. Como parte de sus derechos, el deudor está legitimado al reembolso por su entidad en los términos y condiciones del contrato suscrito con la misma. La solicitud de reembolso deberá efectuarse dentro de las ocho semanas que siguen a la fecha de adeudo en cuenta.',
  modalidad: 'Modalidad de pago',
  modalidadObligatoria: 'Elija la modalidad de pago para poder firmar · obligatorio',
  modalidades: { monthly: 'Pago por mensualidades', single: 'Pago único' },
  textoMensual: (importe: string) => `Diez recibos de ${importe} de septiembre a junio.`,
  textoUnico: (importe: string) => `Un único cargo de ${importe} en septiembre.`,
  /** Cuadro de importes del PDF SEPA de cada vía (GS privado: P28). Provisional hasta Cobros completos. */
  importes: {
    bach: { monthly: '410 €', single: '4.100 €' },
    gs: { monthly: '', single: '180,30 €' },
    gspPrimero: { monthly: '295 €', single: '2.950 €' },
    gspSegundo: { monthly: '275 €', single: '2.750 €' },
  },
  notaPrefijo: 'TODOS LOS CAMPOS HAN DE SER CUMPLIMENTADOS OBLIGATORIAMENTE. Una vez firmada, esta orden queda bajo la custodia del acreedor.',
  notaMensual: (importe: string) => `Recibos: desde septiembre hasta junio por un importe de ${importe}.`,
  notaUnico: (importe: string) => `Cargo único de ${importe} en septiembre.`,
  firmaTitulo: 'Firma del titular de la cuenta',
};

export const PLUS = {
  titulo: 'PROGRAMA ALBAYDARPLUS',
  intro:
    'Es un programa propio que nace de nuestra preocupación continua por conocer las demandas actuales del mercado laboral y así mejorar el CV de nuestras alumnas. Incluye actividades que enriquecen el currículum a través de una formación continua de calidad, encaminada a conseguir una mayor inserción laboral.',
  beneficiosTitulo: 'Participar en el programa supone estos beneficios',
  beneficios:
    'Plan trimestral de conferencias con profesionales del mundo empresarial. Simulacros de entrevistas de trabajo realizados por directivos de recursos humanos de nuestras empresas colaboradoras. Mesas redondas sobre temas de actualidad económica y laboral. Becas para cursos de acreditación en competencias digitales —Albaydar es centro examinador oficial de Microsoft—. Licencia Microsoft Office 365 gratuita. Preparación de entrevistas de trabajo en inglés con personal nativo.',
  nota: 'TODOS LOS CAMPOS HAN DE SER CUMPLIMENTADOS OBLIGATORIAMENTE. Una vez firmada, la orden queda bajo la custodia del acreedor. Recibo mensual de septiembre a junio por un importe de 20 €/mes.',
  fecha: 'Fecha {fecha} · Localidad: Sevilla.',
  firmaTitulo: 'Firma del titular de la cuenta',
};

export const ETIQUETA_VIA = { bach: 'Bachillerato', gm: 'Ciclos Concertados (GM)', gs: 'Ciclos Concertados (GS)', gsp: 'Ciclos Privados (GS)' } as const;
