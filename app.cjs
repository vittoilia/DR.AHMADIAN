// Startup file for cPanel "Setup Node.js App" (Phusion Passenger loads
// CommonJS entry points; the application itself is an ES module).
import('./server.mjs').catch((e) => { console.error(e); process.exit(1); });
