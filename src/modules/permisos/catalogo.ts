/**
 * Catálogo de permisos: cada módulo (vista) del front tiene "ver" y "editar".
 * Dirección (superadministrador) activa o desactiva estos permisos por rol
 * desde Configuración → Roles y permisos.
 */
export const MODULOS = [
  { id: 'dashboard', nombre: 'Dashboard' },
  { id: 'alumnado', nombre: 'Alumnado' },
  { id: 'solicitudes', nombre: 'Solicitudes y admisión' },
  { id: 'entrevistas', nombre: 'Entrevistas y agenda' },
  { id: 'evaluacion', nombre: 'Evaluación y reserva de plaza' },
  { id: 'matricula', nombre: 'Matrícula digital' },
  { id: 'cobros', nombre: 'Cobros y facturación' },
  { id: 'comunicaciones', nombre: 'Comunicaciones y plantillas' },
  { id: 'configuracion', nombre: 'Configuración, usuarios y roles' },
] as const;

export type ModuloId = (typeof MODULOS)[number]['id'];
export type Accion = 'ver' | 'editar';
export type Permiso = `${ModuloId}.${Accion}`;

export const PERMISOS: { clave: Permiso; modulo: ModuloId; accion: Accion; descripcion: string }[] = MODULOS.flatMap((m) => [
  { clave: `${m.id}.ver` as Permiso, modulo: m.id, accion: 'ver' as const, descripcion: `Ver ${m.nombre}` },
  { clave: `${m.id}.editar` as Permiso, modulo: m.id, accion: 'editar' as const, descripcion: `Editar ${m.nombre}` },
]);

export const esPermiso = (p: string): p is Permiso => PERMISOS.some((x) => x.clave === p);

const todo = (...m: ModuloId[]) => m.flatMap((id) => [`${id}.ver`, `${id}.editar`] as Permiso[]);
const ver = (...m: ModuloId[]) => m.map((id) => `${id}.ver` as Permiso);

/**
 * Roles de serie (reunión con el cliente del 5 oct 2026) y permisos iniciales,
 * tomados de la navegación y la matriz de permisos del mockup.
 * Son solo el punto de partida: Dirección los puede cambiar.
 */
export const ROLES_INICIALES = [
  {
    codigo: 'DIRECCION',
    nombre: 'Dirección',
    descripcion: 'Superadministrador: ve y edita todo, gestiona usuarios, roles y permisos.',
    esSuperadmin: true,
    orden: 1,
    permisos: PERMISOS.map((p) => p.clave),
  },
  {
    codigo: 'SECRETARIA',
    nombre: 'Secretaría',
    descripcion: 'Admisión, entrevistas, matrícula y comunicaciones.',
    esSuperadmin: false,
    orden: 2,
    // "Registrar decisión de admisión" es solo de Dirección (matriz del mockup): Evaluación solo en lectura.
    permisos: [...todo('alumnado', 'solicitudes', 'entrevistas', 'matricula', 'comunicaciones'), ...ver('dashboard', 'evaluacion')],
  },
  {
    codigo: 'ADMINISTRACION',
    nombre: 'Administración',
    descripcion: 'Cobros, facturación y comunicaciones de pagos.',
    esSuperadmin: false,
    orden: 3,
    permisos: [...todo('cobros', 'comunicaciones'), ...ver('dashboard', 'alumnado', 'configuracion')],
  },
  {
    codigo: 'COMERCIAL',
    nombre: 'Comercial / Promoción',
    descripcion: 'Seguimiento de solicitudes, entrevistas y nuevas alumnas (CRM).',
    esSuperadmin: false,
    orden: 4,
    permisos: [...todo('solicitudes'), ...ver('dashboard', 'alumnado', 'entrevistas')],
  },
] as const satisfies readonly { codigo: string; nombre: string; descripcion: string; esSuperadmin: boolean; orden: number; permisos: readonly Permiso[] }[];
