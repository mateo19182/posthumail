// User-facing copy (Spanish). Plain text, short, direct.

const fmtDate = (ms: number) =>
  new Date(ms).toLocaleString("es-ES", { timeZone: "Europe/Madrid", dateStyle: "long", timeStyle: "short" });

export const owner = {
  ping: (reminder: boolean, urgent: boolean) =>
    urgent
      ? "Tus contactos de confianza han confirmado tu fallecimiento. Si sigues aquí, confírmalo ya o se enviarán tus mensajes."
      : reminder
        ? "Recordatorio: confirma que sigues aquí."
        : "Check-in de posthumail: confirma que sigues aquí.",
  pingSubject: (urgent: boolean) => (urgent ? "posthumail: confirma ya" : "posthumail: check-in"),
  pingEmail: (text: string, link: string) => `${text}\n\n${link}`,
  aliveButton: "Sigo aquí",
  thanks: (nextAt: number) => `Hecho. Próximo check-in: ${fmtDate(nextAt)}.`,
  paused: (until: number) => `Pausado hasta ${fmtDate(until)}.`,
  trusteeConfirmed: (name: string, count: number, quorum: number) =>
    `${name} ha confirmado tu fallecimiento (${count}/${quorum}). Si sigues aquí, confírmalo.`,
  falseAlarmBy: (name: string) => `${name} ha dicho que estás bien. Contador reiniciado.`,
  linked: (name: string) => `${name} ha vinculado Telegram.`,
  updateReminder: (q: string) =>
    `Actualización trimestral ${q}: escríbela en el blog (private/updates/${q}.md) y envíala con: bun cli update send ${q}`,
  help: "/alive: confirmar que sigues aquí\n/pause 60d: pausar\n/resume: quitar la pausa\n/status: estado",
};

export const trustee = {
  ask: (ownerName: string, again: boolean) =>
    `${again ? "Segundo aviso. " : ""}${ownerName} te eligió como contacto de confianza en posthumail. ` +
    `Lleva semanas sin responder a sus check-ins. ¿Sabes si está bien? ` +
    `Hacen falta varias confirmaciones antes de enviar sus mensajes.`,
  askSubject: (ownerName: string) => `¿${ownerName} está bien?`,
  askEmail: (text: string, link: string) => `${text}\n\nResponde aquí: ${link}`,
  fineButton: "Está bien",
  diedButton: "Ha fallecido",
  recorded: "Registrado. Gracias.",
  fineRecorded: (ownerName: string) => `Registrado. Se reinicia el contador de ${ownerName}.`,
  cooling: (ownerName: string, until: number) =>
    `Hay confirmaciones suficientes. Si ${ownerName} no responde antes del ${fmtDate(until)}, se enviarán sus mensajes.`,
  falseAlarm: (ownerName: string) => `Falsa alarma: ${ownerName} está bien. Gracias.`,
  released: (ownerName: string) => `Los mensajes de ${ownerName} se han enviado. Gracias.`,
  notAsked: "Ahora mismo no hay nada que confirmar.",
};

export const recipient = {
  footer: (ownerName: string) => `--\n${ownerName} escribió este mensaje para que te llegara tras su fallecimiento.`,
  attachments: "Archivos:",
  tgCopy: (subject: string) => `${subject} (también enviado por email)`,
};

export const bot = {
  linked: (name: string) => `Vinculado: ${name}.`,
  unknown: "No te conozco. Usa el enlace de invitación.",
};

export const page = {
  checkinDone: "Hecho.",
  trustee: (ownerName: string) => ({ title: `¿${ownerName} está bien?` }),
  invalid: "Enlace no válido.",
  released: "Los mensajes ya se han enviado.",
};
