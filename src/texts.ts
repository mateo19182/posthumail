// User-facing copy (Spanish). Edit freely; keep the {placeholders} as function args.

const fmtDate = (ms: number) =>
  new Date(ms).toLocaleString("es-ES", { timeZone: "Europe/Madrid", dateStyle: "long", timeStyle: "short" });

export const owner = {
  ping: (reminder: boolean, urgent: boolean) =>
    urgent
      ? "🚨 Tus contactos de confianza creen que has muerto. Si sigues con vida, pulsa el botón YA o tus mensajes se enviarán."
      : reminder
        ? "⏰ Recordatorio: aún no has confirmado que sigues por aquí."
        : "👋 Check-in mensual de posthumail: ¿sigues por aquí?",
  pingSubject: (urgent: boolean) =>
    urgent ? "🚨 posthumail: confirma que sigues con vida YA" : "posthumail: ¿sigues por aquí?",
  pingEmail: (text: string, link: string) => `${text}\n\nConfirma aquí: ${link}\n\nTambién puedes pulsar el botón en Telegram.`,
  aliveButton: "Sigo aquí ✋",
  thanks: (nextAt: number) => `Gracias, apuntado. Próximo check-in: ${fmtDate(nextAt)}.`,
  paused: (until: number) => `Pausado hasta ${fmtDate(until)}. No se avisará a nadie antes.`,
  trusteeConfirmed: (name: string, count: number, quorum: number) =>
    `⚠️ ${name} ha confirmado tu fallecimiento (${count}/${quorum}). Si sigues con vida, pulsa el botón.`,
  falseAlarmBy: (name: string) => `${name} ha dicho que estás bien; contador reiniciado.`,
  help:
    "Comandos:\n/alive — confirmar que sigues por aquí\n/pause 60d — pausar (máx. según config)\n/resume — quitar la pausa\n/status — estado actual",
};

export const trustee = {
  ask: (ownerName: string, again: boolean) =>
    `${again ? "Te lo volvemos a preguntar: " : ""}Hola, soy posthumail, el sistema que ${ownerName} configuró por si le pasaba algo. ` +
    `Hace semanas que ${ownerName} no responde a sus check-ins. ¿Sabes si está bien?\n\n` +
    `Si ha fallecido, confírmalo. Hacen falta varias confirmaciones antes de enviar nada, y ${ownerName} recibirá un último aviso.`,
  askSubject: (ownerName: string) => `¿${ownerName} está bien?`,
  askEmail: (text: string, link: string) => `${text}\n\nResponde aquí: ${link}`,
  fineButton: "Está bien 🙂",
  diedButton: "Ha fallecido",
  sureButton: "Sí, estoy seguro/a",
  areYouSure: (ownerName: string) => `¿Confirmas que ${ownerName} ha fallecido?`,
  recorded: "Gracias. Queda registrado.",
  fineRecorded: (ownerName: string) => `Gracias. Se reinicia el contador de ${ownerName}.`,
  cooling: (ownerName: string, until: number) =>
    `Hay confirmaciones suficientes. Si ${ownerName} no responde antes del ${fmtDate(until)}, se enviarán sus mensajes.`,
  falseAlarm: (ownerName: string) => `Falsa alarma: ${ownerName} está bien. Gracias por estar pendiente.`,
  released: (ownerName: string) => `Los mensajes de ${ownerName} se han enviado. Gracias por cuidar de esto. ❤️`,
  notAsked: "Ahora mismo no hay nada que confirmar.",
};

export const recipient = {
  footer: (ownerName: string) =>
    `—\n${ownerName} escribió este mensaje en vida y lo dejó programado para enviarse tras su fallecimiento.`,
  attachments: "Archivos:",
  tgCopy: (subject: string) => `📩 ${subject}\n(Te lo hemos enviado también por email.)`,
};

export const bot = {
  linked: (name: string) => `Hola ${name}, quedas vinculado/a a posthumail. Puedes cerrar este chat.`,
  unknown: "No te conozco. Usa el enlace de invitación que te pasaron.",
};

export const page = {
  checkin: { title: "¿Sigues por aquí?", button: "Sigo aquí ✋", done: "Apuntado. Gracias 🙂" },
  trustee: (ownerName: string) => ({ title: `¿${ownerName} está bien?` }),
  invalid: "Enlace no válido.",
  released: "Ya se han enviado los mensajes.",
};
