export function logger(quiet = false) {
  const emit = (level: string, o: Record<string, unknown>) => { if (!quiet) console.log(JSON.stringify({ t: new Date().toISOString(), level, ...o })); };
  return { info: (o: Record<string, unknown>) => emit('info', o), error: (o: Record<string, unknown>) => { if (!quiet) console.error(JSON.stringify({ t: new Date().toISOString(), level: 'error', ...o })); } };
}
