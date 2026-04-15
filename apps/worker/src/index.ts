setInterval(() => {
  const now = new Date().toISOString();
  console.log(`[worker] standby heartbeat: ${now}`);
}, 30_000);

console.log("[worker] running in placeholder mode. Move extraction queue here when scaling.");
