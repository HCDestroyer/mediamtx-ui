/**
 * All user-facing text lives here so the UI can be translated later.
 * Keep keys grouped by screen; use `fmt` for interpolation.
 */
export const es = {
  app: { name: "Nodo" },
  nav: {
    channels: "Canales",
    connections: "Conexiones",
    servers: "Servidores",
    settings: "Ajustes",
    groupOperation: "Operación",
    groupManagement: "Gestión",
  },
  network: { lan: "LAN", vpn: "VPN", public: "Pública" },
  connection: {
    resolving: "Conectando…",
    online: "{network} · {ms} ms",
    authError: "Credenciales",
    offline: "Sin conexión",
    none: "Sin servidor",
  },
  probeFailure: {
    timeout: "Sin respuesta",
    network: "No se pudo conectar",
    "mixed-content":
      "El navegador bloquea http desde una página https. Usa el panel por http en la LAN/VPN o pon la API detrás de HTTPS.",
    auth: "Usuario o clave incorrectos",
    http: "Respuesta inesperada",
  },
  probeFailureShort: {
    timeout: "Sin respuesta",
    network: "Sin conexión",
    "mixed-content": "Bloqueado",
    auth: "Credenciales",
    http: "Error",
  },
  serverSelector: { label: "Servidor", add: "Agregar servidor", empty: "Sin servidores" },
  channels: {
    title: "Canales",
    comingTitle: "Los canales llegan en la siguiente fase",
    comingBody:
      "Ya hay conexión con el servidor. El dashboard, la lista y el detalle de canal se agregan en la Fase 2.",
    noServerTitle: "Agrega tu primer servidor",
    noServerBody:
      "Guarda la dirección de la API de MediaMTX (LAN, VPN o pública) y el panel usa la primera que responda.",
    connectedTo: "Conectado a",
    endpoint: "Endpoint",
    latency: "Latencia",
  },
  connections: {
    title: "Conexiones",
    comingTitle: "Las conexiones llegan más adelante",
    comingBody: "La tabla por protocolo con la acción Expulsar se agrega en la Fase 4.",
  },
  servers: {
    title: "Servidores",
    subtitle: "Se prueba LAN → VPN → Pública y se usa el primero que responde.",
    add: "Agregar servidor",
    edit: "Editar",
    delete: "Eliminar",
    test: "Probar conexión",
    testing: "Probando…",
    use: "Usar",
    active: "Activo",
    notTested: "Sin probar",
    emptyTitle: "Todavía no hay servidores",
    emptyBody: "Agrega uno para empezar.",
    notSet: "Sin configurar",
    deleteTitle: "Eliminar servidor",
    deleteBody: "Se borra {name} de este dispositivo. No afecta al servidor MediaMTX.",
    cancel: "Cancelar",
    confirmDelete: "Eliminar",
    form: {
      addTitle: "Agregar servidor",
      editTitle: "Editar servidor",
      name: "Nombre",
      namePlaceholder: "Casa",
      color: "Color",
      endpoints: "Endpoints, en orden de prueba",
      endpointsHelp: "Con uno basta. Ejemplo: 192.168.1.20:9997",
      username: "Usuario",
      password: "Clave",
      save: "Guardar",
      test: "Probar",
      nameRequired: "Escribe un nombre.",
      endpointRequired: "Agrega al menos un endpoint.",
      endpointInvalid: "La dirección no es válida.",
    },
  },
  settings: {
    title: "Ajustes",
    appearance: "Apariencia",
    theme: "Tema",
    themeSystem: "Sistema",
    themeLight: "Claro",
    themeDark: "Oscuro",
    refresh: "Intervalo de refresco",
    refreshHelp: "Cada cuánto se actualiza el dashboard.",
    seconds: "{n} s",
    backup: "Servidores",
    export: "Exportar JSON",
    import: "Importar JSON",
    includePasswords: "Incluir las claves en el archivo",
    includePasswordsHelp: "Quien tenga el archivo podrá entrar a tus servidores.",
    exported: "Archivo exportado",
    imported: "Se importaron {n} servidor(es)",
    importedNone: "No se importó ningún servidor",
    importFailed: "El archivo no es una exportación válida",
    importWarnings: "{n} entrada(s) omitida(s)",
  },
  notFound: { title: "Página no encontrada", back: "Ir a Canales" },
} as const;

export const t = es;

/** Replaces `{key}` placeholders. */
export function fmt(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? ""));
}
