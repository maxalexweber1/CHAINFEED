// Side-effect CSS imports (`import './globals.css'`) — Next.js handles
// the bundling at build time; TypeScript needs an ambient declaration so
// the import doesn't trip ts(2882). Empty module body is sufficient
// because no exports are consumed in code.
declare module '*.css';
